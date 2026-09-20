// @effect-diagnostics globalDate:off - Connect is a standalone Node control-plane service, not an Effect runtime.
import * as NodeCrypto from "node:crypto";
import { Pool, type PoolClient } from "pg";

import type { ConnectConfig } from "./config.ts";
import type { ManagedTunnelAllocation, ManagedTunnelEndpoint } from "./managedTunnel.ts";
import {
  generateEnvironmentCredential,
  formatPairingCode,
  hashEnvironmentCredential,
  hashPairingCode,
  isValidPairingCode,
  normalizePairingCode,
  validatePairingCandidate,
  type PairingValidationError,
} from "./pairing.ts";

export type EndpointKind = "tailscale" | "cloudflare_tunnel";

export interface EndpointInput {
  readonly kind: EndpointKind;
  readonly httpBaseUrl: string;
  readonly wsBaseUrl: string;
}

export interface EndpointRecord extends EndpointInput {
  readonly updatedAt: string;
}

export interface DeviceRecord {
  readonly id: string;
  readonly userId: string;
  readonly label: string;
  readonly publicKey: string;
  readonly createdAt: string;
}

export interface EnvironmentRecord {
  readonly id: string;
  readonly ownerUserId: string;
  readonly label: string;
  readonly publicKey: string;
  readonly createdAt: string;
  readonly endpoints: readonly EndpointRecord[];
}

export class ConnectDatabaseError extends Error {
  readonly code: PairingValidationError | "invalid_pairing_code" | "not_found" | "forbidden";

  constructor(code: PairingValidationError | "invalid_pairing_code" | "not_found" | "forbidden") {
    super(code);
    this.name = "ConnectDatabaseError";
    this.code = code;
  }
}

const CONNECT_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS connect_devices (
  id text PRIMARY KEY,
  user_id text NOT NULL,
  label text NOT NULL,
  public_key text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, public_key)
);

CREATE INDEX IF NOT EXISTS connect_devices_user_idx ON connect_devices(user_id);

CREATE TABLE IF NOT EXISTS connect_environments (
  id text PRIMARY KEY,
  owner_user_id text NOT NULL,
  label text NOT NULL,
  public_key text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS connect_environments_owner_idx ON connect_environments(owner_user_id);

CREATE TABLE IF NOT EXISTS connect_environment_credentials (
  id text PRIMARY KEY,
  environment_id text NOT NULL REFERENCES connect_environments(id) ON DELETE CASCADE,
  credential_hash text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz
);

CREATE INDEX IF NOT EXISTS connect_environment_credentials_environment_idx
  ON connect_environment_credentials(environment_id, revoked_at);

CREATE TABLE IF NOT EXISTS connect_environment_endpoints (
  environment_id text NOT NULL REFERENCES connect_environments(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('tailscale', 'cloudflare_tunnel')),
  http_base_url text NOT NULL,
  ws_base_url text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (environment_id, kind)
);

CREATE TABLE IF NOT EXISTS connect_managed_tunnel_allocations (
  environment_id text PRIMARY KEY REFERENCES connect_environments(id) ON DELETE CASCADE,
  tunnel_id text NOT NULL UNIQUE,
  tunnel_name text NOT NULL UNIQUE,
  hostname text NOT NULL UNIQUE,
  dns_record_id text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS connect_pairings (
  id text PRIMARY KEY,
  environment_id text NOT NULL REFERENCES connect_environments(id) ON DELETE CASCADE,
  code_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  used_at timestamptz,
  used_by_device_id text REFERENCES connect_devices(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS connect_pairings_environment_idx
  ON connect_pairings(environment_id, created_at DESC);

CREATE TABLE IF NOT EXISTS connect_environment_grants (
  environment_id text NOT NULL REFERENCES connect_environments(id) ON DELETE CASCADE,
  device_id text NOT NULL REFERENCES connect_devices(id) ON DELETE CASCADE,
  granted_by_user_id text NOT NULL,
  granted_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  PRIMARY KEY (environment_id, device_id)
);

CREATE INDEX IF NOT EXISTS connect_environment_grants_device_idx
  ON connect_environment_grants(device_id, revoked_at);
`;

const asIso = (value: Date | string): string =>
  (value instanceof Date ? value : new Date(value)).toISOString();

function endpointFromRow(row: Record<string, unknown>): EndpointRecord {
  return {
    kind: row.kind as EndpointKind,
    httpBaseUrl: String(row.http_base_url),
    wsBaseUrl: String(row.ws_base_url),
    updatedAt: asIso(row.updated_at as Date | string),
  };
}

function managedTunnelAllocationFromRow(row: Record<string, unknown>): ManagedTunnelAllocation {
  return {
    environmentId: String(row.environment_id),
    tunnelId: String(row.tunnel_id),
    tunnelName: String(row.tunnel_name),
    hostname: String(row.hostname),
    dnsRecordId: String(row.dns_record_id),
    createdAt: asIso(row.created_at as Date | string),
    updatedAt: asIso(row.updated_at as Date | string),
  };
}

async function withTransaction<T>(
  pool: Pool,
  body: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await body(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export class ConnectDatabase {
  readonly pool: Pool;
  private readonly secret: string;
  private readonly pairingTtlSeconds: number;

  constructor(databaseUrl: string, secret: string, pairingTtlSeconds: number) {
    this.pool = new Pool({ connectionString: databaseUrl });
    this.secret = secret;
    this.pairingTtlSeconds = pairingTtlSeconds;
  }

  async migrate(): Promise<void> {
    await withTransaction(this.pool, async (client) => {
      await client.query(CONNECT_SCHEMA_SQL);
    });
  }

  async health(): Promise<void> {
    await this.pool.query("SELECT 1");
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  async createDevice(
    userId: string,
    input: { label: string; publicKey: string },
  ): Promise<DeviceRecord> {
    const id = NodeCrypto.randomUUID();
    const result = await this.pool.query(
      `INSERT INTO connect_devices (id, user_id, label, public_key)
       VALUES ($1, $2, $3, $4)
       RETURNING id, user_id, label, public_key, created_at`,
      [id, userId, input.label, input.publicKey],
    );
    const row = result.rows[0] as Record<string, unknown>;
    return {
      id: String(row.id),
      userId: String(row.user_id),
      label: String(row.label),
      publicKey: String(row.public_key),
      createdAt: asIso(row.created_at as Date | string),
    };
  }

  async devicesForUser(userId: string): Promise<readonly DeviceRecord[]> {
    const result = await this.pool.query(
      `SELECT id, user_id, label, public_key, created_at
       FROM connect_devices
       WHERE user_id = $1
       ORDER BY created_at ASC`,
      [userId],
    );
    return (result.rows as Record<string, unknown>[]).map((row) => ({
      id: String(row.id),
      userId: String(row.user_id),
      label: String(row.label),
      publicKey: String(row.public_key),
      createdAt: asIso(row.created_at as Date | string),
    }));
  }

  async createEnvironment(
    ownerUserId: string,
    input: { label: string; publicKey: string; endpoints: readonly EndpointInput[] },
  ): Promise<{ environment: EnvironmentRecord; credential: string }> {
    const environmentId = NodeCrypto.randomUUID();
    const credential = generateEnvironmentCredential();
    const credentialHash = hashEnvironmentCredential(credential, this.secret);
    return withTransaction(this.pool, async (client) => {
      const inserted = await client.query(
        `INSERT INTO connect_environments (id, owner_user_id, label, public_key)
         VALUES ($1, $2, $3, $4)
         RETURNING id, owner_user_id, label, public_key, created_at`,
        [environmentId, ownerUserId, input.label, input.publicKey],
      );
      await client.query(
        `INSERT INTO connect_environment_credentials (id, environment_id, credential_hash)
         VALUES ($1, $2, $3)`,
        [NodeCrypto.randomUUID(), environmentId, credentialHash],
      );
      const endpoints: EndpointRecord[] = [];
      for (const endpoint of input.endpoints) {
        endpoints.push(await this.upsertEndpointWithClient(client, environmentId, endpoint));
      }
      const row = inserted.rows[0] as Record<string, unknown>;
      return {
        environment: {
          id: String(row.id),
          ownerUserId: String(row.owner_user_id),
          label: String(row.label),
          publicKey: String(row.public_key),
          createdAt: asIso(row.created_at as Date | string),
          endpoints,
        },
        credential,
      };
    });
  }

  async verifyEnvironmentCredential(environmentId: string, credential: string): Promise<boolean> {
    const hash = hashEnvironmentCredential(credential, this.secret);
    const result = await this.pool.query(
      `SELECT 1 FROM connect_environment_credentials
       WHERE environment_id = $1 AND credential_hash = $2 AND revoked_at IS NULL`,
      [environmentId, hash],
    );
    return result.rowCount === 1;
  }

  async upsertEndpoint(environmentId: string, endpoint: EndpointInput): Promise<EndpointRecord> {
    return withTransaction(this.pool, (client) =>
      this.upsertEndpointWithClient(client, environmentId, endpoint),
    );
  }

  async getManagedTunnelEnvironment(
    environmentId: string,
  ): Promise<{ readonly id: string; readonly label: string } | null> {
    const result = await this.pool.query(
      `SELECT id, label FROM connect_environments WHERE id = $1`,
      [environmentId],
    );
    const row = result.rows[0] as Record<string, unknown> | undefined;
    return row ? { id: String(row.id), label: String(row.label) } : null;
  }

  async getManagedTunnelAllocation(environmentId: string): Promise<ManagedTunnelAllocation | null> {
    const result = await this.pool.query(
      `SELECT environment_id, tunnel_id, tunnel_name, hostname, dns_record_id, created_at, updated_at
       FROM connect_managed_tunnel_allocations
       WHERE environment_id = $1`,
      [environmentId],
    );
    const row = result.rows[0] as Record<string, unknown> | undefined;
    return row ? managedTunnelAllocationFromRow(row) : null;
  }

  async getManagedTunnelAllocationForOwner(
    ownerUserId: string,
    environmentId: string,
  ): Promise<ManagedTunnelAllocation | null> {
    await this.assertEnvironmentOwner(ownerUserId, environmentId);
    return this.getManagedTunnelAllocation(environmentId);
  }

  async saveManagedTunnelAllocation(input: {
    readonly environmentId: string;
    readonly tunnelId: string;
    readonly tunnelName: string;
    readonly hostname: string;
    readonly dnsRecordId: string;
  }): Promise<ManagedTunnelAllocation> {
    const result = await this.pool.query(
      `INSERT INTO connect_managed_tunnel_allocations
         (environment_id, tunnel_id, tunnel_name, hostname, dns_record_id)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (environment_id) DO UPDATE SET
         tunnel_id = EXCLUDED.tunnel_id,
         tunnel_name = EXCLUDED.tunnel_name,
         hostname = EXCLUDED.hostname,
         dns_record_id = EXCLUDED.dns_record_id,
         updated_at = now()
       RETURNING environment_id, tunnel_id, tunnel_name, hostname, dns_record_id, created_at, updated_at`,
      [input.environmentId, input.tunnelId, input.tunnelName, input.hostname, input.dnsRecordId],
    );
    return managedTunnelAllocationFromRow(result.rows[0] as Record<string, unknown>);
  }

  async upsertManagedTunnelEndpoint(
    environmentId: string,
    hostname: string,
  ): Promise<ManagedTunnelEndpoint> {
    const endpoint = await this.upsertEndpoint(environmentId, {
      kind: "cloudflare_tunnel",
      httpBaseUrl: `https://${hostname}`,
      wsBaseUrl: `wss://${hostname}`,
    });
    return { ...endpoint, kind: "cloudflare_tunnel" };
  }

  async deleteManagedTunnelState(environmentId: string): Promise<void> {
    await withTransaction(this.pool, async (client) => {
      await client.query(
        `DELETE FROM connect_environment_endpoints
         WHERE environment_id = $1 AND kind = 'cloudflare_tunnel'`,
        [environmentId],
      );
      await client.query(
        `DELETE FROM connect_managed_tunnel_allocations WHERE environment_id = $1`,
        [environmentId],
      );
    });
  }

  private async upsertEndpointWithClient(
    client: PoolClient,
    environmentId: string,
    endpoint: EndpointInput,
  ): Promise<EndpointRecord> {
    const result = await client.query(
      `INSERT INTO connect_environment_endpoints (environment_id, kind, http_base_url, ws_base_url)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (environment_id, kind) DO UPDATE SET
         http_base_url = EXCLUDED.http_base_url,
         ws_base_url = EXCLUDED.ws_base_url,
         updated_at = now()
       RETURNING kind, http_base_url, ws_base_url, updated_at`,
      [environmentId, endpoint.kind, endpoint.httpBaseUrl, endpoint.wsBaseUrl],
    );
    return endpointFromRow(result.rows[0] as Record<string, unknown>);
  }

  async createPairing(
    environmentId: string,
    requestedCode: string,
    requestedExpiresAt?: Date,
  ): Promise<{ code: string; expiresAt: string; pairingUri: string }> {
    const code = formatPairingCode(requestedCode);
    if (!isValidPairingCode(code)) throw new ConnectDatabaseError("invalid_pairing_code");
    const codeHash = hashPairingCode(code, this.secret);
    const maximumExpiry = new Date(Date.now() + this.pairingTtlSeconds * 1000);
    const expiresAt =
      requestedExpiresAt && requestedExpiresAt.getTime() < maximumExpiry.getTime()
        ? requestedExpiresAt
        : maximumExpiry;
    if (expiresAt.getTime() <= Date.now()) throw new ConnectDatabaseError("expired");
    await this.pool.query(
      `INSERT INTO connect_pairings (id, environment_id, code_hash, expires_at)
       VALUES ($1, $2, $3, $4)`,
      [NodeCrypto.randomUUID(), environmentId, codeHash, expiresAt],
    );
    return {
      code,
      expiresAt: expiresAt.toISOString(),
      pairingUri: `dispatch://connect/pair?code=${encodeURIComponent(code)}`,
    };
  }

  async redeemPairing(userId: string, deviceId: string, code: string): Promise<EnvironmentRecord> {
    const codeHash = hashPairingCode(code, this.secret);
    return withTransaction(this.pool, async (client) => {
      const result = await client.query(
        `SELECT p.environment_id,
                p.expires_at,
                p.used_at,
                p.used_by_device_id,
                e.owner_user_id AS environment_owner_user_id,
                d.user_id AS device_owner_user_id,
                (g.device_id IS NOT NULL) AS has_active_grant
         FROM connect_pairings p
         JOIN connect_environments e ON e.id = p.environment_id
         LEFT JOIN connect_devices d ON d.id = $2
         LEFT JOIN connect_environment_grants g
           ON g.environment_id = p.environment_id
          AND g.device_id = $2
          AND g.revoked_at IS NULL
         WHERE p.code_hash = $1
         FOR UPDATE OF p`,
        [codeHash, deviceId],
      );
      const row = result.rows[0] as Record<string, unknown> | undefined;
      const validation = validatePairingCandidate(
        row
          ? {
              expiresAt: new Date(row.expires_at as string | Date),
              usedAt: row.used_at ? new Date(row.used_at as string | Date) : null,
              usedByDeviceId: row.used_by_device_id ? String(row.used_by_device_id) : null,
              deviceOwnerUserId: row.device_owner_user_id ? String(row.device_owner_user_id) : null,
              hasActiveGrant: row.has_active_grant === true,
            }
          : null,
        userId,
        deviceId,
        new Date(),
      );
      if (validation === "already_redeemed") {
        return this.environmentByIdWithClient(client, String(row?.environment_id));
      }
      if (validation !== "redeem") throw new ConnectDatabaseError(validation);

      const environmentId = String(row?.environment_id);
      const environmentOwnerUserId = String(row?.environment_owner_user_id);
      await client.query(
        `UPDATE connect_pairings SET used_at = now(), used_by_device_id = $2
         WHERE code_hash = $1`,
        [codeHash, deviceId],
      );
      await client.query(
        `INSERT INTO connect_environment_grants (environment_id, device_id, granted_by_user_id)
         VALUES ($1, $2, $3)
         ON CONFLICT (environment_id, device_id) DO UPDATE SET
           granted_by_user_id = EXCLUDED.granted_by_user_id,
           granted_at = now(),
           revoked_at = NULL`,
        [environmentId, deviceId, environmentOwnerUserId],
      );
      return this.environmentByIdWithClient(client, environmentId);
    });
  }

  async environmentsForDevice(
    userId: string,
    deviceId: string,
  ): Promise<readonly EnvironmentRecord[]> {
    const owned = await this.pool.query(
      `SELECT 1 FROM connect_devices WHERE id = $1 AND user_id = $2`,
      [deviceId, userId],
    );
    if (owned.rowCount !== 1) throw new ConnectDatabaseError("not_found");

    const environments = await this.pool.query(
      `SELECT e.id, e.owner_user_id, e.label, e.public_key, e.created_at
       FROM connect_environment_grants g
       JOIN connect_environments e ON e.id = g.environment_id
       WHERE g.device_id = $1 AND g.revoked_at IS NULL
       ORDER BY e.created_at ASC`,
      [deviceId],
    );
    const output: EnvironmentRecord[] = [];
    for (const row of environments.rows as Record<string, unknown>[]) {
      output.push(await this.environmentFromRow(this.pool, row));
    }
    return output;
  }

  async ownedEnvironments(userId: string): Promise<readonly EnvironmentRecord[]> {
    const environments = await this.pool.query(
      `SELECT id, owner_user_id, label, public_key, created_at
       FROM connect_environments
       WHERE owner_user_id = $1
       ORDER BY created_at ASC`,
      [userId],
    );
    const output: EnvironmentRecord[] = [];
    for (const row of environments.rows as Record<string, unknown>[]) {
      output.push(await this.environmentFromRow(this.pool, row));
    }
    return output;
  }

  async deleteDevice(userId: string, deviceId: string): Promise<void> {
    const result = await this.pool.query(
      `DELETE FROM connect_devices WHERE id = $1 AND user_id = $2`,
      [deviceId, userId],
    );
    if (result.rowCount !== 1) throw new ConnectDatabaseError("not_found");
  }

  async rotateEnvironmentCredential(ownerUserId: string, environmentId: string): Promise<string> {
    const credential = generateEnvironmentCredential();
    const credentialHash = hashEnvironmentCredential(credential, this.secret);
    await withTransaction(this.pool, async (client) => {
      const owned = await client.query(
        `SELECT 1 FROM connect_environments WHERE id = $1 AND owner_user_id = $2 FOR UPDATE`,
        [environmentId, ownerUserId],
      );
      if (owned.rowCount !== 1) throw new ConnectDatabaseError("not_found");
      await client.query(
        `UPDATE connect_environment_credentials SET revoked_at = now()
         WHERE environment_id = $1 AND revoked_at IS NULL`,
        [environmentId],
      );
      await client.query(
        `INSERT INTO connect_environment_credentials (id, environment_id, credential_hash)
         VALUES ($1, $2, $3)`,
        [NodeCrypto.randomUUID(), environmentId, credentialHash],
      );
    });
    return credential;
  }

  async revokeEnvironmentCredentials(ownerUserId: string, environmentId: string): Promise<void> {
    await this.assertEnvironmentOwner(ownerUserId, environmentId);
    await this.pool.query(
      `UPDATE connect_environment_credentials SET revoked_at = now()
       WHERE environment_id = $1 AND revoked_at IS NULL`,
      [environmentId],
    );
  }

  async listGrants(ownerUserId: string, environmentId: string) {
    await this.assertEnvironmentOwner(ownerUserId, environmentId);
    const result = await this.pool.query(
      `SELECT g.device_id, d.label, d.public_key, g.granted_at, g.revoked_at
       FROM connect_environment_grants g
       JOIN connect_devices d ON d.id = g.device_id
       WHERE g.environment_id = $1
       ORDER BY g.granted_at ASC`,
      [environmentId],
    );
    return result.rows.map((row: Record<string, unknown>) => ({
      deviceId: String(row.device_id),
      label: String(row.label),
      publicKey: String(row.public_key),
      grantedAt: asIso(row.granted_at as Date | string),
      revokedAt: row.revoked_at ? asIso(row.revoked_at as Date | string) : null,
    }));
  }

  async revokeGrant(ownerUserId: string, environmentId: string, deviceId: string): Promise<void> {
    await this.assertEnvironmentOwner(ownerUserId, environmentId);
    const result = await this.pool.query(
      `UPDATE connect_environment_grants SET revoked_at = now()
       WHERE environment_id = $1 AND device_id = $2 AND revoked_at IS NULL`,
      [environmentId, deviceId],
    );
    if (result.rowCount !== 1) throw new ConnectDatabaseError("not_found");
  }

  private async assertEnvironmentOwner(userId: string, environmentId: string): Promise<void> {
    const result = await this.pool.query(
      `SELECT 1 FROM connect_environments WHERE id = $1 AND owner_user_id = $2`,
      [environmentId, userId],
    );
    if (result.rowCount !== 1) throw new ConnectDatabaseError("not_found");
  }

  private async environmentByIdWithClient(
    client: PoolClient,
    environmentId: string,
  ): Promise<EnvironmentRecord> {
    const result = await client.query(
      `SELECT id, owner_user_id, label, public_key, created_at FROM connect_environments WHERE id = $1`,
      [environmentId],
    );
    const row = result.rows[0] as Record<string, unknown> | undefined;
    if (!row) throw new ConnectDatabaseError("not_found");
    return this.environmentFromRow(client, row);
  }

  private async environmentFromRow(
    client: Pick<PoolClient, "query"> | Pick<Pool, "query">,
    row: Record<string, unknown>,
  ): Promise<EnvironmentRecord> {
    const endpointRows = await client.query(
      `SELECT kind, http_base_url, ws_base_url, updated_at
       FROM connect_environment_endpoints WHERE environment_id = $1 ORDER BY kind ASC`,
      [String(row.id)],
    );
    return {
      id: String(row.id),
      ownerUserId: String(row.owner_user_id),
      label: String(row.label),
      publicKey: String(row.public_key),
      createdAt: asIso(row.created_at as Date | string),
      endpoints: (endpointRows.rows as Record<string, unknown>[]).map(endpointFromRow),
    };
  }
}

export function createConnectDatabase(config: ConnectConfig): ConnectDatabase {
  return new ConnectDatabase(config.databaseUrl, config.credentialSecret, config.pairingTtlSeconds);
}

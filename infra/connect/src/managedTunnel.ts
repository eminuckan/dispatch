// @effect-diagnostics globalFetch:off - This standalone Node service calls Cloudflare's REST API directly.
import type { CloudflareManagedTunnelConfig } from "./config.ts";

export interface ManagedTunnelAllocation {
  readonly environmentId: string;
  readonly tunnelId: string;
  readonly tunnelName: string;
  readonly hostname: string;
  readonly dnsRecordId: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ManagedTunnelEndpoint {
  readonly kind: "cloudflare_tunnel";
  readonly httpBaseUrl: string;
  readonly wsBaseUrl: string;
  readonly updatedAt: string;
}

export interface ManagedTunnelStore {
  getManagedTunnelEnvironment(
    environmentId: string,
  ): Promise<{ readonly id: string; readonly label: string } | null>;
  getManagedTunnelAllocation(environmentId: string): Promise<ManagedTunnelAllocation | null>;
  saveManagedTunnelAllocation(input: {
    readonly environmentId: string;
    readonly tunnelId: string;
    readonly tunnelName: string;
    readonly hostname: string;
    readonly dnsRecordId: string;
  }): Promise<ManagedTunnelAllocation>;
  upsertManagedTunnelEndpoint(
    environmentId: string,
    hostname: string,
  ): Promise<ManagedTunnelEndpoint>;
  deleteManagedTunnelState(environmentId: string): Promise<void>;
}

export type ManagedTunnelErrorCode =
  | "invalid_local_origin"
  | "managed_tunnel_environment_not_found"
  | "managed_tunnel_not_provisioned"
  | "managed_tunnel_upstream_error";

export class ManagedTunnelError extends Error {
  readonly code: ManagedTunnelErrorCode;

  constructor(code: ManagedTunnelErrorCode) {
    super(code);
    this.name = "ManagedTunnelError";
    this.code = code;
  }
}

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

interface CloudflareEnvelope<T> {
  readonly success?: boolean;
  readonly result?: T;
}

export function normalizeLoopbackOrigin(value: unknown): string {
  if (typeof value !== "string") throw new ManagedTunnelError("invalid_local_origin");
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ManagedTunnelError("invalid_local_origin");
  }
  const loopback =
    url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "[::1]";
  const port = Number.parseInt(url.port, 10);
  if (
    url.protocol !== "http:" ||
    !loopback ||
    !url.port ||
    !Number.isSafeInteger(port) ||
    port < 1 ||
    port > 65535 ||
    url.username ||
    url.password ||
    (url.pathname !== "/" && url.pathname !== "") ||
    url.search ||
    url.hash
  ) {
    throw new ManagedTunnelError("invalid_local_origin");
  }
  return `http://127.0.0.1:${port}`;
}

export function managedTunnelIdentity(
  environment: { readonly id: string; readonly label: string },
  tunnelDomain: string,
): { readonly tunnelName: string; readonly hostname: string } {
  const slug =
    environment.label
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 36) || "environment";
  const suffix =
    environment.id
      .toLowerCase()
      .replace(/[^a-z0-9]/g, "")
      .slice(-10) || "dispatch";
  const hostLabel = `${slug}-${suffix}`.slice(0, 63).replace(/-+$/g, "");
  return {
    tunnelName: `dispatch-${hostLabel}`,
    hostname: `${hostLabel}.${tunnelDomain}`,
  };
}

export class CloudflareManagedTunnelClient {
  private readonly config: CloudflareManagedTunnelConfig;
  private readonly fetcher: FetchLike;

  constructor(config: CloudflareManagedTunnelConfig, fetcher: FetchLike = fetch) {
    this.config = config;
    this.fetcher = fetcher;
  }

  async createTunnel(name: string): Promise<{ readonly id: string; readonly name: string }> {
    const result = await this.request<{ readonly id?: unknown; readonly name?: unknown }>(
      "POST",
      `/accounts/${this.config.accountId}/cfd_tunnel`,
      {
        name,
        config_src: "cloudflare",
      },
    );
    if (typeof result?.id !== "string" || !result.id) {
      throw new ManagedTunnelError("managed_tunnel_upstream_error");
    }
    return {
      id: result.id,
      name: typeof result.name === "string" && result.name ? result.name : name,
    };
  }

  async configureTunnel(tunnelId: string, hostname: string, localOrigin: string): Promise<void> {
    await this.request(
      "PUT",
      `/accounts/${this.config.accountId}/cfd_tunnel/${tunnelId}/configurations`,
      {
        config: {
          ingress: [
            { hostname, service: localOrigin, originRequest: {} },
            { service: "http_status:404" },
          ],
        },
      },
    );
  }

  async createDnsRecord(hostname: string, tunnelId: string): Promise<{ readonly id: string }> {
    const result = await this.request<{ readonly id?: unknown }>(
      "POST",
      `/zones/${this.config.zoneId}/dns_records`,
      {
        type: "CNAME",
        name: hostname,
        content: `${tunnelId}.cfargotunnel.com`,
        proxied: true,
        ttl: 1,
      },
    );
    if (typeof result?.id !== "string" || !result.id) {
      throw new ManagedTunnelError("managed_tunnel_upstream_error");
    }
    return { id: result.id };
  }

  async getTunnelToken(tunnelId: string): Promise<string> {
    const token = await this.request<string>(
      "GET",
      `/accounts/${this.config.accountId}/cfd_tunnel/${tunnelId}/token`,
    );
    if (!token) throw new ManagedTunnelError("managed_tunnel_upstream_error");
    return token;
  }

  async deleteDnsRecord(dnsRecordId: string): Promise<void> {
    await this.request("DELETE", `/zones/${this.config.zoneId}/dns_records/${dnsRecordId}`);
  }

  async deleteTunnel(tunnelId: string): Promise<void> {
    await this.request("DELETE", `/accounts/${this.config.accountId}/cfd_tunnel/${tunnelId}`);
  }

  private async request<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
    let response: Response;
    try {
      response = await this.fetcher(`https://api.cloudflare.com/client/v4${path}`, {
        method,
        headers: {
          authorization: `Bearer ${this.config.apiToken}`,
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch {
      throw new ManagedTunnelError("managed_tunnel_upstream_error");
    }

    let envelope: CloudflareEnvelope<T> | null = null;
    try {
      envelope = (await response.json()) as CloudflareEnvelope<T>;
    } catch {
      if (response.ok && method === "DELETE") return undefined as T;
    }
    if (!response.ok || !envelope?.success) {
      throw new ManagedTunnelError("managed_tunnel_upstream_error");
    }
    return envelope.result as T;
  }
}

export class ManagedTunnelService {
  private readonly store: ManagedTunnelStore;
  private readonly cloudflare: CloudflareManagedTunnelClient;
  private readonly tunnelDomain: string;
  private readonly ensureLocks = new Map<string, Promise<unknown>>();

  constructor(input: {
    readonly store: ManagedTunnelStore;
    readonly cloudflare: CloudflareManagedTunnelClient;
    readonly tunnelDomain: string;
  }) {
    this.store = input.store;
    this.cloudflare = input.cloudflare;
    this.tunnelDomain = input.tunnelDomain;
  }

  async ensure(environmentId: string, localOriginInput: unknown) {
    return this.serializeEnsure(environmentId, () =>
      this.ensureUnlocked(environmentId, localOriginInput),
    );
  }

  private async ensureUnlocked(environmentId: string, localOriginInput: unknown) {
    const localOrigin = normalizeLoopbackOrigin(localOriginInput);
    const environment = await this.store.getManagedTunnelEnvironment(environmentId);
    if (!environment) throw new ManagedTunnelError("managed_tunnel_environment_not_found");

    let allocation = await this.store.getManagedTunnelAllocation(environmentId);
    if (!allocation) {
      const identity = managedTunnelIdentity(environment, this.tunnelDomain);
      const tunnel = await this.cloudflare.createTunnel(identity.tunnelName);
      let dnsRecord: { readonly id: string };
      try {
        dnsRecord = await this.cloudflare.createDnsRecord(identity.hostname, tunnel.id);
      } catch (error) {
        await this.cloudflare.deleteTunnel(tunnel.id).catch(() => undefined);
        throw error;
      }
      try {
        allocation = await this.store.saveManagedTunnelAllocation({
          environmentId,
          tunnelId: tunnel.id,
          tunnelName: tunnel.name || identity.tunnelName,
          hostname: identity.hostname,
          dnsRecordId: dnsRecord.id,
        });
      } catch (error) {
        await Promise.allSettled([
          this.cloudflare.deleteDnsRecord(dnsRecord.id),
          this.cloudflare.deleteTunnel(tunnel.id),
        ]);
        throw error;
      }
    }

    await this.cloudflare.configureTunnel(allocation.tunnelId, allocation.hostname, localOrigin);
    const connectorToken = await this.cloudflare.getTunnelToken(allocation.tunnelId);
    const endpoint = await this.store.upsertManagedTunnelEndpoint(
      environmentId,
      allocation.hostname,
    );
    return { endpoint, connectorToken, tunnel: allocation };
  }

  private async serializeEnsure<T>(environmentId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.ensureLocks.get(environmentId) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(operation);
    this.ensureLocks.set(environmentId, current);
    try {
      return await current;
    } finally {
      if (this.ensureLocks.get(environmentId) === current) this.ensureLocks.delete(environmentId);
    }
  }

  async reconnectToken(environmentId: string) {
    const allocation = await this.store.getManagedTunnelAllocation(environmentId);
    if (!allocation) throw new ManagedTunnelError("managed_tunnel_not_provisioned");
    const connectorToken = await this.cloudflare.getTunnelToken(allocation.tunnelId);
    return { connectorToken, tunnel: allocation };
  }

  async remove(
    environmentId: string,
    allocation: ManagedTunnelAllocation,
  ): Promise<{ remoteCleanup: "complete" | "partial" }> {
    const cleanup = await Promise.allSettled([
      this.cloudflare.deleteDnsRecord(allocation.dnsRecordId),
      this.cloudflare.deleteTunnel(allocation.tunnelId),
    ]);
    await this.store.deleteManagedTunnelState(environmentId);
    return {
      remoteCleanup: cleanup.every((entry) => entry.status === "fulfilled")
        ? "complete"
        : "partial",
    };
  }
}

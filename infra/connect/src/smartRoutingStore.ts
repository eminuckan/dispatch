// @effect-diagnostics nodeBuiltinImport:off preferSchemaOverJson:off - Connect uses Node and PostgreSQL directly.
import type { Pool, PoolClient } from "pg";

import type { SmartRoutingConfig } from "./config.ts";
import { hashEnvironmentCredential } from "./pairing.ts";
import {
  SMART_ROUTING_INPUT_TOKEN_NANOS,
  SMART_ROUTING_MAX_INPUT_TOKENS,
  SmartRoutingError,
  type SmartRoutingOperation,
  type SmartRoutingResult,
} from "./smartRouting.ts";

export const SMART_ROUTING_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS connect_routing_accounts (
  account_id text PRIMARY KEY,
  blocked_at timestamptz,
  block_reason text,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS connect_routing_control (
  id boolean PRIMARY KEY DEFAULT true CHECK (id),
  disabled boolean NOT NULL DEFAULT false
);
INSERT INTO connect_routing_control (id) VALUES (true) ON CONFLICT DO NOTHING;
CREATE TABLE IF NOT EXISTS connect_routing_buckets (
  scope text NOT NULL,
  bucket text NOT NULL,
  requests bigint NOT NULL DEFAULT 0,
  reserved_nanos bigint NOT NULL DEFAULT 0,
  expires_at timestamptz NOT NULL,
  PRIMARY KEY (scope, bucket)
);
CREATE INDEX IF NOT EXISTS connect_routing_buckets_expiry_idx ON connect_routing_buckets(expires_at);
CREATE TABLE IF NOT EXISTS connect_routing_requests (
  account_id text NOT NULL,
  request_id uuid NOT NULL,
  environment_id text NOT NULL,
  operation text NOT NULL CHECK (operation IN ('execution','profile','recommendations')),
  digest text NOT NULL,
  reserved_nanos bigint NOT NULL,
  charged_buckets jsonb NOT NULL,
  input_tokens bigint,
  billed_nanos bigint,
  status text NOT NULL CHECK (status IN ('pending','completed','failed')),
  response jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  lease_expires_at timestamptz NOT NULL DEFAULT now() + interval '15 seconds',
  PRIMARY KEY (account_id, request_id)
);
CREATE INDEX IF NOT EXISTS connect_routing_requests_pending_idx ON connect_routing_requests(account_id, lease_expires_at) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS connect_routing_requests_created_idx ON connect_routing_requests(created_at);
CREATE INDEX IF NOT EXISTS connect_routing_requests_account_created_idx ON connect_routing_requests(account_id, created_at);
ALTER TABLE connect_routing_accounts ADD COLUMN IF NOT EXISTS daily_requests bigint CHECK (daily_requests >= 0);
ALTER TABLE connect_routing_accounts ADD COLUMN IF NOT EXISTS monthly_requests bigint CHECK (monthly_requests >= 0);
ALTER TABLE connect_routing_requests ADD COLUMN IF NOT EXISTS completed_at timestamptz;
ALTER TABLE connect_routing_requests ADD COLUMN IF NOT EXISTS outcome text;
CREATE TABLE IF NOT EXISTS connect_routing_audit (
  id bigserial PRIMARY KEY,
  account_id text,
  action text NOT NULL,
  actor text NOT NULL,
  reason text NOT NULL,
  details jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS connect_routing_audit_account_created_idx ON connect_routing_audit(account_id, created_at);
`;

export interface SmartRoutingPrincipal {
  readonly accountId: string;
  readonly environmentId: string;
  readonly credentialId: string;
  readonly sessionId: string;
  readonly newAccount: boolean;
}
/** Resolved by Better Auth; never accepted from the routing request body. */
export interface SmartRoutingSession {
  readonly accountId: string;
  readonly sessionId: string;
}
export type SmartRoutingReservation =
  | { readonly kind: "admitted" }
  | { readonly kind: "cached"; readonly response: SmartRoutingResult };

export class SmartRoutingStore {
  private readonly pool: Pool;
  private readonly credentialSecret: string;

  constructor(pool: Pool, credentialSecret: string) {
    this.pool = pool;
    this.credentialSecret = credentialSecret;
  }

  async migrate(): Promise<void> {
    await this.transaction(async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(817263490)");
      await client.query(SMART_ROUTING_SCHEMA_SQL);
    });
  }

  async authenticate(
    environmentId: string,
    credential: string,
    session: SmartRoutingSession,
  ): Promise<SmartRoutingPrincipal> {
    if (!credential.startsWith("dce_") || credential.length > 512)
      throw new SmartRoutingError(401, "environment_auth_required");
    const result = await this.pool.query(
      `SELECT e.owner_user_id, c.id AS credential_id, (u."createdAt" > now() - interval '24 hours') AS new_account, a.blocked_at
       FROM connect_environment_credentials c
       JOIN connect_environments e ON e.id = c.environment_id
       JOIN "user" u ON u.id = e.owner_user_id
       JOIN "session" s ON s."userId" = u.id AND s.id = $3 AND s."expiresAt" > now()
       LEFT JOIN connect_routing_accounts a ON a.account_id = e.owner_user_id
       WHERE c.environment_id = $1 AND c.credential_hash = $2 AND c.revoked_at IS NULL
         AND e.owner_user_id = $4`,
      [
        environmentId,
        hashEnvironmentCredential(credential, this.credentialSecret),
        session.sessionId,
        session.accountId,
      ],
    );
    const row = result.rows[0] as
      | { owner_user_id: string; credential_id: string; new_account: boolean; blocked_at: unknown }
      | undefined;
    if (!row) throw new SmartRoutingError(401, "environment_auth_invalid");
    if (row.blocked_at) throw new SmartRoutingError(403, "smart_routing_account_blocked");
    return {
      accountId: row.owner_user_id,
      environmentId,
      credentialId: row.credential_id,
      sessionId: session.sessionId,
      newAccount: row.new_account,
    };
  }

  async reserve(input: {
    readonly principal: SmartRoutingPrincipal;
    readonly requestId: string;
    readonly operation: SmartRoutingOperation;
    readonly digest: string;
    readonly ipHash: string;
    readonly config: SmartRoutingConfig;
  }): Promise<SmartRoutingReservation> {
    return this.transaction(async (client) => {
      // The one global row is held only for admission, never during inference. It serializes
      // budget checks across all processes, accounts and environments without an overspend race.
      const control = await client.query(
        "SELECT disabled FROM connect_routing_control WHERE id = true FOR UPDATE",
      );
      if (control.rows[0]?.disabled !== false)
        throw new SmartRoutingError(503, "smart_routing_unavailable");
      const { principal, config } = input;
      const credential = await client.query(
        `SELECT 1 FROM connect_environment_credentials c
         JOIN connect_environments e ON e.id = c.environment_id
         JOIN "user" u ON u.id = e.owner_user_id
         JOIN "session" s ON s."userId" = u.id AND s.id = $4 AND s."expiresAt" > now()
         WHERE c.id = $1 AND c.environment_id = $2 AND e.owner_user_id = $3 AND c.revoked_at IS NULL
         FOR SHARE OF c, s`,
        [principal.credentialId, principal.environmentId, principal.accountId, principal.sessionId],
      );
      if (credential.rowCount !== 1) throw new SmartRoutingError(401, "environment_auth_invalid");
      const blocked = await client.query(
        "SELECT blocked_at, daily_requests, monthly_requests FROM connect_routing_accounts WHERE account_id = $1",
        [principal.accountId],
      );
      if (blocked.rows[0]?.blocked_at)
        throw new SmartRoutingError(403, "smart_routing_account_blocked");

      const existing = await client.query(
        "SELECT environment_id, digest, status, response FROM connect_routing_requests WHERE account_id = $1 AND request_id = $2",
        [principal.accountId, input.requestId],
      );
      const previous = existing.rows[0];
      if (previous) {
        if (previous.environment_id !== principal.environmentId || previous.digest !== input.digest)
          throw new SmartRoutingError(409, "smart_routing_request_conflict");
        if (previous.status === "completed" && previous.response)
          return { kind: "cached", response: previous.response as SmartRoutingResult };
        throw new SmartRoutingError(
          previous.status === "pending" ? 409 : 503,
          previous.status === "pending"
            ? "smart_routing_request_pending"
            : "smart_routing_upstream_unavailable",
          15,
        );
      }

      const concurrent = await client.query(
        `SELECT count(*)::int AS total, count(*) FILTER (WHERE account_id = $1)::int AS account
         FROM connect_routing_requests WHERE status = 'pending' AND lease_expires_at > now()`,
        [principal.accountId],
      );
      if (
        concurrent.rows[0].total >= config.maxConcurrentGlobal ||
        concurrent.rows[0].account >= config.maxConcurrentPerAccount
      )
        throw new SmartRoutingError(429, "smart_routing_busy", 15);

      const recent = await client.query(
        `SELECT count(*) FILTER (WHERE created_at > now() - interval '10 seconds')::int AS burst,
          count(*) FILTER (WHERE created_at > now() - interval '1 hour')::int AS sustained,
          count(DISTINCT environment_id)::int AS environments,
          bool_or(environment_id = $2) AS known_environment
         FROM connect_routing_requests WHERE account_id = $1
           AND created_at > now() - interval '30 days'`,
        [principal.accountId, principal.environmentId],
      );
      if (recent.rows[0].burst >= config.accountBurstRequests)
        throw new SmartRoutingError(429, "smart_routing_rate_limited", 10);
      if (recent.rows[0].sustained >= config.accountHourlyRequests)
        throw new SmartRoutingError(429, "smart_routing_rate_limited", 3600);
      if (
        !recent.rows[0].known_environment &&
        recent.rows[0].environments >= config.maxEnvironmentsPerAccount
      )
        throw new SmartRoutingError(429, "smart_routing_environment_limit", 3600);

      const windows = await client.query(`SELECT
        to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM') AS month,
        to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS day,
        to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD-HH24-MI') AS minute`);
      const { month, day, minute } = windows.rows[0] as {
        month: string;
        day: string;
        minute: string;
      };
      const accountLimits = blocked.rows[0];
      const configuredDailyLimit = Math.min(
        config.accountDailyRequests,
        Number(accountLimits?.daily_requests ?? config.accountDailyRequests),
      );
      const monthlyAccountLimit = Math.min(
        config.accountMonthlyRequests,
        Number(accountLimits?.monthly_requests ?? config.accountMonthlyRequests),
      );
      const dailyAccountLimit = principal.newAccount
        ? Math.min(configuredDailyLimit, config.newAccountDailyRequests)
        : configuredDailyLimit;
      const limits = [
        {
          scope: "global",
          bucket: month,
          requests: Number.MAX_SAFE_INTEGER,
          nanos: config.monthlyBudgetNanos,
          retryAfter: 3600,
        },
        {
          scope: "global",
          bucket: day,
          requests: Number.MAX_SAFE_INTEGER,
          nanos: config.dailyBudgetNanos,
          retryAfter: 3600,
        },
        {
          scope: `account:${principal.accountId}`,
          bucket: month,
          requests: monthlyAccountLimit,
          nanos: Number.MAX_SAFE_INTEGER,
          retryAfter: 3600,
        },
        {
          scope: `account:${principal.accountId}`,
          bucket: day,
          requests: dailyAccountLimit,
          nanos: Number.MAX_SAFE_INTEGER,
          retryAfter: 3600,
        },
        {
          scope: `account:${principal.accountId}`,
          bucket: minute,
          requests: config.accountMinuteRequests,
          nanos: Number.MAX_SAFE_INTEGER,
          retryAfter: 60,
        },
        {
          scope: `environment:${principal.environmentId}`,
          bucket: minute,
          requests: config.environmentMinuteRequests,
          nanos: Number.MAX_SAFE_INTEGER,
          retryAfter: 60,
        },
        {
          scope: `ip:${input.ipHash}`,
          bucket: day,
          requests: config.ipDailyRequests,
          nanos: Number.MAX_SAFE_INTEGER,
          retryAfter: 3600,
        },
        {
          scope: `ip:${input.ipHash}`,
          bucket: minute,
          requests: config.ipMinuteRequests,
          nanos: Number.MAX_SAFE_INTEGER,
          retryAfter: 60,
        },
      ];
      for (const limit of limits) {
        const updated = await client.query(
          `INSERT INTO connect_routing_buckets (scope, bucket, requests, reserved_nanos, expires_at)
           SELECT $1, $2, 1, $3::bigint, now() + interval '35 days' WHERE $4::bigint >= 1 AND $5::bigint >= $3::bigint
           ON CONFLICT (scope, bucket) DO UPDATE SET
             requests = connect_routing_buckets.requests + 1,
             reserved_nanos = connect_routing_buckets.reserved_nanos + $3::bigint
           WHERE connect_routing_buckets.requests < $4::bigint AND connect_routing_buckets.reserved_nanos <= $5::bigint - $3::bigint
           RETURNING requests`,
          [limit.scope, limit.bucket, config.requestCostNanos, limit.requests, limit.nanos],
        );
        if (updated.rowCount !== 1)
          throw new SmartRoutingError(
            429,
            limit.scope === "global"
              ? "smart_routing_budget_exhausted"
              : "smart_routing_quota_exhausted",
            limit.retryAfter,
          );
      }
      await client.query(
        `INSERT INTO connect_routing_requests (account_id, request_id, environment_id, operation, digest, reserved_nanos, charged_buckets, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending')`,
        [
          principal.accountId,
          input.requestId,
          principal.environmentId,
          input.operation,
          input.digest,
          config.requestCostNanos,
          JSON.stringify(limits.map(({ scope, bucket }) => ({ scope, bucket }))),
        ],
      );
      return { kind: "admitted" };
    });
  }

  async complete(
    principal: SmartRoutingPrincipal,
    requestId: string,
    response: SmartRoutingResult | null,
    inputTokens: number | null = null,
  ): Promise<void> {
    await this.transaction(async (client) => {
      await client.query("SELECT id FROM connect_routing_control WHERE id = true FOR UPDATE");
      const result = await client.query(
        "SELECT reserved_nanos, charged_buckets FROM connect_routing_requests WHERE account_id = $1 AND request_id = $2 AND status = 'pending'",
        [principal.accountId, requestId],
      );
      const current = result.rows[0];
      if (!current) return;
      const allowance = Number(current.reserved_nanos);
      const validUsage =
        response !== null &&
        inputTokens !== null &&
        Number.isSafeInteger(inputTokens) &&
        inputTokens > 0 &&
        inputTokens <= SMART_ROUTING_MAX_INPUT_TOKENS;
      const billed = validUsage
        ? Math.min(allowance, inputTokens * SMART_ROUTING_INPUT_TOKEN_NANOS)
        : allowance;
      const refund = allowance - billed;
      if (refund > 0) {
        // Use the originally charged windows, including across a midnight/month boundary.
        for (const { scope, bucket } of current.charged_buckets as {
          scope: string;
          bucket: string;
        }[]) {
          await client.query(
            "UPDATE connect_routing_buckets SET reserved_nanos = reserved_nanos - $3 WHERE scope = $1 AND bucket = $2",
            [scope, bucket, refund],
          );
        }
      }
      await client.query(
        `UPDATE connect_routing_requests SET status = $3, response = $4, input_tokens = $5, billed_nanos = $6,
           completed_at = now(), outcome = $7
         WHERE account_id = $1 AND request_id = $2 AND status = 'pending'`,
        [
          principal.accountId,
          requestId,
          response === null ? "failed" : "completed",
          response === null ? null : JSON.stringify(response),
          validUsage ? inputTokens : null,
          billed,
          response === null
            ? "upstream_error"
            : "source" in response && response.source === "policy"
              ? "fallback"
              : "completed",
        ],
      );
    });
  }

  async capability(
    principal: SmartRoutingPrincipal,
    config: SmartRoutingConfig,
  ): Promise<{ readonly available: boolean; readonly reason: string | null }> {
    const result = await this.pool.query(
      `SELECT c.disabled, a.blocked_at, a.daily_requests, a.monthly_requests,
         COALESCE(gm.reserved_nanos, 0) AS global_month, COALESCE(gd.reserved_nanos, 0) AS global_day,
         COALESCE(am.requests, 0) AS account_month, COALESCE(ad.requests, 0) AS account_day
       FROM connect_routing_control c
       LEFT JOIN connect_routing_accounts a ON a.account_id = $1
       LEFT JOIN connect_routing_buckets gm ON gm.scope = 'global' AND gm.bucket = to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM')
       LEFT JOIN connect_routing_buckets gd ON gd.scope = 'global' AND gd.bucket = to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD')
       LEFT JOIN connect_routing_buckets am ON am.scope = 'account:' || $1 AND am.bucket = to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM')
       LEFT JOIN connect_routing_buckets ad ON ad.scope = 'account:' || $1 AND ad.bucket = to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD')
       WHERE c.id = true AND EXISTS (
         SELECT 1 FROM connect_environment_credentials ec
         JOIN connect_environments e ON e.id = ec.environment_id
         JOIN "session" s ON s."userId" = e.owner_user_id
         WHERE ec.id = $2 AND ec.revoked_at IS NULL AND e.id = $3 AND e.owner_user_id = $1
           AND s.id = $4 AND s."expiresAt" > now()
       )`,
      [principal.accountId, principal.credentialId, principal.environmentId, principal.sessionId],
    );
    const row = result.rows[0];
    if (!row) return { available: false, reason: "smart_routing_session_invalid" };
    if (row.blocked_at) return { available: false, reason: "smart_routing_account_blocked" };
    if (row.disabled !== false) return { available: false, reason: "smart_routing_unavailable" };
    if (
      Number(row.global_month) + config.requestCostNanos > config.monthlyBudgetNanos ||
      Number(row.global_day) + config.requestCostNanos > config.dailyBudgetNanos
    )
      return { available: false, reason: "smart_routing_budget_exhausted" };
    const daily = Math.min(
      config.accountDailyRequests,
      Number(row.daily_requests ?? config.accountDailyRequests),
      principal.newAccount ? config.newAccountDailyRequests : Number.MAX_SAFE_INTEGER,
    );
    const monthly = Math.min(
      config.accountMonthlyRequests,
      Number(row.monthly_requests ?? config.accountMonthlyRequests),
    );
    if (Number(row.account_day) >= daily || Number(row.account_month) >= monthly)
      return { available: false, reason: "smart_routing_quota_exhausted" };
    return { available: true, reason: null };
  }

  async setAccountBlocked(
    accountId: string,
    blocked: boolean,
    reason: string,
    actor = "operator",
  ): Promise<void> {
    await this.transaction(async (client) => {
      await client.query("SELECT id FROM connect_routing_control WHERE id = true FOR UPDATE");
      await client.query(
        `INSERT INTO connect_routing_accounts (account_id, blocked_at, block_reason)
         VALUES ($1, CASE WHEN $2 THEN now() ELSE NULL END, $3)
         ON CONFLICT (account_id) DO UPDATE SET blocked_at = EXCLUDED.blocked_at,
         block_reason = EXCLUDED.block_reason, updated_at = now()`,
        [accountId, blocked, reason.slice(0, 500)],
      );
      await this.audit(client, blocked ? "block" : "unblock", actor, reason, accountId);
    });
  }

  async setAccountLimits(
    accountId: string,
    daily: number | null,
    monthly: number | null,
    reason: string,
    actor = "operator",
  ): Promise<void> {
    for (const value of [daily, monthly]) {
      if (value !== null && (!Number.isSafeInteger(value) || value < 0))
        throw new Error("Invalid account limit");
    }
    await this.transaction(async (client) => {
      await client.query("SELECT id FROM connect_routing_control WHERE id = true FOR UPDATE");
      await client.query(
        `INSERT INTO connect_routing_accounts (account_id, daily_requests, monthly_requests) VALUES ($1, $2, $3)
         ON CONFLICT (account_id) DO UPDATE SET daily_requests = EXCLUDED.daily_requests,
           monthly_requests = EXCLUDED.monthly_requests, updated_at = now()`,
        [accountId, daily, monthly],
      );
      await this.audit(client, "limits", actor, reason, accountId, { daily, monthly });
    });
  }

  async setDisabled(disabled: boolean, reason: string, actor = "operator"): Promise<void> {
    await this.transaction(async (client) => {
      await client.query("UPDATE connect_routing_control SET disabled = $1 WHERE id = true", [
        disabled,
      ]);
      await this.audit(client, disabled ? "pause" : "resume", actor, reason, null);
    });
  }

  async revokeAccountSessions(
    accountId: string,
    reason: string,
    actor = "operator",
  ): Promise<number> {
    return this.transaction(async (client) => {
      await client.query("SELECT id FROM connect_routing_control WHERE id = true FOR UPDATE");
      const result = await client.query('DELETE FROM "session" WHERE "userId" = $1', [accountId]);
      const revoked = result.rowCount ?? 0;
      await this.audit(client, "revoke-sessions", actor, reason, accountId, { revoked });
      return revoked;
    });
  }

  private async audit(
    client: PoolClient,
    action: string,
    actor: string,
    reason: string,
    accountId: string | null,
    details: Readonly<Record<string, number | null>> = {},
  ): Promise<void> {
    if (!reason.trim() || !actor.trim()) throw new Error("An operator and reason are required");
    await client.query(
      "INSERT INTO connect_routing_audit (account_id, action, actor, reason, details) VALUES ($1, $2, $3, $4, $5)",
      [
        accountId,
        action,
        actor.trim().slice(0, 128),
        reason.trim().slice(0, 500),
        JSON.stringify(details),
      ],
    );
  }

  async cleanup(): Promise<void> {
    // Do not persist objective text, credentials or IP addresses. Idempotency metadata expires.
    await this.transaction(async (client) => {
      await client.query("SELECT id FROM connect_routing_control WHERE id = true FOR UPDATE");
      await client.query(
        `UPDATE connect_routing_requests SET status = 'failed', billed_nanos = reserved_nanos,
        completed_at = lease_expires_at, outcome = 'interrupted'
       WHERE status = 'pending' AND lease_expires_at < now()`,
      );
      await client.query(
        "DELETE FROM connect_routing_requests WHERE created_at < now() - interval '35 days'",
      );
      await client.query("DELETE FROM connect_routing_buckets WHERE expires_at < now()");
      await client.query(
        "DELETE FROM connect_routing_audit WHERE created_at < now() - interval '180 days'",
      );
    });
  }

  private async transaction<T>(body: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL statement_timeout = '3000ms'");
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
}

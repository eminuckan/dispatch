// @effect-diagnostics nodeBuiltinImport:off globalConsole:off preferSchemaOverJson:off - Local operator CLI for the standalone Node service.
import { Pool } from "pg";
import { loadConfig } from "./config.ts";
import { SmartRoutingStore } from "./smartRoutingStore.ts";

export async function routingAdmin(
  args: readonly string[],
  pool: Pool,
  store: SmartRoutingStore,
  actor = "operator",
): Promise<unknown> {
  const [operation, accountId, ...reason] = args;
  if (operation === "summary" && args.length === 1) {
    const usage = await pool.query(`SELECT scope, bucket, requests, reserved_nanos,
      reserved_nanos::numeric / 1000000000 AS reserved_usd
      FROM connect_routing_buckets WHERE scope = 'global' AND length(bucket) <= 10
      ORDER BY bucket DESC LIMIT 32`);
    const accounts = await pool.query(`SELECT account_id, count(*)::int AS requests,
      count(*) FILTER (WHERE status = 'failed')::int AS failures,
      sum(COALESCE(billed_nanos, reserved_nanos))::numeric / 1000000000 AS accounted_usd
      FROM connect_routing_requests WHERE created_at >= date_trunc('month', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'
      GROUP BY account_id ORDER BY accounted_usd DESC LIMIT 50`);
    const blocked = await pool.query(
      "SELECT account_id, blocked_at, block_reason FROM connect_routing_accounts WHERE blocked_at IS NOT NULL ORDER BY blocked_at DESC LIMIT 50",
    );
    const control = await pool.query(
      "SELECT disabled FROM connect_routing_control WHERE id = true",
    );
    return {
      disabled: control.rows[0]?.disabled ?? true,
      usage: usage.rows,
      accounts: accounts.rows,
      blocked: blocked.rows,
    };
  }
  if ((operation === "pause" || operation === "resume") && args.slice(1).join(" ").trim()) {
    await store.setDisabled(operation === "pause", args.slice(1).join(" "), actor);
    return { disabled: operation === "pause" };
  }
  if (operation === "account" && accountId && accountId.length <= 128 && args.length === 2) {
    const limits = await pool.query(
      "SELECT account_id, blocked_at, block_reason, daily_requests, monthly_requests FROM connect_routing_accounts WHERE account_id = $1",
      [accountId],
    );
    const usage = await pool.query(
      `SELECT operation, status, outcome, count(*)::int AS requests, sum(input_tokens)::text AS input_tokens,
        sum(COALESCE(billed_nanos, reserved_nanos))::numeric / 1000000000 AS accounted_usd,
        round(avg(extract(epoch FROM (completed_at - created_at)) * 1000)) AS average_ms
       FROM connect_routing_requests WHERE account_id = $1 GROUP BY operation, status, outcome`,
      [accountId],
    );
    const requests = await pool.query(
      `SELECT request_id, environment_id, operation, status, outcome, input_tokens,
        COALESCE(billed_nanos, reserved_nanos)::numeric / 1000000000 AS accounted_usd,
        created_at, completed_at FROM connect_routing_requests WHERE account_id = $1
       ORDER BY created_at DESC LIMIT 100`,
      [accountId],
    );
    const audit = await pool.query(
      "SELECT action, actor, reason, details, created_at FROM connect_routing_audit WHERE account_id = $1 ORDER BY id DESC LIMIT 100",
      [accountId],
    );
    return {
      accountId,
      limits: limits.rows[0] ?? null,
      usage: usage.rows,
      requests: requests.rows,
      audit: audit.rows,
    };
  }
  if (
    (operation === "block" || operation === "unblock") &&
    accountId &&
    accountId.length <= 128 &&
    reason.join(" ").trim()
  ) {
    await store.setAccountBlocked(accountId, operation === "block", reason.join(" "), actor);
    return { accountId, blocked: operation === "block" };
  }
  if (operation === "limits" && accountId && accountId.length <= 128 && args.length >= 5) {
    const parseLimit = (value: string | undefined): number | null => {
      if (value === "default") return null;
      const parsed = Number(value);
      if (value === undefined || !/^\d+$/.test(value) || !Number.isSafeInteger(parsed))
        throw new Error("Invalid limit");
      return parsed;
    };
    const daily = parseLimit(args[2]);
    const monthly = parseLimit(args[3]);
    await store.setAccountLimits(accountId, daily, monthly, args.slice(4).join(" "), actor);
    return { accountId, daily, monthly };
  }
  if (
    operation === "revoke-sessions" &&
    accountId &&
    accountId.length <= 128 &&
    reason.join(" ").trim()
  ) {
    return {
      accountId,
      revoked: await store.revokeAccountSessions(accountId, reason.join(" "), actor),
    };
  }
  if (operation === "audit" && args.length === 1) {
    const events = await pool.query(
      "SELECT account_id, action, actor, reason, details, created_at FROM connect_routing_audit ORDER BY id DESC LIMIT 100",
    );
    return { events: events.rows };
  }
  if (operation === "cleanup" && args.length === 1) {
    await store.cleanup();
    return { cleaned: true };
  }
  throw new Error(
    "Usage: routing:admin summary | account <id> | audit | pause <reason> | resume <reason> | block <id> <reason> | unblock <id> <reason> | limits <id> <daily|default> <monthly|default> <reason> | revoke-sessions <id> <reason> | cleanup",
  );
}

if (import.meta.main) {
  const config = loadConfig();
  const pool = new Pool({ connectionString: config.databaseUrl });
  try {
    const result = await routingAdmin(
      process.argv.slice(2),
      pool,
      new SmartRoutingStore(pool, config.credentialSecret),
      process.env.CONNECT_ROUTING_OPERATOR?.trim() || "operator",
    );
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    console.error(
      error instanceof Error && error.message.startsWith("Usage:")
        ? error.message
        : "Routing administration failed. Check service configuration and database connectivity.",
    );
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

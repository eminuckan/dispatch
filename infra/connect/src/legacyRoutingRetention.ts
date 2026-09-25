import type { Pool } from "pg";

/** Retain old routing receipts and audit records for their original expiry period. */
export async function cleanupLegacyRoutingRecords(pool: Pick<Pool, "query">): Promise<void> {
  const tables = await pool.query<{
    requests: string | null;
    buckets: string | null;
    audit: string | null;
  }>(
    `SELECT to_regclass('connect_routing_requests')::text AS requests,
      to_regclass('connect_routing_buckets')::text AS buckets,
      to_regclass('connect_routing_audit')::text AS audit`,
  );
  const existing = tables.rows[0];
  if (existing?.requests) {
    await pool.query(`UPDATE connect_routing_requests SET status = 'failed', billed_nanos = reserved_nanos,
      completed_at = lease_expires_at, outcome = 'interrupted'
      WHERE status = 'pending' AND lease_expires_at < now()`);
    await pool.query(
      "DELETE FROM connect_routing_requests WHERE created_at < now() - interval '35 days'",
    );
  }
  if (existing?.buckets)
    await pool.query("DELETE FROM connect_routing_buckets WHERE expires_at < now()");
  if (existing?.audit)
    await pool.query(
      "DELETE FROM connect_routing_audit WHERE created_at < now() - interval '180 days'",
    );
}

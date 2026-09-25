import * as NodeAssert from "node:assert/strict";
import * as NodeTest from "node:test";
import type { Pool } from "pg";

import { cleanupLegacyRoutingRecords } from "./legacyRoutingRetention.ts";

NodeTest.test(
  "legacy routing receipts and audit records keep their original retention windows",
  async () => {
    const statements: string[] = [];
    const pool = {
      query: async (statement: string) => {
        statements.push(statement);
        return {
          rows: [
            {
              requests: "connect_routing_requests",
              buckets: "connect_routing_buckets",
              audit: "connect_routing_audit",
            },
          ],
        };
      },
    } as unknown as Pick<Pool, "query">;
    await cleanupLegacyRoutingRecords(pool);
    NodeAssert.equal(statements.length, 5);
    NodeAssert.match(statements[1]!, /status = 'pending'.*lease_expires_at < now\(\)/s);
    NodeAssert.match(statements[2]!, /interval '35 days'/);
    NodeAssert.match(statements[4]!, /interval '180 days'/);
  },
);

NodeTest.test("fresh Connect databases need no legacy routing tables", async () => {
  const statements: string[] = [];
  const pool = {
    query: async (statement: string) => {
      statements.push(statement);
      return { rows: [{ requests: null, buckets: null, audit: null }] };
    },
  } as unknown as Pick<Pool, "query">;
  await cleanupLegacyRoutingRecords(pool);
  NodeAssert.equal(statements.length, 1);
});

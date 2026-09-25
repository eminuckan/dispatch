import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@dispatch/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";

it.layer(NodeSqliteClient.layer({ filename: ":memory:" }))("057_FlowThreads", (it) => {
  it.effect("pauses active managed runs while preserving completed history", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 56 });
      yield* sql`
        INSERT INTO orchestration_v2_runs (id, command_id, revision, payload)
        VALUES
          ('active', 'active-command', 1, '{"revision":1,"status":"running"}'),
          ('complete', 'complete-command', 3, '{"revision":3,"status":"completed"}')
      `;
      yield* runMigrations({ toMigrationInclusive: 57 });
      const rows = yield* sql<{
        id: string;
        revision: number;
        status: string;
        reason: string | null;
      }>`
        SELECT id, revision, json_extract(payload, '$.status') AS status,
          json_extract(payload, '$.statusReason') AS reason
        FROM orchestration_v2_runs ORDER BY id
      `;
      assert.deepEqual(rows, [
        {
          id: "active",
          revision: 2,
          status: "paused",
          reason: "This managed run was paused when Flow replaced managed teams.",
        },
        { id: "complete", revision: 3, status: "completed", reason: null },
      ]);
      const events = yield* sql<{ runId: string; revision: number }>`
        SELECT run_id AS "runId", revision FROM orchestration_v2_events WHERE event = 'retired-paused'
      `;
      assert.deepEqual(events, [{ runId: "active", revision: 2 }]);
    }),
  );
});

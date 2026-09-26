import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@dispatch/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";

it.layer(NodeSqliteClient.layer({ filename: ":memory:" }))("060_FlowRepositoryPaths", (it) => {
  it.effect("keeps existing Git workers and permits new shared workers", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 59 });
      yield* sql`
        INSERT INTO flow_workers
          (thread_id, parent_thread_id, spawn_id, assignment, model_selection_json,
           branch, state, created_at, updated_at)
        VALUES
          ('worker-old', 'lead', 'spawn-old', 'Review API', '{}',
           'flow/worker-old', 'idle', '2026-09-25', '2026-09-25')
      `;
      yield* runMigrations({ toMigrationInclusive: 60 });
      yield* sql`
        INSERT INTO flow_workers
          (thread_id, parent_thread_id, spawn_id, assignment, model_selection_json,
           branch, repository_path, state, created_at, updated_at)
        VALUES
          ('worker-shared', 'lead', 'spawn-shared', 'Review workspace', '{}',
           '', NULL, 'queued', '2026-09-26', '2026-09-26')
      `;
      const workers = yield* sql<{ threadId: string; repositoryPath: string | null }>`
        SELECT thread_id AS "threadId", repository_path AS "repositoryPath"
        FROM flow_workers ORDER BY thread_id
      `;
      assert.deepEqual(workers, [
        { threadId: "worker-old", repositoryPath: "." },
        { threadId: "worker-shared", repositoryPath: null },
      ]);
    }),
  );
});

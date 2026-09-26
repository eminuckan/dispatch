import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE flow_workers ADD COLUMN profile_id TEXT`;
  yield* sql`
    CREATE TABLE flow_updates (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      id TEXT NOT NULL UNIQUE,
      worker_thread_id TEXT NOT NULL REFERENCES flow_workers(thread_id) ON DELETE CASCADE,
      message TEXT NOT NULL,
      created_at TEXT NOT NULL
    )
  `;
  yield* sql`CREATE INDEX flow_updates_worker ON flow_updates (worker_thread_id, sequence)`;
});

import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE team_policy (id INTEGER PRIMARY KEY CHECK(id = 1), revision INTEGER NOT NULL, payload TEXT NOT NULL)`;
  yield* sql`CREATE TABLE team_runs (id TEXT PRIMARY KEY, command_id TEXT NOT NULL UNIQUE, revision INTEGER NOT NULL, payload TEXT NOT NULL)`;
  yield* sql`CREATE TABLE team_events (run_id TEXT NOT NULL, revision INTEGER NOT NULL, payload TEXT NOT NULL, PRIMARY KEY(run_id, revision))`;
  yield* sql`CREATE TABLE team_effects (id TEXT PRIMARY KEY, run_id TEXT NOT NULL, task_id TEXT NOT NULL, generation INTEGER NOT NULL, status TEXT NOT NULL CHECK(status IN ('reserved','dispatching','running','settled','unknown')), payload TEXT NOT NULL, UNIQUE(run_id, task_id, generation))`;
});

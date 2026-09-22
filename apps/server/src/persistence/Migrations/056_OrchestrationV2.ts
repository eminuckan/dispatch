import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE orchestration_v2_settings (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      revision INTEGER NOT NULL CHECK (revision >= 0),
      payload TEXT NOT NULL
    )
  `;

  yield* sql`
    CREATE TABLE orchestration_v2_runs (
      id TEXT PRIMARY KEY,
      command_id TEXT NOT NULL UNIQUE,
      revision INTEGER NOT NULL CHECK (revision >= 0),
      payload TEXT NOT NULL
    )
  `;

  yield* sql`
    CREATE TABLE orchestration_v2_events (
      run_id TEXT NOT NULL,
      revision INTEGER NOT NULL CHECK (revision >= 0),
      event TEXT NOT NULL,
      payload TEXT NOT NULL,
      PRIMARY KEY (run_id, revision),
      FOREIGN KEY (run_id) REFERENCES orchestration_v2_runs(id) ON DELETE CASCADE
    )
  `;
});

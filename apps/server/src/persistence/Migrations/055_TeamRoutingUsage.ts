import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE team_routing_usage (id INTEGER PRIMARY KEY, fingerprint TEXT NOT NULL, model TEXT NOT NULL, input_tokens INTEGER, output_tokens INTEGER, succeeded INTEGER NOT NULL, recorded_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)`;
});

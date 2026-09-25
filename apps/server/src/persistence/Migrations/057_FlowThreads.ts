import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // Retired managed runs remain readable, but must not resume after upgrade.
  yield* sql`
    INSERT INTO orchestration_v2_events (run_id, revision, event, payload)
    SELECT id, revision + 1, 'retired-paused',
      json_set(payload, '$.revision', revision + 1, '$.status', 'paused',
        '$.statusReason', 'This managed run was paused when Flow replaced managed teams.',
        '$.updatedAt', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    FROM orchestration_v2_runs
    WHERE json_extract(payload, '$.status') NOT IN ('completed', 'cancelled', 'failed', 'paused')
  `;
  yield* sql`
    UPDATE orchestration_v2_runs
    SET revision = revision + 1,
      payload = json_set(payload, '$.revision', revision + 1, '$.status', 'paused',
        '$.statusReason', 'This managed run was paused when Flow replaced managed teams.',
        '$.updatedAt', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    WHERE json_extract(payload, '$.status') NOT IN ('completed', 'cancelled', 'failed', 'paused')
  `;

  yield* sql`ALTER TABLE projection_threads ADD COLUMN flow_enabled INTEGER NOT NULL DEFAULT 0`;

  yield* sql`
    CREATE TABLE flow_workers (
      thread_id TEXT PRIMARY KEY,
      parent_thread_id TEXT NOT NULL,
      spawn_id TEXT NOT NULL UNIQUE,
      assignment TEXT NOT NULL,
      model_selection_json TEXT NOT NULL,
      branch TEXT NOT NULL,
      worktree_path TEXT,
      state TEXT NOT NULL CHECK (state IN ('queued', 'working', 'idle', 'failed', 'stopped')),
      error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;
  yield* sql`CREATE INDEX flow_workers_parent ON flow_workers (parent_thread_id, created_at)`;

  yield* sql`
    CREATE TABLE flow_jobs (
      id TEXT PRIMARY KEY,
      worker_thread_id TEXT NOT NULL REFERENCES flow_workers(thread_id) ON DELETE CASCADE,
      command_id TEXT NOT NULL UNIQUE,
      message_id TEXT NOT NULL UNIQUE,
      prompt TEXT NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('queued', 'working', 'completed', 'failed', 'stopped')),
      result TEXT,
      error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;
  yield* sql`CREATE INDEX flow_jobs_worker ON flow_jobs (worker_thread_id, created_at)`;
});

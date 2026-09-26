import {
  FlowError,
  ModelSelection,
  ThreadId,
  type FlowJob,
  type FlowUpdate,
  type FlowWorker,
} from "@dispatch/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

const decodeSelection = Schema.decodeUnknownSync(Schema.fromJsonString(ModelSelection));
const encodeSelection = Schema.encodeSync(Schema.fromJsonString(ModelSelection));
const nowIso = DateTime.now.pipe(Effect.map(DateTime.formatIso));
const fail = (code: FlowError["code"], message: string) => new FlowError({ code, message });
const persistence = () => fail("persistence", "Flow state could not be read or saved.");
const isFlowError = Schema.is(FlowError);

interface WorkerRow {
  readonly threadId: string;
  readonly parentThreadId: string;
  readonly spawnId: string;
  readonly assignment: string;
  readonly modelSelectionJson: string;
  readonly profileId: string | null;
  readonly branch: string;
  readonly worktreePath: string | null;
  readonly state: FlowWorker["state"];
  readonly error: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

interface JobRow {
  readonly id: string;
  readonly workerThreadId: string;
  readonly commandId: string;
  readonly messageId: string;
  readonly delivery: "turn" | "steer";
  readonly prompt: string;
  readonly state: FlowJob["state"];
  readonly result: string | null;
  readonly error: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

interface UpdateRow {
  readonly sequence: number;
  readonly id: string;
  readonly workerThreadId: string;
  readonly message: string;
  readonly createdAt: string;
}

export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const getWorkerRow = (threadId: string) =>
    sql<WorkerRow>`SELECT thread_id AS "threadId", parent_thread_id AS "parentThreadId", spawn_id AS "spawnId", assignment, model_selection_json AS "modelSelectionJson", profile_id AS "profileId", branch, worktree_path AS "worktreePath", state, error, created_at AS "createdAt", updated_at AS "updatedAt" FROM flow_workers WHERE thread_id = ${threadId}`.pipe(
      Effect.map((rows) => rows[0] ?? null),
    );
  const getJobRow = (id: string) =>
    sql<JobRow>`SELECT id, worker_thread_id AS "workerThreadId", command_id AS "commandId", message_id AS "messageId", delivery, prompt, state, result, error, created_at AS "createdAt", updated_at AS "updatedAt" FROM flow_jobs WHERE id = ${id}`.pipe(
      Effect.map((rows) => rows[0] ?? null),
    );
  const latestJobRow = (workerThreadId: string) =>
    sql<JobRow>`SELECT id, worker_thread_id AS "workerThreadId", command_id AS "commandId", message_id AS "messageId", delivery, prompt, state, result, error, created_at AS "createdAt", updated_at AS "updatedAt" FROM flow_jobs WHERE worker_thread_id = ${workerThreadId} ORDER BY updated_at DESC, CASE delivery WHEN 'turn' THEN 0 ELSE 1 END, rowid DESC LIMIT 1`.pipe(
      Effect.map((rows) => rows[0] ?? null),
    );

  const toJob = (row: JobRow): FlowJob => ({
    id: row.id as FlowJob["id"],
    workerThreadId: ThreadId.make(row.workerThreadId),
    state: row.state,
    prompt: row.prompt,
    result: row.result,
    error: row.error,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  });
  const toWorker = Effect.fn("FlowStore.toWorker")(function* (row: WorkerRow) {
    const latest = yield* latestJobRow(row.threadId);
    return {
      threadId: ThreadId.make(row.threadId),
      spawnId: row.spawnId as FlowWorker["spawnId"],
      parentThreadId: ThreadId.make(row.parentThreadId),
      assignment: row.assignment,
      modelSelection: decodeSelection(row.modelSelectionJson),
      profileId: row.profileId,
      branch: row.branch,
      worktreePath: row.worktreePath,
      state: row.state,
      error: row.error,
      latestJob: latest ? toJob(latest) : null,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    } satisfies FlowWorker;
  });

  const isEnabled = Effect.fn("FlowStore.isEnabled")(function* (threadId: ThreadId) {
    const rows = yield* sql<{ flowEnabled: number }>`
      SELECT flow_enabled AS "flowEnabled" FROM projection_threads
      WHERE thread_id = ${threadId} AND deleted_at IS NULL AND archived_at IS NULL
    `;
    return rows[0]?.flowEnabled === 1;
  }, Effect.mapError(persistence));

  const getWorker = Effect.fn("FlowStore.getWorker")(function* (threadId: ThreadId) {
    const row = yield* getWorkerRow(threadId);
    return row ? yield* toWorker(row) : null;
  }, Effect.mapError(persistence));

  const getWorkerBySpawnId = Effect.fn("FlowStore.getWorkerBySpawnId")(function* (spawnId: string) {
    const rows =
      yield* sql<WorkerRow>`SELECT thread_id AS "threadId", parent_thread_id AS "parentThreadId", spawn_id AS "spawnId", assignment, model_selection_json AS "modelSelectionJson", profile_id AS "profileId", branch, worktree_path AS "worktreePath", state, error, created_at AS "createdAt", updated_at AS "updatedAt" FROM flow_workers WHERE spawn_id = ${spawnId}`;
    return rows[0] ? yield* toWorker(rows[0]) : null;
  }, Effect.mapError(persistence));

  const getJob = Effect.fn("FlowStore.getJob")(function* (id: string) {
    const row = yield* getJobRow(id);
    return row ? toJob(row) : null;
  }, Effect.mapError(persistence));

  const listWorkers = Effect.fn("FlowStore.listWorkers")(function* (parentThreadId: ThreadId) {
    const rows = yield* sql<WorkerRow>`
      SELECT thread_id AS "threadId", parent_thread_id AS "parentThreadId", spawn_id AS "spawnId", assignment, model_selection_json AS "modelSelectionJson", profile_id AS "profileId", branch, worktree_path AS "worktreePath", state, error, created_at AS "createdAt", updated_at AS "updatedAt" FROM flow_workers WHERE parent_thread_id = ${parentThreadId}
      ORDER BY created_at ASC, rowid ASC
    `;
    return yield* Effect.forEach(rows, toWorker);
  }, Effect.mapError(persistence));

  const listUpdates = Effect.fn("FlowStore.listUpdates")(function* (parentThreadId: ThreadId) {
    const rows = yield* sql<UpdateRow>`
      SELECT u.sequence, u.id, u.worker_thread_id AS "workerThreadId", u.message,
        u.created_at AS "createdAt"
      FROM flow_updates u JOIN flow_workers w ON w.thread_id = u.worker_thread_id
      WHERE w.parent_thread_id = ${parentThreadId}
      ORDER BY u.sequence DESC LIMIT 20
    `;
    return rows.toReversed().map((row): FlowUpdate => ({
      sequence: row.sequence,
      workerThreadId: ThreadId.make(row.workerThreadId),
      message: row.message,
      createdAt: row.createdAt,
    }));
  }, Effect.mapError(persistence));

  const recordUpdate = Effect.fn("FlowStore.recordUpdate")(function* (input: {
    readonly workerThreadId: ThreadId;
    readonly id: string;
    readonly message: string;
    readonly createdAt: string;
  }) {
    return yield* sql
      .withTransaction(
        Effect.gen(function* () {
          const prior =
            yield* sql<UpdateRow>`SELECT sequence, id, worker_thread_id AS "workerThreadId", message, created_at AS "createdAt" FROM flow_updates WHERE id = ${input.id}`;
          if (prior[0]) {
            if (
              prior[0].workerThreadId !== input.workerThreadId ||
              prior[0].message !== input.message
            )
              return yield* fail("conflict", "This Flow update ID was already used.");
            return {
              sequence: prior[0].sequence,
              workerThreadId: input.workerThreadId,
              message: prior[0].message,
              createdAt: prior[0].createdAt,
            } satisfies FlowUpdate;
          }
          const worker = yield* getWorkerRow(input.workerThreadId);
          if (!worker || worker.state === "stopped")
            return yield* fail("not-found", "Active Flow worker was not found.");
          yield* sql`INSERT INTO flow_updates (id, worker_thread_id, message, created_at) VALUES (${input.id}, ${input.workerThreadId}, ${input.message}, ${input.createdAt})`;
          const saved =
            yield* sql<UpdateRow>`SELECT sequence, id, worker_thread_id AS "workerThreadId", message, created_at AS "createdAt" FROM flow_updates WHERE id = ${input.id}`;
          return {
            sequence: saved[0]!.sequence,
            workerThreadId: input.workerThreadId,
            message: input.message,
            createdAt: input.createdAt,
          } satisfies FlowUpdate;
        }),
      )
      .pipe(Effect.mapError((cause) => (isFlowError(cause) ? cause : persistence())));
  });

  const findParent = Effect.fn("FlowStore.findParent")(function* (threadId: ThreadId) {
    const row = yield* getWorkerRow(threadId);
    if (row) return ThreadId.make(row.parentThreadId);
    const rows = yield* sql<{ threadId: string }>`
      SELECT thread_id AS "threadId" FROM projection_threads
      WHERE thread_id = ${threadId} AND deleted_at IS NULL
        AND (flow_enabled = 1 OR EXISTS (
          SELECT 1 FROM flow_workers WHERE parent_thread_id = ${threadId}
        ))
    `;
    return rows[0] ? ThreadId.make(rows[0].threadId) : null;
  }, Effect.mapError(persistence));

  const reserveWorker = Effect.fn("FlowStore.reserveWorker")(function* (input: {
    readonly threadId: ThreadId;
    readonly parentThreadId: ThreadId;
    readonly spawnId: string;
    readonly assignment: string;
    readonly modelSelection: ModelSelection;
    readonly profileId?: string | undefined;
    readonly branch: string;
    readonly jobId: string;
    readonly messageId: string;
    readonly createdAt: string;
  }) {
    return yield* sql
      .withTransaction(
        Effect.gen(function* () {
          const prior =
            yield* sql<WorkerRow>`SELECT thread_id AS "threadId", parent_thread_id AS "parentThreadId", spawn_id AS "spawnId", assignment, model_selection_json AS "modelSelectionJson", profile_id AS "profileId", branch, worktree_path AS "worktreePath", state, error, created_at AS "createdAt", updated_at AS "updatedAt" FROM flow_workers WHERE spawn_id = ${input.spawnId}`;
          if (prior[0]) {
            if (
              prior[0].parentThreadId !== input.parentThreadId ||
              prior[0].assignment !== input.assignment ||
              prior[0].profileId !== (input.profileId ?? null) ||
              prior[0].modelSelectionJson !== encodeSelection(input.modelSelection)
            )
              return yield* fail(
                "conflict",
                "This Flow request ID was already used for another assignment.",
              );
            return yield* toWorker(prior[0]);
          }
          const enabled = yield* isEnabled(input.parentThreadId);
          if (!enabled)
            return yield* fail("invalid", "Enable Flow on this thread before starting a worker.");
          yield* sql`
          INSERT INTO flow_workers (thread_id, parent_thread_id, spawn_id, assignment, model_selection_json, profile_id, branch, worktree_path, state, error, created_at, updated_at)
          VALUES (${input.threadId}, ${input.parentThreadId}, ${input.spawnId}, ${input.assignment}, ${encodeSelection(input.modelSelection)}, ${input.profileId ?? null}, ${input.branch}, NULL, 'queued', NULL, ${input.createdAt}, ${input.createdAt})
        `;
          yield* sql`
          INSERT INTO flow_jobs (id, worker_thread_id, command_id, message_id, prompt, state, result, error, created_at, updated_at)
          VALUES (${input.jobId}, ${input.threadId}, ${input.jobId}, ${input.messageId}, ${input.assignment}, 'queued', NULL, NULL, ${input.createdAt}, ${input.createdAt})
        `;
          return yield* toWorker((yield* getWorkerRow(input.threadId))!);
        }),
      )
      .pipe(Effect.mapError((error) => (isFlowError(error) ? error : persistence())));
  });

  const reserveJob = Effect.fn("FlowStore.reserveJob")(function* (input: {
    readonly parentThreadId: ThreadId;
    readonly workerThreadId: ThreadId;
    readonly id: string;
    readonly messageId: string;
    readonly message: string;
    readonly delivery: "turn" | "steer";
    readonly createdAt: string;
  }) {
    return yield* sql
      .withTransaction(
        Effect.gen(function* () {
          const prior =
            yield* sql<JobRow>`SELECT id, worker_thread_id AS "workerThreadId", command_id AS "commandId", message_id AS "messageId", delivery, prompt, state, result, error, created_at AS "createdAt", updated_at AS "updatedAt" FROM flow_jobs WHERE id = ${input.id}`;
          if (prior[0]) {
            if (
              prior[0].workerThreadId !== input.workerThreadId ||
              prior[0].prompt !== input.message
            )
              return yield* fail(
                "conflict",
                "This Flow request ID was already used for another message.",
              );
            return toJob(prior[0]);
          }
          const worker = yield* getWorkerRow(input.workerThreadId);
          if (!worker || worker.parentThreadId !== input.parentThreadId)
            return yield* fail("not-found", "Worker does not belong to this Flow.");
          if (worker.state !== "idle" && worker.state !== "working")
            return yield* fail(
              "conflict",
              "Worker is not ready for a message. Wait for it to start or stop it.",
            );
          const queued = yield* sql<{
            count: number;
          }>`SELECT COUNT(*) AS count FROM flow_jobs WHERE worker_thread_id = ${input.workerThreadId} AND state = 'queued'`;
          if ((queued[0]?.count ?? 0) > 0)
            return yield* fail("conflict", "A message is already queued for this worker.");
          yield* sql`
          INSERT INTO flow_jobs (id, worker_thread_id, command_id, message_id, delivery, prompt, state, result, error, created_at, updated_at)
          VALUES (${input.id}, ${input.workerThreadId}, ${input.id}, ${input.messageId}, ${input.delivery}, ${input.message}, 'queued', NULL, NULL, ${input.createdAt}, ${input.createdAt})
        `;
          if (worker.state === "idle")
            yield* sql`UPDATE flow_workers SET state = 'queued', updated_at = ${input.createdAt} WHERE thread_id = ${input.workerThreadId}`;
          return toJob((yield* getJobRow(input.id))!);
        }),
      )
      .pipe(Effect.mapError((error) => (isFlowError(error) ? error : persistence())));
  });

  const activeJobs = Effect.gen(function* () {
    const rows =
      yield* sql<JobRow>`SELECT id, worker_thread_id AS "workerThreadId", command_id AS "commandId", message_id AS "messageId", delivery, prompt, state, result, error, created_at AS "createdAt", updated_at AS "updatedAt" FROM flow_jobs WHERE state IN ('queued', 'working') ORDER BY created_at ASC, rowid ASC`;
    return rows;
  }).pipe(Effect.mapError(persistence));

  const updateJob = Effect.fn("FlowStore.updateJob")(function* (input: {
    readonly id: string;
    readonly state: FlowJob["state"];
    readonly workerState: FlowWorker["state"];
    readonly result?: string | null;
    readonly error?: string | null;
    readonly updatedAt: string;
  }) {
    yield* sql
      .withTransaction(
        Effect.gen(function* () {
          const row = yield* getJobRow(input.id);
          if (
            !row ||
            row.state === "stopped" ||
            row.state === "completed" ||
            row.state === "failed"
          )
            return;
          yield* sql`
        UPDATE flow_jobs SET state = ${input.state}, result = ${input.result ?? null}, error = ${input.error ?? null}, updated_at = ${input.updatedAt}
        WHERE id = ${input.id}
      `;
          const active = yield* sql<{
            count: number;
          }>`SELECT COUNT(*) AS count FROM flow_jobs WHERE worker_thread_id = ${row.workerThreadId} AND state IN ('queued', 'working')`;
          const workerState = (active[0]?.count ?? 0) > 0 ? "working" : input.workerState;
          yield* sql`
        UPDATE flow_workers SET state = ${workerState}, error = ${input.error ?? null}, updated_at = ${input.updatedAt}
        WHERE thread_id = ${row.workerThreadId} AND state != 'stopped'
      `;
        }),
      )
      .pipe(Effect.mapError(persistence));
  });

  const setWorktree = Effect.fn("FlowStore.setWorktree")(function* (
    workerThreadId: ThreadId,
    worktreePath: string,
  ) {
    yield* sql`
      UPDATE flow_workers SET worktree_path = ${worktreePath}, updated_at = ${yield* nowIso}
      WHERE thread_id = ${workerThreadId} AND worktree_path IS NULL AND state != 'stopped'
    `.pipe(Effect.mapError(persistence));
  });

  const stop = Effect.fn("FlowStore.stop")(function* (
    parentThreadId: ThreadId,
    workerThreadId: ThreadId,
  ) {
    return yield* sql
      .withTransaction(
        Effect.gen(function* () {
          const row = yield* getWorkerRow(workerThreadId);
          if (!row || row.parentThreadId !== parentThreadId)
            return yield* fail("not-found", "Worker does not belong to this Flow.");
          const now = yield* nowIso;
          yield* sql`UPDATE flow_workers SET state = 'stopped', updated_at = ${now} WHERE thread_id = ${workerThreadId}`;
          yield* sql`UPDATE flow_jobs SET state = 'stopped', updated_at = ${now} WHERE worker_thread_id = ${workerThreadId} AND state IN ('queued', 'working')`;
          return yield* toWorker((yield* getWorkerRow(workerThreadId))!);
        }),
      )
      .pipe(Effect.mapError((error) => (isFlowError(error) ? error : persistence())));
  });

  return {
    isEnabled,
    getWorker,
    getWorkerBySpawnId,
    getJob,
    listWorkers,
    listUpdates,
    recordUpdate,
    findParent,
    reserveWorker,
    reserveJob,
    activeJobs,
    updateJob,
    setWorktree,
    stop,
  };
});

export class FlowStore extends Context.Service<FlowStore, Effect.Success<typeof make>>()(
  "dispatch/flow/FlowStore",
) {}

export const layer = Layer.effect(FlowStore, make);

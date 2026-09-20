import { admitExecutionTurn } from "./execution.ts";
import { readyTasks, receiveResult } from "./decider.ts";
import {
  ThreadId,
  TeamError,
  TeamPolicy,
  TeamRun,
  type TeamExecutionTurn,
} from "@dispatch/contracts";
import * as DateTime from "effect/DateTime";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { defaultTeamPolicy } from "./routing.ts";

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const persistenceError = () =>
  new TeamError({ code: "persistence", message: "Team state could not be read or committed." });
const decodeRunValue = Schema.decodeUnknownEffect(TeamRun);
const decodeUnknownJson = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));
const isTeamError = Schema.is(TeamError);

function normalizeLegacyRun(value: unknown): unknown {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return value;
  const run = value as Record<string, unknown>;
  const execution = run.execution;
  if (typeof execution !== "object" || execution === null || Array.isArray(execution)) return value;
  const executionRecord = execution as Record<string, unknown>;
  if (!Array.isArray(executionRecord.turns)) return value;

  let changed = false;
  const turns = executionRecord.turns.map((turn) => {
    if (
      typeof turn !== "object" ||
      turn === null ||
      Array.isArray(turn) ||
      (turn as Record<string, unknown>).role !== "consult"
    ) {
      return turn;
    }
    changed = true;
    return { ...(turn as Record<string, unknown>), role: "review" };
  });
  if (!changed) return value;
  return { ...run, execution: { ...executionRecord, turns } };
}

const decodeRunPayload = (payload: string) =>
  decodeUnknownJson(payload).pipe(Effect.map(normalizeLegacyRun), Effect.flatMap(decodeRunValue));

export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const decodePolicy = Schema.decodeUnknownEffect(Schema.fromJsonString(TeamPolicy));
  const decodeRun = decodeRunPayload;
  const getPolicy = Effect.gen(function* () {
    const rows = yield* sql<{ payload: string }>`SELECT payload FROM team_policy WHERE id = 1`;
    return rows[0] ? yield* decodePolicy(rows[0].payload) : defaultTeamPolicy;
  }).pipe(Effect.mapError(persistenceError));
  const savePolicy = Effect.fn("TeamStore.savePolicy")(function* (policy: TeamPolicy) {
    return yield* sql
      .withTransaction(
        Effect.gen(function* () {
          const current = yield* getPolicy;
          if (policy.revision !== current.revision)
            return yield* new TeamError({
              code: "conflict",
              message: "Settings changed elsewhere. Reload before saving.",
            });
          const next = { ...policy, revision: policy.revision + 1 };
          yield* sql`INSERT INTO team_policy (id, revision, payload) VALUES (1, ${next.revision}, ${encodeJson(next)}) ON CONFLICT(id) DO UPDATE SET revision=excluded.revision, payload=excluded.payload`;
          return next;
        }),
      )
      .pipe(Effect.mapError((error) => (isTeamError(error) ? error : persistenceError())));
  });
  const list = Effect.gen(function* () {
    const rows = yield* sql<{
      payload: string;
    }>`SELECT payload FROM team_runs ORDER BY rowid DESC LIMIT 100`;
    return yield* Effect.forEach(rows, (row) => decodeRun(row.payload));
  }).pipe(Effect.mapError(persistenceError));
  const get = Effect.fn("TeamStore.get")(function* (id: string) {
    const rows = yield* sql<{
      payload: string;
    }>`SELECT payload FROM team_runs WHERE id = ${id}`.pipe(Effect.mapError(persistenceError));
    if (!rows[0])
      return yield* new TeamError({ code: "not-found", message: "Team run not found." });
    return yield* decodeRun(rows[0].payload).pipe(Effect.mapError(persistenceError));
  });
  const findByThread = Effect.fn("TeamStore.findByThread")(function* (threadId: ThreadId) {
    const rows = yield* sql<{ payload: string }>`
      SELECT payload FROM team_runs
      WHERE json_extract(payload, '$.execution.leadThreadId') = ${threadId}
        OR EXISTS (SELECT 1 FROM json_each(team_runs.payload, '$.tasks')
          WHERE json_extract(value, '$.threadId') = ${threadId})
        OR EXISTS (SELECT 1 FROM json_each(team_runs.payload, '$.execution.turns')
          WHERE json_extract(value, '$.command.threadId') = ${threadId})
      ORDER BY rowid DESC LIMIT 1`.pipe(Effect.mapError(persistenceError));
    return rows[0]
      ? yield* decodeRun(rows[0].payload).pipe(Effect.mapError(persistenceError))
      : null;
  });
  const create = Effect.fn("TeamStore.create")(function* (run: TeamRun) {
    return yield* sql
      .withTransaction(
        Effect.gen(function* () {
          const previous = yield* sql<{
            payload: string;
          }>`SELECT payload FROM team_runs WHERE command_id = ${run.commandId}`;
          if (previous[0]) {
            const old = yield* decodeRun(previous[0].payload);
            if (
              old.projectId !== run.projectId ||
              old.objective !== run.objective ||
              encodeJson(old.policy) !== encodeJson(run.policy)
            )
              return yield* new TeamError({
                code: "conflict",
                message: "Command ID already belongs to a different request.",
              });
            return old;
          }
          yield* sql`INSERT INTO team_runs (id, command_id, revision, payload) VALUES (${run.id}, ${run.commandId}, ${run.revision}, ${encodeJson(run)})`;
          yield* sql`INSERT INTO team_events (run_id, revision, payload) VALUES (${run.id}, ${run.revision}, ${encodeJson({ type: "created", run })})`;
          return run;
        }),
      )
      .pipe(Effect.mapError((error) => (isTeamError(error) ? error : persistenceError())));
  });
  const update = Effect.fn("TeamStore.update")(function* (
    id: string,
    revision: number,
    change: (run: TeamRun) => TeamRun,
    event: string,
  ) {
    return yield* sql
      .withTransaction(
        Effect.gen(function* () {
          const current = yield* get(id);
          if (current.revision !== revision)
            return yield* new TeamError({
              code: "conflict",
              message: "Run changed; reload its current state.",
            });
          const candidate = yield* Effect.try({
            try: () => change(current),
            catch: (error) =>
              isTeamError(error)
                ? error
                : new TeamError({ code: "invalid", message: "Invalid team transition." }),
          });
          const now = yield* DateTime.now;
          const next = yield* decodeRunValue({
            ...candidate,
            id: current.id,
            commandId: current.commandId,
            revision: revision + 1,
            updatedAt: DateTime.formatIso(now),
          });
          yield* sql`UPDATE team_runs SET revision = ${next.revision}, payload = ${encodeJson(next)} WHERE id = ${id} AND revision = ${revision}`;
          yield* sql`INSERT INTO team_events (run_id, revision, payload) VALUES (${id}, ${next.revision}, ${encodeJson({ type: event, run: next })})`;
          return next;
        }),
      )
      .pipe(Effect.mapError((error) => (isTeamError(error) ? error : persistenceError())));
  });
  const reserve = Effect.fn("TeamStore.reserve")(function* (
    id: string,
    revision: number,
    taskId: string,
    effectId: string,
    threadId: ThreadId,
  ) {
    return yield* sql
      .withTransaction(
        Effect.gen(function* () {
          const run = yield* get(id);
          if (run.revision !== revision)
            return yield* new TeamError({
              code: "conflict",
              message: "Run changed before admission.",
            });
          const continuing = run.tasks.find((t) => t.id === taskId);
          if (continuing?.threadId && continuing.threadId !== threadId)
            return yield* new TeamError({
              code: "conflict",
              message: "A continuing worker must retain its provider thread.",
            });
          const unresolved = yield* sql<{
            run_id: string;
          }>`SELECT run_id FROM team_effects WHERE status != 'settled'`;
          if (
            unresolved.length >= 4 ||
            !readyTasks(run, unresolved.filter((e) => e.run_id === id).length).some(
              (t) => t.id === taskId,
            )
          )
            return yield* new TeamError({
              code: "conflict",
              message: "Task is not ready or all worker slots are reserved.",
            });
          const next = yield* update(
            id,
            revision,
            (current) => ({
              ...current,
              tasks: current.tasks.map((t) =>
                t.id === taskId
                  ? {
                      ...t,
                      generation: t.generation + 1,
                      attempts: t.attempts + 1,
                      status: "running",
                      threadId,
                    }
                  : t,
              ),
            }),
            "attempt-reserved",
          );
          const task = next.tasks.find((t) => t.id === taskId)!;
          yield* sql`INSERT INTO team_effects (id, run_id, task_id, generation, status, payload) VALUES (${effectId}, ${id}, ${taskId}, ${task.generation}, 'reserved', ${encodeJson({ threadId })})`;
          return next;
        }),
      )
      .pipe(Effect.mapError((error) => (isTeamError(error) ? error : persistenceError())));
  });
  // Must commit BEFORE calling a provider. On interruption, this row retains its slot.
  const beginDispatch = Effect.fn("TeamStore.beginDispatch")(function* (effectId: string) {
    const rows =
      yield* sql`UPDATE team_effects SET status = 'dispatching' WHERE id = ${effectId} AND status = 'reserved' RETURNING id`.pipe(
        Effect.mapError(persistenceError),
      );
    if (rows.length !== 1)
      return yield* new TeamError({
        code: "conflict",
        message: "Effect has already been dispatched or requires reconciliation.",
      });
  });
  const recoverUncertain =
    sql`UPDATE team_effects SET status = 'unknown' WHERE status IN ('dispatching','running')`.pipe(
      Effect.asVoid,
      Effect.mapError(persistenceError),
    );
  const settle = Effect.fn("TeamStore.settle")(function* (effectId: string, result: string) {
    return yield* sql
      .withTransaction(
        Effect.gen(function* () {
          const effects = yield* sql<{
            run_id: string;
            task_id: string;
            generation: number;
            status: string;
          }>`SELECT run_id, task_id, generation, status FROM team_effects WHERE id = ${effectId}`;
          const effect = effects[0];
          if (!effect)
            return yield* new TeamError({
              code: "not-found",
              message: "Attempt effect not found.",
            });
          const run = yield* get(effect.run_id);
          if (effect.status === "settled") return run;
          if (effect.status === "reserved")
            return yield* new TeamError({
              code: "conflict",
              message: "Undispatched attempt cannot return a result.",
            });
          const next = yield* update(
            run.id,
            run.revision,
            (current) => receiveResult(current, effect.task_id, effect.generation, result),
            "attempt-returned",
          );
          yield* sql`UPDATE team_effects SET status = 'settled' WHERE id = ${effectId}`;
          return next;
        }),
      )
      .pipe(Effect.mapError((error) => (isTeamError(error) ? error : persistenceError())));
  });
  // Admission and the durable command are one transaction. Replays dispatch the same
  // command ID through the orchestration engine's existing durable receipt boundary.
  const reserveTurn = Effect.fn("TeamStore.reserveTurn")(function* (
    id: string,
    revision: number,
    turn: TeamExecutionTurn,
  ) {
    return yield* sql
      .withTransaction(
        Effect.gen(function* () {
          const current = yield* get(id);
          if (
            current.revision !== revision ||
            !current.execution ||
            !["planning", "running", "review"].includes(current.status)
          )
            return yield* new TeamError({
              code: "conflict",
              message: "Run cannot admit this turn.",
            });
          const budget = current.policy.estimatedBudgetUsd;
          if (budget !== undefined && budget !== null) {
            const estimates = [...current.execution.turns, turn].map((t) => t.estimatedAttemptUsd);
            if (estimates.some((cost) => cost === undefined || cost === null))
              return yield* new TeamError({
                code: "invalid",
                message:
                  "An estimated budget requires a known estimate for every admitted profile and prior turn.",
              });
            // Reserve whole attempts, including failed/uncertain dispatches. This is
            // a conservative planning estimate, never a claim about provider billing.
            const reservedMicros = estimates.reduce<number>(
              (total, cost) => total + Math.ceil(cost! * 1_000_000),
              0,
            );
            if (reservedMicros > Math.floor(budget * 1_000_000))
              return yield* new TeamError({
                code: "invalid",
                message: "Team estimated budget exhausted. No additional turn was dispatched.",
              });
          }
          const rows = yield* sql<{ payload: string }>`SELECT payload FROM team_runs`;
          const runs = yield* Effect.forEach(rows, (row) => decodeRun(row.payload));
          const unresolved = runs.flatMap((run) =>
            (run.execution?.turns ?? []).filter((t) => t.status !== "settled"),
          );
          const local = current.execution.turns.filter((t) => t.status !== "settled");
          const legacy = yield* sql<{
            count: number;
          }>`SELECT COUNT(*) AS count FROM team_effects WHERE status != 'settled'`;
          if (
            unresolved.length + (legacy[0]?.count ?? 0) >= 5 ||
            local.length >= current.policy.maxActive ||
            unresolved.some((t) => t.command.threadId === turn.command.threadId)
          )
            return yield* new TeamError({
              code: "conflict",
              message: "All team slots are reserved or this thread is busy.",
            });
          if (turn.status !== "reserved" || current.execution.turns.some((t) => t.id === turn.id))
            return yield* new TeamError({ code: "invalid", message: "Invalid turn reservation." });
          return yield* update(
            id,
            revision,
            (run) => admitExecutionTurn(run, turn),
            "turn-reserved",
          );
        }),
      )
      .pipe(Effect.mapError((error) => (isTeamError(error) ? error : persistenceError())));
  });
  const active = Effect.gen(function* () {
    // Do not hide an older active run behind the 100 most recent history entries.
    const rows = yield* sql<{
      payload: string;
    }>`SELECT payload FROM team_runs WHERE json_extract(payload, '$.execution') IS NOT NULL AND (json_extract(payload, '$.execution.phase') != 'done' OR EXISTS (SELECT 1 FROM json_each(json_extract(payload, '$.execution.turns')) WHERE json_extract(value, '$.status') != 'settled'))`;
    return yield* Effect.forEach(rows, (row) => decodeRun(row.payload));
  }).pipe(Effect.mapError(persistenceError));
  const recordRoutingUsage = (input: {
    fingerprint: string;
    model: string;
    inputTokens: number | null;
    outputTokens: number | null;
    succeeded: boolean;
  }) =>
    sql`INSERT INTO team_routing_usage (fingerprint, model, input_tokens, output_tokens, succeeded) VALUES (${input.fingerprint}, ${input.model}, ${input.inputTokens}, ${input.outputTokens}, ${input.succeeded ? 1 : 0})`.pipe(
      Effect.asVoid,
      Effect.mapError(persistenceError),
    );
  return {
    active,
    reserveTurn,
    recordRoutingUsage,
    findByThread,
    getPolicy,
    savePolicy,
    list,
    get,
    create,
    update,
    reserve,
    beginDispatch,
    recoverUncertain,
    settle,
  };
});
export class TeamStore extends Context.Service<TeamStore, Effect.Success<typeof make>>()(
  "dispatch/team/TeamStore",
) {}
export const layer = Layer.effect(TeamStore, make);

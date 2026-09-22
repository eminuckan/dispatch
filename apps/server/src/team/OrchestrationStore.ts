import { TeamError, TeamRun, TeamSettings, type ThreadId } from "@dispatch/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const decodeSettings = Schema.decodeUnknownEffect(Schema.fromJsonString(TeamSettings));
const decodeRun = Schema.decodeUnknownEffect(Schema.fromJsonString(TeamRun));
const decodeRunValue = Schema.decodeUnknownEffect(TeamRun);
const isTeamError = Schema.is(TeamError);

const persistenceError = () =>
  new TeamError({
    code: "persistence",
    message: "Flow state could not be read or committed.",
  });

const conflict = (message: string) => new TeamError({ code: "conflict", message });

type RevisionedPayloadRow = {
  readonly revision: number;
  readonly payload: string;
};

const decodeSettingsRow = Effect.fn("OrchestrationStore.decodeSettingsRow")(function* (
  row: RevisionedPayloadRow,
) {
  const settings = yield* decodeSettings(row.payload);
  if (settings.policy.revision !== row.revision) return yield* persistenceError();
  return settings;
});

const decodeRunRow = Effect.fn("OrchestrationStore.decodeRunRow")(function* (
  row: RevisionedPayloadRow,
) {
  const run = yield* decodeRun(row.payload);
  if (run.revision !== row.revision) return yield* persistenceError();
  return run;
});

export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const getSettings = Effect.gen(function* () {
    const rows = yield* sql<RevisionedPayloadRow>`
      SELECT revision, payload
      FROM orchestration_v2_settings
      WHERE id = 1
    `;
    return rows[0] ? yield* decodeSettingsRow(rows[0]) : null;
  }).pipe(Effect.mapError(persistenceError));

  const saveSettings = Effect.fn("OrchestrationStore.saveSettings")(function* (
    settings: TeamSettings,
  ) {
    return yield* sql
      .withTransaction(
        Effect.gen(function* () {
          const rows = yield* sql<{ revision: number }>`
            SELECT revision
            FROM orchestration_v2_settings
            WHERE id = 1
          `;
          const currentRevision = rows[0]?.revision ?? 0;
          if (currentRevision !== settings.policy.revision)
            return yield* conflict("Flow settings changed; reload before saving.");

          const next: TeamSettings = {
            policy: { ...settings.policy, revision: currentRevision + 1 },
            smartRouting: settings.smartRouting,
          };
          const payload = encodeJson(next);
          if (rows[0]) {
            yield* sql`
              UPDATE orchestration_v2_settings
              SET revision = ${next.policy.revision}, payload = ${payload}
              WHERE id = 1 AND revision = ${currentRevision}
            `;
          } else {
            yield* sql`
              INSERT INTO orchestration_v2_settings (id, revision, payload)
              VALUES (1, ${next.policy.revision}, ${payload})
            `;
          }

          const changes = yield* sql<{ changed: number }>`SELECT changes() AS changed`;
          if (changes[0]?.changed !== 1)
            return yield* conflict("Flow settings changed; reload before saving.");
          return next;
        }),
      )
      .pipe(Effect.mapError((error) => (isTeamError(error) ? error : persistenceError())));
  });

  const list = Effect.gen(function* () {
    const rows = yield* sql<RevisionedPayloadRow>`
      SELECT revision, payload
      FROM orchestration_v2_runs
      ORDER BY rowid DESC
    `;
    return yield* Effect.forEach(rows, decodeRunRow);
  }).pipe(Effect.mapError(persistenceError));

  const get = Effect.fn("OrchestrationStore.get")(function* (id: string) {
    const rows = yield* sql<RevisionedPayloadRow>`
      SELECT revision, payload
      FROM orchestration_v2_runs
      WHERE id = ${id}
    `.pipe(Effect.mapError(persistenceError));
    if (!rows[0]) return yield* new TeamError({ code: "not-found", message: "Run not found." });
    return yield* decodeRunRow(rows[0]).pipe(Effect.mapError(persistenceError));
  });

  const create = Effect.fn("OrchestrationStore.create")(function* (candidate: TeamRun) {
    return yield* sql
      .withTransaction(
        Effect.gen(function* () {
          const run = yield* decodeRunValue(candidate);
          const previous = yield* sql<RevisionedPayloadRow>`
            SELECT revision, payload
            FROM orchestration_v2_runs
            WHERE command_id = ${run.commandId}
          `;
          if (previous[0]) return yield* decodeRunRow(previous[0]);

          const reusedId = yield* sql<{ command_id: string }>`
            SELECT command_id
            FROM orchestration_v2_runs
            WHERE id = ${run.id}
          `;
          if (reusedId[0]) return yield* conflict("Run ID already belongs to another command.");

          const payload = encodeJson(run);
          yield* sql`
            INSERT INTO orchestration_v2_runs (id, command_id, revision, payload)
            VALUES (${run.id}, ${run.commandId}, ${run.revision}, ${payload})
          `;
          yield* sql`
            INSERT INTO orchestration_v2_events (run_id, revision, event, payload)
            VALUES (${run.id}, ${run.revision}, 'created', ${payload})
          `;
          return run;
        }),
      )
      .pipe(Effect.mapError((error) => (isTeamError(error) ? error : persistenceError())));
  });

  const update = Effect.fn("OrchestrationStore.update")(function* (
    id: string,
    revision: number,
    change: (run: TeamRun) => TeamRun,
    event: string,
  ) {
    return yield* sql
      .withTransaction(
        Effect.gen(function* () {
          if (!event.trim())
            return yield* new TeamError({ code: "invalid", message: "Run event is required." });
          const current = yield* get(id);
          if (current.revision !== revision)
            return yield* conflict("Run changed; reload its current state.");

          const candidate = yield* Effect.try({
            try: () => change(current),
            catch: (error) =>
              isTeamError(error)
                ? error
                : new TeamError({ code: "invalid", message: "Invalid Flow transition." }),
          });
          const updatedAt = DateTime.formatIso(yield* DateTime.now);
          const next = yield* decodeRunValue({
            ...candidate,
            id: current.id,
            commandId: current.commandId,
            revision: revision + 1,
            updatedAt,
          });
          const payload = encodeJson(next);
          yield* sql`
            UPDATE orchestration_v2_runs
            SET revision = ${next.revision}, payload = ${payload}
            WHERE id = ${id} AND revision = ${revision}
          `;
          const changes = yield* sql<{ changed: number }>`SELECT changes() AS changed`;
          if (changes[0]?.changed !== 1)
            return yield* conflict("Run changed; reload its current state.");
          yield* sql`
            INSERT INTO orchestration_v2_events (run_id, revision, event, payload)
            VALUES (${id}, ${next.revision}, ${event.trim()}, ${payload})
          `;
          return next;
        }),
      )
      .pipe(Effect.mapError((error) => (isTeamError(error) ? error : persistenceError())));
  });

  const findByThread = Effect.fn("OrchestrationStore.findByThread")(function* (threadId: ThreadId) {
    const rows = yield* sql<RevisionedPayloadRow>`
      SELECT revision, payload
      FROM orchestration_v2_runs
      WHERE json_extract(payload, '$.lead.threadId') = ${threadId}
        OR EXISTS (
          SELECT 1 FROM json_each(orchestration_v2_runs.payload, '$.tasks')
          WHERE json_extract(value, '$.owner.threadId') = ${threadId}
        )
        OR EXISTS (
          SELECT 1 FROM json_each(orchestration_v2_runs.payload, '$.attempts')
          WHERE json_extract(value, '$.owner.threadId') = ${threadId}
        )
        OR EXISTS (
          SELECT 1 FROM json_each(orchestration_v2_runs.payload, '$.messages')
          WHERE json_extract(value, '$.from.threadId') = ${threadId}
             OR json_extract(value, '$.to.threadId') = ${threadId}
        )
        OR EXISTS (
          SELECT 1 FROM json_each(orchestration_v2_runs.payload, '$.settlements')
          WHERE json_extract(value, '$.owner.threadId') = ${threadId}
        )
      ORDER BY rowid DESC
      LIMIT 1
    `;
    return rows[0] ? yield* decodeRunRow(rows[0]) : null;
  }, Effect.mapError(persistenceError));

  const active = Effect.gen(function* () {
    const rows = yield* sql<RevisionedPayloadRow>`
      SELECT revision, payload
      FROM orchestration_v2_runs
      WHERE json_extract(payload, '$.status') NOT IN ('completed', 'cancelled', 'failed')
      ORDER BY rowid ASC
    `;
    return yield* Effect.forEach(rows, decodeRunRow);
  }).pipe(Effect.mapError(persistenceError));

  return { getSettings, saveSettings, list, get, create, update, findByThread, active };
});

export class OrchestrationStore extends Context.Service<
  OrchestrationStore,
  Effect.Success<typeof make>
>()("dispatch/team/OrchestrationStore") {}

export const layer = Layer.effect(OrchestrationStore, make);

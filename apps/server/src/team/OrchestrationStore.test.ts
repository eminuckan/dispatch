import { expect, it } from "@effect/vitest";
import {
  MessageId,
  ProjectId,
  ProviderInstanceId,
  TeamRun,
  TeamSettings,
  ThreadId,
  type TeamAttempt,
} from "@dispatch/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { make } from "./OrchestrationStore.ts";

const profile = {
  id: "capable",
  label: "Capable",
  selection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-test" },
  lead: true,
  worker: true,
  capability: "frontier" as const,
};
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

const settings: TeamSettings = {
  policy: {
    revision: 0,
    enabled: true,
    flowMode: "standard",
    profiles: [profile],
    maxActive: 3,
    maxAttempts: 2,
    providerLimitBehavior: "ask",
  },
  smartRouting: { available: false, reason: "smart_routing_session_required" },
};

const baseRun = (id: string, status: TeamRun["status"] = "running"): TeamRun => ({
  id,
  commandId: `command-${id}`,
  projectId: ProjectId.make("project"),
  revision: 0,
  executionMode: "orchestrated",
  runtimeMode: "approval-required",
  prompt: `objective-${id}`,
  policy: settings.policy,
  lead: { role: "lead", profileId: profile.id, threadId: null, taskId: null },
  acceptance: [],
  decisions: [],
  status,
  statusReason: null,
  workspace: null,
  tasks: [],
  attempts: [],
  messages: [],
  settlements: [],
  failovers: [],
  attachments: [],
  createdAt: "2026-09-21T00:00:00.000Z",
  updatedAt: "2026-09-21T00:00:00.000Z",
});

const workerAttempt = (id: string, threadId: ThreadId): TeamAttempt => ({
  id,
  commandId: `attempt-command-${id}`,
  requestMessageId: MessageId.make(`attempt-message-${id}`),
  taskId: "task",
  role: "work",
  sequence: 0,
  owner: { role: "worker", profileId: profile.id, threadId, taskId: "task" },
  selection: profile.selection,
  prompt: `Persisted worker prompt ${id}`,
  attachments: [],
  status: "succeeded",
  providerTurnId: null,
  resultMessageId: null,
  result: "done",
  failure: null,
  createdAt: "2026-09-21T00:00:00.000Z",
  updatedAt: "2026-09-21T00:00:00.000Z",
});

it.effect("saves settings with optimistic revisions", () =>
  Effect.gen(function* () {
    const store = yield* make;
    expect(yield* store.getSettings).toBeNull();

    const first = yield* store.saveSettings({
      ...settings,
      supportedProviderInstanceIds: [ProviderInstanceId.make("untrusted-persisted-hint")],
    });
    expect(first.policy.revision).toBe(1);
    expect(first).not.toHaveProperty("supportedProviderInstanceIds");
    expect(yield* store.getSettings).toEqual(first);

    const stale = yield* store.saveSettings(settings).pipe(Effect.flip);
    expect(stale.code).toBe("conflict");

    const second = yield* store.saveSettings({
      ...first,
      smartRouting: { available: true, reason: null },
    });
    expect(second.policy.revision).toBe(2);
    expect((yield* store.getSettings)?.smartRouting.available).toBe(true);
  }).pipe(Effect.provide(SqlitePersistenceMemory)),
);

it.effect("creates idempotently and rejects stale run updates", () =>
  Effect.gen(function* () {
    const store = yield* make;
    const sql = yield* SqlClient.SqlClient;
    const run = baseRun("one");

    expect(yield* store.create(run)).toEqual(run);
    expect(yield* store.create({ ...run, id: "replayed-id" })).toEqual(run);
    expect(
      (yield* store.create({ ...run, commandId: "different-command" }).pipe(Effect.flip)).code,
    ).toBe("conflict");

    const updated = yield* store.update(
      run.id,
      run.revision,
      (current) => ({ ...current, status: "paused" }),
      "paused",
    );
    expect(updated.revision).toBe(1);
    expect(updated.status).toBe("paused");
    expect(
      (yield* store.update(run.id, run.revision, (current) => current, "stale").pipe(Effect.flip))
        .code,
    ).toBe("conflict");

    const events = yield* sql<{ revision: number; event: string }>`
      SELECT revision, event
      FROM orchestration_v2_events
      WHERE run_id = ${run.id}
      ORDER BY revision
    `;
    expect(events).toEqual([
      { revision: 0, event: "created" },
      { revision: 1, event: "paused" },
    ]);
  }).pipe(Effect.provide(SqlitePersistenceMemory)),
);

it.effect("decodes a pre-runtime-mode stored run as supervised", () =>
  Effect.gen(function* () {
    const store = yield* make;
    const sql = yield* SqlClient.SqlClient;
    const run = baseRun("legacy-runtime-mode");
    const { runtimeMode: _runtimeMode, ...legacyRun } = run;

    yield* sql`
      INSERT INTO orchestration_v2_runs (id, command_id, revision, payload)
      VALUES (${run.id}, ${run.commandId}, ${run.revision}, ${encodeJson(legacyRun)})
    `;

    expect((yield* store.get(run.id)).runtimeMode).toBe("approval-required");
  }).pipe(Effect.provide(SqlitePersistenceMemory)),
);

it.effect(
  "lists runs, finds exact thread membership, and returns non-terminal runs as active",
  () =>
    Effect.gen(function* () {
      const store = yield* make;
      const leadThreadId = ThreadId.make("lead-thread");
      const currentWorkerThreadId = ThreadId.make("current-worker-thread");
      const historicalWorkerThreadId = ThreadId.make("historical-worker-thread");
      const original = baseRun("membership");
      const run: TeamRun = {
        ...original,
        lead: { ...original.lead, threadId: leadThreadId },
        tasks: [
          {
            id: "task",
            objective: "task objective",
            acceptance: ["passes"],
            dependencies: [],
            owner: {
              role: "worker",
              profileId: profile.id,
              threadId: currentWorkerThreadId,
              taskId: "task",
            },
            branch: "team/task",
            worktreePath: "/repo/task",
            status: "settled",
            attemptIds: ["historical"],
            settlementId: null,
            result: "done",
          },
        ],
        attempts: [workerAttempt("historical", historicalWorkerThreadId)],
        workspace: {
          root: "/repo",
          baseCommit: "abc123",
          integrationHead: "abc123",
          leadBranch: "team/lead",
          leadWorktreePath: "/repo/lead",
        },
      };
      yield* store.create(run);
      yield* store.create(baseRun("completed", "completed"));
      yield* store.create(baseRun("planning", "planning"));

      expect((yield* store.list).map(({ id }) => id)).toEqual(["planning", "completed", run.id]);
      expect((yield* store.get(run.id)).id).toBe(run.id);
      expect((yield* store.findByThread(leadThreadId))?.id).toBe(run.id);
      expect((yield* store.findByThread(currentWorkerThreadId))?.id).toBe(run.id);
      const historical = yield* store.findByThread(historicalWorkerThreadId);
      expect(historical?.id).toBe(run.id);
      expect(historical?.attempts[0]).toMatchObject({
        commandId: "attempt-command-historical",
        requestMessageId: "attempt-message-historical",
        prompt: "Persisted worker prompt historical",
      });
      expect(yield* store.findByThread(ThreadId.make("unrelated-thread"))).toBeNull();
      expect((yield* store.active).map(({ id }) => id)).toEqual([run.id, "planning"]);
    }).pipe(Effect.provide(SqlitePersistenceMemory)),
);

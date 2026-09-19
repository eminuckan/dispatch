import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import {
  CommandId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type TeamExecutionTurn,
  type TeamRun,
} from "@t3tools/contracts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { make } from "./TeamStore.ts";
import { defaultTeamPolicy } from "./routing.ts";
const profile = {
  id: "p",
  label: "P",
  selection: { instanceId: ProviderInstanceId.make("codex"), model: "large" },
  tier: "capable" as const,
  lead: true,
  worker: true,
  estimatedAttemptUsd: null,
};
const run: TeamRun = {
  id: "run",
  commandId: "cmd",
  projectId: ProjectId.make("project"),
  revision: 0,
  objective: "build",
  policy: { ...defaultTeamPolicy, profiles: [profile], maxActive: 2 },
  lead: profile,
  status: "running",
  tasks: [
    {
      id: "a",
      objective: "one",
      acceptance: ["test"],
      dependencies: [],
      profileId: "p",
      status: "pending",
      generation: 0,
      attempts: 0,
      threadId: null,
      context: "context",
      result: null,
    },
    {
      id: "b",
      objective: "two",
      acceptance: ["test"],
      dependencies: [],
      profileId: "p",
      status: "pending",
      generation: 0,
      attempts: 0,
      threadId: null,
      context: "context",
      result: null,
    },
  ],
  decisions: [],
  createdAt: "now",
  updatedAt: "now",
};
it.effect("persists idempotent create, rejects conflicting replay and stale writes", () =>
  Effect.gen(function* () {
    const store = yield* make;
    expect(yield* store.create(run)).toEqual(run);
    expect(yield* store.create({ ...run, id: "other" })).toEqual(run);
    expect((yield* store.create({ ...run, objective: "other" }).pipe(Effect.flip)).code).toBe(
      "conflict",
    );
    yield* store.update(run.id, 0, (r) => ({ ...r, status: "paused" }), "paused");
    expect((yield* store.update(run.id, 0, (r) => r, "stale").pipe(Effect.flip)).code).toBe(
      "conflict",
    );
    const reopened = yield* make;
    expect((yield* reopened.get(run.id)).status).toBe("paused");
  }).pipe(Effect.provide(SqlitePersistenceMemory)),
);
it.effect("reserves atomically, retains unknown slots after restart and settles exactly once", () =>
  Effect.gen(function* () {
    const store = yield* make;
    const sql = yield* SqlClient.SqlClient;
    yield* store.create(run);
    yield* store.reserve(run.id, 0, "a", "effect-a", ThreadId.make("thread-a"));
    yield* store.beginDispatch("effect-a");
    yield* store.recoverUncertain;
    expect(
      (yield* store
        .reserve(run.id, 1, "b", "effect-b", ThreadId.make("thread-b"))
        .pipe(Effect.flip)).code,
    ).toBe("conflict");
    expect((yield* store.beginDispatch("effect-a").pipe(Effect.flip)).code).toBe("conflict");
    const returned = yield* store.settle("effect-a", "worker output");
    expect(returned.tasks[0]?.status).toBe("review");
    expect(yield* store.settle("effect-a", "duplicate output")).toEqual(returned);
    expect(
      (yield* sql<{ status: string }>`SELECT status FROM team_effects WHERE id = 'effect-a'`)[0]
        ?.status,
    ).toBe("settled");
    yield* store.reserve(run.id, returned.revision, "b", "effect-b", ThreadId.make("thread-b"));
  }).pipe(Effect.provide(SqlitePersistenceMemory)),
);

const executionRun = (id: string, maxTurns = 2): TeamRun => ({
  ...run,
  id,
  commandId: id,
  execution: {
    workspaceRoot: "/repo",
    baseCommit: "abc",
    leadThreadId: ThreadId.make(`lead-${id}`),
    maxTurns,
    turns: [],
    phase: "workers",
    notice: null,
  },
});
const leadTurn = (r: TeamRun, id: string): TeamExecutionTurn => ({
  id,
  role: "review",
  taskId: null,
  status: "reserved",
  result: null,
  succeeded: false,
  command: {
    type: "thread.turn.start",
    commandId: CommandId.make(id),
    threadId: r.execution!.leadThreadId,
    message: { messageId: MessageId.make(id), role: "user", text: "review", attachments: [] },
    modelSelection: r.lead.selection,
    runtimeMode: "full-access",
    interactionMode: "default",
    createdAt: "2026-09-19T00:00:00.000Z",
  },
});
it.effect("counts leads in global admission and enforces the durable total-turn budget", () =>
  Effect.gen(function* () {
    const store = yield* make;
    for (let i = 0; i < 5; i++) {
      const r = executionRun(`run-${i}`);
      yield* store.create(r);
      yield* store.reserveTurn(r.id, 0, leadTurn(r, `turn-${i}`));
    }
    const sixth = executionRun("sixth");
    yield* store.create(sixth);
    expect(
      (yield* store.reserveTurn(sixth.id, 0, leadTurn(sixth, "sixth-turn")).pipe(Effect.flip)).code,
    ).toBe("conflict");
    const first = yield* store.get("run-0");
    const settled = yield* store.update(
      first.id,
      first.revision,
      (r) => ({
        ...r,
        execution: {
          ...r.execution!,
          maxTurns: 1,
          turns: r.execution!.turns.map((t) => ({ ...t, status: "settled" })),
        },
      }),
      "test-settled",
    );
    expect(
      (yield* store
        .reserveTurn(settled.id, settled.revision, leadTurn(settled, "over-budget"))
        .pipe(Effect.flip)).message,
    ).toBe("Team turn budget exhausted.");
    yield* store.reserveTurn(sixth.id, 0, leadTurn(sixth, "sixth-turn"));
  }).pipe(Effect.provide(SqlitePersistenceMemory)),
);

it.effect("fails closed for unknown estimates and reserves retry-inclusive planning costs", () =>
  Effect.gen(function* () {
    const store = yield* make;
    const r = { ...executionRun("cost", 5), policy: { ...run.policy, estimatedBudgetUsd: 0.3 } };
    yield* store.create(r);
    expect(
      (yield* store.reserveTurn(r.id, 0, leadTurn(r, "unknown-cost")).pipe(Effect.flip)).code,
    ).toBe("invalid");
    const first = yield* store.reserveTurn(r.id, 0, {
      ...leadTurn(r, "cost-one"),
      estimatedAttemptUsd: 0.2,
    });
    const settled = yield* store.update(
      r.id,
      first.revision,
      (x) => ({
        ...x,
        execution: {
          ...x.execution!,
          turns: x.execution!.turns.map((t) => ({ ...t, status: "settled", succeeded: false })),
        },
      }),
      "test-failed-attempt",
    );
    expect(
      (yield* store
        .reserveTurn(r.id, settled.revision, {
          ...leadTurn(r, "cost-too-much"),
          estimatedAttemptUsd: 0.2,
        })
        .pipe(Effect.flip)).message,
    ).toContain("estimated budget exhausted");
    yield* store.reserveTurn(r.id, settled.revision, {
      ...leadTurn(r, "cost-last"),
      estimatedAttemptUsd: 0.1,
    });
  }).pipe(Effect.provide(SqlitePersistenceMemory)),
);

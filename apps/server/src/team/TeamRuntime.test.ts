import { OrchestrationProjectorDecodeError } from "../orchestration/Errors.ts";
import { GitWorkflowService } from "../git/GitWorkflowService.ts";
import { expect, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  MessageId,
  OrchestrationThread,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type OrchestrationCommand,
  type TeamRun,
  type ServerProvider,
} from "@t3tools/contracts";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import {
  ProjectionTurnRepository,
  type ProjectionTurnById,
} from "../persistence/Services/ProjectionTurns.ts";
import { ProviderRegistry } from "../provider/Services/ProviderRegistry.ts";
import { ProcessRunner } from "../processRunner.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import * as Store from "./TeamStore.ts";
import { TeamRouter } from "./TeamRouter.ts";
import { make } from "./TeamRuntime.ts";
import { defaultTeamPolicy } from "./routing.ts";
const decodeThread = Schema.decodeUnknownSync(OrchestrationThread);
const date = "2026-09-19T00:00:00.000Z";
const provider: ServerProvider = {
  instanceId: ProviderInstanceId.make("codex"),
  driver: ProviderDriverKind.make("codex"),
  enabled: true,
  installed: true,
  version: null,
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: date,
  models: [{ slug: "test", name: "Test", isCustom: false, capabilities: null }],
  slashCommands: [],
  skills: [],
};
const profile = {
  id: "p",
  label: "P",
  selection: { instanceId: provider.instanceId, model: "test" },
  tier: "capable" as const,
  lead: true,
  worker: true,
  estimatedAttemptUsd: null,
};
const initial: TeamRun = {
  id: "abc",
  commandId: "start",
  projectId: ProjectId.make("project"),
  revision: 0,
  objective: "Fix boundary",
  policy: { ...defaultTeamPolicy, profiles: [profile] },
  lead: profile,
  status: "planning",
  tasks: [],
  decisions: [],
  createdAt: date,
  updatedAt: date,
  execution: {
    workspaceRoot: "/repo",
    baseCommit: "abc",
    leadThreadId: ThreadId.make("team-abc-lead"),
    maxTurns: 1,
    turns: [],
    phase: "plan",
    notice: null,
  },
};
function fixture(failAcknowledgement = false, driver = "codex") {
  const commands: OrchestrationCommand[] = [];
  const lifecycleActivities: Array<
    Extract<OrchestrationCommand, { type: "thread.activity.append" }>
  > = [];
  const checks: string[] = [];
  const threads = new Map<string, OrchestrationThread>();
  const receipts = new Map<string, ProjectionTurnById>();
  let clockStep = 0;
  const nextTime = () =>
    DateTime.formatIso(DateTime.add(DateTime.makeUnsafe(date), { seconds: ++clockStep * 10 }));
  const pendingStarts = new Set<string>();
  const complete = (
    command: Extract<OrchestrationCommand, { type: "thread.turn.start" }>,
    text: string,
  ) => {
    const turnId = TurnId.make(`turn-${command.commandId}`);
    const answer = MessageId.make(`answer-${command.commandId}`);
    const previous = threads.get(command.threadId);
    const startedAt = nextTime();
    const completedAt = DateTime.formatIso(
      DateTime.add(DateTime.makeUnsafe(startedAt), { seconds: 1 }),
    );
    receipts.set(turnId, {
      threadId: command.threadId,
      turnId,
      pendingMessageId: command.message.messageId,
      sourceProposedPlanThreadId: null,
      sourceProposedPlanId: null,
      assistantMessageId: answer,
      state: "completed",
      requestedAt: startedAt,
      startedAt,
      completedAt,
      checkpointTurnCount: null,
      checkpointRef: null,
      checkpointStatus: null,
      checkpointFiles: [],
    });
    threads.set(
      command.threadId,
      decodeThread({
        id: command.threadId,
        projectId: initial.projectId,
        title: "Managed",
        modelSelection: profile.selection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: "team/test",
        worktreePath: "/isolated",
        createdAt: date,
        updatedAt: date,
        deletedAt: null,
        latestTurn: {
          turnId,
          state: "completed",
          requestedAt: startedAt,
          startedAt,
          completedAt,
          assistantMessageId: answer,
        },
        messages: [
          ...(previous?.messages.filter(
            (m) => m.id !== answer && m.id !== command.message.messageId,
          ) ?? []),
          {
            id: command.message.messageId,
            role: "user",
            text: command.message.text,
            turnId: null,
            streaming: false,
            createdAt: date,
            updatedAt: date,
          },
          {
            id: answer,
            role: "assistant",
            text,
            turnId,
            streaming: false,
            createdAt: date,
            updatedAt: date,
          },
        ],
        activities: previous?.activities ?? [],
        checkpoints: [],
        session: null,
      }),
    );
  };
  const supersede = (
    command: Extract<OrchestrationCommand, { type: "thread.turn.start" }>,
    text: string,
    manualRunning = false,
  ) => {
    if (!receipts.has(`turn-${command.commandId}`)) complete(command, text);
    const thread = threads.get(command.threadId);
    if (!thread || !thread.latestTurn) throw new Error("Expected completed managed turn");
    const manualTurnId = TurnId.make(`manual-${command.commandId}`);
    const manualAnswer = MessageId.make(`manual-answer-${command.commandId}`);
    const startedAt = nextTime();
    receipts.set(manualTurnId, {
      ...receipts.get(`turn-${command.commandId}`)!,
      turnId: manualTurnId,
      pendingMessageId: MessageId.make(`manual-message-${command.commandId}`),
      requestedAt: startedAt,
      startedAt,
      completedAt: manualRunning ? null : startedAt,
      state: manualRunning ? "running" : "completed",
      assistantMessageId: manualRunning ? null : manualAnswer,
    });
    threads.set(
      command.threadId,
      decodeThread({
        ...thread,
        latestTurn: {
          ...thread.latestTurn,
          turnId: manualTurnId,
          state: manualRunning ? "running" : "completed",
          requestedAt: startedAt,
          startedAt,
          completedAt: manualRunning ? null : startedAt,
          assistantMessageId: manualRunning ? null : manualAnswer,
        },
        messages: [
          ...thread.messages,
          {
            id: MessageId.make(`manual-message-${command.commandId}`),
            role: "user",
            text: "A manual follow-up",
            turnId: null,
            streaming: false,
            createdAt: date,
            updatedAt: date,
          },
          ...(manualRunning
            ? []
            : [
                {
                  id: manualAnswer,
                  role: "assistant" as const,
                  text: "Manual follow-up complete",
                  turnId: manualTurnId,
                  streaming: false,
                  createdAt: date,
                  updatedAt: date,
                },
              ]),
        ],
      }),
    );
  };
  const setActivities = (threadId: string, activities: OrchestrationThread["activities"]) => {
    const thread = threads.get(threadId);
    if (thread) threads.set(threadId, { ...thread, activities });
  };
  const layers = Layer.mergeAll(
    Layer.mock(TeamRouter)({
      assess: (draft) =>
        Effect.succeed({
          draftId: draft.draftId,
          revision: draft.revision,
          fingerprint: "test",
          policyRevision: draft.policyRevision,
          profileId: "p",
          selection: profile.selection,
          tier: "capable",
          confidence: 1,
          reason: "fixture",
          source: "jev",
          inputTokens: null,
          outputTokens: null,
        }),
    }),
    Layer.mock(GitWorkflowService)({
      listRefs: () =>
        Effect.succeed({
          refs: [
            { name: "team/test", current: false, isDefault: false, worktreePath: "/isolated" },
          ],
          isRepo: true,
          hasPrimaryRemote: false,
          nextCursor: null,
          totalCount: 1,
        }),
      createWorktree: () =>
        Effect.succeed({ worktree: { path: "/isolated", refName: "team/test" } }),
    }),
    Layer.mock(ProviderRegistry)({
      getProviders: Effect.succeed([{ ...provider, driver: ProviderDriverKind.make(driver) }]),
    }),
    Layer.mock(ProcessRunner)({
      run: (input) =>
        Effect.sync(() => {
          checks.push(input.command);
          return {
            code: ChildProcessSpawner.ExitCode(0),
            stdout: "passed",
            stderr: "",
            timedOut: false,
            stdoutTruncated: false,
            stderrTruncated: false,
            stdoutInvalidUtf8: false,
            stderrInvalidUtf8: false,
          };
        }),
    }),
    Layer.mock(ProjectionSnapshotQuery)({
      getThreadDetailById: (id) => Effect.succeed(Option.fromUndefinedOr(threads.get(id))),
      getThreadShellById: () => Effect.succeed(Option.none()),
    }),
    Layer.mock(ProjectionTurnRepository)({
      getPendingTurnStartByThreadId: ({ threadId }) =>
        Effect.succeed(
          pendingStarts.has(threadId)
            ? Option.some({
                threadId,
                messageId: MessageId.make(`pending-${threadId}`),
                sourceProposedPlanThreadId: null,
                sourceProposedPlanId: null,
                requestedAt: date,
              })
            : Option.none(),
        ),
      listByThreadId: ({ threadId }) =>
        Effect.succeed([...receipts.values()].filter((turn) => turn.threadId === threadId)),
      getByTurnId: ({ turnId }) => Effect.succeed(Option.fromUndefinedOr(receipts.get(turnId))),
    }),
    Layer.mock(OrchestrationEngineService)({
      dispatch: (command) =>
        Effect.gen(function* () {
          if (command.type === "thread.activity.append") lifecycleActivities.push(command);
          else if (command.type !== "thread.create") commands.push(command);
          if (command.type === "thread.turn.start" && failAcknowledgement) {
            failAcknowledgement = false;
            return yield* new OrchestrationProjectorDecodeError({
              eventType: "thread.turn-start-requested",
              issue: "simulated acknowledgement loss",
            });
          }
          return { sequence: commands.length };
        }),
    }),
  );
  return {
    commands,
    complete,
    supersede,
    setActivities,
    layers,
    checks,
    lifecycleActivities,
    pendingStarts,
    receipts,
    threads,
  };
}
it.effect(
  "dispatches a durable plan once and matches completion through the canonical request receipt",
  () => {
    const f = fixture();
    return Effect.gen(function* () {
      const store = yield* Store.make;
      yield* store.create(initial);
      const runtime = yield* make.pipe(
        Effect.provideService(Store.TeamStore, store),
        Effect.provide(f.layers),
      );
      yield* runtime.tick();
      expect(f.commands).toHaveLength(1);
      yield* runtime.tick();
      expect(f.commands).toHaveLength(1);
      const plan = f.commands[0]!;
      if (plan.type !== "thread.turn.start") throw new Error("Expected plan dispatch");
      f.complete(
        plan,
        '{"acceptance":["Combined result"],"tasks":[],"rationale":"Lead-only bounded work"}',
      );
      yield* runtime.tick();
      expect(f.commands).toHaveLength(2);
      const run = yield* store.get(initial.id);
      expect(run.execution?.phase).toBe("integrate");
      expect(run.execution?.turns[0]?.status).toBe("settled");
      expect(run.execution?.turns[1]?.command.threadId).toBe(initial.execution?.leadThreadId);
    }).pipe(Effect.provide(SqlitePersistenceMemory));
  },
);

it.effect("settles a managed turn by its request when a manual follow-up becomes latest", () => {
  const f = fixture();
  return Effect.gen(function* () {
    const store = yield* Store.make;
    yield* store.create(initial);
    const runtime = yield* make.pipe(
      Effect.provideService(Store.TeamStore, store),
      Effect.provide(f.layers),
    );
    yield* runtime.tick();
    const plan = f.commands[0]!;
    if (plan.type !== "thread.turn.start") throw new Error("Expected plan dispatch");
    f.supersede(
      plan,
      '{"acceptance":["Combined result"],"tasks":[],"rationale":"Lead-only bounded work"}',
    );
    yield* runtime.tick();
    const run = yield* store.get(initial.id);
    expect(run.execution?.turns[0]?.status).toBe("settled");
    expect(run.execution?.turns[0]?.succeeded).toBe(true);
  }).pipe(Effect.provide(SqlitePersistenceMemory));
});

it.effect("defers the next managed turn while a newer manual follow-up is running", () => {
  const f = fixture();
  return Effect.gen(function* () {
    const store = yield* Store.make;
    yield* store.create(initial);
    const runtime = yield* make.pipe(
      Effect.provideService(Store.TeamStore, store),
      Effect.provide(f.layers),
    );
    yield* runtime.tick();
    const plan = f.commands[0]!;
    if (plan.type !== "thread.turn.start") throw new Error("Expected plan dispatch");
    f.supersede(
      plan,
      '{"acceptance":["Combined result"],"tasks":[],"rationale":"Lead-only bounded work"}',
      true,
    );
    yield* runtime.tick();
    expect(f.commands).toHaveLength(1);
    expect((yield* store.get(initial.id)).execution?.turns[0]?.status).toBe("dispatched");
  }).pipe(Effect.provide(SqlitePersistenceMemory));
});

it.effect("defers review when the lead has a newer manual follow-up running", () => {
  const f = fixture();
  return Effect.gen(function* () {
    const store = yield* Store.make;
    yield* store.create(initial);
    const runtime = yield* make.pipe(
      Effect.provideService(Store.TeamStore, store),
      Effect.provide(f.layers),
    );
    yield* runtime.tick();
    const plan = f.commands[0]!;
    if (plan.type !== "thread.turn.start") throw new Error("Expected plan dispatch");
    f.complete(
      plan,
      '{"acceptance":["Combined result"],"tasks":[{"id":"edit","objective":"Edit label","acceptance":["Exact label check"],"dependencies":[],"profileId":"p","context":"contract"}],"rationale":"bounded worker"}',
    );
    yield* runtime.tick();
    const worker = f.commands[1]!;
    if (worker.type !== "thread.turn.start") throw new Error("Expected worker dispatch");
    f.supersede(plan, plan.message.text, true);
    f.complete(worker, "Worker complete; commit abc.");
    yield* runtime.tick();
    expect(f.commands).toHaveLength(2);
    const run = yield* store.get(initial.id);
    expect(run.execution?.turns.find((turn) => turn.role === "worker")?.status).toBe("settled");
    expect(run.execution?.turns.some((turn) => turn.role === "review")).toBe(false);
  }).pipe(Effect.provide(SqlitePersistenceMemory));
});

it.effect("defers a lead reservation while a pending turn start is projected", () => {
  const f = fixture();
  return Effect.gen(function* () {
    const store = yield* Store.make;
    yield* store.create(initial);
    const runtime = yield* make.pipe(
      Effect.provideService(Store.TeamStore, store),
      Effect.provide(f.layers),
    );
    yield* runtime.tick();
    const plan = f.commands[0]!;
    if (plan.type !== "thread.turn.start") throw new Error("Expected plan dispatch");
    f.complete(plan, '{"acceptance":["Combined result"],"tasks":[],"rationale":"lead"}');
    f.pendingStarts.add(initial.execution!.leadThreadId);
    yield* runtime.tick();
    expect(f.commands).toHaveLength(1);
    expect((yield* store.get(initial.id)).execution?.turns).toHaveLength(1);
  }).pipe(Effect.provide(SqlitePersistenceMemory));
});

it.effect("persists attachments and sends them only on each managed thread's first turn", () => {
  const f = fixture();
  const attachment = {
    type: "file" as const,
    id: "file-1",
    name: "notes.txt",
    mimeType: "text/plain",
    sizeBytes: 4,
  };
  return Effect.gen(function* () {
    const store = yield* Store.make;
    yield* store.create({ ...initial, attachments: [attachment] });
    const runtime = yield* make.pipe(
      Effect.provideService(Store.TeamStore, store),
      Effect.provide(f.layers),
    );
    yield* runtime.tick();
    const plan = f.commands[0]!;
    if (plan.type !== "thread.turn.start") throw new Error("Expected plan dispatch");
    expect(plan.message.attachments).toEqual([attachment]);
    f.complete(plan, '{"acceptance":["Combined result"],"tasks":[],"rationale":"lead"}');
    yield* runtime.tick();
    const integrate = f.commands[1]!;
    if (integrate.type !== "thread.turn.start") throw new Error("Expected integration dispatch");
    expect(integrate.message.attachments).toEqual([]);
    expect((yield* store.get(initial.id)).attachments).toEqual([attachment]);
  }).pipe(Effect.provide(SqlitePersistenceMemory));
});

it.effect("waits for native questions and follows the exact message-mode answer turn", () => {
  const f = fixture();
  return Effect.gen(function* () {
    const store = yield* Store.make;
    yield* store.create(initial);
    const runtime = yield* make.pipe(
      Effect.provideService(Store.TeamStore, store),
      Effect.provide(f.layers),
    );
    yield* runtime.tick();
    const plan = f.commands[0]!;
    if (plan.type !== "thread.turn.start") throw new Error("Expected plan");
    f.complete(plan, "Which scope should I use?");
    const turnId = TurnId.make(`turn-${plan.commandId}`);
    const question = {
      id: EventId.make("question"),
      kind: "user-input.requested",
      tone: "info" as const,
      summary: "Choose scope",
      turnId,
      createdAt: date,
      payload: { requestId: "scope", responseMode: "message" },
    };
    f.setActivities(plan.threadId, [question]);
    yield* runtime.tick();
    expect(f.commands).toHaveLength(1);
    expect((yield* store.get(initial.id)).execution?.turns[0]?.status).toBe("dispatched");
    f.setActivities(plan.threadId, [
      question,
      {
        ...question,
        id: EventId.make("answer"),
        kind: "user-input.resolved",
        payload: { requestId: "scope", responseMode: "message", answers: { scope: "frontend" } },
      },
    ]);
    // Resolving a question precedes the normal provider receipt: wait for it.
    yield* runtime.tick();
    expect(f.commands).toHaveLength(1);
    const result = '{"acceptance":["Combined result"],"tasks":[],"rationale":"Confirmed scope"}';
    f.complete(
      {
        ...plan,
        commandId: CommandId.make("question-answer"),
        message: {
          ...plan.message,
          messageId: MessageId.make("async-answer:scope"),
          text: "frontend",
        },
      },
      result,
    );
    yield* runtime.tick();
    const run = yield* store.get(initial.id);
    expect(run.execution?.turns[0]?.result).toBe(result);
    expect(run.execution?.turns[0]?.succeeded).toBe(true);
    expect(run.execution?.phase).toBe("integrate");
  }).pipe(Effect.provide(SqlitePersistenceMemory));
});

it.effect("pauses when the provider cannot start the native question answer turn", () => {
  const f = fixture();
  return Effect.gen(function* () {
    const store = yield* Store.make;
    yield* store.create(initial);
    const runtime = yield* make.pipe(
      Effect.provideService(Store.TeamStore, store),
      Effect.provide(f.layers),
    );
    yield* runtime.tick();
    const plan = f.commands[0]!;
    if (plan.type !== "thread.turn.start") throw new Error("Expected plan");
    f.complete(plan, "Which scope should I use?");
    const question = {
      id: EventId.make("question"),
      kind: "user-input.requested",
      tone: "info" as const,
      summary: "Choose scope",
      turnId: TurnId.make(`turn-${plan.commandId}`),
      createdAt: date,
      payload: { requestId: "scope", responseMode: "message" },
    };
    f.setActivities(plan.threadId, [
      question,
      {
        ...question,
        id: EventId.make("answer"),
        kind: "user-input.resolved",
        payload: { requestId: "scope", responseMode: "message", answers: { scope: "frontend" } },
      },
      {
        ...question,
        id: EventId.make("start-failed"),
        kind: "provider.turn.start.failed",
        turnId: null,
        payload: { requestId: "async-answer:scope", detail: "Provider unavailable" },
      },
    ]);
    yield* runtime.tick();
    const run = yield* store.get(initial.id);
    expect(run.status).toBe("paused");
    expect(run.execution?.turns[0]?.status).toBe("dispatched");
    expect(f.commands).toHaveLength(1);
  }).pipe(Effect.provide(SqlitePersistenceMemory));
});

it.effect("a dismissed optional question does not block a completed managed result", () => {
  const f = fixture();
  return Effect.gen(function* () {
    const store = yield* Store.make;
    yield* store.create(initial);
    const runtime = yield* make.pipe(
      Effect.provideService(Store.TeamStore, store),
      Effect.provide(f.layers),
    );
    yield* runtime.tick();
    const plan = f.commands[0]!;
    if (plan.type !== "thread.turn.start") throw new Error("Expected plan");
    f.complete(plan, '{"acceptance":["Combined result"],"tasks":[],"rationale":"Default scope"}');
    const question = {
      id: EventId.make("question"),
      kind: "user-input.requested",
      tone: "info" as const,
      summary: "Optional preference",
      turnId: TurnId.make(`turn-${plan.commandId}`),
      createdAt: date,
      payload: { requestId: "optional", responseMode: "message" },
    };
    f.setActivities(plan.threadId, [
      question,
      { ...question, id: EventId.make("dismiss"), kind: "user-input.resolved" },
    ]);
    yield* runtime.tick();
    expect((yield* store.get(initial.id)).execution?.phase).toBe("integrate");
  }).pipe(Effect.provide(SqlitePersistenceMemory));
});

it.effect("does not advance a completed result while approval remains open", () => {
  const f = fixture();
  return Effect.gen(function* () {
    const store = yield* Store.make;
    yield* store.create(initial);
    const runtime = yield* make.pipe(
      Effect.provideService(Store.TeamStore, store),
      Effect.provide(f.layers),
    );
    yield* runtime.tick();
    const plan = f.commands[0]!;
    if (plan.type !== "thread.turn.start") throw new Error("Expected plan");
    f.complete(plan, '{"acceptance":["Combined result"],"tasks":[],"rationale":"Ready"}');
    const request = {
      id: EventId.make("approval"),
      kind: "approval.requested",
      tone: "approval" as const,
      summary: "Approve",
      turnId: TurnId.make(`turn-${plan.commandId}`),
      createdAt: date,
      payload: { requestId: "approval" },
    };
    f.setActivities(plan.threadId, [request]);
    yield* runtime.tick();
    expect(f.commands).toHaveLength(1);
    f.setActivities(plan.threadId, [
      request,
      { ...request, id: EventId.make("approved"), kind: "approval.resolved" },
    ]);
    yield* runtime.tick();
    expect((yield* store.get(initial.id)).execution?.phase).toBe("integrate");
  }).pipe(Effect.provide(SqlitePersistenceMemory));
});

it.effect(
  "pauses an overtaken partial turn instead of accepting its forced completed state",
  () => {
    const f = fixture();
    return Effect.gen(function* () {
      const store = yield* Store.make;
      yield* store.create(initial);
      const runtime = yield* make.pipe(
        Effect.provideService(Store.TeamStore, store),
        Effect.provide(f.layers),
      );
      yield* runtime.tick();
      const plan = f.commands[0]!;
      if (plan.type !== "thread.turn.start") throw new Error("Expected plan");
      f.supersede(plan, '{"acceptance":["Partial scope"],"tasks":[],"rationale":"Partial"}');
      const original = f.receipts.get(`turn-${plan.commandId}`)!;
      const manual = f.receipts.get(`manual-${plan.commandId}`)!;
      f.receipts.set(original.turnId, { ...original, completedAt: manual.startedAt });
      yield* runtime.tick();
      const run = yield* store.get(initial.id);
      expect(run.status).toBe("paused");
      expect(run.execution?.notice).toContain("interrupted");
      expect(run.execution?.turns[0]?.succeeded).toBe(false);
      expect(f.commands).toHaveLength(1);
    }).pipe(Effect.provide(SqlitePersistenceMemory));
  },
);

it.effect("pause retains in-flight reservations and resume never replays a dispatched turn", () => {
  const f = fixture();
  return Effect.gen(function* () {
    const store = yield* Store.make;
    yield* store.create(initial);
    const runtime = yield* make.pipe(
      Effect.provideService(Store.TeamStore, store),
      Effect.provide(f.layers),
    );
    yield* runtime.tick();
    const run = yield* store.get(initial.id);
    const paused = yield* runtime.control({ id: run.id, revision: run.revision, action: "pause" });
    yield* runtime.tick();
    expect(f.commands).toHaveLength(1);
    expect(paused.execution?.turns[0]?.status).toBe("dispatched");
    yield* runtime.control({ id: paused.id, revision: paused.revision, action: "resume" });
    yield* runtime.tick();
    expect(f.commands).toHaveLength(1);
  }).pipe(Effect.provide(SqlitePersistenceMemory));
});

it.effect(
  "repairs lead acceptance IDs without retrying the worker, then verifies combined output",
  () => {
    const f = fixture();
    const attachments: NonNullable<TeamRun["attachments"]> = [
      { type: "image", id: "diagram", name: "diagram.png", mimeType: "image/png", sizeBytes: 40 },
      { type: "file", id: "notes", name: "notes.txt", mimeType: "text/plain", sizeBytes: 20 },
    ];
    return Effect.gen(function* () {
      const store = yield* Store.make;
      yield* store.create({ ...initial, attachments });
      const runtime = yield* make.pipe(
        Effect.provideService(Store.TeamStore, store),
        Effect.provide(f.layers),
      );
      const finish = (index: number, text: string) => {
        const command = f.commands[index]!;
        if (command.type !== "thread.turn.start") throw new Error("Expected turn");
        f.complete(command, text);
      };
      yield* runtime.tick();
      finish(
        0,
        '{"acceptance":["Combined result"],"tasks":[{"id":"edit","objective":"Edit label","acceptance":["Exact label check"],"dependencies":[],"profileId":"p","context":"contract"}],"rationale":"bounded worker"}',
      );
      yield* runtime.tick();
      expect(
        f.commands[1]?.type === "thread.turn.start" ? f.commands[1].message.attachments : null,
      ).toEqual(attachments);
      finish(1, "Worker complete; commit abc.");
      yield* runtime.tick();
      expect(
        f.commands[2]?.type === "thread.turn.start" ? f.commands[2].message.attachments : null,
      ).toEqual([]);
      expect(f.lifecycleActivities.map((command) => command.activity.kind)).toEqual([
        "team.worker-dispatched",
        "team.worker-result",
      ]);
      expect(f.lifecycleActivities[0]?.activity.payload).toMatchObject({
        taskId: "edit",
        threadId: expect.stringContaining("team-abc-"),
      });
      finish(
        2,
        '{"action":"accept","summary":"Looks correct","checks":[{"criterion":"Reworded label check","command":"python3","args":[]}]}',
      );
      yield* runtime.tick();
      let run = yield* store.get(initial.id);
      expect(run.tasks[0]?.attempts).toBe(1);
      expect(run.execution?.turns.map((t) => t.role)).toEqual([
        "plan",
        "worker",
        "review",
        "review",
      ]);
      expect(f.checks).toEqual([]);
      finish(
        3,
        '{"action":"accept","summary":"Corrected evidence mapping","checks":[{"criterionIndex":0,"criterion":"Reworded label check","command":"python3","args":[]}]}',
      );
      yield* runtime.tick();
      run = yield* store.get(initial.id);
      expect(run.tasks[0]?.status).toBe("accepted");
      expect(run.status).not.toBe("completed");
      expect(f.checks).toEqual(["python3"]);
      expect(f.lifecycleActivities.at(-1)?.activity.kind).toBe("team.worker-accepted");
      finish(
        4,
        '{"action":"accept","summary":"Integrated and verified","checks":[{"criterion":"Combined result","command":"python3","args":[]}]}',
      );
      yield* runtime.tick();
      run = yield* store.get(initial.id);
      expect(run.status).toBe("completed");
      expect(f.checks).toEqual(["python3", "python3"]);
      expect(run.tasks[0]?.attempts).toBe(1);
      expect(run.decisions.some((d) => d.includes("passed"))).toBe(true);
    }).pipe(Effect.provide(SqlitePersistenceMemory));
  },
);

it.effect("retains an uncertain dispatch reservation and interrupts it on cancellation", () => {
  const f = fixture(true);
  return Effect.gen(function* () {
    const store = yield* Store.make;
    yield* store.create(initial);
    const runtime = yield* make.pipe(
      Effect.provideService(Store.TeamStore, store),
      Effect.provide(f.layers),
    );
    yield* runtime.tick();
    let run = yield* store.get(initial.id);
    expect(run.status).toBe("paused");
    expect(run.execution?.turns[0]?.status).toBe("dispatching");
    yield* runtime.control({ id: run.id, revision: run.revision, action: "cancel" });
    expect(f.commands[1]?.type).toBe("thread.turn.interrupt");
    const sent = f.commands[0]!;
    if (sent.type !== "thread.turn.start") throw new Error("Expected start");
    f.complete(sent, "Turn terminated after cancellation.");
    yield* runtime.tick();
    run = yield* store.get(initial.id);
    expect(run.status).toBe("cancelled");
    expect(run.execution?.turns[0]?.status).toBe("settled");
    expect(f.commands).toHaveLength(2);
  }).pipe(Effect.provide(SqlitePersistenceMemory));
});

it.effect("admits ready providers through the common adapter contract", () => {
  const f = fixture(false, "opencode");
  return Effect.gen(function* () {
    const store = yield* Store.make;
    yield* store.create(initial);
    const runtime = yield* make.pipe(
      Effect.provideService(Store.TeamStore, store),
      Effect.provide(f.layers),
    );
    yield* runtime.tick();
    expect((yield* store.get(initial.id)).execution?.turns[0]?.status).toBe("dispatched");
  }).pipe(Effect.provide(SqlitePersistenceMemory));
});

it.effect(
  "rejects incomplete combined acceptance, allows one correction, and never loops on resume",
  () => {
    const f = fixture();
    return Effect.gen(function* () {
      const store = yield* Store.make;
      yield* store.create(initial);
      const runtime = yield* make.pipe(
        Effect.provideService(Store.TeamStore, store),
        Effect.provide(f.layers),
      );
      const finish = (index: number, text: string) => {
        const command = f.commands[index]!;
        if (command.type !== "thread.turn.start") throw new Error("Expected turn");
        f.complete(command, text);
      };
      yield* runtime.tick();
      finish(
        0,
        '{"acceptance":["Behavior works","Constraints preserved"],"tasks":[],"rationale":"Lead alone"}',
      );
      yield* runtime.tick();
      finish(
        1,
        '{"action":"accept","summary":"Only one criterion checked","checks":[{"criterionIndex":0,"criterion":"Behavior works","command":"python3","args":[]}]}',
      );
      yield* runtime.tick();
      let run = yield* store.get(initial.id);
      expect(run.status).not.toBe("completed");
      expect(f.checks).toEqual([]);
      expect(f.commands).toHaveLength(3);
      expect(run.decisions.join(" ")).toContain("Constraints preserved");
      finish(2, '{"action":"correct","summary":"Missing external input","checks":[]}');
      yield* runtime.tick();
      run = yield* store.get(initial.id);
      expect(run.status).toBe("paused");
      expect(run.execution?.notice).toContain("automatic retries stopped");
      yield* runtime.control({ id: run.id, revision: run.revision, action: "resume" });
      yield* runtime.tick();
      yield* runtime.tick();
      expect(f.commands).toHaveLength(3);
      expect((yield* store.get(initial.id)).status).toBe("paused");
    }).pipe(Effect.provide(SqlitePersistenceMemory));
  },
);

it.effect("does not admit workers when the plan omits whole-objective acceptance", () => {
  const f = fixture();
  return Effect.gen(function* () {
    const store = yield* Store.make;
    yield* store.create(initial);
    const runtime = yield* make.pipe(
      Effect.provideService(Store.TeamStore, store),
      Effect.provide(f.layers),
    );
    yield* runtime.tick();
    const command = f.commands[0]!;
    if (command.type !== "thread.turn.start") throw new Error("Expected turn");
    f.complete(command, '{"tasks":[],"rationale":"No criteria"}');
    yield* runtime.tick();
    expect((yield* store.get(initial.id)).status).toBe("paused");
    expect(f.commands).toHaveLength(1);
  }).pipe(Effect.provide(SqlitePersistenceMemory));
});

import { TeamToolkit } from "../mcp/toolkits/team/tools.ts";
import { TeamToolkitHandlersLive } from "../mcp/toolkits/team/handlers.ts";
import { McpInvocationContext } from "../mcp/McpInvocationContext.ts";
import * as Stream from "effect/Stream";
import { OrchestrationProjectorDecodeError } from "../orchestration/Errors.ts";
import { GitWorkflowService } from "../git/GitWorkflowService.ts";
import { expect, it } from "@effect/vitest";
import {
  EnvironmentId,
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
  type OrchestrationEvent,
  type TeamRecoveryAdvice,
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
import { make, TeamRuntime } from "./TeamRuntime.ts";
import { defaultTeamPolicy } from "./routing.ts";
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
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
function fixture(
  failAcknowledgement = false,
  driver = "codex",
  recovery: TeamRecoveryAdvice = {
    action: "correct",
    reason: "Apply lead correction",
    profileId: "p",
    source: "policy",
  },
) {
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
      recover: () => Effect.succeed(recovery),
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
      const historicalView = yield* runtime.forThread(plan.threadId);
      expect(historicalView?.turns[0]?.providerTurnId).toBe(`turn-${plan.commandId}`);
      expect(historicalView?.turns[0]?.resultMessageId).toBe(`answer-${plan.commandId}`);
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

for (const resumePausedRun of [false, true]) {
  it.effect(
    `follows the lead correction despite uncertain routing and completes acceptance${resumePausedRun ? " after resume" : ""}`,
    () => {
      const f = fixture(false, "codex", {
        action: "lead_review",
        reason: "Failure diagnosis is uncertain; no automatic escalation.",
        profileId: "p",
        source: "policy",
      });
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
          return command;
        };
        yield* runtime.tick();
        finish(
          0,
          '{"acceptance":["Combined result"],"tasks":[{"id":"edit","objective":"Edit label","acceptance":["Exact label check"],"dependencies":[],"profileId":"p","context":"contract"}],"rationale":"bounded worker"}',
        );
        yield* runtime.tick();
        const worker = finish(1, "Worker complete; commit abc, but boundary coverage missing.");
        yield* runtime.tick();
        finish(
          2,
          '{"action":"correct","summary":"Add a real child-process cancellation check; the current test mocks the owner and does not exercise runtime cleanup.","checks":[]}',
        );
        if (resumePausedRun) {
          const run = yield* store.get(initial.id);
          yield* runtime.control({
            id: run.id,
            revision: run.revision,
            action: "pause",
          });
          yield* runtime.tick();
          expect(f.commands).toHaveLength(3);
          const paused = yield* store.get(initial.id);
          yield* runtime.control({ id: paused.id, revision: paused.revision, action: "resume" });
        }
        yield* runtime.tick();
        let run = yield* store.get(initial.id);
        expect(run.status).toBe("running");
        expect(run.tasks[0]?.attempts).toBe(2);
        const correction = f.commands[3];
        if (correction?.type !== "thread.turn.start")
          throw new Error("Expected correction dispatch");
        expect(correction.threadId).toBe(worker.threadId);
        expect(correction.modelSelection).toEqual(worker.modelSelection);
        expect(correction.message.text).toContain("real child-process cancellation check");
        yield* runtime.tick();
        expect(f.commands).toHaveLength(4);
        finish(3, "Added real child-process cancellation coverage; commit def; checks pass.");
        yield* runtime.tick();
        finish(
          4,
          '{"action":"accept","summary":"Worker correction verified","checks":[{"criterionIndex":0,"criterion":"Exact label check","command":"python3","args":[]}]}',
        );
        yield* runtime.tick();
        expect((yield* store.get(initial.id)).status).not.toBe("completed");
        finish(
          5,
          '{"action":"accept","summary":"Integrated worker commit def and verified the combined result.","checks":[{"criterionIndex":0,"criterion":"Combined result","command":"python3","args":[]}]}',
        );
        yield* runtime.tick();
        run = yield* store.get(initial.id);
        expect(run.status).toBe("completed");
        expect(run.execution?.notice).toBe(
          "Integrated worker commit def and verified the combined result.",
        );
        expect(run.tasks[0]?.status).toBe("accepted");
        expect(f.checks).toEqual(["python3", "python3"]);
        expect(f.lifecycleActivities.map((command) => command.activity.kind)).toContain(
          "team.worker-correction",
        );
      }).pipe(Effect.provide(SqlitePersistenceMemory));
    },
  );
}

for (const advice of [
  { action: "stop", profileId: "p" },
  { action: "wait", profileId: "p" },
  { action: "lead_review", profileId: null },
] as const) {
  it.effect(
    `does not bypass recovery blocker ${advice.action} with profile ${advice.profileId}`,
    () => {
      const f = fixture(false, "codex", {
        ...advice,
        reason: "Explicit recovery blocker",
        source: "policy",
      });
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
          '{"acceptance":["Combined result"],"tasks":[{"id":"edit","objective":"Edit label","acceptance":["Exact label check"],"dependencies":[],"profileId":"p","context":"contract"}],"rationale":"bounded worker"}',
        );
        yield* runtime.tick();
        finish(1, "Worker result");
        yield* runtime.tick();
        finish(2, '{"action":"correct","summary":"Add a real cleanup check","checks":[]}');
        yield* runtime.tick();
        const run = yield* store.get(initial.id);
        expect(run.status).toBe("paused");
        expect(run.execution?.notice).toContain("Explicit recovery blocker");
        expect(run.tasks[0]?.attempts).toBe(1);
        expect(f.commands).toHaveLength(3);
      }).pipe(Effect.provide(SqlitePersistenceMemory));
    },
  );
}

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
  "continues combined corrections beyond the legacy limit and pauses only for an explicit blocker",
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
      finish(
        2,
        '{"action":"correct","summary":"Need to exercise the second boundary","checks":[]}',
      );
      yield* runtime.tick();
      expect(f.commands).toHaveLength(4);
      finish(3, '{"action":"blocked","summary":"Missing external input","checks":[]}');
      yield* runtime.tick();
      run = yield* store.get(initial.id);
      expect(run.status).toBe("paused");
      expect(run.execution?.notice).toBe("Missing external input");
      yield* runtime.control({ id: run.id, revision: run.revision, action: "resume" });
      yield* runtime.tick();
      yield* runtime.tick();
      expect(f.commands).toHaveLength(4);
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

it.effect(
  "delivers a live worker question to the lead and returns advice without settling the worker",
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
      f.complete(
        plan,
        '{"acceptance":["Combined result"],"tasks":[{"id":"edit","objective":"Edit label","acceptance":["Exact label check"],"dependencies":[],"profileId":"p","context":"contract"}],"rationale":"worker"}',
      );
      yield* runtime.tick();
      const worker = f.commands[1]!;
      if (worker.type !== "thread.turn.start") throw new Error("Expected worker");
      const question = {
        id: "boundary-question",
        toThreadId: plan.threadId,
        text: "Does cancellation need to terminate the owned child process?",
        replyRequested: true,
      };
      const toolkit = yield* TeamToolkit.pipe(
        Effect.provide(
          TeamToolkitHandlersLive.pipe(Layer.provide(Layer.succeed(TeamRuntime, runtime))),
        ),
      );
      yield* toolkit.handle("team_send_message", question).pipe(
        Stream.unwrap,
        Stream.runCollect,
        Effect.provideService(TeamRuntime, runtime),
        Effect.provideService(McpInvocationContext, {
          environmentId: EnvironmentId.make("test-environment"),
          threadId: worker.threadId,
          providerSessionId: "worker-session",
          providerInstanceId: provider.instanceId,
          capabilities: new Set(["pull-requests"] as const),
          issuedAt: 0,
        }),
      );
      yield* runtime.sendMessage(worker.threadId, question);
      expect((yield* store.get(initial.id)).messages).toHaveLength(1);
      yield* runtime.tick();
      const consultation = f.commands[2]!;
      if (consultation.type !== "thread.turn.start") throw new Error("Expected consultation");
      expect(consultation.threadId).toBe(plan.threadId);
      expect(consultation.message.text).toContain(question.text);
      expect((yield* store.get(initial.id)).tasks[0]?.status).toBe("running");
      yield* runtime.tick();
      expect(f.commands).toHaveLength(3);
      f.complete(
        consultation,
        "Yes. Test the real child-process boundary and preserve unrelated processes.",
      );
      yield* runtime.tick();
      const run = yield* store.get(initial.id);
      expect(run.tasks[0]?.attempts).toBe(1);
      expect(run.tasks[0]?.status).toBe("running");
      expect(run.messages).toHaveLength(2);
      expect(run.messages?.[1]?.replyRequested).toBe(false);
      expect(run.messages?.[1]?.inReplyTo).toBe(question.id);
      // Recreate the runtime over the same durable store; unread advice is retained.
      const resumed = yield* make.pipe(
        Effect.provideService(Store.TeamStore, store),
        Effect.provide(f.layers),
      );
      const inbox = yield* resumed.readMessages(worker.threadId);
      expect(inbox.messages.map((message) => message.text)).toEqual([
        "Yes. Test the real child-process boundary and preserve unrelated processes.",
      ]);
      expect((yield* resumed.readMessages(worker.threadId)).messages).toEqual([]);
      expect((yield* resumed.readMessages(worker.threadId, true)).messages).toHaveLength(1);
      expect(inbox.members.map((member) => member.threadId)).toEqual([
        plan.threadId,
        worker.threadId,
      ]);
      expect(f.commands).toHaveLength(3);
      expect(
        f.lifecycleActivities.some((event) => event.activity.summary === "Reply from teammate"),
      ).toBe(true);
      const forged = yield* resumed
        .sendMessage(ThreadId.make("unrelated-thread"), question)
        .pipe(Effect.flip);
      expect(forged.code).toBe("not-found");
      const outside = yield* resumed
        .sendMessage(worker.threadId, {
          ...question,
          id: "outside",
          toThreadId: ThreadId.make("other-team"),
        })
        .pipe(Effect.flip);
      expect(outside.code).toBe("invalid");
      const changed = yield* resumed
        .sendMessage(worker.threadId, { ...question, text: "changed content" })
        .pipe(Effect.flip);
      expect(changed.code).toBe("conflict");
      const current = yield* store.get(initial.id);
      yield* resumed.control({ id: current.id, revision: current.revision, action: "pause" });
      const paused = yield* resumed
        .sendMessage(worker.threadId, { ...question, id: "while-paused" })
        .pipe(Effect.flip);
      expect(paused.code).toBe("conflict");
    }).pipe(Effect.provide(SqlitePersistenceMemory));
  },
);

it.effect(
  "a lead correction reaches a running worker inbox without starting a competing turn",
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
      f.complete(
        plan,
        '{"acceptance":["Combined result"],"tasks":[{"id":"edit","objective":"Edit label","acceptance":["Exact label check"],"dependencies":[],"profileId":"p","context":"contract"}],"rationale":"worker"}',
      );
      yield* runtime.tick();
      const worker = f.commands[1]!;
      if (worker.type !== "thread.turn.start") throw new Error("Expected worker");
      yield* runtime.sendMessage(plan.threadId, {
        id: "lead-guidance",
        toThreadId: worker.threadId,
        text: "Use the real runtime boundary; the owner mock does not verify cleanup.",
        replyRequested: false,
      });
      yield* runtime.tick();
      expect(f.commands).toHaveLength(2);
      const inbox = yield* runtime.readMessages(worker.threadId);
      expect(inbox.messages[0]?.fromThreadId).toBe(plan.threadId);
      expect(inbox.messages[0]?.text).toContain("real runtime boundary");
      f.complete(worker, "Worker implemented the real cleanup check.");
      yield* runtime.tick();
      expect((yield* store.get(initial.id)).execution?.turns.map((turn) => turn.role)).toEqual([
        "plan",
        "worker",
        "review",
      ]);
    }).pipe(Effect.provide(SqlitePersistenceMemory));
  },
);

it.effect(
  "keeps correcting beyond legacy worker limits and sends repeated advice back to the lead",
  () => {
    const f = fixture();
    return Effect.gen(function* () {
      const store = yield* Store.make;
      yield* store.create({ ...initial, policy: { ...initial.policy, maxAttempts: 1 } });
      const runtime = yield* make.pipe(
        Effect.provideService(Store.TeamStore, store),
        Effect.provide(f.layers),
      );
      const finishLatest = (text: string) => {
        const command = f.commands.at(-1)!;
        if (command.type !== "thread.turn.start") throw new Error("Expected turn");
        f.complete(command, text);
      };
      yield* runtime.tick();
      finishLatest(
        '{"acceptance":["Combined result"],"tasks":[{"id":"edit","objective":"Edit label","acceptance":["Exact label check"],"dependencies":[],"profileId":"p","context":"contract"}],"rationale":"worker"}',
      );
      yield* runtime.tick();
      for (let attempt = 1; attempt <= 4; attempt++) {
        finishLatest(`Worker evidence from attempt ${attempt}`);
        yield* runtime.tick();
        finishLatest(
          encodeJson({
            action: "correct",
            summary: `Exercise missing boundary ${attempt}`,
            checks: [],
          }),
        );
        yield* runtime.tick();
        expect((yield* store.get(initial.id)).tasks[0]?.attempts).toBe(attempt + 1);
      }
      finishLatest("More worker evidence");
      yield* runtime.tick();
      finishLatest('{"action":"correct","summary":"Exercise missing boundary 4","checks":[]}');
      yield* runtime.tick();
      let run = yield* store.get(initial.id);
      expect(run.status).toBe("running");
      expect(run.tasks[0]?.attempts).toBe(5);
      expect(run.execution?.turns.at(-1)?.role).toBe("review");
      finishLatest(
        '{"action":"accept","summary":"Evidence now covers it","checks":[{"criterionIndex":0,"criterion":"Exact label check","command":"python3","args":[]}]}',
      );
      yield* runtime.tick();
      finishLatest(
        '{"action":"accept","summary":"Combined result verified","checks":[{"criterionIndex":0,"criterion":"Combined result","command":"python3","args":[]}]}',
      );
      yield* runtime.tick();
      run = yield* store.get(initial.id);
      expect(run.status).toBe("completed");
      expect(run.tasks[0]?.recoveryHistory).toHaveLength(4);
    }).pipe(Effect.provide(SqlitePersistenceMemory));
  },
);

it.effect(
  "actively supervises worker progress, coalesces bursts and ignores coordination-tool echoes",
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
      f.complete(
        plan,
        '{"acceptance":["Combined result"],"tasks":[{"id":"edit","objective":"Edit label","acceptance":["Exact label check"],"dependencies":[],"profileId":"p","context":"contract"}],"rationale":"worker"}',
      );
      yield* runtime.tick();
      const worker = f.commands[1]!;
      if (worker.type !== "thread.turn.start") throw new Error("Expected worker");
      const activity = (
        sequence: number,
        summary: string,
        kind = "tool.completed",
      ): OrchestrationEvent => ({
        type: "thread.activity-appended",
        sequence,
        eventId: EventId.make(`progress-${sequence}`),
        aggregateKind: "thread",
        aggregateId: worker.threadId,
        occurredAt: date,
        commandId: null,
        causationEventId: null,
        correlationId: null,
        metadata: {},
        payload: {
          threadId: worker.threadId,
          activity: {
            id: EventId.make(`tool-${sequence}`),
            tone: "tool",
            kind,
            summary,
            payload: {},
            turnId: null,
            createdAt: date,
          },
        },
      });
      yield* runtime.observeWorkerEvent(activity(1, "Running cleanup test"));
      yield* runtime.tick();
      const consultation = f.commands[2]!;
      if (consultation.type !== "thread.turn.start")
        throw new Error("Expected proactive lead turn");
      expect(consultation.threadId).toBe(plan.threadId);
      expect(consultation.message.text).toContain("Actively inspect");
      for (let sequence = 2; sequence <= 6; sequence++) {
        yield* runtime.observeWorkerEvent(activity(sequence, `Boundary check ${sequence}`));
        yield* runtime.tick();
      }
      expect(f.commands).toHaveLength(3);
      let run = yield* store.get(initial.id);
      expect(run.messages).toHaveLength(1);
      expect(run.messages?.[0]?.text).toContain("Boundary check 6");
      yield* runtime.observeWorkerEvent(activity(6, "Duplicate receipt must not append"));
      yield* runtime.observeWorkerEvent(activity(7, "mcp__t3_code__team_read_messages"));
      expect((yield* store.get(initial.id)).messages?.[0]?.sourceSequence).toBe(6);
      // New progress after the lead's initial snapshot must get another look,
      // even if the provider did not call the inbox tool before finishing.
      f.complete(consultation, "Initial check reviewed.");
      yield* runtime.tick();
      expect(f.commands).toHaveLength(4);
      const next = f.commands[3]!;
      if (next.type !== "thread.turn.start") throw new Error("Expected follow-up inspection");
      expect(next.message.text).toContain("Boundary check 6");
      yield* runtime.readMessages(plan.threadId);
      f.complete(next, "Current progress checked; no intervention needed.");
      yield* runtime.tick();
      expect(f.commands).toHaveLength(4);
      run = yield* store.get(initial.id);
      expect(run.tasks[0]?.status).toBe("running");
      expect(run.messages?.every((message) => !message.replyRequested)).toBe(true);
      yield* runtime.control({ id: run.id, revision: run.revision, action: "pause" });
      yield* runtime.observeWorkerEvent(activity(8, "Paused progress"));
      yield* runtime.tick();
      expect(f.commands).toHaveLength(4);
    }).pipe(Effect.provide(SqlitePersistenceMemory));
  },
);

import { OrchestrationProjectorDecodeError } from "../orchestration/Errors.ts";
import { GitWorkflowService } from "../git/GitWorkflowService.ts";
import { expect, it } from "@effect/vitest";
import {
  MessageId,
  OrchestrationThread,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type OrchestrationCommand,
  type TeamRecoveryAdvice,
  type TeamRun,
  type ServerProvider,
} from "@t3tools/contracts";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import {
  ProjectionTurnRepository,
  type ProjectionTurn,
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
  const checks: string[] = [];
  const threads = new Map<string, OrchestrationThread>();
  const requests = new Map<string, MessageId>();
  const receipts = new Map<string, ProjectionTurn[]>();
  const addReceipt = (receipt: ProjectionTurn) => {
    receipts.set(receipt.threadId, [...(receipts.get(receipt.threadId) ?? []), receipt]);
  };
  const complete = (
    command: Extract<OrchestrationCommand, { type: "thread.turn.start" }>,
    text: string,
  ) => {
    const turnId = TurnId.make(`turn-${command.commandId}`);
    const answer = MessageId.make(`answer-${command.commandId}`);
    requests.set(turnId, command.message.messageId);
    addReceipt({
      threadId: command.threadId,
      turnId,
      pendingMessageId: command.message.messageId,
      sourceProposedPlanThreadId: null,
      sourceProposedPlanId: null,
      assistantMessageId: answer,
      state: "completed",
      requestedAt: date,
      startedAt: date,
      completedAt: date,
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
          requestedAt: date,
          startedAt: date,
          completedAt: date,
          assistantMessageId: answer,
        },
        messages: [
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
        activities: [],
        checkpoints: [],
        session: null,
      }),
    );
  };
  const failStart = (
    command: Extract<OrchestrationCommand, { type: "thread.turn.start" }>,
    detail: string,
  ) => {
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
        latestTurn: null,
        messages: [
          {
            id: command.message.messageId,
            role: "user",
            text: command.message.text,
            turnId: null,
            streaming: false,
            createdAt: date,
            updatedAt: date,
          },
        ],
        activities: [
          {
            id: "provider-start-failed",
            tone: "error",
            kind: "provider.turn.start.failed",
            summary: "Provider turn start failed",
            payload: { requestId: command.message.messageId, detail },
            turnId: null,
            createdAt: date,
          },
        ],
        checkpoints: [],
        session: null,
      }),
    );
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
    }),
    Layer.mock(ProjectionTurnRepository)({
      listByThreadId: ({ threadId }) => Effect.succeed(receipts.get(threadId) ?? []),
      getByTurnId: ({ threadId, turnId }) => {
        const receipt = (receipts.get(threadId) ?? []).find((entry) => entry.turnId === turnId);
        return Effect.succeed(
          receipt?.turnId
            ? Option.some({ ...receipt, turnId: receipt.turnId })
            : Option.some({
                threadId,
                turnId,
                pendingMessageId: requests.get(turnId) ?? null,
                sourceProposedPlanThreadId: null,
                sourceProposedPlanId: null,
                assistantMessageId: null,
                state: "completed",
                requestedAt: date,
                startedAt: date,
                completedAt: date,
                checkpointTurnCount: null,
                checkpointRef: null,
                checkpointStatus: null,
                checkpointFiles: [],
              }),
        );
      },
    }),
    Layer.mock(OrchestrationEngineService)({
      dispatch: (command) =>
        Effect.gen(function* () {
          if (command.type !== "thread.create") commands.push(command);
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
  return { commands, complete, failStart, addReceipt, layers, checks };
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
      f.addReceipt({
        threadId: plan.threadId,
        turnId: TurnId.make("turn-newer-manual"),
        pendingMessageId: MessageId.make("manual-follow-up"),
        sourceProposedPlanThreadId: null,
        sourceProposedPlanId: null,
        assistantMessageId: MessageId.make("manual-follow-up-answer"),
        state: "completed",
        requestedAt: date,
        startedAt: date,
        completedAt: date,
        checkpointTurnCount: null,
        checkpointRef: null,
        checkpointStatus: null,
        checkpointFiles: [],
      });
      const historicalView = yield* runtime.forThread(plan.threadId);
      expect(historicalView?.turns[0]?.providerTurnId).toBe(`turn-${plan.commandId}`);
      expect(historicalView?.turns[0]?.resultMessageId).toBe(`answer-${plan.commandId}`);
      yield* runtime.tick();
      expect(f.commands).toHaveLength(2);
      const run = yield* store.get(initial.id);
      expect(run.execution?.phase).toBe("integrate");
      expect(run.execution?.turns[0]?.status).toBe("settled");
      expect(run.execution?.turns[0]?.providerTurnId).toBe(`turn-${plan.commandId}`);
      expect(run.execution?.turns[0]?.resultMessageId).toBe(`answer-${plan.commandId}`);
      expect(run.execution?.turns[1]?.command.threadId).toBe(initial.execution?.leadThreadId);
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

it.effect("settles a dispatched managed turn from its exact provider start failure receipt", () => {
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
    f.failStart(command, "writer collision");
    yield* runtime.tick();
    const run = yield* store.get(initial.id);
    expect(run.execution?.turns[0]).toMatchObject({
      status: "settled",
      succeeded: false,
      result: "writer collision",
    });
    expect(run.status).toBe("paused");
    expect(run.execution?.notice).toContain("Lead planning failed");
  }).pipe(Effect.provide(SqlitePersistenceMemory));
});

it.effect(
  "repairs lead acceptance IDs without retrying the worker, then verifies combined output",
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
        '{"acceptance":["Combined result"],"tasks":[{"id":"edit","objective":"Edit label","acceptance":["Exact label check"],"dependencies":[],"profileId":"p","context":"contract"}],"rationale":"bounded worker"}',
      );
      yield* runtime.tick();
      finish(1, "Worker complete; commit abc.");
      yield* runtime.tick();
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
    `follows a lead correction despite uncertain routing${resumePausedRun ? " after resume" : ""}`,
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
          yield* runtime.control({ id: run.id, revision: run.revision, action: "pause" });
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
      }).pipe(Effect.provide(SqlitePersistenceMemory));
    },
  );
}

for (const advice of [
  { action: "stop", profileId: "p" },
  { action: "wait", profileId: "p" },
  { action: "repair_environment", profileId: "p" },
  { action: "supply_context", profileId: "p" },
  { action: "lead_review", profileId: null },
] as const) {
  it.effect(
    `keeps recovery blocker ${advice.action} with profile ${advice.profileId ?? "none"}`,
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

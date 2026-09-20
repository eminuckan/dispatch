// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";

import * as NodeServices from "@effect/platform-node/NodeServices";
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
  type TeamRecoveryAdvice,
  type TeamRun,
  type ServerProvider,
} from "@t3tools/contracts";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import * as DateTime from "effect/DateTime";
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
import * as ServerConfig from "../config.ts";
import { parseThreadSegmentFromAttachmentId, resolveAttachmentPath } from "../attachmentStore.ts";
import * as Store from "./TeamStore.ts";
import { TeamRouter } from "./TeamRouter.ts";
import { make } from "./TeamRuntime.ts";
import { defaultTeamPolicy } from "./routing.ts";
const decodeThread = Schema.decodeUnknownSync(OrchestrationThread);
const date = "2026-09-19T00:00:00.000Z";
const runtimeInfrastructure = Layer.mergeAll(
  SqlitePersistenceMemory,
  ServerConfig.layerTest(process.cwd(), { prefix: "dispatch-team-runtime-" }).pipe(
    Layer.provide(NodeServices.layer),
  ),
);
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
  const receipts = new Map<string, ProjectionTurn[]>();
  const pendingStarts = new Set<string>();
  const assessedDrafts: Array<{ hasAttachments: boolean; role: "lead" | "worker" }> = [];
  let clockStep = 0;
  const nextTime = () =>
    DateTime.formatIso(DateTime.add(DateTime.makeUnsafe(date), { seconds: ++clockStep * 10 }));
  const addReceipt = (receipt: ProjectionTurn) => {
    receipts.set(receipt.threadId, [...(receipts.get(receipt.threadId) ?? []), receipt]);
  };
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
    addReceipt({
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
            (message) => message.id !== answer && message.id !== command.message.messageId,
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
    if (
      !(receipts.get(command.threadId) ?? []).some(
        (receipt) => receipt.turnId === `turn-${command.commandId}`,
      )
    )
      complete(command, text);
    const thread = threads.get(command.threadId);
    if (!thread || !thread.latestTurn) throw new Error("Expected completed managed turn");
    const manualTurnId = TurnId.make(`manual-${command.commandId}`);
    const manualMessageId = MessageId.make(`manual-message-${command.commandId}`);
    const manualAnswer = MessageId.make(`manual-answer-${command.commandId}`);
    const startedAt = nextTime();
    addReceipt({
      threadId: command.threadId,
      turnId: manualTurnId,
      pendingMessageId: manualMessageId,
      sourceProposedPlanThreadId: null,
      sourceProposedPlanId: null,
      assistantMessageId: manualRunning ? null : manualAnswer,
      state: manualRunning ? "running" : "completed",
      requestedAt: startedAt,
      startedAt,
      completedAt: manualRunning ? null : startedAt,
      checkpointTurnCount: null,
      checkpointRef: null,
      checkpointStatus: null,
      checkpointFiles: [],
    });
    threads.set(
      command.threadId,
      decodeThread({
        ...thread,
        latestTurn: {
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
            id: manualMessageId,
            role: "user",
            text: "A manual follow-up",
            turnId: null,
            streaming: false,
            createdAt: startedAt,
            updatedAt: startedAt,
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
                  createdAt: startedAt,
                  updatedAt: startedAt,
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
      settings: Effect.succeed({
        policy: { ...initial.policy, mode: "shadow" },
        jevConfigured: true,
      }),
      recover: () => Effect.succeed(recovery),
      assess: (draft, role = "lead") => {
        assessedDrafts.push({ hasAttachments: draft.hasAttachments, role });
        return Effect.succeed({
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
        });
      },
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
          if (input.command === "git" && input.args[0] === "rev-parse") {
            return {
              code: ChildProcessSpawner.ExitCode(0),
              stdout: "a".repeat(40),
              stderr: "",
              timedOut: false,
              stdoutTruncated: false,
              stderrTruncated: false,
              stdoutInvalidUtf8: false,
              stderrInvalidUtf8: false,
            };
          }
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
      getProjectShellById: (id) =>
        Effect.succeed(
          Option.some({
            id,
            title: "Project",
            workspaceRoot: "/repo",
            defaultModelSelection: null,
            scripts: [],
            createdAt: date,
            updatedAt: date,
          }),
        ),
      getThreadDetailById: (id) => Effect.succeed(Option.fromUndefinedOr(threads.get(id))),
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
      listByThreadId: ({ threadId }) => Effect.succeed(receipts.get(threadId) ?? []),
      getByTurnId: ({ threadId, turnId }) => {
        const receipt = (receipts.get(threadId) ?? []).find((entry) => entry.turnId === turnId);
        return Effect.succeed(
          receipt?.turnId ? Option.some({ ...receipt, turnId: receipt.turnId }) : Option.none(),
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
  return {
    commands,
    complete,
    supersede,
    setActivities,
    failStart,
    addReceipt,
    layers,
    checks,
    pendingStarts,
    receipts,
    threads,
    assessedDrafts,
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
    }).pipe(Effect.provide(runtimeInfrastructure));
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
    expect(run.execution?.turns[0]?.result).toContain("Lead-only bounded work");
  }).pipe(Effect.provide(runtimeInfrastructure));
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
  }).pipe(Effect.provide(runtimeInfrastructure));
});

it.effect("defers review while a newer manual lead turn is running", () => {
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
  }).pipe(Effect.provide(runtimeInfrastructure));
});

it.effect("defers a lead reservation while a foreign pending turn start is projected", () => {
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
  }).pipe(Effect.provide(runtimeInfrastructure));
});

it.effect("persists attachments and sends them only on each managed thread's first turn", () => {
  const f = fixture();
  const attachments: NonNullable<TeamRun["attachments"]> = [
    {
      type: "image",
      id: "pending-00000000-0000-4000-8000-000000000001",
      name: "diagram.png",
      mimeType: "image/png",
      sizeBytes: 40,
    },
    {
      type: "file",
      id: "pending-00000000-0000-4000-8000-000000000002-txt",
      name: "notes.txt",
      mimeType: "text/plain",
      sizeBytes: 20,
    },
  ];
  return Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    const store = yield* Store.make;
    const policy = yield* store.savePolicy({ ...initial.policy, mode: "shadow" });
    const runtime = yield* make.pipe(
      Effect.provideService(Store.TeamStore, store),
      Effect.provide(f.layers),
    );
    const sourceBytes = [Buffer.alloc(40, 7), Buffer.alloc(20, 9)];
    for (const [index, attachment] of attachments.entries()) {
      const path = resolveAttachmentPath({ attachmentsDir: config.attachmentsDir, attachment });
      if (!path) throw new Error("Expected pending attachment path");
      NodeFS.writeFileSync(path, sourceBytes[index]!);
    }

    const started = yield* runtime.start({
      commandId: "start-with-attachments",
      projectId: initial.projectId,
      draft: {
        draftId: "attachment-draft",
        revision: 0,
        policyRevision: policy.revision,
        prompt: initial.objective,
        hasAttachments: true,
      },
      fingerprint: "test",
      attachments,
    });
    expect(started.attachments).toEqual(attachments);
    const plan = f.commands[0]!;
    if (plan.type !== "thread.turn.start") throw new Error("Expected plan dispatch");
    expect(plan.message.attachments).toHaveLength(attachments.length);
    expect(plan.message.attachments.map((attachment) => attachment.id)).not.toEqual(
      attachments.map((attachment) => attachment.id),
    );
    expect(
      plan.message.attachments.every(
        (attachment) => parseThreadSegmentFromAttachmentId(attachment.id) === plan.threadId,
      ),
    ).toBe(true);
    const leadImagePath = resolveAttachmentPath({
      attachmentsDir: config.attachmentsDir,
      attachment: plan.message.attachments[0]!,
    });
    if (!leadImagePath) throw new Error("Expected lead image path");
    NodeFS.writeFileSync(leadImagePath, Buffer.alloc(40, 3));
    f.complete(
      plan,
      '{"acceptance":["Combined result"],"tasks":[{"id":"edit","objective":"Edit label","acceptance":["Exact label check"],"dependencies":[],"profileId":"p","context":"contract"}],"rationale":"bounded worker"}',
    );

    yield* runtime.tick();
    const worker = f.commands[1]!;
    if (worker.type !== "thread.turn.start") throw new Error("Expected worker dispatch");
    expect(worker.message.attachments).toHaveLength(attachments.length);
    expect(
      worker.message.attachments.every(
        (attachment) => parseThreadSegmentFromAttachmentId(attachment.id) === worker.threadId,
      ),
    ).toBe(true);
    expect(worker.message.attachments.map((attachment) => attachment.id)).not.toEqual(
      plan.message.attachments.map((attachment) => attachment.id),
    );
    const workerImagePath = resolveAttachmentPath({
      attachmentsDir: config.attachmentsDir,
      attachment: worker.message.attachments[0]!,
    });
    if (!workerImagePath) throw new Error("Expected worker image path");
    expect(NodeFS.readFileSync(workerImagePath)).toEqual(sourceBytes[0]);
    const pendingImagePath = resolveAttachmentPath({
      attachmentsDir: config.attachmentsDir,
      attachment: attachments[0]!,
    });
    if (!pendingImagePath) throw new Error("Expected pending image path");
    expect(NodeFS.readFileSync(pendingImagePath)).toEqual(sourceBytes[0]);
    expect(f.assessedDrafts.some((draft) => draft.role === "worker" && draft.hasAttachments)).toBe(
      true,
    );
    f.complete(worker, "Worker complete; commit abc.");

    yield* runtime.tick();
    const review = f.commands[2]!;
    if (review.type !== "thread.turn.start") throw new Error("Expected review dispatch");
    expect(review.message.attachments).toEqual([]);
    f.complete(
      review,
      '{"action":"correct","summary":"Add the missing boundary check","checks":[]}',
    );

    yield* runtime.tick();
    const correction = f.commands[3]!;
    if (correction.type !== "thread.turn.start") throw new Error("Expected correction dispatch");
    expect(correction.threadId).toBe(worker.threadId);
    expect(correction.message.attachments).toEqual([]);
    expect((yield* store.get(started.id)).attachments).toEqual(attachments);

    f.complete(correction, "Worker correction complete; commit def.");
    yield* runtime.tick();
    const correctedReview = f.commands[4]!;
    if (correctedReview.type !== "thread.turn.start")
      throw new Error("Expected corrected review dispatch");
    expect(correctedReview.message.attachments).toEqual([]);
    f.complete(
      correctedReview,
      '{"action":"accept","summary":"Correction verified","checks":[{"criterionIndex":0,"criterion":"Exact label check","command":"python3","args":[]}]}',
    );
    yield* runtime.tick();
    const integrate = f.commands[5]!;
    if (integrate.type !== "thread.turn.start") throw new Error("Expected integration dispatch");
    expect(integrate.message.attachments).toEqual([]);
    f.complete(
      integrate,
      '{"action":"accept","summary":"Combined result verified","checks":[{"criterionIndex":0,"criterion":"Combined result","command":"python3","args":[]}]}',
    );
    yield* runtime.tick();
    expect((yield* store.get(started.id)).status).toBe("completed");
    for (const attachment of attachments) {
      const path = resolveAttachmentPath({ attachmentsDir: config.attachmentsDir, attachment });
      if (!path) throw new Error("Expected pending attachment path");
      expect(NodeFS.existsSync(path)).toBe(false);
    }
  }).pipe(Effect.provide(runtimeInfrastructure));
});

it.effect(
  "retains a cancelled run source until its dispatched provider receipt is terminal",
  () => {
    const f = fixture();
    const attachment = {
      type: "image" as const,
      id: "pending-00000000-0000-4000-8000-000000000021",
      name: "diagram.png",
      mimeType: "image/png",
      sizeBytes: 8,
    };
    return Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      const sourcePath = resolveAttachmentPath({
        attachmentsDir: config.attachmentsDir,
        attachment,
      });
      if (!sourcePath) throw new Error("Expected pending attachment path");
      NodeFS.writeFileSync(sourcePath, Buffer.from("original"));

      const store = yield* Store.make;
      const policy = yield* store.savePolicy({ ...initial.policy, mode: "shadow" });
      const runtime = yield* make.pipe(
        Effect.provideService(Store.TeamStore, store),
        Effect.provide(f.layers),
      );
      const started = yield* runtime.start({
        commandId: "cancel-with-attachments",
        projectId: initial.projectId,
        draft: {
          draftId: "cancel-attachment-draft",
          revision: 0,
          policyRevision: policy.revision,
          prompt: initial.objective,
          hasAttachments: true,
        },
        fingerprint: "test",
        attachments: [attachment],
      });
      const plan = f.commands[0]!;
      if (plan.type !== "thread.turn.start") throw new Error("Expected plan dispatch");

      const paused = yield* runtime.control({
        id: started.id,
        revision: started.revision,
        action: "pause",
      });
      yield* runtime.tick();
      expect(NodeFS.existsSync(sourcePath)).toBe(true);
      const resumed = yield* runtime.control({
        id: paused.id,
        revision: paused.revision,
        action: "resume",
      });
      yield* runtime.control({ id: resumed.id, revision: resumed.revision, action: "cancel" });
      expect(NodeFS.existsSync(sourcePath)).toBe(true);
      f.complete(plan, "Provider turn stopped.");
      f.receipts.set(
        plan.threadId,
        (f.receipts.get(plan.threadId) ?? []).map((receipt) =>
          receipt.pendingMessageId === plan.message.messageId
            ? { ...receipt, state: "interrupted" as const }
            : receipt,
        ),
      );
      yield* runtime.tick();
      expect((yield* store.get(started.id)).status).toBe("cancelled");
      expect(NodeFS.existsSync(sourcePath)).toBe(false);
    }).pipe(Effect.provide(runtimeInfrastructure));
  },
);

it.effect("cleans a terminal attachment lease on startup after terminal state persisted", () => {
  const f = fixture();
  const attachment = {
    type: "image" as const,
    id: "pending-00000000-0000-4000-8000-000000000022",
    name: "diagram.png",
    mimeType: "image/png",
    sizeBytes: 8,
  };
  return Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    const sourcePath = resolveAttachmentPath({
      attachmentsDir: config.attachmentsDir,
      attachment,
    });
    if (!sourcePath) throw new Error("Expected pending attachment path");
    NodeFS.writeFileSync(sourcePath, Buffer.from("original"));

    const store = yield* Store.make;
    const policy = yield* store.savePolicy({ ...initial.policy, mode: "shadow" });
    const runtime = yield* make.pipe(
      Effect.provideService(Store.TeamStore, store),
      Effect.provide(f.layers),
    );
    const started = yield* runtime.start({
      commandId: "failed-with-attachments",
      projectId: initial.projectId,
      draft: {
        draftId: "failed-attachment-draft",
        revision: 0,
        policyRevision: policy.revision,
        prompt: initial.objective,
        hasAttachments: true,
      },
      fingerprint: "test",
      attachments: [attachment],
    });
    expect(NodeFS.existsSync(sourcePath)).toBe(true);
    yield* store.update(
      started.id,
      started.revision,
      (run) => ({
        ...run,
        status: "failed",
        execution: {
          ...run.execution!,
          phase: "done",
          turns: run.execution!.turns.map((turn) => ({
            ...turn,
            status: "settled",
            result: "Terminal before cleanup",
            succeeded: false,
          })),
        },
      }),
      "test-terminal-before-cleanup",
    );

    const restartedRuntime = yield* make.pipe(
      Effect.provideService(Store.TeamStore, store),
      Effect.provide(f.layers),
    );
    yield* restartedRuntime.tick();
    expect(NodeFS.existsSync(sourcePath)).toBe(false);
  }).pipe(Effect.provide(runtimeInfrastructure));
});

it.effect("rejects a replayed command id when its attachment identity changed", () => {
  const f = fixture();
  const firstAttachment = {
    type: "image" as const,
    id: "pending-00000000-0000-4000-8000-000000000023",
    name: "first.png",
    mimeType: "image/png",
    sizeBytes: 8,
  };
  const secondAttachment = {
    ...firstAttachment,
    id: "pending-00000000-0000-4000-8000-000000000024",
    name: "second.png",
  };
  return Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    for (const attachment of [firstAttachment, secondAttachment]) {
      const path = resolveAttachmentPath({ attachmentsDir: config.attachmentsDir, attachment });
      if (!path) throw new Error("Expected pending attachment path");
      NodeFS.writeFileSync(path, Buffer.from("original"));
    }
    const store = yield* Store.make;
    const policy = yield* store.savePolicy({ ...initial.policy, mode: "shadow" });
    const runtime = yield* make.pipe(
      Effect.provideService(Store.TeamStore, store),
      Effect.provide(f.layers),
    );
    const draft = {
      draftId: "replay-attachment-draft",
      revision: 0,
      policyRevision: policy.revision,
      prompt: initial.objective,
      hasAttachments: true,
    };
    yield* runtime.start({
      commandId: "attachment-replay",
      projectId: initial.projectId,
      draft,
      fingerprint: "test",
      attachments: [firstAttachment],
    });
    const error = yield* runtime
      .start({
        commandId: "attachment-replay",
        projectId: initial.projectId,
        draft,
        fingerprint: "test",
        attachments: [secondAttachment],
      })
      .pipe(Effect.flip);
    expect(error.code).toBe("conflict");
    expect(error.message).toContain("different attachments");
  }).pipe(Effect.provide(runtimeInfrastructure));
});

it.effect("waits for open requests and advances after an optional request is dismissed", () => {
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
      id: EventId.make("optional-question"),
      kind: "user-input.requested",
      tone: "info" as const,
      summary: "Optional preference",
      turnId: TurnId.make(`turn-${plan.commandId}`),
      createdAt: date,
      payload: { requestId: "optional", responseMode: "message" },
    };
    f.setActivities(plan.threadId, [request]);
    yield* runtime.tick();
    expect(f.commands).toHaveLength(1);
    expect((yield* store.get(initial.id)).execution?.turns[0]?.status).toBe("dispatched");

    f.setActivities(plan.threadId, [
      request,
      { ...request, id: EventId.make("optional-dismissed"), kind: "user-input.resolved" },
    ]);
    yield* runtime.tick();
    expect((yield* store.get(initial.id)).execution?.phase).toBe("integrate");
    expect(f.commands).toHaveLength(2);
  }).pipe(Effect.provide(runtimeInfrastructure));
});

it.effect("does not advance while an approval remains open", () => {
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
    const approval = {
      id: EventId.make("approval"),
      kind: "approval.requested",
      tone: "approval" as const,
      summary: "Approve",
      turnId: TurnId.make(`turn-${plan.commandId}`),
      createdAt: date,
      payload: { requestId: "approval" },
    };
    f.setActivities(plan.threadId, [approval]);
    yield* runtime.tick();
    expect(f.commands).toHaveLength(1);
    expect((yield* store.get(initial.id)).execution?.turns[0]?.status).toBe("dispatched");

    f.setActivities(plan.threadId, [
      approval,
      { ...approval, id: EventId.make("approved"), kind: "approval.resolved" },
    ]);
    yield* runtime.tick();
    expect((yield* store.get(initial.id)).execution?.phase).toBe("integrate");
  }).pipe(Effect.provide(runtimeInfrastructure));
});

it.effect("follows the exact message-mode answer continuation", () => {
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

    f.setActivities(plan.threadId, [
      question,
      {
        ...question,
        id: EventId.make("answer"),
        kind: "user-input.resolved",
        payload: { requestId: "scope", responseMode: "message", answers: { scope: "frontend" } },
      },
    ]);
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
  }).pipe(Effect.provide(runtimeInfrastructure));
});

it.effect("pauses when the provider cannot start the message-mode answer continuation", () => {
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
  }).pipe(Effect.provide(runtimeInfrastructure));
});

it.effect("pauses an overtaken partial turn instead of accepting its forced completion", () => {
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
    const threadReceipts = f.receipts.get(plan.threadId) ?? [];
    const original = threadReceipts.find((receipt) => receipt.turnId === `turn-${plan.commandId}`);
    const manual = threadReceipts.find((receipt) => receipt.turnId === `manual-${plan.commandId}`);
    if (!original || !manual?.startedAt) throw new Error("Expected managed and manual receipts");
    f.receipts.set(
      plan.threadId,
      threadReceipts.map((receipt) =>
        receipt === original ? { ...receipt, completedAt: manual.startedAt } : receipt,
      ),
    );
    yield* runtime.tick();
    const run = yield* store.get(initial.id);
    expect(run.status).toBe("paused");
    expect(run.execution?.notice).toContain("interrupted");
    expect(run.execution?.turns[0]?.succeeded).toBe(false);
    expect(f.commands).toHaveLength(1);
  }).pipe(Effect.provide(runtimeInfrastructure));
});

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
  }).pipe(Effect.provide(runtimeInfrastructure));
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
  }).pipe(Effect.provide(runtimeInfrastructure));
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
    }).pipe(Effect.provide(runtimeInfrastructure));
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
      }).pipe(Effect.provide(runtimeInfrastructure));
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
      }).pipe(Effect.provide(runtimeInfrastructure));
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
  }).pipe(Effect.provide(runtimeInfrastructure));
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
  }).pipe(Effect.provide(runtimeInfrastructure));
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
    }).pipe(Effect.provide(runtimeInfrastructure));
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
  }).pipe(Effect.provide(runtimeInfrastructure));
});

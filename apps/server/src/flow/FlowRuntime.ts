import * as NodeCrypto from "node:crypto";

import {
  CommandId,
  FlowError,
  MessageId,
  ThreadId,
  type FlowSendInput,
  type FlowSpawnInput,
  type FlowThreadView,
  type FlowWaitInput,
  type ModelSelection,
} from "@dispatch/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import { GitWorkflowService } from "../git/GitWorkflowService.ts";
import { openRequests } from "../orchestration/decider.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ProjectionTurnRepository } from "../persistence/Services/ProjectionTurns.ts";
import { ProjectionTurnRepositoryLive } from "../persistence/Layers/ProjectionTurns.ts";
import { ProviderRegistry } from "../provider/Services/ProviderRegistry.ts";
import { forkParked } from "../serverActivation.ts";
import { FlowStore } from "./FlowStore.ts";
import { settledFlowReceipt } from "./FlowReceipt.ts";

const isFlowError = Schema.is(FlowError);
const error = (code: FlowError["code"], message: string) => new FlowError({ code, message });
const unavailable = (cause: unknown) =>
  isFlowError(cause)
    ? cause
    : error("unavailable", cause instanceof Error ? cause.message : "Flow operation failed.");
const nowIso = DateTime.now.pipe(Effect.map(DateTime.formatIso));
const RESULT_LIMIT = 8_000;

export const make = Effect.gen(function* () {
  const store = yield* FlowStore;
  const projection = yield* ProjectionSnapshotQuery;
  const turns = yield* ProjectionTurnRepository;
  const providers = yield* ProviderRegistry;
  const git = yield* GitWorkflowService;
  const engine = yield* OrchestrationEngineService;
  const lock = yield* Semaphore.make(1);
  const wakeups = yield* Queue.unbounded<void>();
  const completed = yield* PubSub.unbounded<ThreadId>();

  const requireLeadThread = Effect.fn("FlowRuntime.requireLeadThread")(function* (
    threadId: ThreadId,
  ) {
    const shell = yield* projection.getThreadShellById(threadId).pipe(Effect.mapError(unavailable));
    if (Option.isNone(shell)) return yield* error("not-found", "Flow thread was not found.");
    if (shell.value.managedTeamWorker === true || (yield* store.getWorker(threadId)))
      return yield* error("invalid", "A worker cannot own another Flow.");
    return shell.value;
  });

  const requireParent = Effect.fn("FlowRuntime.requireParent")(function* (threadId: ThreadId) {
    const shell = yield* requireLeadThread(threadId);
    if (shell.flowEnabled !== true)
      return yield* error("invalid", "Enable Flow on this thread first.");
    return shell;
  });

  const validateModel = Effect.fn("FlowRuntime.validateModel")(function* (
    selection: ModelSelection,
  ) {
    const candidates = yield* providers.getProviders.pipe(Effect.mapError(unavailable));
    const provider = candidates.find((item) => item.instanceId === selection.instanceId);
    if (
      !provider ||
      !provider.enabled ||
      provider.status !== "ready" ||
      provider.auth.status === "unauthenticated" ||
      provider.availability === "unavailable" ||
      !provider.models.some((model) => model.slug === selection.model && !model.isLegacy)
    )
      return yield* error(
        "unavailable",
        "The selected worker model is not available in this environment.",
      );
  });

  const view = Effect.fn("FlowRuntime.view")(function* (threadId: ThreadId) {
    const parentThreadId = yield* store.findParent(threadId);
    if (!parentThreadId) return null;
    const workers = yield* store.listWorkers(parentThreadId);
    return {
      parentThreadId,
      enabled: yield* store.isEnabled(parentThreadId),
      currentWorkerThreadId: threadId === parentThreadId ? null : threadId,
      workers,
    } satisfies FlowThreadView;
  });

  const requireView = Effect.fn("FlowRuntime.requireView")(function* (threadId: ThreadId) {
    const current = yield* view(threadId);
    if (!current) return yield* error("not-found", "Flow was not found.");
    return current;
  });

  const assertClientMessageAllowed = Effect.fn("FlowRuntime.assertClientMessageAllowed")(function* (
    threadId: ThreadId,
  ) {
    if (yield* store.getWorker(threadId))
      return yield* error(
        "invalid",
        "Flow worker threads are read only. Send instructions to the lead.",
      );
  });

  const assertCanEnableFlow = Effect.fn("FlowRuntime.assertCanEnableFlow")(function* (
    threadId: ThreadId,
  ) {
    yield* requireLeadThread(threadId);
  });

  const spawn = Effect.fn("FlowRuntime.spawn")(function* (
    parentThreadId: ThreadId,
    input: FlowSpawnInput,
  ) {
    const existing = yield* store.getWorkerBySpawnId(input.id);
    if (existing) {
      if (
        existing.parentThreadId !== parentThreadId ||
        existing.assignment !== input.assignment ||
        existing.modelSelection.instanceId !== input.modelSelection.instanceId ||
        existing.modelSelection.model !== input.modelSelection.model
      )
        return yield* error(
          "conflict",
          "This Flow request ID was already used for another assignment.",
        );
      return existing;
    }
    yield* requireParent(parentThreadId);
    yield* validateModel(input.modelSelection);
    const workerThreadId = ThreadId.make(`flow-${NodeCrypto.randomUUID()}`);
    const timestamp = yield* nowIso;
    const worker = yield* store.reserveWorker({
      threadId: workerThreadId,
      parentThreadId,
      spawnId: input.id,
      assignment: input.assignment,
      modelSelection: input.modelSelection,
      branch: `flow/${workerThreadId}`,
      jobId: `flow-job-${input.id}`,
      messageId: `flow-message-${input.id}`,
      createdAt: timestamp,
    });
    yield* Queue.offer(wakeups, undefined);
    return worker;
  });

  const send = Effect.fn("FlowRuntime.send")(function* (
    parentThreadId: ThreadId,
    input: FlowSendInput,
  ) {
    const id = `flow-job-${input.id}`;
    const existing = yield* store.getJob(id);
    if (existing) {
      const worker = yield* store.getWorker(existing.workerThreadId);
      if (
        !worker ||
        worker.parentThreadId !== parentThreadId ||
        existing.workerThreadId !== input.workerThreadId ||
        existing.prompt !== input.message
      )
        return yield* error(
          "conflict",
          "This Flow request ID was already used for another message.",
        );
      return existing;
    }
    yield* requireParent(parentThreadId);
    const job = yield* store.reserveJob({
      parentThreadId,
      workerThreadId: input.workerThreadId,
      id,
      messageId: `flow-message-${input.id}`,
      message: input.message,
      createdAt: yield* nowIso,
    });
    yield* Queue.offer(wakeups, undefined);
    return job;
  });

  const stop = Effect.fn("FlowRuntime.stop")(function* (
    parentThreadId: ThreadId,
    workerThreadId: ThreadId,
  ) {
    const current = yield* store.getWorker(workerThreadId);
    if (!current || current.parentThreadId !== parentThreadId)
      return yield* error("not-found", "Worker does not belong to this Flow.");
    const shell = yield* projection
      .getThreadShellById(workerThreadId)
      .pipe(Effect.mapError(unavailable));
    if (Option.isSome(shell) && shell.value.latestTurn?.state === "running") {
      yield* engine
        .dispatch({
          type: "thread.turn.interrupt",
          commandId: CommandId.make(`flow-stop-${NodeCrypto.randomUUID()}`),
          threadId: workerThreadId,
          turnId: shell.value.latestTurn.turnId,
          createdAt: yield* nowIso,
        })
        .pipe(
          Effect.catch((cause) =>
            Effect.logWarning("Could not interrupt Flow worker turn", { workerThreadId, cause }),
          ),
        );
    }
    if (
      Option.isSome(shell) &&
      shell.value.session !== null &&
      shell.value.session.status !== "stopped"
    ) {
      yield* engine
        .dispatch({
          type: "thread.session.stop",
          commandId: CommandId.make(`flow-session-stop-${workerThreadId}`),
          threadId: workerThreadId,
          createdAt: yield* nowIso,
        })
        .pipe(Effect.mapError(unavailable));
    }
    const worker = yield* store.stop(parentThreadId, workerThreadId);
    yield* PubSub.publish(completed, parentThreadId);
    return worker;
  }, lock.withPermits(1));

  const ensureWorktree = Effect.fn("FlowRuntime.ensureWorktree")(function* (
    workerThreadId: ThreadId,
  ) {
    let worker = yield* store.getWorker(workerThreadId);
    if (!worker) return yield* error("not-found", "Worker was not found.");
    if (worker.worktreePath) return worker;
    const parent = yield* requireLeadThread(worker.parentThreadId);
    const project = yield* projection
      .getProjectShellById(parent.projectId)
      .pipe(Effect.mapError(unavailable));
    if (Option.isNone(project)) return yield* error("not-found", "Flow project was not found.");
    const cwd = parent.worktreePath ?? project.value.workspaceRoot;
    const hasCommit = yield* git
      .hasCommit({ cwd, refName: "HEAD" })
      .pipe(Effect.mapError(unavailable));
    if (!hasCommit)
      return yield* error("unavailable", "Flow workers need a Git repository with a commit.");
    const refs = yield* git
      .listRefs({ cwd, query: worker.branch, refKind: "local", refresh: true })
      .pipe(Effect.mapError(unavailable));
    const existing = refs.refs.find((ref) => ref.name === worker!.branch);
    const worktree = existing?.worktreePath
      ? { path: existing.worktreePath, refName: existing.name }
      : (yield* git
          .createWorktree({
            cwd,
            refName: existing?.name ?? "HEAD",
            ...(existing ? {} : { newRefName: worker.branch }),
            baseRefName: "HEAD",
            path: null,
          })
          .pipe(Effect.mapError(unavailable))).worktree;
    yield* store.setWorktree(workerThreadId, worktree.path);
    worker = yield* store.getWorker(workerThreadId);
    if (!worker) return yield* error("not-found", "Worker was removed while preparing it.");
    return worker;
  });

  const dispatchQueuedJob = Effect.fn("FlowRuntime.dispatchQueuedJob")(function* (
    row: Effect.Success<typeof store.activeJobs>[number],
  ) {
    let worker = yield* store.getWorker(ThreadId.make(row.workerThreadId));
    if (!worker || worker.state === "stopped") return;
    worker = yield* ensureWorktree(worker.threadId);
    const parent = yield* requireLeadThread(worker.parentThreadId);
    if (!worker.worktreePath)
      return yield* error("unavailable", "Worker worktree could not be prepared.");
    yield* engine.dispatch({
      type: "thread.create",
      commandId: CommandId.make(`flow-create-${worker.threadId}`),
      threadId: worker.threadId,
      projectId: parent.projectId,
      title: `Flow worker · ${worker.assignment.slice(0, 80)}`,
      modelSelection: worker.modelSelection,
      runtimeMode: parent.runtimeMode,
      interactionMode: "default",
      branch: worker.branch,
      worktreePath: worker.worktreePath,
      createdAt: worker.createdAt,
    });
    const prompt = [
      `You are a Dispatch Flow worker. Your assignment is: ${row.prompt}`,
      `Work in your isolated checkout at ${worker.worktreePath}. Do not change the parent checkout.`,
      "Report the result, files changed, validation performed, and any commit or branch needed for the lead to integrate your work.",
      "You may use your provider's native tools. The Flow lead owns integration and the final user response.",
    ].join("\n\n");
    yield* engine.dispatch({
      type: "thread.turn.start",
      commandId: CommandId.make(row.commandId),
      threadId: worker.threadId,
      message: {
        messageId: MessageId.make(row.messageId),
        role: "user",
        text: prompt,
        attachments: [],
      },
      modelSelection: worker.modelSelection,
      runtimeMode: parent.runtimeMode,
      interactionMode: "default",
      createdAt: row.createdAt,
    });
    yield* store.updateJob({
      id: row.id,
      state: "working",
      workerState: "working",
      updatedAt: yield* nowIso,
    });
  });

  const reconcileWorkingJob = Effect.fn("FlowRuntime.reconcileWorkingJob")(function* (
    row: Effect.Success<typeof store.activeJobs>[number],
  ) {
    const threadId = ThreadId.make(row.workerThreadId);
    const receipts = yield* turns.listByThreadId({ threadId }).pipe(Effect.mapError(unavailable));
    let receipt = receipts.find((entry) => entry.pendingMessageId === row.messageId);
    const detail = yield* projection
      .getThreadDetailById(threadId)
      .pipe(Effect.mapError(unavailable));
    if (Option.isNone(detail)) return;
    if (!receipt) {
      const failure = detail.value.activities.findLast(
        (activity) =>
          activity.kind === "provider.turn.start.failed" &&
          typeof activity.payload === "object" &&
          activity.payload !== null &&
          "requestId" in activity.payload &&
          activity.payload.requestId === row.messageId,
      );
      if (!failure) return;
      yield* store.updateJob({
        id: row.id,
        state: "failed",
        workerState: "failed",
        error: failure.summary,
        updatedAt: yield* nowIso,
      });
      const worker = yield* store.getWorker(threadId);
      if (worker) yield* PubSub.publish(completed, worker.parentThreadId);
      return;
    }
    if (openRequests(detail.value).size > 0) return;
    const settled = settledFlowReceipt(receipts, receipt, detail.value.activities);
    if (!settled) return;
    receipt = settled;
    if (
      detail.value.latestTurn &&
      detail.value.latestTurn.turnId !== receipt.turnId &&
      detail.value.latestTurn.state === "running"
    )
      return;
    const answer = receipt.assistantMessageId
      ? detail.value.messages.find((message) => message.id === receipt.assistantMessageId)?.text
      : null;
    const success = receipt.state === "completed" && answer != null;
    yield* store.updateJob({
      id: row.id,
      state: success ? "completed" : "failed",
      workerState: success ? "idle" : "failed",
      result: success ? answer.slice(0, RESULT_LIMIT) : null,
      error: success
        ? null
        : `Worker turn ended with ${receipt.state}. Open its thread for details.`,
      updatedAt: yield* nowIso,
    });
    const worker = yield* store.getWorker(threadId);
    if (worker) yield* PubSub.publish(completed, worker.parentThreadId);
  });

  const tick = Effect.fn("FlowRuntime.tick")(function* () {
    const jobs = yield* store.activeJobs;
    for (const job of jobs) {
      if (job.state === "queued") {
        yield* dispatchQueuedJob(job).pipe(
          Effect.catch((cause) =>
            Effect.gen(function* () {
              yield* store.updateJob({
                id: job.id,
                state: "failed",
                workerState: "failed",
                error: unavailable(cause).message,
                updatedAt: yield* nowIso,
              });
              const worker = yield* store.getWorker(ThreadId.make(job.workerThreadId));
              if (worker) yield* PubSub.publish(completed, worker.parentThreadId);
            }),
          ),
        );
      } else {
        yield* reconcileWorkingJob(job).pipe(
          Effect.catch((cause) =>
            Effect.logWarning("Could not reconcile Flow worker", {
              workerThreadId: job.workerThreadId,
              cause,
            }),
          ),
        );
      }
    }
  }, lock.withPermits(1));

  const wait = Effect.fn("FlowRuntime.wait")(function* (
    parentThreadId: ThreadId,
    input: FlowWaitInput,
  ) {
    yield* requireParent(parentThreadId);
    const queue = yield* PubSub.subscribe(completed);
    const current = yield* requireView(parentThreadId);
    const selected = input.workerThreadIds?.length
      ? current.workers.filter((worker) => input.workerThreadIds!.includes(worker.threadId))
      : current.workers;
    if (selected.length !== (input.workerThreadIds?.length ?? selected.length))
      return yield* error("not-found", "A requested worker does not belong to this Flow.");
    if (
      selected.every((worker) => worker.state !== "queued" && worker.state !== "working") ||
      (input.timeoutSeconds ?? 0) === 0
    )
      return current;
    yield* Stream.fromSubscription(queue).pipe(
      Stream.filter((threadId) => threadId === parentThreadId),
      Stream.runHead,
      Effect.timeoutOption(`${input.timeoutSeconds ?? 0} seconds`),
    );
    return yield* requireView(parentThreadId);
  });

  return {
    view,
    spawn,
    send,
    stop,
    wait,
    tick,
    assertClientMessageAllowed,
    assertCanEnableFlow,
    wakeups: Stream.fromQueue(wakeups),
    models: providers.getProviders,
  };
});

export class FlowRuntime extends Context.Service<FlowRuntime, Effect.Success<typeof make>>()(
  "dispatch/flow/FlowRuntime",
) {}

export const layer = Layer.effect(FlowRuntime, make).pipe(
  Layer.provide(ProjectionTurnRepositoryLive),
);

export const reactorLayer = Layer.effectDiscard(
  Effect.gen(function* () {
    const runtime = yield* FlowRuntime;
    const engine = yield* OrchestrationEngineService;
    const events = yield* engine.subscribeDomainEvents;
    const triggers = Stream.merge(
      events.pipe(
        Stream.filter(
          (event) =>
            event.aggregateId.startsWith("flow-") &&
            (event.type === "thread.session-set" ||
              event.type === "thread.turn-diff-completed" ||
              (event.type === "thread.message-sent" && !event.payload.streaming) ||
              (event.type === "thread.activity-appended" &&
                event.payload.activity.kind === "provider.turn.start.failed")),
        ),
      ),
      runtime.wakeups,
    );
    yield* forkParked(
      Effect.andThen(
        runtime.tick().pipe(Effect.ignoreCause({ log: true })),
        Stream.runForEach(triggers, () => runtime.tick().pipe(Effect.ignoreCause({ log: true }))),
      ),
    );
  }),
);

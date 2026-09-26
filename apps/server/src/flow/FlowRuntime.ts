import * as NodeCrypto from "node:crypto";

import {
  CommandId,
  FlowError,
  MessageId,
  ThreadId,
  type FlowSendInput,
  type FlowReportInput,
  type FlowSpawnInput,
  type FlowThreadView,
  type FlowWaitInput,
  type ModelSelection,
} from "@dispatch/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Equal from "effect/Equal";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
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
import { ProviderService } from "../provider/Services/ProviderService.ts";
import { forkParked } from "../serverActivation.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { resolveProjectSettings } from "@dispatch/shared/projectSettings";
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
  const providerService = yield* ProviderService;
  const git = yield* GitWorkflowService;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const engine = yield* OrchestrationEngineService;
  const settings = yield* ServerSettingsService;
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
    const model = provider?.models.find((item) => item.slug === selection.model && !item.isLegacy);
    if (
      !provider ||
      !provider.enabled ||
      provider.status !== "ready" ||
      provider.auth.status === "unauthenticated" ||
      provider.availability === "unavailable" ||
      !model
    )
      return yield* error(
        "unavailable",
        "The selected worker model is not available in this environment.",
      );
    for (const option of selection.options ?? []) {
      const descriptor = model.capabilities?.optionDescriptors?.find(
        (item) => item.id === option.id,
      );
      if (
        !descriptor ||
        (descriptor.type === "boolean" && typeof option.value !== "boolean") ||
        (descriptor.type === "select" &&
          (typeof option.value !== "string" ||
            !descriptor.options.some((choice) => choice.id === option.value)))
      )
        return yield* error("unavailable", `The worker model no longer supports ${option.id}.`);
    }
  });

  const profiles = Effect.fn("FlowRuntime.profiles")(function* (parentThreadId: ThreadId) {
    const parent = yield* requireParent(parentThreadId);
    const current = yield* settings.getSettings.pipe(Effect.mapError(unavailable));
    return resolveProjectSettings(current, parent.projectId).settings.flowWorkerProfiles;
  });

  const selectionForSpawn = Effect.fn("FlowRuntime.selectionForSpawn")(function* (
    parentThreadId: ThreadId,
    input: FlowSpawnInput,
  ) {
    if ((input.profileId === undefined) === (input.modelSelection === undefined))
      return yield* error("invalid", "Choose exactly one worker profile or model selection.");
    if (input.modelSelection) return input.modelSelection;
    const matches = (yield* profiles(parentThreadId)).filter(
      (entry) => entry.id === input.profileId,
    );
    if (matches.length !== 1)
      return yield* error("not-found", "The selected Flow worker profile is unavailable.");
    return matches[0]!.modelSelection;
  });

  const leadCwd = Effect.fn("FlowRuntime.leadCwd")(function* (parentThreadId: ThreadId) {
    const parent = yield* requireLeadThread(parentThreadId);
    const project = yield* projection
      .getProjectShellById(parent.projectId)
      .pipe(Effect.mapError(unavailable));
    if (Option.isNone(project)) return yield* error("not-found", "Flow project was not found.");
    return parent.worktreePath ?? project.value.workspaceRoot;
  });

  const resolveRepository = Effect.fn("FlowRuntime.resolveRepository")(function* (
    workspaceRoot: string,
    repositoryPath: string,
  ) {
    if (path.isAbsolute(repositoryPath))
      return yield* error("invalid", "Choose a repository inside this project.");
    const root = yield* fileSystem
      .realPath(workspaceRoot)
      .pipe(Effect.mapError(() => error("invalid", "The project workspace is unavailable.")));
    const candidate = yield* fileSystem
      .realPath(path.resolve(root, repositoryPath))
      .pipe(
        Effect.mapError(() => error("invalid", "The selected repository path is unavailable.")),
      );
    const relative = path.relative(root, candidate);
    if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))
      return yield* error("invalid", "Choose a repository inside this project.");
    return candidate;
  });

  const requireRepositoryCommit = Effect.fn("FlowRuntime.requireRepositoryCommit")(function* (
    cwd: string,
  ) {
    if (!(yield* git.isRepository(cwd).pipe(Effect.mapError(unavailable))))
      return yield* error("invalid", "The selected path is not a Git repository.");
    if (!(yield* git.hasCommit({ cwd, refName: "HEAD" }).pipe(Effect.mapError(unavailable))))
      return yield* error("unavailable", "The selected Git repository needs a commit.");
  });

  const requireChildRepository = Effect.fn("FlowRuntime.requireChildRepository")(function* (
    cwd: string,
  ) {
    if (
      !(yield* fileSystem
        .exists(path.join(cwd, ".git"))
        .pipe(Effect.mapError(() => error("invalid", "The selected repository is unavailable."))))
    )
      return yield* error("invalid", "Choose the root of a child Git repository.");
    yield* requireRepositoryCommit(cwd);
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
      updates: yield* store.listUpdates(parentThreadId),
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
    if ((input.profileId === undefined) === (input.modelSelection === undefined))
      return yield* error("invalid", "Choose exactly one worker profile or model selection.");
    const existing = yield* store.getWorkerBySpawnId(input.id);
    if (existing) {
      if (
        existing.parentThreadId !== parentThreadId ||
        existing.assignment !== input.assignment ||
        existing.profileId !== (input.profileId ?? null) ||
        (input.repositoryPath === undefined &&
          existing.repositoryPath !== null &&
          existing.repositoryPath !== ".") ||
        (input.repositoryPath !== undefined &&
          existing.repositoryPath !== path.normalize(input.repositoryPath)) ||
        (input.modelSelection && !Equal.equals(existing.modelSelection, input.modelSelection))
      )
        return yield* error(
          "conflict",
          "This Flow request ID was already used for another assignment.",
        );
      return existing;
    }
    const modelSelection = yield* selectionForSpawn(parentThreadId, input);
    yield* requireParent(parentThreadId);
    yield* validateModel(modelSelection);
    const cwd = yield* leadCwd(parentThreadId);
    let repositoryPath: string | null;
    if (input.repositoryPath) {
      const repositoryCwd = yield* resolveRepository(cwd, input.repositoryPath);
      yield* requireChildRepository(repositoryCwd);
      repositoryPath = path.normalize(input.repositoryPath);
    } else {
      const isRepository = yield* git.isRepository(cwd).pipe(Effect.mapError(unavailable));
      const hasCommit = isRepository
        ? yield* git.hasCommit({ cwd, refName: "HEAD" }).pipe(Effect.mapError(unavailable))
        : false;
      repositoryPath = hasCommit ? "." : null;
    }
    const workerThreadId = ThreadId.make(`flow-${NodeCrypto.randomUUID()}`);
    const timestamp = yield* nowIso;
    const worker = yield* store.reserveWorker({
      threadId: workerThreadId,
      parentThreadId,
      spawnId: input.id,
      assignment: input.assignment,
      modelSelection,
      ...(input.profileId ? { profileId: input.profileId } : {}),
      branch: repositoryPath === null ? "" : `flow/${workerThreadId}`,
      repositoryPath,
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
    const worker = yield* store.getWorker(input.workerThreadId);
    if (!worker || worker.parentThreadId !== parentThreadId)
      return yield* error("not-found", "Worker does not belong to this Flow.");
    const shell = yield* projection
      .getThreadShellById(worker.threadId)
      .pipe(Effect.mapError(unavailable));
    const active = Option.isSome(shell) && shell.value.latestTurn?.state === "running";
    const prepared = active
      ? yield* providerService
          .prepareSteerTurnMessageId(worker.threadId)
          .pipe(Effect.orElseSucceed(() => ({ status: "unsupported" }) as const))
      : ({ status: "unsupported" } as const);
    const job = yield* store.reserveJob({
      parentThreadId,
      workerThreadId: input.workerThreadId,
      id,
      messageId: prepared.status === "ready" ? prepared.messageId : `flow-message-${input.id}`,
      message: input.message,
      delivery: prepared.status === "ready" ? "steer" : "turn",
      createdAt: yield* nowIso,
    });
    yield* Queue.offer(wakeups, undefined);
    return job;
  });

  const report = Effect.fn("FlowRuntime.report")(function* (
    workerThreadId: ThreadId,
    input: FlowReportInput,
  ) {
    const worker = yield* store.getWorker(workerThreadId);
    if (!worker || worker.state === "stopped")
      return yield* error("not-found", "Active Flow worker was not found.");
    const update = yield* store.recordUpdate({
      workerThreadId,
      id: `${workerThreadId}:${input.id}`,
      message: input.message,
      createdAt: yield* nowIso,
    });
    yield* PubSub.publish(completed, worker.parentThreadId);
    return update;
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
    if (worker.repositoryPath === null) return worker;
    if (
      worker.worktreePath &&
      (yield* fileSystem.exists(worker.worktreePath).pipe(Effect.mapError(unavailable)))
    )
      return worker;
    const workspaceRoot = yield* leadCwd(worker.parentThreadId);
    const cwd =
      worker.repositoryPath === "."
        ? workspaceRoot
        : yield* resolveRepository(workspaceRoot, worker.repositoryPath);
    if (worker.repositoryPath === ".") yield* requireRepositoryCommit(cwd);
    else yield* requireChildRepository(cwd);
    if (!worker.branch) return yield* error("invalid", "Worker branch is missing.");
    const branch = worker.branch;
    if (worker.worktreePath) {
      yield* git.pruneWorktrees({ cwd }).pipe(Effect.mapError(unavailable));
      yield* git
        .createWorktree({ cwd, refName: branch, path: worker.worktreePath })
        .pipe(Effect.mapError(unavailable));
      return worker;
    }
    const refs = yield* git
      .listRefs({ cwd, query: branch, refKind: "local", refresh: true })
      .pipe(Effect.mapError(unavailable));
    const existing = refs.refs.find((ref) => ref.name === branch);
    const worktree = existing?.worktreePath
      ? { path: existing.worktreePath, refName: existing.name }
      : (yield* git
          .createWorktree({
            cwd,
            refName: existing?.name ?? "HEAD",
            ...(existing ? {} : { newRefName: branch }),
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
    const current = yield* projection
      .getThreadShellById(worker.threadId)
      .pipe(Effect.mapError(unavailable));
    if (
      row.delivery === "turn" &&
      Option.isSome(current) &&
      current.value.latestTurn?.state === "running"
    )
      return;
    worker = yield* ensureWorktree(worker.threadId);
    const parent = yield* requireLeadThread(worker.parentThreadId);
    if (worker.repositoryPath !== null && !worker.worktreePath)
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
    const initial = row.id === `flow-job-${worker.spawnId}`;
    const prompt = initial
      ? [
          `You are a Dispatch Flow worker. Your assignment is: ${row.prompt}`,
          worker.repositoryPath === null
            ? "You share the lead's live project directory. It may contain several independent Git repositories or no Git repository. Run Git commands only inside a repository, coordinate file ownership with the lead, and do not overwrite another worker's changes."
            : `Work in your isolated checkout at ${worker.worktreePath} for repository ${worker.repositoryPath}. Do not change the parent checkout.`,
          "Use flow_report to send concise progress or a blocker to the lead while you work. The lead may send you a message during your turn.",
          "Report the result, files changed, validation performed, and any repository, commit, or branch needed for the lead to integrate your work.",
          "You may use your provider's native tools. The Flow lead owns integration and the final user response.",
        ].join("\n\n")
      : `Message from your Flow lead: ${row.prompt}`;
    if (row.delivery === "steer") {
      yield* engine.dispatch({
        type: "thread.message.user.append",
        commandId: CommandId.make(`flow-message-append-${row.id}`),
        threadId: worker.threadId,
        message: {
          messageId: MessageId.make(row.messageId),
          text: prompt,
          attachments: [],
        },
        createdAt: row.createdAt,
      });
      const latest = yield* projection
        .getThreadShellById(worker.threadId)
        .pipe(Effect.mapError(unavailable));
      const turn = Option.isSome(latest) ? latest.value.latestTurn : null;
      if (turn?.state === "running") {
        const delivered = yield* providerService.steerTurn({
          threadId: worker.threadId,
          expectedTurnId: turn.turnId,
          messageId: MessageId.make(row.messageId),
          input: prompt,
        });
        if (delivered.status === "accepted") {
          yield* store.updateJob({
            id: row.id,
            state: "completed",
            workerState: "idle",
            result: "Delivered to the active worker turn.",
            updatedAt: yield* nowIso,
          });
          yield* PubSub.publish(completed, worker.parentThreadId);
          return;
        }
      }
    }
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
      (input.afterUpdateSequence !== undefined &&
        current.updates.some(
          (update) =>
            update.sequence > input.afterUpdateSequence! &&
            selected.some((worker) => worker.threadId === update.workerThreadId),
        )) ||
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
    report,
    stop,
    wait,
    tick,
    assertClientMessageAllowed,
    assertCanEnableFlow,
    wakeups: Stream.fromQueue(wakeups),
    models: providers.getProviders,
    profiles,
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

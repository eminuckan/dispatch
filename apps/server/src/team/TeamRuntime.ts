import * as NodeCrypto from "node:crypto";

import {
  ApprovalRequestId,
  CommandId,
  MessageId,
  TeamError,
  ThreadId,
  type TeamAttempt,
  type TeamControl,
  type TeamFailover,
  type TeamMessage,
  type TeamModelProfile,
  type TeamOwner,
  type TeamProviderDecision,
  type TeamRun,
  type TeamSettlement,
  type TeamStart,
  type TeamTask,
} from "@dispatch/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import {
  deleteMaterializedThreadAttachments,
  materializePendingAttachmentsForThread,
  releasePendingAttachmentsForOwner,
  retainPendingAttachmentsForOwner,
} from "../assets/AttachmentUpload.ts";
import { GitWorkflowService } from "../git/GitWorkflowService.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import {
  isOrchestrationCommandRejection,
  OrchestrationCommandPreviouslyRejectedError,
} from "../orchestration/Errors.ts";
import { openRequests } from "../orchestration/decider.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ProjectionTurnRepositoryLive } from "../persistence/Layers/ProjectionTurns.ts";
import { ProjectionTurnRepository } from "../persistence/Services/ProjectionTurns.ts";
import { ProcessRunner, layer as ProcessRunnerLive } from "../processRunner.ts";
import { ProviderService } from "../provider/Services/ProviderService.ts";
import { forkParked } from "../serverActivation.ts";
import { OrchestrationAdvisor } from "./OrchestrationAdvisor.ts";
import { verificationDecision } from "./OrchestrationEvidence.ts";
import { equivalentProfileOrder, OrchestrationModelCatalog } from "./OrchestrationModels.ts";
import {
  integrationCorrectionPrompt,
  integrationPrompt,
  planningPrompt,
  providerHandoffPrompt,
  reviewPrompt,
  settlementConflictPrompt,
  FLOW_SUPERVISION_PROMPT_MARKER,
  supervisionPrompt,
  workerCorrectionPrompt,
  workerPrompt,
} from "./OrchestrationPrompts.ts";
import {
  IntegrationResult,
  OrchestrationPlan,
  parseProtocol,
  readyTasks,
  ReviewResult,
  reviewCoversAll,
  validatePlanGraph,
  WorkerResult,
} from "./OrchestrationProtocol.ts";
import { OrchestrationSettings } from "./OrchestrationSettings.ts";
import { OrchestrationStore } from "./OrchestrationStore.ts";
import { SMART_ROUTING_STANDARD_FALLBACK_NOTICE, teamThreadView } from "./presentation.ts";

const isTeamError = Schema.is(TeamError);
const isPreviouslyRejected = Schema.is(OrchestrationCommandPreviouslyRejectedError);
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const nowIso = DateTime.now.pipe(Effect.map(DateTime.formatIso));
const MAX_VERIFY_OUTPUT = 16 * 1024;
const WORKER_COMMIT_SHA = /^[0-9a-f]{7,64}$/iu;
const FULL_COMMIT_SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/iu;
const SUPERVISION_RECEIPTS_PREFIX = "DISPATCH_FLOW_RECEIPTS_V1 ";
const MESSAGE_CONTINUATION_MARKER = "DISPATCH_FLOW_MESSAGE_CONTINUATION_V1";
const MESSAGE_PROMPT_LIMIT = 63_000;
const SupervisionReceipts = Schema.Struct({
  messageIds: Schema.Array(Schema.String),
  workerAttemptIds: Schema.Array(Schema.String),
});
const decodeSupervisionReceipts = Schema.decodeSync(Schema.fromJsonString(SupervisionReceipts));

const unavailable = (message: string) => new TeamError({ code: "unavailable", message });
const invalid = (message: string) => new TeamError({ code: "invalid", message });
const mapError = (error: unknown) =>
  isTeamError(error)
    ? error
    : unavailable(error instanceof Error ? error.message : "Flow operation failed.");

function profileFor(run: TeamRun, profileId: string): TeamModelProfile {
  const profile = run.policy.profiles.find((candidate) => candidate.id === profileId);
  if (!profile) throw invalid(`Orchestration profile '${profileId}' is no longer in this run.`);
  return profile;
}

function ownerThread(owner: TeamOwner): ThreadId {
  if (!owner.threadId) throw invalid("Managed agent has no thread identity.");
  return owner.threadId;
}

function ownerForThread(run: TeamRun, threadId: ThreadId): TeamOwner | null {
  if (run.lead.threadId === threadId) return run.lead;
  return run.tasks.find((task) => task.owner.threadId === threadId)?.owner ?? null;
}

function attemptCount(run: TeamRun, taskId: string, role: TeamAttempt["role"]): number {
  return run.attempts.filter(
    (attempt) =>
      attempt.taskId === taskId &&
      attempt.role === role &&
      !attempt.prompt.startsWith(MESSAGE_CONTINUATION_MARKER),
  ).length;
}

function awaitsDelivery(message: TeamMessage): boolean {
  return (
    message.delivery === undefined ||
    message.delivery.status === "pending" ||
    message.delivery.status === "queued"
  );
}

function messageInstruction(message: TeamMessage): string {
  return [
    `Team message ID: ${message.id}`,
    `From: ${message.from.role}${message.from.taskId ? ` task ${message.from.taskId}` : ""}`,
    `To: ${message.to.role}${message.to.taskId ? ` task ${message.to.taskId}` : ""}`,
    `Reply requested: ${message.replyRequested ? "yes" : "no"}`,
    `Text: ${message.text}`,
  ].join("\n");
}

function messageBatch(messages: ReadonlyArray<TeamMessage>, prompt: string): TeamMessage[] {
  const selected: TeamMessage[] = [];
  let length = prompt.length;
  for (const message of messages) {
    const addition = messageInstruction(message).length + 2;
    if (length + addition > MESSAGE_PROMPT_LIMIT) break;
    selected.push(message);
    length += addition;
    if (selected.length === 4) break;
  }
  return selected;
}

function supervisionReceipts(run: TeamRun): {
  readonly messageIds: ReadonlySet<string>;
  readonly workerAttemptIds: ReadonlySet<string>;
} {
  const messageIds = new Set<string>();
  const workerAttemptIds = new Set<string>();
  for (const attempt of run.attempts) {
    if (
      attempt.role !== "review" ||
      attempt.taskId !== null ||
      !attempt.prompt.startsWith(FLOW_SUPERVISION_PROMPT_MARKER)
    )
      continue;
    const header = attempt.prompt.split(/\r?\n/, 2)[1];
    if (!header?.startsWith(SUPERVISION_RECEIPTS_PREFIX)) continue;
    try {
      const receipt = decodeSupervisionReceipts(header.slice(SUPERVISION_RECEIPTS_PREFIX.length));
      for (const id of receipt.messageIds) messageIds.add(id);
      for (const id of receipt.workerAttemptIds) workerAttemptIds.add(id);
    } catch {
      // Ignore malformed receipts; they cannot consume mailbox or failure events.
    }
  }
  return { messageIds, workerAttemptIds };
}

function makeAttempt(input: {
  run: TeamRun;
  owner: TeamOwner;
  role: TeamAttempt["role"];
  taskId: string | null;
  prompt: string;
  createdAt: string;
}): TeamAttempt {
  const profile = profileFor(input.run, input.owner.profileId);
  const sequence = input.run.attempts.filter(
    (attempt) => attempt.role === input.role && attempt.taskId === input.taskId,
  ).length;
  const id = NodeCrypto.randomUUID();
  return {
    id,
    commandId: `team-attempt-${id}`,
    requestMessageId: MessageId.make(`team-${id}`),
    taskId: input.taskId,
    role: input.role,
    sequence,
    owner: input.owner,
    selection: profile.selection,
    prompt: input.prompt,
    attachments: [],
    status: "reserved",
    providerTurnId: null,
    resultMessageId: null,
    result: null,
    failure: null,
    createdAt: input.createdAt,
    updatedAt: input.createdAt,
  };
}

function attemptFailureKind(
  text: string,
): TeamAttempt["failure"] extends infer T ? (T extends { kind: infer K } ? K : never) : never {
  const value = text.toLowerCase();
  if (
    value.includes("usage limit") ||
    value.includes("usage_limit") ||
    value.includes("usagelimit") ||
    value.includes("quota") ||
    value.includes("rate limit") ||
    value.includes("too many requests")
  )
    return "provider-limit";
  if (value.includes("unavailable") || value.includes("not ready") || value.includes("logged out"))
    return "provider-unavailable";
  return "provider-error";
}

export const make = Effect.gen(function* () {
  const store = yield* OrchestrationStore;
  const settingsService = yield* OrchestrationSettings;
  const advisor = yield* OrchestrationAdvisor;
  const models = yield* OrchestrationModelCatalog;
  const engine = yield* OrchestrationEngineService;
  const projection = yield* ProjectionSnapshotQuery;
  const turns = yield* ProjectionTurnRepository;
  const providers = yield* ProviderService;
  const git = yield* GitWorkflowService;
  const gitVcs = yield* GitVcsDriver.GitVcsDriver;
  const processes = yield* ProcessRunner;
  const schedulerLock = yield* Semaphore.make(1);
  const supervisorWakeQueue = yield* Queue.unbounded<void>();

  const runProcess = (input: {
    cwd: string;
    command: string;
    args: ReadonlyArray<string>;
    timeout?: "10 seconds" | "120 seconds";
    outputMode?: "error" | "truncate";
  }) =>
    processes
      .run({
        command: input.command,
        args: [...input.args],
        cwd: input.cwd,
        timeout: input.timeout ?? "120 seconds",
        maxOutputBytes: MAX_VERIFY_OUTPUT,
        outputMode: input.outputMode ?? "error",
      })
      .pipe(Effect.mapError(mapError));

  const reconcileAttachmentLease = Effect.fnUntraced(function* (run: TeamRun) {
    if (run.attachments.length === 0) return run;
    if (["completed", "cancelled", "failed"].includes(run.status)) {
      yield* releasePendingAttachmentsForOwner({ ownerId: run.id, attachments: run.attachments });
      return run;
    }
    const retained = yield* retainPendingAttachmentsForOwner({
      ownerId: run.id,
      attachments: run.attachments,
    });
    if (retained || run.status === "paused") return run;
    return yield* store.update(
      run.id,
      run.revision,
      (current) => ({
        ...current,
        status: "paused",
        statusReason:
          "Managed attachments are no longer available. Start a new run with fresh uploads.",
      }),
      "attachment-lease-missing",
    );
  });

  const ensureLeadWorktree = Effect.fn("TeamRuntime.ensureLeadWorktree")(function* (run: TeamRun) {
    if (!run.workspace) return yield* invalid("Run workspace is missing.");
    if (run.workspace.leadWorktreePath && run.workspace.leadBranch) return run;
    const branch = `orchestration/${run.id}/lead`;
    const refs = yield* git
      .listRefs({ cwd: run.workspace.root, query: branch, refKind: "local", refresh: true })
      .pipe(Effect.mapError(mapError));
    const existing = refs.refs.find((ref) => ref.name === branch);
    const worktree = existing?.worktreePath
      ? { path: existing.worktreePath, refName: existing.name }
      : (yield* git
          .createWorktree({
            cwd: run.workspace.root,
            refName: existing?.name ?? run.workspace.integrationHead,
            ...(existing ? {} : { newRefName: branch }),
            baseRefName: run.workspace.integrationHead,
            path: null,
          })
          .pipe(Effect.mapError(mapError))).worktree;
    return yield* store.update(
      run.id,
      run.revision,
      (current) => ({
        ...current,
        workspace: {
          ...current.workspace!,
          leadBranch: worktree.refName,
          leadWorktreePath: worktree.path,
        },
      }),
      "lead-worktree-ready",
    );
  });

  const ensureTaskWorktree = Effect.fn("TeamRuntime.ensureTaskWorktree")(function* (
    run: TeamRun,
    taskId: string,
  ) {
    if (!run.workspace) return yield* invalid("Run workspace is missing.");
    const task = run.tasks.find((candidate) => candidate.id === taskId);
    if (!task) return yield* invalid("Task no longer exists.");
    if (task.worktreePath && task.branch) return run;
    const branch = `orchestration/${run.id}/task/${task.id}`;
    const refs = yield* git
      .listRefs({ cwd: run.workspace.root, query: branch, refKind: "local", refresh: true })
      .pipe(Effect.mapError(mapError));
    const existing = refs.refs.find((ref) => ref.name === branch);
    const worktree = existing?.worktreePath
      ? { path: existing.worktreePath, refName: existing.name }
      : (yield* git
          .createWorktree({
            cwd: run.workspace.root,
            refName: existing?.name ?? run.workspace.integrationHead,
            ...(existing ? {} : { newRefName: branch }),
            baseRefName: run.workspace.integrationHead,
            path: null,
          })
          .pipe(Effect.mapError(mapError))).worktree;
    return yield* store.update(
      run.id,
      run.revision,
      (current) => ({
        ...current,
        tasks: current.tasks.map((candidate) =>
          candidate.id === task.id
            ? { ...candidate, branch: worktree.refName, worktreePath: worktree.path }
            : candidate,
        ),
      }),
      "worker-worktree-ready",
    );
  });

  const ensureThread = Effect.fn("TeamRuntime.ensureThread")(function* (
    run: TeamRun,
    attempt: TeamAttempt,
  ) {
    const threadId = ownerThread(attempt.owner);
    const existing = yield* projection
      .getThreadDetailById(threadId)
      .pipe(Effect.mapError(mapError));
    if (Option.isSome(existing)) return run;

    let current = run;
    if (attempt.owner.role === "lead") current = yield* ensureLeadWorktree(current);
    else if (attempt.taskId) current = yield* ensureTaskWorktree(current, attempt.taskId);
    const profile = profileFor(current, attempt.owner.profileId);
    const task = attempt.taskId
      ? current.tasks.find((candidate) => candidate.id === attempt.taskId)
      : undefined;
    const worktreePath =
      attempt.owner.role === "lead" ? current.workspace?.leadWorktreePath : task?.worktreePath;
    const branch = attempt.owner.role === "lead" ? current.workspace?.leadBranch : task?.branch;
    if (!worktreePath || !branch) return yield* invalid("Managed worktree was not prepared.");

    let persistedAttempt = current.attempts.find((candidate) => candidate.id === attempt.id)!;
    if (persistedAttempt.attachments.length === 0 && current.attachments.length > 0) {
      const copied = yield* materializePendingAttachmentsForThread({
        ownerId: current.id,
        threadId,
        attachments: current.attachments,
      });
      if (copied === null)
        return yield* unavailable("Managed attachments could not be prepared for this agent.");
      current = yield* store
        .update(
          current.id,
          current.revision,
          (state) => ({
            ...state,
            attempts: state.attempts.map((candidate) =>
              candidate.id === attempt.id ? { ...candidate, attachments: [...copied] } : candidate,
            ),
          }),
          "attempt-attachments-materialized",
        )
        .pipe(Effect.tapError(() => deleteMaterializedThreadAttachments(copied)));
      persistedAttempt = current.attempts.find((candidate) => candidate.id === attempt.id)!;
    }

    yield* engine
      .dispatch({
        type: "thread.create",
        commandId: CommandId.make(`team-create-${threadId}`),
        threadId,
        projectId: current.projectId,
        title:
          attempt.owner.role === "lead"
            ? `${current.executionMode === "direct" ? "Direct" : "Lead"} · ${current.prompt.slice(0, 80)}`
            : `Worker · ${(task?.objective ?? current.prompt).slice(0, 80)}`,
        modelSelection: profile.selection,
        runtimeMode: current.runtimeMode,
        interactionMode: "default",
        branch,
        worktreePath,
        createdAt: attempt.createdAt,
      })
      .pipe(Effect.mapError(mapError));
    return current;
  });

  const setAttempt = Effect.fn("TeamRuntime.setAttempt")(function* (
    run: TeamRun,
    attemptId: string,
    change: (attempt: TeamAttempt) => TeamAttempt,
    event: string,
  ) {
    const updatedAt = yield* nowIso;
    return yield* store.update(
      run.id,
      run.revision,
      (current) => ({
        ...current,
        attempts: current.attempts.map((attempt) =>
          attempt.id === attemptId ? { ...change(attempt), updatedAt } : attempt,
        ),
      }),
      event,
    );
  });

  const appendAttempt = Effect.fn("TeamRuntime.appendAttempt")(function* (
    run: TeamRun,
    attempt: TeamAttempt,
    event: string,
  ) {
    return yield* store.update(
      run.id,
      run.revision,
      (current) => ({
        ...current,
        attempts: [...current.attempts, attempt],
        tasks:
          attempt.taskId === null
            ? current.tasks
            : current.tasks.map((task) =>
                task.id === attempt.taskId && !task.attemptIds.includes(attempt.id)
                  ? { ...task, attemptIds: [...task.attemptIds, attempt.id] }
                  : task,
              ),
      }),
      event,
    );
  });

  const dispatchAttempt = Effect.fn("TeamRuntime.dispatchAttempt")(function* (
    run: TeamRun,
    attemptId: string,
  ) {
    let current = run;
    let attempt = current.attempts.find((candidate) => candidate.id === attemptId);
    if (!attempt || !["reserved", "dispatching"].includes(attempt.status)) return current;
    const profile = profileFor(current, attempt.owner.profileId);
    const availability = yield* models.refreshProfile(profile);
    if (!availability.managedSafe || !availability.usable) {
      const message = !availability.managedSafe
        ? "This provider cannot deterministically disable native subagents for Flow."
        : availability.quotaExhausted
          ? "The assigned provider usage limit is exhausted."
          : "The assigned provider is unavailable.";
      current = yield* setAttempt(
        current,
        attempt.id,
        (candidate) => ({
          ...candidate,
          status: "failed",
          failure: {
            kind: availability.quotaExhausted ? "provider-limit" : "provider-unavailable",
            message,
          },
        }),
        "attempt-unavailable",
      );
      return current;
    }

    current = yield* ensureThread(current, attempt);
    attempt = current.attempts.find((candidate) => candidate.id === attemptId)!;
    const threadId = ownerThread(attempt.owner);
    const requestMessageId = attempt.requestMessageId;
    const isSupervision = attempt.prompt.startsWith(FLOW_SUPERVISION_PROMPT_MARKER);
    const eligible = current.messages.filter(
      (message) =>
        message.to.threadId === threadId &&
        awaitsDelivery(message) &&
        (isSupervision ? message.delivery?.providerMessageId === requestMessageId : true),
    );
    const incoming = isSupervision ? eligible : messageBatch(eligible, attempt.prompt);
    if (incoming.length > 0) {
      const newInstructions = isSupervision
        ? []
        : incoming.filter(
            (message) => !attempt!.prompt.includes(`Team message ID: ${message.id}\n`),
          );
      current = yield* store.update(
        current.id,
        current.revision,
        (state) => ({
          ...state,
          attempts: state.attempts.map((candidate) =>
            candidate.id === attemptId && newInstructions.length > 0
              ? {
                  ...candidate,
                  prompt: `${candidate.prompt}\n\n${newInstructions.map(messageInstruction).join("\n\n")}`,
                }
              : candidate,
          ),
          messages: state.messages.map((message) =>
            incoming.some((selected) => selected.id === message.id)
              ? { ...message, delivery: { status: "queued", providerMessageId: requestMessageId } }
              : message,
          ),
        }),
        "team-messages-assigned",
      );
      attempt = current.attempts.find((candidate) => candidate.id === attemptId)!;
    }
    const markAttemptMessagesSent = (state: TeamRun) => ({
      ...state,
      attempts: state.attempts.map((candidate) =>
        candidate.id === attemptId ? { ...candidate, status: "running" as const } : candidate,
      ),
      messages: state.messages.map((message) =>
        message.delivery?.status === "queued" &&
        message.delivery.providerMessageId === requestMessageId
          ? {
              ...message,
              delivery: { status: "sent" as const, providerMessageId: requestMessageId },
            }
          : message,
      ),
    });
    const pending = yield* turns
      .getPendingTurnStartByThreadId({ threadId })
      .pipe(Effect.mapError(mapError));
    if (Option.isSome(pending)) {
      if (pending.value.messageId !== attempt.requestMessageId) return current;
      return yield* store.update(
        current.id,
        current.revision,
        markAttemptMessagesSent,
        "attempt-reconciled-running",
      );
    }
    const projected = yield* turns.listByThreadId({ threadId }).pipe(Effect.mapError(mapError));
    if (
      projected.some(
        (candidate) =>
          candidate.pendingMessageId === requestMessageId &&
          (candidate.state === "pending" || candidate.state === "running"),
      )
    )
      return yield* store.update(
        current.id,
        current.revision,
        markAttemptMessagesSent,
        "attempt-reconciled-running",
      );
    const thread = yield* projection.getThreadDetailById(threadId).pipe(Effect.mapError(mapError));
    if (
      Option.isSome(thread) &&
      (thread.value.latestTurn?.state === "running" || openRequests(thread.value).size > 0)
    )
      return current;
    if (attempt.status === "reserved") {
      current = yield* setAttempt(
        current,
        attempt.id,
        (candidate) => ({ ...candidate, status: "dispatching" }),
        "attempt-dispatching",
      );
      attempt = current.attempts.find((candidate) => candidate.id === attemptId)!;
    }

    const rejection = yield* engine
      .dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make(attempt.commandId),
        threadId: ownerThread(attempt.owner),
        message: {
          messageId: attempt.requestMessageId,
          role: "user",
          text: attempt.prompt,
          attachments: attempt.attachments,
        },
        modelSelection: attempt.selection,
        runtimeMode: current.runtimeMode,
        interactionMode: "default",
        createdAt: attempt.createdAt,
      })
      .pipe(
        Effect.as<string | null>(null),
        Effect.catch((error) =>
          isOrchestrationCommandRejection(error) || isPreviouslyRejected(error)
            ? Effect.succeed(error.message)
            : Effect.fail(mapError(error)),
        ),
      );
    if (rejection !== null)
      return yield* setAttempt(
        current,
        attempt.id,
        (candidate) => ({
          ...candidate,
          status: "failed",
          failure: { kind: attemptFailureKind(rejection), message: rejection },
        }),
        "attempt-rejected",
      );
    return yield* store.update(
      current.id,
      current.revision,
      markAttemptMessagesSent,
      "attempt-running",
    );
  });

  const resolvedAttemptTurn = Effect.fn("TeamRuntime.resolvedAttemptTurn")(function* (
    attempt: TeamAttempt,
  ) {
    const threadId = ownerThread(attempt.owner);
    const detail = yield* projection.getThreadDetailById(threadId).pipe(Effect.mapError(mapError));
    if (Option.isNone(detail)) return null;
    if (openRequests(detail.value).size > 0) return null;
    const projected = yield* turns.listByThreadId({ threadId }).pipe(Effect.mapError(mapError));
    let receipt = projected.find(
      (candidate) =>
        candidate.pendingMessageId === attempt.requestMessageId && candidate.turnId !== null,
    );
    if (!receipt) {
      const failure = detail.value.activities.findLast(
        (activity) =>
          activity.kind === "provider.turn.start.failed" &&
          Predicate.isObject(activity.payload) &&
          activity.payload.requestId === attempt.requestMessageId,
      );
      return failure
        ? {
            state: "failed" as const,
            turnId: null,
            assistantMessageId: null,
            text:
              Predicate.isObject(failure.payload) && typeof failure.payload.detail === "string"
                ? failure.payload.detail
                : failure.summary,
          }
        : null;
    }
    if (receipt.state === "pending" || receipt.state === "running") return null;

    const visited = new Set<string>();
    while (receipt.turnId) {
      if (visited.has(receipt.turnId)) return null;
      visited.add(receipt.turnId);
      const requestIds = new Set(
        detail.value.activities.flatMap((activity) => {
          if (
            activity.turnId !== receipt!.turnId ||
            activity.kind !== "user-input.requested" ||
            !Predicate.isObject(activity.payload) ||
            activity.payload.responseMode !== "message" ||
            typeof activity.payload.requestId !== "string"
          )
            return [];
          return [activity.payload.requestId];
        }),
      );
      const resolution = detail.value.activities.findLast(
        (activity) =>
          activity.kind === "user-input.resolved" &&
          activity.turnId === receipt!.turnId &&
          Predicate.isObject(activity.payload) &&
          typeof activity.payload.requestId === "string" &&
          requestIds.has(activity.payload.requestId),
      );
      if (
        !resolution ||
        !Predicate.isObject(resolution.payload) ||
        typeof resolution.payload.requestId !== "string"
      )
        break;
      const resolutionRequestId = resolution.payload.requestId;
      const continuation = projected.find(
        (candidate) => candidate.pendingMessageId === `async-answer:${resolutionRequestId}`,
      );
      if (!continuation || continuation.state === "pending" || continuation.state === "running")
        return null;
      receipt = continuation;
    }

    if (
      detail.value.latestTurn &&
      detail.value.latestTurn.turnId !== receipt.turnId &&
      detail.value.latestTurn.state === "running"
    )
      return null;
    const overtaken =
      receipt.completedAt !== null &&
      projected.some(
        (candidate) =>
          candidate.turnId !== receipt!.turnId &&
          candidate.startedAt !== null &&
          candidate.requestedAt >= receipt!.requestedAt &&
          candidate.startedAt >= (receipt!.startedAt ?? receipt!.requestedAt) &&
          candidate.startedAt <= receipt!.completedAt!,
      );
    if (overtaken)
      return {
        state: "failed" as const,
        turnId: receipt.turnId,
        assistantMessageId: receipt.assistantMessageId,
        text: "A newer message overlapped this managed turn. Inspect the agent conversation before resuming Flow.",
      };

    const answer = receipt.assistantMessageId
      ? detail.value.messages.find((message) => message.id === receipt!.assistantMessageId)
      : undefined;
    return {
      state: receipt.state,
      turnId: receipt.turnId,
      assistantMessageId: receipt.assistantMessageId,
      text: answer?.text ?? `Provider turn ended with ${receipt.state}.`,
    };
  });

  const reconcileAttempt = Effect.fn("TeamRuntime.reconcileAttempt")(function* (
    run: TeamRun,
    attemptId: string,
  ) {
    const attempt = run.attempts.find((candidate) => candidate.id === attemptId);
    if (!attempt || attempt.status !== "running") return run;
    const settled = yield* resolvedAttemptTurn(attempt);
    if (!settled) return run;
    const succeeded = settled.state === "completed" && settled.assistantMessageId !== null;
    return yield* setAttempt(
      run,
      attempt.id,
      (candidate) => ({
        ...candidate,
        status: succeeded ? "succeeded" : "failed",
        providerTurnId: settled.turnId,
        resultMessageId: settled.assistantMessageId,
        result: settled.text,
        failure: succeeded
          ? null
          : { kind: attemptFailureKind(settled.text), message: settled.text },
        updatedAt: candidate.updatedAt,
      }),
      succeeded ? "attempt-succeeded" : "attempt-failed",
    );
  });

  const deliverTeamMessages = Effect.fn("TeamRuntime.deliverTeamMessages")(function* (
    run: TeamRun,
  ) {
    let current = run;
    for (const message of run.messages.filter(awaitsDelivery)) {
      const threadId = message.to.threadId;
      if (!threadId) continue;
      if (message.delivery?.providerMessageId && message.delivery.turnId) {
        const providerMessageId = message.delivery.providerMessageId;
        const turnId = message.delivery.turnId;
        const detail = yield* projection
          .getThreadDetailById(threadId)
          .pipe(Effect.mapError(mapError));
        const observed =
          Option.isSome(detail) &&
          detail.value.messages.some((candidate) => candidate.id === providerMessageId);
        current = yield* store.update(
          current.id,
          current.revision,
          (state) => ({
            ...state,
            status: observed ? state.status : "paused",
            statusReason: observed
              ? state.statusReason
              : "Native team-message delivery could not be confirmed. Ask the lead before retrying it.",
            messages: state.messages.map((candidate) =>
              candidate.id === message.id
                ? {
                    ...candidate,
                    delivery: observed
                      ? { status: "steered", providerMessageId, turnId }
                      : {
                          status: "failed",
                          providerMessageId,
                          turnId,
                          detail:
                            "Native admission may have succeeded without a projected receipt.",
                        },
                  }
                : candidate,
            ),
          }),
          observed ? "team-message-native-reconciled" : "team-message-native-uncertain",
        );
        if (!observed) return current;
        continue;
      }
      const task = current.tasks.find((candidate) => candidate.owner.threadId === threadId);
      if (
        ["completed", "cancelled", "failed"].includes(current.status) ||
        (task && ["settled", "cancelled"].includes(task.status))
      ) {
        current = yield* store.update(
          current.id,
          current.revision,
          (state) => ({
            ...state,
            messages: state.messages.map((candidate) =>
              candidate.id === message.id
                ? {
                    ...candidate,
                    delivery: { status: "closed", detail: "Recipient work has ended." },
                  }
                : candidate,
            ),
          }),
          "team-message-closed",
        );
        continue;
      }
      const active = current.attempts.findLast(
        (attempt) => attempt.owner.threadId === threadId && attempt.status === "running",
      );
      if (!active || message.delivery?.status === "queued") continue;
      const projected = yield* turns.listByThreadId({ threadId }).pipe(Effect.mapError(mapError));
      const activeTurn = projected.find(
        (candidate) =>
          candidate.pendingMessageId === active.requestMessageId &&
          candidate.turnId !== null &&
          candidate.state === "running",
      );
      if (!activeTurn?.turnId) continue;
      const prepared = yield* providers.prepareSteerTurnMessageId(threadId).pipe(
        Effect.timeout("10 seconds"),
        Effect.catch(() => Effect.succeed({ status: "unsupported" as const })),
      );
      if (prepared.status === "unsupported") {
        current = yield* store.update(
          current.id,
          current.revision,
          (state) => ({
            ...state,
            messages: state.messages.map((candidate) =>
              candidate.id === message.id
                ? { ...candidate, delivery: { status: "queued" as const } }
                : candidate,
            ),
          }),
          "team-message-queued",
        );
        continue;
      }
      const providerMessageId = prepared.messageId;
      current = yield* store.update(
        current.id,
        current.revision,
        (state) => ({
          ...state,
          messages: state.messages.map((candidate) =>
            candidate.id === message.id
              ? {
                  ...candidate,
                  delivery: { status: "pending", providerMessageId, turnId: activeTurn.turnId! },
                }
              : candidate,
          ),
        }),
        "team-message-steer-intent",
      );
      const result = yield* providers
        .steerTurn({
          threadId,
          expectedTurnId: activeTurn.turnId,
          messageId: providerMessageId,
          input: messageInstruction(message),
        })
        .pipe(
          Effect.timeout("10 seconds"),
          Effect.catch((error) =>
            Effect.succeed({ status: "uncertain" as const, detail: error.message }),
          ),
        );
      current = yield* store.update(
        current.id,
        current.revision,
        (state) => ({
          ...state,
          status: result.status === "uncertain" ? "paused" : state.status,
          statusReason:
            result.status === "uncertain"
              ? "Native team-message delivery could not be confirmed. Ask the lead before retrying it."
              : state.statusReason,
          messages: state.messages.map((candidate) =>
            candidate.id === message.id
              ? {
                  ...candidate,
                  delivery:
                    result.status === "accepted"
                      ? { status: "steered" as const, providerMessageId, turnId: result.turnId }
                      : result.status === "uncertain"
                        ? {
                            status: "failed" as const,
                            providerMessageId,
                            turnId: activeTurn.turnId!,
                            detail: result.detail,
                          }
                        : {
                            status: "queued" as const,
                          },
                }
              : candidate,
          ),
        }),
        result.status === "accepted"
          ? "team-message-steered"
          : result.status === "uncertain"
            ? "team-message-native-uncertain"
            : "team-message-queued",
      );
      if (result.status === "uncertain") return current;
    }

    for (const task of current.tasks) {
      const threadId = task.owner.threadId;
      if (!threadId) continue;
      const incoming = current.messages.filter(
        (message) => message.to.threadId === threadId && awaitsDelivery(message),
      );
      if (incoming.length === 0) continue;
      if (task.status === "settling") {
        const settlement = current.settlements.find(
          (candidate) => candidate.id === task.settlementId,
        );
        if (settlement?.status !== "ready") {
          current = yield* store.update(
            current.id,
            current.revision,
            (state) => ({
              ...state,
              status: "paused",
              statusReason:
                "A team message arrived after worker settlement started. Ask the lead to reconcile it.",
              messages: state.messages.map((message) =>
                incoming.some((selected) => selected.id === message.id)
                  ? {
                      ...message,
                      delivery: { status: "failed", detail: "Worker settlement already started." },
                    }
                  : message,
              ),
            }),
            "team-message-settlement-conflict",
          );
          return current;
        }
        const updatedAt = yield* nowIso;
        current = yield* store.update(
          current.id,
          current.revision,
          (state) => ({
            ...state,
            tasks: state.tasks.map((candidate) =>
              candidate.id === task.id
                ? { ...candidate, status: "running" as const, settlementId: null }
                : candidate,
            ),
            settlements: state.settlements.map((candidate) =>
              candidate.id === settlement.id
                ? { ...candidate, status: "rejected" as const, updatedAt }
                : candidate,
            ),
          }),
          "settlement-superseded-by-message",
        );
      }
      if (!["running", "review", "settling"].includes(task.status)) continue;
      if (
        current.attempts.some(
          (attempt) =>
            attempt.owner.threadId === threadId &&
            ["reserved", "dispatching", "running"].includes(attempt.status),
        )
      )
        continue;
      const latestWork = current.attempts.findLast(
        (attempt) => attempt.taskId === task.id && attempt.role === "work",
      );
      if (latestWork?.status !== "succeeded") continue;
      const createdAt = yield* nowIso;
      const continuationPrompt = [
        MESSAGE_CONTINUATION_MARKER,
        "Continue this same Dispatch-managed task in its existing worktree. Apply the team messages below before reporting completion. Send a concise reply only if a concrete decision is needed. Return the normal complete worker JSON result with the current full Git commit SHA; this continuation is part of the same task.",
        `Task: ${task.objective}\nContext: ${task.context}\nAcceptance: ${task.acceptance.join("; ")}`,
      ].join("\n\n");
      const batch = messageBatch(incoming, continuationPrompt);
      if (batch.length === 0) continue;
      const continuation = makeAttempt({
        run: current,
        owner: task.owner,
        role: "work",
        taskId: task.id,
        prompt: `${continuationPrompt}\n\n${batch.map(messageInstruction).join("\n\n")}`,
        createdAt,
      });
      current = yield* store.update(
        current.id,
        current.revision,
        (state) => ({
          ...state,
          attempts: [...state.attempts, continuation],
          tasks: state.tasks.map((candidate) =>
            candidate.id === task.id
              ? {
                  ...candidate,
                  status: "running" as const,
                  attemptIds: [...candidate.attemptIds, continuation.id],
                }
              : candidate,
          ),
          messages: state.messages.map((message) =>
            batch.some((selected) => selected.id === message.id)
              ? {
                  ...message,
                  delivery: {
                    status: "queued" as const,
                    providerMessageId: continuation.requestMessageId,
                  },
                }
              : message,
          ),
        }),
        "team-message-continuation-reserved",
      );
    }
    return current;
  });

  const verify = Effect.fn("TeamRuntime.verify")(function* (
    cwd: string,
    checks: ReviewResult["checks"],
  ) {
    return yield* Effect.forEach(checks, (check) =>
      runProcess({ cwd, command: check.command, args: check.args, outputMode: "truncate" }).pipe(
        Effect.map((result) => ({
          ...check,
          passed: result.code === 0,
          output: `${result.stdout}\n${result.stderr}`.trim().slice(-MAX_VERIFY_OUTPUT),
        })),
        Effect.catch((error) =>
          Effect.succeed({
            ...check,
            passed: false,
            output: error.message.slice(-MAX_VERIFY_OUTPUT),
          }),
        ),
      ),
    );
  });

  const createFailover = Effect.fn("TeamRuntime.createFailover")(function* (
    run: TeamRun,
    attempt: TeamAttempt,
  ) {
    const currentProfile = profileFor(run, attempt.owner.profileId);
    const role =
      run.executionMode === "direct" && attempt.owner.role === "lead"
        ? "worker"
        : attempt.owner.role;
    const allowed = yield* models.runnableProfiles(run.policy, role);
    const equivalentIds = new Set(
      equivalentProfileOrder(currentProfile, allowed).map((candidate) => candidate.id),
    );
    const candidates = allowed.filter(
      (candidate) =>
        equivalentIds.has(candidate.id) &&
        candidate.selection.instanceId !== currentProfile.selection.instanceId,
    );
    const createdAt = yield* nowIso;
    const id = NodeCrypto.randomUUID();
    const failure = attempt.failure;
    const failover: TeamFailover = {
      id,
      taskId: attempt.taskId,
      attemptId: attempt.id,
      fromProfileId: currentProfile.id,
      candidateProfileIds: candidates.map((candidate) => candidate.id),
      trigger: {
        kind:
          failure?.kind === "provider-limit"
            ? "provider-limit"
            : failure?.kind === "provider-unavailable"
              ? "provider-unavailable"
              : "attempt-failed",
        providerInstanceId: currentProfile.selection.instanceId,
        limitId: null,
        detail: failure?.message ?? "Provider attempt failed.",
      },
      status: "pending",
      decision: null,
      createdAt,
      updatedAt: createdAt,
    };

    if (candidates.length === 0)
      return yield* store.update(
        run.id,
        run.revision,
        (current) => ({
          ...current,
          status: "paused",
          statusReason: "No comparable selected model is currently available on another provider.",
          failovers: [...current.failovers, { ...failover, status: "exhausted" }],
        }),
        "failover-exhausted",
      );

    if (run.policy.providerLimitBehavior === "pause")
      return yield* store.update(
        run.id,
        run.revision,
        (current) => ({
          ...current,
          status: "paused",
          statusReason: "The assigned provider reached a limit or became unavailable.",
          failovers: [
            ...current.failovers,
            {
              ...failover,
              status: "paused",
              decision: {
                action: "pause",
                profileId: null,
                source: "policy",
                decidedAt: createdAt,
              },
            },
          ],
        }),
        "failover-paused",
      );

    const advisorConfigured =
      run.policy.flowMode === "auto" &&
      run.policy.providerLimitBehavior === "auto" &&
      candidates.length > 1
        ? yield* advisor.configured
        : false;
    if (
      run.policy.providerLimitBehavior === "ask" ||
      (run.policy.providerLimitBehavior === "auto" &&
        currentProfile.capability === undefined &&
        !advisorConfigured)
    )
      return yield* store.update(
        run.id,
        run.revision,
        (current) => ({
          ...current,
          status: "awaiting-provider-decision",
          statusReason:
            run.policy.providerLimitBehavior === "auto"
              ? "A provider limit was reached, but Dispatch cannot prove an equivalent automatic replacement without capability metadata or Smart Routing. Choose another selected provider."
              : "A provider limit was reached. Choose whether Flow may continue with another selected provider.",
          failovers: [...current.failovers, failover],
        }),
        "failover-awaiting-user",
      );

    const useHostedFailoverProfile =
      run.policy.flowMode === "auto" && advisorConfigured && candidates.length > 1;
    const decision = useHostedFailoverProfile
      ? yield* advisor.chooseProfile({
          purpose: "failover",
          objective: attempt.taskId
            ? (run.tasks.find((task) => task.id === attempt.taskId)?.objective ?? run.prompt)
            : run.prompt,
          candidates,
          context: { failedModel: currentProfile.label, role: attempt.role },
        })
      : {
          profileId: candidates[0]!.id,
          source: "policy" as const,
          confidence: 1,
          reason: "Selected from the saved model order.",
        };
    const smartRoutingFallback = useHostedFailoverProfile && decision.source !== "jev";
    if (currentProfile.capability === undefined && decision.source !== "jev")
      return yield* store.update(
        run.id,
        run.revision,
        (current) => ({
          ...current,
          policy: smartRoutingFallback
            ? { ...current.policy, flowMode: "standard" }
            : current.policy,
          decisions:
            smartRoutingFallback &&
            !current.decisions.includes(SMART_ROUTING_STANDARD_FALLBACK_NOTICE)
              ? [...current.decisions, SMART_ROUTING_STANDARD_FALLBACK_NOTICE]
              : current.decisions,
          status: "awaiting-provider-decision",
          statusReason:
            "A provider limit was reached, but Dispatch cannot prove an equivalent automatic replacement because capability metadata is missing and Smart Routing did not return a confident decision. Choose another selected provider.",
          failovers: [...current.failovers, failover],
        }),
        "failover-awaiting-user",
      );
    const failoverRun = smartRoutingFallback
      ? yield* store.update(
          run.id,
          run.revision,
          (current) => ({
            ...current,
            policy: { ...current.policy, flowMode: "standard" },
            decisions: current.decisions.includes(SMART_ROUTING_STANDARD_FALLBACK_NOTICE)
              ? current.decisions
              : [...current.decisions, SMART_ROUTING_STANDARD_FALLBACK_NOTICE],
          }),
          "smart-routing-fallback",
        )
      : run;
    return yield* applyFailover(
      failoverRun,
      failover,
      "switch",
      decision.profileId,
      decision.source === "jev" ? "advisor" : "policy",
    );
  });

  const applyFailover = Effect.fn("TeamRuntime.applyFailover")(function* (
    run: TeamRun,
    failover: TeamFailover,
    action: "retry" | "switch" | "pause",
    profileId: string | null,
    source: "user" | "policy" | "advisor",
  ) {
    const failed = run.attempts.find((attempt) => attempt.id === failover.attemptId);
    if (!failed) return yield* invalid("Failover attempt no longer exists.");
    const decidedAt = yield* nowIso;
    if (action === "pause")
      return yield* store.update(
        run.id,
        run.revision,
        (current) => ({
          ...current,
          status: "paused",
          statusReason: "Flow paused after a provider limit.",
          failovers: current.failovers.map((candidate) =>
            candidate.id === failover.id
              ? {
                  ...candidate,
                  status: "paused",
                  decision: { action, profileId: null, source, decidedAt },
                  updatedAt: decidedAt,
                }
              : candidate,
          ),
        }),
        "failover-paused",
      );

    const nextProfileId = action === "retry" ? failed.owner.profileId : profileId;
    if (!nextProfileId) return yield* invalid("A replacement profile is required.");
    if (action === "switch" && !failover.candidateProfileIds.includes(nextProfileId))
      return yield* invalid("Selected replacement is outside the available failover candidates.");
    const nextProfile = profileFor(run, nextProfileId);
    const nextThreadId =
      action === "retry"
        ? failed.owner.threadId
        : ThreadId.make(`team-${run.id}-${failed.owner.role}-${NodeCrypto.randomUUID()}`);
    const nextOwner: TeamOwner = {
      ...failed.owner,
      profileId: nextProfile.id,
      threadId: nextThreadId,
    };
    const replacement = makeAttempt({
      run: { ...run, lead: failed.owner.role === "lead" ? nextOwner : run.lead },
      owner: nextOwner,
      role: failed.role,
      taskId: failed.taskId,
      prompt: action === "switch" ? providerHandoffPrompt(run, failed) : failed.prompt,
      createdAt: decidedAt,
    });
    const appliedFailover = {
      ...failover,
      status: "applied" as const,
      decision: { action, profileId: nextProfileId, source, decidedAt },
      updatedAt: decidedAt,
    };
    return yield* store.update(
      run.id,
      run.revision,
      (current) => ({
        ...current,
        lead: failed.owner.role === "lead" ? nextOwner : current.lead,
        status:
          failed.role === "plan"
            ? "planning"
            : failed.role === "integrate"
              ? failed.taskId === null
                ? "review"
                : "settling"
              : "running",
        statusReason: null,
        tasks:
          failed.taskId === null
            ? current.tasks
            : current.tasks.map((task) =>
                task.id === failed.taskId
                  ? {
                      ...task,
                      owner: failed.owner.role === "worker" ? nextOwner : task.owner,
                      status: failed.role === "work" ? "running" : task.status,
                      attemptIds: [...task.attemptIds, replacement.id],
                    }
                  : task,
              ),
        attempts: [...current.attempts, replacement],
        messages: current.messages.map((message) =>
          awaitsDelivery(message) && message.to.threadId === failed.owner.threadId
            ? { ...message, to: nextOwner, delivery: { status: "pending" as const } }
            : message,
        ),
        failovers: current.failovers.some((candidate) => candidate.id === failover.id)
          ? current.failovers.map((candidate) =>
              candidate.id === failover.id ? appliedFailover : candidate,
            )
          : [...current.failovers, appliedFailover],
      }),
      "failover-applied",
    );
  });

  const handleTerminalAttemptFailure = Effect.fn("TeamRuntime.handleTerminalAttemptFailure")(
    function* (run: TeamRun, attempt: TeamAttempt) {
      if (
        attempt.failure?.kind === "provider-limit" ||
        attempt.failure?.kind === "provider-unavailable"
      )
        return yield* createFailover(run, attempt);
      if (attempt.prompt.startsWith(MESSAGE_CONTINUATION_MARKER))
        return yield* store.update(
          run.id,
          run.revision,
          (current) => ({
            ...current,
            status: "paused",
            statusReason: attempt.failure?.message ?? "Team message continuation failed.",
          }),
          "team-message-continuation-paused",
        );
      if (attempt.role === "work" && attempt.taskId) {
        const task = run.tasks.find((candidate) => candidate.id === attempt.taskId)!;
        if (attemptCount(run, task.id, "work") < run.policy.maxAttempts) {
          const createdAt = yield* nowIso;
          const retry = makeAttempt({
            run,
            owner: task.owner,
            role: "work",
            taskId: task.id,
            prompt: workerCorrectionPrompt(
              run,
              task,
              attempt.failure?.message ??
                "The previous worker attempt failed before producing an acceptable result.",
            ),
            createdAt,
          });
          return yield* appendAttempt(run, retry, "worker-retry-reserved");
        }
      }
      return yield* store.update(
        run.id,
        run.revision,
        (current) => ({
          ...current,
          status: "paused",
          statusReason: attempt.failure?.message ?? "Managed attempt failed.",
          tasks:
            attempt.taskId === null
              ? current.tasks
              : current.tasks.map((task) =>
                  task.id === attempt.taskId ? { ...task, status: "failed" } : task,
                ),
        }),
        "attempt-paused-run",
      );
    },
  );

  const dispatchPendingAttempts = Effect.fn("TeamRuntime.dispatchPendingAttempts")(function* (
    run: TeamRun,
  ) {
    let current = run;
    const visited = new Set<string>();
    for (let iteration = 0; iteration < 64; iteration++) {
      const pending = current.attempts.find((attempt) => {
        if (visited.has(attempt.id) || !["reserved", "dispatching"].includes(attempt.status))
          return false;
        const threadId = attempt.owner.threadId;
        return !current.attempts.some(
          (other) =>
            other.id !== attempt.id &&
            other.owner.threadId === threadId &&
            ["dispatching", "running"].includes(other.status),
        );
      });
      if (!pending) break;
      visited.add(pending.id);
      current = yield* dispatchAttempt(current, pending.id);
      const latest = current.attempts.find((attempt) => attempt.id === pending.id);
      if (latest?.status === "failed")
        current = yield* handleTerminalAttemptFailure(current, latest);
      if (["paused", "awaiting-provider-decision", "cancelled", "failed"].includes(current.status))
        return current;
    }
    return current;
  });

  const installPlan = Effect.fn("TeamRuntime.installPlan")(function* (
    run: TeamRun,
    attempt: TeamAttempt,
  ) {
    const plan = yield* Effect.try({
      try: () => parseProtocol(OrchestrationPlan, attempt.result ?? ""),
      catch: () => invalid("Lead returned an invalid Flow plan."),
    });
    if (run.executionMode === "orchestrated")
      yield* Effect.try({ try: () => validatePlanGraph(plan), catch: mapError });
    const proposals =
      run.executionMode === "direct" || run.policy.maxActive === 1 ? [] : plan.tasks;
    const workers = proposals.length ? yield* models.runnableProfiles(run.policy, "worker") : [];
    if (proposals.length > 0 && workers.length === 0)
      return yield* unavailable(
        "No selected Worker model is currently safe and available for Flow.",
      );
    const tasks: TeamTask[] = [];
    let useSmartRouting = run.policy.flowMode === "auto" && workers.length > 1;
    let smartRoutingFallback = false;
    for (const proposal of proposals) {
      const preferred = workers.find((profile) => profile.id === proposal.preferredProfileId);
      const decision = useSmartRouting
        ? yield* advisor.chooseProfile({
            purpose: "worker",
            objective: encodeJson({
              objective: proposal.objective,
              acceptance: proposal.acceptance,
              context: proposal.context,
            }),
            candidates: workers,
            preferredProfileId: preferred?.id ?? null,
          })
        : {
            profileId: workers[0]!.id,
            source: "policy" as const,
            confidence: 1,
            reason: "Selected from the saved Worker model order.",
          };
      if (useSmartRouting && decision.source !== "jev") {
        useSmartRouting = false;
        smartRoutingFallback = true;
      }
      const profile =
        useSmartRouting && decision.source === "jev"
          ? (workers.find((candidate) => candidate.id === decision.profileId) ?? workers[0]!)
          : workers[0]!;
      const threadId = ThreadId.make(`team-${run.id}-worker-${NodeCrypto.randomUUID()}`);
      tasks.push({
        id: proposal.id,
        objective: proposal.objective,
        context: proposal.context,
        acceptance: [...proposal.acceptance],
        dependencies: [...proposal.dependencies],
        owner: { role: "worker", profileId: profile.id, threadId, taskId: proposal.id },
        branch: null,
        worktreePath: null,
        status: "pending",
        attemptIds: [],
        settlementId: null,
        result: null,
      });
    }
    return yield* store.update(
      run.id,
      run.revision,
      (current) => ({
        ...current,
        policy: smartRoutingFallback ? { ...current.policy, flowMode: "standard" } : current.policy,
        acceptance: [...plan.acceptance],
        decisions: [
          ...current.decisions,
          run.executionMode === "direct" && plan.tasks.length > 0
            ? `${plan.rationale} Dispatch enforced direct execution; delegated tasks were not scheduled.`
            : run.policy.maxActive === 1 && plan.tasks.length > 0
              ? `${plan.rationale} Dispatch enforced Lead-only execution because maxActive is 1; delegated tasks were not scheduled.`
              : plan.rationale,
          ...(smartRoutingFallback &&
          !current.decisions.includes(SMART_ROUTING_STANDARD_FALLBACK_NOTICE)
            ? [SMART_ROUTING_STANDARD_FALLBACK_NOTICE]
            : []),
        ],
        tasks,
        status: tasks.length > 0 ? "running" : "review",
        statusReason: null,
      }),
      "plan-installed",
    );
  });

  const advanceWorkers = Effect.fn("TeamRuntime.advanceWorkers")(function* (run: TeamRun) {
    let current = run;
    for (const task of readyTasks(current)) {
      if (
        current.attempts.some(
          (attempt) =>
            attempt.taskId === task.id &&
            ["reserved", "dispatching", "running"].includes(attempt.status),
        )
      )
        continue;
      const createdAt = yield* nowIso;
      const attempt = makeAttempt({
        run: current,
        owner: task.owner,
        role: "work",
        taskId: task.id,
        prompt: workerPrompt(current, task),
        createdAt,
      });
      current = yield* store.update(
        current.id,
        current.revision,
        (state) => ({
          ...state,
          tasks: state.tasks.map((candidate) =>
            candidate.id === task.id
              ? {
                  ...candidate,
                  status: "running",
                  attemptIds: [...candidate.attemptIds, attempt.id],
                }
              : candidate,
          ),
          attempts: [...state.attempts, attempt],
        }),
        "worker-reserved",
      );
    }
    return current;
  });

  const reviewWorker = Effect.fn("TeamRuntime.reviewWorker")(function* (
    run: TeamRun,
    task: TeamTask,
  ) {
    const work = run.attempts.findLast(
      (attempt) => attempt.taskId === task.id && attempt.role === "work",
    );
    if (work?.status !== "succeeded") return run;
    let workerResult: typeof WorkerResult.Type;
    try {
      workerResult = parseProtocol(WorkerResult, work.result ?? "");
    } catch {
      const failed = yield* setAttempt(
        run,
        work.id,
        (attempt) => ({
          ...attempt,
          status: "failed",
          failure: {
            kind: "invalid-result",
            message: "Worker returned an invalid settlement result.",
          },
        }),
        "worker-result-invalid",
      );
      return yield* handleTerminalAttemptFailure(
        failed,
        failed.attempts.find((attempt) => attempt.id === work.id)!,
      );
    }
    if (!task.worktreePath) return yield* invalid("Worker worktree is missing.");
    const head = yield* gitVcs.resolveCommit({ cwd: task.worktreePath, revision: "HEAD" }).pipe(
      Effect.map((resolved) => resolved.commitSha),
      Effect.catch(() => Effect.succeed(null)),
    );
    const reportedCommit =
      head && WORKER_COMMIT_SHA.test(workerResult.commit)
        ? head.toLowerCase() === workerResult.commit.toLowerCase()
          ? head
          : yield* gitVcs
              .resolveCommit({ cwd: task.worktreePath, revision: workerResult.commit })
              .pipe(
                Effect.map((resolved) => resolved.commitSha),
                Effect.catch(() => Effect.succeed(null)),
              )
        : null;
    if (
      !head ||
      !FULL_COMMIT_SHA.test(head) ||
      !reportedCommit ||
      reportedCommit.toLowerCase() !== head.toLowerCase()
    ) {
      const message = !WORKER_COMMIT_SHA.test(workerResult.commit)
        ? "Worker settlement must report a hexadecimal Git commit SHA. No worker changes were integrated; have the worker report the current full SHA from `git rev-parse --verify HEAD`."
        : !head || !FULL_COMMIT_SHA.test(head)
          ? "Dispatch could not verify the worker worktree HEAD. No worker changes were integrated; inspect the worker worktree and report its full SHA before continuing."
          : !reportedCommit
            ? `Worker settlement SHA ${workerResult.commit} could not be resolved to a commit in its assigned worktree. No worker changes were integrated; have the worker report the current full SHA from \`git rev-parse --verify HEAD\`.`
            : `Worker settlement commit ${reportedCommit} does not match its worktree HEAD ${head}. No worker changes were integrated; have the worker report the current full SHA from \`git rev-parse --verify HEAD\`.`;
      const failed = yield* setAttempt(
        run,
        work.id,
        (attempt) => ({
          ...attempt,
          status: "failed",
          failure: { kind: "invalid-result", message },
        }),
        "worker-commit-mismatch",
      );
      return yield* handleTerminalAttemptFailure(
        failed,
        failed.attempts.find((attempt) => attempt.id === work.id)!,
      );
    }
    workerResult = { ...workerResult, commit: reportedCommit };
    const canonicalWorkerResult = encodeJson(workerResult);

    const existingReview = run.attempts.findLast(
      (attempt) => attempt.taskId === task.id && attempt.role === "review",
    );
    if (!existingReview || run.attempts.indexOf(existingReview) < run.attempts.indexOf(work)) {
      const createdAt = yield* nowIso;
      const review = makeAttempt({
        run,
        owner: run.lead,
        role: "review",
        taskId: task.id,
        prompt: reviewPrompt(run, task, canonicalWorkerResult),
        createdAt,
      });
      return yield* store.update(
        run.id,
        run.revision,
        (current) => ({
          ...current,
          tasks: current.tasks.map((candidate) =>
            candidate.id === task.id
              ? {
                  ...candidate,
                  status: "review",
                  result: canonicalWorkerResult,
                  attemptIds: [...candidate.attemptIds, review.id],
                }
              : candidate,
          ),
          attempts: [...current.attempts, review],
        }),
        "worker-review-reserved",
      );
    }
    if (existingReview.status === "failed")
      return yield* handleTerminalAttemptFailure(run, existingReview);
    if (existingReview.status !== "succeeded") return run;

    const review = yield* Effect.try({
      try: () => parseProtocol(ReviewResult, existingReview.result ?? ""),
      catch: () => invalid("Lead returned an invalid worker review."),
    });
    if (review.action === "accept" && !reviewCoversAll(task.acceptance, review))
      return yield* store.update(
        run.id,
        run.revision,
        (current) => ({
          ...current,
          status: "paused",
          statusReason: "Lead review did not cover every acceptance criterion.",
        }),
        "review-incomplete",
      );

    if (review.action === "correct") {
      if (attemptCount(run, task.id, "work") >= run.policy.maxAttempts)
        return yield* store.update(
          run.id,
          run.revision,
          (current) => ({
            ...current,
            status: "paused",
            statusReason: "Worker attempt limit reached before acceptance.",
          }),
          "worker-attempt-limit",
        );
      const createdAt = yield* nowIso;
      const retry = makeAttempt({
        run,
        owner: task.owner,
        role: "work",
        taskId: task.id,
        prompt: workerCorrectionPrompt(run, task, review.summary),
        createdAt,
      });
      return yield* store.update(
        run.id,
        run.revision,
        (current) => ({
          ...current,
          decisions: [...current.decisions, review.summary],
          tasks: current.tasks.map((candidate) =>
            candidate.id === task.id
              ? { ...candidate, status: "running", attemptIds: [...candidate.attemptIds, retry.id] }
              : candidate,
          ),
          attempts: [...current.attempts, retry],
        }),
        "worker-correction-reserved",
      );
    }

    const evidence = yield* verify(task.worktreePath, review.checks);
    if (evidence.some((entry) => !entry.passed)) {
      const correction = verificationDecision(review.summary, evidence);
      if (attemptCount(run, task.id, "work") >= run.policy.maxAttempts)
        return yield* store.update(
          run.id,
          run.revision,
          (current) => ({
            ...current,
            status: "paused",
            statusReason: "Worker verification failed at the attempt limit.",
          }),
          "worker-verification-limit",
        );
      const createdAt = yield* nowIso;
      const retry = makeAttempt({
        run,
        owner: task.owner,
        role: "work",
        taskId: task.id,
        prompt: workerCorrectionPrompt(run, task, correction),
        createdAt,
      });
      return yield* store.update(
        run.id,
        run.revision,
        (current) => ({
          ...current,
          decisions: [...current.decisions, correction],
          tasks: current.tasks.map((candidate) =>
            candidate.id === task.id
              ? { ...candidate, status: "running", attemptIds: [...candidate.attemptIds, retry.id] }
              : candidate,
          ),
          attempts: [...current.attempts, retry],
        }),
        "worker-verification-correction",
      );
    }

    const mergeBase = yield* runProcess({
      cwd: task.worktreePath,
      command: "git",
      args: ["merge-base", workerResult.commit, run.workspace!.integrationHead],
      timeout: "10 seconds",
    });
    if (mergeBase.code !== 0 || !mergeBase.stdout.trim())
      return yield* invalid("Could not determine the worker settlement base commit.");
    const createdAt = yield* nowIso;
    const settlement: TeamSettlement = {
      id: NodeCrypto.randomUUID(),
      taskId: task.id,
      attemptId: work.id,
      owner: task.owner,
      sourceWorktreePath: task.worktreePath,
      baseCommit: mergeBase.stdout.trim(),
      headCommit: workerResult.commit,
      appliedCommit: null,
      status: "ready",
      summary: review.summary,
      createdAt,
      updatedAt: createdAt,
    };
    return yield* store.update(
      run.id,
      run.revision,
      (current) => ({
        ...current,
        decisions: [...current.decisions, verificationDecision(review.summary, evidence, task.id)],
        tasks: current.tasks.map((candidate) =>
          candidate.id === task.id
            ? { ...candidate, status: "settling", settlementId: settlement.id }
            : candidate,
        ),
        settlements: [...current.settlements, settlement],
        status: "settling",
      }),
      "settlement-ready",
    );
  });

  const reserveSupervision = Effect.fn("TeamRuntime.reserveSupervision")(function* (run: TeamRun) {
    if (!["running", "settling", "review", "paused"].includes(run.status)) return run;
    if (run.status === "paused" && run.statusReason === "Paused by user.") return run;
    const leadThreadId = ownerThread(run.lead);
    const consumed = supervisionReceipts(run);
    const messages = run.messages.filter(
      (message) =>
        !consumed.messageIds.has(message.id) &&
        (message.delivery?.status === "failed" ||
          (message.from.role === "worker" &&
            message.to.threadId === leadThreadId &&
            awaitsDelivery(message))),
    );
    const failedDelivery = messages.some((message) => message.delivery?.status === "failed");
    const failedWorkerAttempts = run.attempts.filter((attempt) => {
      if (
        attempt.role !== "work" ||
        attempt.taskId === null ||
        attempt.status !== "failed" ||
        attempt.failure === null
      )
        return false;
      const task = run.tasks.find((candidate) => candidate.id === attempt.taskId);
      return (
        task !== undefined &&
        ["running", "failed"].includes(task.status) &&
        (attempt.failure.kind === "invalid-result" ||
          attempt.prompt.startsWith(MESSAGE_CONTINUATION_MARKER) ||
          run.status === "paused") &&
        !consumed.workerAttemptIds.has(attempt.id)
      );
    });
    if (messages.length === 0 && failedWorkerAttempts.length === 0) return run;
    if (run.status === "paused" && failedWorkerAttempts.length === 0 && !failedDelivery) return run;
    const leadIsBusy = run.attempts.some(
      (attempt) =>
        attempt.owner.threadId === leadThreadId &&
        ["reserved", "dispatching", "running"].includes(attempt.status),
    );
    if (leadIsBusy) return run;
    const leadThread = yield* projection
      .getThreadDetailById(leadThreadId)
      .pipe(Effect.orElseSucceed(() => Option.none()));
    if (Option.isSome(leadThread) && leadThread.value.latestTurn?.state === "running") return run;

    const selectedMessages = messages.slice(0, 8);
    const selectedFailures = failedWorkerAttempts.slice(0, 8);
    const createdAt = yield* nowIso;
    const supervisor = makeAttempt({
      run,
      owner: run.lead,
      role: "review",
      taskId: null,
      prompt: supervisionPrompt(
        run,
        selectedMessages,
        selectedFailures.map((attempt) => attempt.id),
      ),
      createdAt,
    });
    return yield* store.update(
      run.id,
      run.revision,
      (current) => ({
        ...current,
        attempts: [...current.attempts, supervisor],
        messages: current.messages.map((message) =>
          awaitsDelivery(message) && selectedMessages.some((selected) => selected.id === message.id)
            ? {
                ...message,
                delivery: {
                  status: "queued" as const,
                  providerMessageId: supervisor.requestMessageId,
                },
              }
            : message,
        ),
      }),
      "lead-supervision-reserved",
    );
  });

  const advancePausedSupervision = Effect.fn("TeamRuntime.advancePausedSupervision")(function* (
    run: TeamRun,
  ) {
    if (run.statusReason === "Paused by user.") return run;
    let current = run;
    for (const attempt of current.attempts.filter((candidate) => candidate.status === "running"))
      current = yield* reconcileAttempt(current, attempt.id);
    current = yield* reserveSupervision(current);
    const pending = current.attempts.findLast(
      (attempt) =>
        attempt.role === "review" &&
        attempt.taskId === null &&
        attempt.prompt.startsWith(FLOW_SUPERVISION_PROMPT_MARKER) &&
        attempt.status === "reserved",
    );
    if (pending) return yield* dispatchAttempt(current, pending.id);
    return current;
  });

  const cleanupAppliedSettlement = Effect.fn("TeamRuntime.cleanupAppliedSettlement")(function* (
    run: TeamRun,
    settlementId: string,
  ) {
    const settlement = run.settlements.find((candidate) => candidate.id === settlementId);
    if (settlement?.status !== "applied" || !run.workspace) return run;
    const task = run.tasks.find((candidate) => candidate.id === settlement.taskId);
    if (!task || task.status !== "settled" || (!task.worktreePath && !task.branch)) return run;

    if (task.worktreePath) {
      const removed = yield* git
        .removeWorktree({
          cwd: run.workspace.root,
          path: task.worktreePath,
          force: false,
        })
        .pipe(
          Effect.as(true),
          Effect.orElseSucceed(() => false),
        );
      if (!removed) {
        const listed = yield* runProcess({
          cwd: run.workspace.root,
          command: "git",
          args: ["worktree", "list", "--porcelain"],
          timeout: "10 seconds",
        });
        const stillRegistered =
          listed.code === 0 &&
          listed.stdout.split(/\r?\n/).some((line) => line === `worktree ${task.worktreePath}`);
        if (listed.code !== 0 || stillRegistered)
          return yield* unavailable("Worker workspace cleanup failed after accepted integration.");
      }
    }

    if (task.branch) {
      const deleted = yield* runProcess({
        cwd: run.workspace.root,
        command: "git",
        args: ["branch", "-D", task.branch],
        timeout: "10 seconds",
      });
      if (deleted.code !== 0) {
        const branchRef = yield* runProcess({
          cwd: run.workspace.root,
          command: "git",
          args: ["show-ref", "--verify", "--quiet", `refs/heads/${task.branch}`],
          timeout: "10 seconds",
        });
        if (branchRef.code !== 1)
          return yield* unavailable("Worker branch cleanup failed after accepted integration.");
      }
    }

    return yield* store.update(
      run.id,
      run.revision,
      (current) => ({
        ...current,
        tasks: current.tasks.map((candidate) =>
          candidate.id === task.id
            ? {
                ...candidate,
                branch: null,
                worktreePath: null,
              }
            : candidate,
        ),
      }),
      "settlement-cleaned",
    );
  });

  const reconcileAppliedSettlementCleanup = Effect.fn(
    "TeamRuntime.reconcileAppliedSettlementCleanup",
  )(function* (run: TeamRun) {
    let current = run;
    for (const settlement of current.settlements) {
      if (settlement.status !== "applied") continue;
      const task = current.tasks.find((candidate) => candidate.id === settlement.taskId);
      if (!task || (!task.worktreePath && !task.branch)) continue;
      current = yield* cleanupAppliedSettlement(current, settlement.id);
    }
    return current;
  });

  const applySettlement = Effect.fn("TeamRuntime.applySettlement")(function* (
    run: TeamRun,
    settlement: TeamSettlement,
  ) {
    if (!run.workspace?.leadWorktreePath || !settlement.headCommit)
      return yield* invalid("Settlement workspace is incomplete.");
    const leadWorktreePath = run.workspace.leadWorktreePath;
    if (settlement.status === "conflict") {
      const resolution = run.attempts.findLast(
        (attempt) =>
          attempt.role === "integrate" &&
          attempt.taskId === settlement.taskId &&
          attempt.createdAt >= settlement.updatedAt,
      );
      if (!resolution || ["reserved", "dispatching", "running"].includes(resolution.status))
        return run;
      if (resolution.status === "failed")
        return yield* handleTerminalAttemptFailure(run, resolution);
      if (resolution.status !== "succeeded") return run;
      const ancestor = yield* runProcess({
        cwd: leadWorktreePath,
        command: "git",
        args: ["merge-base", "--is-ancestor", settlement.headCommit, "HEAD"],
        timeout: "10 seconds",
      });
      if (ancestor.code !== 0)
        return yield* store.update(
          run.id,
          run.revision,
          (current) => ({
            ...current,
            status: "paused",
            statusReason:
              "Lead conflict resolution finished without integrating the accepted worker commit.",
          }),
          "settlement-conflict-unresolved",
        );
      const head = yield* runProcess({
        cwd: leadWorktreePath,
        command: "git",
        args: ["rev-parse", "HEAD"],
        timeout: "10 seconds",
      });
      if (head.code !== 0 || !head.stdout.trim())
        return yield* invalid("Could not read the conflict-resolved integration HEAD.");
      const appliedAt = yield* nowIso;
      run = yield* store.update(
        run.id,
        run.revision,
        (current) => ({
          ...current,
          workspace: { ...current.workspace!, integrationHead: head.stdout.trim() },
          status: "running",
          statusReason: null,
          tasks: current.tasks.map((task) =>
            task.id === settlement.taskId ? { ...task, status: "settled" } : task,
          ),
          settlements: current.settlements.map((candidate) =>
            candidate.id === settlement.id
              ? {
                  ...candidate,
                  status: "applied",
                  appliedCommit: head.stdout.trim(),
                  updatedAt: appliedAt,
                }
              : candidate,
          ),
        }),
        "settlement-conflict-resolved",
      );
    }
    const commitCount = yield* runProcess({
      cwd: settlement.sourceWorktreePath,
      command: "git",
      args: ["rev-list", "--count", `${settlement.baseCommit}..${settlement.headCommit}`],
      timeout: "10 seconds",
    });
    if (commitCount.code !== 0 || Number.parseInt(commitCount.stdout.trim(), 10) < 1)
      return yield* invalid("Worker settlement contains no commits to integrate.");

    let current = run;
    if (settlement.status === "applying") {
      const alreadyApplied = yield* runProcess({
        cwd: leadWorktreePath,
        command: "git",
        args: ["merge-base", "--is-ancestor", settlement.headCommit, "HEAD"],
        timeout: "10 seconds",
      });
      if (alreadyApplied.code === 0) {
        const head = yield* runProcess({
          cwd: leadWorktreePath,
          command: "git",
          args: ["rev-parse", "HEAD"],
          timeout: "10 seconds",
        });
        if (head.code !== 0 || !head.stdout.trim())
          return yield* invalid("Could not reconcile the applied worker settlement.");
        const appliedAt = yield* nowIso;
        current = yield* store.update(
          current.id,
          current.revision,
          (state) => ({
            ...state,
            workspace: { ...state.workspace!, integrationHead: head.stdout.trim() },
            status: "running",
            tasks: state.tasks.map((task) =>
              task.id === settlement.taskId ? { ...task, status: "settled" } : task,
            ),
            settlements: state.settlements.map((candidate) =>
              candidate.id === settlement.id
                ? {
                    ...candidate,
                    status: "applied",
                    appliedCommit: head.stdout.trim(),
                    updatedAt: appliedAt,
                  }
                : candidate,
            ),
          }),
          "settlement-reconciled-applied",
        );
      } else {
        yield* runProcess({
          cwd: leadWorktreePath,
          command: "git",
          args: ["merge", "--abort"],
          timeout: "10 seconds",
        }).pipe(Effect.ignore);
      }
    }

    const reconciled = current.settlements.find((candidate) => candidate.id === settlement.id);
    if (reconciled?.status !== "applied") {
      const applyingAt = yield* nowIso;
      if (reconciled?.status !== "applying")
        current = yield* store.update(
          current.id,
          current.revision,
          (state) => ({
            ...state,
            settlements: state.settlements.map((candidate) =>
              candidate.id === settlement.id
                ? { ...candidate, status: "applying", updatedAt: applyingAt }
                : candidate,
            ),
          }),
          "settlement-applying",
        );

      const merge = yield* runProcess({
        cwd: leadWorktreePath,
        command: "git",
        args: ["merge", "--no-edit", settlement.headCommit],
      });
      if (merge.code !== 0) {
        const task = current.tasks.find((candidate) => candidate.id === settlement.taskId);
        if (!task) return yield* invalid("Settlement task no longer exists.");
        const conflictAt = yield* nowIso;
        const resolution = makeAttempt({
          run: current,
          owner: current.lead,
          role: "integrate",
          taskId: task.id,
          prompt: settlementConflictPrompt(current, task, settlement.headCommit),
          createdAt: conflictAt,
        });
        return yield* store.update(
          current.id,
          current.revision,
          (state) => ({
            ...state,
            status: "settling",
            statusReason:
              "The lead is resolving a conflict while integrating an accepted worker result.",
            attempts: [...state.attempts, resolution],
            tasks: state.tasks.map((candidate) =>
              candidate.id === task.id
                ? { ...candidate, attemptIds: [...candidate.attemptIds, resolution.id] }
                : candidate,
            ),
            settlements: state.settlements.map((candidate) =>
              candidate.id === settlement.id
                ? { ...candidate, status: "conflict", updatedAt: conflictAt }
                : candidate,
            ),
          }),
          "settlement-conflict",
        );
      }
      const head = yield* runProcess({
        cwd: leadWorktreePath,
        command: "git",
        args: ["rev-parse", "HEAD"],
        timeout: "10 seconds",
      });
      if (head.code !== 0 || !head.stdout.trim())
        return yield* invalid("Could not read integration HEAD.");
      const appliedAt = yield* nowIso;
      current = yield* store.update(
        current.id,
        current.revision,
        (state) => ({
          ...state,
          workspace: { ...state.workspace!, integrationHead: head.stdout.trim() },
          status: "running",
          tasks: state.tasks.map((task) =>
            task.id === settlement.taskId ? { ...task, status: "settled" } : task,
          ),
          settlements: state.settlements.map((candidate) =>
            candidate.id === settlement.id
              ? {
                  ...candidate,
                  status: "applied",
                  appliedCommit: head.stdout.trim(),
                  updatedAt: appliedAt,
                }
              : candidate,
          ),
        }),
        "settlement-applied",
      );
    }

    return yield* cleanupAppliedSettlement(current, settlement.id);
  });

  const advanceIntegration = Effect.fn("TeamRuntime.advanceIntegration")(function* (run: TeamRun) {
    if (run.tasks.some((task) => task.status !== "settled")) return run;
    const lastSupervisionIndex = run.attempts.findLastIndex(
      (attempt) =>
        attempt.role === "review" &&
        attempt.taskId === null &&
        attempt.prompt.startsWith(FLOW_SUPERVISION_PROMPT_MARKER),
    );
    const lastIntegrationIndex = run.attempts.findLastIndex(
      (attempt) => attempt.role === "integrate" && attempt.taskId === null,
    );
    if (lastSupervisionIndex > lastIntegrationIndex) {
      if (run.attempts[lastSupervisionIndex]?.status !== "succeeded") return run;
      const createdAt = yield* nowIso;
      return yield* appendAttempt(
        run,
        makeAttempt({
          run,
          owner: run.lead,
          role: "integrate",
          taskId: null,
          prompt: integrationPrompt(run),
          createdAt,
        }),
        "integration-after-supervision",
      );
    }
    const last = run.attempts.findLast(
      (attempt) => attempt.role === "integrate" && attempt.taskId === null,
    );
    if (!last) {
      const createdAt = yield* nowIso;
      return yield* appendAttempt(
        run,
        makeAttempt({
          run,
          owner: run.lead,
          role: "integrate",
          taskId: null,
          prompt: integrationPrompt(run),
          createdAt,
        }),
        "integration-reserved",
      );
    }
    if (last.status === "failed") return yield* handleTerminalAttemptFailure(run, last);
    if (last.status !== "succeeded") return run;
    const result = yield* Effect.try({
      try: () => parseProtocol(IntegrationResult, last.result ?? ""),
      catch: () => invalid("Lead returned an invalid integration result."),
    });
    if (!run.workspace?.leadWorktreePath) return yield* invalid("Lead worktree is missing.");
    if (result.action === "correct" || !reviewCoversAll(run.acceptance, result)) {
      if (
        run.attempts.filter((attempt) => attempt.role === "integrate" && attempt.taskId === null)
          .length >= run.policy.maxAttempts
      )
        return yield* store.update(
          run.id,
          run.revision,
          (current) => ({
            ...current,
            status: "paused",
            statusReason: "Combined verification did not converge within the attempt limit.",
          }),
          "integration-attempt-limit",
        );
      const createdAt = yield* nowIso;
      const correction = result.summary;
      return yield* appendAttempt(
        run,
        makeAttempt({
          run,
          owner: run.lead,
          role: "integrate",
          taskId: null,
          prompt: integrationCorrectionPrompt(run, correction),
          createdAt,
        }),
        "integration-correction-reserved",
      );
    }
    const evidence = yield* verify(run.workspace.leadWorktreePath, result.checks);
    if (evidence.some((entry) => !entry.passed)) {
      if (
        run.attempts.filter((attempt) => attempt.role === "integrate" && attempt.taskId === null)
          .length >= run.policy.maxAttempts
      )
        return yield* store.update(
          run.id,
          run.revision,
          (current) => ({
            ...current,
            status: "paused",
            statusReason: "Combined verification failed at the attempt limit.",
          }),
          "integration-verification-limit",
        );
      const createdAt = yield* nowIso;
      return yield* appendAttempt(
        run,
        makeAttempt({
          run,
          owner: run.lead,
          role: "integrate",
          taskId: null,
          prompt: integrationCorrectionPrompt(run, verificationDecision(result.summary, evidence)),
          createdAt,
        }),
        "integration-verification-correction",
      );
    }
    const dirty = yield* runProcess({
      cwd: run.workspace.leadWorktreePath,
      command: "git",
      args: ["status", "--porcelain"],
      timeout: "10 seconds",
    });
    if (dirty.code !== 0 || dirty.stdout.trim())
      return yield* store.update(
        run.id,
        run.revision,
        (current) => ({
          ...current,
          status: "paused",
          statusReason: "Lead worktree still has uncommitted changes after verification.",
        }),
        "integration-dirty",
      );
    const head = yield* runProcess({
      cwd: run.workspace.leadWorktreePath,
      command: "git",
      args: ["rev-parse", "HEAD"],
      timeout: "10 seconds",
    });
    const completed = yield* store.update(
      run.id,
      run.revision,
      (current) => ({
        ...current,
        status: "completed",
        statusReason: result.summary,
        workspace: {
          ...current.workspace!,
          integrationHead: head.stdout.trim() || current.workspace!.integrationHead,
        },
        decisions: [...current.decisions, verificationDecision(result.summary, evidence)],
      }),
      "run-completed",
    );
    yield* releasePendingAttachmentsForOwner({
      ownerId: completed.id,
      attachments: completed.attachments,
    });
    return completed;
  });

  const advanceRun = Effect.fn("TeamRuntime.advanceRun")(function* (id: string) {
    let run = yield* store.get(id);
    if (run.status === "paused") return yield* advancePausedSupervision(run);
    if (["cancelled", "completed", "failed", "awaiting-provider-decision"].includes(run.status))
      return run;

    run = yield* reconcileAppliedSettlementCleanup(run);
    run = yield* dispatchPendingAttempts(run);
    if (run.status === "paused") return yield* advancePausedSupervision(run);
    if (["awaiting-provider-decision", "cancelled", "failed"].includes(run.status)) return run;
    for (const attempt of run.attempts.filter((candidate) => candidate.status === "running"))
      run = yield* reconcileAttempt(run, attempt.id);
    run = yield* deliverTeamMessages(run);
    if (run.status === "paused") return yield* advancePausedSupervision(run);

    const terminalFailure = run.attempts.findLast(
      (attempt) =>
        attempt.status === "failed" &&
        run.attempts.findLast(
          (candidate) => candidate.role === attempt.role && candidate.taskId === attempt.taskId,
        )?.id === attempt.id &&
        !run.failovers.some((failover) => failover.attemptId === attempt.id) &&
        (attempt.taskId === null ||
          run.tasks.find((task) => task.id === attempt.taskId)?.status !== "settled"),
    );
    if (terminalFailure) {
      run = yield* handleTerminalAttemptFailure(run, terminalFailure);
      if (run.status === "paused") return yield* advancePausedSupervision(run);
      if (run.status === "awaiting-provider-decision") return run;
    }

    if (run.status === "planning") {
      const plan = run.attempts.findLast((attempt) => attempt.role === "plan");
      if (plan?.status === "succeeded") run = yield* installPlan(run, plan);
      else return run;
    }

    if (run.status === "running" || run.status === "settling") {
      for (const task of run.tasks) {
        const currentTask = run.tasks.find((candidate) => candidate.id === task.id)!;
        if (currentTask.status === "running" || currentTask.status === "review")
          run = yield* reviewWorker(run, currentTask);
        const latestTask = run.tasks.find((candidate) => candidate.id === task.id)!;
        if (latestTask.status === "settling" && latestTask.settlementId) {
          const settlement = run.settlements.find(
            (candidate) => candidate.id === latestTask.settlementId,
          );
          if (settlement && ["ready", "applying", "conflict"].includes(settlement.status))
            run = yield* applySettlement(run, settlement);
        }
        if (run.status === "paused") return yield* advancePausedSupervision(run);
        if (run.status === "awaiting-provider-decision") return run;
      }
      if (run.tasks.every((task) => task.status === "settled"))
        run = yield* store.update(
          run.id,
          run.revision,
          (current) => ({ ...current, status: "review" }),
          "workers-settled",
        );
      else run = yield* advanceWorkers(run);
    }

    run = yield* reserveSupervision(run);
    if (run.status === "review") run = yield* advanceIntegration(run);
    if (
      !["paused", "awaiting-provider-decision", "cancelled", "completed", "failed"].includes(
        run.status,
      )
    )
      run = yield* dispatchPendingAttempts(run);
    return run;
  }, schedulerLock.withPermits(1));

  const start = Effect.fn("TeamRuntime.start")(function* (input: TeamStart) {
    const existing = (yield* store.list).find((run) => run.commandId === input.commandId);
    if (existing) {
      if (
        existing.projectId !== input.projectId ||
        existing.runtimeMode !== input.runtimeMode ||
        existing.prompt !== input.prompt.trim() ||
        encodeJson(existing.attachments) !== encodeJson(input.attachments)
      )
        return yield* new TeamError({
          code: "conflict",
          message: "Command ID already belongs to a different Flow request.",
        });
      return yield* reconcileAttachmentLease(existing);
    }
    const settings = yield* settingsService.settings;
    if (!settings.policy.enabled)
      return yield* invalid("Enable Flow before starting a managed run.");
    if (!input.prompt.trim()) return yield* invalid("Flow requires an objective.");
    const [leadCandidates, workerCandidates] = yield* Effect.all([
      models.runnableProfiles(settings.policy, "lead"),
      models.runnableProfiles(settings.policy, "worker"),
    ]);
    const directCandidates = workerCandidates;
    const route =
      settings.policy.flowMode === "standard"
        ? {
            mode: "orchestrated" as const,
            source: "policy" as const,
            confidence: 1,
            reason: "Standard Flow uses the saved Lead and Worker model order.",
          }
        : !settings.smartRouting.available
          ? {
              mode: "orchestrated" as const,
              source: "policy" as const,
              confidence: 1,
              reason: "Smart Routing is unavailable; using Flow Standard.",
            }
          : directCandidates.length === 0
            ? {
                mode: "orchestrated" as const,
                source: "policy" as const,
                confidence: 1,
                reason: "No available worker can execute the objective directly.",
              }
            : yield* advisor.routeExecution({
                objective: input.prompt,
                workers: directCandidates,
              });
    const routedExecutionMode = route.mode;
    const routedCandidates = routedExecutionMode === "direct" ? directCandidates : leadCandidates;
    if (routedCandidates.length === 0)
      return yield* unavailable(
        routedExecutionMode === "direct"
          ? "No selected Worker model is currently safe and available for direct execution."
          : settings.policy.flowMode === "auto"
            ? route.source === "jev"
              ? "Flow Auto selected a managed team, but no selected Lead model is currently safe and available."
              : "Flow Auto fell back to Standard, but no selected Lead model is currently safe and available."
            : "No selected Lead model is currently safe and available for Flow Standard.",
      );
    const useHostedProfile =
      settings.policy.flowMode === "auto" && route.source === "jev" && routedCandidates.length > 1;
    const decision = useHostedProfile
      ? yield* advisor.chooseProfile({
          purpose: routedExecutionMode === "direct" ? "worker" : "lead",
          objective: input.prompt,
          candidates: routedCandidates,
        })
      : {
          profileId: routedCandidates[0]!.id,
          source: "policy" as const,
          confidence: 1,
          reason: "Selected from the saved model order.",
        };
    const profileFallback = useHostedProfile && decision.source !== "jev";
    if (profileFallback && leadCandidates.length === 0)
      return yield* unavailable(
        "Smart Routing could not choose a profile, and no selected Lead model is currently safe and available for Flow Standard.",
      );
    const executionMode = profileFallback ? ("orchestrated" as const) : routedExecutionMode;
    const candidates = profileFallback ? leadCandidates : routedCandidates;
    const leadProfile = profileFallback
      ? candidates[0]!
      : (candidates.find((candidate) => candidate.id === decision.profileId) ?? candidates[0]!);
    const project = yield* projection
      .getProjectShellById(input.projectId)
      .pipe(Effect.mapError(mapError));
    if (Option.isNone(project))
      return yield* new TeamError({ code: "not-found", message: "Project not found." });
    const head = yield* runProcess({
      cwd: project.value.workspaceRoot,
      command: "git",
      args: ["rev-parse", "--verify", "HEAD^{commit}"],
      timeout: "10 seconds",
    });
    if (head.code !== 0 || !/^[a-f0-9]{40,64}$/.test(head.stdout.trim()))
      return yield* invalid("Flow requires a Git repository with an initial commit.");
    const id = NodeCrypto.randomUUID();
    const leadThreadId = ThreadId.make(`team-${id}-lead`);
    const retained = yield* retainPendingAttachmentsForOwner({
      ownerId: id,
      attachments: input.attachments,
    });
    if (!retained) return yield* unavailable("Flow attachments could not be retained.");
    const createdAt = yield* nowIso;
    const lead: TeamOwner = {
      role: "lead",
      profileId: leadProfile.id,
      threadId: leadThreadId,
      taskId: null,
    };
    const seed: TeamRun = {
      id,
      commandId: input.commandId,
      projectId: input.projectId,
      revision: 0,
      executionMode,
      runtimeMode: input.runtimeMode,
      prompt: input.prompt.trim(),
      policy:
        settings.policy.flowMode === "auto" && (route.source !== "jev" || profileFallback)
          ? { ...settings.policy, flowMode: "standard" }
          : settings.policy,
      lead,
      acceptance: [],
      decisions: [
        route.reason,
        settings.policy.flowMode === "auto" && (route.source !== "jev" || profileFallback)
          ? SMART_ROUTING_STANDARD_FALLBACK_NOTICE
          : decision.reason,
      ],
      status: "planning",
      statusReason: null,
      workspace: {
        root: project.value.workspaceRoot,
        baseCommit: head.stdout.trim(),
        integrationHead: head.stdout.trim(),
        leadBranch: null,
        leadWorktreePath: null,
      },
      tasks: [],
      attempts: [],
      messages: [],
      settlements: [],
      failovers: [],
      attachments: [...input.attachments],
      createdAt,
      updatedAt: createdAt,
    };
    const plan = makeAttempt({
      run: seed,
      owner: lead,
      role: "plan",
      taskId: null,
      prompt: planningPrompt(seed),
      createdAt,
    });
    const created = yield* store
      .create({ ...seed, attempts: [plan] })
      .pipe(
        Effect.tapError(() =>
          releasePendingAttachmentsForOwner({ ownerId: id, attachments: input.attachments }),
        ),
      );
    if (created.id !== id) {
      yield* releasePendingAttachmentsForOwner({ ownerId: id, attachments: input.attachments });
      if (
        created.projectId !== input.projectId ||
        created.prompt !== input.prompt.trim() ||
        encodeJson(created.attachments) !== encodeJson(input.attachments)
      )
        return yield* new TeamError({
          code: "conflict",
          message: "Command ID already belongs to a different Flow request.",
        });
      return yield* reconcileAttachmentLease(created);
    }
    yield* advanceRun(created.id).pipe(Effect.ignoreCause({ log: true }));
    return yield* store.get(created.id);
  });

  const control = Effect.fn("TeamRuntime.control")(function* (input: TeamControl) {
    const run = yield* store.get(input.id);
    if (run.revision !== input.revision)
      return yield* new TeamError({
        code: "conflict",
        message: "Run changed; reload before controlling it.",
      });
    if (["completed", "cancelled", "failed"].includes(run.status)) return run;
    if (input.action === "cancel") {
      const interruptedThreads = new Set<ThreadId>();
      for (const attempt of run.attempts.filter((candidate) =>
        ["dispatching", "running"].includes(candidate.status),
      )) {
        const threadId = attempt.owner.threadId;
        if (!threadId || interruptedThreads.has(threadId)) continue;
        interruptedThreads.add(threadId);

        const detail = yield* projection
          .getThreadDetailById(threadId)
          .pipe(Effect.orElseSucceed(() => Option.none()));
        if (Option.isSome(detail)) {
          for (const [requestId, request] of openRequests(detail.value)) {
            if (request.kind !== "approval.requested") continue;
            yield* engine
              .dispatch({
                type: "thread.approval.respond",
                commandId: CommandId.make(`team-cancel-approval-${attempt.id}-${requestId}`),
                threadId,
                requestId: ApprovalRequestId.make(requestId),
                decision: "cancel",
                createdAt: yield* nowIso,
              })
              .pipe(Effect.ignore);
          }
        }

        yield* engine
          .dispatch({
            type: "thread.turn.interrupt",
            commandId: CommandId.make(`team-cancel-${attempt.id}`),
            threadId,
            createdAt: yield* nowIso,
          })
          .pipe(Effect.ignore);
      }
    }
    const updated = yield* store.update(
      run.id,
      run.revision,
      (current) => ({
        ...current,
        status:
          input.action === "cancel"
            ? "cancelled"
            : input.action === "pause"
              ? "paused"
              : current.acceptance.length === 0
                ? "planning"
                : current.tasks.some((task) => task.status !== "settled")
                  ? "running"
                  : "review",
        statusReason: input.action === "pause" ? "Paused by user." : null,
        attempts:
          input.action === "cancel"
            ? current.attempts.map((attempt) =>
                ["reserved", "dispatching", "running"].includes(attempt.status)
                  ? {
                      ...attempt,
                      status: "cancelled" as const,
                      failure: { kind: "cancelled" as const, message: "Cancelled by user." },
                    }
                  : attempt,
              )
            : current.attempts,
        tasks:
          input.action === "cancel"
            ? current.tasks.map((task) =>
                ["settled", "cancelled"].includes(task.status)
                  ? task
                  : { ...task, status: "cancelled" as const },
              )
            : current.tasks,
      }),
      `run-${input.action}`,
    );
    if (input.action === "cancel")
      yield* releasePendingAttachmentsForOwner({
        ownerId: updated.id,
        attachments: updated.attachments,
      });
    return updated;
  });

  const providerDecision = Effect.fn("TeamRuntime.providerDecision")(function* (
    input: TeamProviderDecision,
  ) {
    const run = yield* store.get(input.id);
    if (run.revision !== input.revision)
      return yield* new TeamError({
        code: "conflict",
        message: "Run changed; reload before choosing a provider.",
      });
    const failover = run.failovers.find((candidate) => candidate.id === input.failoverId);
    if (!failover || failover.status !== "pending")
      return yield* invalid("Provider decision is no longer pending.");
    yield* applyFailover(run, failover, input.action, input.profileId, "user");
    return yield* advanceRun(run.id);
  });

  const sendMessage = Effect.fn("TeamRuntime.sendMessage")(function* (
    fromThreadId: ThreadId,
    input: {
      id: string;
      toThreadId: ThreadId;
      text: string;
      replyRequested: boolean;
      inReplyTo?: string;
    },
  ) {
    const run = yield* store.findByThread(fromThreadId);
    if (!run)
      return yield* new TeamError({
        code: "not-found",
        message: "Managed run not found for sender.",
      });
    const from = ownerForThread(run, fromThreadId);
    const to = ownerForThread(run, input.toThreadId);
    if (!from || !to)
      return yield* invalid(
        "Team messages can only target current members of the same managed run.",
      );
    if (["completed", "cancelled", "failed"].includes(run.status))
      return yield* invalid("This managed run has ended.");
    const existing = run.messages.find((message) => message.id === input.id);
    if (existing) {
      if (
        existing.from.threadId === from.threadId &&
        existing.to.threadId === to.threadId &&
        existing.text === input.text &&
        existing.replyRequested === input.replyRequested &&
        existing.inReplyTo === input.inReplyTo
      ) {
        if (awaitsDelivery(existing)) yield* Queue.offer(supervisorWakeQueue, undefined);
        return existing;
      }
      return yield* new TeamError({
        code: "conflict",
        message: "Message ID already belongs to different content.",
      });
    }
    if (input.inReplyTo && !run.messages.some((message) => message.id === input.inReplyTo))
      return yield* invalid("Reply target does not exist in this managed run.");
    const createdAt = yield* nowIso;
    const message: TeamMessage = {
      id: input.id,
      from,
      to,
      text: input.text,
      replyRequested: input.replyRequested,
      ...(input.inReplyTo ? { inReplyTo: input.inReplyTo } : {}),
      createdAt,
      readAt: null,
      delivery: { status: "pending" },
    };
    yield* store.update(
      run.id,
      run.revision,
      (current) => ({ ...current, messages: [...current.messages, message] }),
      "team-message-sent",
    );
    yield* Queue.offer(supervisorWakeQueue, undefined);
    return message;
  }, schedulerLock.withPermits(1));

  const readMessages = Effect.fn("TeamRuntime.readMessages")(function* (
    threadId: ThreadId,
    includeRead = false,
  ) {
    let run = yield* store.findByThread(threadId);
    if (!run)
      return yield* new TeamError({
        code: "not-found",
        message: "Managed run not found for reader.",
      });
    if (!ownerForThread(run, threadId))
      return yield* invalid("Only current managed team members can read the mailbox.");
    const messages = run.messages
      .filter(
        (message) => message.to.threadId === threadId && (includeRead || message.readAt === null),
      )
      .slice(-40);
    const unread = new Set(
      messages.filter((message) => message.readAt === null).map((message) => message.id),
    );
    if (unread.size > 0) {
      const readAt = yield* nowIso;
      run = yield* store.update(
        run.id,
        run.revision,
        (current) => ({
          ...current,
          messages: current.messages.map((message) =>
            unread.has(message.id) ? { ...message, readAt } : message,
          ),
        }),
        "team-messages-read",
      );
    }
    const members = [run.lead, ...run.tasks.map((task) => task.owner)].flatMap((owner) =>
      owner.threadId
        ? [
            {
              threadId: owner.threadId,
              role: owner.role,
              state:
                owner.role === "lead"
                  ? run.status
                  : (run.tasks.find((task) => task.owner.threadId === owner.threadId)?.status ??
                    "pending"),
              activity: "",
              needsUserInput: false,
              summary:
                owner.role === "worker"
                  ? (run.tasks.find((task) => task.owner.threadId === owner.threadId)?.result ?? "")
                  : (run.statusReason ?? ""),
            },
          ]
        : [],
    );
    return {
      runId: run.id,
      status: run.status,
      leadThreadId: ownerThread(run.lead),
      members,
      messages,
    };
  }, schedulerLock.withPermits(1));

  const assertClientMessageAllowed = Effect.fn("TeamRuntime.assertClientMessageAllowed")(function* (
    threadId: ThreadId,
  ) {
    const run = yield* store.findByThread(threadId);
    if (run && run.lead.threadId !== threadId)
      return yield* invalid(
        "Managed worker threads are read-only. Send messages to the Flow lead.",
      );
  });

  const tick = Effect.fn("TeamRuntime.tick")(function* () {
    for (const run of yield* store.active) {
      const leased = yield* reconcileAttachmentLease(run);
      if (leased.status === "paused" && run.status !== "paused") continue;
      yield* advanceRun(leased.id).pipe(
        Effect.catch((error) =>
          store.get(leased.id).pipe(
            Effect.flatMap((current) =>
              store.update(
                current.id,
                current.revision,
                (state) => ({ ...state, status: "paused", statusReason: error.message }),
                "runtime-error-paused",
              ),
            ),
            Effect.ignore,
          ),
        ),
      );
    }
  });

  return {
    start,
    control,
    providerDecision,
    sendMessage,
    readMessages,
    assertClientMessageAllowed,
    tick,
    wakeups: Stream.fromQueue(supervisorWakeQueue),
    list: store.list,
    get: store.get,
    forThread: Effect.fn("TeamRuntime.forThread")(function* (threadId: ThreadId) {
      return teamThreadView(yield* store.findByThread(threadId));
    }),
  };
});

export class TeamRuntime extends Context.Service<TeamRuntime, Effect.Success<typeof make>>()(
  "dispatch/team/TeamRuntime",
) {}

export const layer = Layer.effect(TeamRuntime, make).pipe(
  Layer.provide(ProjectionTurnRepositoryLive),
  Layer.provide(ProcessRunnerLive),
);

export const reactorLayer = Layer.effectDiscard(
  Effect.gen(function* () {
    const runtime = yield* TeamRuntime;
    const engine = yield* OrchestrationEngineService;
    const events = yield* engine.subscribeDomainEvents;
    const wakeups = Stream.merge(
      events.pipe(
        Stream.filter(
          (event) =>
            event.aggregateId.startsWith("team-") &&
            (event.type === "thread.session-set" ||
              event.type === "thread.turn-diff-completed" ||
              (event.type === "thread.message-sent" && !event.payload.streaming) ||
              (event.type === "thread.activity-appended" &&
                [
                  "approval.resolved",
                  "user-input.resolved",
                  "user-input.answer-submitted",
                  "provider.turn.start.failed",
                ].includes(event.payload.activity.kind))),
        ),
      ),
      runtime.wakeups,
    );
    yield* forkParked(
      Effect.andThen(
        runtime.tick().pipe(Effect.ignoreCause({ log: true })),
        Stream.runForEach(wakeups, () => runtime.tick().pipe(Effect.ignoreCause({ log: true }))),
      ).pipe(
        Effect.catchCause(() =>
          Effect.logError(
            "Flow reconciliation stopped; restart the server to resume durable runs.",
          ),
        ),
      ),
    );
  }),
);

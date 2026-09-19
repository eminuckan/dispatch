import { usableModel } from "./pool.ts";
import { teamAgentDisplayName } from "@t3tools/shared/teamAgentNames";
import { isTeamProtocolRole } from "@t3tools/shared/teamProtocolPresentation";
import { teamThreadView } from "./presentation.ts";
import {
  isOrchestrationCommandRejection,
  OrchestrationCommandPreviouslyRejectedError,
} from "../orchestration/Errors.ts";
import * as NodeCrypto from "node:crypto";
import {
  CommandId,
  EventId,
  MessageId,
  ThreadId,
  TeamError,
  type TeamStart,
  type TeamControl,
  type TeamRun,
  type TeamExecutionTurn,
  type TeamModelProfile,
  type TeamPeerMessage,
  type OrchestrationEvent,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import { forkParked } from "../serverActivation.ts";
import * as DateTime from "effect/DateTime";
import * as Predicate from "effect/Predicate";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ProviderRegistry } from "../provider/Services/ProviderRegistry.ts";
import { GitWorkflowService } from "../git/GitWorkflowService.ts";
import { ProcessRunner, layer as ProcessRunnerLive } from "../processRunner.ts";
import { ProjectionTurnRepository } from "../persistence/Services/ProjectionTurns.ts";
import { ProjectionTurnRepositoryLive } from "../persistence/Layers/ProjectionTurns.ts";
import { TeamStore } from "./TeamStore.ts";
import { TeamRouter } from "./TeamRouter.ts";
import {
  acceptPlan,
  acceptTask,
  retryTask,
  contextPack,
  PlanProposal,
  receiveResult,
} from "./decider.ts";
import { validatePool, defaultTeamPolicy } from "./routing.ts";
import { parseProposal, LeadReview, reviewCoverage } from "./execution.ts";
import { openRequests } from "../orchestration/decider.ts";

const encode = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const liveProgressGuidance =
  "Use team_read_messages before each meaningful work step and before reporting a result. Use team_send_message to ask teammates for advice, share findings, or request corrections during work; set replyRequested when an answer is needed. Reply to received questions using team_send_message; reading does not answer them. The lead is responsible for staying aware of worker progress and helping unblock them. Use the provider's normal tool, reasoning, and progress events while working so the live conversation stays visible, and emit brief natural-language progress or commentary between meaningful steps. If a decision genuinely requires the user, emit the provider's native approval or question request and wait for the response; never invent an answer. When a structured final format is requested, keep the final assistant message exactly in that format, without prepended or appended commentary, so the scheduler can parse it.";
const asyncQuestionRequestId = (activity: { readonly kind: string; readonly payload: unknown }) => {
  if (
    activity.kind !== "user-input.requested" ||
    !Predicate.isObject(activity.payload) ||
    activity.payload.responseMode !== "message" ||
    typeof activity.payload.requestId !== "string"
  )
    return null;
  return activity.payload.requestId;
};
const watchedWorkerActivityKinds = new Set([
  "tool.started",
  "tool.completed",
  "task.started",
  "task.completed",
  "turn.plan.updated",
  "runtime.error",
  "runtime.warning",
  "tool.denied",
  "approval.requested",
  "user-input.requested",
]);
const safeError = () =>
  new TeamError({
    code: "unavailable",
    message: "Team execution could not reconcile with the provider. Its reservation is retained.",
  });
const isTeamError = Schema.is(TeamError);
const isPreviouslyRejected = Schema.is(OrchestrationCommandPreviouslyRejectedError);
const mapError = (error: unknown) => (isTeamError(error) ? error : safeError());
export const make = Effect.gen(function* () {
  const store = yield* TeamStore;
  const router = yield* TeamRouter;
  const engine = yield* OrchestrationEngineService;
  const projection = yield* ProjectionSnapshotQuery;
  const registry = yield* ProviderRegistry;
  const processes = yield* ProcessRunner;
  const git = yield* GitWorkflowService;
  const turns = yield* ProjectionTurnRepository;
  const lock = yield* Semaphore.make(1);
  const schedulerLock = yield* Semaphore.make(1);
  const now = DateTime.now.pipe(Effect.map(DateTime.formatIso));
  const appendWorkerLifecycle = Effect.fnUntraced(function* (input: {
    run: TeamRun;
    turn: TeamExecutionTurn;
    phase: "dispatched" | "result" | "correction" | "accepted";
    detail: string;
    tone?: "info" | "error";
  }) {
    if (input.turn.role !== "worker" || input.turn.taskId === null || !input.run.execution) return;
    const task = input.run.tasks.find((candidate) => candidate.id === input.turn.taskId);
    if (!task) return;
    const workerThreadId = input.turn.command.threadId;
    const agentName = teamAgentDisplayName(
      input.run.id,
      [
        input.run.execution.leadThreadId,
        ...input.run.execution.turns
          .filter((candidate) => candidate.role === "worker")
          .map((candidate) => candidate.command.threadId),
        workerThreadId,
      ],
      workerThreadId,
    );
    const createdAt = yield* now;
    const id = `team-lifecycle:${input.run.id}:${input.phase}:${input.turn.id}`;
    const summary =
      input.phase === "dispatched"
        ? `${agentName} started work`
        : input.phase === "result"
          ? `${agentName} reported a result`
          : input.phase === "correction"
            ? `${agentName} needs a correction`
            : `${agentName} accepted by the lead`;
    // Lifecycle records are observability. A missing lead thread must not turn
    // a successful provider turn into a paused team run.
    yield* engine
      .dispatch({
        type: "thread.activity.append",
        commandId: CommandId.make(id),
        threadId: input.run.execution.leadThreadId,
        activity: {
          id: EventId.make(id),
          tone: input.tone ?? "info",
          kind: `team.worker-${input.phase}`,
          summary,
          payload: {
            runId: input.run.id,
            taskId: task.id,
            threadId: workerThreadId,
            detail: input.detail,
          },
          turnId: null,
          createdAt,
        },
        createdAt,
      })
      .pipe(Effect.ignoreCause({ log: true }));
  });
  const checkProfile = Effect.fn("TeamRuntime.checkProfile")(function* (profile: TeamModelProfile) {
    if (profile.reviewRequired)
      return yield* new TeamError({
        code: "invalid",
        message: "This model profile needs task-group and effort review before dispatch.",
      });
    const providers = yield* registry.getProviders;
    yield* Effect.try({
      try: () => validatePool({ ...defaultTeamPolicy, profiles: [profile] }, providers),
      catch: mapError,
    });
    const provider = providers.find((p) => p.instanceId === profile.selection.instanceId);
    if (
      !provider ||
      !usableModel(provider, profile.selection.model) ||
      !provider.enabled ||
      provider.status !== "ready" ||
      provider.auth.status === "unauthenticated"
    )
      return yield* new TeamError({
        code: "unavailable",
        message: "Managed teams require a ready provider without an exhausted quota.",
      });
  });
  const reserve = Effect.fn("TeamRuntime.reserve")(function* (
    run: TeamRun,
    role: TeamExecutionTurn["role"],
    taskId: string | null,
    text: string,
    recipient?: ThreadId,
  ) {
    const execution = run.execution!;
    const task = run.tasks.find((t) => (recipient ? t.threadId === recipient : t.id === taskId));
    const profile =
      role === "worker" || (role === "consult" && recipient !== execution.leadThreadId)
        ? run.policy.profiles.find((p) => p.id === task?.profileId)!
        : run.lead;
    yield* checkProfile(profile);
    const threadId =
      recipient ??
      (role === "worker"
        ? (task?.threadId ?? ThreadId.make(`team-${run.id}-${NodeCrypto.randomUUID()}`))
        : execution.leadThreadId);
    if (
      execution.turns.some(
        (turn) => turn.command.threadId === threadId && turn.status !== "settled",
      )
    )
      return run;
    const existing = yield* projection
      .getThreadDetailById(threadId)
      .pipe(Effect.mapError(mapError));
    const pending = yield* turns
      .getPendingTurnStartByThreadId({ threadId })
      .pipe(Effect.mapError(mapError));
    if (
      Option.isSome(pending) ||
      (Option.isSome(existing) &&
        (existing.value.latestTurn?.state === "running" || openRequests(existing.value).size > 0))
    )
      return run;
    const createdAt = yield* now;
    const id = NodeCrypto.randomUUID();
    const agentName = teamAgentDisplayName(
      run.id,
      [
        execution.leadThreadId,
        ...execution.turns.filter((t) => t.role === "worker").map((t) => t.command.threadId),
        threadId,
      ],
      threadId,
    );
    const observedMessageSequence =
      role === "consult"
        ? run.messages?.find((message) => message.id === taskId)?.sourceSequence
        : undefined;
    const turn: TeamExecutionTurn = {
      id,
      ...(observedMessageSequence !== undefined ? { observedMessageSequence } : {}),
      estimatedAttemptUsd: profile.estimatedAttemptUsd,
      role,
      taskId,
      status: "reserved",
      result: null,
      succeeded: false,
      command: {
        type: "thread.turn.start",
        commandId: CommandId.make(`team-${id}`),
        threadId,
        message: {
          messageId: MessageId.make(`team-${id}`),
          role: "user",
          text,
          attachments: Option.isNone(existing) ? (run.attachments ?? []) : [],
        },
        modelSelection: profile.selection,
        runtimeMode: "full-access",
        interactionMode: "default",
        createdAt,
        ...(Option.isNone(existing)
          ? {
              bootstrap: {
                createThread: {
                  projectId: run.projectId,
                  title:
                    role === "worker"
                      ? `${agentName} · Worker: ${task!.objective.slice(0, 80)}`
                      : `${agentName} · Lead: ${run.objective.slice(0, 80)}`,
                  modelSelection: profile.selection,
                  runtimeMode: "full-access" as const,
                  interactionMode: "default" as const,
                  branch: null,
                  worktreePath: null,
                  createdAt,
                },
                prepareWorktree: {
                  projectCwd: execution.workspaceRoot,
                  baseBranch: execution.baseCommit,
                  branch: `team/${run.id}/${role === "worker" ? id : "lead"}`,
                  requireWorktree: true,
                },
                runSetupScript: false,
              },
            }
          : {}),
      },
    };
    return yield* store.reserveTurn(run.id, run.revision, turn);
  }, lock.withPermits(1));
  const reconcile = Effect.fn("TeamRuntime.reconcile")(function* (id: string) {
    let run = yield* store.get(id);
    if (!run.execution) return run;
    for (const original of run.execution.turns.filter((t) => t.status !== "settled")) {
      let turn = original;
      if (
        ["reserved", "dispatching"].includes(turn.status) &&
        !["paused", "cancelled", "failed"].includes(run.status)
      ) {
        const current = yield* projection
          .getThreadDetailById(turn.command.threadId)
          .pipe(Effect.mapError(mapError));
        const pending = yield* turns
          .getPendingTurnStartByThreadId({ threadId: turn.command.threadId })
          .pipe(Effect.mapError(mapError));
        if (Option.isSome(pending) && pending.value.messageId !== turn.command.message.messageId)
          continue;
        if (
          Option.isSome(current) &&
          (current.value.latestTurn?.state === "running" || openRequests(current.value).size > 0)
        ) {
          const latest = current.value.latestTurn;
          const receipt = latest
            ? yield* turns
                .getByTurnId({ threadId: turn.command.threadId, turnId: latest.turnId })
                .pipe(Effect.mapError(mapError))
            : Option.none();
          // An uncertain dispatch can replay its own receipt, but must not steer a user's turn.
          if (
            Option.isNone(receipt) ||
            receipt.value.pendingMessageId !== turn.command.message.messageId
          )
            continue;
        }
        if (turn.status === "reserved") {
          const selection = turn.command.modelSelection;
          const currentProviders = yield* registry.getProviders;
          if (
            !selection ||
            !currentProviders.some(
              (provider) =>
                provider.instanceId === selection.instanceId &&
                usableModel(provider, selection.model),
            )
          )
            return yield* pause(
              run,
              "The assigned provider is unavailable or its quota is exhausted. The reservation and agent identity are preserved.",
            );
        }
        const bootstrap = turn.command.bootstrap;
        if (bootstrap?.createThread && bootstrap.prepareWorktree) {
          const existing = yield* projection
            .getThreadDetailById(turn.command.threadId)
            .pipe(Effect.mapError(mapError));
          if (Option.isNone(existing)) {
            const setup = bootstrap.prepareWorktree;
            const refs = yield* git
              .listRefs({
                cwd: setup.projectCwd,
                query: setup.branch!,
                refKind: "local",
                refresh: true,
              })
              .pipe(Effect.mapError(mapError));
            const ref = refs.refs.find((r) => r.name === setup.branch);
            const worktree = ref?.worktreePath
              ? { path: ref.worktreePath, refName: ref.name }
              : (yield* git
                  .createWorktree({
                    cwd: setup.projectCwd,
                    refName: ref?.name ?? setup.baseBranch,
                    ...(ref ? {} : { newRefName: setup.branch! }),
                    baseRefName: setup.baseBranch,
                    path: null,
                  })
                  .pipe(Effect.mapError(mapError))).worktree;
            yield* engine
              .dispatch({
                type: "thread.create",
                commandId: CommandId.make(`team-create-${turn.command.threadId}`),
                threadId: turn.command.threadId,
                ...bootstrap.createThread,
                branch: worktree.refName,
                worktreePath: worktree.path,
              })
              .pipe(Effect.mapError(mapError));
          }
        }
        if (turn.status === "reserved") {
          run = yield* store.update(
            run.id,
            run.revision,
            (r) => ({
              ...r,
              execution: {
                ...r.execution!,
                turns: r.execution!.turns.map((t) =>
                  t.id === turn.id ? { ...t, status: "dispatching" } : t,
                ),
              },
            }),
            "turn-dispatching",
          );
          turn = { ...turn, status: "dispatching" };
        }
        // The identical persisted command is safe to replay at the engine receipt boundary.
        const rejection = yield* engine.dispatch(turn.command).pipe(
          Effect.as<string | null>(null),
          Effect.catch((error) =>
            isOrchestrationCommandRejection(error) || isPreviouslyRejected(error)
              ? Effect.succeed(error.message)
              : Effect.fail(mapError(error)),
          ),
        );
        if (rejection !== null)
          return yield* store.update(
            run.id,
            run.revision,
            (r) => ({
              ...r,
              status: "paused",
              tasks: r.tasks.map((t) =>
                turn.role === "worker" && t.id === turn.taskId
                  ? { ...t, status: "failed", result: rejection }
                  : t,
              ),
              execution: {
                ...r.execution!,
                notice:
                  "The provider command was rejected before execution. Inspect the lead or worker thread.",
                turns: r.execution!.turns.map((t) =>
                  t.id === turn.id
                    ? { ...t, status: "settled", succeeded: false, result: rejection }
                    : t,
                ),
              },
            }),
            "turn-rejected",
          );
        run = yield* store.update(
          run.id,
          run.revision,
          (r) => ({
            ...r,
            execution: {
              ...r.execution!,
              turns: r.execution!.turns.map((t) =>
                t.id === turn.id ? { ...t, status: "dispatched" } : t,
              ),
            },
          }),
          "turn-dispatched",
        );
        turn = { ...turn, status: "dispatched" };
        yield* appendWorkerLifecycle({
          run,
          turn,
          phase: "dispatched",
          detail: `Working on: ${run.tasks.find((task) => task.id === turn.taskId)?.objective ?? "assigned task"}`,
        });
      }
      const detail = yield* projection
        .getThreadDetailById(turn.command.threadId)
        .pipe(Effect.mapError(mapError));
      if (Option.isNone(detail)) continue;
      const thread = detail.value;
      if (openRequests(thread).size > 0) continue;
      // A user follow-up or an answer to an interactive request can create a
      // newer latestTurn on the same thread. Reconcile the durable row tied to
      // this scheduler message instead of assuming latestTurn is ours.
      const persistedTurns = yield* turns
        .listByThreadId({ threadId: thread.id })
        .pipe(Effect.mapError(mapError));
      const persistedTurn = persistedTurns.find(
        (candidate) => candidate.pendingMessageId === turn.command.message.messageId,
      );
      if (
        !persistedTurn ||
        persistedTurn.turnId === null ||
        persistedTurn.state === "running" ||
        persistedTurn.state === "pending"
      )
        continue;
      // A live manual follow-up on the same lead thread owns the provider
      // session for now. Wait for its normal completion event before sending
      // the next managed review/integration turn.
      if (
        thread.latestTurn &&
        thread.latestTurn.turnId !== persistedTurn.turnId &&
        thread.latestTurn.state === "running"
      )
        continue;
      let settledTurn = persistedTurn;
      let waitingForContinuation = false;
      const visitedTurnIds = new Set<string>();
      while (settledTurn.turnId !== null) {
        const settledTurnId = settledTurn.turnId;
        if (visitedTurnIds.has(settledTurnId))
          return yield* pause(
            run,
            "The question continuation is inconsistent. Inspect the agent conversation before resuming.",
          );
        visitedTurnIds.add(settledTurnId);
        const requestIds = new Set(
          thread.activities.flatMap((activity) => {
            const id = activity.turnId === settledTurnId ? asyncQuestionRequestId(activity) : null;
            return id === null ? [] : [id];
          }),
        );
        // T3's message-mode answer records its original request and starts a
        // normal turn with this exact message ID. Arbitrary follow-ups are not results.
        const resolution = thread.activities.findLast(
          (activity) =>
            activity.kind === "user-input.resolved" &&
            activity.turnId === settledTurnId &&
            Predicate.isObject(activity.payload) &&
            activity.payload.responseMode === "message" &&
            typeof activity.payload.requestId === "string" &&
            requestIds.has(activity.payload.requestId) &&
            activity.payload.answers !== undefined,
        );
        if (!resolution || !Predicate.isObject(resolution.payload)) break;
        const answerMessageId = `async-answer:${resolution.payload.requestId}`;
        const continuation = persistedTurns.find(
          (candidate) => candidate.pendingMessageId === answerMessageId,
        );
        if (
          !continuation &&
          thread.activities.some(
            (activity) =>
              activity.kind === "provider.turn.start.failed" &&
              Predicate.isObject(activity.payload) &&
              activity.payload.requestId === answerMessageId,
          )
        )
          return yield* pause(
            run,
            "The provider could not start the question answer turn. Inspect the agent conversation before resuming.",
          );
        if (
          !continuation ||
          continuation.turnId === null ||
          continuation.state === "running" ||
          continuation.state === "pending"
        ) {
          waitingForContinuation = true;
          break;
        }
        settledTurn = continuation;
      }
      if (waitingForContinuation) continue;
      // The projector closes a still-running turn when a newer one starts.
      // That closure is not evidence that its partial answer completed the task.
      const overtaken =
        settledTurn.completedAt !== null &&
        persistedTurns.some(
          (candidate) =>
            candidate.turnId !== settledTurn.turnId &&
            candidate.startedAt !== null &&
            candidate.requestedAt >= settledTurn.requestedAt &&
            candidate.startedAt >= (settledTurn.startedAt ?? settledTurn.requestedAt) &&
            candidate.startedAt <= settledTurn.completedAt!,
        );
      if (overtaken)
        return yield* pause(
          run,
          "A newer message interrupted the managed turn. Inspect the agent conversation before resuming orchestration.",
        );
      const answer = settledTurn.assistantMessageId
        ? thread.messages.find((m) => m.id === settledTurn.assistantMessageId)
        : undefined;
      const result = answer?.text ?? `Provider turn ended with ${settledTurn.state}.`;
      const succeeded = settledTurn.state === "completed" && !!answer && !answer.streaming;
      if (settledTurn.state === "completed" && !succeeded) {
        if (thread.latestTurn && thread.latestTurn.turnId !== settledTurn.turnId)
          return yield* pause(
            run,
            "The managed turn ended without a final response before a newer message. Inspect the agent conversation before resuming.",
          );
        continue;
      }
      const consultationMessage =
        turn.role === "consult"
          ? run.messages?.find((message) => message.id === turn.taskId)
          : undefined;
      const completedAt = settledTurn.completedAt ?? (yield* now);
      run = yield* store.update(
        run.id,
        run.revision,
        (r) => {
          const next =
            turn.role === "worker"
              ? receiveResult(
                  r,
                  turn.taskId!,
                  r.tasks.find((t) => t.id === turn.taskId)!.generation,
                  result,
                )
              : r;
          return {
            ...next,
            ...(consultationMessage
              ? {
                  messages: [
                    ...(next.messages ?? []).map((message) =>
                      message.id === consultationMessage.id &&
                      message.sourceSequence === turn.observedMessageSequence
                        ? { ...message, readAt: completedAt }
                        : message,
                    ),
                    ...(consultationMessage.replyRequested
                      ? [
                          {
                            id: `reply:${turn.id}`,
                            inReplyTo: consultationMessage.id,
                            fromThreadId: turn.command.threadId,
                            toThreadId: consultationMessage.fromThreadId,
                            text: succeeded
                              ? result.slice(0, 8000)
                              : `Consultation failed: ${result.slice(0, 7900)}`,
                            replyRequested: false,
                            createdAt: completedAt,
                            readAt: null,
                          },
                        ]
                      : []),
                  ],
                }
              : {}),
            execution: {
              ...next.execution!,
              turns: next.execution!.turns.map((t) =>
                t.id === turn.id
                  ? {
                      ...t,
                      status: "settled",
                      result,
                      succeeded,
                      ...(settledTurn.turnId ? { providerTurnId: settledTurn.turnId } : {}),
                      ...(answer ? { resultMessageId: answer.id } : {}),
                    }
                  : t,
              ),
            },
          };
        },
        "turn-settled",
      );
      if (turn.role === "consult") {
        const reply = run.messages?.find((message) => message.id === `reply:${turn.id}`);
        if (reply) {
          const id = `team-reply:${turn.id}`;
          yield* engine
            .dispatch({
              type: "thread.activity.append",
              commandId: CommandId.make(id),
              threadId: reply.toThreadId,
              activity: {
                id: EventId.make(id),
                kind: "team.message",
                tone: "info",
                summary: "Reply from teammate",
                payload: { threadId: reply.fromThreadId, detail: reply.text },
                turnId: null,
                createdAt: reply.createdAt,
              },
              createdAt: reply.createdAt,
            })
            .pipe(Effect.ignoreCause({ log: true }));
        }
      }
      yield* appendWorkerLifecycle({
        run,
        turn,
        phase: "result",
        tone: succeeded ? "info" : "error",
        detail: result,
      });
    }
    return run;
  }, lock.withPermits(1));
  const advance = Effect.fn("TeamRuntime.advance")(function* (id: string) {
    let run = yield* reconcile(id);
    const execution = run.execution;
    if (!execution || ["paused", "cancelled", "completed", "failed"].includes(run.status))
      return run;
    for (const message of run.messages ?? []) {
      if (
        message.readAt !== null ||
        run.execution!.turns.some(
          (turn) =>
            turn.role === "consult" && turn.taskId === message.id && turn.status !== "settled",
        )
      )
        continue;
      if (
        run.execution!.turns.filter((turn) => turn.status !== "settled").length >=
        run.policy.maxActive
      )
        break;
      const before = run.execution!.turns.length;
      run = yield* reserve(
        run,
        "consult",
        message.id,
        `${message.origin === "progress" ? "Worker progress changed. Actively inspect the current work and identify drift, failures, or opportunities to help. Send a concrete correction or advice with team_send_message when useful; do not send a generic acknowledgement to the worker." : "A teammate sent you a message while work is in progress."} Read team_read_messages for current progress and any other messages. This is a consultation, not acceptance of the task. Provide advice without modifying files; implementation belongs to the assigned worker or integration turn. ${message.replyRequested ? "Answer this request in your final natural-language message; it will be delivered to the sender automatically." : "Read and consider this update. No reply is required unless you have useful new information; use team_send_message if needed."} Never answer user permissions or approvals on their behalf. If you are the lead, help the worker within the existing acceptance contract. Sender: ${message.fromThreadId}. Message: ${message.text}\n\n${liveProgressGuidance}`,
        message.toThreadId,
      );
      if (run.execution!.turns.length > before) return run;
    }
    if (run.execution!.turns.some((turn) => turn.role === "consult" && turn.status !== "settled"))
      return run;
    if (execution.phase === "plan") {
      const plan = execution.turns.find((t) => t.role === "plan");
      if (!plan)
        return yield* reserve(
          run,
          "plan",
          null,
          `You are the fixed lead of a managed team. Never spawn native subagents. Inspect the repository but do not implement yet. Return ONLY JSON matching {acceptance:string[],tasks:[{id,objective,acceptance:string[],dependencies:string[],profileId,context}],rationale}. Choose the smallest useful team, with independent write scopes. Define 1-20 stable, observable acceptance criteria for the COMPLETE user objective, including constraints and integration behavior. Do not weaken criteria to fit results. Every task needs concrete verification and a bounded write scope. If required information is missing, report the blocker rather than inventing requirements. Zero tasks means the lead will implement alone. Available worker profiles: ${encode(run.policy.profiles.filter((p) => p.worker))}. Objective: ${run.objective}\n\n${liveProgressGuidance}`,
        );
      if (plan.status !== "settled") return run;
      if (!plan.succeeded)
        return yield* pause(run, "Lead planning failed. Inspect its thread before resuming.");
      let proposal = yield* Effect.try({
        try: () => parseProposal(PlanProposal, plan.result!),
        catch: () =>
          new TeamError({ code: "invalid", message: "Lead returned an invalid structured plan." }),
      });
      if (!proposal.acceptance?.length)
        return yield* pause(
          run,
          "Lead plan needs explicit acceptance criteria for the complete objective.",
        );
      // Validate the complete graph before spending classification calls or admitting work.
      yield* Effect.try({ try: () => acceptPlan(run, proposal), catch: mapError });
      if ((yield* store.getPolicy).revision === run.policy.revision) {
        const tasks = yield* Effect.forEach(
          proposal.tasks,
          (task) =>
            router
              .assess(
                {
                  draftId: `${run.id}-${task.id}`,
                  revision: 0,
                  policyRevision: run.policy.revision,
                  prompt: encode({
                    objective: task.objective,
                    acceptance: task.acceptance,
                    context: task.context,
                  }),
                  hasAttachments: (run.attachments?.length ?? 0) > 0,
                },
                "worker",
              )
              .pipe(
                Effect.flatMap((assessment) =>
                  assessment.profileId
                    ? Effect.succeed({ ...task, profileId: assessment.profileId })
                    : Effect.fail(
                        new TeamError({
                          code: "unavailable",
                          message: "No allowed worker profile satisfies the task.",
                        }),
                      ),
                ),
              ),
          { concurrency: 2 },
        );
        proposal = { ...proposal, tasks };
      }
      if (run.policy.maxActive === 1 && proposal.tasks.length > 0)
        return yield* pause(run, "The plan requires workers but the active-agent limit is one.");
      run = yield* store.update(
        run.id,
        run.revision,
        (r) => ({
          ...acceptPlan(r, proposal),
          execution: {
            ...r.execution!,
            acceptance: proposal.acceptance,
            phase: proposal.tasks.length ? "workers" : "integrate",
          },
        }),
        "plan-accepted",
      );
    }
    if (run.execution!.phase === "workers") {
      const review = run.tasks.find((t) => t.status === "review");
      if (review) {
        const workerTurn = run.execution!.turns.findLast(
          (t) => t.role === "worker" && t.taskId === review.id,
        )!;
        const reviewTurn = run.execution!.turns.findLast(
          (t) => t.role === "review" && t.taskId === workerTurn.id,
        );
        if (!reviewTurn) {
          const worker = yield* projection
            .getThreadDetailById(review.threadId!)
            .pipe(Effect.mapError(mapError));
          if (Option.isNone(worker) || !worker.value.worktreePath)
            return yield* pause(run, "Worker worktree is missing; acceptance is blocked.");
          return yield* reserve(
            run,
            "review",
            workerTurn.id,
            `Review worker output against every acceptance criterion. Do not spawn subagents or modify the worker worktree. Inspect files at ${worker.value.worktreePath}. Return ONLY JSON {action:"accept"|"correct"|"blocked",summary:string,checks:[{criterionIndex:number,criterion:string,command:string,args:string[]}]}. For accept, provide a reproducible non-destructive check for EVERY criterion. criterionIndex MUST be its zero-based index in the acceptance array; do not infer new criteria. Checks execute in the worker worktree without a shell. Use blocked only for a concrete external blocker requiring user intervention; first try to resolve it yourself or consult the worker with team_send_message. For correct, identify the unmet criterion, observed failure, and a materially different next action in summary. Never resend a previous correction unchanged. Worker contract and output: ${encode(review)}\n\n${liveProgressGuidance}`,
          );
        }
        if (reviewTurn.status !== "settled") return run;
        if (!reviewTurn.succeeded)
          return yield* pause(run, "Lead review failed; inspect its thread.");
        const proposal = yield* Effect.try({
          try: () => parseProposal(LeadReview, reviewTurn.result!),
          catch: () =>
            new TeamError({ code: "invalid", message: "Lead returned an invalid review." }),
        });
        if (proposal.action === "blocked") return yield* pause(run, proposal.summary);
        if (proposal.action === "accept" && !reviewCoverage(review.acceptance, proposal.checks)) {
          return yield* reserve(
            run,
            "review",
            workerTurn.id,
            `Your review could not be matched to the acceptance contract. This is a review protocol repair, NOT a worker failure. Return ONLY JSON {action:"accept"|"correct"|"blocked",summary:string,checks:[{criterionIndex:number,criterion:string,command:string,args:string[]}]}. Include checks covering EACH zero-based criterionIndex in ${encode(review.acceptance)}. Reuse your valid prior checks where appropriate. Prior review: ${reviewTurn.result}\n\n${liveProgressGuidance}`,
          );
        }
        const evidence =
          proposal.action === "accept"
            ? yield* verify(run, review.threadId!, proposal, review.acceptance)
            : [];
        if (
          proposal.action === "accept" &&
          evidence.every((e) => e.passed) &&
          review.acceptance.every((criterion) =>
            evidence.some((e) => e.criterion === criterion && e.passed),
          )
        ) {
          run = yield* store.update(
            run.id,
            run.revision,
            (r) => ({
              ...acceptTask(r, review.id, review.generation, evidence),
              decisions: [
                ...r.decisions,
                encode({
                  task: review.id,
                  generation: review.generation,
                  summary: proposal.summary,
                  evidence,
                }),
              ],
            }),
            "task-accepted",
          );
          yield* appendWorkerLifecycle({
            run,
            turn: workerTurn,
            phase: "accepted",
            detail: proposal.summary,
          });
        } else {
          const correction = `${proposal.summary}\n${encode(evidence.filter((e) => !e.passed))}`;
          yield* appendWorkerLifecycle({
            run,
            turn: workerTurn,
            phase: "correction",
            tone: "error",
            detail: correction,
          });
          if (
            review.recoveryHistory?.some(
              (entry) =>
                entry.correction.trim().replace(/\s+/g, " ").toLowerCase() ===
                correction.trim().replace(/\s+/g, " ").toLowerCase(),
            )
          )
            return yield* reserve(
              run,
              "review",
              workerTurn.id,
              `The worker has already received this correction. Inspect its current evidence, identify what is preventing acceptance, and choose a materially different action. Use team_send_message to ask the worker for clarification if needed. Do not repeat the same correction. Return the usual review JSON. Worker contract: ${encode(review)}. Prior review: ${reviewTurn.result}\n\n${liveProgressGuidance}`,
            );
          const latestPolicy = yield* store.getPolicy;
          const advice =
            latestPolicy.revision === run.policy.revision
              ? yield* router
                  .recover({
                    policyRevision: run.policy.revision,
                    currentProfileId: review.profileId,
                    objective: review.objective.slice(0, 4000),
                    evidence: encode({ workerResult: review.result, checks: evidence }).slice(
                      0,
                      8000,
                    ),
                    correction: correction.slice(0, 4000),
                    attemptsMade: review.attempts,
                    inFlight: false,
                  })
                  .pipe(Effect.orElseSucceed(() => null))
              : null;
          // Jev advises model recovery; the lead owns the acceptance review.
          // An uncertain diagnosis must not veto a correction the lead already
          // supplied. Keep that worker/model and let retryTask enforce limits
          // and reject repeated corrections or unchanged results.
          const continueLeadCorrection =
            proposal.action === "correct" &&
            advice !== null &&
            ["lead_review", "repair_environment", "supply_context"].includes(advice.action) &&
            advice.profileId === review.profileId;
          if (
            advice &&
            !continueLeadCorrection &&
            !["correct", "increase_effort", "new_worker"].includes(advice.action)
          )
            return yield* pause(run, `${advice.reason} Lead correction: ${proposal.summary}`);
          const profileId = continueLeadCorrection
            ? review.profileId
            : (advice?.profileId ?? review.profileId);
          run = yield* store.update(
            run.id,
            run.revision,
            (r) =>
              retryTask(
                r,
                review.id,
                profileId,
                correction,
                advice?.action === "new_worker" ? "handoff" : "continue",
              ),
            "worker-correction",
          );
        }
      }
      if (run.tasks.every((t) => t.status === "accepted"))
        run = yield* store.update(
          run.id,
          run.revision,
          (r) => ({ ...r, status: "review", execution: { ...r.execution!, phase: "integrate" } }),
          "integration-ready",
        );
      for (const task of run.tasks.filter((t) => t.status === "pending")) {
        if (
          task.dependencies.some(
            (dep) => !run.tasks.some((t) => t.id === dep && t.status === "accepted"),
          )
        )
          continue;
        const live = run.execution!.turns.filter((t) => t.status !== "settled").length;
        if (live >= run.policy.maxActive - 1) break;
        run = yield* reserve(
          run,
          "worker",
          task.id,
          `You are a managed worker. Never spawn native subagents. Follow the persisted contract below, which remains authoritative after compaction. Work only in your assigned isolated worktree. Inspect accepted dependency results and integrate their commits if needed. Run relevant checks and report their results and changed files. Commit your own changes with an English message; do not push. Report the commit ID, evidence for each criterion, what changed since the previous attempt, and any unresolved limitations. If blocked, explain the missing input or dependency; do not repeat an unsuccessful action. ${liveProgressGuidance}\n\nContract:\n${contextPack(run, task)}`,
        );
      }
    }
    if (
      run.execution!.phase === "integrate" &&
      !run.execution!.turns.some((t) => t.role === "integrate")
    ) {
      const artifacts = yield* Effect.forEach(run.tasks, (task) =>
        projection.getThreadDetailById(task.threadId!).pipe(
          Effect.map((detail) => ({
            task: task.id,
            result: task.result,
            worktree: Option.isSome(detail) ? detail.value.worktreePath : null,
          })),
          Effect.mapError(mapError),
        ),
      );
      run = yield* reserve(
        run,
        "integrate",
        null,
        `Finish and verify the combined objective in your isolated lead worktree. Never spawn native subagents. Integrate accepted worker commits, resolve conflicts, and run relevant combined checks. If no workers were needed, implement directly. Preserve the original checkout; do not push. Return ONLY JSON {action:"accept"|"correct"|"blocked",summary:string,checks:[{criterionIndex:number,criterion:string,command:string,args:string[]}]}. Verify EVERY persisted run acceptance criterion using its zero-based criterionIndex, without changing or dropping criteria. Provide meaningful non-destructive combined verification commands; commands run without a shell in your worktree. Objective: ${run.objective}. Run acceptance: ${encode(run.execution!.acceptance ?? [])}. Accepted worker artifacts: ${encode(artifacts)}\n\n${liveProgressGuidance}`,
      );
    }
    const final = run.execution!.turns.findLast((t) => t.role === "integrate");
    if (final?.status === "settled") {
      if (!final.succeeded)
        return yield* pause(run, "Lead integration failed; its worktree is preserved.");
      if ((run.messages ?? []).some((message) => message.readAt === null)) return run;
      const proposal = yield* Effect.try({
        try: () => parseProposal(LeadReview, final.result!),
        catch: () =>
          new TeamError({
            code: "invalid",
            message: "Lead returned invalid integration evidence.",
          }),
      });
      if (proposal.action === "blocked") return yield* pause(run, proposal.summary);
      const criteria = run.execution!.acceptance;
      if (!criteria?.length)
        return yield* pause(
          run,
          "This older run has no complete acceptance contract. Start a new team with explicit criteria.",
        );
      const covered = proposal.action === "accept" && reviewCoverage(criteria, proposal.checks);
      const evidence = covered
        ? yield* verify(run, run.execution!.leadThreadId, proposal, criteria)
        : [];
      if (!covered || evidence.some((e) => !e.passed)) {
        const correction = encode({
          summary: proposal.summary,
          missingCriteria: criteria.filter(
            (criterion, index) =>
              !proposal.checks.some(
                (check) =>
                  check.criterionIndex === index ||
                  (check.criterionIndex === undefined && check.criterion === criterion),
              ),
          ),
          evidence,
        });
        run = yield* store.update(
          run.id,
          run.revision,
          (r) => ({
            ...r,
            decisions: [...r.decisions, correction],
          }),
          "integration-correction",
        );
        return yield* reserve(
          run,
          "integrate",
          null,
          `Correct the combined result in your existing lead worktree. Do not delegate or change acceptance criteria. Do not repeat a failed action unchanged. Return ONLY JSON {action:"accept"|"correct"|"blocked",summary:string,checks:[{criterionIndex:number,criterion:string,command:string,args:string[]}]}. Verify EVERY criterion with a meaningful non-destructive check. If user input or permission is required, use the native question/approval flow; return blocked only for a concrete external blocker you cannot resolve, explaining the missing input. Objective: ${run.objective}. Persisted acceptance: ${encode(criteria)}. Previous result and independently executed evidence: ${correction}\n\n${liveProgressGuidance}`,
        );
      }
      return yield* store.update(
        run.id,
        run.revision,
        (r) => ({
          ...r,
          status: "completed",
          execution: { ...r.execution!, phase: "done", notice: proposal.summary },
          decisions: [...r.decisions, encode({ summary: proposal.summary, evidence })],
        }),
        "run-completed",
      );
    }
    return run;
  });
  const verify = Effect.fn("TeamRuntime.verify")(function* (
    run: TeamRun,
    threadId: ThreadId,
    proposal: LeadReview,
    criteria?: ReadonlyArray<string>,
  ) {
    const detail = yield* projection.getThreadDetailById(threadId).pipe(Effect.mapError(mapError));
    if (
      Option.isNone(detail) ||
      !detail.value.worktreePath ||
      detail.value.worktreePath === run.execution!.workspaceRoot
    )
      return yield* new TeamError({
        code: "invalid",
        message: "Verification requires the assigned isolated worktree.",
      });
    const cwd = detail.value.worktreePath;
    return yield* Effect.forEach(proposal.checks, (check) =>
      store.get(run.id).pipe(
        Effect.flatMap((current) => {
          if (["paused", "cancelled", "failed"].includes(current.status))
            return Effect.fail(
              new TeamError({ code: "conflict", message: "Verification stopped by team control." }),
            );
          return processes
            .run({
              command: check.command,
              args: check.args,
              cwd,
              timeout: "120 seconds",
              maxOutputBytes: 16000,
              outputMode: "truncate",
            })
            .pipe(
              Effect.map((output) => ({
                criterion:
                  (check.criterionIndex === undefined
                    ? undefined
                    : criteria?.[check.criterionIndex]) ?? check.criterion,
                passed: output.code === 0 && !output.timedOut,
                artifact: encode({
                  command: check.command,
                  args: check.args,
                  code: output.code,
                  stdout: output.stdout,
                  stderr: output.stderr,
                  truncated: output.stdoutTruncated || output.stderrTruncated,
                }),
              })),
              Effect.catch(() =>
                Effect.succeed({
                  criterion:
                    (check.criterionIndex === undefined
                      ? undefined
                      : criteria?.[check.criterionIndex]) ?? check.criterion,
                  passed: false,
                  artifact: "Verification command failed or timed out.",
                }),
              ),
            );
        }),
      ),
    );
  });
  const pause = (run: TeamRun, notice: string) =>
    store.update(
      run.id,
      run.revision,
      (r) =>
        ["cancelled", "completed", "failed"].includes(r.status)
          ? r
          : { ...r, status: "paused", execution: { ...r.execution!, notice } },
      "run-paused",
    );
  const start = Effect.fn("TeamRuntime.start")(function* (input: TeamStart) {
    const settings = yield* router.settings;
    const attachments = input.attachments ?? [];
    if (!settings.jevConfigured || settings.policy.mode === "off")
      return yield* new TeamError({
        code: "invalid",
        message: "Enable Jev routing to start a managed team.",
      });
    if (input.draft.hasAttachments !== attachments.length > 0)
      return yield* new TeamError({
        code: "conflict",
        message: "The attachment metadata changed. Refresh the orchestration preview.",
      });
    const assessment = yield* router.assess(input.draft);
    if (assessment.fingerprint !== input.fingerprint || !assessment.profileId)
      return yield* new TeamError({
        code: "conflict",
        message: "The objective or routing policy changed. Refresh the preview.",
      });
    const policy = yield* store.getPolicy;
    if (policy.revision !== assessment.policyRevision)
      return yield* new TeamError({ code: "conflict", message: "Routing policy changed." });
    const lead = policy.profiles.find((p) => p.id === assessment.profileId)!;
    yield* checkProfile(lead);
    const project = yield* projection
      .getProjectShellById(input.projectId)
      .pipe(Effect.mapError(mapError));
    if (Option.isNone(project))
      return yield* new TeamError({ code: "not-found", message: "Project not found." });
    const workspaceRoot = project.value.workspaceRoot;
    const git = yield* processes
      .run({
        command: "git",
        args: ["rev-parse", "--verify", "HEAD^{commit}"],
        cwd: workspaceRoot,
        timeout: "10 seconds",
        maxOutputBytes: 1024,
      })
      .pipe(Effect.mapError(mapError));
    if (git.code !== 0 || !/^[a-f0-9]{40,64}$/.test(git.stdout.trim()))
      return yield* new TeamError({
        code: "invalid",
        message: "Managed teams require a Git repository with an initial commit.",
      });
    const id = NodeCrypto.randomUUID();
    const createdAt = yield* now;
    const run = yield* store.create({
      id,
      commandId: input.commandId,
      projectId: input.projectId,
      revision: 0,
      objective: input.draft.prompt.trim(),
      policy,
      lead,
      status: "planning",
      tasks: [],
      decisions: [],
      createdAt,
      updatedAt: createdAt,
      attachments,
      execution: {
        workspaceRoot,
        baseCommit: git.stdout.trim(),
        leadThreadId: ThreadId.make(`team-${id}-lead`),
        turns: [],
        phase: "plan",
        notice: null,
      },
    });
    yield* advance(run.id);
    return yield* reconcile(run.id);
  }, schedulerLock.withPermits(1));
  const control = Effect.fn("TeamRuntime.control")(function* (input: TeamControl) {
    const run = yield* store.get(input.id);
    if (
      run.revision !== input.revision ||
      !run.execution ||
      ["completed", "cancelled", "failed"].includes(run.status)
    )
      return yield* new TeamError({
        code: "conflict",
        message: "Run changed or is already terminal.",
      });
    const status =
      input.action === "cancel"
        ? "cancelled"
        : input.action === "pause"
          ? "paused"
          : run.execution.phase === "plan"
            ? "planning"
            : "running";
    const next = yield* store.update(
      run.id,
      run.revision,
      (r) => ({
        ...r,
        status,
        execution: {
          ...r.execution!,
          notice: input.action === "resume" ? null : r.execution!.notice,
          phase: input.action === "cancel" ? "done" : r.execution!.phase,
          turns: r.execution!.turns.map((t) =>
            input.action === "cancel" && t.status === "reserved"
              ? { ...t, status: "settled", result: "Cancelled before dispatch", succeeded: false }
              : t,
          ),
        },
      }),
      `run-${input.action}`,
    );
    if (input.action === "cancel")
      for (const turn of next.execution!.turns.filter((t) =>
        ["dispatching", "dispatched"].includes(t.status),
      )) {
        yield* engine
          .dispatch({
            type: "thread.turn.interrupt",
            commandId: CommandId.make(`team-cancel-${turn.id}`),
            threadId: turn.command.threadId,
            createdAt: yield* now,
          })
          .pipe(Effect.mapError(mapError));
      }
    return next;
  }, lock.withPermits(1));
  const tick = Effect.fn("TeamRuntime.tick")(function* () {
    for (const run of yield* store.active)
      yield* advance(run.id)
        .pipe(Effect.flatMap(() => reconcile(run.id)))
        .pipe(
          Effect.catch((error) =>
            error.code === "conflict"
              ? Effect.void
              : store.get(run.id).pipe(
                  Effect.flatMap((current) => pause(current, error.message)),
                  Effect.ignoreCause({ log: true }),
                ),
          ),
        );
  }, schedulerLock.withPermits(1));
  const observeWorkerEvent = Effect.fnUntraced(function* (event: OrchestrationEvent) {
    let threadId: ThreadId;
    let detail: string;
    if (
      event.type === "thread.message-sent" &&
      event.payload.role === "assistant" &&
      !event.payload.streaming
    ) {
      threadId = event.payload.threadId;
      detail = event.payload.text.slice(-4000);
    } else if (
      event.type === "thread.activity-appended" &&
      watchedWorkerActivityKinds.has(event.payload.activity.kind)
    ) {
      threadId = event.payload.threadId;
      const activity = event.payload.activity;
      const payload = encode(activity.payload);
      // Observing the mailbox tools would generate supervision of supervision.
      if (
        /team_(?:read_messages|send_message)|Read team messages|Message teammate/i.test(
          `${activity.summary} ${payload}`,
        )
      )
        return;
      detail = `${activity.kind}: ${activity.summary}\n${payload.slice(0, 3000)}`;
    } else return;
    if (!detail.trim()) return;
    const run = yield* store.findByThread(threadId);
    if (
      !run?.execution ||
      !["running", "review"].includes(run.status) ||
      !run.tasks.some((task) => task.threadId === threadId && task.status === "running")
    )
      return;
    const latest = run.messages?.findLast(
      (message) => message.origin === "progress" && message.fromThreadId === threadId,
    );
    if ((latest?.sourceSequence ?? -1) >= event.sequence) return;
    // One unread observation per worker accumulates a burst while the lead is busy.
    const pending = latest?.readAt === null ? latest : undefined;
    const message: TeamPeerMessage = {
      id: pending?.id ?? `watch:${run.id}:${event.sequence}`,
      fromThreadId: threadId,
      toThreadId: run.execution.leadThreadId,
      text: pending ? `${pending.text}\n\n${detail}`.slice(-7800) : detail,
      replyRequested: false,
      origin: "progress",
      sourceSequence: event.sequence,
      createdAt: pending?.createdAt ?? event.occurredAt,
      readAt: null,
    };
    yield* store.update(
      run.id,
      run.revision,
      (current) => ({
        ...current,
        messages: pending
          ? current.messages?.map((entry) => (entry.id === pending.id ? message : entry))
          : [...(current.messages ?? []), message],
      }),
      "worker-progress-observed",
    );
  }, lock.withPermits(1));
  const peerRun = Effect.fnUntraced(function* (threadId: ThreadId) {
    const run = yield* store.findByThread(threadId);
    if (
      !run?.execution ||
      (threadId !== run.execution.leadThreadId &&
        !run.tasks.some((task) => task.threadId === threadId))
    )
      return yield* new TeamError({
        code: "not-found",
        message: "This provider thread is not a current team member.",
      });
    return run;
  });
  const sendMessage = Effect.fnUntraced(function* (
    fromThreadId: ThreadId,
    input: {
      id: string;
      toThreadId: ThreadId;
      text: string;
      replyRequested: boolean;
      inReplyTo?: string | undefined;
    },
  ) {
    const run = yield* peerRun(fromThreadId);
    if (["completed", "cancelled", "failed", "paused"].includes(run.status))
      return yield* new TeamError({
        code: "conflict",
        message: "Resume an active team before sending agent messages.",
      });
    if (
      input.toThreadId === fromThreadId ||
      (input.toThreadId !== run.execution!.leadThreadId &&
        !run.tasks.some((task) => task.threadId === input.toThreadId))
    )
      return yield* new TeamError({
        code: "invalid",
        message: "Recipient must be another current member of the same team.",
      });
    if (
      input.inReplyTo &&
      !run.messages?.some(
        (message) =>
          message.id === input.inReplyTo &&
          message.fromThreadId === input.toThreadId &&
          message.toThreadId === fromThreadId,
      )
    )
      return yield* new TeamError({
        code: "invalid",
        message: "Reply must refer to a message received from this teammate.",
      });
    const existing = run.messages?.find((message) => message.id === input.id);
    if (
      existing &&
      (existing.fromThreadId !== fromThreadId ||
        existing.toThreadId !== input.toThreadId ||
        existing.text !== input.text ||
        existing.replyRequested !== input.replyRequested ||
        existing.inReplyTo !== input.inReplyTo)
    )
      return yield* new TeamError({
        code: "conflict",
        message: "Message ID already belongs to different content.",
      });
    const message: TeamPeerMessage = existing ?? {
      ...input,
      fromThreadId,
      createdAt: yield* now,
      readAt: null,
    };
    if (!existing)
      yield* store.update(
        run.id,
        run.revision,
        (current) => ({ ...current, messages: [...(current.messages ?? []), message] }),
        "peer-message",
      );
    // Native activity events both expose the message and wake the scheduler.
    for (const threadId of [fromThreadId, input.toThreadId]) {
      const id = `team-message:${run.id}:${input.id}:${threadId}`;
      yield* engine
        .dispatch({
          type: "thread.activity.append",
          commandId: CommandId.make(id),
          threadId,
          activity: {
            id: EventId.make(id),
            kind: "team.message",
            tone: "info",
            summary:
              threadId === fromThreadId ? "Sent message to teammate" : "Message from teammate",
            payload: {
              threadId: threadId === fromThreadId ? input.toThreadId : fromThreadId,
              detail: input.text,
              replyRequested: input.replyRequested,
            },
            turnId: null,
            createdAt: message.createdAt,
          },
          createdAt: message.createdAt,
        })
        .pipe(Effect.mapError(mapError));
    }
    return message;
  }, lock.withPermits(1));
  const readMessages = Effect.fnUntraced(function* (threadId: ThreadId, includeRead = false) {
    const run = yield* peerRun(threadId);
    const inbox = (run.messages ?? []).filter((message) => message.toThreadId === threadId);
    const messages = includeRead
      ? inbox.slice(-40)
      : inbox.filter((message) => message.readAt === null).slice(0, 40);
    const readAt = yield* now;
    const members = yield* Effect.forEach(
      [
        run.execution!.leadThreadId,
        ...run.tasks.flatMap((task) => (task.threadId ? [task.threadId] : [])),
      ],
      (id) =>
        projection.getThreadDetailById(id).pipe(
          Effect.map((detail) => ({
            threadId: id,
            role: id === run.execution!.leadThreadId ? ("lead" as const) : ("worker" as const),
            state: Option.isSome(detail) ? (detail.value.latestTurn?.state ?? "idle") : "idle",
            activity: Option.isSome(detail)
              ? (detail.value.activities.at(-1)?.summary.slice(0, 1000) ?? "")
              : "",
            needsUserInput: Option.isSome(detail) && openRequests(detail.value).size > 0,
            summary: Option.isSome(detail)
              ? (detail.value.messages
                  .findLast((message) => message.role === "assistant")
                  ?.text.slice(-1500) ?? "")
              : "",
          })),
          Effect.mapError(mapError),
        ),
    );
    if (messages.some((message) => message.readAt === null))
      yield* store.update(
        run.id,
        run.revision,
        (current) => ({
          ...current,
          messages: current.messages?.map((message) =>
            messages.some((entry) => entry.id === message.id) ? { ...message, readAt } : message,
          ),
        }),
        "peer-messages-read",
      );
    return {
      runId: run.id,
      status: run.status,
      leadThreadId: run.execution!.leadThreadId,
      members,
      messages,
    };
  }, lock.withPermits(1));
  return {
    observeWorkerEvent,
    sendMessage,
    readMessages,
    start,
    control,
    tick,
    list: store.list,
    get: store.get,
    forThread: Effect.fn(function* (threadId: ThreadId) {
      const run = yield* store.findByThread(threadId);
      const view = teamThreadView(run);
      if (!view) return null;
      // The canonical receipts cover both old runs and responses still streaming.
      // One lead-thread query also keeps paged chat independent of loaded user messages.
      const receipts = yield* turns
        .listByThreadId({ threadId: view.leadThreadId })
        .pipe(Effect.mapError(mapError));
      const byMessage = new Map(receipts.map((receipt) => [receipt.pendingMessageId, receipt]));
      return {
        ...view,
        turns: view.turns.map((turn, index) => {
          if (!isTeamProtocolRole(turn.role)) return turn;
          const command = run?.execution?.turns[index]?.command;
          const receipt = command ? byMessage.get(command.message.messageId) : undefined;
          return {
            ...turn,
            ...(!turn.providerTurnId && receipt?.turnId ? { providerTurnId: receipt.turnId } : {}),
            ...(!turn.resultMessageId && receipt?.assistantMessageId && receipt.completedAt
              ? { resultMessageId: receipt.assistantMessageId }
              : {}),
          };
        }),
      };
    }),
  };
});
export class TeamRuntime extends Context.Service<TeamRuntime, Effect.Success<typeof make>>()(
  "t3/team/TeamRuntime",
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
    yield* forkParked(
      Effect.andThen(
        runtime.tick().pipe(Effect.ignoreCause({ log: true })),
        Stream.runForEach(
          events.pipe(
            Stream.filter(
              (event) =>
                event.aggregateId.startsWith("team-") &&
                (event.type === "thread.session-set" ||
                  event.type === "thread.turn-diff-completed" ||
                  (event.type === "thread.message-sent" && !event.payload.streaming) ||
                  (event.type === "thread.activity-appended" &&
                    (watchedWorkerActivityKinds.has(event.payload.activity.kind) ||
                      [
                        "team.message",
                        "approval.resolved",
                        "user-input.resolved",
                        "user-input.answer-submitted",
                        "provider.approval.respond.failed",
                        "provider.user-input.respond.failed",
                        "provider.turn.start.failed",
                      ].includes(event.payload.activity.kind)))),
            ),
          ),
          (event) =>
            runtime
              .observeWorkerEvent(event)
              .pipe(Effect.andThen(runtime.tick()), Effect.ignoreCause({ log: true })),
        ),
      ).pipe(
        Effect.catchCause(() =>
          Effect.logError(
            "Team reconciliation stopped; restart the server to reconcile durable reservations.",
          ),
        ),
      ),
    );
  }),
);

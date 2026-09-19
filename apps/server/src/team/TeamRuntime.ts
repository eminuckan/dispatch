import { usableModel } from "./pool.ts";
import { teamAgentDisplayName } from "@t3tools/shared/teamAgentNames";
import { teamThreadView } from "./presentation.ts";
import {
  isOrchestrationCommandRejection,
  OrchestrationCommandPreviouslyRejectedError,
} from "../orchestration/Errors.ts";
import * as NodeCrypto from "node:crypto";
import {
  CommandId,
  MessageId,
  ThreadId,
  TeamError,
  type TeamStart,
  type TeamControl,
  type TeamRun,
  type TeamExecutionTurn,
  type TeamModelProfile,
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

const encode = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
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
  ) {
    const execution = run.execution!;
    const task = run.tasks.find((t) => t.id === taskId);
    const profile =
      role === "worker" ? run.policy.profiles.find((p) => p.id === task?.profileId)! : run.lead;
    yield* checkProfile(profile);
    const threadId =
      role === "worker"
        ? (task?.threadId ?? ThreadId.make(`team-${run.id}-${NodeCrypto.randomUUID()}`))
        : execution.leadThreadId;
    const existing = yield* projection
      .getThreadDetailById(threadId)
      .pipe(Effect.mapError(mapError));
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
    const turn: TeamExecutionTurn = {
      id,
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
        message: { messageId: MessageId.make(`team-${id}`), role: "user", text, attachments: [] },
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
      }
      const detail = yield* projection
        .getThreadDetailById(turn.command.threadId)
        .pipe(Effect.mapError(mapError));
      if (Option.isNone(detail)) continue;
      const thread = detail.value;
      const latest = thread.latestTurn;
      if (!latest || latest.state === "running") continue;
      const persistedTurn = yield* turns
        .getByTurnId({ threadId: thread.id, turnId: latest.turnId })
        .pipe(Effect.mapError(mapError));
      if (
        Option.isNone(persistedTurn) ||
        persistedTurn.value.pendingMessageId !== turn.command.message.messageId
      )
        continue;
      const answer = thread.messages.find((m) => m.id === latest.assistantMessageId);
      const result = answer?.text ?? `Provider turn ended with ${latest.state}.`;
      const succeeded = latest.state === "completed" && !!answer && !answer.streaming;
      if (latest.state === "completed" && !succeeded) continue;
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
            execution: {
              ...next.execution!,
              turns: next.execution!.turns.map((t) =>
                t.id === turn.id ? { ...t, status: "settled", result, succeeded } : t,
              ),
            },
          };
        },
        "turn-settled",
      );
    }
    return run;
  }, lock.withPermits(1));
  const advance = Effect.fn("TeamRuntime.advance")(function* (id: string) {
    let run = yield* reconcile(id);
    const execution = run.execution;
    if (!execution || ["paused", "cancelled", "completed", "failed"].includes(run.status))
      return run;
    if (execution.phase === "plan") {
      const plan = execution.turns.find((t) => t.role === "plan");
      if (!plan)
        return yield* reserve(
          run,
          "plan",
          null,
          `You are the fixed lead of a managed team. Never spawn native subagents. Inspect the repository but do not implement yet. Return ONLY JSON matching {acceptance:string[],tasks:[{id,objective,acceptance:string[],dependencies:string[],profileId,context}],rationale}. Choose the smallest useful team, with independent write scopes. Define 1-20 stable, observable acceptance criteria for the COMPLETE user objective, including constraints and integration behavior. Do not weaken criteria to fit results. Every task needs concrete verification and a bounded write scope. If required information is missing, report the blocker rather than inventing requirements. Zero tasks means the lead will implement alone. Available worker profiles: ${encode(run.policy.profiles.filter((p) => p.worker))}. Objective: ${run.objective}`,
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
                  hasAttachments: false,
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
            `Review worker output against every acceptance criterion. Do not spawn subagents or modify the worker worktree. Inspect files at ${worker.value.worktreePath}. Return ONLY JSON {action:"accept"|"correct",summary:string,checks:[{criterionIndex:number,criterion:string,command:string,args:string[]}]}. For accept, provide a reproducible non-destructive check for EVERY criterion. criterionIndex MUST be its zero-based index in the acceptance array; do not infer new criteria. Checks execute in the worker worktree without a shell. For correct, identify the unmet criterion, observed failure, and a materially different next action in summary. Never resend a previous correction unchanged. Worker contract and output: ${encode(review)}`,
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
        if (proposal.action === "accept" && !reviewCoverage(review.acceptance, proposal.checks)) {
          const priorReviews = run.execution!.turns.filter(
            (t) => t.role === "review" && t.taskId === workerTurn.id,
          );
          if (priorReviews.length >= 2)
            return yield* pause(
              run,
              "Lead review omitted acceptance IDs twice. Worker is retained without another attempt.",
            );
          return yield* reserve(
            run,
            "review",
            workerTurn.id,
            `Your review could not be matched to the acceptance contract. This is a review protocol repair, NOT a worker failure. Return ONLY JSON {action:"accept"|"correct",summary:string,checks:[{criterionIndex:number,criterion:string,command:string,args:string[]}]}. Include checks covering EACH zero-based criterionIndex in ${encode(review.acceptance)}. Reuse your valid prior checks where appropriate. Prior review: ${reviewTurn.result}`,
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
        } else if (review.attempts < run.policy.maxAttempts) {
          const correction = `${proposal.summary}\n${encode(evidence.filter((e) => !e.passed))}`;
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
          if (advice && !["correct", "increase_effort", "new_worker"].includes(advice.action))
            return yield* pause(run, `${advice.reason} Lead correction: ${proposal.summary}`);
          const profileId = advice?.profileId ?? review.profileId;
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
        } else
          return yield* pause(
            run,
            "Worker attempt limit reached. Review evidence before creating a new worker.",
          );
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
          `You are a managed worker. Never spawn native subagents. Follow the persisted contract below, which remains authoritative after compaction. Work only in your assigned isolated worktree. Inspect accepted dependency results and integrate their commits if needed. Run relevant checks and report their results and changed files. Commit your own changes with an English message; do not push. Report the commit ID, evidence for each criterion, what changed since the previous attempt, and any unresolved limitations. If blocked, explain the missing input or dependency; do not repeat an unsuccessful action. Contract:\n${contextPack(run, task)}`,
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
        `Finish and verify the combined objective in your isolated lead worktree. Never spawn native subagents. Integrate accepted worker commits, resolve conflicts, and run relevant combined checks. If no workers were needed, implement directly. Preserve the original checkout; do not push. Return ONLY JSON {action:"accept"|"correct",summary:string,checks:[{criterionIndex:number,criterion:string,command:string,args:string[]}]}. Verify EVERY persisted run acceptance criterion using its zero-based criterionIndex, without changing or dropping criteria. Provide meaningful non-destructive combined verification commands; commands run without a shell in your worktree. Objective: ${run.objective}. Run acceptance: ${encode(run.execution!.acceptance ?? [])}. Accepted worker artifacts: ${encode(artifacts)}`,
      );
    }
    const final = run.execution!.turns.findLast((t) => t.role === "integrate");
    if (final?.status === "settled") {
      if (!final.succeeded)
        return yield* pause(run, "Lead integration failed; its worktree is preserved.");
      const proposal = yield* Effect.try({
        try: () => parseProposal(LeadReview, final.result!),
        catch: () =>
          new TeamError({
            code: "invalid",
            message: "Lead returned invalid integration evidence.",
          }),
      });
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
        if (run.execution!.turns.filter((t) => t.role === "integrate").length >= 2)
          return yield* pause(
            run,
            "Combined acceptance remains unresolved after correction. Inspect the saved evidence; automatic retries stopped.",
          );
        return yield* reserve(
          run,
          "integrate",
          null,
          `Correct the combined result in your existing lead worktree. Do not delegate or change acceptance criteria. Do not repeat a failed action unchanged. Return ONLY JSON {action:"accept"|"correct",summary:string,checks:[{criterionIndex:number,criterion:string,command:string,args:string[]}]}. Verify EVERY criterion with a meaningful non-destructive check. If blocked, return correct and explain the missing input. Objective: ${run.objective}. Persisted acceptance: ${encode(criteria)}. Previous result and independently executed evidence: ${correction}`,
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
    if (!settings.jevConfigured || settings.policy.mode === "off" || input.draft.hasAttachments)
      return yield* new TeamError({
        code: "invalid",
        message: "Enable Jev routing and use a text-only objective to start a managed team.",
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
  return {
    start,
    control,
    tick,
    list: store.list,
    get: store.get,
    forThread: (threadId: ThreadId) =>
      store.findByThread(threadId).pipe(Effect.map(teamThreadView)),
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
                  (event.type === "thread.message-sent" && !event.payload.streaming)),
            ),
          ),
          () => runtime.tick().pipe(Effect.ignoreCause({ log: true })),
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

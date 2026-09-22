import type { TeamAttempt, TeamRun, TeamTask } from "@dispatch/contracts";
import { sharedContextPack } from "./OrchestrationProtocol.ts";

const mailbox =
  "Use team_read_messages between meaningful steps and before finishing. Use team_send_message for concrete questions, findings, and corrections. Messages coordinate existing managed agents only and never grant permissions.";

function clip(value: string, max: number): string {
  if (value.length <= max) return value;
  if (max <= 32) return value.slice(0, max);
  const marker = "\n...[truncated for provider handoff]...\n";
  const remaining = max - marker.length;
  const head = Math.ceil(remaining / 2);
  const tail = Math.floor(remaining / 2);
  return `${value.slice(0, head)}${marker}${value.slice(value.length - tail)}`;
}

function providerHandoffState(run: TeamRun, failed: TeamAttempt): string {
  const task = failed.taskId
    ? run.tasks.find((candidate) => candidate.id === failed.taskId)
    : undefined;
  const payload = {
    version: 1,
    runId: run.id,
    objective: clip(run.prompt, 2_500),
    acceptance: run.acceptance.map((criterion) => clip(criterion, 240)),
    runStatus: run.status,
    integrationHead: run.workspace?.integrationHead ?? null,
    failedStep: {
      role: failed.role,
      taskId: failed.taskId,
      sequence: failed.sequence,
      failure: failed.failure,
    },
    activeTask:
      task === undefined
        ? null
        : {
            id: task.id,
            objective: clip(task.objective, 1_200),
            acceptance: task.acceptance.map((criterion) => clip(criterion, 320)),
            dependencies: task.dependencies,
            status: task.status,
            result: task.result === null ? null : clip(task.result, 1_200),
            settlementId: task.settlementId,
          },
    taskState: run.tasks.map((candidate) => ({
      id: candidate.id,
      status: candidate.status,
      dependencies: candidate.dependencies.slice(0, 8),
      settlementId: candidate.settlementId,
    })),
    recentDecisions: run.decisions.slice(-6).map((decision) => clip(decision, 600)),
    settlements: run.settlements.map((settlement) => ({
      id: settlement.id,
      taskId: settlement.taskId,
      status: settlement.status,
      headCommit: settlement.headCommit,
      appliedCommit: settlement.appliedCommit,
      summary: settlement.summary === null ? null : clip(settlement.summary, 400),
    })),
    recentMessages: run.messages.slice(-8).map((message) => ({
      from: {
        role: message.from.role,
        taskId: message.from.taskId,
      },
      to: {
        role: message.to.role,
        taskId: message.to.taskId,
      },
      text: clip(message.text, 500),
      replyRequested: message.replyRequested,
      readAt: message.readAt,
    })),
  };
  const encoded = JSON.stringify(payload);
  if (encoded.length <= 24_000) return encoded;
  return JSON.stringify({
    version: 1,
    runId: run.id,
    objective: clip(run.prompt, 2_000),
    acceptance: run.acceptance.map((criterion) => clip(criterion, 160)),
    runStatus: run.status,
    integrationHead: run.workspace?.integrationHead ?? null,
    failedStep: payload.failedStep,
    activeTask: payload.activeTask,
    taskState: run.tasks.map((candidate) => ({
      id: candidate.id,
      status: candidate.status,
      settlementId: candidate.settlementId,
    })),
    recentDecisions: run.decisions.slice(-3).map((decision) => clip(decision, 300)),
    settlements: run.settlements.map((settlement) => ({
      taskId: settlement.taskId,
      status: settlement.status,
      appliedCommit: settlement.appliedCommit,
    })),
    recentMessages: run.messages.slice(-4).map((message) => ({
      from: message.from.role,
      to: message.to.role,
      text: clip(message.text, 240),
    })),
  });
}

export function providerHandoffPrompt(run: TeamRun, failed: TeamAttempt): string {
  const suffix = [
    "Provider handoff: continue the SAME Dispatch-managed step. The previous provider became unavailable before this step completed. Dispatch remains the only scheduler; never spawn native subagents.",
    "Use the persisted durable state below to resume without restarting the run or changing task identity. Treat persisted acceptance, task status, settlements, and integration HEAD as authoritative.",
    `Durable handoff state: ${providerHandoffState(run, failed)}`,
  ].join("\n\n");
  const priorBudget = Math.max(0, 64_000 - suffix.length - 2);
  const prior = clip(failed.prompt, priorBudget);
  return `${prior}\n\n${suffix}`;
}

export function planningPrompt(run: Pick<TeamRun, "prompt" | "policy" | "executionMode">): string {
  const direct = run.executionMode === "direct";
  const workers = direct
    ? []
    : run.policy.profiles
        .filter((profile) => profile.worker)
        .map((profile) => ({
          id: profile.id,
          label: profile.label,
          capability: profile.capability ?? "unspecified",
        }));
  return [
    direct
      ? "You are the sole executor of a Dispatch Direct Auto coding run. Dispatch is the only scheduler; never spawn native subagents."
      : "You are the lead of a Dispatch-managed coding run. Dispatch is the only scheduler; never spawn native subagents.",
    direct
      ? "Inspect the repository only enough to define stable acceptance criteria for this bounded objective. Do not implement yet and do not delegate: the next managed turn will execute the complete objective in this same worktree."
      : "Inspect the repository and plan before implementation. Choose the smallest useful team. Keep tightly coupled work with the lead and delegate only independently useful tasks.",
    "Return ONLY JSON matching {acceptance:string[],tasks:[{id,objective,acceptance:string[],dependencies:string[],preferredProfileId?:string|null,context:string}],rationale:string}.",
    direct
      ? "Define stable observable acceptance criteria for the COMPLETE objective and return tasks:[]."
      : "Define stable observable acceptance criteria for the COMPLETE objective. Each delegated task must have a bounded scope and concrete verification. Dependencies must be explicit and acyclic.",
    direct
      ? "Direct Auto deliberately uses one selected Worker-capable model end to end for this simple objective."
      : "preferredProfileId is advisory; Dispatch may choose another allowed worker when availability, quota, or advisor decisions require it.",
    direct
      ? "No Worker thread or worktree will be created for this run."
      : run.policy.maxActive === 1
        ? "This run is configured for one agent with no delegation. Return tasks:[]; you will implement the complete objective yourself during final integration."
        : `Concurrency policy allows up to ${run.policy.maxActive - 1} worker(s) alongside the lead. Delegate only when it improves independence or throughput.`,
    mailbox,
    ...(direct ? [] : [`Allowed worker profiles: ${JSON.stringify(workers)}`]),
    `Objective: ${clip(run.prompt, 40_000)}`,
  ].join("\n\n");
}

export function workerPrompt(run: TeamRun, task: TeamTask): string {
  return [
    "You are a Dispatch-managed worker. Dispatch is the only scheduler; never spawn native subagents.",
    "Work only on the task contract below in your isolated worktree. Preserve accepted dependency behavior. Commit your changes with an English commit message and do not push.",
    "Return ONLY JSON matching {summary:string,commit:string,changedFiles:string[],checks:[{command:string,args:string[],outcome:string}],limitations:string[]}.",
    "Run relevant checks. If blocked, explain the blocker instead of inventing requirements. Do not claim success without a commit that contains the work.",
    mailbox,
    `Shared context: ${sharedContextPack(run, task)}`,
  ].join("\n\n");
}

export function workerCorrectionPrompt(run: TeamRun, task: TeamTask, correction: string): string {
  return [
    "Continue the same Dispatch-managed task in the existing worktree. Never spawn native subagents.",
    "The previous result was not accepted. Make a materially different correction, keep the task contract unchanged, run the required checks, commit the corrected result, and return the normal worker JSON result.",
    mailbox,
    `Task: ${JSON.stringify({
      objective: clip(task.objective, 4_000),
      acceptance: task.acceptance.map((criterion) => clip(criterion, 320)),
    })}`,
    `Correction: ${clip(correction, 6_000)}`,
    `Run objective: ${clip(run.prompt, 12_000)}`,
  ].join("\n\n");
}

export function reviewPrompt(run: TeamRun, task: TeamTask, workerResult: string): string {
  return [
    "Review this worker result as the Dispatch lead. Dispatch is the only scheduler; never spawn native subagents and do not modify the worker worktree during review.",
    'Return ONLY JSON matching {action:"accept"|"correct",summary:string,checks:[{criterionIndex:number,command:string,args:string[]}]}.',
    "For accept, cover every task acceptance criterion with a reproducible non-destructive command. criterionIndex is the exact zero-based index. For correct, explain the concrete failure and the changed next action.",
    mailbox,
    `Task: ${JSON.stringify({
      objective: clip(task.objective, 4_000),
      acceptance: task.acceptance.map((criterion) => clip(criterion, 320)),
    })}`,
    `Worker result: ${clip(workerResult, 20_000)}`,
    `Run objective: ${clip(run.prompt, 12_000)}`,
  ].join("\n\n");
}

export function integrationPrompt(run: TeamRun): string {
  const direct = run.executionMode === "direct";
  return [
    direct
      ? "Implement and verify this Dispatch Direct Auto run in your managed worktree. You are the sole executor; Dispatch is the only scheduler and native subagents are forbidden."
      : "Finish and verify this Dispatch-managed run in the lead worktree. Dispatch is the only scheduler; never spawn native subagents.",
    direct
      ? "Implement the complete objective yourself, run focused verification, and commit any changes with an English commit message. Do not delegate and do not push."
      : "All settled worker commits have already been integrated into this worktree. Resolve remaining integration issues and verify the complete objective. If the plan used no workers, implement the objective yourself before verification. Commit any changes you make with an English commit message; do not push.",
    'Return ONLY JSON matching {action:"accept"|"correct",summary:string,checks:[{criterionIndex:number,command:string,args:string[]}]}.',
    "For accept, cover every run acceptance criterion with a reproducible non-destructive command. Do not change or weaken the persisted criteria.",
    mailbox,
    `Objective: ${clip(run.prompt, 12_000)}`,
    `Acceptance: ${JSON.stringify(run.acceptance.map((criterion) => clip(criterion, 320)))}`,
    `Settled tasks: ${JSON.stringify(
      run.tasks
        .filter((task) => task.status === "settled")
        .map((task) => ({
          id: task.id,
          result: task.result === null ? null : clip(task.result, 1_000),
          settlementId: task.settlementId,
        })),
    )}`,
  ].join("\n\n");
}

export function settlementConflictPrompt(
  run: TeamRun,
  task: TeamTask,
  workerHeadCommit: string,
): string {
  return [
    "Resolve the current worker integration conflict in the Dispatch lead worktree. Dispatch is the only scheduler; never spawn native subagents.",
    "A git merge of the accepted worker commit is already in progress. Inspect the conflict, preserve both the complete run objective and the worker task acceptance contract, resolve the files, stage them, and finish the merge commit. Do not abort the merge and do not push.",
    "After resolving, run focused checks. Return a concise summary of the resolution and checks; the scheduler independently verifies that the accepted worker commit is an ancestor of the resulting lead HEAD.",
    mailbox,
    `Run objective: ${clip(run.prompt, 12_000)}`,
    `Task: ${JSON.stringify({
      id: task.id,
      objective: clip(task.objective, 4_000),
      acceptance: task.acceptance.map((criterion) => clip(criterion, 320)),
    })}`,
    `Accepted worker head: ${workerHeadCommit}`,
  ].join("\n\n");
}

export function integrationCorrectionPrompt(run: TeamRun, correction: string): string {
  return [
    run.executionMode === "direct"
      ? "Correct the Dispatch Direct Auto result in the existing managed worktree. You are the sole executor; never spawn native subagents."
      : "Correct the combined Dispatch-managed result in the existing lead worktree. Never spawn native subagents.",
    "Do not change the persisted acceptance criteria. Make a materially different correction, run checks, commit any changes, then return the normal integration review JSON.",
    mailbox,
    `Objective: ${clip(run.prompt, 12_000)}`,
    `Acceptance: ${JSON.stringify(run.acceptance.map((criterion) => clip(criterion, 320)))}`,
    `Previous verification: ${clip(correction, 16_000)}`,
  ].join("\n\n");
}

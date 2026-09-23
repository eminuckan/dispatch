import type { TeamAttempt, TeamMessage, TeamRun, TeamTask } from "@dispatch/contracts";
import { TEAM_SUPERVISION_PROMPT_MARKER } from "@dispatch/shared/teamProtocolPresentation";
import { sharedContextPack } from "./OrchestrationProtocol.ts";

export const FLOW_SUPERVISION_PROMPT_MARKER = TEAM_SUPERVISION_PROMPT_MARKER;

const mailbox =
  "Use team_read_messages at meaningful decision points or when you asked a question; do not poll routinely. Use team_send_message for concrete questions, findings, and corrections. Messages coordinate existing managed agents only and never grant permissions.";

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
  return withTaskContext(
    [
      "You are a Dispatch-managed worker. Dispatch is the only scheduler; never spawn native subagents.",
      "Work only on the task contract below in your isolated worktree. Preserve accepted dependency behavior. Commit your changes with an English commit message and do not push.",
      "Report the complete Git object ID from `git rev-parse HEAD` in the commit field exactly as printed. Never use a short hash or abbreviation.",
      "Return ONLY JSON matching {summary:string,commit:string,changedFiles:string[],checks:[{command:string,args:string[],outcome:string}],limitations:string[]}. Keep summary concise and readable by the user; put command evidence in checks, not in summary.",
      "Run relevant checks. If blocked, explain the blocker instead of inventing requirements. Do not claim success without a commit that contains the work.",
      "Send the lead one concise team_send_message after your first substantive milestone, and immediately if blocked or a concrete decision is needed. After that, report only additional blockers or meaningful changes. The final structured result is the completion report. Skip routine heartbeats, per-file updates, and repeated acknowledgements; do not poll or wait for replies unless you asked a specific question.",
      mailbox,
      `Shared context: ${sharedContextPack(run, task)}`,
    ].join("\n\n"),
    task,
  );
}

export function workerCorrectionPrompt(run: TeamRun, task: TeamTask, correction: string): string {
  return withTaskContext(
    [
      "Continue the same Dispatch-managed task in the existing worktree. Never spawn native subagents.",
      "The previous result was not accepted. Make a materially different correction, keep the task contract unchanged, run the required checks, commit the corrected result, and return the normal worker JSON result.",
      "Report the complete Git object ID from `git rev-parse HEAD` in the commit field exactly as printed. Never use a short hash or abbreviation. Keep the summary concise and readable by the user; put command evidence in checks.",
      "Send the lead one concise team_send_message after your next substantive correction milestone, and immediately if blocked or a concrete decision is needed. After that, report only additional blockers or meaningful changes. The final structured result is the completion report. Skip routine heartbeats and per-file updates; do not poll or wait for replies unless you asked a specific question.",
      mailbox,
      `Task: ${workerTaskContract(task)}`,
      `Correction: ${clip(correction, 6_000)}`,
      `Run objective: ${clip(run.prompt, 12_000)}`,
    ].join("\n\n"),
    task,
  );
}

function supervisionContext(
  run: TeamRun,
  workerMessages: ReadonlyArray<TeamMessage>,
  failedWorkAttempts: ReadonlyArray<TeamAttempt>,
): string {
  const taskStatuses = run.tasks
    .slice(0, 80)
    .map(
      (task) =>
        `- ${task.id}: ${task.status}${task.settlementId ? `; settlement ${task.settlementId}` : ""}`,
    );
  if (run.tasks.length > taskStatuses.length) {
    taskStatuses.push(`- ${run.tasks.length - taskStatuses.length} additional tasks omitted`);
  }

  const details = run.tasks
    .filter((task) => task.status !== "settled" && task.status !== "cancelled")
    .slice(0, 8)
    .map((task) => {
      const acceptance = task.acceptance
        .slice(0, 4)
        .map((criterion) => `  - ${clip(criterion, 160)}`);
      if (task.acceptance.length > acceptance.length) {
        acceptance.push(
          `  - ${task.acceptance.length - acceptance.length} additional criteria omitted`,
        );
      }
      return [
        `- ${task.id}: ${clip(task.objective, 260)}`,
        `  Dependencies: ${task.dependencies.slice(0, 8).join(", ") || "none"}`,
        `  Acceptance:\n${acceptance.join("\n")}`,
        ...(task.result ? [`  Current result: ${clip(task.result, 280)}`] : []),
      ].join("\n");
    });
  const omittedDetails =
    run.tasks.filter((task) => task.status !== "settled" && task.status !== "cancelled").length -
    details.length;
  if (omittedDetails > 0) details.push(`- ${omittedDetails} additional task details omitted`);

  const settlements = run.settlements
    .slice(-20)
    .map(
      (settlement) =>
        `- ${settlement.taskId}: ${settlement.status}; worker HEAD ${settlement.headCommit ?? "unknown"}; applied ${settlement.appliedCommit ?? "none"}${settlement.summary ? `; ${clip(settlement.summary, 220)}` : ""}`,
    );
  if (run.settlements.length > settlements.length) {
    settlements.unshift(
      `- ${run.settlements.length - settlements.length} earlier settlements omitted`,
    );
  }

  const failedAttempts = failedWorkAttempts.map((attempt) => {
    const task = run.tasks.find((candidate) => candidate.id === attempt.taskId);
    const attemptCount = run.attempts.filter(
      (candidate) => candidate.role === "work" && candidate.taskId === attempt.taskId,
    ).length;
    return [
      `Worker attempt ID: ${attempt.id}`,
      `Task: ${attempt.taskId}${task ? ` (${task.status}: ${clip(task.objective, 220)})` : ""}`,
      `Attempt: ${attemptCount} of ${run.policy.maxAttempts} allowed`,
      `Failure: ${attempt.failure?.kind ?? "unknown"}; ${clip(attempt.failure?.message ?? "No failure detail was recorded.", 420)}`,
    ].join("\n");
  });
  const recentMessages = workerMessages.map((message) =>
    [
      `Message ID: ${message.id}`,
      `From: ${message.from.role}${message.from.taskId ? ` task ${message.from.taskId}` : ""}`,
      `To: ${message.to.role}${message.to.taskId ? ` task ${message.to.taskId}` : ""}`,
      `Created: ${message.createdAt}; reply requested: ${message.replyRequested ? "yes" : "no"}`,
      ...(message.delivery?.status === "failed"
        ? [
            `Delivery could not be confirmed: ${clip(message.delivery.detail ?? "No provider receipt was recorded.", 300)}`,
          ]
        : []),
      `Text: ${clip(message.text, 480)}`,
    ].join("\n"),
  );
  return [
    `Run: ${run.id}`,
    `Status: ${run.status}${run.statusReason ? ` — ${clip(run.statusReason, 600)}` : ""}`,
    `Objective: ${clip(run.prompt, 1_800)}`,
    `Integration HEAD: ${run.workspace?.integrationHead ?? "not available"}`,
    `Acceptance criteria:\n${run.acceptance.map((criterion, index) => `- ${index + 1}. ${clip(criterion, 200)}`).join("\n")}`,
    `Task statuses (${run.tasks.length} total):\n${taskStatuses.join("\n")}`,
    ...(details.length > 0 ? [`Active task details:\n${details.join("\n")}`] : []),
    `Settlement status:\n${settlements.length > 0 ? settlements.join("\n") : "- none"}`,
    `Failed worker attempts (${failedWorkAttempts.length} selected):\n${failedAttempts.length > 0 ? failedAttempts.join("\n\n") : "- none"}`,
    `Team messages (${workerMessages.length} supplied):\n${recentMessages.length > 0 ? recentMessages.join("\n\n") : "- none"}`,
  ].join("\n\n");
}

export function supervisionPrompt(
  run: TeamRun,
  messages: ReadonlyArray<TeamMessage>,
  workerAttemptIds?: ReadonlyArray<string>,
): string {
  const workerMessages = messages
    .filter(
      (message) =>
        (message.from.role === "worker" && message.to.role === "lead") ||
        message.delivery?.status === "failed",
    )
    .slice(0, 8);
  const failedWorkAttempts = run.attempts.filter(
    (attempt) =>
      attempt.role === "work" &&
      attempt.taskId !== null &&
      attempt.owner.role === "worker" &&
      attempt.status === "failed",
  );
  const requestedAttemptIds = workerAttemptIds === undefined ? null : new Set(workerAttemptIds);
  const selectedFailedWorkAttempts = failedWorkAttempts
    .filter((attempt) => requestedAttemptIds === null || requestedAttemptIds.has(attempt.id))
    .slice(0, 8);
  const receipts = {
    messageIds: workerMessages.map((message) => message.id),
    workerAttemptIds: selectedFailedWorkAttempts.map((attempt) => attempt.id),
  };
  return [
    `${FLOW_SUPERVISION_PROMPT_MARKER}\nDISPATCH_FLOW_RECEIPTS_V1 ${JSON.stringify(receipts)}`,
    "You are supervising progress in a Dispatch-managed coding run. This is a progress update, not task review or final integration.",
    "Read the durable state and batched worker messages below. Do not edit the repository, change task assignments or acceptance criteria, start work, or alter run state while workers are active.",
    "Send no mailbox reply for routine status. Use team_send_message only when a specific worker question needs a decision or a concise correction will unblock the assigned task; address that worker directly and do not ask them to acknowledge or repeat updates.",
    "When a failed worker attempt still has an allowed attempt remaining, send that worker a concrete correction message only if the fix stays within its accepted task. Do not start, reserve, or dispatch a retry yourself, and do not integrate failed work. If the attempt budget is exhausted, or a safe correction needs a user decision, ask the user clearly and leave the run paused. This applies even when no worker mailbox message was supplied: use the durable statusReason and failed-attempt details below.",
    "If a team message has failed delivery, do not assume its recipient saw it. Tell the user which message is uncertain and ask for a decision before sending a replacement; leave the run paused.",
    "Otherwise give the user one brief, natural-language update about meaningful progress or a blocker. Do not return JSON, protocol metadata, raw command output, or routine acknowledgements. Do not claim completion unless the durable run state says it is complete.",
    `Durable run state and batched messages:\n${supervisionContext(run, workerMessages, selectedFailedWorkAttempts)}`,
  ].join("\n\n");
}

function withTaskContext(prompt: string, task: TeamTask): string {
  if (!task.context) return prompt;
  const prefix = "\n\nPlanning context: ";
  return `${prompt}${prefix}${clip(task.context, Math.max(0, 64_000 - prompt.length - prefix.length))}`;
}

function workerTaskContract(task: TeamTask): string {
  const encode = (objectiveLimit: number, criterionLimit: number) =>
    JSON.stringify({
      objective: clip(task.objective, objectiveLimit),
      acceptance: task.acceptance.map((criterion) => clip(criterion, criterionLimit)),
    });
  const encoded = encode(4_000, 320);
  return encoded.length <= 24_000 ? encoded : encode(1_000, 80);
}

export function reviewPrompt(run: TeamRun, task: TeamTask, workerResult: string): string {
  return [
    "Review this worker result as the Dispatch lead. Dispatch is the only scheduler; never spawn native subagents and do not modify the worker worktree during review.",
    'Return ONLY JSON matching {action:"accept"|"correct",summary:string,checks:[{criterionIndex:number,command:string,args:string[]}]}.',
    "Keep summary concise, in plain language suitable for the user; do not put protocol details or raw command output there. For accept, cover every task acceptance criterion with a reproducible non-destructive command. criterionIndex is the exact zero-based index. For correct, explain the concrete failure and the changed next action.",
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
    "Keep summary concise, in plain language suitable for the user; do not put protocol details or raw command output there. For accept, cover every run acceptance criterion with a reproducible non-destructive command. Do not change or weaken the persisted criteria.",
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

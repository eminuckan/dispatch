import type {
  TeamAttempt,
  TeamRun,
  TeamThreadTurnView,
  TeamThreadView,
  ThreadId,
} from "@dispatch/contracts";
import {
  isTeamProtocolRole,
  looksLikeTeamProtocol,
  TEAM_SUPERVISION_PROMPT_MARKER,
  teamProtocolSummary,
} from "@dispatch/shared/teamProtocolPresentation";

export const SMART_ROUTING_STANDARD_FALLBACK_NOTICE =
  "Smart Routing was unavailable or uncertain. Flow continued with Standard using your saved model order.";

function threadScope(run: TeamRun): ThreadId | null {
  if (run.lead.threadId) return run.lead.threadId;
  for (const attempt of run.attempts) if (attempt.owner.threadId) return attempt.owner.threadId;
  for (const task of run.tasks) if (task.owner.threadId) return task.owner.threadId;
  for (const message of run.messages) {
    if (message.from.threadId) return message.from.threadId;
    if (message.to.threadId) return message.to.threadId;
  }
  for (const settlement of run.settlements)
    if (settlement.owner.threadId) return settlement.owner.threadId;
  return null;
}

function phase(run: TeamRun): TeamThreadView["phase"] {
  if (["completed", "cancelled", "failed"].includes(run.status)) return "done";
  if (run.status === "planning") return "plan";
  if (run.status === "review" || run.status === "settling") return "integrate";

  const integratingSettlement = run.settlements.some(
    (settlement) => !["applied", "rejected"].includes(settlement.status),
  );
  if (
    integratingSettlement ||
    (run.tasks.length > 0 && run.tasks.every((task) => task.status === "settled"))
  )
    return "integrate";
  if (run.tasks.length === 0 && run.settlements.length === 0 && run.status === "paused")
    return "plan";
  return "workers";
}

function turnStatus(status: TeamAttempt["status"]): TeamThreadTurnView["status"] {
  switch (status) {
    case "reserved":
      return "reserved";
    case "dispatching":
      return "dispatching";
    case "running":
      return "dispatched";
    case "succeeded":
    case "failed":
    case "cancelled":
      return "settled";
  }
}

function turnSummary(attempt: TeamAttempt): string | null {
  if (attempt.result === null) return null;
  if (
    attempt.role === "review" &&
    attempt.taskId === null &&
    attempt.prompt.startsWith(TEAM_SUPERVISION_PROMPT_MARKER)
  ) {
    return attempt.result;
  }
  const role = attempt.role === "work" ? "worker" : attempt.role;
  if (isTeamProtocolRole(role)) {
    const summary = teamProtocolSummary(role, attempt.result);
    if (summary) return summary;
    if (role !== "worker" || looksLikeTeamProtocol(attempt.result)) return null;
  }
  return attempt.result;
}

function notice(run: TeamRun): string | null {
  if (run.statusReason) return run.statusReason;
  return run.policy.flowMode === "standard" &&
    run.decisions.includes(SMART_ROUTING_STANDARD_FALLBACK_NOTICE)
    ? SMART_ROUTING_STANDARD_FALLBACK_NOTICE
    : null;
}

export function teamThreadView(run: TeamRun | null): TeamThreadView | null {
  if (!run) return null;
  const lead = run.policy.profiles.find((profile) => profile.id === run.lead.profileId);
  const threadId = threadScope(run);
  if (!lead || !threadId) return null;

  return {
    id: run.id,
    threadId,
    revision: run.revision,
    executionMode: run.executionMode,
    objective: run.prompt,
    prompt: run.prompt,
    status: run.status,
    statusReason: run.statusReason,
    profiles: run.policy.profiles,
    lead,
    leadOwner: run.lead,
    leadThreadId: run.lead.threadId,
    phase: phase(run),
    notice: notice(run),
    workspace: run.workspace,
    tasks: run.tasks,
    attempts: run.attempts,
    turns: run.attempts.map((attempt) => ({
      id: attempt.id,
      role: attempt.role === "work" ? "worker" : attempt.role,
      taskId: attempt.taskId,
      threadId: attempt.owner.threadId,
      model: attempt.selection.model,
      status: turnStatus(attempt.status),
      succeeded: attempt.status === "succeeded",
      summary: turnSummary(attempt),
      providerTurnId: attempt.providerTurnId,
      resultMessageId: attempt.resultMessageId,
    })),
    messages: run.messages,
    settlements: run.settlements,
    failovers: run.failovers,
  };
}

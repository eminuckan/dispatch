import type { TeamRun, TeamThreadView } from "@t3tools/contracts";
import { isTeamProtocolRole, teamProtocolSummary } from "@t3tools/shared/teamProtocolPresentation";

export function teamThreadView(run: TeamRun | null): TeamThreadView | null {
  if (!run?.execution) return null;
  const execution = run.execution;
  return {
    id: run.id,
    coordinationMessageIds: execution.turns.map((turn) => turn.command.message.messageId),
    revision: run.revision,
    objective: run.objective,
    status: run.status,
    lead: run.lead,
    leadThreadId: execution.leadThreadId,
    phase: execution.phase,
    notice: execution.notice,
    maxTurns: execution.maxTurns,
    tasks: run.tasks.map(
      ({ context: _context, recoveryHistory: _history, result: _result, ...task }) => task,
    ),
    turns: execution.turns.map((turn) => ({
      id: turn.id,
      role: turn.role,
      taskId: turn.taskId,
      threadId: turn.command.threadId,
      model: turn.command.modelSelection?.model ?? "Unknown model",
      effort: (() => {
        const value = turn.command.modelSelection?.options?.find((option) =>
          ["reasoningEffort", "effort"].includes(option.id),
        )?.value;
        return typeof value === "string" ? value : null;
      })(),
      ...(turn.providerTurnId ? { providerTurnId: turn.providerTurnId } : {}),
      ...(turn.resultMessageId ? { resultMessageId: turn.resultMessageId } : {}),
      status: turn.status,
      succeeded: turn.succeeded,
      summary: isTeamProtocolRole(turn.role)
        ? teamProtocolSummary(turn.role, turn.result ?? "")
        : turn.result,
    })),
  };
}

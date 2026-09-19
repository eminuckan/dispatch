import type { TeamRun, TeamThreadView } from "@t3tools/contracts";

function protocolSummary(value: string | null): string | null {
  if (!value) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    return typeof parsed === "object" &&
      parsed !== null &&
      "summary" in parsed &&
      typeof parsed.summary === "string"
      ? parsed.summary
      : null;
  } catch {
    // Invalid protocol is handled by the runtime. Never leak it into the conversation.
    return null;
  }
}

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
      status: turn.status,
      succeeded: turn.succeeded,
      summary: turn.role === "worker" ? turn.result : protocolSummary(turn.result),
    })),
  };
}

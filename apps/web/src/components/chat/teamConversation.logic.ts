import { teamAgentDisplayName } from "@t3tools/shared/teamAgentNames";
import type { TeamThreadView } from "@t3tools/contracts";
import {
  isTeamProtocolRole,
  teamProtocolSummary,
  looksLikeTeamProtocol,
} from "@t3tools/shared/teamProtocolPresentation";
import type { TimelineEntry } from "../../session-logic";

// Managed turns use the ordinary live timeline. Only runtime-authored user
// instructions and structured final responses are presented; live work retains its identity.
export function teamConversationEntries(
  entries: ReadonlyArray<TimelineEntry>,
  coordinationIds: ReadonlyArray<string>,
  initialMessage?: { id: string; objective: string },
  turns: TeamThreadView["turns"] = [],
): TimelineEntry[] {
  const internal = new Set(coordinationIds);
  const protocolTurns = turns.filter((turn) => isTeamProtocolRole(turn.role));
  const byTurn = new Map(protocolTurns.map((turn) => [turn.providerTurnId, turn]));
  const byResult = new Map(protocolTurns.map((turn) => [turn.resultMessageId, turn]));
  const byRequest = new Map(protocolTurns.map((turn) => [`team-${turn.id}`, turn]));
  let precedingRequest: (typeof protocolTurns)[number] | undefined;
  return entries.flatMap((entry): TimelineEntry[] => {
    if (entry.kind !== "message") return [entry];
    if (entry.message.role === "assistant") {
      const turn =
        byResult.get(entry.message.id) ??
        (entry.message.turnId ? byTurn.get(entry.message.turnId) : undefined) ??
        (precedingRequest?.providerTurnId ? undefined : precedingRequest);
      if (!turn || !isTeamProtocolRole(turn.role)) return [entry];
      if (turn.resultMessageId && turn.resultMessageId !== entry.message.id) return [entry];
      const summary = teamProtocolSummary(turn.role, entry.message.text);
      if (summary) return [{ ...entry, message: { ...entry.message, text: summary } }];
      if (looksLikeTeamProtocol(entry.message.text)) {
        if (entry.message.streaming) return [];
        return [
          {
            ...entry,
            message: {
              ...entry.message,
              text: "The lead’s structured response could not be read. Check the team status in Agents.",
            },
          },
        ];
      }
      return [entry];
    }
    if (entry.message.role !== "user") return [entry];
    precedingRequest = byRequest.get(entry.message.id);
    if (entry.message.id === initialMessage?.id) {
      return [{ ...entry, message: { ...entry.message, text: initialMessage.objective } }];
    }
    return internal.has(entry.message.id) || entry.message.id.startsWith("team-") ? [] : [entry];
  });
}

export function teamAgentName(
  run: Pick<import("@t3tools/contracts").TeamThreadView, "id" | "leadThreadId" | "turns">,
  threadId: string,
): string {
  return teamAgentDisplayName(
    run.id,
    [run.leadThreadId, ...run.turns.filter((t) => t.role === "worker").map((t) => t.threadId)],
    threadId,
  );
}

export function teamTurnLabel(
  run: import("@t3tools/contracts").TeamThreadView,
  turn: import("@t3tools/contracts").TeamThreadView["turns"][number],
): string {
  if (turn.status === "reserved") return "queued";
  if (turn.role === "consult")
    return turn.status === "settled" ? "consultation finished" : "responding to teammate";
  if (turn.status !== "settled")
    return turn.role === "review"
      ? "reviewing worker"
      : turn.role === "integrate"
        ? "verifying result"
        : turn.role === "plan"
          ? "planning"
          : "working";
  if (!turn.succeeded) return "needs attention";
  if (turn.role === "plan") return "plan ready";
  if (turn.role === "integrate")
    return run.status === "completed" ? "result verified" : "verification reported";
  if (turn.role === "review") return "review finished";
  const task = run.tasks.find((t) => t.id === turn.taskId);
  const latest = run.turns.findLast((t) => t.role === "worker" && t.taskId === turn.taskId);
  return task?.status === "accepted" && latest?.id === turn.id
    ? "accepted by lead"
    : "reported result";
}

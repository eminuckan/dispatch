import { teamAgentDisplayName } from "@t3tools/shared/teamAgentNames";
import type { TeamThreadView } from "@t3tools/contracts";
import {
  isTeamProtocolRole,
  looksLikeTeamProtocol,
  teamProtocolSummary,
} from "@t3tools/shared/teamProtocolPresentation";
import type { TimelineEntry } from "../../session-logic";

// Exact managed-thread membership lets us hide only scheduler prompts while
// preserving the provider's real reasoning/tool/message stream in the normal
// chat timeline. Structured scheduler replies are rendered as human text.
export function teamConversationEntries(
  entries: ReadonlyArray<TimelineEntry>,
  coordinationIds: ReadonlyArray<string>,
  turns: TeamThreadView["turns"] = [],
): TimelineEntry[] {
  const internal = new Set(coordinationIds);
  const protocolTurns = turns.filter((turn) => isTeamProtocolRole(turn.role));
  const byTurn = new Map(
    protocolTurns.flatMap((turn) =>
      turn.providerTurnId ? [[turn.providerTurnId, turn] as const] : [],
    ),
  );
  const byResult = new Map(
    protocolTurns.flatMap((turn) =>
      turn.resultMessageId ? [[turn.resultMessageId, turn] as const] : [],
    ),
  );
  const byRequest = new Map<string, (typeof protocolTurns)[number]>(
    protocolTurns.map((turn) => [`team-${turn.id}`, turn]),
  );
  let precedingRequest: (typeof protocolTurns)[number] | undefined;
  let unknownManagedRequest = false;

  return entries.flatMap((entry): TimelineEntry[] => {
    if (entry.kind !== "message") return [entry];
    if (entry.message.role === "assistant") {
      const turn =
        byResult.get(entry.message.id) ??
        (entry.message.turnId ? byTurn.get(entry.message.turnId) : undefined) ??
        (precedingRequest?.providerTurnId ? undefined : precedingRequest);
      if (!turn || !isTeamProtocolRole(turn.role)) {
        // A freshly reserved scheduler request can reach the native timeline a
        // moment before its team-ledger/receipt metadata. The reserved team-*
        // namespace is exact enough to suppress only protocol-shaped leakage
        // during that short window; normal commentary remains visible.
        if (unknownManagedRequest && looksLikeTeamProtocol(entry.message.text)) return [];
        return [entry];
      }
      if (turn.resultMessageId && turn.resultMessageId !== entry.message.id) return [entry];
      const summary = teamProtocolSummary(turn.role, entry.message.text);
      if (summary) return [{ ...entry, message: { ...entry.message, text: summary } }];
      if (!looksLikeTeamProtocol(entry.message.text)) return [entry];
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
    if (entry.message.role !== "user") return [entry];
    precedingRequest = byRequest.get(entry.message.id);
    unknownManagedRequest = precedingRequest === undefined && entry.message.id.startsWith("team-");
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

import { teamAgentDisplayName } from "@dispatch/shared/teamAgentNames";
import type { TeamAttempt, TeamThreadView } from "@dispatch/contracts";
import {
  isTeamProtocolRole,
  looksLikeTeamProtocol,
  teamProtocolSummary,
} from "@dispatch/shared/teamProtocolPresentation";
import type { TimelineEntry } from "../../session-logic";

export function teamProviderDecisionState(
  run: Pick<TeamThreadView, "status" | "failovers" | "profiles">,
) {
  if (run.status !== "awaiting-provider-decision") return null;
  const failover = run.failovers.findLast((candidate) => candidate.status === "pending");
  if (!failover) return null;
  const byId = new Map(run.profiles.map((profile) => [profile.id, profile]));
  return {
    failover,
    currentProfile: byId.get(failover.fromProfileId) ?? null,
    candidates: failover.candidateProfileIds.flatMap((id) => {
      const profile = byId.get(id);
      return profile ? [profile] : [];
    }),
  };
}

// Exact managed-thread membership lets us hide only scheduler prompts while
// preserving the provider's real reasoning/tool/message stream in the normal
// chat timeline. Structured scheduler replies are rendered as human text.
export function teamConversationEntries(
  entries: ReadonlyArray<TimelineEntry>,
  attempts: ReadonlyArray<Pick<TeamAttempt, "id" | "requestMessageId">>,
  turns: TeamThreadView["turns"] = [],
  initialMessage?: { id: string; objective: string },
): TimelineEntry[] {
  const internal = new Set(attempts.map((attempt) => attempt.requestMessageId));
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
  const turnById = new Map(protocolTurns.map((turn) => [turn.id, turn]));
  const byRequest = new Map<string, (typeof protocolTurns)[number]>(
    attempts.flatMap((attempt) => {
      const turn = turnById.get(attempt.id);
      return turn ? [[attempt.requestMessageId, turn] as const] : [];
    }),
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
    if (entry.message.id === initialMessage?.id) {
      return [{ ...entry, message: { ...entry.message, text: initialMessage.objective } }];
    }
    return internal.has(entry.message.id) || entry.message.id.startsWith("team-") ? [] : [entry];
  });
}

export function teamAgentName(
  run: Pick<import("@dispatch/contracts").TeamThreadView, "id" | "leadThreadId" | "tasks">,
  threadId: string,
): string {
  const workerThreadIds = run.tasks.flatMap((task) =>
    task.owner.threadId ? [task.owner.threadId] : [],
  );
  return teamAgentDisplayName(
    run.id,
    [...(run.leadThreadId ? [run.leadThreadId] : []), ...workerThreadIds],
    threadId,
  );
}

export function teamPrimaryRoleLabel(
  run: Pick<import("@dispatch/contracts").TeamThreadView, "executionMode">,
): "Direct" | "Lead" {
  return run.executionMode === "direct" ? "Direct" : "Lead";
}

export function teamTurnLabel(
  run: import("@dispatch/contracts").TeamThreadView,
  turn: import("@dispatch/contracts").TeamThreadView["turns"][number],
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
  return task?.status === "settled" && latest?.id === turn.id
    ? "accepted by lead"
    : "reported result";
}

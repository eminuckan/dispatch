import { teamAgentDisplayName } from "@t3tools/shared/teamAgentNames";
import type { TimelineEntry } from "../../session-logic";

// Only explicit user follow-ups and their associated turns enter the chat surface.
// A paged-in assistant fragment without its initiating message stays out until identified.
export function teamFollowUpEntries(
  entries: ReadonlyArray<TimelineEntry>,
  coordinationIds: ReadonlyArray<string>,
): TimelineEntry[] {
  const internal = new Set(coordinationIds);
  // Reserved runtime message IDs can arrive before the next ledger refresh.
  // This guard runs only after exact managed-thread membership has been confirmed.
  const isCoordination = (id: string) => internal.has(id) || id.startsWith("team-");
  const publicTurns = new Set(
    entries.flatMap((entry) =>
      entry.kind === "message" &&
      entry.message.role === "user" &&
      !isCoordination(entry.message.id) &&
      entry.message.turnId
        ? [entry.message.turnId]
        : [],
    ),
  );
  return entries.filter((entry) => {
    if (entry.kind === "message" && entry.message.role === "user")
      return !isCoordination(entry.message.id);
    const turnId =
      entry.kind === "message"
        ? entry.message.turnId
        : entry.kind === "work"
          ? entry.entry.turnId
          : entry.proposedPlan.turnId;
    return turnId != null && publicTurns.has(turnId);
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

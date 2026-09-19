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

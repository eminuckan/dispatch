import { teamAgentDisplayName } from "@t3tools/shared/teamAgentNames";
import type { TimelineEntry } from "../../session-logic";

// Managed turns use the ordinary live timeline. Only runtime-authored user
// instructions are replaced/hidden; assistant and tool events retain their identity.
export function teamConversationEntries(
  entries: ReadonlyArray<TimelineEntry>,
  coordinationIds: ReadonlyArray<string>,
  initialMessage?: { id: string; objective: string },
): TimelineEntry[] {
  const internal = new Set(coordinationIds);
  return entries.flatMap((entry): TimelineEntry[] => {
    if (entry.kind !== "message" || entry.message.role !== "user") return [entry];
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

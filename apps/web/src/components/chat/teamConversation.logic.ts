import { teamAgentDisplayName } from "@t3tools/shared/teamAgentNames";
import type { TimelineEntry } from "../../session-logic";

function structuredTeamReply(text: string): string | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return text;
  let value: unknown;
  try {
    value = JSON.parse(trimmed);
  } catch {
    // Managed protocol JSON streams through partial states. Do not flash raw
    // scheduler syntax while the final object is still being assembled.
    return null;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (
    (record.action === "accept" || record.action === "correct") &&
    typeof record.summary === "string" &&
    Array.isArray(record.checks)
  ) {
    return record.summary.trim() || null;
  }
  if (
    typeof record.rationale === "string" &&
    Array.isArray(record.acceptance) &&
    Array.isArray(record.tasks)
  ) {
    const objectives = record.tasks.flatMap((task) => {
      if (typeof task !== "object" || task === null || !("objective" in task)) return [];
      const objective = (task as Record<string, unknown>).objective;
      return typeof objective === "string" ? [objective.trim()] : [];
    });
    const sections = [record.rationale.trim()];
    if (objectives.length > 0)
      sections.push(
        `**Planlanan işler**\n${objectives.map((objective) => `- ${objective}`).join("\n")}`,
      );
    return sections.filter(Boolean).join("\n\n") || null;
  }
  if (typeof record.summary === "string") return record.summary.trim() || null;
  return null;
}

// Exact managed-thread membership lets us hide only scheduler prompts while
// preserving the provider's real reasoning/tool/message stream in the normal
// chat timeline. Structured scheduler replies are rendered as human text.
export function teamConversationEntries(
  entries: ReadonlyArray<TimelineEntry>,
  coordinationIds: ReadonlyArray<string>,
): TimelineEntry[] {
  const internal = new Set(coordinationIds);
  // Reserved runtime message IDs can arrive before the next ledger refresh.
  // This guard runs only after exact managed-thread membership has been confirmed.
  const isCoordination = (id: string) => internal.has(id) || id.startsWith("team-");
  const visible: TimelineEntry[] = [];
  for (const entry of entries) {
    if (entry.kind !== "message") {
      visible.push(entry);
      continue;
    }
    if (entry.message.role === "user") {
      if (!isCoordination(entry.message.id)) visible.push(entry);
      continue;
    }
    const rendered = structuredTeamReply(entry.message.text);
    if (rendered === null) continue;
    visible.push(
      rendered === entry.message.text
        ? entry
        : { ...entry, message: { ...entry.message, text: rendered } },
    );
  }
  return visible;
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

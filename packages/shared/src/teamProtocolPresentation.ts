type ProtocolRole = "plan" | "review" | "integrate";

export function isTeamProtocolRole(role: string): role is ProtocolRole {
  return role === "plan" || role === "review" || role === "integrate";
}

/** Apply only to a response belonging to a managed protocol turn. */
export function teamProtocolSummary(role: ProtocolRole, text: string): string | null {
  try {
    const value: unknown = JSON.parse(
      text.trim().replace(/^```(?:json)?\s*\n([\s\S]*?)\n```$/, "$1"),
    );
    if (typeof value !== "object" || value === null) return null;
    if (role === "plan") {
      if (
        !("tasks" in value) ||
        !Array.isArray(value.tasks) ||
        !("rationale" in value) ||
        typeof value.rationale !== "string"
      )
        return null;
      const tasks: string[] = [];
      for (const task of value.tasks) {
        if (
          typeof task !== "object" ||
          task === null ||
          !("objective" in task) ||
          typeof task.objective !== "string"
        )
          return null;
        tasks.push(task.objective);
      }
      return (
        [value.rationale.trim(), tasks.map((task) => `- ${task}`).join("\n")]
          .filter(Boolean)
          .join("\n\n") || "The lead has finished planning."
      );
    }
    if (
      !("action" in value) ||
      !["accept", "correct", "blocked"].includes(String(value.action)) ||
      !("summary" in value) ||
      typeof value.summary !== "string"
    )
      return null;
    return value.summary.trim() || null;
  } catch {
    return null;
  }
}

/** Avoid displaying a partial control object while its final message is streaming. */
export function looksLikeTeamProtocol(text: string): boolean {
  const object = text.trim().replace(/^```(?:json)?\s*/, "");
  if (/^\{\s*$/.test(object)) return true;
  const firstKey = /^\{\s*"([^"\\]*)/.exec(object)?.[1];
  if (firstKey === undefined) return false;
  const keys = ["acceptance", "tasks", "rationale", "action", "summary", "checks"];
  return (
    keys.includes(firstKey) ||
    (!object.includes(`"${firstKey}"`) && keys.some((key) => key.startsWith(firstKey)))
  );
}

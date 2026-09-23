type ProtocolRole = "plan" | "worker" | "review" | "integrate";

export const TEAM_SUPERVISION_PROMPT_MARKER = "DISPATCH_FLOW_SUPERVISION_V1";

function isStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.every((item) => typeof item === "string" && item.trim().length > 0)
  );
}

function isPlanTask(value: unknown): value is { objective: string } {
  if (typeof value !== "object" || value === null) return false;
  return (
    "id" in value &&
    typeof value.id === "string" &&
    /^[a-z][a-z0-9_-]{0,63}$/u.test(value.id) &&
    "objective" in value &&
    typeof value.objective === "string" &&
    value.objective.trim().length > 0 &&
    "acceptance" in value &&
    isStringArray(value.acceptance) &&
    value.acceptance.length > 0 &&
    "dependencies" in value &&
    isStringArray(value.dependencies) &&
    "context" in value &&
    typeof value.context === "string" &&
    (!("preferredProfileId" in value) ||
      value.preferredProfileId === null ||
      typeof value.preferredProfileId === "string")
  );
}

function parsePlanTasks(value: unknown): Array<{ objective: string }> | null {
  if (!Array.isArray(value)) return null;
  const tasks: Array<{ objective: string }> = [];
  for (const item of value) {
    if (!isPlanTask(item)) return null;
    tasks.push(item);
  }
  return tasks;
}

function isWorkerCheck(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    "command" in value &&
    typeof value.command === "string" &&
    value.command.length > 0 &&
    value.command.length <= 128 &&
    "args" in value &&
    Array.isArray(value.args) &&
    value.args.length <= 40 &&
    value.args.every((argument) => typeof argument === "string" && argument.length <= 4_000) &&
    "outcome" in value &&
    typeof value.outcome === "string" &&
    value.outcome.length <= 4_000
  );
}

function isBoundedStringArray(
  value: unknown,
  maxCount: number,
  maxLength: number,
): value is string[] {
  return (
    Array.isArray(value) &&
    value.length <= maxCount &&
    value.every((item) => typeof item === "string" && item.length <= maxLength)
  );
}

function trailingFencedBlock(text: string): { prefix: string; json: string } | null {
  const trimmed = text.trimEnd();
  const match = /(?:^|\n)[\t ]*```(?:json)?[\t ]*\r?\n([\s\S]*?)\r?\n```[\t ]*$/u.exec(trimmed);
  if (!match) return null;
  return {
    prefix: trimmed.slice(0, match.index).trimEnd(),
    json: match[1]!,
  };
}

function isReviewCheck(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    "criterionIndex" in value &&
    Number.isInteger(value.criterionIndex) &&
    "command" in value &&
    typeof value.command === "string" &&
    "args" in value &&
    isStringArray(value.args)
  );
}

export function isTeamProtocolRole(role: string): role is ProtocolRole {
  return role === "plan" || role === "worker" || role === "review" || role === "integrate";
}

/** Apply only to a response that has already been identified as a managed protocol turn. */
export function teamProtocolSummary(role: ProtocolRole, text: string): string | null {
  if (role === "worker") {
    const trailing = trailingFencedBlock(text);
    if (trailing?.prefix) {
      const summary = teamProtocolSummary(role, trailing.json);
      return summary ? `${trailing.prefix}\n\n${summary}` : null;
    }
  }

  try {
    const value: unknown = JSON.parse(
      text.trim().replace(/^```(?:json)?\s*\n([\s\S]*?)\n```$/, "$1"),
    );
    if (typeof value !== "object" || value === null || Array.isArray(value)) return null;

    if (role === "plan") {
      const tasks = "tasks" in value ? parsePlanTasks(value.tasks) : null;
      if (
        !tasks ||
        !("rationale" in value) ||
        typeof value.rationale !== "string" ||
        !value.rationale.trim() ||
        !("acceptance" in value) ||
        !isStringArray(value.acceptance) ||
        value.acceptance.length === 0
      ) {
        return null;
      }
      const acceptance = value.acceptance;
      return (
        [
          value.rationale.trim(),
          tasks.length > 0
            ? `Planned work:\n${tasks.map((task) => `- ${task.objective}`).join("\n")}`
            : null,
          acceptance.length > 0
            ? `Completion checks:\n${acceptance.map((criterion) => `- ${criterion}`).join("\n")}`
            : null,
        ]
          .filter(Boolean)
          .join("\n\n") || "The lead has finished planning."
      );
    }

    if (role === "worker") {
      if (
        !("summary" in value) ||
        typeof value.summary !== "string" ||
        value.summary.length > 8_000 ||
        !("commit" in value) ||
        typeof value.commit !== "string" ||
        value.commit.length < 7 ||
        value.commit.length > 256 ||
        !("changedFiles" in value) ||
        !isBoundedStringArray(value.changedFiles, 500, 4_000) ||
        !("checks" in value) ||
        !Array.isArray(value.checks) ||
        value.checks.length > 40 ||
        !value.checks.every(isWorkerCheck) ||
        !("limitations" in value) ||
        !isBoundedStringArray(value.limitations, 20, 4_000)
      ) {
        return null;
      }
      const summary = value.summary.trim();
      if (!summary) return null;
      const limitations = value.limitations;
      return [
        summary,
        limitations.length > 0
          ? `Limitations:\n${limitations.map((limitation) => `- ${limitation}`).join("\n")}`
          : null,
      ]
        .filter(Boolean)
        .join("\n\n");
    }

    if (
      !("action" in value) ||
      !["accept", "correct"].includes(String(value.action)) ||
      !("summary" in value) ||
      typeof value.summary !== "string" ||
      !("checks" in value) ||
      !Array.isArray(value.checks) ||
      !value.checks.every(isReviewCheck)
    ) {
      return null;
    }
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
  const keys = [
    "acceptance",
    "tasks",
    "rationale",
    "action",
    "summary",
    "checks",
    "commit",
    "changedFiles",
    "limitations",
  ];
  return (
    keys.includes(firstKey) ||
    (!object.includes(`"${firstKey}"`) && keys.some((key) => key.startsWith(firstKey)))
  );
}

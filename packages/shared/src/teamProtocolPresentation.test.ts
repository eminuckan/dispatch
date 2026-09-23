import { expect, it } from "vite-plus/test";
import {
  isTeamProtocolRole,
  looksLikeTeamProtocol,
  teamProtocolSummary,
} from "./teamProtocolPresentation.ts";

it("formats only managed protocol roles", () => {
  expect(isTeamProtocolRole("plan")).toBe(true);
  expect(isTeamProtocolRole("review")).toBe(true);
  expect(isTeamProtocolRole("integrate")).toBe(true);
  expect(isTeamProtocolRole("worker")).toBe(true);
});

it("presents review and integration summaries", () => {
  expect(
    teamProtocolSummary(
      "review",
      '{"action":"correct","summary":"Add the timeout check.","checks":[]}',
    ),
  ).toBe("Add the timeout check.");
  expect(
    teamProtocolSummary(
      "integrate",
      '{"action":"accept","summary":"Combined result verified.","checks":[]}',
    ),
  ).toBe("Combined result verified.");
});

it("does not reinterpret arbitrary or malformed JSON as a valid protocol summary", () => {
  expect(teamProtocolSummary("review", '{"hello":"world"}')).toBeNull();
  expect(teamProtocolSummary("review", '{"action":"blocked","summary":"Nope"}')).toBeNull();
  expect(teamProtocolSummary("plan", '{"tasks":[')).toBeNull();
});

it("recognizes partial protocol-shaped objects for streaming suppression", () => {
  expect(looksLikeTeamProtocol('{"action":"correct","summary":"')).toBe(true);
  expect(looksLikeTeamProtocol('{"ac')).toBe(true);
  expect(looksLikeTeamProtocol('{"normal":"json"}')).toBe(false);
  expect(looksLikeTeamProtocol("ordinary commentary")).toBe(false);
});

it("turns a structured plan into readable work and completion checks", () => {
  const text = `\`\`\`json
${JSON.stringify({
  acceptance: ["All tests pass", "The status reflects the active attempt"],
  tasks: [
    {
      id: "update-status",
      objective: "Update the status projection",
      acceptance: ["Active attempts show their current role."],
      dependencies: [],
      context: "Keep internal notes private.",
    },
  ],
  rationale: "The paused run retained a stale worker status.",
})}
\`\`\``;

  const summary = teamProtocolSummary("plan", text)!;
  expect(summary).toContain("The paused run retained a stale worker status.");
  expect(summary).toContain("Planned work:\n- Update the status projection");
  expect(summary).toContain(
    "Completion checks:\n- All tests pass\n- The status reflects the active attempt",
  );
  expect(summary).not.toContain('"acceptance"');
  expect(summary).not.toContain("Keep internal notes private.");
});

it("shows only the useful worker report and limitations", () => {
  const summary = teamProtocolSummary(
    "worker",
    JSON.stringify({
      summary: "The worker now reports completion from its latest attempt.",
      commit: "abc1234",
      changedFiles: ["TeamConversation.tsx"],
      checks: [{ command: "vp", args: ["test", "run"], outcome: "passed" }],
      limitations: ["The browser path has not been verified."],
    }),
  )!;

  expect(summary).toContain("The worker now reports completion from its latest attempt.");
  expect(summary).toContain("Limitations:\n- The browser path has not been verified.");
  expect(summary).not.toContain("abc1234");
  expect(summary).not.toContain("changedFiles");
  expect(summary).not.toContain("checks");
});

it("preserves worker progress prose and summarizes a complete trailing fenced result", () => {
  const prose =
    "Sent the lead two reconciliation replies after checking both requested changes. Worktree is clean, nothing uncommitted.";
  const result = {
    summary: "The worker completed the reconciliation and confirmed a clean worktree.",
    commit: "edc359be86d21d45eb48f9d3eb57600bd686a72b",
    changedFiles: ["src/reconcile.ts"],
    checks: [{ command: "vp", args: ["test", "run"], outcome: "passed" }],
    limitations: ["The integrated browser pass is still pending."],
  };
  const text = `${prose}\n\n\`\`\`json\n${JSON.stringify(result, null, 2)}\n\`\`\``;

  expect(teamProtocolSummary("worker", text)).toBe(
    `${prose}\n\n${result.summary}\n\nLimitations:\n- The integrated browser pass is still pending.`,
  );
  expect(teamProtocolSummary("worker", text)).not.toContain('"changedFiles"');
  expect(
    teamProtocolSummary("worker", `${prose}\n\n\`\`\`json\n{"summary":"Partial example"}\n\`\`\``),
  ).toBeNull();
});

it("recognizes every managed protocol role and worker result keys", () => {
  expect(["plan", "worker", "review", "integrate"].every(isTeamProtocolRole)).toBe(true);
  expect(looksLikeTeamProtocol('{"commit":"abc1234","summary":"Done"}')).toBe(true);
  expect(looksLikeTeamProtocol("I am checking the worker result now.")).toBe(false);
});

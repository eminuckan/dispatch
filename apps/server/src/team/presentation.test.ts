import { expect, it } from "vite-plus/test";
import {
  CommandId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type TeamRun,
  type TeamExecutionTurn,
} from "@t3tools/contracts";
import { teamThreadView } from "./presentation.ts";
import { defaultTeamPolicy } from "./routing.ts";
const profile = {
  id: "p",
  label: "Luna max",
  selection: { instanceId: ProviderInstanceId.make("codex"), model: "luna" },
  tier: "economy" as const,
  lead: true,
  worker: true,
  estimatedAttemptUsd: null,
};
const turn = (role: TeamExecutionTurn["role"], result: string | null): TeamExecutionTurn => ({
  id: role,
  role,
  taskId: null,
  result,
  succeeded: true,
  status: "settled",
  command: {
    type: "thread.turn.start",
    commandId: CommandId.make(role),
    threadId: ThreadId.make("lead"),
    message: {
      messageId: MessageId.make(role),
      role: "user",
      text: "INTERNAL_PROMPT",
      attachments: [],
    },
    modelSelection: profile.selection,
    runtimeMode: "full-access",
    interactionMode: "default",
    createdAt: "now",
  },
});
const run: TeamRun = {
  id: "r",
  commandId: "c",
  projectId: ProjectId.make("p"),
  revision: 2,
  objective: "Rename heading",
  policy: { ...defaultTeamPolicy, profiles: [profile] },
  lead: profile,
  status: "completed",
  tasks: [
    {
      id: "t",
      objective: "Rename",
      acceptance: ["Heading correct"],
      dependencies: [],
      profileId: "p",
      status: "accepted",
      generation: 0,
      attempts: 1,
      threadId: ThreadId.make("worker"),
      context: "INTERNAL_CONTEXT",
      result: "done",
    },
  ],
  decisions: ["INTERNAL_DECISION"],
  createdAt: "now",
  updatedAt: "now",
  execution: {
    workspaceRoot: "/repo",
    baseCommit: "abc",
    leadThreadId: ThreadId.make("lead"),
    maxTurns: 10,
    phase: "done",
    notice: "Verified the heading.",
    turns: [
      turn("plan", '{"tasks":[],"context":"INTERNAL_CONTEXT"}'),
      turn(
        "review",
        '{"action":"accept","summary":"Heading checked.","checks":[{"command":"INTERNAL_COMMAND"}]}',
      ),
      turn("worker", 'A normal JSON example: {"action":"accept"}'),
    ],
  },
};
it("projects readable results without coordination prompts, context or executable checks", () => {
  const view = teamThreadView(run)!;
  expect(view.turns.map((t) => t.summary)).toEqual([
    null,
    "Heading checked.",
    'A normal JSON example: {"action":"accept"}',
  ]);
  expect(JSON.stringify(view)).not.toContain("INTERNAL_");
  expect(view.notice).toBe("Verified the heading.");
  expect(view.tasks[0]?.status).toBe("accepted");
});
it("does not expose malformed coordination output or treat it as a verified summary", () => {
  const view = teamThreadView({
    ...run,
    status: "paused",
    execution: {
      ...run.execution!,
      phase: "workers",
      notice: "Review needs correction.",
      turns: [
        turn("review", "not valid JSON INTERNAL_COMMAND"),
        { ...turn("integrate", null), succeeded: false, status: "dispatched" },
      ],
    },
  })!;
  expect(view.turns.every((t) => t.summary === null)).toBe(true);
  expect(view.status).toBe("paused");
  expect(view.turns[1]?.status).toBe("dispatched");
  expect(view.notice).toBe("Review needs correction.");
});
it("returns no managed view for missing or unbootstrapped runs", () => {
  expect(teamThreadView(null)).toBeNull();
  const { execution: _, ...unbootstrapped } = run;
  expect(teamThreadView(unbootstrapped)).toBeNull();
});

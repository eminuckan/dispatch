import { expect, it } from "vite-plus/test";
import {
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type TeamAttempt,
  type TeamRun,
} from "@dispatch/contracts";

import {
  SMART_ROUTING_CONSERVATIVE_NOTICE,
  SMART_ROUTING_MODEL_ORDER_NOTICE,
  SMART_ROUTING_STANDARD_FALLBACK_NOTICE,
  teamThreadView,
} from "./presentation.ts";

import { TEAM_SUPERVISION_PROMPT_MARKER } from "@dispatch/shared/teamProtocolPresentation";

const profile = {
  id: "lead-profile",
  label: "Luna",
  selection: { instanceId: ProviderInstanceId.make("codex"), model: "luna" },
  lead: true,
  worker: true,
  capability: "frontier" as const,
};

const leadThreadId = ThreadId.make("team-lead");
const workerThreadId = ThreadId.make("team-worker");

const attempt = (
  role: TeamAttempt["role"],
  result: string | null,
  status: TeamAttempt["status"] = "succeeded",
): TeamAttempt => ({
  id: `attempt-${role}`,
  commandId: `command-${role}`,
  requestMessageId: MessageId.make(`message-${role}`),
  taskId: role === "work" ? "task-1" : null,
  role,
  sequence: 0,
  owner: {
    role: role === "work" ? "worker" : "lead",
    profileId: profile.id,
    threadId: role === "work" ? workerThreadId : leadThreadId,
    taskId: role === "work" ? "task-1" : null,
  },
  selection: profile.selection,
  prompt: `Internal ${role} prompt`,
  attachments: [],
  status,
  providerTurnId: null,
  resultMessageId: null,
  result,
  failure: null,
  createdAt: "now",
  updatedAt: "now",
});

const run: TeamRun = {
  id: "run",
  commandId: "command-run",
  projectId: ProjectId.make("project"),
  revision: 2,
  executionMode: "orchestrated",
  runtimeMode: "approval-required",
  prompt: "Rename heading",
  policy: {
    revision: 3,
    enabled: true,
    flowMode: "standard",
    profiles: [profile],
    maxActive: 3,
    maxAttempts: 2,
    providerLimitBehavior: "ask",
  },
  lead: { role: "lead", profileId: profile.id, threadId: leadThreadId, taskId: null },
  acceptance: ["Heading correct"],
  decisions: ["INTERNAL_DECISION"],
  status: "completed",
  statusReason: "Verified the heading.",
  workspace: {
    root: "/repo",
    baseCommit: "abc",
    integrationHead: "def",
    leadBranch: "team/lead",
    leadWorktreePath: "/repo/lead",
  },
  tasks: [
    {
      id: "task-1",
      objective: "Rename",
      acceptance: ["Heading correct"],
      dependencies: [],
      owner: {
        role: "worker",
        profileId: profile.id,
        threadId: workerThreadId,
        taskId: "task-1",
      },
      branch: "team/task-1",
      worktreePath: "/repo/task-1",
      status: "settled",
      attemptIds: ["attempt-work"],
      settlementId: null,
      result: "done",
    },
  ],
  attempts: [
    attempt(
      "plan",
      '{"acceptance":["Heading correct"],"tasks":[{"id":"rename-heading","objective":"Rename heading","acceptance":["Heading correct"],"dependencies":[],"context":"Update the visible heading."}],"rationale":"Check the heading."}',
    ),
    attempt("review", '{"action":"accept","summary":"Heading checked.","checks":[]}'),
    attempt("work", 'A normal JSON example: {"action":"accept"}'),
  ],
  messages: [],
  settlements: [],
  failovers: [],
  attachments: [],
  createdAt: "now",
  updatedAt: "now",
};

it("projects attempts and derives the lead profile from the frozen policy", () => {
  const view = teamThreadView(run)!;
  expect(view.lead).toEqual(profile);
  expect(view.executionMode).toBe("orchestrated");
  expect(view.leadThreadId).toBe(leadThreadId);
  expect(view.phase).toBe("done");
  expect(view.notice).toBe("Verified the heading.");
  expect(view.turns.map((turn) => [turn.role, turn.summary])).toEqual([
    [
      "plan",
      "Check the heading.\n\nPlanned work:\n- Rename heading\n\nCompletion checks:\n- Heading correct",
    ],
    ["review", "Heading checked."],
    ["worker", 'A normal JSON example: {"action":"accept"}'],
  ]);
});

it("projects the worker result summary instead of the settlement JSON", () => {
  const worker = attempt(
    "work",
    JSON.stringify({
      summary: "Updated the Flow activity statuses.",
      commit: "abc1234",
      changedFiles: ["TeamConversation.tsx"],
      checks: [],
      limitations: ["Integrated browser verification is pending."],
    }),
  );
  const view = teamThreadView({ ...run, attempts: [worker] })!;
  expect(view.turns[0]?.summary).toBe(
    "Updated the Flow activity statuses.\n\nLimitations:\n- Integrated browser verification is pending.",
  );
  expect(view.turns[0]?.summary).not.toContain("abc1234");
});

it("keeps freeform supervision updates visible in activity history", () => {
  const supervisor = {
    ...attempt("review", "The worker is blocked on a decision."),
    prompt: `${TEAM_SUPERVISION_PROMPT_MARKER}\nRead the mailbox and report useful progress.`,
  };
  const view = teamThreadView({ ...run, attempts: [supervisor] })!;
  expect(view.turns[0]?.summary).toBe("The worker is blocked on a decision.");
});

it("projects direct execution mode without changing internal lead ownership", () => {
  const view = teamThreadView({ ...run, executionMode: "direct" })!;
  expect(view.executionMode).toBe("direct");
  expect(view.leadOwner.role).toBe("lead");
});

it("surfaces a durable Auto-to-Standard fallback without turning it into an error status", () => {
  const view = teamThreadView({
    ...run,
    policy: { ...run.policy, flowMode: "standard" },
    status: "planning",
    statusReason: null,
    decisions: [SMART_ROUTING_STANDARD_FALLBACK_NOTICE],
  })!;
  expect(view.statusReason).toBeNull();
  expect(view.notice).toBe(SMART_ROUTING_STANDARD_FALLBACK_NOTICE);
});

it("does not advertise a Standard fallback for an Auto run with a stale decision notice", () => {
  const view = teamThreadView({
    ...run,
    executionMode: "direct",
    policy: { ...run.policy, flowMode: "auto" },
    status: "running",
    statusReason: null,
    decisions: [SMART_ROUTING_STANDARD_FALLBACK_NOTICE],
  })!;
  expect(view.executionMode).toBe("direct");
  expect(view.notice).toBeNull();
});

it("shows the conservative managed route and saved model choice while Auto stays selected", () => {
  const view = teamThreadView({
    ...run,
    policy: { ...run.policy, flowMode: "auto" },
    statusReason: null,
    decisions: [SMART_ROUTING_CONSERVATIVE_NOTICE, SMART_ROUTING_MODEL_ORDER_NOTICE],
  })!;
  expect(view.notice).toBe(
    `${SMART_ROUTING_CONSERVATIVE_NOTICE} ${SMART_ROUTING_MODEL_ORDER_NOTICE}`,
  );
});

it("keeps leadThreadId nullable and scopes the view to a worker thread before lead dispatch", () => {
  const workerOnly = {
    ...run,
    status: "running" as const,
    statusReason: null,
    lead: { ...run.lead, threadId: null },
    tasks: run.tasks.map((task) => ({ ...task, status: "running" as const })),
    attempts: [attempt("work", "working", "running")],
    settlements: [],
  };
  const view = teamThreadView(workerOnly)!;
  expect(view.threadId).toBe(workerThreadId);
  expect(view.leadThreadId).toBeNull();
  expect(view.phase).toBe("workers");
  expect(view.turns[0]).toMatchObject({ role: "worker", status: "dispatched", succeeded: false });
});

it("derives integration phase from settled tasks and settlement state", () => {
  const view = teamThreadView({
    ...run,
    status: "paused",
    statusReason: "Conflict requires attention.",
    settlements: [
      {
        id: "settlement-1",
        taskId: "task-1",
        attemptId: "attempt-work",
        owner: run.tasks[0]!.owner,
        sourceWorktreePath: "/repo/task-1",
        baseCommit: "abc",
        headCommit: "def",
        appliedCommit: null,
        status: "conflict",
        summary: "Conflict",
        createdAt: "now",
        updatedAt: "now",
      },
    ],
  })!;
  expect(view.phase).toBe("integrate");
  expect(view.notice).toBe("Conflict requires attention.");
});

it("returns null without a resolvable lead profile or managed thread scope", () => {
  expect(teamThreadView(null)).toBeNull();
  expect(teamThreadView({ ...run, policy: { ...run.policy, profiles: [] } })).toBeNull();
  expect(
    teamThreadView({
      ...run,
      lead: { ...run.lead, threadId: null },
      tasks: [],
      attempts: [],
    }),
  ).toBeNull();
});

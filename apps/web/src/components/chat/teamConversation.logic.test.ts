import { expect, it } from "vite-plus/test";
import {
  MessageId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type TeamAttempt,
  type TeamMessage,
  type TeamTask,
  type TeamThreadView,
} from "@dispatch/contracts";
import type { TimelineEntry } from "../../session-logic";
import {
  teamActivityAgents,
  teamAgentName,
  teamConversationMessages,
  teamConversationEntries,
  teamMailboxEntries,
  teamMessageDeliveryLabel,
  teamThreadComposerAccess,
  teamPrimaryRoleLabel,
  teamProviderDecisionState,
  teamThreadRoleForRun,
  teamTurnLabel,
} from "./teamConversation.logic";

const statusInstanceId = ProviderInstanceId.make("codex");
const statusLeadThreadId = ThreadId.make("lead");
const statusWorkerThreadId = ThreadId.make("worker");
const statusProfile = {
  id: "profile",
  label: "Luna",
  selection: { instanceId: statusInstanceId, model: "luna" },
  lead: true,
  worker: true,
};

function statusRun(overrides: Partial<TeamThreadView> = {}): TeamThreadView {
  return {
    id: "run",
    threadId: statusLeadThreadId,
    revision: 1,
    executionMode: "orchestrated",
    objective: "Build the feature",
    prompt: "Build the feature",
    status: "running",
    statusReason: null,
    profiles: [statusProfile],
    lead: statusProfile,
    leadOwner: {
      role: "lead",
      profileId: statusProfile.id,
      threadId: statusLeadThreadId,
      taskId: null,
    },
    leadThreadId: statusLeadThreadId,
    phase: "workers",
    notice: null,
    workspace: null,
    tasks: [],
    attempts: [],
    turns: [],
    messages: [],
    settlements: [],
    failovers: [],
    ...overrides,
  };
}

function statusTask(
  id: string,
  status: TeamTask["status"] = "running",
  overrides: Partial<TeamTask> = {},
): TeamTask {
  return {
    id,
    objective: id === "prepare" ? "Prepare shared types" : "Update Flow statuses",
    context: "Keep the existing panel structure.",
    acceptance: ["Active attempts show their current role."],
    dependencies: [],
    owner: {
      role: "worker",
      profileId: statusProfile.id,
      threadId: statusWorkerThreadId,
      taskId: id,
    },
    branch: null,
    worktreePath: null,
    status,
    attemptIds: [`work-${id}`],
    settlementId: null,
    result: null,
    ...overrides,
  };
}

function statusAttempt(
  role: TeamAttempt["role"],
  status: TeamAttempt["status"],
  taskId: string | null,
): TeamAttempt {
  const id = `${role}-${taskId ?? "lead"}`;
  return {
    id,
    commandId: `command-${id}`,
    requestMessageId: MessageId.make(`team-${id}`),
    taskId,
    role,
    sequence: 0,
    owner: {
      role: role === "work" ? "worker" : "lead",
      profileId: statusProfile.id,
      threadId: taskId ? statusWorkerThreadId : statusLeadThreadId,
      taskId,
    },
    selection: statusProfile.selection,
    prompt:
      role === "review" && taskId === null
        ? "DISPATCH_FLOW_SUPERVISION_V1\ninternal prompt"
        : "internal prompt",
    attachments: [],
    status,
    providerTurnId: null,
    resultMessageId: null,
    result: null,
    failure: null,
    createdAt: "now",
    updatedAt: "now",
  };
}

type MessageTimelineEntry = Extract<TimelineEntry, { kind: "message" }>;

function message(
  id: string,
  role: "user" | "assistant",
  turn: string | null,
  text: string,
): MessageTimelineEntry {
  return {
    id,
    kind: "message",
    createdAt: "now",
    message: {
      id: MessageId.make(id),
      role,
      text,
      turnId: turn ? TurnId.make(turn) : null,
      streaming: false,
      createdAt: "now",
      updatedAt: "now",
    },
  };
}

function managedRequest(
  id: string,
  requestMessageId: string,
  role?: TeamAttempt["role"],
): Pick<TeamAttempt, "id" | "requestMessageId"> & Partial<Pick<TeamAttempt, "role">> {
  return {
    id,
    requestMessageId: MessageId.make(requestMessageId),
    ...(role === undefined ? {} : { role }),
  };
}

const protocolTurn: TeamThreadView["turns"][number] = {
  id: "review",
  role: "review",
  taskId: "task",
  threadId: ThreadId.make("lead"),
  model: "lead",
  status: "settled",
  succeeded: true,
  summary: "Check complete.",
  providerTurnId: TurnId.make("review-turn"),
  resultMessageId: MessageId.make("review-result"),
};

it("hides managed request prompts while keeping normal assistant output and follow-ups", () => {
  const entries = [
    message("internal", "user", "a", "hidden prompt"),
    message("progress", "assistant", "a", "Worker testlerini inceliyorum."),
    message("user", "user", "b", "Explain this JSON"),
    message("answer", "assistant", "b", "Normal follow-up answer"),
  ];
  expect(
    teamConversationEntries(entries, [managedRequest("attempt", "internal")]).map((e) => e.id),
  ).toEqual(["progress", "user", "answer"]);
});

it("keeps assistant/work history visible but hides queued managed requests", () => {
  const entries = [
    message("orphan", "assistant", "a", "hidden"),
    message("internal", "user", null, "queued control"),
    message("followup", "user", null, "my queued question"),
  ];
  expect(
    teamConversationEntries(entries, [managedRequest("attempt", "internal")]).map((e) => e.id),
  ).toEqual(["orphan", "followup"]);
});

it("keeps tool work attached to a user follow-up", () => {
  const entries: TimelineEntry[] = [
    message("user", "user", "b", "Inspect"),
    {
      id: "work",
      kind: "work",
      createdAt: "now",
      entry: {
        id: "work",
        label: "Read file",
        tone: "tool",
        createdAt: "now",
        turnId: TurnId.make("b"),
      },
    },
  ];
  expect(teamConversationEntries(entries, []).map((e) => e.id)).toEqual(["user", "work"]);
});

it("keeps a newly dispatched managed request and incomplete protocol hidden before ledger refresh", () => {
  const entries = [
    message("team-new-reservation", "user", "new-turn", "hidden contract"),
    message("new-answer", "assistant", "new-turn", '{"action":"accept"}'),
    message("manual", "user", "manual-turn", "Explain"),
  ];
  expect(teamConversationEntries(entries, []).map((entry) => entry.id)).toEqual(["manual"]);
});

it("presents the initial managed request in place so its attachment references survive", () => {
  const initial = message("team-plan", "user", null, "INTERNAL CONTRACT");
  initial.message = {
    ...initial.message,
    attachments: [
      {
        type: "image",
        id: "attachment-ref",
        name: "shot.png",
        mimeType: "image/png",
        sizeBytes: 42,
      },
    ],
  };
  const attempts = [managedRequest("plan", "team-plan")];
  const visible = teamConversationEntries([initial], attempts, [], {
    id: "team-plan",
    objective: "Inspect the attached screenshot",
  });
  expect(visible).toEqual([
    {
      ...initial,
      message: {
        ...initial.message,
        text: "Inspect the attached screenshot",
      },
    },
  ]);
  expect(visible[0]?.kind === "message" && visible[0].message.attachments).toEqual(
    initial.message.attachments,
  );
});

it("renders managed review protocol JSON as a normal assistant message", () => {
  const entries = [
    message("team-review", "user", null, "hidden review contract"),
    message(
      "review-result",
      "assistant",
      "review-turn",
      '{"action":"accept","summary":"Altı ölçüt karşılandı.","checks":[{"criterionIndex":0,"command":"vp","args":["test","run"]}]}',
    ),
  ];
  const visible = teamConversationEntries(
    entries,
    [managedRequest("review", "team-review")],
    [protocolTurn],
  );
  expect(visible).toHaveLength(1);
  expect(visible[0]?.kind).toBe("message");
  if (visible[0]?.kind === "message")
    expect(visible[0].message.text).toBe("Altı ölçüt karşılandı.");
});

it("renders managed planning JSON without exposing the protocol object", () => {
  const entries = [
    message(
      "plan-progress",
      "assistant",
      "plan-turn",
      "I found two independent work items; the acceptance checks are below.",
    ),
    message(
      "plan-intermediate",
      "assistant",
      "plan-turn",
      '{"acceptance":["Works"],"tasks":[{"id":"runtime","objective":"Runtimeı güncelle","acceptance":["Checks pass"],"dependencies":[],"context":"private worker notes"},{"id":"ui","objective":"UIyi doğrula","acceptance":["The UI is clear"],"dependencies":[],"context":"Only useful UI work"}],"rationale":"İki bağımsız iş yeterli."}',
    ),
  ];
  const planTurn = {
    ...protocolTurn,
    id: "plan",
    role: "plan" as const,
    providerTurnId: TurnId.make("plan-turn"),
    resultMessageId: MessageId.make("plan-result"),
  };
  const visible = teamConversationEntries(entries, [], [planTurn]);
  expect(visible).toHaveLength(2);
  expect(visible[0]).toBe(entries[0]);
  expect(visible[1]?.kind).toBe("message");
  if (visible[1]?.kind !== "message") throw new Error("Expected message");
  expect(visible[1].message.text).toContain("İki bağımsız iş yeterli.");
  expect(visible[1].message.text).toContain("Planned work:\n- Runtimeı güncelle");
  expect(visible[1].message.text).toContain("Completion checks:\n- Works");
  expect(visible[1].message.text).not.toContain('"acceptance"');
  expect(visible[1].message.text).not.toContain("private worker notes");
});

it("renders a valid scope response as its concise summary", () => {
  const scope = {
    summary: "The request separates into two useful areas with a shared acceptance check.",
    independentAreas: ["Inspect server flow", "Present the Lead response"],
    risks: ["Scope and plan use the same wire role."],
    acceptance: ["The Lead timeline shows a concise summary."],
  };
  const response = message("scope-result", "assistant", "scope-turn", JSON.stringify(scope));
  const scopeTurn = {
    ...protocolTurn,
    id: "scope-attempt",
    role: "plan" as const,
    taskId: null,
    providerTurnId: TurnId.make("scope-turn"),
    resultMessageId: MessageId.make("scope-result"),
  };
  const visible = teamConversationEntries(
    [message("team-scope", "user", "scope-turn", "internal scope prompt"), response],
    [managedRequest("scope-attempt", "team-scope", "scope")],
    [scopeTurn],
    { id: "team-scope", objective: "Implement the requested change." },
    "lead",
  );

  expect(visible).toHaveLength(2);
  expect(visible[0]?.kind === "message" && visible[0].message.text).toBe(
    "Implement the requested change.",
  );
  expect(visible[1]?.kind === "message" && visible[1].message.text).toBe(scope.summary);
  expect(visible[1]?.kind === "message" && visible[1].message.text).not.toContain(
    "independentAreas",
  );
  expect(visible[1]?.kind === "message" && visible[1].message.text).not.toContain('"risks"');
});

it("keeps a malformed completed scope response distinguishable", () => {
  const response = message(
    "scope-result",
    "assistant",
    "scope-turn",
    JSON.stringify({
      summary: "Incomplete scope response.",
      independentAreas: [],
      risks: [],
      acceptance: [],
    }),
  );
  const scopeTurn = {
    ...protocolTurn,
    id: "scope-attempt",
    role: "plan" as const,
    taskId: null,
    providerTurnId: TurnId.make("scope-turn"),
    resultMessageId: MessageId.make("scope-result"),
  };
  const visible = teamConversationEntries(
    [response],
    [managedRequest("scope-attempt", "team-scope", "scope")],
    [scopeTurn],
  );

  expect(visible[0]?.kind === "message" && visible[0].message.text).toBe(
    "The lead’s structured response could not be read. Check the team status in Agents.",
  );
  expect(visible[0]?.kind === "message" && visible[0].message.text).not.toContain(
    "Incomplete scope response.",
  );
});

it("infers and summarizes a scope response in a managed Lead thread before team metadata arrives", () => {
  const scope = {
    summary: "The Lead found two bounded areas worth routing.",
    independentAreas: ["Area A", "Area B"],
    risks: [],
    acceptance: ["Both areas remain within scope."],
  };
  const response = message("scope-result", "assistant", "scope-turn", JSON.stringify(scope));

  expect(teamConversationEntries([response], [], [], undefined, "lead")[0]).toEqual({
    ...response,
    message: { ...response.message, text: scope.summary },
  });
});

it("normalizes an exact managed worker result and preserves ordinary commentary", () => {
  const result = message(
    "worker-result",
    "assistant",
    "worker-turn",
    JSON.stringify({
      commit: "abc1234",
      summary: "Updated the Flow activity statuses.",
      changedFiles: ["TeamConversation.tsx"],
      checks: [],
      limitations: ["Browser verification remains pending."],
    }),
  );
  const commentary = message(
    "worker-commentary",
    "assistant",
    "worker-turn",
    "The worker is checking the settlement now.",
  );
  const turn: TeamThreadView["turns"][number] = {
    ...protocolTurn,
    id: "work-attempt",
    role: "worker",
    taskId: "task",
    threadId: ThreadId.make("worker"),
    providerTurnId: TurnId.make("worker-turn"),
    resultMessageId: MessageId.make("worker-result"),
  };
  const visible = teamConversationEntries(
    [commentary, result],
    [managedRequest("work-attempt", "team-work-attempt")],
    [turn],
  );
  expect(visible[0]).toBe(commentary);
  expect(visible[1]?.kind === "message" && visible[1].message.text).toContain(
    "Updated the Flow activity statuses.",
  );
  expect(visible[1]?.kind === "message" && visible[1].message.text).not.toContain("abc1234");
});

it("derives lead and worker states from current attempts before stale run and task status", () => {
  const task = statusTask("work");
  const pausedWithLiveAttempts = statusRun({
    status: "paused",
    tasks: [task],
    attempts: [statusAttempt("review", "running", null), statusAttempt("work", "running", task.id)],
  });
  expect(teamActivityAgents(pausedWithLiveAttempts).map(({ status }) => status)).toEqual([
    "supervising",
    "running",
  ]);
  expect(
    teamActivityAgents(
      statusRun({ status: "paused", attempts: [statusAttempt("review", "reserved", null)] }),
    )[0]?.status,
  ).toBe("supervising");

  expect(
    teamActivityAgents(
      statusRun({
        status: "running",
        tasks: [task],
        attempts: [
          statusAttempt("review", "succeeded", null),
          statusAttempt("work", "running", task.id),
        ],
      }),
    )[0]?.status,
  ).toBe("supervising");
  expect(
    teamActivityAgents(
      statusRun({ status: "paused", attempts: [statusAttempt("review", "failed", null)] }),
    )[0]?.status,
  ).toBe("paused");
  expect(
    teamActivityAgents(
      statusRun({
        status: "paused",
        attempts: [{ ...statusAttempt("review", "running", null), prompt: "old unmarked review" }],
      }),
    )[0]?.status,
  ).toBe("reviewing");

  const pausedAfterWorkerCompletion = statusRun({
    status: "paused",
    tasks: [task],
    attempts: [statusAttempt("work", "succeeded", task.id)],
  });
  expect(teamActivityAgents(pausedAfterWorkerCompletion)[1]?.status).toBe("needs attention");

  const failedWorker = statusRun({
    status: "paused",
    tasks: [statusTask("work", "failed")],
    attempts: [statusAttempt("work", "failed", "work")],
  });
  expect(teamActivityAgents(failedWorker)[1]?.status).toBe("failed");

  const activeRetry = statusRun({
    status: "paused",
    tasks: [statusTask("work", "failed")],
    attempts: [statusAttempt("work", "running", "work")],
  });
  expect(teamActivityAgents(activeRetry)[1]?.status).toBe("running");

  expect(teamActivityAgents(statusRun())[0]?.status).toBe("supervising");
  expect(teamActivityAgents(statusRun({ status: "paused" }))[0]?.status).toBe("paused");
});

it("prefers a selected native lead turn over paused run status until that turn settles", () => {
  const paused = statusRun({ status: "paused" });
  expect(
    teamActivityAgents(paused, {
      threadId: statusLeadThreadId,
      runningTurnId: "manual-provider-turn",
    })[0]?.status,
  ).toBe("running");
  expect(
    teamActivityAgents(paused, {
      threadId: statusWorkerThreadId,
      runningTurnId: "worker-provider-turn",
    })[0]?.status,
  ).toBe("paused");
  expect(
    teamActivityAgents(paused, { threadId: statusLeadThreadId, runningTurnId: null })[0]?.status,
  ).toBe("paused");
});

it("exposes task contract details and names mailbox participants", () => {
  const prep = statusTask("prepare", "settled", {
    owner: { ...statusTask("prepare").owner, threadId: null },
    acceptance: ["Shared types compile."],
  });
  const work = statusTask("work", "pending", {
    dependencies: ["prepare"],
    context: "The shared type has landed.",
    acceptance: ["The worker reports only useful progress."],
  });
  const message: TeamMessage = {
    id: "mail-1",
    from: {
      role: "lead",
      profileId: statusProfile.id,
      threadId: statusLeadThreadId,
      taskId: null,
    },
    to: work.owner,
    text: "Please include the result summary.",
    replyRequested: true,
    createdAt: "2026-09-23T00:00:00.000Z",
    readAt: null,
  };
  const run = statusRun({ tasks: [prep, work], messages: [message] });
  const agents = teamActivityAgents(run);
  expect(agents[2]).toMatchObject({
    context: "The shared type has landed.",
    acceptance: ["The worker reports only useful progress."],
    dependencies: ["Prepare shared types"],
    status: "queued",
  });
  expect(teamMailboxEntries(run)).toEqual([
    {
      message,
      from: teamAgentName(run, statusLeadThreadId),
      to: teamAgentName(run, statusWorkerThreadId),
    },
  ]);
  expect(teamConversationMessages(run, statusLeadThreadId)).toEqual([
    {
      id: message.id,
      createdAt: message.createdAt,
      text: message.text,
      from: teamAgentName(run, statusLeadThreadId),
      to: teamAgentName(run, statusWorkerThreadId),
      deliveryStatus: null,
      providerMessageId: null,
    },
  ]);
  expect(teamConversationMessages(run, statusWorkerThreadId)).toHaveLength(1);
  expect(teamConversationMessages(run, "unrelated-thread")).toEqual([]);
  expect(teamThreadRoleForRun(run, statusLeadThreadId)).toBe("lead");
  expect(teamThreadRoleForRun(run, statusWorkerThreadId)).toBe("worker");
  expect(teamThreadRoleForRun(run, "unrelated-thread")).toBeNull();
});

it("fails closed while managed-thread ownership loads, then trusts exact run membership", () => {
  const leadThreadId = ThreadId.make("team-lead");
  const workerThreadId = ThreadId.make("team-worker");
  const run = statusRun({
    leadThreadId,
    tasks: [
      statusTask("worker-task", "running", {
        owner: {
          role: "worker",
          profileId: statusProfile.id,
          threadId: workerThreadId,
          taskId: "worker-task",
        },
      }),
    ],
  });

  expect(teamThreadComposerAccess("team-worker", null, false)).toBe("checking");
  expect(teamThreadComposerAccess(workerThreadId, run, true)).toBe("worker");
  expect(teamThreadComposerAccess(leadThreadId, run, true)).toBe("lead");
  expect(teamThreadComposerAccess("team-unrelated", run, true)).toBeNull();
  expect(teamThreadComposerAccess("ordinary-thread", null, false)).toBeNull();
});

it("maps persisted delivery receipts without treating read state as delivery", () => {
  expect(teamMessageDeliveryLabel(null)).toBeNull();
  expect(teamMessageDeliveryLabel("pending")).toBe("Waiting for dispatch");
  expect(teamMessageDeliveryLabel("queued")).toBe("Waiting for a safe handoff");
  expect(teamMessageDeliveryLabel("steered")).toBe("Added to the active turn");
  expect(teamMessageDeliveryLabel("sent")).toBe("Accepted by agent");
  expect(teamMessageDeliveryLabel("failed")).toBe("Delivery failed");
  expect(teamMessageDeliveryLabel("closed")).toBe("Flow ended before delivery");
});

it("rewrites only the exact managed final response and preserves commentary or manual JSON", () => {
  const json =
    '{"action":"correct","summary":"Add the missing timeout check.","checks":[{"criterionIndex":0,"command":"PRIVATE_COMMAND","args":[]}]}';
  const entries = [
    message("commentary", "assistant", "review-turn", json),
    message("review-result", "assistant", "review-turn", json),
    message("manual", "assistant", "manual-turn", json),
  ];
  const visible = teamConversationEntries(entries, [], [protocolTurn]);
  expect(visible[0]).toBe(entries[0]);
  expect(visible[1]).toEqual({
    ...entries[1],
    message: { ...entries[1]!.message, text: "Add the missing timeout check." },
  });
  expect(visible[2]).toBe(entries[2]);
});

it("keeps worker progress prose while formatting its trailing structured result", () => {
  const prose =
    "Sent the lead two reconciliation replies after checking both requested changes. Worktree is clean, nothing uncommitted.";
  const result = {
    summary: "The worker completed the reconciliation and confirmed a clean worktree.",
    commit: "edc359be86d21d45eb48f9d3eb57600bd686a72b",
    changedFiles: ["src/reconcile.ts"],
    checks: [{ command: "vp", args: ["test", "run"], outcome: "passed" }],
    limitations: ["The integrated browser pass is still pending."],
  };
  const raw = `${prose}\n\n\`\`\`json\n${JSON.stringify(result, null, 2)}\n\`\`\``;
  const workerProgress = message("worker-progress-result", "assistant", null, raw);
  const visible = teamConversationEntries([workerProgress], [], [], undefined, "worker");

  expect(visible[0]).toEqual({
    ...workerProgress,
    message: {
      ...workerProgress.message,
      text: `${prose}\n\n${result.summary}\n\nLimitations:\n- The integrated browser pass is still pending.`,
    },
  });
  expect(JSON.stringify(visible)).not.toContain('"changedFiles"');
});

it("suppresses only protocol-shaped streaming output for a known managed turn", () => {
  const turn = { ...protocolTurn, resultMessageId: null, status: "dispatched" as const };
  const partial = message("partial", "assistant", "review-turn", '{"action":"correct","summary":"');
  partial.message = { ...partial.message, streaming: true };
  const progress = message(
    "progress",
    "assistant",
    "review-turn",
    "Checking the timeout behavior.",
  );
  progress.message = { ...progress.message, streaming: true };
  expect(teamConversationEntries([progress, partial], [], [turn])).toEqual([progress]);
});

it("replaces malformed completed managed protocol output instead of leaking it", () => {
  const broken = message(
    "review-result",
    "assistant",
    "review-turn",
    '{"action":"correct","checks":',
  );
  const visible = teamConversationEntries([broken], [], [protocolTurn]);
  expect(visible[0]?.kind === "message" && visible[0].message.text).toBe(
    "The lead’s structured response could not be read. Check the team status in Agents.",
  );
});

it("does not confuse a finished worker response with lead acceptance", () => {
  const workerThreadId = ThreadId.make("worker");
  const worker: TeamThreadView["turns"][number] = {
    id: "work-attempt",
    role: "worker",
    taskId: "task",
    threadId: workerThreadId,
    model: "luna",
    status: "settled",
    succeeded: true,
    summary: "Done",
    providerTurnId: null,
    resultMessageId: null,
  };
  const run: TeamThreadView = {
    id: "run",
    threadId: ThreadId.make("lead"),
    revision: 0,
    executionMode: "orchestrated",
    objective: "Build",
    prompt: "Build",
    status: "running",
    statusReason: null,
    profiles: [
      {
        id: "profile",
        label: "Luna",
        selection: { instanceId: ProviderInstanceId.make("codex"), model: "luna" },
        lead: true,
        worker: true,
      },
    ],
    lead: {
      id: "profile",
      label: "Luna",
      selection: { instanceId: ProviderInstanceId.make("codex"), model: "luna" },
      lead: true,
      worker: true,
    },
    leadOwner: {
      role: "lead",
      profileId: "profile",
      threadId: ThreadId.make("lead"),
      taskId: null,
    },
    leadThreadId: ThreadId.make("lead"),
    phase: "workers",
    notice: null,
    workspace: null,
    tasks: [
      {
        id: "task",
        objective: "Build",
        acceptance: ["Works"],
        dependencies: [],
        owner: {
          role: "worker",
          profileId: "profile",
          threadId: workerThreadId,
          taskId: "task",
        },
        branch: null,
        worktreePath: null,
        status: "review",
        attemptIds: [worker.id],
        settlementId: null,
        result: "Done",
      },
    ],
    attempts: [],
    turns: [worker],
    messages: [],
    settlements: [],
    failovers: [],
  };
  expect(teamTurnLabel(run, worker)).toBe("reported result");
  const accepted: TeamThreadView = {
    ...run,
    tasks: run.tasks.map((task) => ({ ...task, status: "settled" as const })),
  };
  expect(teamTurnLabel(accepted, worker)).toBe("accepted by lead");
  expect(teamTurnLabel(run, { ...worker, status: "reserved" })).toBe("queued");
  expect(teamTurnLabel(run, { ...worker, status: "dispatched" })).toBe("working");
  expect(teamTurnLabel(run, { ...worker, succeeded: false })).toBe("needs attention");
  expect(teamTurnLabel({ ...accepted, turns: [worker, { ...worker, id: "retry" }] }, worker)).toBe(
    "reported result",
  );
});

it("labels the primary actor as Direct only for direct execution", () => {
  expect(teamPrimaryRoleLabel({ executionMode: "direct" })).toBe("Direct");
  expect(teamPrimaryRoleLabel({ executionMode: "orchestrated" })).toBe("Lead");
});

it("resolves the latest pending provider failover and candidate profile labels in configured order", () => {
  const instanceId = ProviderInstanceId.make("codex");
  const profiles: TeamThreadView["profiles"] = [
    {
      id: "current",
      label: "Current model",
      selection: { instanceId, model: "current" },
      lead: true,
      worker: true,
    },
    {
      id: "alt-b",
      label: "Alternate B",
      selection: { instanceId, model: "b" },
      lead: true,
      worker: true,
    },
    {
      id: "alt-a",
      label: "Alternate A",
      selection: { instanceId, model: "a" },
      lead: true,
      worker: true,
    },
  ];
  const failovers: TeamThreadView["failovers"] = [
    {
      id: "old",
      taskId: null,
      attemptId: "attempt-old",
      fromProfileId: "current",
      candidateProfileIds: ["alt-a"],
      trigger: {
        kind: "provider-limit",
        providerInstanceId: instanceId,
        limitId: "weekly",
        detail: "Old limit",
      },
      status: "applied",
      decision: null,
      createdAt: "before",
      updatedAt: "before",
    },
    {
      id: "pending",
      taskId: null,
      attemptId: "attempt-new",
      fromProfileId: "current",
      candidateProfileIds: ["missing", "alt-b", "alt-a"],
      trigger: {
        kind: "provider-unavailable",
        providerInstanceId: instanceId,
        limitId: null,
        detail: "Provider unavailable",
      },
      status: "pending",
      decision: null,
      createdAt: "now",
      updatedAt: "now",
    },
  ];

  const state = teamProviderDecisionState({
    status: "awaiting-provider-decision",
    profiles,
    failovers,
  });
  expect(state?.failover.id).toBe("pending");
  expect(state?.currentProfile?.label).toBe("Current model");
  expect(state?.candidates.map((profile) => profile.label)).toEqual(["Alternate B", "Alternate A"]);
  expect(teamProviderDecisionState({ status: "running", profiles, failovers })).toBeNull();
});

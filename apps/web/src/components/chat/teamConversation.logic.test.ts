import { expect, it } from "vite-plus/test";
import {
  MessageId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type TeamAttempt,
  type TeamThreadView,
} from "@dispatch/contracts";
import type { TimelineEntry } from "../../session-logic";
import {
  teamConversationEntries,
  teamPrimaryRoleLabel,
  teamProviderDecisionState,
  teamTurnLabel,
} from "./teamConversation.logic";

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
): Pick<TeamAttempt, "id" | "requestMessageId"> {
  return { id, requestMessageId: MessageId.make(requestMessageId) };
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
      '{"action":"accept","summary":"Altı ölçüt karşılandı.","checks":[{"criterionIndex":0}]}',
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
      "plan-result",
      "assistant",
      "plan-turn",
      '{"acceptance":["Works"],"tasks":[{"objective":"Runtimeı güncelle"},{"objective":"UIyi doğrula"}],"rationale":"İki bağımsız iş yeterli."}',
    ),
  ];
  const visible = teamConversationEntries(
    entries,
    [],
    [
      {
        ...protocolTurn,
        id: "plan",
        role: "plan",
        providerTurnId: TurnId.make("plan-turn"),
        resultMessageId: MessageId.make("plan-result"),
      },
    ],
  );
  expect(visible).toHaveLength(1);
  if (visible[0]?.kind !== "message") throw new Error("Expected message");
  expect(visible[0].message.text).toContain("İki bağımsız iş yeterli.");
  expect(visible[0].message.text).toContain("- Runtimeı güncelle");
  expect(visible[0].message.text).not.toContain('"acceptance"');
});

it("rewrites only the exact managed final response and preserves commentary or manual JSON", () => {
  const json =
    '{"action":"correct","summary":"Add the missing timeout check.","checks":[{"command":"PRIVATE_COMMAND"}]}';
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

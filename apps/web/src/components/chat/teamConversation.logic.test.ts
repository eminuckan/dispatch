import { expect, it } from "vite-plus/test";
import {
  MessageId,
  TurnId,
  ThreadId,
  ProviderInstanceId,
  type TeamThreadView,
} from "@t3tools/contracts";
import type { TimelineEntry } from "../../session-logic";
import { teamConversationEntries, teamTurnLabel } from "./teamConversation.logic";
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

const protocolTurn: TeamThreadView["turns"][number] = {
  id: "review",
  role: "review",
  taskId: "task",
  threadId: ThreadId.make("lead"),
  model: "lead",
  effort: "high",
  status: "settled",
  succeeded: true,
  summary: "Check complete.",
  providerTurnId: TurnId.make("review-turn"),
  resultMessageId: MessageId.make("review-result"),
};
it("hides coordination prompts while keeping normal managed assistant output and follow-ups", () => {
  const entries = [
    message("internal", "user", "a", "hidden prompt"),
    message("progress", "assistant", "a", "Worker testlerini inceliyorum."),
    message("user", "user", "b", "Explain this JSON"),
    message("answer", "assistant", "b", "Normal follow-up answer"),
  ];
  expect(teamConversationEntries(entries, ["internal"]).map((e) => e.id)).toEqual([
    "progress",
    "user",
    "answer",
  ]);
});
it("keeps assistant/work history visible but hides queued internal messages", () => {
  const entries = [
    message("orphan", "assistant", "a", "hidden"),
    message("internal", "user", null, "queued control"),
    message("followup", "user", null, "my queued question"),
  ];
  expect(teamConversationEntries(entries, ["internal"]).map((e) => e.id)).toEqual([
    "orphan",
    "followup",
  ]);
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

it("keeps a newly dispatched coordination turn and incomplete protocol hidden before ledger refresh", () => {
  const entries = [
    message("team-new-reservation", "user", "new-turn", "hidden contract"),
    message("new-answer", "assistant", "new-turn", '{"action":"accept"}'),
    message("manual", "user", "manual-turn", "Explain"),
  ];
  expect(teamConversationEntries(entries, []).map((entry) => entry.id)).toEqual(["manual"]);
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
  const visible = teamConversationEntries(entries, ["team-review"], [protocolTurn]);
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
  const turn = { ...protocolTurn, resultMessageId: undefined, status: "dispatched" as const };
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
  const worker = {
    id: "turn",
    role: "worker",
    taskId: "task",
    threadId: ThreadId.make("worker"),
    model: "luna",
    effort: "max",
    status: "settled",
    succeeded: true,
    summary: "Done",
  } as const;
  const run: TeamThreadView = {
    id: "run",
    coordinationMessageIds: [],
    revision: 0,
    objective: "Build",
    status: "running",
    lead: {
      id: "profile",
      label: "Luna",
      selection: { instanceId: ProviderInstanceId.make("codex"), model: "luna" },
      tier: "economy",
      lead: true,
      worker: true,
      estimatedAttemptUsd: null,
    },
    leadThreadId: ThreadId.make("lead"),
    phase: "workers",
    notice: null,
    maxTurns: 20,
    tasks: [
      {
        id: "task",
        objective: "Build",
        acceptance: ["Works"],
        dependencies: [],
        profileId: "profile",
        status: "review",
        generation: 0,
        attempts: 1,
        threadId: worker.threadId,
      },
    ],
    turns: [worker],
  };
  expect(teamTurnLabel(run, worker)).toBe("reported result");
  const accepted = {
    ...run,
    tasks: run.tasks.map((task) => ({ ...task, status: "accepted" as const })),
  };
  expect(teamTurnLabel(accepted, worker)).toBe("accepted by lead");
  expect(teamTurnLabel(run, { ...worker, status: "reserved" })).toBe("queued");
  expect(teamTurnLabel(run, { ...worker, status: "dispatched" })).toBe("working");
  expect(teamTurnLabel(run, { ...worker, succeeded: false })).toBe("needs attention");
  expect(teamTurnLabel({ ...accepted, turns: [worker, { ...worker, id: "retry" }] }, worker)).toBe(
    "reported result",
  );
});

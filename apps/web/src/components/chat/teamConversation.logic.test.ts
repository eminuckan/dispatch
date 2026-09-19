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
function message(
  id: string,
  role: "user" | "assistant",
  turn: string | null,
  text: string,
): Extract<TimelineEntry, { kind: "message" }> {
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
it("hides runtime prompts while retaining live assistant output and explicit user follow-ups", () => {
  const entries = [
    message("internal", "user", "a", "hidden prompt"),
    message("review", "assistant", "a", '{"action":"accept"}'),
    message("user", "user", "b", "Explain this JSON"),
    message("answer", "assistant", "b", '{"action":"accept"}'),
  ];
  expect(teamConversationEntries(entries, ["internal"]).map((e) => e.id)).toEqual([
    "review",
    "user",
    "answer",
  ]);
});
it("retains paged assistant fragments while hiding queued runtime prompts", () => {
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

it("shows a newly dispatched response before the ledger refresh arrives", () => {
  const entries = [
    message("team-new-reservation", "user", "new-turn", "hidden contract"),
    message("new-answer", "assistant", "new-turn", '{"action":"accept"}'),
    message("manual", "user", "manual-turn", "Explain"),
  ];
  expect(teamConversationEntries(entries, []).map((entry) => entry.id)).toEqual([
    "new-answer",
    "manual",
  ]);
});

it("keeps tool work from managed turns and without a loaded initiating message", () => {
  const work: TimelineEntry = {
    id: "work",
    kind: "work",
    createdAt: "now",
    entry: {
      id: "work",
      label: "Read file",
      tone: "tool",
      createdAt: "now",
      turnId: TurnId.make("managed"),
    },
  };
  expect(
    teamConversationEntries(
      [message("team-internal", "user", "managed", "instructions"), work],
      [],
    ),
  ).toEqual([work]);
});

it("replaces the initial runtime prompt with the task while retaining its attachments", () => {
  const entry = message("team-initial", "user", "managed", "internal prompt");
  entry.message = {
    ...entry.message,
    attachments: [
      { type: "image", id: "image", name: "image.png", mimeType: "image/png", sizeBytes: 42 },
    ],
  };
  const result = teamConversationEntries([entry], ["team-initial"], {
    id: "team-initial",
    objective: "Fix this",
  });
  expect(result).toEqual([
    {
      ...entry,
      message: { ...entry.message, text: "Fix this" },
    },
  ]);
  expect(teamConversationEntries([entry], ["team-initial"])).toEqual([]);
});

it("preserves streaming messages and pending interaction events without rewriting their identities", () => {
  const assistant = message("delta", "assistant", "managed", "Reading the source");
  assistant.message = { ...assistant.message, streaming: true };
  const question: TimelineEntry = {
    id: "question",
    kind: "work",
    createdAt: "now",
    entry: {
      id: "question",
      label: "Which option?",
      tone: "info",
      createdAt: "now",
      sourceActivityKind: "user-input.requested",
      turnId: TurnId.make("managed"),
    },
  };
  const result = teamConversationEntries([assistant, question], []);
  expect(result[0]).toBe(assistant);
  expect(result[1]).toBe(question);
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
  providerTurnId: TurnId.make("managed"),
  resultMessageId: MessageId.make("final"),
};
it("presents the canonical review as prose while preserving other JSON and commentary", () => {
  const json =
    '{"action":"correct","summary":"Add the missing timeout check.","checks":[{"command":"PRIVATE_COMMAND"}]}';
  const entries = [
    message("commentary", "assistant", "managed", json),
    message("final", "assistant", "managed", json),
    message("manual", "assistant", "manual", json),
    message("worker", "assistant", "worker", json),
  ];
  const result = teamConversationEntries(entries, [], undefined, [protocolTurn]);
  expect(result[0]).toBe(entries[0]);
  expect(result[1]).toEqual({
    ...entries[1],
    message: { ...entries[1]!.message, text: "Add the missing timeout check." },
  });
  expect(result[2]).toBe(entries[2]);
  expect(result[3]).toBe(entries[3]);
});
it("suppresses only partial protocol responses during a managed turn", () => {
  const turn = { ...protocolTurn, resultMessageId: undefined, status: "dispatched" as const };
  const partial = message("partial", "assistant", "managed", '{"action":"correct","summary":"');
  partial.message = { ...partial.message, streaming: true };
  const progress = message("progress", "assistant", "managed", "Checking the timeout behavior.");
  progress.message = { ...progress.message, streaming: true };
  expect(teamConversationEntries([progress, partial], [], undefined, [turn])).toEqual([progress]);
  expect(teamConversationEntries([partial], [], undefined, [{ ...turn, role: "worker" }])).toEqual([
    partial,
  ]);
});
it("presents a paged plan without its initial message or runtime context", () => {
  const plan = message(
    "final",
    "assistant",
    "managed",
    '```json\n{"tasks":[{"objective":"Fix startup","context":"PRIVATE_CONTEXT"}],"rationale":"I will check startup, then verify the connection.","acceptance":["PRIVATE_CONTRACT"]}\n```',
  );
  const result = teamConversationEntries([plan], [], undefined, [
    { ...protocolTurn, role: "plan" },
  ]);
  expect(result).toEqual([
    {
      ...plan,
      message: {
        ...plan.message,
        text: "I will check startup, then verify the connection.\n\n- Fix startup",
      },
    },
  ]);
});
it("does not leak a malformed completed protocol object", () => {
  const broken = message("final", "assistant", "managed", '{"action":"correct","checks":');
  const result = teamConversationEntries([broken], [], undefined, [protocolTurn]);
  expect(result[0]?.kind === "message" && result[0].message.text).toBe(
    "The lead’s structured response could not be read. Check the team status in Agents.",
  );
});

it("uses the exact initiating request until its receipt arrives, and stops at a manual follow-up", () => {
  const turn = {
    ...protocolTurn,
    providerTurnId: undefined,
    resultMessageId: undefined,
    status: "dispatched" as const,
  };
  const partial = message("new-final", "assistant", "new", '{"ac');
  partial.message = { ...partial.message, streaming: true };
  const user = message("manual", "user", null, "Explain this JSON");
  expect(
    teamConversationEntries(
      [
        message("team-review", "user", null, "INTERNAL"),
        partial,
        user,
        {
          ...partial,
          id: "manual-output",
          message: { ...partial.message, id: MessageId.make("manual-output") },
        },
      ],
      [],
      undefined,
      [turn],
    ).map((entry) => entry.id),
  ).toEqual(["manual", "manual-output"]);
});

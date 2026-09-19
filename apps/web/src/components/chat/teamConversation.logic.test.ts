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

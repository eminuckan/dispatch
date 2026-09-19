import { expect, it } from "vite-plus/test";
import { MessageId, TurnId } from "@t3tools/contracts";
import type { TimelineEntry } from "../../session-logic";
import { teamFollowUpEntries } from "./teamConversation.logic";
function message(
  id: string,
  role: "user" | "assistant",
  turn: string | null,
  text: string,
): TimelineEntry {
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
it("hides coordination turns while preserving explicit user follow-ups including JSON", () => {
  const entries = [
    message("internal", "user", "a", "hidden prompt"),
    message("review", "assistant", "a", '{"action":"accept"}'),
    message("user", "user", "b", "Explain this JSON"),
    message("answer", "assistant", "b", '{"action":"accept"}'),
  ];
  expect(teamFollowUpEntries(entries, ["internal"]).map((e) => e.id)).toEqual(["user", "answer"]);
});
it("does not reveal unidentified fragments or queued internal messages", () => {
  const entries = [
    message("orphan", "assistant", "a", "hidden"),
    message("internal", "user", null, "queued control"),
    message("followup", "user", null, "my queued question"),
  ];
  expect(teamFollowUpEntries(entries, ["internal"]).map((e) => e.id)).toEqual(["followup"]);
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
  expect(teamFollowUpEntries(entries, []).map((e) => e.id)).toEqual(["user", "work"]);
});

it("keeps a newly dispatched coordination turn hidden before the ledger refresh arrives", () => {
  const entries = [
    message("team-new-reservation", "user", "new-turn", "hidden contract"),
    message("new-answer", "assistant", "new-turn", '{"action":"accept"}'),
    message("manual", "user", "manual-turn", "Explain"),
  ];
  expect(teamFollowUpEntries(entries, []).map((entry) => entry.id)).toEqual(["manual"]);
});

import { expect, it } from "@effect/vitest";

import { settledFlowReceipt } from "./FlowReceipt.ts";

it("waits for a message-mode answer's continuation and uses its final turn", () => {
  const initial = { turnId: "turn-1", pendingMessageId: "flow-message-1", state: "completed" };
  const continuation = {
    turnId: "turn-2",
    pendingMessageId: "async-answer:question-1",
    state: "running",
  };
  const activities = [
    {
      turnId: "turn-1",
      kind: "user-input.requested",
      payload: { responseMode: "message", requestId: "question-1" },
    },
    { turnId: "turn-1", kind: "user-input.resolved", payload: { requestId: "question-1" } },
  ];
  expect(settledFlowReceipt([initial], initial, activities)).toBeNull();
  expect(settledFlowReceipt([initial, continuation], initial, activities)).toBeNull();
  expect(
    settledFlowReceipt([initial, { ...continuation, state: "completed" }], initial, activities),
  ).toEqual({ ...continuation, state: "completed" });
});

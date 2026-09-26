import * as Schema from "effect/Schema";
import { expect, it } from "vite-plus/test";

import { FlowWorker } from "./flow.ts";

const decodeWorker = Schema.decodeUnknownSync(FlowWorker);

const legacyWorker = {
  threadId: "flow-old",
  parentThreadId: "lead",
  assignment: "Review API",
  modelSelection: { instanceId: "codex", model: "gpt-test" },
  branch: "flow/flow-old",
  worktreePath: "/tmp/flow-old",
  state: "idle",
  error: null,
  latestJob: null,
  createdAt: "2026-09-25T00:00:00.000Z",
  updatedAt: "2026-09-25T00:00:00.000Z",
};

it("decodes workers from older environments as root Git workers", () => {
  expect(decodeWorker(legacyWorker).repositoryPath).toBe(".");
  expect(
    decodeWorker({
      ...legacyWorker,
      branch: null,
      worktreePath: null,
      repositoryPath: null,
    }).repositoryPath,
  ).toBeNull();
});

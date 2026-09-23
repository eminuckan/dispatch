import { describe, expect, it } from "vite-plus/test";
import { ThreadId, type TeamThreadView } from "@dispatch/contracts";
import { isTeamWorkerThreadCandidate, resolveTeamThreadComposerAccess } from "./teamThreadAccess";

const leadThreadId = ThreadId.make("team-run-lead");
const workerThreadId = ThreadId.make("team-run-worker-task");

function run() {
  return {
    leadThreadId,
    tasks: [{ owner: { threadId: workerThreadId } }],
  } as unknown as Pick<TeamThreadView, "leadThreadId" | "tasks">;
}

describe("mobile managed worker thread access", () => {
  it("identifies worker-shaped IDs while keeping canonical lead IDs on the normal composer path", () => {
    expect(isTeamWorkerThreadCandidate(workerThreadId)).toBe(true);
    expect(isTeamWorkerThreadCandidate(leadThreadId)).toBe(false);
    expect(isTeamWorkerThreadCandidate("ordinary-thread")).toBe(false);
  });

  it("fails closed until persisted run ownership is known, then blocks only worker members", () => {
    expect(
      resolveTeamThreadComposerAccess({
        threadId: workerThreadId,
        run: null,
        resolved: false,
        error: null,
      }),
    ).toBe("checking");
    expect(
      resolveTeamThreadComposerAccess({
        threadId: workerThreadId,
        run: null,
        resolved: false,
        error: "offline",
      }),
    ).toBe("unavailable");
    expect(
      resolveTeamThreadComposerAccess({
        threadId: workerThreadId,
        run: run(),
        resolved: true,
        error: null,
      }),
    ).toBe("worker");
    expect(
      resolveTeamThreadComposerAccess({
        threadId: leadThreadId,
        run: run(),
        resolved: true,
        error: null,
      }),
    ).toBeNull();
    expect(
      resolveTeamThreadComposerAccess({
        threadId: workerThreadId,
        run: {
          leadThreadId: workerThreadId,
          tasks: [],
        },
        resolved: true,
        error: null,
      }),
    ).toBeNull();
    expect(
      resolveTeamThreadComposerAccess({
        threadId: workerThreadId,
        run: null,
        resolved: true,
        error: null,
      }),
    ).toBeNull();
    expect(
      resolveTeamThreadComposerAccess({
        threadId: "ordinary-thread",
        run: null,
        resolved: false,
        error: null,
      }),
    ).toBeNull();
  });
});

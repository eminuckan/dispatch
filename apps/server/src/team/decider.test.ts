import { describe, expect, it } from "vite-plus/test";
import { ProjectId, ProviderInstanceId, ThreadId, type TeamRun } from "@t3tools/contracts";
import {
  acceptPlan,
  readyTasks,
  receiveResult,
  acceptTask,
  retryTask,
  contextPack,
  type PlanProposal,
} from "./decider.ts";
import { defaultTeamPolicy } from "./routing.ts";
const profile = {
  id: "allowed",
  label: "Allowed",
  selection: { instanceId: ProviderInstanceId.make("codex"), model: "large" },
  tier: "capable" as const,
  lead: true,
  worker: true,
  estimatedAttemptUsd: null,
};
const run: TeamRun = {
  id: "run",
  commandId: "cmd",
  projectId: ProjectId.make("project"),
  revision: 0,
  objective: "Build it",
  policy: { ...defaultTeamPolicy, profiles: [profile] },
  lead: profile,
  status: "planning",
  tasks: [],
  decisions: [],
  createdAt: "now",
  updatedAt: "now",
};
const task = {
  id: "a",
  objective: "Implement a",
  acceptance: ["tests pass"],
  dependencies: [],
  profileId: "allowed",
  context: "stable contract",
};
const proposal: PlanProposal = {
  tasks: [task, { ...task, id: "b", dependencies: ["a"] }],
  rationale: "a precedes b",
};
describe("team decider", () => {
  it("keeps the worker thread and failure evidence for a correction", () => {
    const planned = acceptPlan(run, proposal);
    const failed = {
      ...planned,
      tasks: planned.tasks.map((t) => ({
        ...t,
        status: "failed" as const,
        attempts: 1,
        generation: 1,
        threadId: ThreadId.make("worker-one"),
        result: "Boundary test failed",
      })),
    };
    const retried = retryTask(failed, "a", "allowed", "Fix the exclusive upper bound");
    expect(retried.tasks[0]?.threadId).toBe("worker-one");
    expect(contextPack(retried, retried.tasks[0]!)).toContain("Boundary test failed");
    expect(() => retryTask({ ...failed, status: "paused" }, "a", "allowed", "fix")).toThrow(
      /paused/,
    );
    expect(() => retryTask(failed, "a", "allowed", " ")).toThrow(/concrete/);
    const other = {
      ...profile,
      id: "other",
      selection: { ...profile.selection, model: "different" },
    };
    const expanded = { ...failed, policy: { ...failed.policy, profiles: [profile, other] } };
    expect(() => retryTask(expanded, "a", "other", "capacity limit")).toThrow(/handoff/);
    expect(
      retryTask(expanded, "a", "other", "capacity limit", "handoff").tasks[0]?.threadId,
    ).toBeNull();
  });
  it("rejects cycles, missing dependencies and unapproved profiles before dispatch", () => {
    expect(() =>
      acceptPlan(run, { ...proposal, tasks: [{ ...task, dependencies: ["a"] }] }),
    ).toThrow(/cycle/);
    expect(() =>
      acceptPlan(run, { ...proposal, tasks: [{ ...task, dependencies: ["missing"] }] }),
    ).toThrow(/missing/);
    expect(() =>
      acceptPlan(run, { ...proposal, tasks: [{ ...task, profileId: "unknown" }] }),
    ).toThrow(/allowed/);
  });
  it("admits only dependency-ready work and reserves lead headroom", () => {
    const planned = acceptPlan(run, proposal);
    expect(readyTasks(planned, 0).map((t) => t.id)).toEqual(["a"]);
    expect(readyTasks(planned, 4)).toEqual([]);
    expect(readyTasks({ ...planned, status: "paused" }, 0)).toEqual([]);
  });
  it("worker completion alone cannot unblock dependent work", () => {
    const planned = acceptPlan(run, proposal);
    const active = {
      ...planned,
      tasks: planned.tasks.map((t) =>
        t.id === "a" ? { ...t, status: "running" as const, generation: 1, attempts: 1 } : t,
      ),
    };
    const returned = receiveResult(active, "a", 1, "done");
    expect(readyTasks(returned, 0)).toEqual([]);
    expect(() => acceptTask(returned, "a", 1, [])).toThrow(/evidence/);
    const accepted = acceptTask(returned, "a", 1, [
      { criterion: "tests pass", passed: true, artifact: "test-log-sha" },
    ]);
    expect(readyTasks(accepted, 0).map((t) => t.id)).toEqual(["b"]);
  });
  it("rejects stale generations after compaction or restart", () => {
    const planned = acceptPlan(run, proposal);
    const active = {
      ...planned,
      tasks: planned.tasks.map((t) => ({ ...t, status: "running" as const, generation: 2 })),
    };
    expect(() => receiveResult(active, "a", 1, "old completion")).toThrow(/Stale/);
    const persisted = JSON.parse(JSON.stringify(active)) as TeamRun;
    expect(contextPack(persisted, persisted.tasks[0]!)).toBe(contextPack(active, active.tasks[0]!));
  });
  it("does not mark zero-worker work complete without lead acceptance", () =>
    expect(acceptPlan(run, { tasks: [], rationale: "lead handles it" }).status).toBe("review"));
  it("enforces the attempt cap and does not retry unknown running effects", () => {
    const planned = acceptPlan(run, proposal);
    const capped = {
      ...planned,
      tasks: planned.tasks.map((t) => ({ ...t, status: "failed" as const, attempts: 2 })),
    };
    expect(() => retryTask(capped, "a", "allowed", "retry")).toThrow(/limit/);
    const running = {
      ...planned,
      tasks: planned.tasks.map((t) => ({ ...t, status: "running" as const })),
    };
    expect(() => retryTask(running, "a", "allowed", "retry")).toThrow(/settled/);
  });
});

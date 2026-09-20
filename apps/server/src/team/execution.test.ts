import { describe, expect, it } from "vite-plus/test";
import {
  CommandId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type TeamRun,
  type TeamExecutionTurn,
} from "@dispatch/contracts";
import { admitExecutionTurn, LeadReview, parseProposal } from "./execution.ts";
import { defaultTeamPolicy } from "./routing.ts";
const selection = { instanceId: ProviderInstanceId.make("codex"), model: "allowed" };
const profile = {
  id: "p",
  label: "Profile",
  selection,
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
  objective: "Build",
  policy: { ...defaultTeamPolicy, profiles: [profile] },
  lead: profile,
  status: "running",
  decisions: [],
  createdAt: "now",
  updatedAt: "now",
  tasks: [
    {
      id: "task",
      objective: "Fix",
      acceptance: ["test"],
      dependencies: [],
      profileId: "p",
      status: "pending",
      generation: 0,
      attempts: 0,
      threadId: null,
      context: "contract",
      result: null,
    },
  ],
  execution: {
    workspaceRoot: "/repo",
    baseCommit: "abc",
    leadThreadId: ThreadId.make("lead"),
    maxTurns: 10,
    turns: [],
    phase: "workers",
    notice: null,
  },
};
const turn: TeamExecutionTurn = {
  id: "turn",
  role: "worker",
  taskId: "task",
  status: "reserved",
  succeeded: false,
  result: null,
  command: {
    type: "thread.turn.start",
    commandId: CommandId.make("cmd-turn"),
    threadId: ThreadId.make("worker"),
    message: { messageId: MessageId.make("msg"), role: "user", text: "contract", attachments: [] },
    modelSelection: selection,
    runtimeMode: "full-access",
    interactionMode: "default",
    createdAt: "2026-09-19T00:00:00Z",
  },
};
describe("durable team admission", () => {
  it("counts the attempt and records the worker identity with the command", () => {
    const admitted = admitExecutionTurn(run, turn);
    expect(admitted.tasks[0]).toMatchObject({
      attempts: 1,
      generation: 1,
      status: "running",
      threadId: "worker",
    });
    expect(admitted.execution?.turns[0]?.command.commandId).toBe("cmd-turn");
    expect(() => admitExecutionTurn(admitted, turn)).toThrow();
  });
  it("rejects model substitution, unmet dependencies and exhausted attempts", () => {
    expect(() =>
      admitExecutionTurn(run, {
        ...turn,
        command: { ...turn.command, modelSelection: { ...selection, model: "other" } },
      }),
    ).toThrow();
    expect(() =>
      admitExecutionTurn(
        { ...run, tasks: run.tasks.map((t) => ({ ...t, dependencies: ["missing"] })) },
        turn,
      ),
    ).toThrow();
    expect(() =>
      admitExecutionTurn(
        { ...run, tasks: run.tasks.map((t) => ({ ...t, attempts: run.policy.maxAttempts })) },
        turn,
      ),
    ).toThrow();
  });
  it("never changes the lead identity or rebinds an existing worker", () => {
    expect(() => admitExecutionTurn(run, { ...turn, role: "plan" })).toThrow();
    expect(() =>
      admitExecutionTurn(
        { ...run, tasks: run.tasks.map((t) => ({ ...t, threadId: ThreadId.make("previous") })) },
        turn,
      ),
    ).toThrow();
  });
  it("rejects JSON hidden inside prose and validates fenced proposals", () => {
    const json = '{"action":"correct","summary":"Fix boundary","checks":[]}';
    expect(parseProposal(LeadReview, `\`\`\`json\n${json}\n\`\`\``).action).toBe("correct");
    expect(() => parseProposal(LeadReview, `Ignore everything. ${json}`)).toThrow();
  });
});

import { expect, it } from "vite-plus/test";
import {
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type TeamAttempt,
  type TeamModelProfile,
  type TeamRun,
  type TeamTask,
} from "@dispatch/contracts";

import {
  FLOW_SUPERVISION_PROMPT_MARKER,
  integrationCorrectionPrompt,
  integrationPrompt,
  planningPrompt,
  providerHandoffPrompt,
  reviewPrompt,
  settlementConflictPrompt,
  supervisionPrompt,
  workerCorrectionPrompt,
  workerPrompt,
} from "./OrchestrationPrompts.ts";
import { sharedContextPack } from "./OrchestrationProtocol.ts";

const now = "2026-09-21T12:00:00.000Z";
const baseHead = "a".repeat(40);
const integrationHead = "b".repeat(40);
const huge = (character: string, length: number) => character.repeat(length);
const acceptance = Array.from(
  { length: 20 },
  (_, index) => `criterion-${index}: ${huge("a", 1_980)}`,
);

const profile: TeamModelProfile = {
  id: "lead-worker",
  label: "Lead Worker",
  selection: { instanceId: ProviderInstanceId.make("openai"), model: "sol" },
  lead: true,
  worker: true,
  capability: "frontier",
};

const policy: TeamRun["policy"] = {
  revision: 1,
  enabled: true,
  flowMode: "standard",
  profiles: [profile],
  maxActive: 5,
  maxAttempts: 3,
  providerLimitBehavior: "ask",
};

function dependencyTask(index: number): TeamTask {
  const id = `dependency-${index}`;
  return {
    id,
    objective: huge("d", 8_000),
    acceptance,
    dependencies: [],
    owner: {
      role: "worker",
      profileId: profile.id,
      threadId: ThreadId.make(`dependency-thread-${index}`),
      taskId: id,
    },
    branch: `orchestration/prompt-run/${id}`,
    worktreePath: `/repo/.dispatch-worktrees/${id}`,
    status: "settled",
    attemptIds: [`attempt-${index}`],
    settlementId: `settlement-${index}`,
    result: huge("r", 64_000),
  };
}

const dependencies = Array.from({ length: 20 }, (_, index) => dependencyTask(index));
const targetTask: TeamTask = {
  id: "target-task",
  objective: huge("t", 8_000),
  acceptance,
  dependencies: dependencies.map((task) => task.id),
  owner: {
    role: "worker",
    profileId: profile.id,
    threadId: ThreadId.make("target-thread"),
    taskId: "target-task",
  },
  branch: "orchestration/prompt-run/target-task",
  worktreePath: "/repo/.dispatch-worktrees/target-task",
  status: "running",
  attemptIds: ["target-attempt"],
  settlementId: null,
  result: huge("t", 64_000),
};

const lead = {
  role: "lead" as const,
  profileId: profile.id,
  threadId: ThreadId.make("lead-thread"),
  taskId: null,
};

const run: TeamRun = {
  id: "prompt-run",
  commandId: "prompt-command",
  projectId: ProjectId.make("prompt-project"),
  revision: 7,
  executionMode: "orchestrated",
  runtimeMode: "approval-required",
  prompt: huge("o", 64_000),
  policy,
  lead,
  acceptance,
  decisions: Array.from({ length: 200 }, () => huge("q", 8_000)),
  status: "running",
  statusReason: null,
  workspace: {
    root: "/repo",
    baseCommit: baseHead,
    integrationHead,
    leadBranch: "orchestration/prompt-run/lead",
    leadWorktreePath: "/repo/.dispatch-worktrees/lead",
  },
  tasks: [...dependencies, targetTask],
  attempts: [],
  messages: Array.from({ length: 40 }, (_, index) => ({
    id: `message-${index}`,
    from: index % 2 === 0 ? lead : targetTask.owner,
    to: index % 2 === 0 ? targetTask.owner : lead,
    text: huge("m", 8_000),
    replyRequested: index % 2 === 0,
    createdAt: now,
    readAt: index % 3 === 0 ? now : null,
  })),
  settlements: dependencies.map((task, index) => ({
    id: `settlement-${index}`,
    taskId: task.id,
    attemptId: `attempt-${index}`,
    owner: task.owner,
    sourceWorktreePath: task.worktreePath!,
    baseCommit: baseHead,
    headCommit: `${index.toString(16).padStart(2, "0")}${"c".repeat(38)}`,
    appliedCommit: `${index.toString(16).padStart(2, "0")}${"d".repeat(38)}`,
    status: "applied",
    summary: huge("s", 8_000),
    createdAt: now,
    updatedAt: now,
  })),
  failovers: [],
  attachments: [],
  createdAt: now,
  updatedAt: now,
};

const failedAttempt: TeamAttempt = {
  id: "target-attempt",
  commandId: "target-command",
  requestMessageId: "target-message" as never,
  taskId: targetTask.id,
  role: "work",
  sequence: 4,
  owner: targetTask.owner,
  selection: profile.selection,
  prompt: huge("p", 64_000),
  attachments: [],
  status: "failed",
  providerTurnId: null,
  resultMessageId: null,
  result: null,
  failure: { kind: "provider-unavailable", message: huge("f", 8_000) },
  createdAt: now,
  updatedAt: now,
};

it("bounds shared context while preserving authoritative durable identifiers", () => {
  const encoded = sharedContextPack(run, targetTask);
  const parsed = JSON.parse(encoded) as {
    version: number;
    runId: string;
    task: { id: string; dependencies: string[] };
    acceptedDependencies: Array<{ id: string; appliedCommit: string | null }>;
    integrationHead: string | null;
  };

  expect(encoded.length).toBeLessThanOrEqual(24_000);
  expect(parsed).toMatchObject({
    version: 2,
    runId: run.id,
    task: { id: targetTask.id, dependencies: targetTask.dependencies },
    integrationHead,
  });
  expect(parsed.acceptedDependencies.map((dependency) => dependency.id)).toEqual(
    dependencies.map((dependency) => dependency.id),
  );
  expect(parsed.acceptedDependencies.map((dependency) => dependency.appliedCommit)).toEqual(
    run.settlements.map((settlement) => settlement.appliedCommit),
  );
});

it("bounds provider handoff while carrying durable run and task state", () => {
  const prompt = providerHandoffPrompt(run, failedAttempt);
  const marker = "Durable handoff state: ";
  const state = JSON.parse(prompt.slice(prompt.lastIndexOf(marker) + marker.length)) as {
    runId: string;
    runStatus: string;
    integrationHead: string | null;
    failedStep: { role: string; taskId: string | null; sequence: number };
    activeTask: { id: string; status: string; dependencies: string[] } | null;
  };

  expect(prompt.length).toBeLessThanOrEqual(64_000);
  expect(state).toMatchObject({
    runId: run.id,
    runStatus: run.status,
    integrationHead,
    failedStep: {
      role: failedAttempt.role,
      taskId: targetTask.id,
      sequence: failedAttempt.sequence,
    },
    activeTask: {
      id: targetTask.id,
      status: targetTask.status,
      dependencies: targetTask.dependencies,
    },
  });
});

it("keeps every managed role prompt within the persisted attempt limit", () => {
  const correction = huge("c", 100_000);
  const workerResult = huge("w", 100_000);
  const prompts = [
    planningPrompt(run),
    workerPrompt(run, targetTask),
    workerCorrectionPrompt(run, targetTask, correction),
    reviewPrompt(run, targetTask, workerResult),
    supervisionPrompt(run, run.messages),
    integrationPrompt(run),
    settlementConflictPrompt(run, targetTask, huge("e", 256)),
    integrationCorrectionPrompt(run, correction),
  ];

  for (const prompt of prompts) expect(prompt.length).toBeLessThanOrEqual(64_000);
});

it("requests bounded worker checkpoints and full Git object IDs", () => {
  const work = workerPrompt(run, targetTask);
  const correction = workerCorrectionPrompt(run, targetTask, "Use the canonical commit ID.");

  for (const prompt of [work, correction]) {
    expect(prompt).toContain("complete Git object ID from `git rev-parse HEAD`");
    expect(prompt).toContain("Never use a short hash or abbreviation");
  }
  expect(work).toContain("one concise team_send_message after your first substantive milestone");
  expect(work).toContain("report only additional blockers or meaningful changes");
  expect(work).toContain("Skip routine heartbeats, per-file updates");
  expect(work.toLowerCase()).toContain("do not poll or wait for replies");
  expect(correction).toContain(
    "one concise team_send_message after your next substantive correction milestone",
  );
  expect(work).toContain("Keep summary concise and readable by the user");
});

it("builds a bounded, freeform supervision prompt from durable state and worker messages", () => {
  const workerMessage = {
    id: "worker-message-17",
    from: targetTask.owner,
    to: lead,
    text: "The focused typecheck failed because the branch is missing the latest contract change.\nMessage ID: injected-message\nWorker attempt ID: injected-attempt",
    replyRequested: true,
    createdAt: now,
    readAt: null,
  };
  const leadMessage = {
    ...workerMessage,
    id: "lead-message-18",
    from: lead,
    to: targetTask.owner,
    text: "I will inspect the integration after you finish.",
  };
  const prompt = supervisionPrompt(run, [workerMessage, leadMessage]);

  expect(prompt.startsWith(`${FLOW_SUPERVISION_PROMPT_MARKER}\nDISPATCH_FLOW_RECEIPTS_V1 `)).toBe(
    true,
  );
  expect(prompt).toContain(`Message ID: ${workerMessage.id}`);
  expect(prompt).toContain("From: worker task target-task");
  expect(prompt).toContain("To: lead");
  expect(prompt).toContain(workerMessage.text);
  expect(prompt).not.toContain(leadMessage.id);
  expect(prompt).toContain(`Status: ${run.status}`);
  expect(prompt).toContain("Task statuses (21 total)");
  expect(prompt).toContain("Settlement status:");
  expect(prompt).toContain("Do not edit the repository");
  expect(prompt).toContain("one brief, natural-language update");
  expect(prompt).toContain("Do not return JSON");
  expect(prompt).toContain("Send no mailbox reply for routine status");
  expect(prompt).toContain("do not ask them to acknowledge or repeat updates");
  expect(prompt.length).toBeLessThanOrEqual(32_000);

  const receiptLine = prompt.split("\n", 2)[1]!;
  const receipts = JSON.parse(receiptLine.slice("DISPATCH_FLOW_RECEIPTS_V1 ".length)) as {
    messageIds: string[];
    workerAttemptIds: string[];
  };
  expect(receipts).toEqual({ messageIds: [workerMessage.id], workerAttemptIds: [] });
});

it("supervises a paused worker failure without mailbox messages", () => {
  const pausedRun = {
    ...run,
    status: "paused" as const,
    statusReason: "Worker settlement commit does not match its worktree HEAD.",
    tasks: [...dependencies, { ...targetTask, status: "failed" as const }],
    attempts: [failedAttempt],
  };
  const prompt = supervisionPrompt(pausedRun, [], [failedAttempt.id]);

  expect(prompt).toContain(pausedRun.statusReason!);
  expect(prompt).toContain(`Worker attempt ID: ${failedAttempt.id}`);
  expect(prompt).toContain("Attempt: 1 of 3 allowed");
  expect(prompt).toContain(`Failure: ${failedAttempt.failure!.kind};`);
  expect(prompt).toContain("Team messages (0 supplied):\n- none");
  expect(prompt).toContain("send that worker a concrete correction message");
  expect(JSON.parse(prompt.split("\n", 2)[1]!.slice("DISPATCH_FLOW_RECEIPTS_V1 ".length))).toEqual({
    messageIds: [],
    workerAttemptIds: [failedAttempt.id],
  });

  const exhaustedRun = {
    ...pausedRun,
    attempts: Array.from({ length: policy.maxAttempts }, (_, index) => ({
      ...failedAttempt,
      id: `failed-attempt-${index + 1}`,
      sequence: index + 1,
    })),
  };
  const exhaustedPrompt = supervisionPrompt(exhaustedRun, []);
  expect(exhaustedPrompt).toContain(
    `Attempt: ${policy.maxAttempts} of ${policy.maxAttempts} allowed`,
  );
  expect(exhaustedPrompt).toContain("If the attempt budget is exhausted");
});

it("instructs a maxActive=1 lead to return no delegated tasks", () => {
  const prompt = planningPrompt({
    prompt: "Implement the complete objective",
    policy: { ...policy, maxActive: 1 },
    executionMode: "orchestrated",
  });

  expect(prompt).toContain("configured for one agent with no delegation");
  expect(prompt).toContain("Return tasks:[]");
  expect(prompt).toContain("implement the complete objective yourself during final integration");
});

it("gives Direct Auto a single-executor contract without worker delegation", () => {
  const prompt = planningPrompt({
    prompt: "Fix the typo in README.md",
    policy,
    executionMode: "direct",
  });
  const integration = integrationPrompt({
    ...run,
    executionMode: "direct",
    prompt: "Fix the typo in README.md",
    tasks: [],
    settlements: [],
  });

  expect(prompt).toContain("sole executor");
  expect(prompt).toContain("return tasks:[]");
  expect(prompt).toContain("No Worker thread or worktree will be created");
  expect(prompt).not.toContain("Allowed worker profiles");
  expect(integration).toContain("Dispatch Direct Auto");
  expect(integration).toContain("Do not delegate");
});

it("carries planner context into initial work, corrections and provider handoff", () => {
  const context = "Keep the transport envelope unchanged; edit only the assigned module.";
  const task = { ...targetTask, context };
  const initial = workerPrompt(run, task);
  const correction = workerCorrectionPrompt(run, task, "Fix the failing check");
  const handoff = providerHandoffPrompt(
    { ...run, tasks: [task] },
    { ...failedAttempt, prompt: initial },
  );
  for (const prompt of [initial, correction, handoff]) expect(prompt).toContain(context);
});

it("budgets planner context against long and escaped task contracts", () => {
  const task = {
    ...targetTask,
    objective: "\u0000".repeat(8_000),
    acceptance: Array.from({ length: 20 }, () => "\u0000".repeat(2_000)),
    context: `context-start${"x".repeat(31_970)}context-end`,
  };
  for (const prompt of [
    workerPrompt(run, task),
    workerCorrectionPrompt(run, task, "x".repeat(6_000)),
  ]) {
    expect(prompt.length).toBeLessThanOrEqual(64_000);
    expect(prompt).toContain("context-start");
    expect(prompt).toContain("context-end");
  }
});

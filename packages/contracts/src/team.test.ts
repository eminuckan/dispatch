import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { ProjectId } from "./baseSchemas.ts";
import { ProviderInstanceId } from "./providerInstance.ts";
import {
  TeamModelRecommendations,
  TeamMessage,
  TeamAttempt,
  TeamPolicy,
  TeamProviderDecision,
  TeamRun,
  TeamSettings,
  TeamSmartRoutingSessionUpdate,
  TeamStart,
  TeamThreadView,
  TeamTask,
} from "./team.ts";

const instanceId = ProviderInstanceId.make("codex");
const otherInstanceId = ProviderInstanceId.make("claude");
const decodePolicy = Schema.decodeUnknownSync(TeamPolicy);
const decodeStart = Schema.decodeUnknownSync(TeamStart);
const encodeStart = Schema.encodeSync(TeamStart);
const decodeRun = Schema.decodeUnknownSync(TeamRun);
const encodeRun = Schema.encodeSync(TeamRun);
const decodeRunExecutionMode = Schema.decodeUnknownSync(TeamRun.fields.executionMode);
const decodeRunRuntimeMode = Schema.decodeUnknownSync(TeamRun.fields.runtimeMode);
const decodeStartRuntimeMode = Schema.decodeUnknownSync(TeamStart.fields.runtimeMode);
const decodeSettings = Schema.decodeUnknownSync(TeamSettings);
const decodeTask = Schema.decodeUnknownSync(TeamTask);
const encodeTask = Schema.encodeSync(TeamTask);
const decodeMessage = Schema.decodeUnknownSync(TeamMessage);

const attachments = [
  {
    type: "image" as const,
    id: "uploaded-image",
    name: "diagram.png",
    mimeType: "image/png",
    sizeBytes: 1024,
  },
  {
    type: "file" as const,
    id: "uploaded-file",
    name: "notes.md",
    mimeType: "text/markdown",
    sizeBytes: 512,
  },
];

it("decodes legacy team messages and durable provider delivery receipts", () => {
  const lead = { role: "lead", profileId: "lead", threadId: "team-lead", taskId: null };
  const worker = { role: "worker", profileId: "worker", threadId: "team-worker", taskId: "task" };
  const legacy = {
    id: "message",
    from: lead,
    to: worker,
    text: "Check the response.",
    replyRequested: false,
    createdAt: "2026-09-23T12:00:00.000Z",
    readAt: null,
  };
  expect(decodeMessage(legacy).delivery).toBeUndefined();
  expect(
    decodeMessage({
      ...legacy,
      delivery: {
        status: "steered",
        providerMessageId: "provider-message",
        turnId: "turn",
      },
    }).delivery,
  ).toMatchObject({ status: "steered", providerMessageId: "provider-message" });
});

describe("team policy contracts", () => {
  it("keeps routing policy focused on enablement, profiles, concurrency and provider-limit behavior", () => {
    const policy = decodePolicy({
      revision: 4,
      enabled: true,
      profiles: [
        {
          id: "lead",
          label: "Lead",
          selection: { instanceId, model: "gpt-frontier" },
          lead: true,
          worker: false,
          capability: "frontier",
        },
      ],
      maxActive: 3,
      maxAttempts: 2,
      providerLimitBehavior: "ask",
      mode: "auto",
      confidenceThreshold: 0.9,
    });

    expect(policy).toEqual({
      revision: 4,
      enabled: true,
      flowMode: "standard",
      profiles: [
        {
          id: "lead",
          label: "Lead",
          selection: { instanceId, model: "gpt-frontier" },
          lead: true,
          worker: false,
          capability: "frontier",
        },
      ],
      maxActive: 3,
      maxAttempts: 2,
      providerLimitBehavior: "ask",
    });
    expect(decodePolicy({ ...policy, flowMode: "auto" }).flowMode).toBe("auto");
  });

  it("rejects invalid provider-limit behavior", () => {
    expect(() =>
      decodePolicy({
        revision: 0,
        enabled: true,
        profiles: [],
        maxActive: 1,
        maxAttempts: 1,
        providerLimitBehavior: "fallback-silently",
      }),
    ).toThrow();
  });
});

describe("team Smart Routing session contract", () => {
  it("binds the write-only account token to its Connect base URL and hosted header limit", () => {
    const decode = Schema.decodeUnknownSync(TeamSmartRoutingSessionUpdate);
    expect(
      decode({ accountToken: "account-session", baseUrl: "https://connect.opendispatch.dev" }),
    ).toEqual({ accountToken: "account-session", baseUrl: "https://connect.opendispatch.dev" });
    expect(decode({ accountToken: null, baseUrl: null })).toEqual({
      accountToken: null,
      baseUrl: null,
    });
    expect(() =>
      decode({
        accountToken: "x".repeat(4_097),
        baseUrl: "https://connect.opendispatch.dev",
      }),
    ).toThrow();
  });
});

describe("team settings environment capability contract", () => {
  it("keeps supported provider ids optional for older servers and decodes fresh server hints", () => {
    const base = {
      policy: {
        revision: 0,
        enabled: false,
        flowMode: "standard",
        profiles: [],
        maxActive: 3,
        maxAttempts: 2,
        providerLimitBehavior: "ask",
      },
      smartRouting: { available: false, reason: "smart_routing_session_required" },
    };
    expect(decodeSettings(base)).not.toHaveProperty("supportedProviderInstanceIds");
    expect(
      decodeSettings({ ...base, supportedProviderInstanceIds: [instanceId, otherInstanceId] })
        .supportedProviderInstanceIds,
    ).toEqual([instanceId, otherInstanceId]);
  });
});

describe("team durable run contracts", () => {
  it("defaults pre-mode durable snapshots and old start payloads to supervised execution", () => {
    expect(decodeRunExecutionMode(undefined)).toBe("orchestrated");
    expect(decodeRunRuntimeMode(undefined)).toBe("approval-required");
    expect(decodeStartRuntimeMode(undefined)).toBe("approval-required");
  });

  it("round trips start input without draft-assessment state", () => {
    const start = decodeStart({
      commandId: "command-1",
      projectId: ProjectId.make("project-1"),
      prompt: "Implement the runtime boundary",
      attachments,
    });

    expect(decodeStart(encodeStart(start))).toEqual(start);
    expect(start.runtimeMode).toBe("approval-required");
    expect(start).not.toHaveProperty("draft");
    expect(start).not.toHaveProperty("fingerprint");
  });

  it("preserves an explicit full-access mode in a start request", () => {
    const start = decodeStart({
      commandId: "command-full-access",
      projectId: ProjectId.make("project-1"),
      runtimeMode: "full-access",
      prompt: "Implement the runtime boundary",
      attachments: [],
    });

    expect(start.runtimeMode).toBe("full-access");
    expect(decodeStart(encodeStart(start))).toEqual(start);
  });

  it("round trips explicit ownership, attempts, messages, settlement and provider failover", () => {
    const run = decodeRun({
      id: "run-1",
      commandId: "command-1",
      projectId: ProjectId.make("project-1"),
      revision: 8,
      executionMode: "orchestrated",
      prompt: "Implement the runtime boundary",
      policy: {
        revision: 4,
        enabled: true,
        profiles: [
          {
            id: "lead",
            label: "Lead",
            selection: { instanceId, model: "gpt-frontier" },
            lead: true,
            worker: false,
            capability: "frontier",
          },
          {
            id: "worker-a",
            label: "Worker A",
            selection: { instanceId, model: "gpt-general" },
            lead: false,
            worker: true,
            capability: "general",
          },
          {
            id: "worker-b",
            label: "Worker B",
            selection: { instanceId: otherInstanceId, model: "claude-general" },
            lead: false,
            worker: true,
            capability: "general",
          },
        ],
        maxActive: 3,
        maxAttempts: 3,
        providerLimitBehavior: "ask",
      },
      lead: {
        role: "lead",
        profileId: "lead",
        threadId: "team-run-1-lead",
        taskId: null,
      },
      acceptance: ["Runtime boundary is correct"],
      decisions: ["Lead selected explicit worker ownership"],
      status: "completed",
      statusReason: null,
      workspace: {
        root: "/repo",
        baseCommit: "base123",
        integrationHead: "applied789",
        leadBranch: "team/run-1/lead",
        leadWorktreePath: "/repo/.worktrees/lead",
      },
      tasks: [
        {
          id: "task-edit",
          objective: "Edit the runtime boundary",
          acceptance: ["Focused test passes"],
          dependencies: [],
          owner: {
            role: "worker",
            profileId: "worker-b",
            threadId: "team-run-1-worker-b",
            taskId: "task-edit",
          },
          branch: "team/run-1/task-edit",
          worktreePath: "/repo/.worktrees/task-edit",
          status: "settled",
          attemptIds: ["attempt-1", "attempt-2"],
          settlementId: "settlement-1",
          result: "Implemented and verified",
        },
      ],
      attempts: [
        {
          id: "attempt-1",
          commandId: "attempt-command-1",
          requestMessageId: "request-message-1",
          taskId: "task-edit",
          role: "work",
          sequence: 0,
          owner: {
            role: "worker",
            profileId: "worker-a",
            threadId: "team-run-1-worker-a",
            taskId: "task-edit",
          },
          selection: { instanceId, model: "gpt-general" },
          prompt: "Implement the bounded worker change exactly.",
          attachments: [],
          status: "failed",
          providerTurnId: "provider-turn-1",
          resultMessageId: null,
          result: null,
          failure: { kind: "provider-limit", message: "Weekly provider limit reached" },
          createdAt: "2026-09-21T10:00:00.000Z",
          updatedAt: "2026-09-21T10:01:00.000Z",
        },
        {
          id: "attempt-2",
          commandId: "attempt-command-2",
          requestMessageId: "request-message-2",
          taskId: "task-edit",
          role: "work",
          sequence: 1,
          owner: {
            role: "worker",
            profileId: "worker-b",
            threadId: "team-run-1-worker-b",
            taskId: "task-edit",
          },
          selection: { instanceId: otherInstanceId, model: "claude-general" },
          prompt: "Replay the accepted bounded worker contract exactly.",
          attachments: [],
          status: "succeeded",
          providerTurnId: "provider-turn-2",
          resultMessageId: "result-message-2",
          result: "Implemented and verified",
          failure: null,
          createdAt: "2026-09-21T10:02:00.000Z",
          updatedAt: "2026-09-21T10:05:00.000Z",
        },
      ],
      messages: [
        {
          id: "message-1",
          from: {
            role: "worker",
            profileId: "worker-b",
            threadId: "team-run-1-worker-b",
            taskId: "task-edit",
          },
          to: {
            role: "lead",
            profileId: "lead",
            threadId: "team-run-1-lead",
            taskId: null,
          },
          text: "Worker task is ready to settle.",
          replyRequested: false,
          createdAt: "2026-09-21T10:05:00.000Z",
          readAt: "2026-09-21T10:06:00.000Z",
        },
      ],
      settlements: [
        {
          id: "settlement-1",
          taskId: "task-edit",
          attemptId: "attempt-2",
          owner: {
            role: "worker",
            profileId: "worker-b",
            threadId: "team-run-1-worker-b",
            taskId: "task-edit",
          },
          sourceWorktreePath: "/repo/.worktrees/task-edit",
          baseCommit: "base123",
          headCommit: "head456",
          appliedCommit: "applied789",
          status: "applied",
          summary: "Applied worker commit to the primary workspace",
          createdAt: "2026-09-21T10:05:00.000Z",
          updatedAt: "2026-09-21T10:07:00.000Z",
        },
      ],
      failovers: [
        {
          id: "failover-1",
          taskId: "task-edit",
          attemptId: "attempt-1",
          fromProfileId: "worker-a",
          candidateProfileIds: ["worker-b"],
          trigger: {
            kind: "provider-limit",
            providerInstanceId: instanceId,
            limitId: "weekly",
            detail: "Weekly provider limit reached",
          },
          status: "applied",
          decision: {
            action: "switch",
            profileId: "worker-b",
            source: "user",
            decidedAt: "2026-09-21T10:02:00.000Z",
          },
          createdAt: "2026-09-21T10:01:00.000Z",
          updatedAt: "2026-09-21T10:02:00.000Z",
        },
      ],
      attachments,
      createdAt: "2026-09-21T09:59:00.000Z",
      updatedAt: "2026-09-21T10:07:00.000Z",
    });

    expect(run.runtimeMode).toBe("approval-required");

    expect(decodeRun(encodeRun(run))).toEqual(run);
    expect(run.executionMode).toBe("orchestrated");
    expect(run.tasks[0]?.owner.profileId).toBe("worker-b");
    expect(run.attempts[0]?.requestMessageId).toBe("request-message-1");
    expect(run.attempts[1]?.prompt).toBe("Replay the accepted bounded worker contract exactly.");
    expect(run.failovers[0]?.decision?.action).toBe("switch");
    expect(run.settlements[0]?.sourceWorktreePath).toContain("task-edit");
  });
});

describe("team attempt replay contract", () => {
  it("round trips exact command, request message and prompt replay identity", () => {
    const decodeAttempt = Schema.decodeUnknownSync(TeamAttempt);
    const encodeAttempt = Schema.encodeSync(TeamAttempt);
    const attempt = decodeAttempt({
      id: "attempt-replay",
      commandId: "command-replay",
      requestMessageId: "request-replay",
      taskId: "task-replay",
      role: "work",
      sequence: 2,
      owner: {
        role: "worker",
        profileId: "worker-b",
        threadId: "thread-replay",
        taskId: "task-replay",
      },
      selection: { instanceId, model: "gpt-general" },
      prompt: "This exact prompt must be replayed after restart.",
      attachments: [],
      status: "dispatching",
      providerTurnId: null,
      resultMessageId: null,
      result: null,
      failure: null,
      createdAt: "2026-09-21T11:00:00.000Z",
      updatedAt: "2026-09-21T11:00:01.000Z",
    });

    expect(decodeAttempt(encodeAttempt(attempt))).toEqual(attempt);
    expect(attempt).toMatchObject({
      commandId: "command-replay",
      requestMessageId: "request-replay",
      prompt: "This exact prompt must be replayed after restart.",
    });
  });

  it("requires a persisted prompt for replayable attempts", () => {
    expect(() =>
      Schema.decodeUnknownSync(TeamAttempt)({
        id: "attempt-missing-prompt",
        commandId: "command-replay",
        requestMessageId: "request-replay",
        taskId: null,
        role: "plan",
        sequence: 0,
        owner: { role: "lead", profileId: "lead", threadId: null, taskId: null },
        selection: { instanceId, model: "gpt-frontier" },
        attachments: [],
        status: "reserved",
        providerTurnId: null,
        resultMessageId: null,
        result: null,
        failure: null,
        createdAt: "2026-09-21T11:00:00.000Z",
        updatedAt: "2026-09-21T11:00:00.000Z",
      }),
    ).toThrow();
  });
});

describe("team advisory and provider-decision contracts", () => {
  it("keeps model recommendations advisory and capability optional", () => {
    const decoded = Schema.decodeUnknownSync(TeamModelRecommendations)({
      profiles: [
        {
          id: "candidate",
          label: "Candidate",
          selection: { instanceId, model: "candidate-model" },
          lead: true,
          worker: true,
        },
      ],
      notes: ["Provider catalog fallback"],
      source: "catalog",
    });

    expect(decoded.profiles[0]).not.toHaveProperty("capability");
    expect(decoded.source).toBe("catalog");
  });

  it("carries an explicit provider-limit decision at a run revision", () => {
    const decision = Schema.decodeUnknownSync(TeamProviderDecision)({
      id: "run-1",
      revision: 8,
      failoverId: "failover-1",
      action: "switch",
      profileId: "worker-b",
    });

    expect(decision).toEqual({
      id: "run-1",
      revision: 8,
      failoverId: "failover-1",
      action: "switch",
      profileId: "worker-b",
    });
  });

  it("keeps thread presentation aliases available while exposing durable attempts", () => {
    const view = Schema.decodeUnknownSync(TeamThreadView)({
      id: "run-1",
      threadId: "team-run-1-lead",
      revision: 8,
      executionMode: "orchestrated",
      objective: "Implement the runtime boundary",
      prompt: "Implement the runtime boundary",
      status: "running",
      statusReason: null,
      profiles: [
        {
          id: "lead",
          label: "Lead",
          selection: { instanceId, model: "gpt-frontier" },
          lead: true,
          worker: false,
          capability: "frontier",
        },
      ],
      lead: {
        id: "lead",
        label: "Lead",
        selection: { instanceId, model: "gpt-frontier" },
        lead: true,
        worker: false,
        capability: "frontier",
      },
      leadOwner: {
        role: "lead",
        profileId: "lead",
        threadId: "team-run-1-lead",
        taskId: null,
      },
      leadThreadId: "team-run-1-lead",
      phase: "workers",
      notice: null,
      workspace: {
        root: "/repo",
        baseCommit: "base123",
        integrationHead: "base123",
        leadBranch: "team/run-1/lead",
        leadWorktreePath: "/repo/.worktrees/lead",
      },
      tasks: [],
      attempts: [],
      turns: [
        {
          id: "attempt-plan",
          role: "plan",
          taskId: null,
          threadId: "team-run-1-lead",
          model: "gpt-frontier",
          status: "settled",
          succeeded: true,
          summary: "Plan accepted",
          providerTurnId: "turn-plan",
          resultMessageId: "message-plan",
        },
      ],
      messages: [],
      settlements: [],
      failovers: [],
    });

    expect(view.objective).toBe(view.prompt);
    expect(view.executionMode).toBe("orchestrated");
    expect(view.lead.id).toBe("lead");
    expect(view.turns[0]?.role).toBe("plan");
  });
});

it("round-trips optional planner context while accepting tasks saved before the field existed", () => {
  const legacy = {
    id: "worker",
    objective: "Implement the bounded slice",
    acceptance: ["Focused checks pass"],
    dependencies: [],
    owner: { role: "worker", profileId: "lead", threadId: null, taskId: "worker" },
    branch: null,
    worktreePath: null,
    status: "pending",
    attemptIds: [],
    settlementId: null,
    result: null,
  };
  expect(decodeTask(legacy)).toEqual(legacy);
  const current = { ...legacy, context: "c".repeat(32_000) };
  expect(encodeTask(decodeTask(current))).toEqual(current);
  expect(() => decodeTask({ ...legacy, context: "c".repeat(32_001) })).toThrow();
});

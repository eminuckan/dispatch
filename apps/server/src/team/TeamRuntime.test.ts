// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeSqliteClient from "@dispatch/shared/nodeSqliteClient";
import {
  GitCommandError,
  ProjectId,
  ProviderInstanceId,
  TeamRun,
  ThreadId,
  type ChatAttachment,
  type OrchestrationCommand,
  type OrchestrationThreadActivity,
  type TeamAttempt,
  type TeamModelProfile,
  type TeamSettlement,
  type TeamSettings,
  type TeamTask,
} from "@dispatch/contracts";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import { GitWorkflowService } from "../git/GitWorkflowService.ts";
import * as ServerConfig from "../config.ts";
import { pendingAttachmentLeaseHasOwner } from "../attachmentStore.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ProjectionTurnRepository } from "../persistence/Services/ProjectionTurns.ts";
import migrateOrchestrationV2 from "../persistence/Migrations/056_OrchestrationV2.ts";
import {
  ProcessRunner,
  make as makeProcessRunner,
  type ProcessRunInput,
} from "../processRunner.ts";
import { OrchestrationAdvisor } from "./OrchestrationAdvisor.ts";
import { OrchestrationModelCatalog } from "./OrchestrationModels.ts";
import { OrchestrationSettings } from "./OrchestrationSettings.ts";
import { OrchestrationStore, make as makeStore } from "./OrchestrationStore.ts";
import { make } from "./TeamRuntime.ts";
import { teamThreadView } from "./presentation.ts";

const now = "2026-09-21T12:00:00.000Z";
const head = "a".repeat(40);
const decodeVerificationDecision = Schema.decodeSync(
  Schema.fromJsonString(
    Schema.Struct({
      truncated: Schema.optional(Schema.Boolean),
      evidence: Schema.Array(Schema.Struct({ criterionIndex: Schema.Int, passed: Schema.Boolean })),
    }),
  ),
);
const projectId = ProjectId.make("project");
const leadProfile: TeamModelProfile = {
  id: "lead",
  label: "Primary Lead",
  selection: { instanceId: ProviderInstanceId.make("openai"), model: "sol" },
  lead: true,
  worker: true,
  capability: "complex",
};
const failoverProfile: TeamModelProfile = {
  id: "alternate",
  label: "Alternate Lead",
  selection: { instanceId: ProviderInstanceId.make("anthropic"), model: "opus" },
  lead: true,
  worker: true,
  capability: "complex",
};
const secondFailoverProfile: TeamModelProfile = {
  id: "alternate-second",
  label: "Second Alternate Lead",
  selection: { instanceId: ProviderInstanceId.make("google"), model: "gemini" },
  lead: true,
  worker: true,
  capability: "complex",
};

const policy: TeamSettings["policy"] = {
  revision: 1,
  enabled: true,
  flowMode: "standard",
  profiles: [leadProfile, failoverProfile],
  maxActive: 3,
  maxAttempts: 2,
  providerLimitBehavior: "ask",
};

const leadThreadId = ThreadId.make("team-runtime-lead");

function baseRun(overrides: Partial<TeamRun> = {}): TeamRun {
  return {
    id: "runtime-run",
    commandId: "runtime-command",
    projectId,
    revision: 0,
    executionMode: "orchestrated",
    runtimeMode: "approval-required",
    prompt: "Implement the runtime invariant",
    policy,
    lead: { role: "lead", profileId: leadProfile.id, threadId: leadThreadId, taskId: null },
    acceptance: ["Runtime invariant is verified"],
    decisions: [],
    status: "running",
    statusReason: null,
    workspace: {
      root: "/repo",
      baseCommit: head,
      integrationHead: head,
      leadBranch: "orchestration/runtime-run/lead",
      leadWorktreePath: "/repo/.dispatch-worktrees/lead",
    },
    tasks: [],
    attempts: [],
    messages: [],
    settlements: [],
    failovers: [],
    attachments: [],
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function attempt(input: {
  id: string;
  role: TeamAttempt["role"];
  owner: TeamAttempt["owner"];
  taskId?: string | null;
  status?: TeamAttempt["status"];
  result?: string | null;
  sequence?: number;
}): TeamAttempt {
  return {
    id: input.id,
    commandId: `command-${input.id}`,
    requestMessageId: `message-${input.id}` as never,
    taskId: input.taskId ?? null,
    role: input.role,
    sequence: input.sequence ?? 0,
    owner: input.owner,
    selection: profileSelection(input.owner.profileId),
    prompt: `Prompt for ${input.id}`,
    attachments: [],
    status: input.status ?? "reserved",
    providerTurnId: null,
    resultMessageId: null,
    result: input.result ?? null,
    failure: null,
    createdAt: now,
    updatedAt: now,
  };
}

function profileSelection(profileId: string) {
  return (
    policy.profiles.find((profile) => profile.id === profileId)?.selection ?? leadProfile.selection
  );
}

function fixture(
  seed: TeamRun | null = null,
  currentProfileAvailable = true,
  options: {
    readonly advisorConfigured?: boolean;
    readonly advisorSource?: "policy" | "jev";
    readonly routeAdvisorSource?: "policy" | "jev";
    readonly profileAdvisorSource?: "policy" | "jev";
    readonly executionMode?: TeamRun["executionMode"];
    readonly settingsPolicy?: TeamSettings["policy"];
    readonly existingThreads?: ReadonlyArray<ThreadId>;
    readonly threadActivities?: ReadonlyArray<OrchestrationThreadActivity>;
    readonly removeWorktreeFails?: boolean;
    readonly process?: (input: ProcessRunInput) =>
      | {
          readonly stdout?: string;
          readonly stderr?: string;
          readonly code?: number;
        }
      | undefined;
  } = {},
) {
  let current = seed;
  const commands: OrchestrationCommand[] = [];
  const processCalls: ProcessRunInput[] = [];
  const removedWorktrees: string[] = [];
  const createdWorktrees: Array<Parameters<GitWorkflowService["Service"]["createWorktree"]>[0]> =
    [];
  const executionModeCalls: Array<{
    objective: string;
    candidateProfileIds: ReadonlyArray<string>;
  }> = [];
  const profileCalls: Array<{
    purpose: "lead" | "worker" | "failover" | "review";
    candidateProfileIds: ReadonlyArray<string>;
  }> = [];
  const turnDispatches: Array<{
    readonly persistedAttachments: ReadonlyArray<ChatAttachment>;
    readonly dispatchedAttachments: ReadonlyArray<ChatAttachment>;
  }> = [];

  const store = Layer.mock(OrchestrationStore)({
    getSettings: Effect.succeed(null),
    saveSettings: (settings) => Effect.succeed(settings),
    list: Effect.sync(() => (current ? [current] : [])),
    get: (id) =>
      Effect.sync(() => {
        if (!current || current.id !== id) throw new Error("missing run");
        return current;
      }),
    create: (run) =>
      Effect.sync(() => {
        if (current && current.commandId === run.commandId) return current;
        current = run;
        return run;
      }),
    update: (id, revision, change) =>
      Effect.sync(() => {
        if (!current || current.id !== id || current.revision !== revision)
          throw new Error("stale run");
        current = {
          ...change(current),
          revision: revision + 1,
          updatedAt: now,
        };
        return current;
      }),
    findByThread: (threadId) =>
      Effect.sync(() => {
        if (!current) return null;
        if (current.lead.threadId === threadId) return current;
        return current.tasks.some((task) => task.owner.threadId === threadId) ? current : null;
      }),
    active: Effect.sync(() =>
      current && !["completed", "cancelled", "failed"].includes(current.status) ? [current] : [],
    ),
  });

  const activePolicy = options.settingsPolicy ?? policy;
  const smartRouting = {
    available: options.advisorConfigured ?? false,
    reason: options.advisorConfigured ? null : "smart_routing_session_required",
  };
  const settings = Layer.mock(OrchestrationSettings)({
    settings: Effect.succeed({
      policy: activePolicy,
      smartRouting,
      supportedProviderInstanceIds: activePolicy.profiles.map(
        (profile) => profile.selection.instanceId,
      ),
    }),
    saveSettings: (next) =>
      Effect.succeed({
        policy: next,
        smartRouting,
        supportedProviderInstanceIds: next.profiles.map((profile) => profile.selection.instanceId),
      }),
    setSmartRoutingSession: () =>
      Effect.succeed({
        policy: activePolicy,
        smartRouting,
        supportedProviderInstanceIds: activePolicy.profiles.map(
          (profile) => profile.selection.instanceId,
        ),
      }),
    recommendModels: () => Effect.succeed({ profiles: [], notes: [], source: "catalog" as const }),
  });

  const advisor = Layer.mock(OrchestrationAdvisor)({
    configured: Effect.succeed(options.advisorConfigured ?? false),
    localPrerequisites: Effect.succeed({ ready: true, reason: null }),
    status: Effect.succeed(smartRouting),
    setSmartRoutingSession: () => Effect.succeed(undefined),
    recommendProfiles: (profiles) => Effect.succeed(profiles),
    routeExecution: ({ objective, workers }) => {
      executionModeCalls.push({
        objective,
        candidateProfileIds: workers.map((candidate) => candidate.id),
      });
      const mode = options.executionMode ?? "orchestrated";
      return Effect.succeed({
        mode,
        source: options.routeAdvisorSource ?? options.advisorSource ?? ("policy" as const),
        confidence: 1,
        reason: mode === "direct" ? "Direct route" : "Orchestrated route",
      });
    },
    chooseProfile: ({ purpose, candidates, preferredProfileId }) => {
      profileCalls.push({
        purpose,
        candidateProfileIds: candidates.map((candidate) => candidate.id),
      });
      const selected =
        candidates.find((candidate) => candidate.id === preferredProfileId) ?? candidates[0]!;
      return Effect.succeed({
        profileId: selected.id,
        source: options.profileAdvisorSource ?? options.advisorSource ?? ("policy" as const),
        confidence: 1,
        reason:
          (options.profileAdvisorSource ?? options.advisorSource) === "jev"
            ? "Smart Routing recommendation"
            : "Policy order",
      });
    },
  });

  const models = Layer.mock(OrchestrationModelCatalog)({
    runnableProfiles: (activePolicy, role) =>
      Effect.succeed(activePolicy.profiles.filter((profile) => profile[role])),
    refreshProfile: (profile) =>
      Effect.succeed({
        usable: profile.id === leadProfile.id ? currentProfileAvailable : true,
        quotaExhausted: profile.id === leadProfile.id && !currentProfileAvailable,
        providerReady: true,
        managedSafe: true,
      }),
  });

  const engine = Layer.mock(OrchestrationEngineService)({
    dispatch: (command) =>
      Effect.sync(() => {
        if (command.type === "thread.turn.start") {
          const persisted = current?.attempts.find(
            (candidate) => candidate.requestMessageId === command.message.messageId,
          );
          turnDispatches.push({
            persistedAttachments: [...(persisted?.attachments ?? [])],
            dispatchedAttachments: [...command.message.attachments],
          });
        }
        commands.push(command);
        return { sequence: commands.length };
      }),
    readEvents: () => Stream.empty,
    readThreadEvents: () => Stream.empty,
    getThreadReplayStats: () =>
      Effect.succeed({ eventCount: 0, payloadBytes: 0, hasCreateEvent: false }),
    streamDomainEvents: Stream.empty,
    subscribeDomainEvents: Effect.succeed(Stream.empty),
    latestSequence: Effect.succeed(0),
  });

  const projection = Layer.mock(ProjectionSnapshotQuery)({
    getProjectShellById: (id) =>
      Effect.succeed(
        Option.some({
          id,
          title: "Project",
          workspaceRoot: "/repo",
          defaultModelSelection: null,
          scripts: [],
          createdAt: now,
          updatedAt: now,
        }),
      ),
    getThreadDetailById: (threadId) =>
      Effect.succeed(
        options.existingThreads?.includes(threadId)
          ? Option.some({
              id: threadId,
              projectId,
              title: "Managed thread",
              modelSelection: leadProfile.selection,
              runtimeMode: current?.runtimeMode ?? "approval-required",
              interactionMode: "default" as const,
              branch: null,
              worktreePath: null,
              pullRequests: [],
              latestTurn: null,
              createdAt: now,
              updatedAt: now,
              archivedAt: null,
              settledOverride: null,
              settledAt: null,
              unsettledAt: null,
              activeOrderKey: null,
              snoozedUntil: null,
              snoozedAt: null,
              pinnedAt: null,
              pinOrderKey: null,
              deletedAt: null,
              messages: [],
              proposedPlans: [],
              activities: [...(options.threadActivities ?? [])],
              checkpoints: [],
              session: null,
            })
          : Option.none(),
      ),
  });

  const turns = Layer.mock(ProjectionTurnRepository)({
    getPendingTurnStartByThreadId: () => Effect.succeed(Option.none()),
    listByThreadId: () => Effect.succeed([]),
  });

  const git = Layer.mock(GitWorkflowService)({
    listRefs: () =>
      Effect.succeed({
        refs: [],
        isRepo: true,
        hasPrimaryRemote: false,
        nextCursor: null,
        totalCount: 0,
      }),
    createWorktree: (input) =>
      Effect.sync(() => {
        createdWorktrees.push(input);
        return {
          worktree: {
            path: "/repo/.dispatch-worktrees/lead",
            refName: input.newRefName ?? input.refName,
          },
        };
      }),
    removeWorktree: (input) =>
      Effect.gen(function* () {
        removedWorktrees.push(input.path);
        if (options.removeWorktreeFails)
          return yield* new GitCommandError({
            operation: "remove-worktree",
            command: "git worktree remove",
            cwd: input.cwd,
            detail: "scripted cleanup failure",
          });
      }),
  });

  const processLayer = Layer.mock(ProcessRunner)({
    run: (input) => {
      processCalls.push(input);
      const scripted = options.process?.(input);
      return Effect.succeed({
        stdout:
          scripted?.stdout ??
          (input.command === "git" && input.args[0] === "rev-parse" ? `${head}\n` : ""),
        stderr: scripted?.stderr ?? "",
        code: ChildProcessSpawner.ExitCode(scripted?.code ?? 0),
        timedOut: false,
        stdoutTruncated: false,
        stderrTruncated: false,
        stdoutInvalidUtf8: false,
        stderrInvalidUtf8: false,
      });
    },
  });

  const layer = Layer.mergeAll(
    store,
    settings,
    advisor,
    models,
    engine,
    projection,
    turns,
    git,
    processLayer,
    ServerConfig.layerTest(process.cwd(), { prefix: "dispatch-orchestration-runtime-test-" }).pipe(
      Layer.provide(NodeServices.layer),
    ),
  );

  return {
    layer,
    commands,
    processCalls,
    removedWorktrees,
    createdWorktrees,
    executionModeCalls,
    profileCalls,
    turnDispatches,
    current: () => current,
  };
}

it.effect(
  "starts Standard Flow without hosted routing and persists the exact lead prompt before dispatch",
  () => {
    const f = fixture();
    return Effect.gen(function* () {
      const runtime = yield* make;
      const run = yield* runtime.start({
        commandId: "start-no-jev",
        projectId,
        runtimeMode: "approval-required",
        prompt: "Refactor the auth boundary",
        attachments: [],
      });

      expect(run.policy.enabled).toBe(true);
      expect(run.policy.flowMode).toBe("standard");
      expect(run.runtimeMode).toBe("approval-required");
      expect(run.lead.profileId).toBe(leadProfile.id);
      expect(f.executionModeCalls).toEqual([]);
      expect(f.profileCalls).toEqual([]);
      expect(run.lead.threadId).toMatch(/^team-[a-f0-9-]+-lead$/);
      expect(run.attempts).toHaveLength(1);
      expect(run.attempts[0]?.role).toBe("plan");
      expect(run.attempts[0]?.status).toBe("running");
      expect(run.attempts[0]?.prompt).toContain("Dispatch is the only scheduler");
      const created = f.commands.find(
        (command) => command.type === "thread.create" && command.threadId === run.lead.threadId,
      );
      expect(created?.type === "thread.create" && created.runtimeMode).toBe("approval-required");
      const turn = f.commands.find((command) => command.type === "thread.turn.start");
      expect(turn?.type === "thread.turn.start" && turn.message.text).toBe(run.attempts[0]?.prompt);
      expect(turn?.type === "thread.turn.start" && turn.runtimeMode).toBe("approval-required");
    }).pipe(Effect.provide(f.layer));
  },
);

it.effect(
  "uses a single Worker when Auto confidently routes the objective to direct execution",
  () => {
    const frontierLead: TeamModelProfile = {
      ...leadProfile,
      id: "frontier-lead",
      label: "Frontier Lead",
      selection: { instanceId: ProviderInstanceId.make("openai"), model: "astra" },
      lead: true,
      worker: false,
      capability: "frontier",
    };
    const complexWorker: TeamModelProfile = {
      ...failoverProfile,
      id: "complex-worker",
      label: "Complex Worker",
      lead: false,
      worker: true,
      capability: "complex",
    };
    const generalWorker: TeamModelProfile = {
      ...leadProfile,
      id: "general-worker",
      label: "General Worker",
      selection: { instanceId: ProviderInstanceId.make("openai"), model: "luna" },
      lead: false,
      worker: true,
      capability: "general",
    };
    const directPolicy: TeamSettings["policy"] = {
      ...policy,
      flowMode: "auto",
      profiles: [frontierLead, complexWorker, generalWorker],
    };
    const f = fixture(null, true, {
      advisorConfigured: true,
      executionMode: "direct",
      advisorSource: "jev",
      settingsPolicy: directPolicy,
    });

    return Effect.gen(function* () {
      const runtime = yield* make;
      const run = yield* runtime.start({
        commandId: "direct-start",
        projectId,
        runtimeMode: "full-access",
        prompt: "Rename the local helper and update its focused test",
        attachments: [],
      });

      expect(run.executionMode).toBe("direct");
      expect(run.runtimeMode).toBe("full-access");
      expect(run.policy).toEqual(directPolicy);
      expect(run.lead).toMatchObject({ role: "lead", profileId: complexWorker.id, taskId: null });
      expect(run.attempts[0]).toMatchObject({
        role: "plan",
        selection: complexWorker.selection,
        owner: { profileId: complexWorker.id },
      });
      expect(f.executionModeCalls).toEqual([
        {
          objective: "Rename the local helper and update its focused test",
          candidateProfileIds: [complexWorker.id, generalWorker.id],
        },
      ]);
      expect(f.profileCalls[0]).toEqual({
        purpose: "worker",
        candidateProfileIds: [complexWorker.id, generalWorker.id],
      });
      expect(
        run.attempts.some(
          (candidate) => candidate.selection.model === frontierLead.selection.model,
        ),
      ).toBe(false);
      const created = f.commands.find((command) => command.type === "thread.create");
      const turn = f.commands.find((command) => command.type === "thread.turn.start");
      expect(created?.type === "thread.create" && created.runtimeMode).toBe("full-access");
      expect(turn?.type === "thread.turn.start" && turn.runtimeMode).toBe("full-access");
    }).pipe(Effect.provide(f.layer));
  },
);

it.effect("returns an existing Auto run without repeating hosted routing", () => {
  const autoPolicy: TeamSettings["policy"] = { ...policy, flowMode: "auto" };
  const f = fixture(null, true, {
    advisorConfigured: true,
    executionMode: "direct",
    advisorSource: "jev",
    settingsPolicy: autoPolicy,
  });
  const input = {
    commandId: "duplicate-auto-start",
    projectId,
    runtimeMode: "approval-required",
    prompt: "Update the focused runtime test",
    attachments: [],
  } as const;

  return Effect.gen(function* () {
    const runtime = yield* make;
    const first = yield* runtime.start(input);
    const second = yield* runtime.start(input);

    expect(second.id).toBe(first.id);
    expect(f.executionModeCalls).toHaveLength(1);
    expect(f.profileCalls).toHaveLength(1);
  }).pipe(Effect.provide(f.layer));
});

it.effect("keeps Auto when a routed objective has only one eligible execution profile", () => {
  const workerOnly: TeamModelProfile = { ...leadProfile, lead: false, worker: true };
  const singlePolicy: TeamSettings["policy"] = {
    ...policy,
    flowMode: "auto",
    profiles: [workerOnly],
  };
  const f = fixture(null, true, {
    advisorConfigured: true,
    executionMode: "direct",
    routeAdvisorSource: "jev",
    profileAdvisorSource: "policy",
    settingsPolicy: singlePolicy,
  });

  return Effect.gen(function* () {
    const runtime = yield* make;
    const run = yield* runtime.start({
      commandId: "single-profile-auto-start",
      projectId,
      runtimeMode: "approval-required",
      prompt: "Update the focused runtime test",
      attachments: [],
    });

    expect(run.executionMode).toBe("direct");
    expect(run.policy.flowMode).toBe("auto");
    expect(run.lead.profileId).toBe(workerOnly.id);
    expect(teamThreadView(run)?.notice).toBeNull();
    expect(f.executionModeCalls).toHaveLength(1);
    expect(f.profileCalls).toEqual([]);
  }).pipe(Effect.provide(f.layer));
});

it.effect("rejects Worker-only Auto when Smart Routing selects a managed team", () => {
  const workerOnly: TeamModelProfile = { ...leadProfile, lead: false, worker: true };
  const workerOnlyPolicy: TeamSettings["policy"] = {
    ...policy,
    flowMode: "auto",
    profiles: [workerOnly],
  };
  const f = fixture(null, true, {
    advisorConfigured: true,
    executionMode: "orchestrated",
    routeAdvisorSource: "jev",
    settingsPolicy: workerOnlyPolicy,
  });

  return Effect.gen(function* () {
    const runtime = yield* make;
    const error = yield* runtime
      .start({
        commandId: "worker-only-managed-team",
        projectId,
        runtimeMode: "approval-required",
        prompt: "Coordinate a multi-part change",
        attachments: [],
      })
      .pipe(Effect.flip);

    expect(error.code).toBe("unavailable");
    expect(error.message).toContain("selected a managed team");
    expect(error.message).toContain("Lead model");
    expect(f.profileCalls).toEqual([]);
  }).pipe(Effect.provide(f.layer));
});

it.effect("reports a missing Lead when Worker-only Auto falls back to Standard", () => {
  const workerOnly: TeamModelProfile = { ...leadProfile, lead: false, worker: true };
  const workerOnlyPolicy: TeamSettings["policy"] = {
    ...policy,
    flowMode: "auto",
    profiles: [workerOnly],
  };
  const f = fixture(null, true, {
    advisorConfigured: true,
    executionMode: "orchestrated",
    routeAdvisorSource: "policy",
    settingsPolicy: workerOnlyPolicy,
  });

  return Effect.gen(function* () {
    const runtime = yield* make;
    const error = yield* runtime
      .start({
        commandId: "worker-only-standard-fallback",
        projectId,
        runtimeMode: "approval-required",
        prompt: "Handle the change",
        attachments: [],
      })
      .pipe(Effect.flip);

    expect(error.code).toBe("unavailable");
    expect(error.message).toContain("fell back to Standard");
    expect(error.message).toContain("Lead model");
    expect(f.profileCalls).toEqual([]);
  }).pipe(Effect.provide(f.layer));
});

it.effect(
  "falls back to Standard when Auto execution succeeds but profile selection is uncertain",
  () => {
    const autoPolicy: TeamSettings["policy"] = { ...policy, flowMode: "auto" };
    const f = fixture(null, true, {
      advisorConfigured: true,
      executionMode: "direct",
      routeAdvisorSource: "jev",
      profileAdvisorSource: "policy",
      settingsPolicy: autoPolicy,
    });

    return Effect.gen(function* () {
      const runtime = yield* make;
      const run = yield* runtime.start({
        commandId: "profile-fallback-start",
        projectId,
        runtimeMode: "approval-required",
        prompt: "Update the focused runtime test",
        attachments: [],
      });

      expect(run.executionMode).toBe("orchestrated");
      expect(run.policy.flowMode).toBe("standard");
      expect(run.lead.profileId).toBe(leadProfile.id);
      expect(run.decisions).toContain(
        "Smart Routing was unavailable or uncertain. Flow continued with Standard using your saved model order.",
      );
      expect(f.executionModeCalls).toHaveLength(1);
      expect(f.profileCalls).toHaveLength(1);
    }).pipe(Effect.provide(f.layer));
  },
);

it.effect(
  "uses the sole Lead profile without hosted profile inference after Auto routes to a team",
  () => {
    const frontierLead: TeamModelProfile = {
      ...leadProfile,
      id: "frontier-lead",
      label: "Frontier Lead",
      selection: { instanceId: ProviderInstanceId.make("openai"), model: "astra" },
      lead: true,
      worker: false,
      capability: "frontier",
    };
    const generalWorker: TeamModelProfile = {
      ...failoverProfile,
      id: "general-worker",
      label: "General Worker",
      lead: false,
      worker: true,
      capability: "general",
    };
    const routedPolicy: TeamSettings["policy"] = {
      ...policy,
      flowMode: "auto",
      profiles: [generalWorker, frontierLead],
    };
    const f = fixture(null, true, {
      advisorConfigured: true,
      executionMode: "orchestrated",
      advisorSource: "jev",
      settingsPolicy: routedPolicy,
    });

    return Effect.gen(function* () {
      const runtime = yield* make;
      const run = yield* runtime.start({
        commandId: "orchestrated-start",
        projectId,
        runtimeMode: "approval-required",
        prompt: "Re-architect authentication across the server and web client",
        attachments: [],
      });

      expect(run.executionMode).toBe("orchestrated");
      expect(run.lead.profileId).toBe(frontierLead.id);
      expect(f.profileCalls).toEqual([]);
      expect(run.attempts[0]?.selection).toEqual(frontierLead.selection);
    }).pipe(Effect.provide(f.layer));
  },
);

it.effect("falls back visibly to Standard when Auto has no safe Worker routing candidate", () => {
  const frontierLead: TeamModelProfile = {
    ...leadProfile,
    id: "frontier-only-lead",
    label: "Frontier Only Lead",
    lead: true,
    worker: false,
    capability: "frontier",
  };
  const routedPolicy: TeamSettings["policy"] = {
    ...policy,
    flowMode: "auto",
    profiles: [frontierLead],
  };
  const f = fixture(null, true, { executionMode: "direct", settingsPolicy: routedPolicy });

  return Effect.gen(function* () {
    const runtime = yield* make;
    const run = yield* runtime.start({
      commandId: "no-direct-worker",
      projectId,
      runtimeMode: "approval-required",
      prompt: "Rename one local helper",
      attachments: [],
    });

    expect(run.executionMode).toBe("orchestrated");
    expect(run.policy.flowMode).toBe("standard");
    expect(run.lead.profileId).toBe(frontierLead.id);
    expect(run.decisions).toContain(
      "Smart Routing was unavailable or uncertain. Flow continued with Standard using your saved model order.",
    );
    expect(f.executionModeCalls).toEqual([]);
    expect(f.profileCalls).toEqual([]);
  }).pipe(Effect.provide(f.layer));
});

it.effect("rejects a run with no runnable Lead or Worker without calling hosted routing", () => {
  const emptyPolicy: TeamSettings["policy"] = {
    ...policy,
    flowMode: "auto",
    profiles: [],
  };
  const f = fixture(null, true, {
    executionMode: "direct",
    advisorSource: "jev",
    settingsPolicy: emptyPolicy,
  });

  return Effect.gen(function* () {
    const runtime = yield* make;
    const error = yield* runtime
      .start({
        commandId: "no-runnable-models",
        projectId,
        runtimeMode: "approval-required",
        prompt: "Handle the task",
        attachments: [],
      })
      .pipe(Effect.flip);

    expect(error.code).toBe("unavailable");
    expect(error.message).toContain("Lead model");
    expect(f.executionModeCalls).toEqual([]);
    expect(f.profileCalls).toEqual([]);
  }).pipe(Effect.provide(f.layer));
});

it.effect("ignores delegated plan tasks in direct mode and proceeds with the same agent", () => {
  const directWorker: TeamModelProfile = {
    ...leadProfile,
    lead: false,
    worker: true,
    capability: "general",
  };
  const directPolicy: TeamSettings["policy"] = { ...policy, profiles: [directWorker] };
  const directOwner = {
    role: "lead" as const,
    profileId: directWorker.id,
    threadId: leadThreadId,
    taskId: null,
  };
  const plan = attempt({
    id: "direct-plan",
    role: "plan",
    owner: directOwner,
    status: "succeeded",
    result: JSON.stringify({
      acceptance: ["Focused change is verified"],
      tasks: [
        {
          id: "should-not-run",
          objective: "Delegate the supposedly simple edit",
          acceptance: ["Delegated edit is complete"],
          dependencies: ["missing-dependency"],
          context: "This graph is intentionally invalid because direct mode must ignore it.",
        },
      ],
      rationale: "A delegated task was proposed.",
    }),
  });
  const seed = baseRun({
    executionMode: "direct",
    policy: directPolicy,
    lead: directOwner,
    status: "planning",
    acceptance: [],
    workspace: {
      root: "/repo",
      baseCommit: head,
      integrationHead: head,
      leadBranch: null,
      leadWorktreePath: null,
    },
    attempts: [plan],
  });
  const f = fixture(seed);

  return Effect.gen(function* () {
    const runtime = yield* make;
    yield* runtime.tick();
    const run = f.current()!;

    expect(run.tasks).toEqual([]);
    expect(run.status).toBe("review");
    expect(run.decisions.at(-1)).toContain("Dispatch enforced direct execution");
    expect(run.attempts.some((candidate) => candidate.role === "work")).toBe(false);
    expect(run.attempts.findLast((candidate) => candidate.role === "integrate")).toMatchObject({
      owner: { profileId: directWorker.id, threadId: directOwner.threadId },
      taskId: null,
    });
    expect(f.createdWorktrees).toHaveLength(1);
    expect(f.createdWorktrees[0]?.newRefName).toContain("/lead");
    expect(f.createdWorktrees.some((worktree) => worktree.newRefName?.includes("/task/"))).toBe(
      false,
    );
  }).pipe(Effect.provide(f.layer));
});

it.effect(
  "Standard assigns workers from saved order even when the Lead prefers another profile",
  () => {
    const plan = attempt({
      id: "standard-plan-with-preference",
      role: "plan",
      owner: baseRun().lead,
      status: "succeeded",
      result: JSON.stringify({
        acceptance: ["The task is verified"],
        tasks: [
          {
            id: "standard-task",
            objective: "Implement the bounded change",
            acceptance: ["Focused verification passes"],
            dependencies: [],
            preferredProfileId: failoverProfile.id,
            context: "The Lead preference must not override Standard saved order.",
          },
        ],
        rationale: "Delegate one bounded task.",
      }),
    });
    const f = fixture(
      baseRun({
        status: "planning",
        acceptance: [],
        attempts: [plan],
      }),
    );

    return Effect.gen(function* () {
      const runtime = yield* make;
      yield* runtime.tick();
      const run = f.current()!;

      expect(run.policy.flowMode).toBe("standard");
      expect(run.tasks[0]?.owner.profileId).toBe(leadProfile.id);
      expect(f.profileCalls).toEqual([]);
    }).pipe(Effect.provide(f.layer));
  },
);

it.effect("stops hosted Worker selection after the first Auto profile fallback", () => {
  const autoPolicy: TeamSettings["policy"] = { ...policy, flowMode: "auto" };
  const plan = attempt({
    id: "auto-plan-profile-fallback",
    role: "plan",
    owner: baseRun().lead,
    status: "succeeded",
    result: JSON.stringify({
      acceptance: ["Both tasks are verified"],
      tasks: [
        {
          id: "auto-task-a",
          objective: "Implement change A",
          acceptance: ["A passes"],
          dependencies: [],
          preferredProfileId: failoverProfile.id,
          context: "Independent task A",
        },
        {
          id: "auto-task-b",
          objective: "Implement change B",
          acceptance: ["B passes"],
          dependencies: [],
          preferredProfileId: failoverProfile.id,
          context: "Independent task B",
        },
      ],
      rationale: "Delegate two independent tasks.",
    }),
  });
  const f = fixture(
    baseRun({
      status: "planning",
      policy: autoPolicy,
      acceptance: [],
      attempts: [plan],
    }),
    true,
    { profileAdvisorSource: "policy" },
  );

  return Effect.gen(function* () {
    const runtime = yield* make;
    yield* runtime.tick();
    const run = f.current()!;

    expect(run.policy.flowMode).toBe("standard");
    expect(run.tasks.map((task) => task.owner.profileId)).toEqual([leadProfile.id, leadProfile.id]);
    expect(run.decisions).toContain(
      "Smart Routing was unavailable or uncertain. Flow continued with Standard using your saved model order.",
    );
    expect(f.profileCalls).toHaveLength(1);
  }).pipe(Effect.provide(f.layer));
});

it.effect(
  "pauses for a user decision with comparable alternatives when the active provider limit is hit",
  () => {
    const leadThreadId = ThreadId.make("team-limit-lead");
    const attemptId = "attempt-limit";
    const seed: TeamRun = {
      id: "limit-run",
      commandId: "limit-command",
      projectId,
      revision: 0,
      executionMode: "orchestrated",
      runtimeMode: "approval-required",
      prompt: "Migrate the API",
      policy,
      lead: { role: "lead", profileId: leadProfile.id, threadId: leadThreadId, taskId: null },
      acceptance: ["API migration is verified"],
      decisions: [],
      status: "running",
      statusReason: null,
      workspace: {
        root: "/repo",
        baseCommit: head,
        integrationHead: head,
        leadBranch: "orchestration/limit-run/lead",
        leadWorktreePath: "/repo/.dispatch-worktrees/lead",
      },
      tasks: [],
      attempts: [
        {
          id: attemptId,
          commandId: "attempt-limit-command",
          requestMessageId: "attempt-limit-message" as never,
          taskId: null,
          role: "integrate",
          sequence: 0,
          owner: { role: "lead", profileId: leadProfile.id, threadId: leadThreadId, taskId: null },
          selection: leadProfile.selection,
          prompt: "Verify the run",
          attachments: [],
          status: "reserved",
          providerTurnId: null,
          resultMessageId: null,
          result: null,
          failure: null,
          createdAt: now,
          updatedAt: now,
        },
      ],
      messages: [],
      settlements: [],
      failovers: [],
      attachments: [],
      createdAt: now,
      updatedAt: now,
    };
    const f = fixture(seed, false);
    return Effect.gen(function* () {
      const runtime = yield* make;
      yield* runtime.tick();
      const run = f.current()!;

      expect(run.status).toBe("awaiting-provider-decision");
      expect(run.failovers).toHaveLength(1);
      expect(run.failovers[0]).toMatchObject({
        attemptId,
        fromProfileId: leadProfile.id,
        candidateProfileIds: [failoverProfile.id],
        status: "pending",
        trigger: { kind: "provider-limit" },
      });
      expect(f.commands).toEqual([]);
    }).pipe(Effect.provide(f.layer));
  },
);

it.effect("uses Worker-role candidates when a direct executor needs provider failover", () => {
  const directWorker: TeamModelProfile = {
    ...leadProfile,
    label: "Direct Worker",
    lead: false,
    worker: true,
    capability: "general",
  };
  const replacementWorker: TeamModelProfile = {
    ...failoverProfile,
    id: "replacement-worker",
    label: "Replacement Worker",
    lead: false,
    worker: true,
    capability: "general",
  };
  const leadOnly: TeamModelProfile = {
    ...failoverProfile,
    id: "lead-only",
    label: "Lead Only",
    selection: { instanceId: ProviderInstanceId.make("google"), model: "frontier" },
    lead: true,
    worker: false,
    capability: "frontier",
  };
  const directPolicy: TeamSettings["policy"] = {
    ...policy,
    profiles: [directWorker, leadOnly, replacementWorker],
  };
  const directOwner = {
    role: "lead" as const,
    profileId: directWorker.id,
    threadId: leadThreadId,
    taskId: null,
  };
  const limited = attempt({
    id: "direct-provider-limit",
    role: "integrate",
    owner: directOwner,
  });
  const f = fixture(
    baseRun({
      executionMode: "direct",
      policy: directPolicy,
      lead: directOwner,
      status: "review",
      attempts: [limited],
    }),
    false,
  );

  return Effect.gen(function* () {
    const runtime = yield* make;
    yield* runtime.tick();
    const run = f.current()!;

    expect(run.status).toBe("awaiting-provider-decision");
    expect(run.failovers).toHaveLength(1);
    expect(run.failovers[0]).toMatchObject({
      attemptId: limited.id,
      fromProfileId: directWorker.id,
      candidateProfileIds: [replacementWorker.id],
      status: "pending",
    });
    expect(run.failovers[0]?.candidateProfileIds).not.toContain(leadOnly.id);
  }).pipe(Effect.provide(f.layer));
});

it.effect(
  "requires a provider decision for auto failover when capability metadata and Smart Routing are unavailable",
  () => {
    const unknownLeadProfile: TeamModelProfile = { ...leadProfile, capability: undefined };
    const autoPolicy: TeamSettings["policy"] = {
      ...policy,
      flowMode: "auto",
      providerLimitBehavior: "auto",
      profiles: [unknownLeadProfile, failoverProfile, secondFailoverProfile],
    };
    const limited = attempt({
      id: "auto-limit-without-capability",
      role: "integrate",
      owner: baseRun().lead,
    });
    const f = fixture(
      baseRun({
        policy: autoPolicy,
        attempts: [limited],
      }),
      false,
    );

    return Effect.gen(function* () {
      const runtime = yield* make;
      yield* runtime.tick();
      const run = f.current()!;

      expect(run.status).toBe("awaiting-provider-decision");
      expect(run.statusReason).toContain("cannot prove an equivalent automatic replacement");
      expect(run.failovers).toHaveLength(1);
      expect(run.failovers[0]).toMatchObject({
        attemptId: limited.id,
        fromProfileId: unknownLeadProfile.id,
        candidateProfileIds: [failoverProfile.id, secondFailoverProfile.id],
        status: "pending",
      });
      expect(run.attempts).toHaveLength(1);
      expect(f.commands).toEqual([]);
    }).pipe(Effect.provide(f.layer));
  },
);

it.effect(
  "requires a provider decision when Smart Routing falls back to policy without capability metadata",
  () => {
    const unknownLeadProfile: TeamModelProfile = { ...leadProfile, capability: undefined };
    const autoPolicy: TeamSettings["policy"] = {
      ...policy,
      flowMode: "auto",
      providerLimitBehavior: "auto",
      profiles: [unknownLeadProfile, failoverProfile, secondFailoverProfile],
    };
    const limited = attempt({
      id: "auto-limit-jev-policy-fallback",
      role: "integrate",
      owner: baseRun().lead,
    });
    const f = fixture(
      baseRun({
        policy: autoPolicy,
        attempts: [limited],
      }),
      false,
      { advisorConfigured: true, advisorSource: "policy" },
    );

    return Effect.gen(function* () {
      const runtime = yield* make;
      yield* runtime.tick();
      const run = f.current()!;

      expect(run.status).toBe("awaiting-provider-decision");
      expect(run.policy.flowMode).toBe("standard");
      expect(run.decisions).toContain(
        "Smart Routing was unavailable or uncertain. Flow continued with Standard using your saved model order.",
      );
      expect(run.statusReason).toBe(
        "A provider limit was reached, but Dispatch cannot prove an equivalent automatic replacement because capability metadata is missing and Smart Routing did not return a confident decision. Choose another selected provider.",
      );
      expect(run.failovers).toHaveLength(1);
      expect(run.failovers[0]).toMatchObject({
        attemptId: limited.id,
        fromProfileId: unknownLeadProfile.id,
        candidateProfileIds: [failoverProfile.id, secondFailoverProfile.id],
        status: "pending",
        decision: null,
      });
      expect(run.attempts).toHaveLength(1);
      expect(run.attempts[0]?.id).toBe(limited.id);
      expect(f.commands).toEqual([]);
    }).pipe(Effect.provide(f.layer));
  },
);

it.effect(
  "keeps Auto and skips hosted profile selection when one capability-safe failover remains",
  () => {
    const autoPolicy: TeamSettings["policy"] = {
      ...policy,
      flowMode: "auto",
      providerLimitBehavior: "auto",
    };
    const limited = attempt({
      id: "auto-single-safe-failover",
      role: "integrate",
      owner: baseRun().lead,
    });
    const f = fixture(
      baseRun({
        policy: autoPolicy,
        status: "review",
        attempts: [limited],
      }),
      false,
      { advisorConfigured: true, profileAdvisorSource: "policy" },
    );

    return Effect.gen(function* () {
      const runtime = yield* make;
      yield* runtime.tick();
      const run = f.current()!;

      expect(run.policy.flowMode).toBe("auto");
      expect(run.failovers[0]).toMatchObject({
        status: "applied",
        candidateProfileIds: [failoverProfile.id],
        decision: {
          action: "switch",
          profileId: failoverProfile.id,
          source: "policy",
        },
      });
      expect(f.profileCalls).toEqual([]);
    }).pipe(Effect.provide(f.layer));
  },
);

it.effect(
  "falls back to Standard and uses saved equivalent order when Auto failover profile selection is uncertain",
  () => {
    const autoPolicy: TeamSettings["policy"] = {
      ...policy,
      flowMode: "auto",
      providerLimitBehavior: "auto",
      profiles: [leadProfile, failoverProfile, secondFailoverProfile],
    };
    const limited = attempt({
      id: "auto-limit-profile-fallback",
      role: "integrate",
      owner: baseRun().lead,
    });
    const f = fixture(
      baseRun({
        policy: autoPolicy,
        status: "review",
        attempts: [limited],
      }),
      false,
      { advisorConfigured: true, profileAdvisorSource: "policy" },
    );

    return Effect.gen(function* () {
      const runtime = yield* make;
      yield* runtime.tick();
      const run = f.current()!;
      const replacement = run.attempts.find((candidate) => candidate.id !== limited.id);

      expect(run.policy.flowMode).toBe("standard");
      expect(run.decisions).toContain(
        "Smart Routing was unavailable or uncertain. Flow continued with Standard using your saved model order.",
      );
      expect(run.failovers[0]).toMatchObject({
        status: "applied",
        decision: {
          action: "switch",
          profileId: failoverProfile.id,
          source: "policy",
        },
      });
      expect(replacement).toMatchObject({ owner: { profileId: failoverProfile.id } });
      expect(f.profileCalls).toHaveLength(1);
    }).pipe(Effect.provide(f.layer));
  },
);

it.effect(
  "allows automatic failover when Smart Routing confidently selects the alternate provider without capability metadata",
  () => {
    const unknownLeadProfile: TeamModelProfile = { ...leadProfile, capability: undefined };
    const autoPolicy: TeamSettings["policy"] = {
      ...policy,
      flowMode: "auto",
      providerLimitBehavior: "auto",
      profiles: [unknownLeadProfile, failoverProfile, secondFailoverProfile],
    };
    const limited = attempt({
      id: "auto-limit-jev-confident",
      role: "integrate",
      owner: baseRun().lead,
    });
    const f = fixture(
      baseRun({
        policy: autoPolicy,
        attempts: [limited],
      }),
      false,
      { advisorConfigured: true, advisorSource: "jev" },
    );

    return Effect.gen(function* () {
      const runtime = yield* make;
      yield* runtime.tick();
      const run = f.current()!;
      const replacement = run.attempts.find((candidate) => candidate.id !== limited.id);

      expect(run.status).toBe("review");
      expect(run.statusReason).toBeNull();
      expect(run.failovers).toHaveLength(1);
      expect(run.failovers[0]).toMatchObject({
        attemptId: limited.id,
        fromProfileId: unknownLeadProfile.id,
        candidateProfileIds: [failoverProfile.id, secondFailoverProfile.id],
        status: "applied",
        decision: {
          action: "switch",
          profileId: failoverProfile.id,
          source: "advisor",
        },
      });
      expect(replacement).toMatchObject({
        role: "integrate",
        taskId: null,
        status: "running",
        owner: { profileId: failoverProfile.id },
      });
      expect(run.attempts).toHaveLength(2);
      expect(
        f.commands.some(
          (command) =>
            command.type === "thread.turn.start" &&
            command.threadId === replacement?.owner.threadId,
        ),
      ).toBe(true);
      const replacementCreate = f.commands.find(
        (command) =>
          command.type === "thread.create" && command.threadId === replacement?.owner.threadId,
      );
      const replacementTurn = f.commands.find(
        (command) =>
          command.type === "thread.turn.start" && command.threadId === replacement?.owner.threadId,
      );
      expect(replacementCreate?.type === "thread.create" && replacementCreate.runtimeMode).toBe(
        "approval-required",
      );
      expect(replacementTurn?.type === "thread.turn.start" && replacementTurn.runtimeMode).toBe(
        "approval-required",
      );
    }).pipe(Effect.provide(f.layer));
  },
);

it.effect("restart continues an existing managed thread with the frozen approval mode", () => {
  const f = fixture(baseRun({ status: "review", runtimeMode: "auto-accept-edits" }), true, {
    existingThreads: [leadThreadId],
  });

  return Effect.gen(function* () {
    const runtime = yield* make;
    yield* runtime.tick();

    expect(
      f.commands.some(
        (command) => command.type === "thread.create" && command.threadId === leadThreadId,
      ),
    ).toBe(false);
    const continuation = f.commands.find(
      (command) => command.type === "thread.turn.start" && command.threadId === leadThreadId,
    );
    expect(continuation?.type === "thread.turn.start" && continuation.runtimeMode).toBe(
      "auto-accept-edits",
    );
  }).pipe(Effect.provide(f.layer));
});

it.effect("dispatches a newly reserved worker attempt in the same scheduler tick", () => {
  const workerThreadId = ThreadId.make("team-runtime-worker");
  const task: TeamTask = {
    id: "worker-task",
    objective: "Implement the worker slice",
    acceptance: ["Worker slice is verified"],
    dependencies: [],
    owner: {
      role: "worker",
      profileId: leadProfile.id,
      threadId: workerThreadId,
      taskId: "worker-task",
    },
    branch: null,
    worktreePath: null,
    status: "pending",
    attemptIds: [],
    settlementId: null,
    result: null,
  };
  const f = fixture(baseRun({ tasks: [task] }));

  return Effect.gen(function* () {
    const runtime = yield* make;
    yield* runtime.tick();

    const run = f.current()!;
    const work = run.attempts.find((candidate) => candidate.role === "work");
    expect(work).toMatchObject({ taskId: task.id, status: "running" });
    expect(
      f.commands.some(
        (command) => command.type === "thread.turn.start" && command.threadId === workerThreadId,
      ),
    ).toBe(true);
  }).pipe(Effect.provide(f.layer));
});

it.effect("dispatches a newly reserved lead review in the same scheduler tick", () => {
  const workerThreadId = ThreadId.make("team-runtime-review-worker");
  const taskId = "review-task";
  const workerOwner: TeamAttempt["owner"] = {
    role: "worker",
    profileId: leadProfile.id,
    threadId: workerThreadId,
    taskId,
  };
  const work = attempt({
    id: "completed-work",
    role: "work",
    owner: workerOwner,
    taskId,
    status: "succeeded",
    result: JSON.stringify({
      summary: "Worker finished",
      commit: head,
      changedFiles: ["src/runtime.ts"],
      checks: [],
      limitations: [],
    }),
  });
  const task: TeamTask = {
    id: taskId,
    objective: "Implement the reviewed slice",
    acceptance: ["Reviewed slice is correct"],
    dependencies: [],
    owner: workerOwner,
    branch: `orchestration/runtime-run/task/${taskId}`,
    worktreePath: "/repo/.dispatch-worktrees/review-task",
    status: "running",
    attemptIds: [work.id],
    settlementId: null,
    result: null,
  };
  const f = fixture(baseRun({ tasks: [task], attempts: [work] }));

  return Effect.gen(function* () {
    const runtime = yield* make;
    yield* runtime.tick();

    const run = f.current()!;
    const review = run.attempts.find((candidate) => candidate.role === "review");
    expect(review).toMatchObject({ taskId, status: "running" });
    expect(
      f.commands.some(
        (command) => command.type === "thread.turn.start" && command.threadId === leadThreadId,
      ),
    ).toBe(true);
  }).pipe(Effect.provide(f.layer));
});

it.effect("dispatches a newly reserved integration attempt in the same scheduler tick", () => {
  const f = fixture(baseRun({ status: "review" }));

  return Effect.gen(function* () {
    const runtime = yield* make;
    yield* runtime.tick();

    const run = f.current()!;
    const integration = run.attempts.find((candidate) => candidate.role === "integrate");
    expect(integration).toMatchObject({ status: "running" });
    expect(
      f.commands.some(
        (command) => command.type === "thread.turn.start" && command.threadId === leadThreadId,
      ),
    ).toBe(true);
  }).pipe(Effect.provide(f.layer));
});

it.effect("enforces lead-only planning and dispatches final integration in the same tick", () => {
  const leadOnlyPolicy: TeamSettings["policy"] = { ...policy, maxActive: 1 };
  const planAcceptance = ["The complete lead-only objective is verified"];
  const plan = attempt({
    id: "lead-only-plan",
    role: "plan",
    owner: baseRun().lead,
    status: "succeeded",
    result: JSON.stringify({
      acceptance: planAcceptance,
      tasks: [
        {
          id: "should-not-run",
          objective: "Delegate work even though only the lead is allowed",
          acceptance: ["Worker result exists"],
          dependencies: [],
          preferredProfileId: leadProfile.id,
          context: "This proposal must be ignored by the runtime.",
        },
      ],
      rationale: "A worker could do this independently.",
    }),
  });
  const f = fixture(
    baseRun({
      status: "planning",
      policy: leadOnlyPolicy,
      acceptance: [],
      attempts: [plan],
    }),
  );

  return Effect.gen(function* () {
    const runtime = yield* make;
    yield* runtime.tick();

    const run = f.current()!;
    const integration = run.attempts.find(
      (candidate) => candidate.role === "integrate" && candidate.taskId === null,
    );
    expect(run.policy.maxActive).toBe(1);
    expect(run.acceptance).toEqual(planAcceptance);
    expect(run.tasks).toEqual([]);
    expect(run.status).toBe("review");
    expect(run.decisions.at(-1)).toContain(
      "Dispatch enforced Lead-only execution because maxActive is 1; delegated tasks were not scheduled.",
    );
    expect(integration).toMatchObject({
      role: "integrate",
      taskId: null,
      status: "running",
      owner: { role: "lead", threadId: leadThreadId },
    });
    expect(f.createdWorktrees).toEqual([]);
    expect(
      f.commands
        .filter((command) => command.type === "thread.create")
        .map((command) => command.threadId),
    ).toEqual([leadThreadId]);
    expect(
      f.commands.some(
        (command) =>
          command.type === "thread.turn.start" && command.threadId === integration?.owner.threadId,
      ),
    ).toBe(true);
    expect(
      f.commands.some(
        (command) => "threadId" in command && String(command.threadId).includes("-worker-"),
      ),
    ).toBe(false);
  }).pipe(Effect.provide(f.layer));
});

it.effect(
  "does not dispatch two lead-owned pending attempts concurrently to the same lead thread",
  () => {
    const first = attempt({
      id: "lead-review-pending",
      role: "review",
      owner: baseRun().lead,
    });
    const second = attempt({
      id: "lead-integration-pending",
      role: "integrate",
      owner: baseRun().lead,
      sequence: 1,
    });
    const f = fixture(baseRun({ status: "review", attempts: [first, second] }));

    return Effect.gen(function* () {
      const runtime = yield* make;
      yield* runtime.tick();

      const starts = f.commands.filter(
        (command): command is Extract<OrchestrationCommand, { type: "thread.turn.start" }> =>
          command.type === "thread.turn.start",
      );
      expect(starts).toHaveLength(1);
      expect(starts[0]?.threadId).toBe(leadThreadId);
      expect(f.current()!.attempts.map(({ id, status }) => ({ id, status }))).toEqual([
        { id: first.id, status: "running" },
        { id: second.id, status: "reserved" },
      ]);
    }).pipe(Effect.provide(f.layer));
  },
);

function applyingSettlementSeed(): {
  readonly run: TeamRun;
  readonly settlement: TeamSettlement;
  readonly workerHead: string;
} {
  const workerHead = "b".repeat(40);
  const workerThreadId = ThreadId.make("team-runtime-settlement-worker");
  const taskId = "settlement-task";
  const owner: TeamTask["owner"] = {
    role: "worker",
    profileId: leadProfile.id,
    threadId: workerThreadId,
    taskId,
  };
  const settlement: TeamSettlement = {
    id: "settlement-applying",
    taskId,
    attemptId: "settlement-work",
    owner,
    sourceWorktreePath: "/repo/.dispatch-worktrees/settlement-task",
    baseCommit: head,
    headCommit: workerHead,
    appliedCommit: null,
    status: "applying",
    summary: "Worker reviewed and ready",
    createdAt: now,
    updatedAt: now,
  };
  const task: TeamTask = {
    id: taskId,
    objective: "Apply the worker settlement",
    acceptance: ["Worker commit is integrated"],
    dependencies: [],
    owner,
    branch: `orchestration/runtime-run/task/${taskId}`,
    worktreePath: settlement.sourceWorktreePath,
    status: "settling",
    attemptIds: [settlement.attemptId],
    settlementId: settlement.id,
    result: "Worker reviewed and ready",
  };
  return {
    workerHead,
    settlement,
    run: baseRun({
      status: "settling",
      tasks: [task],
      settlements: [settlement],
    }),
  };
}

function appliedSettlementSeed(): {
  readonly run: TeamRun;
  readonly settlement: TeamSettlement;
  readonly workerPath: string;
  readonly workerBranch: string;
} {
  const seed = applyingSettlementSeed();
  const appliedCommit = "c".repeat(40);
  const settlement: TeamSettlement = {
    ...seed.settlement,
    status: "applied",
    appliedCommit,
  };
  const task = seed.run.tasks[0]!;
  return {
    settlement,
    workerPath: task.worktreePath!,
    workerBranch: task.branch!,
    run: baseRun({
      status: "running",
      workspace: { ...seed.run.workspace!, integrationHead: appliedCommit },
      tasks: [{ ...task, status: "settled" }],
      settlements: [settlement],
    }),
  };
}

it.effect(
  "clears worker workspace metadata after a normal applied settlement cleanup succeeds",
  () => {
    const seed = applyingSettlementSeed();
    const ready: TeamSettlement = { ...seed.settlement, status: "ready" };
    const integratedHead = "f".repeat(40);
    const workerPath = seed.run.tasks[0]!.worktreePath!;
    const workerBranch = seed.run.tasks[0]!.branch!;
    const f = fixture(
      baseRun({
        status: "settling",
        tasks: seed.run.tasks,
        settlements: [ready],
      }),
      true,
      {
        process: (input) => {
          if (input.command !== "git") return undefined;
          if (input.args[0] === "rev-list") return { stdout: "1\n" };
          if (input.args[0] === "merge" && input.args[1] === "--no-edit") return { code: 0 };
          if (input.args[0] === "rev-parse" && input.args[1] === "HEAD")
            return { stdout: `${integratedHead}\n` };
          return undefined;
        },
      },
    );

    return Effect.gen(function* () {
      const runtime = yield* make;
      yield* runtime.tick();

      const run = f.current()!;
      expect(run.settlements[0]).toMatchObject({
        status: "applied",
        appliedCommit: integratedHead,
      });
      expect(run.tasks[0]).toMatchObject({
        status: "settled",
        branch: null,
        worktreePath: null,
      });
      expect(f.removedWorktrees).toEqual([workerPath]);
      expect(
        f.processCalls.some(
          (call) =>
            call.command === "git" &&
            call.args[0] === "branch" &&
            call.args[1] === "-D" &&
            call.args[2] === workerBranch,
        ),
      ).toBe(true);
    }).pipe(Effect.provide(f.layer));
  },
);

it.effect("restart retries cleanup for an applied settlement with stale worker metadata", () => {
  const { run: seed, workerPath, workerBranch } = appliedSettlementSeed();
  const f = fixture(seed);

  return Effect.gen(function* () {
    const runtime = yield* make;
    yield* runtime.tick();

    const run = f.current()!;
    expect(f.removedWorktrees).toEqual([workerPath]);
    expect(
      f.processCalls.some(
        (call) => call.command === "git" && call.args.join(" ") === `branch -D ${workerBranch}`,
      ),
    ).toBe(true);
    expect(run.tasks[0]).toMatchObject({ status: "settled", branch: null, worktreePath: null });
  }).pipe(Effect.provide(f.layer));
});

it.effect(
  "restart treats already-removed worker cleanup side effects as clean and clears stale metadata",
  () => {
    const { run: seed, workerPath, workerBranch } = appliedSettlementSeed();
    const f = fixture(seed, true, {
      removeWorktreeFails: true,
      process: (input) => {
        if (input.command !== "git") return undefined;
        if (input.args[0] === "worktree" && input.args[1] === "list")
          return { code: 0, stdout: "worktree /repo\n" };
        if (input.args[0] === "branch" && input.args[1] === "-D") return { code: 1 };
        if (input.args[0] === "show-ref" && input.args.at(-1) === `refs/heads/${workerBranch}`)
          return { code: 1 };
        return undefined;
      },
    });

    return Effect.gen(function* () {
      const runtime = yield* make;
      yield* runtime.tick();

      const run = f.current()!;
      expect(f.removedWorktrees).toEqual([workerPath]);
      expect(run.status).not.toBe("paused");
      expect(run.tasks[0]).toMatchObject({ status: "settled", branch: null, worktreePath: null });
    }).pipe(Effect.provide(f.layer));
  },
);

it.effect("keeps cleanup metadata and pauses when the worker worktree is still registered", () => {
  const { run: seed, workerPath, workerBranch } = appliedSettlementSeed();
  const f = fixture(seed, true, {
    removeWorktreeFails: true,
    process: (input) => {
      if (input.command === "git" && input.args[0] === "worktree" && input.args[1] === "list")
        return { code: 0, stdout: `worktree /repo\n\nworktree ${workerPath}\n` };
      return undefined;
    },
  });

  return Effect.gen(function* () {
    const runtime = yield* make;
    yield* runtime.tick();

    const run = f.current()!;
    expect(run.status).toBe("paused");
    expect(run.statusReason).toBe("Worker workspace cleanup failed after accepted integration.");
    expect(run.tasks[0]).toMatchObject({
      status: "settled",
      branch: workerBranch,
      worktreePath: workerPath,
    });
    expect(f.processCalls.some((call) => call.command === "git" && call.args[0] === "branch")).toBe(
      false,
    );
  }).pipe(Effect.provide(f.layer));
});

it.effect("keeps cleanup metadata and pauses when the worker branch is still present", () => {
  const { run: seed, workerPath, workerBranch } = appliedSettlementSeed();
  const f = fixture(seed, true, {
    process: (input) => {
      if (input.command !== "git") return undefined;
      if (input.args[0] === "branch" && input.args[1] === "-D") return { code: 1 };
      if (input.args[0] === "show-ref" && input.args.at(-1) === `refs/heads/${workerBranch}`)
        return { code: 0 };
      return undefined;
    },
  });

  return Effect.gen(function* () {
    const runtime = yield* make;
    yield* runtime.tick();

    const run = f.current()!;
    expect(f.removedWorktrees).toEqual([workerPath]);
    expect(run.status).toBe("paused");
    expect(run.statusReason).toBe("Worker branch cleanup failed after accepted integration.");
    expect(run.tasks[0]).toMatchObject({
      status: "settled",
      branch: workerBranch,
      worktreePath: workerPath,
    });
  }).pipe(Effect.provide(f.layer));
});

function conflictSettlementSeed(resolutionStatus: TeamAttempt["status"] = "succeeded"): {
  readonly run: TeamRun;
  readonly settlement: TeamSettlement;
  readonly workerHead: string;
  readonly resolution: TeamAttempt;
} {
  const seed = applyingSettlementSeed();
  const settlement: TeamSettlement = {
    ...seed.settlement,
    status: "conflict",
    updatedAt: now,
  };
  const resolution = attempt({
    id: "settlement-conflict-resolution",
    role: "integrate",
    owner: seed.run.lead,
    taskId: settlement.taskId,
    status: resolutionStatus,
    result: resolutionStatus === "succeeded" ? "Resolved the merge conflict" : null,
  });
  return {
    workerHead: seed.workerHead,
    settlement,
    resolution,
    run: baseRun({
      status: "settling",
      tasks: seed.run.tasks.map((task) => ({
        ...task,
        attemptIds: [...task.attemptIds, resolution.id],
      })),
      attempts: [resolution],
      settlements: [settlement],
    }),
  };
}

it.effect(
  "creates and dispatches a task-specific lead resolution attempt in the same tick when settlement merge conflicts",
  () => {
    const seed = applyingSettlementSeed();
    const ready: TeamSettlement = { ...seed.settlement, status: "ready" };
    const f = fixture(
      baseRun({
        status: "settling",
        tasks: seed.run.tasks,
        settlements: [ready],
      }),
      true,
      {
        process: (input) => {
          if (input.command !== "git") return undefined;
          if (input.args[0] === "rev-list") return { stdout: "1\n" };
          if (input.args[0] === "merge" && input.args[1] === "--no-edit") return { code: 1 };
          return undefined;
        },
      },
    );

    return Effect.gen(function* () {
      const runtime = yield* make;
      yield* runtime.tick();

      const run = f.current()!;
      const resolution = run.attempts.find(
        (candidate) => candidate.role === "integrate" && candidate.taskId === ready.taskId,
      );
      expect(run.status).toBe("settling");
      expect(run.statusReason).toBe(
        "The lead is resolving a conflict while integrating an accepted worker result.",
      );
      expect(run.settlements[0]?.status).toBe("conflict");
      expect(resolution).toMatchObject({
        role: "integrate",
        taskId: ready.taskId,
        status: "running",
      });
      expect(run.tasks[0]?.attemptIds).toContain(resolution?.id);
      expect(
        f.commands.some(
          (command) =>
            command.type === "thread.turn.start" &&
            command.threadId === leadThreadId &&
            command.message.messageId === resolution?.requestMessageId,
        ),
      ).toBe(true);
    }).pipe(Effect.provide(f.layer));
  },
);

it.effect(
  "finalizes a conflict settlement only after the accepted worker head is an ancestor and cleans the worker workspace",
  () => {
    const { run: seed, settlement, workerHead } = conflictSettlementSeed();
    const integratedHead = "e".repeat(40);
    const workerPath = seed.tasks[0]!.worktreePath!;
    const workerBranch = seed.tasks[0]!.branch!;
    const f = fixture(seed, true, {
      process: (input) => {
        if (input.command !== "git") return undefined;
        if (
          input.args[0] === "merge-base" &&
          input.args[1] === "--is-ancestor" &&
          input.args[2] === workerHead
        )
          return { code: 0 };
        if (input.args[0] === "rev-parse" && input.args[1] === "HEAD")
          return { stdout: `${integratedHead}\n` };
        if (input.args[0] === "rev-list") return { stdout: "1\n" };
        return undefined;
      },
    });

    return Effect.gen(function* () {
      const runtime = yield* make;
      yield* runtime.tick();

      const run = f.current()!;
      expect(run.tasks[0]?.status).toBe("settled");
      expect(run.settlements.find((candidate) => candidate.id === settlement.id)).toMatchObject({
        status: "applied",
        appliedCommit: integratedHead,
      });
      expect(run.workspace?.integrationHead).toBe(integratedHead);
      expect(f.removedWorktrees).toEqual([workerPath]);
      expect(
        f.processCalls.some(
          (call) =>
            call.command === "git" &&
            call.cwd === seed.workspace?.root &&
            call.args[0] === "branch" &&
            call.args[1] === "-D" &&
            call.args[2] === workerBranch,
        ),
      ).toBe(true);
    }).pipe(Effect.provide(f.layer));
  },
);

it.effect(
  "pauses when a successful lead conflict-resolution attempt did not integrate the accepted worker head",
  () => {
    const { run: seed, workerHead } = conflictSettlementSeed();
    const f = fixture(seed, true, {
      process: (input) => {
        if (
          input.command === "git" &&
          input.args[0] === "merge-base" &&
          input.args[1] === "--is-ancestor" &&
          input.args[2] === workerHead
        )
          return { code: 1 };
        return undefined;
      },
    });

    return Effect.gen(function* () {
      const runtime = yield* make;
      yield* runtime.tick();

      const run = f.current()!;
      expect(run.status).toBe("paused");
      expect(run.statusReason).toBe(
        "Lead conflict resolution finished without integrating the accepted worker commit.",
      );
      expect(run.tasks[0]?.status).toBe("settling");
      expect(run.settlements[0]?.status).toBe("conflict");
      expect(f.removedWorktrees).toEqual([]);
    }).pipe(Effect.provide(f.layer));
  },
);

it.effect(
  "keeps task-specific integrate failover in settling and carries durable task state to the replacement provider",
  () => {
    const { run: seed, settlement, resolution } = conflictSettlementSeed("reserved");
    const autoPolicy: TeamSettings["policy"] = { ...policy, providerLimitBehavior: "auto" };
    const f = fixture(
      {
        ...seed,
        policy: autoPolicy,
      },
      false,
    );

    return Effect.gen(function* () {
      const runtime = yield* make;
      yield* runtime.tick();

      const run = f.current()!;
      const replacement = run.attempts.find(
        (candidate) => candidate.id !== resolution.id && candidate.role === "integrate",
      );
      expect(run.status).toBe("settling");
      expect(run.settlements.find((candidate) => candidate.id === settlement.id)?.status).toBe(
        "conflict",
      );
      expect(replacement).toMatchObject({
        role: "integrate",
        taskId: settlement.taskId,
        status: "running",
        owner: { profileId: failoverProfile.id },
      });
      expect(replacement?.prompt).toContain("Durable handoff state:");
      expect(replacement?.prompt).toContain(`"taskId":"${settlement.taskId}"`);
      expect(replacement?.prompt).toContain(`"settlementId":"${settlement.id}"`);
      expect(run.failovers[0]).toMatchObject({
        attemptId: resolution.id,
        status: "applied",
        decision: { action: "switch", profileId: failoverProfile.id },
      });
    }).pipe(Effect.provide(f.layer));
  },
);

it.effect(
  "does not count task-specific integrate attempts against final integration retries",
  () => {
    const taskId = "settled-task";
    const taskScopedIntegration = attempt({
      id: "task-conflict-integrate",
      role: "integrate",
      owner: baseRun().lead,
      taskId,
      status: "succeeded",
      result: "Resolved task conflict",
    });
    const finalIntegration = attempt({
      id: "final-integrate-correction",
      role: "integrate",
      owner: baseRun().lead,
      status: "succeeded",
      result: JSON.stringify({ action: "correct", summary: "One final correction", checks: [] }),
    });
    const task: TeamTask = {
      id: taskId,
      objective: "Settled task",
      acceptance: ["Task is settled"],
      dependencies: [],
      owner: {
        role: "worker",
        profileId: leadProfile.id,
        threadId: ThreadId.make("team-runtime-settled-worker"),
        taskId,
      },
      branch: null,
      worktreePath: null,
      status: "settled",
      attemptIds: [taskScopedIntegration.id],
      settlementId: "settled-settlement",
      result: "Settled",
    };
    const f = fixture(
      baseRun({
        status: "review",
        acceptance: ["Run is complete"],
        tasks: [task],
        attempts: [taskScopedIntegration, finalIntegration],
      }),
    );

    return Effect.gen(function* () {
      const runtime = yield* make;
      yield* runtime.tick();

      const run = f.current()!;
      const finalAttempts = run.attempts.filter(
        (candidate) => candidate.role === "integrate" && candidate.taskId === null,
      );
      expect(run.status).toBe("review");
      expect(finalAttempts).toHaveLength(2);
      expect(finalAttempts[1]).toMatchObject({ status: "running", taskId: null });
      expect(run.statusReason).toBeNull();
    }).pipe(Effect.provide(f.layer));
  },
);

it.effect(
  "persists materialized attempt attachments before dispatch and releases the run lease on cancel",
  () => {
    const f = fixture();
    return Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      const attachment: ChatAttachment = {
        type: "image",
        id: "pending-00000000-0000-4000-8000-0000000000ef" as never,
        name: "runtime-attachment.png",
        mimeType: "image/png",
        sizeBytes: 7,
      };
      const pendingPath = NodePath.join(config.attachmentsDir, `${attachment.id}.png`);
      NodeFS.writeFileSync(pendingPath, Buffer.from("content"));

      const runtime = yield* make;
      const run = yield* runtime.start({
        commandId: "start-with-attachment",
        projectId,
        runtimeMode: "approval-required",
        prompt: "Use the attached diagram",
        attachments: [attachment],
      });
      const plan = run.attempts[0]!;
      const dispatch = f.turnDispatches[0]!;

      expect(plan.status).toBe("running");
      expect(plan.attachments).toHaveLength(1);
      expect(plan.attachments[0]?.id).not.toBe(attachment.id);
      expect(dispatch.persistedAttachments).toEqual(plan.attachments);
      expect(dispatch.dispatchedAttachments).toEqual(plan.attachments);
      expect(
        pendingAttachmentLeaseHasOwner({
          attachmentsDir: config.attachmentsDir,
          attachmentId: attachment.id,
          ownerId: run.id,
        }),
      ).toBe(true);

      const cancelled = yield* runtime.control({
        id: run.id,
        revision: run.revision,
        action: "cancel",
      });
      expect(cancelled.status).toBe("cancelled");
      expect(
        pendingAttachmentLeaseHasOwner({
          attachmentsDir: config.attachmentsDir,
          attachmentId: attachment.id,
          ownerId: run.id,
        }),
      ).toBe(false);
      expect(NodeFS.existsSync(pendingPath)).toBe(false);
    }).pipe(Effect.provide(f.layer));
  },
);

it.effect(
  "uses stable approval request ids when cancellation resumes after partial cleanup",
  () => {
    const running = attempt({
      id: "pending-approval",
      role: "plan",
      owner: baseRun().lead,
      status: "running",
    });
    const firstRequestId = "approval-request-a";
    const secondRequestId = "approval-request-b";
    const firstPass = fixture(baseRun({ attempts: [running] }), true, {
      existingThreads: [leadThreadId],
      threadActivities: [
        {
          id: "approval-event-a" as never,
          tone: "approval",
          kind: "approval.requested",
          summary: "First command approval",
          payload: { requestId: firstRequestId },
          turnId: null,
          createdAt: now,
        },
        {
          id: "approval-event-b" as never,
          tone: "approval",
          kind: "approval.requested",
          summary: "Second command approval",
          payload: { requestId: secondRequestId },
          turnId: null,
          createdAt: now,
        },
      ],
    });
    const retry = fixture(baseRun({ attempts: [running] }), true, {
      existingThreads: [leadThreadId],
      threadActivities: [
        {
          id: "approval-event-a" as never,
          tone: "approval",
          kind: "approval.requested",
          summary: "First command approval",
          payload: { requestId: firstRequestId },
          turnId: null,
          createdAt: now,
        },
        {
          id: "approval-event-b" as never,
          tone: "approval",
          kind: "approval.requested",
          summary: "Second command approval",
          payload: { requestId: secondRequestId },
          turnId: null,
          createdAt: now,
        },
        {
          id: "approval-resolved-a" as never,
          tone: "info",
          kind: "approval.resolved",
          summary: "First approval resolved",
          payload: { requestId: firstRequestId },
          turnId: null,
          createdAt: now,
        },
      ],
    });

    return Effect.gen(function* () {
      const firstCancelled = yield* Effect.provide(
        make.pipe(
          Effect.flatMap((runtime) =>
            runtime.control({ id: "runtime-run", revision: 0, action: "cancel" }),
          ),
        ),
        firstPass.layer,
      );
      const retryCancelled = yield* Effect.provide(
        make.pipe(
          Effect.flatMap((runtime) =>
            runtime.control({ id: "runtime-run", revision: 0, action: "cancel" }),
          ),
        ),
        retry.layer,
      );

      expect(firstCancelled.status).toBe("cancelled");
      expect(retryCancelled.status).toBe("cancelled");
      expect(firstPass.commands.map((command) => command.type)).toEqual([
        "thread.approval.respond",
        "thread.approval.respond",
        "thread.turn.interrupt",
      ]);
      const firstApprovalCommands = firstPass.commands.filter(
        (command) => command.type === "thread.approval.respond",
      );
      expect(firstApprovalCommands.map((command) => command.commandId)).toEqual([
        `team-cancel-approval-${running.id}-${firstRequestId}`,
        `team-cancel-approval-${running.id}-${secondRequestId}`,
      ]);
      expect(retry.commands.map((command) => command.type)).toEqual([
        "thread.approval.respond",
        "thread.turn.interrupt",
      ]);
      const retryApproval = retry.commands.find(
        (command) => command.type === "thread.approval.respond",
      );
      expect(retryApproval).toMatchObject({
        type: "thread.approval.respond",
        commandId: `team-cancel-approval-${running.id}-${secondRequestId}`,
        threadId: leadThreadId,
        requestId: secondRequestId,
        decision: "cancel",
      });
      expect(retryApproval?.commandId).toBe(firstApprovalCommands[1]?.commandId);
      expect(retryApproval?.commandId).not.toBe(firstApprovalCommands[0]?.commandId);
    });
  },
);

it.effect(
  "restart-reconciles an applying settlement already contained in lead HEAD without re-merging",
  () => {
    const { run: seed, settlement, workerHead } = applyingSettlementSeed();
    const integratedHead = "c".repeat(40);
    const f = fixture(seed, true, {
      process: (input) => {
        if (input.command !== "git") return undefined;
        if (input.args[0] === "rev-list") return { stdout: "1\n" };
        if (
          input.args[0] === "merge-base" &&
          input.args[1] === "--is-ancestor" &&
          input.args[2] === workerHead
        )
          return { code: 0 };
        if (input.args[0] === "rev-parse" && input.args[1] === "HEAD")
          return { stdout: `${integratedHead}\n` };
        return undefined;
      },
    });

    return Effect.gen(function* () {
      const runtime = yield* make;
      yield* runtime.tick();

      const reconciled = f.current()!;
      expect(
        reconciled.settlements.find((candidate) => candidate.id === settlement.id),
      ).toMatchObject({ status: "applied", appliedCommit: integratedHead });
      expect(reconciled.tasks[0]?.status).toBe("settled");
      expect(reconciled.workspace?.integrationHead).toBe(integratedHead);
      expect(
        f.processCalls.some(
          (call) =>
            call.command === "git" && call.args[0] === "merge" && call.args[1] === "--no-edit",
        ),
      ).toBe(false);
    }).pipe(Effect.provide(f.layer));
  },
);

it.effect(
  "restart-retries an applying settlement safely when the worker head is not yet in lead HEAD",
  () => {
    const { run: seed, settlement, workerHead } = applyingSettlementSeed();
    const integratedHead = "d".repeat(40);
    const f = fixture(seed, true, {
      process: (input) => {
        if (input.command !== "git") return undefined;
        if (input.args[0] === "rev-list") return { stdout: "1\n" };
        if (
          input.args[0] === "merge-base" &&
          input.args[1] === "--is-ancestor" &&
          input.args[2] === workerHead
        )
          return { code: 1 };
        if (input.args[0] === "merge" && input.args[1] === "--abort") return { code: 0 };
        if (input.args[0] === "merge" && input.args[1] === "--no-edit") return { code: 0 };
        if (input.args[0] === "rev-parse" && input.args[1] === "HEAD")
          return { stdout: `${integratedHead}\n` };
        return undefined;
      },
    });

    return Effect.gen(function* () {
      const runtime = yield* make;
      yield* runtime.tick();

      const reconciled = f.current()!;
      expect(
        reconciled.settlements.find((candidate) => candidate.id === settlement.id),
      ).toMatchObject({ status: "applied", appliedCommit: integratedHead });
      const mergeCalls = f.processCalls.filter(
        (call) => call.command === "git" && call.args[0] === "merge",
      );
      expect(mergeCalls.map((call) => call.args.slice(0, 3))).toEqual([
        ["merge", "--abort"],
        ["merge", "--no-edit", workerHead],
      ]);
    }).pipe(Effect.provide(f.layer));
  },
);

function retryTask(): TeamTask {
  return {
    id: "retry-task",
    objective: "Implement the retry slice",
    context: "Preserve the existing transport envelope and edit only the assigned module.",
    acceptance: ["Retry slice is verified"],
    dependencies: [],
    owner: {
      role: "worker",
      profileId: leadProfile.id,
      threadId: ThreadId.make("team-retry-worker"),
      taskId: "retry-task",
    },
    branch: "orchestration/runtime-run/task/retry-task",
    worktreePath: "/repo/.dispatch-worktrees/retry-task",
    status: "running",
    attemptIds: [],
    settlementId: null,
    result: null,
  };
}

const successfulWorkerResult = JSON.stringify({
  summary: "Worker finished",
  commit: head,
  changedFiles: ["src/runtime.ts"],
  checks: [],
  limitations: [],
});

it.effect(
  "keeps a replacement worker running across ticks and restart, then reviews its result",
  () => {
    const task = retryTask();
    const failed: TeamAttempt = {
      ...attempt({
        id: "failed-work",
        role: "work",
        owner: task.owner,
        taskId: task.id,
        status: "failed",
      }),
      failure: { kind: "provider-error", message: "Temporary provider interruption" },
    };
    const f = fixture(
      baseRun({ tasks: [{ ...task, attemptIds: [failed.id] }], attempts: [failed] }),
    );
    return Effect.gen(function* () {
      const runtime = yield* make;
      yield* runtime.tick();
      const retry = f.current()!.attempts.at(-1)!;
      expect(retry.status).toBe("running");
      expect(retry.prompt).toContain(task.context);
      yield* runtime.tick();
      const restarted = yield* make;
      yield* restarted.tick();
      expect(f.current()!.status).toBe("running");
      expect(f.current()!.attempts).toHaveLength(2);
      expect(f.commands.filter((command) => command.type === "thread.turn.start")).toHaveLength(1);

      const store = yield* OrchestrationStore;
      yield* store.update(
        f.current()!.id,
        f.current()!.revision,
        (run) => ({
          ...run,
          attempts: run.attempts.map((candidate) =>
            candidate.id === retry.id
              ? { ...candidate, status: "succeeded", result: successfulWorkerResult }
              : candidate,
          ),
        }),
        "test-worker-completed",
      );
      yield* restarted.tick();
      expect(f.current()!.attempts.at(-1)).toMatchObject({ role: "review", status: "running" });
      expect(f.current()!.attempts[0]).toEqual(failed);
    }).pipe(Effect.provide(f.layer));
  },
);

for (const retryStatus of ["reserved", "running", "failed"] as const) {
  it.effect(
    `restart handles the latest ${retryStatus} worker attempt without replaying an older failure`,
    () => {
      const task = retryTask();
      const failed = attempt({
        id: "old-failure",
        role: "work",
        owner: task.owner,
        taskId: task.id,
        status: "failed",
      });
      const retry: TeamAttempt = {
        ...attempt({
          id: "replacement",
          role: "work",
          owner: task.owner,
          taskId: task.id,
          status: retryStatus,
          sequence: 1,
        }),
        failure:
          retryStatus === "failed"
            ? { kind: "provider-error", message: "Replacement failed" }
            : null,
      };
      const f = fixture(
        baseRun({
          tasks: [{ ...task, attemptIds: [failed.id, retry.id] }],
          attempts: [failed, retry],
        }),
      );
      return Effect.gen(function* () {
        const runtime = yield* make;
        yield* runtime.tick();
        yield* runtime.tick();
        expect(f.current()!.attempts).toHaveLength(2);
        expect(f.current()!.status).toBe(retryStatus === "failed" ? "paused" : "running");
        if (retryStatus === "failed") expect(f.current()!.statusReason).toBe("Replacement failed");
      }).pipe(Effect.provide(f.layer));
    },
  );
}

it.effect("does not review an older successful result while its correction is running", () => {
  const task = retryTask();
  const original = attempt({
    id: "old-success",
    role: "work",
    owner: task.owner,
    taskId: task.id,
    status: "succeeded",
    result: successfulWorkerResult,
  });
  const correction = attempt({
    id: "active-correction",
    role: "work",
    owner: task.owner,
    taskId: task.id,
    status: "running",
    sequence: 1,
  });
  const f = fixture(baseRun({ tasks: [task], attempts: [original, correction] }));
  return Effect.gen(function* () {
    const runtime = yield* make;
    yield* runtime.tick();
    expect(f.current()!.attempts).toHaveLength(2);
    expect(f.current()!.tasks[0]!.status).toBe("running");
    expect(f.commands).toEqual([]);
  }).pipe(Effect.provide(f.layer));
});

for (const action of ["switch", "retry", "pause"] as const) {
  it.effect(
    `provider decision ${action} schedules immediately without another external event`,
    () => {
      const failed: TeamAttempt = {
        ...attempt({ id: "limited-plan", role: "plan", owner: baseRun().lead, status: "failed" }),
        failure: { kind: "provider-limit", message: "Quota exhausted" },
      };
      const f = fixture(baseRun({ status: "planning", acceptance: [], attempts: [failed] }));
      return Effect.gen(function* () {
        const runtime = yield* make;
        yield* runtime.tick();
        const pending = f.current()!;
        expect(pending.status).toBe("awaiting-provider-decision");
        const run = yield* runtime.providerDecision({
          id: pending.id,
          revision: pending.revision,
          failoverId: pending.failovers[0]!.id,
          action,
          profileId: action === "switch" ? failoverProfile.id : null,
        });
        expect(run.status).toBe(action === "pause" ? "paused" : "planning");
        expect(f.commands.filter((command) => command.type === "thread.turn.start")).toHaveLength(
          action === "pause" ? 0 : 1,
        );
        if (action !== "pause")
          expect(run.attempts.at(-1)).toMatchObject({
            status: "running",
            owner: { profileId: action === "switch" ? failoverProfile.id : leadProfile.id },
          });
        const repeated = yield* runtime
          .providerDecision({
            id: pending.id,
            revision: pending.revision,
            failoverId: pending.failovers[0]!.id,
            action,
            profileId: null,
          })
          .pipe(Effect.flip);
        expect(repeated.code).toBe("conflict");
      }).pipe(Effect.provide(f.layer));
    },
  );
}

it.effect(
  "resumes the installed plan after a recovered planner without replacing settled or active tasks",
  () => {
    const task = retryTask();
    const settledSeed = appliedSettlementSeed();
    const settled = { ...settledSeed.run.tasks[0]!, worktreePath: null, branch: null };
    const failed = attempt({
      id: "old-plan-failure",
      role: "plan",
      owner: baseRun().lead,
      status: "failed",
    });
    const plan = attempt({
      id: "recovered-plan",
      role: "plan",
      owner: baseRun().lead,
      status: "succeeded",
      sequence: 1,
      result: JSON.stringify({
        acceptance: ["Stable contract"],
        tasks: [],
        rationale: "No new tasks",
      }),
    });
    const active = attempt({
      id: "active-worker",
      role: "work",
      owner: task.owner,
      taskId: task.id,
      status: "running",
    });
    const seed = baseRun({
      status: "paused",
      tasks: [settled, task],
      settlements: [settledSeed.settlement],
      attempts: [failed, plan, active],
    });
    const f = fixture(seed);
    return Effect.gen(function* () {
      const runtime = yield* make;
      const resumed = yield* runtime.control({
        id: seed.id,
        revision: seed.revision,
        action: "resume",
      });
      expect(resumed.status).toBe("running");
      yield* runtime.tick();
      expect(f.current()!.tasks).toEqual(seed.tasks);
      expect(f.current()!.settlements).toEqual(seed.settlements);
      expect(f.current()!.attempts).toEqual(seed.attempts);
      expect(f.current()!.acceptance).toEqual(seed.acceptance);
    }).pipe(Effect.provide(f.layer));
  },
);

it.effect(
  "resumes a completed but uninstalled plan and persists its context through SQLite to the worker",
  () => {
    const task = retryTask();
    const plan = attempt({
      id: "plan-context",
      role: "plan",
      owner: baseRun().lead,
      status: "succeeded",
      result: JSON.stringify({
        acceptance: ["Stable contract"],
        tasks: [
          {
            id: task.id,
            objective: task.objective,
            context: task.context,
            acceptance: task.acceptance,
            dependencies: [],
          },
        ],
        rationale: "Delegate the bounded slice",
      }),
    });
    const seed = baseRun({ status: "paused", acceptance: [], attempts: [plan] });
    const f = fixture(seed);
    return Effect.gen(function* () {
      yield* migrateOrchestrationV2;
      const store = yield* makeStore;
      yield* store.create(seed);
      const runtime = yield* make.pipe(Effect.provideService(OrchestrationStore, store));
      const resumed = yield* runtime.control({
        id: seed.id,
        revision: seed.revision,
        action: "resume",
      });
      expect(resumed.status).toBe("planning");
      yield* runtime.tick();
      const reopened = yield* makeStore;
      const run = yield* reopened.get(seed.id);
      expect(run.tasks[0]!.context).toBe(task.context);
      const work = run.attempts.find((candidate) => candidate.role === "work")!;
      expect(work.status).toBe("running");
      expect(work.prompt).toContain(task.context);
      const dispatched = f.commands.find(
        (command) =>
          command.type === "thread.turn.start" && command.threadId === work.owner.threadId,
      );
      expect(dispatched?.type === "thread.turn.start" && dispatched.message.text).toContain(
        task.context,
      );
    }).pipe(Effect.provide(Layer.merge(f.layer, NodeSqliteClient.layer({ filename: ":memory:" }))));
  },
);

it.effect("resumes a direct run with installed acceptance in integration", () => {
  const seed = baseRun({ status: "paused", executionMode: "direct" });
  const f = fixture(seed);
  return Effect.gen(function* () {
    const runtime = yield* make;
    expect((yield* runtime.control({ id: seed.id, revision: 0, action: "resume" })).status).toBe(
      "review",
    );
    yield* runtime.tick();
    expect(f.current()!.attempts.at(-1)).toMatchObject({ role: "integrate", status: "running" });
  }).pipe(Effect.provide(f.layer));
});

for (const exitCode of [0, 1]) {
  it.effect(
    `persists noisy integration verification with exit code ${exitCode} using the real process runner and SQLite`,
    () => {
      const check = {
        criterionIndex: 0,
        command: process.execPath,
        args: ["-e", `process.stdout.write('x'.repeat(40000)); process.exitCode = ${exitCode}`],
      };
      const review = attempt({
        id: "noisy-integration",
        role: "integrate",
        owner: baseRun().lead,
        status: "succeeded",
        result: JSON.stringify({
          action: "accept",
          summary: "Combined verification",
          checks: [check],
        }),
      });
      const seed = baseRun({ status: "review", attempts: [review] });
      const f = fixture(seed);
      return Effect.gen(function* () {
        yield* migrateOrchestrationV2;
        const store = yield* makeStore;
        yield* store.create(seed);
        const realProcesses = yield* makeProcessRunner().pipe(Effect.provide(NodeServices.layer));
        const fakeProcesses = yield* ProcessRunner;
        const runtime = yield* make.pipe(
          Effect.provideService(OrchestrationStore, store),
          Effect.provideService(
            ProcessRunner,
            ProcessRunner.of({
              run: (input) =>
                input.command === process.execPath
                  ? realProcesses.run({ ...input, cwd: process.cwd() })
                  : fakeProcesses.run(input),
            }),
          ),
        );
        yield* runtime.tick();
        const run = yield* store.get(seed.id);
        expect(run.status).toBe(exitCode === 0 ? "completed" : "review");
        if (exitCode === 0) {
          const decision = run.decisions.at(-1)!;
          expect(decision.length).toBeLessThanOrEqual(8_000);
          expect(decodeVerificationDecision(decision)).toMatchObject({
            truncated: true,
            evidence: [{ criterionIndex: 0, passed: true }],
          });
        } else {
          expect(run.attempts.at(-1)).toMatchObject({ role: "integrate", status: "running" });
          expect(run.attempts.at(-1)!.prompt).toContain('"passed":false');
        }
      }).pipe(
        Effect.provide(Layer.merge(f.layer, NodeSqliteClient.layer({ filename: ":memory:" }))),
      );
    },
  );
}

for (const exitCode of [0, 1]) {
  it.effect(
    `persists aggregate worker verification with exit code ${exitCode} before settlement or correction`,
    () => {
      const task = retryTask();
      const work = attempt({
        id: "noisy-work",
        role: "work",
        owner: task.owner,
        taskId: task.id,
        status: "succeeded",
        result: successfulWorkerResult,
      });
      const checks = Array.from({ length: 20 }, () => ({
        criterionIndex: 0,
        command: "node",
        args: ["check.js"],
      }));
      const review = attempt({
        id: "noisy-review",
        role: "review",
        owner: baseRun().lead,
        taskId: task.id,
        status: "succeeded",
        result: JSON.stringify({ action: "accept", summary: "Worker verification", checks }),
      });
      const seed = baseRun({
        tasks: [{ ...task, status: "review", attemptIds: [work.id, review.id] }],
        attempts: [work, review],
      });
      const f = fixture(seed, true, {
        process: (input) =>
          input.command === "node"
            ? { stdout: "x".repeat(9_000), code: exitCode }
            : input.args[0] === "rev-list"
              ? { stdout: "1" }
              : input.args[0] === "merge-base"
                ? { stdout: head }
                : undefined,
      });
      return Effect.gen(function* () {
        yield* migrateOrchestrationV2;
        const store = yield* makeStore;
        yield* store.create(seed);
        const runtime = yield* make.pipe(Effect.provideService(OrchestrationStore, store));
        yield* runtime.tick();
        const run = yield* store.get(seed.id);
        expect(run.status).toBe(exitCode === 0 ? "review" : "running");
        expect(run.settlements).toHaveLength(exitCode === 0 ? 1 : 0);
        const decision = run.decisions.at(-1)!;
        expect(decision.length).toBeLessThanOrEqual(8_000);
        const parsed = decodeVerificationDecision(decision);
        expect(parsed.evidence).toHaveLength(20);
        expect(parsed.evidence.every((entry) => entry.passed === (exitCode === 0))).toBe(true);
        if (exitCode !== 0)
          expect(run.attempts.at(-1)).toMatchObject({ role: "work", status: "running" });
      }).pipe(
        Effect.provide(Layer.merge(f.layer, NodeSqliteClient.layer({ filename: ":memory:" }))),
      );
    },
  );
}

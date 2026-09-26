import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { CommandId, MessageId, ProjectId, ProviderInstanceId, ThreadId } from "@dispatch/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { GitWorkflowService } from "../git/GitWorkflowService.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { ProjectionTurnRepository } from "../persistence/Services/ProjectionTurns.ts";
import { ProviderRegistry } from "../provider/Services/ProviderRegistry.ts";
import { ProviderService } from "../provider/Services/ProviderService.ts";
import { layerTest as serverSettingsLayerTest } from "../serverSettings.ts";
import { FlowStore, make as makeStore } from "./FlowStore.ts";
import { make as makeRuntime } from "./FlowRuntime.ts";

const parentThreadId = ThreadId.make("flow-lead");
const projectId = ProjectId.make("flow-project");
const selection = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-test" };
const crossProviderSelection = {
  instanceId: ProviderInstanceId.make("opencode"),
  model: "deepseek-v4.1-flash",
  options: [{ id: "reasoningEffort", value: "low" }],
};
const assistantMessageId = MessageId.make("flow-answer");
const createdAt = "2026-09-25T00:00:00.000Z";

it.effect(
  "starts shared workers at an umbrella root and isolated workers in chosen child repos",
  () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const workspaceRoot = yield* fileSystem.realPath(yield* fileSystem.makeTempDirectoryScoped());
      const childRepo = path.join(workspaceRoot, "api");
      yield* fileSystem.makeDirectory(childRepo);
      yield* fileSystem.makeDirectory(path.join(childRepo, ".git"));
      yield* fileSystem.makeDirectory(path.join(workspaceRoot, "not-a-repo"));
      const outside = yield* fileSystem.realPath(yield* fileSystem.makeTempDirectoryScoped());
      yield* fileSystem.symlink(outside, path.join(workspaceRoot, "escape"));
      const sql = yield* SqlClient.SqlClient;
      yield* sql`
      INSERT INTO projection_threads
        (thread_id, project_id, title, model_selection_json, runtime_mode, interaction_mode, created_at, updated_at, flow_enabled)
      VALUES (${parentThreadId}, ${projectId}, 'Lead', '{}', 'full-access', 'default', ${createdAt}, ${createdAt}, 1)
    `;
      const store = yield* makeStore;
      const commands: Array<{ type: string; [key: string]: unknown }> = [];
      const gitCwds: string[] = [];
      const worktreeInputs: Array<{ cwd: string; refName: string; path: string | null }> = [];
      const runtime = yield* makeRuntime.pipe(
        Effect.provideService(FlowStore, store),
        Effect.provideService(ProjectionSnapshotQuery, {
          getThreadShellById: () =>
            Effect.succeed(
              Option.some({
                id: parentThreadId,
                projectId,
                flowEnabled: true,
                managedTeamWorker: false,
                runtimeMode: "full-access",
                worktreePath: null,
                latestTurn: null,
                session: null,
              }),
            ),
          getProjectShellById: () => Effect.succeed(Option.some({ workspaceRoot })),
          getThreadDetailById: () => Effect.succeed(Option.none()),
        } as never),
        Effect.provideService(ProjectionTurnRepository, {
          listByThreadId: () => Effect.succeed([]),
        } as never),
        Effect.provideService(ProviderRegistry, {
          getProviders: Effect.succeed([
            {
              instanceId: selection.instanceId,
              enabled: true,
              status: "ready",
              auth: { status: "authenticated" },
              availability: "available",
              models: [{ slug: selection.model, isLegacy: false }],
            },
          ]),
        } as never),
        Effect.provideService(ProviderService, {
          prepareSteerTurnMessageId: () => Effect.succeed({ status: "unsupported" }),
        } as never),
        Effect.provideService(GitWorkflowService, {
          isRepository: (cwd: string) => Effect.succeed(cwd === childRepo),
          hasCommit: ({ cwd }: { cwd: string }) =>
            Effect.sync(() => {
              gitCwds.push(cwd);
              return cwd === childRepo;
            }),
          listRefs: () => Effect.succeed({ refs: [] }),
          pruneWorktrees: () => Effect.void,
          createWorktree: (input: { cwd: string; refName: string; path: string | null }) =>
            Effect.sync(() => {
              gitCwds.push(input.cwd);
              worktreeInputs.push(input);
              return {
                worktree: { path: path.join(workspaceRoot, "api-worker"), refName: "flow/api" },
              };
            }),
        } as never),
        Effect.provideService(OrchestrationEngineService, {
          dispatch: (command: { type: string }) =>
            Effect.sync(() => {
              commands.push(command);
            }),
        } as never),
      );

      const shared = yield* runtime.spawn(parentThreadId, {
        id: CommandId.make("umbrella-shared"),
        assignment: "Investigate API and dashboard together",
        modelSelection: selection,
      });
      expect(shared.repositoryPath).toBeNull();
      expect(shared.branch).toBeNull();
      yield* runtime.tick();
      expect(commands[0]).toMatchObject({
        type: "thread.create",
        threadId: shared.threadId,
        branch: null,
        worktreePath: null,
      });
      expect(gitCwds).toEqual([]);

      const child = yield* runtime.spawn(parentThreadId, {
        id: CommandId.make("umbrella-child"),
        assignment: "Implement the API change",
        modelSelection: selection,
        repositoryPath: "api",
      });
      expect(child.repositoryPath).toBe("api");
      expect(
        (yield* runtime.spawn(parentThreadId, {
          id: CommandId.make("umbrella-child"),
          assignment: "Implement the API change",
          modelSelection: selection,
          repositoryPath: "api",
        })).threadId,
      ).toBe(child.threadId);
      expect(
        (yield* runtime
          .spawn(parentThreadId, {
            id: CommandId.make("umbrella-child"),
            assignment: "Implement the API change",
            modelSelection: selection,
          })
          .pipe(Effect.flip)).code,
      ).toBe("conflict");
      yield* runtime.tick();
      expect(gitCwds).toEqual([childRepo, childRepo, childRepo]);
      expect(
        commands.find(
          (command) => command.type === "thread.create" && command.threadId === child.threadId,
        ),
      ).toMatchObject({
        branch: child.branch,
        worktreePath: path.join(workspaceRoot, "api-worker"),
      });
      expect((yield* store.getWorker(child.threadId))?.repositoryPath).toBe("api");
      yield* store.updateJob({
        id: "flow-job-umbrella-child",
        state: "completed",
        workerState: "idle",
        result: "Done",
        updatedAt: createdAt,
      });
      yield* runtime.send(parentThreadId, {
        id: CommandId.make("umbrella-child-followup"),
        workerThreadId: child.threadId,
        message: "Check one more case",
      });
      yield* runtime.tick();
      expect(worktreeInputs[1]).toMatchObject({
        cwd: childRepo,
        refName: child.branch,
        path: path.join(workspaceRoot, "api-worker"),
      });

      for (const [id, repositoryPath] of [
        ["outside", `../${path.basename(outside)}`],
        ["symlink", "escape"],
        ["non-repo", "not-a-repo"],
      ] as const) {
        expect(
          (yield* runtime
            .spawn(parentThreadId, {
              id: CommandId.make(id),
              assignment: "Invalid repository",
              modelSelection: selection,
              repositoryPath,
            })
            .pipe(Effect.flip)).code,
        ).toBe("invalid");
        expect(yield* store.getWorkerBySpawnId(id)).toBeNull();
      }
    }).pipe(
      Effect.provide(
        Layer.mergeAll(NodeServices.layer, SqlitePersistenceMemory, serverSettingsLayerTest({})),
      ),
    ),
);

it.effect("dispatches an isolated worker turn and persists its completed result", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      INSERT INTO projection_threads
        (thread_id, project_id, title, model_selection_json, runtime_mode, interaction_mode, created_at, updated_at, flow_enabled)
      VALUES (${parentThreadId}, ${projectId}, 'Lead', '{}', 'full-access', 'default', ${createdAt}, ${createdAt}, 1)
    `;
    const store = yield* makeStore;
    const commands: unknown[] = [];
    let messageId = "";
    let workerThreadId = ThreadId.make("pending");
    const runtime = yield* makeRuntime.pipe(
      Effect.provideService(FlowStore, store),
      Effect.provideService(ProjectionSnapshotQuery, {
        getThreadShellById: (threadId: ThreadId) =>
          Effect.succeed(
            Option.some({
              id: threadId,
              projectId,
              flowEnabled: threadId === parentThreadId,
              managedTeamWorker: threadId !== parentThreadId,
              runtimeMode: "full-access",
              worktreePath: null,
              latestTurn: null,
              session: null,
            }),
          ),
        getProjectShellById: () => Effect.succeed(Option.some({ workspaceRoot: "/project" })),
        getThreadDetailById: () =>
          Effect.succeed(
            Option.some({
              activities: [],
              messages: [{ id: assistantMessageId, text: "Implemented and checked." }],
              latestTurn: null,
            }),
          ),
      } as never),
      Effect.provideService(ProjectionTurnRepository, {
        listByThreadId: () =>
          Effect.succeed([
            {
              threadId: workerThreadId,
              turnId: "worker-turn",
              pendingMessageId: messageId,
              assistantMessageId,
              state: "completed",
            },
          ]),
      } as never),
      Effect.provideService(ProviderRegistry, {
        getProviders: Effect.succeed([
          {
            ...selection,
            enabled: true,
            status: "ready",
            auth: { status: "authenticated" },
            availability: "available",
            models: [{ slug: selection.model, isLegacy: false }],
          },
          {
            instanceId: crossProviderSelection.instanceId,
            enabled: true,
            status: "ready",
            auth: { status: "authenticated" },
            availability: "available",
            models: [
              {
                slug: crossProviderSelection.model,
                isLegacy: false,
                capabilities: {
                  optionDescriptors: [
                    {
                      id: "reasoningEffort",
                      label: "Reasoning effort",
                      type: "select",
                      options: [{ id: "low", label: "Low" }],
                    },
                  ],
                },
              },
            ],
          },
        ]),
      } as never),
      Effect.provideService(ProviderService, {
        prepareSteerTurnMessageId: () => Effect.succeed({ status: "unsupported" }),
        steerTurn: () => Effect.succeed({ status: "unsupported" }),
      } as never),
      Effect.provideService(GitWorkflowService, {
        isRepository: () => Effect.succeed(true),
        hasCommit: () => Effect.succeed(true),
        listRefs: () => Effect.succeed({ refs: [] }),
        pruneWorktrees: () => Effect.void,
        createWorktree: () =>
          Effect.succeed({ worktree: { path: "/project-flow-worker", refName: "flow/worker" } }),
      } as never),
      Effect.provideService(OrchestrationEngineService, {
        dispatch: (command: unknown) =>
          Effect.sync(() => {
            commands.push(command);
          }),
      } as never),
    );
    const worker = yield* runtime.spawn(parentThreadId, {
      id: CommandId.make("spawn-parser"),
      assignment: "Implement the parser",
      modelSelection: selection,
    });
    workerThreadId = worker.threadId;
    messageId = "flow-message-spawn-parser";
    yield* runtime.tick();
    expect(commands).toMatchObject([
      { type: "thread.create", threadId: worker.threadId, worktreePath: "/project-flow-worker" },
      { type: "thread.turn.start", threadId: worker.threadId, modelSelection: selection },
    ]);
    expect((yield* store.getWorker(worker.threadId))?.state).toBe("working");
    const progress = yield* runtime.report(worker.threadId, {
      id: CommandId.make("progress-parser"),
      message: "Parser implemented; checking edge cases.",
    });
    expect(progress.sequence).toBeGreaterThan(0);
    expect((yield* runtime.view(parentThreadId))?.updates).toMatchObject([
      { sequence: progress.sequence, workerThreadId: worker.threadId, message: progress.message },
    ]);
    expect(
      (yield* runtime
        .report(parentThreadId, {
          id: CommandId.make("invalid-lead-progress"),
          message: "Spoofed worker update",
        })
        .pipe(Effect.flip)).code,
    ).toBe("not-found");
    yield* runtime.tick();
    const completed = yield* store.getWorker(worker.threadId);
    expect(completed?.state).toBe("idle");
    expect(completed?.latestJob?.result).toBe("Implemented and checked.");
    expect(yield* store.activeJobs).toEqual([]);
    expect((yield* runtime.profiles(parentThreadId))[0]?.modelSelection).toEqual(
      crossProviderSelection,
    );
    const crossProviderWorker = yield* runtime.spawn(parentThreadId, {
      id: CommandId.make("spawn-cheap-review"),
      assignment: "Review parser edge cases",
      profileId: "routine-review",
    });
    expect(crossProviderWorker.modelSelection).toEqual(crossProviderSelection);
    expect(crossProviderWorker.profileId).toBe("routine-review");
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        NodeServices.layer,
        SqlitePersistenceMemory,
        serverSettingsLayerTest({
          flowWorkerProfiles: [
            {
              id: "routine-review",
              name: "Cheap review",
              tier: "routine",
              description: "Bounded review with lead verification",
              modelSelection: crossProviderSelection,
            },
          ],
        }),
      ),
    ),
  ),
);

it.effect("delivers a lead message into an active worker turn and keeps its result pending", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      INSERT INTO projection_threads
        (thread_id, project_id, title, model_selection_json, runtime_mode, interaction_mode, created_at, updated_at, flow_enabled)
      VALUES (${parentThreadId}, ${projectId}, 'Lead', '{}', 'full-access', 'default', ${createdAt}, ${createdAt}, 1)
    `;
    const store = yield* makeStore;
    const commands: Array<{ type: string; [key: string]: unknown }> = [];
    const steers: Array<{ input: string }> = [];
    let workerThreadId = ThreadId.make("pending");
    let active = false;
    let steeringSupported = true;
    let initialState: "running" | "completed" = "running";
    const runtime = yield* makeRuntime.pipe(
      Effect.provideService(FlowStore, store),
      Effect.provideService(ProjectionSnapshotQuery, {
        getThreadShellById: (threadId: ThreadId) =>
          Effect.succeed(
            Option.some({
              id: threadId,
              projectId,
              flowEnabled: threadId === parentThreadId,
              managedTeamWorker: threadId !== parentThreadId,
              runtimeMode: "full-access",
              worktreePath: null,
              latestTurn:
                threadId !== parentThreadId && active
                  ? { turnId: "worker-turn", state: "running" }
                  : null,
              session: null,
            }),
          ),
        getProjectShellById: () => Effect.succeed(Option.some({ workspaceRoot: "/project" })),
        getThreadDetailById: () =>
          Effect.succeed(
            Option.some({
              activities: [],
              messages: [{ id: assistantMessageId, text: "Reviewed implementation." }],
              latestTurn: null,
            }),
          ),
      } as never),
      Effect.provideService(ProjectionTurnRepository, {
        listByThreadId: () =>
          Effect.succeed([
            {
              threadId: workerThreadId,
              turnId: "worker-turn",
              pendingMessageId: "flow-message-spawn-live",
              assistantMessageId,
              state: initialState,
            },
          ]),
      } as never),
      Effect.provideService(ProviderRegistry, {
        getProviders: Effect.succeed([
          {
            ...selection,
            enabled: true,
            status: "ready",
            auth: { status: "authenticated" },
            availability: "available",
            models: [{ slug: selection.model, isLegacy: false }],
          },
        ]),
      } as never),
      Effect.provideService(ProviderService, {
        prepareSteerTurnMessageId: () =>
          Effect.succeed(
            steeringSupported
              ? { status: "ready", messageId: MessageId.make("native-live-id") }
              : { status: "unsupported" },
          ),
        steerTurn: (input: { input: string }) =>
          Effect.sync(() => {
            steers.push(input);
            return {
              status: "accepted",
              turnId: "worker-turn",
              messageId: MessageId.make("native-live-id"),
            };
          }),
      } as never),
      Effect.provideService(GitWorkflowService, {
        isRepository: () => Effect.succeed(true),
        hasCommit: () => Effect.succeed(true),
        listRefs: () => Effect.succeed({ refs: [] }),
        pruneWorktrees: () => Effect.void,
        createWorktree: () =>
          Effect.succeed({ worktree: { path: "/project-flow-worker", refName: "flow/worker" } }),
      } as never),
      Effect.provideService(OrchestrationEngineService, {
        dispatch: (command: { type: string }) =>
          Effect.sync(() => {
            commands.push(command);
          }),
      } as never),
    );
    const worker = yield* runtime.spawn(parentThreadId, {
      id: CommandId.make("spawn-live"),
      assignment: "Implement a parser",
      modelSelection: selection,
    });
    workerThreadId = worker.threadId;
    yield* runtime.tick();
    active = true;
    const message = yield* runtime.send(parentThreadId, {
      id: CommandId.make("lead-live"),
      workerThreadId,
      message: "Check unicode input before finishing.",
    });
    yield* runtime.tick();
    expect(steers).toMatchObject([
      { input: "Message from your Flow lead: Check unicode input before finishing." },
    ]);
    expect(commands.map((command) => command.type)).toEqual([
      "thread.create",
      "thread.turn.start",
      "thread.create",
      "thread.message.user.append",
    ]);
    expect((yield* store.getJob(message.id))?.state).toBe("completed");
    expect((yield* store.getWorker(workerThreadId))?.state).toBe("working");
    expect((yield* store.activeJobs).map((job) => job.id)).toEqual(["flow-job-spawn-live"]);
    active = false;
    initialState = "completed";
    yield* runtime.tick();
    expect((yield* store.getWorker(workerThreadId))?.state).toBe("idle");
    expect((yield* store.getWorker(workerThreadId))?.latestJob?.result).toBe(
      "Reviewed implementation.",
    );
    const queued = yield* runtime.send(parentThreadId, {
      id: CommandId.make("lead-later"),
      workerThreadId,
      message: "Summarize one more edge case.",
    });
    yield* runtime.tick();
    expect((yield* store.getJob(queued.id))?.state).toBe("working");
    expect(commands.at(-1)?.type).toBe("thread.turn.start");
    active = true;
    steeringSupported = false;
    const later = yield* runtime.send(parentThreadId, {
      id: CommandId.make("lead-unsupported"),
      workerThreadId,
      message: "Inspect the error path too.",
    });
    const beforeTick = commands.length;
    yield* runtime.tick();
    expect((yield* store.getJob(later.id))?.state).toBe("queued");
    expect(commands).toHaveLength(beforeTick);
  }).pipe(
    Effect.provide(
      Layer.mergeAll(NodeServices.layer, SqlitePersistenceMemory, serverSettingsLayerTest({})),
    ),
  ),
);

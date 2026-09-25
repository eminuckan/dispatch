import { expect, it } from "@effect/vitest";
import { CommandId, MessageId, ProjectId, ProviderInstanceId, ThreadId } from "@dispatch/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { GitWorkflowService } from "../git/GitWorkflowService.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { ProjectionTurnRepository } from "../persistence/Services/ProjectionTurns.ts";
import { ProviderRegistry } from "../provider/Services/ProviderRegistry.ts";
import { FlowStore, make as makeStore } from "./FlowStore.ts";
import { make as makeRuntime } from "./FlowRuntime.ts";

const parentThreadId = ThreadId.make("flow-lead");
const projectId = ProjectId.make("flow-project");
const selection = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-test" };
const assistantMessageId = MessageId.make("flow-answer");
const createdAt = "2026-09-25T00:00:00.000Z";

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
        ]),
      } as never),
      Effect.provideService(GitWorkflowService, {
        hasCommit: () => Effect.succeed(true),
        listRefs: () => Effect.succeed({ refs: [] }),
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
    yield* runtime.tick();
    const completed = yield* store.getWorker(worker.threadId);
    expect(completed?.state).toBe("idle");
    expect(completed?.latestJob?.result).toBe("Implemented and checked.");
    expect(yield* store.activeJobs).toEqual([]);
  }).pipe(Effect.provide(SqlitePersistenceMemory)),
);

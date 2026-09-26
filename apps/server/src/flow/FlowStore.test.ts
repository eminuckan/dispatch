import { expect, it } from "@effect/vitest";
import { ProviderInstanceId, ThreadId } from "@dispatch/contracts";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { make } from "./FlowStore.ts";

const parentThreadId = ThreadId.make("lead");
const otherThreadId = ThreadId.make("other");
const workerThreadId = ThreadId.make("flow-worker-1");
const selection = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-test" };
const createdAt = "2026-09-25T00:00:00.000Z";

it.effect("reserves Flow workers and jobs durably with parent-scoped idempotency", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      INSERT INTO projection_threads
        (thread_id, project_id, title, model_selection_json, runtime_mode, interaction_mode, created_at, updated_at, flow_enabled)
      VALUES
        ('lead', 'project', 'Lead', '{}', 'full-access', 'default', ${createdAt}, ${createdAt}, 1),
        ('other', 'project', 'Other', '{}', 'full-access', 'default', ${createdAt}, ${createdAt}, 1)
    `;
    const store = yield* make;
    const input = {
      threadId: workerThreadId,
      parentThreadId,
      spawnId: "spawn-1",
      assignment: "Implement the parser",
      modelSelection: selection,
      profileId: "routine-parser",
      branch: "flow/flow-worker-1",
      jobId: "flow-job-spawn-1",
      messageId: "flow-message-spawn-1",
      createdAt,
    };
    const first = yield* store.reserveWorker(input);
    expect(first.state).toBe("queued");
    expect(first.profileId).toBe("routine-parser");
    expect((yield* store.getWorkerBySpawnId(input.spawnId))?.threadId).toBe(workerThreadId);
    expect((yield* store.getJob(input.jobId))?.state).toBe("queued");
    expect(
      (yield* store.reserveWorker({ ...input, threadId: ThreadId.make("ignored-retry") })).threadId,
    ).toBe(workerThreadId);
    expect(
      (yield* store.reserveWorker({ ...input, assignment: "Different work" }).pipe(Effect.flip))
        .code,
    ).toBe("conflict");
    expect(
      (yield* store.reserveWorker({ ...input, parentThreadId: otherThreadId }).pipe(Effect.flip))
        .code,
    ).toBe("conflict");
    expect(
      (yield* store
        .reserveJob({
          parentThreadId: otherThreadId,
          workerThreadId,
          id: "foreign-job",
          messageId: "foreign-message",
          message: "Wrong owner",
          delivery: "turn",
          createdAt,
        })
        .pipe(Effect.flip)).code,
    ).toBe("not-found");

    yield* store.setWorktree(workerThreadId, "/worktrees/worker-1");
    yield* store.updateJob({
      id: input.jobId,
      state: "completed",
      workerState: "idle",
      result: "Done",
      updatedAt: createdAt,
    });
    const persisted = yield* make;
    expect((yield* persisted.getWorker(workerThreadId))?.worktreePath).toBe("/worktrees/worker-1");
    const followup = {
      parentThreadId,
      workerThreadId,
      id: "followup-1",
      messageId: "followup-message-1",
      message: "Check edge cases",
      delivery: "turn" as const,
      createdAt,
    };
    expect((yield* persisted.reserveJob(followup)).state).toBe("queued");
    expect((yield* persisted.reserveJob(followup)).id).toBe(followup.id);
    yield* persisted.updateJob({
      id: followup.id,
      state: "working",
      workerState: "working",
      updatedAt: createdAt,
    });
    const liveMessage = yield* persisted.reserveJob({
      ...followup,
      id: "live-message-1",
      messageId: "live-message-id-1",
      message: "Please also check unicode input",
      delivery: "steer",
    });
    expect(liveMessage.state).toBe("queued");
    expect((yield* persisted.activeJobs).find((job) => job.id === liveMessage.id)?.delivery).toBe(
      "steer",
    );
    const update = yield* persisted.recordUpdate({
      workerThreadId,
      id: "worker-progress-1",
      message: "Checking unicode now",
      createdAt,
    });
    expect(yield* persisted.listUpdates(parentThreadId)).toEqual([update]);
    expect(
      (yield* persisted.recordUpdate({
        workerThreadId,
        id: "worker-progress-1",
        message: "Checking unicode now",
        createdAt,
      })).sequence,
    ).toBe(update.sequence);
    expect(
      (yield* persisted
        .recordUpdate({
          workerThreadId,
          id: "worker-progress-1",
          message: "Different progress",
          createdAt,
        })
        .pipe(Effect.flip)).code,
    ).toBe("conflict");
    yield* persisted.updateJob({
      id: followup.id,
      state: "completed",
      workerState: "idle",
      result: "Checked initial cases",
      updatedAt: createdAt,
    });
    expect((yield* persisted.getWorker(workerThreadId))?.state).toBe("working");
    expect(
      (yield* persisted.reserveJob({ ...followup, message: "Changed" }).pipe(Effect.flip)).code,
    ).toBe("conflict");
    expect((yield* persisted.stop(parentThreadId, workerThreadId)).state).toBe("stopped");
    expect(yield* persisted.activeJobs).toEqual([]);
  }).pipe(Effect.provide(SqlitePersistenceMemory)),
);

it.effect("lets the lead start more than five workers", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      INSERT INTO projection_threads
        (thread_id, project_id, title, model_selection_json, runtime_mode, interaction_mode, created_at, updated_at, flow_enabled)
      VALUES ('lead', 'project', 'Lead', '{}', 'full-access', 'default', ${createdAt}, ${createdAt}, 1)
    `;
    const store = yield* make;
    for (let index = 0; index < 6; index += 1) {
      yield* store.reserveWorker({
        threadId: ThreadId.make(`flow-worker-${index}`),
        parentThreadId,
        spawnId: `spawn-${index}`,
        assignment: `Check part ${index}`,
        modelSelection: selection,
        branch: `flow/worker-${index}`,
        jobId: `flow-job-${index}`,
        messageId: `flow-message-${index}`,
        createdAt,
      });
    }
    expect((yield* store.listWorkers(parentThreadId)).length).toBe(6);
  }).pipe(Effect.provide(SqlitePersistenceMemory)),
);

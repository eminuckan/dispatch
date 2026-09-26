import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { CommandId, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ModelSelection } from "./orchestration.ts";

const FlowText = TrimmedNonEmptyString.check(Schema.isMaxLength(8_000));
export const FlowModelSelection = ModelSelection;

export const FlowWorkerProfile = Schema.Struct({
  id: TrimmedNonEmptyString.check(Schema.isMaxLength(80)),
  name: TrimmedNonEmptyString.check(Schema.isMaxLength(80)),
  tier: Schema.Literals(["deep", "routine"]),
  description: TrimmedNonEmptyString.check(Schema.isMaxLength(300)),
  modelSelection: FlowModelSelection,
});
export type FlowWorkerProfile = typeof FlowWorkerProfile.Type;
export const FlowWorkerProfiles = Schema.Array(FlowWorkerProfile).check(
  Schema.isMaxLength(24),
  Schema.makeFilter(
    (profiles) =>
      new Set(profiles.map((profile) => profile.id)).size === profiles.length ||
      "Worker profile IDs must be unique.",
  ),
);

export class FlowError extends Schema.TaggedError<FlowError>()("FlowError", {
  code: Schema.Literals(["invalid", "conflict", "unavailable", "not-found", "persistence"]),
  message: Schema.String,
}) {}

export const FlowJob = Schema.Struct({
  id: CommandId,
  workerThreadId: ThreadId,
  state: Schema.Literals(["queued", "working", "completed", "failed", "stopped"]),
  prompt: FlowText,
  result: Schema.NullOr(Schema.String),
  error: Schema.NullOr(Schema.String),
  createdAt: Schema.String,
  updatedAt: Schema.String,
});
export type FlowJob = typeof FlowJob.Type;

export const FlowWorker = Schema.Struct({
  threadId: ThreadId,
  spawnId: Schema.optional(CommandId),
  parentThreadId: ThreadId,
  assignment: FlowText,
  modelSelection: FlowModelSelection,
  profileId: Schema.optional(Schema.NullOr(FlowWorkerProfile.fields.id)),
  branch: Schema.NullOr(Schema.String),
  repositoryPath: Schema.NullOr(Schema.String).pipe(
    Schema.withDecodingDefault(Effect.succeed(".")),
  ),
  worktreePath: Schema.NullOr(Schema.String),
  state: Schema.Literals(["queued", "working", "idle", "failed", "stopped"]),
  error: Schema.NullOr(Schema.String),
  latestJob: Schema.NullOr(FlowJob),
  createdAt: Schema.String,
  updatedAt: Schema.String,
});
export type FlowWorker = typeof FlowWorker.Type;

export const FlowUpdate = Schema.Struct({
  sequence: Schema.Int,
  workerThreadId: ThreadId,
  message: FlowText,
  createdAt: Schema.String,
});
export type FlowUpdate = typeof FlowUpdate.Type;

export const FlowThreadView = Schema.Struct({
  parentThreadId: ThreadId,
  enabled: Schema.Boolean,
  currentWorkerThreadId: Schema.NullOr(ThreadId),
  workers: Schema.Array(FlowWorker),
  updates: Schema.Array(FlowUpdate),
});
export type FlowThreadView = typeof FlowThreadView.Type;

export const FlowThreadInput = Schema.Struct({ threadId: ThreadId });
export const FlowStopInput = Schema.Struct({ parentThreadId: ThreadId, workerThreadId: ThreadId });

export const FlowSpawnInput = Schema.Struct({
  id: CommandId,
  assignment: FlowText,
  profileId: Schema.optional(FlowWorkerProfile.fields.id),
  modelSelection: Schema.optional(FlowModelSelection),
  repositoryPath: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(400))),
});
export type FlowSpawnInput = typeof FlowSpawnInput.Type;

export const FlowSendInput = Schema.Struct({
  id: CommandId,
  workerThreadId: ThreadId,
  message: FlowText,
});
export type FlowSendInput = typeof FlowSendInput.Type;

export const FlowReportInput = Schema.Struct({
  id: CommandId,
  message: FlowText,
});
export type FlowReportInput = typeof FlowReportInput.Type;

export const FlowWaitInput = Schema.Struct({
  workerThreadIds: Schema.optional(Schema.Array(ThreadId).check(Schema.isMaxLength(100))),
  timeoutSeconds: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 30 }))),
  afterUpdateSequence: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
});
export type FlowWaitInput = typeof FlowWaitInput.Type;

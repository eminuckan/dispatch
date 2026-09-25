import * as Schema from "effect/Schema";

import { CommandId, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ProviderInstanceId } from "./providerInstance.ts";

const FlowText = TrimmedNonEmptyString.check(Schema.isMaxLength(8_000));
export const FlowModelSelection = Schema.Struct({
  instanceId: ProviderInstanceId,
  model: TrimmedNonEmptyString,
});

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
  parentThreadId: ThreadId,
  assignment: FlowText,
  modelSelection: FlowModelSelection,
  branch: Schema.String,
  worktreePath: Schema.NullOr(Schema.String),
  state: Schema.Literals(["queued", "working", "idle", "failed", "stopped"]),
  error: Schema.NullOr(Schema.String),
  latestJob: Schema.NullOr(FlowJob),
  createdAt: Schema.String,
  updatedAt: Schema.String,
});
export type FlowWorker = typeof FlowWorker.Type;

export const FlowThreadView = Schema.Struct({
  parentThreadId: ThreadId,
  enabled: Schema.Boolean,
  currentWorkerThreadId: Schema.NullOr(ThreadId),
  workers: Schema.Array(FlowWorker),
});
export type FlowThreadView = typeof FlowThreadView.Type;

export const FlowThreadInput = Schema.Struct({ threadId: ThreadId });
export const FlowStopInput = Schema.Struct({ parentThreadId: ThreadId, workerThreadId: ThreadId });

export const FlowSpawnInput = Schema.Struct({
  id: CommandId,
  assignment: FlowText,
  modelSelection: FlowModelSelection,
});
export type FlowSpawnInput = typeof FlowSpawnInput.Type;

export const FlowSendInput = Schema.Struct({
  id: CommandId,
  workerThreadId: ThreadId,
  message: FlowText,
});
export type FlowSendInput = typeof FlowSendInput.Type;

export const FlowWaitInput = Schema.Struct({
  workerThreadIds: Schema.optional(Schema.Array(ThreadId).check(Schema.isMaxLength(5))),
  timeoutSeconds: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 30 }))),
});
export type FlowWaitInput = typeof FlowWaitInput.Type;

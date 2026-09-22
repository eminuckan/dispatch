import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import {
  ChatAttachment,
  ModelSelection,
  PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
  RuntimeMode,
} from "./orchestration.ts";
import { MessageId, ProjectId, ThreadId, TurnId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ProviderInstanceId } from "./providerInstance.ts";

const Id = TrimmedNonEmptyString.check(Schema.isMaxLength(128));
const Count = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
const Timestamp = Schema.String;
const Commit = TrimmedNonEmptyString.check(Schema.isMaxLength(256));
const BoundedText = Schema.String.check(Schema.isMaxLength(64_000));
const ManagedRuntimeMode = RuntimeMode.pipe(
  Schema.withDecodingDefault(Effect.succeed("approval-required" as const)),
);

export const TeamCapability = Schema.Literals(["general", "complex", "frontier"]);
export type TeamCapability = typeof TeamCapability.Type;

export const TeamExecutionMode = Schema.Literals(["direct", "orchestrated"]);
export type TeamExecutionMode = typeof TeamExecutionMode.Type;

export const TeamModelProfile = Schema.Struct({
  id: Id,
  label: TrimmedNonEmptyString.check(Schema.isMaxLength(100)),
  selection: ModelSelection,
  lead: Schema.Boolean,
  worker: Schema.Boolean,
  capability: Schema.optional(TeamCapability),
});
export type TeamModelProfile = typeof TeamModelProfile.Type;

export const TeamProviderLimitBehavior = Schema.Literals(["ask", "auto", "pause"]);
export type TeamProviderLimitBehavior = typeof TeamProviderLimitBehavior.Type;

export const TeamFlowMode = Schema.Literals(["standard", "auto"]);
export type TeamFlowMode = typeof TeamFlowMode.Type;

export const TeamPolicy = Schema.Struct({
  revision: Count,
  enabled: Schema.Boolean,
  flowMode: TeamFlowMode.pipe(Schema.withDecodingDefault(Effect.succeed("standard" as const))),
  profiles: Schema.Array(TeamModelProfile).check(Schema.isMaxLength(40)),
  maxActive: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 5 })),
  maxAttempts: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 3 })),
  providerLimitBehavior: TeamProviderLimitBehavior,
});
export type TeamPolicy = typeof TeamPolicy.Type;

export const TeamSmartRoutingStatus = Schema.Struct({
  available: Schema.Boolean,
  reason: Schema.NullOr(Schema.String.check(Schema.isMaxLength(256))),
});
export type TeamSmartRoutingStatus = typeof TeamSmartRoutingStatus.Type;

export const TeamSettings = Schema.Struct({
  policy: TeamPolicy,
  supportedProviderInstanceIds: Schema.optional(Schema.Array(ProviderInstanceId)),
  // Recomputed from the environment's Connect access; old persisted settings stay readable.
  smartRouting: TeamSmartRoutingStatus.pipe(
    Schema.withDecodingDefault(
      Effect.succeed({ available: false, reason: "smart_routing_session_required" } as const),
    ),
  ),
});
export type TeamSettings = typeof TeamSettings.Type;

export class TeamError extends Schema.TaggedError<TeamError>()("TeamError", {
  code: Schema.Literals(["invalid", "conflict", "unavailable", "not-found", "persistence"]),
  message: Schema.String,
}) {}

export const TeamSettingsUpdate = Schema.Struct({ policy: TeamPolicy });
export type TeamSettingsUpdate = typeof TeamSettingsUpdate.Type;

export const TeamSmartRoutingSessionUpdate = Schema.Struct({
  // Write-only account bearer. Never returned from settings or durable run state.
  accountToken: Schema.NullOr(Schema.String.check(Schema.isMaxLength(4_096))),
  // Origin that issued the bearer. The server binds it to the persisted Connect environment
  // before storing the token so a session can never be forwarded to another Connect origin.
  baseUrl: Schema.NullOr(Schema.String.check(Schema.isMaxLength(2_048))),
});
export type TeamSmartRoutingSessionUpdate = typeof TeamSmartRoutingSessionUpdate.Type;

export const TeamModelRecommendations = Schema.Struct({
  profiles: Schema.Array(TeamModelProfile).check(Schema.isMaxLength(40)),
  notes: Schema.Array(Schema.String),
  source: Schema.Literals(["jev", "catalog"]),
});
export type TeamModelRecommendations = typeof TeamModelRecommendations.Type;

/** Explicit owner snapshot used by tasks, attempts and teammate messages. */
export const TeamOwner = Schema.Struct({
  role: Schema.Literals(["lead", "worker"]),
  profileId: Id,
  threadId: Schema.NullOr(ThreadId),
  taskId: Schema.NullOr(Id),
});
export type TeamOwner = typeof TeamOwner.Type;

export const TeamTask = Schema.Struct({
  id: Id,
  objective: TrimmedNonEmptyString.check(Schema.isMaxLength(8_000)),
  context: Schema.optional(Schema.String.check(Schema.isMaxLength(32_000))),
  acceptance: Schema.Array(TrimmedNonEmptyString.check(Schema.isMaxLength(2_000))).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(20),
  ),
  dependencies: Schema.Array(Id).check(Schema.isMaxLength(50)),
  owner: TeamOwner,
  branch: Schema.NullOr(TrimmedNonEmptyString),
  worktreePath: Schema.NullOr(TrimmedNonEmptyString),
  status: Schema.Literals([
    "pending",
    "running",
    "review",
    "settling",
    "settled",
    "blocked",
    "failed",
    "cancelled",
  ]),
  attemptIds: Schema.Array(Id),
  settlementId: Schema.NullOr(Id),
  result: Schema.NullOr(Schema.String),
});
export type TeamTask = typeof TeamTask.Type;

export const TeamAttemptFailure = Schema.Struct({
  kind: Schema.Literals([
    "provider-limit",
    "provider-unavailable",
    "provider-error",
    "invalid-result",
    "cancelled",
    "unknown",
  ]),
  message: Schema.String.check(Schema.isMaxLength(8_000)),
});
export type TeamAttemptFailure = typeof TeamAttemptFailure.Type;

/** One provider-backed unit of managed work. The owner and model selection are frozen per attempt. */
export const TeamAttempt = Schema.Struct({
  id: Id,
  commandId: Id,
  requestMessageId: MessageId,
  taskId: Schema.NullOr(Id),
  role: Schema.Literals(["plan", "work", "review", "integrate"]),
  sequence: Count,
  owner: TeamOwner,
  selection: ModelSelection,
  /** Exact managed prompt persisted before provider dispatch so retries are replay-safe. */
  prompt: BoundedText,
  /** Thread-owned attachment copies persisted before provider dispatch for replay safety. */
  attachments: Schema.Array(ChatAttachment).check(
    Schema.isMaxLength(PROVIDER_SEND_TURN_MAX_ATTACHMENTS),
  ),
  status: Schema.Literals([
    "reserved",
    "dispatching",
    "running",
    "succeeded",
    "failed",
    "cancelled",
  ]),
  providerTurnId: Schema.NullOr(TurnId),
  resultMessageId: Schema.NullOr(MessageId),
  result: Schema.NullOr(Schema.String),
  failure: Schema.NullOr(TeamAttemptFailure),
  createdAt: Timestamp,
  updatedAt: Timestamp,
});
export type TeamAttempt = typeof TeamAttempt.Type;

export const TeamMessage = Schema.Struct({
  id: Id,
  from: TeamOwner,
  to: TeamOwner,
  text: TrimmedNonEmptyString.check(Schema.isMaxLength(8_000)),
  replyRequested: Schema.Boolean,
  inReplyTo: Schema.optional(Id),
  createdAt: Timestamp,
  readAt: Schema.NullOr(Timestamp),
});
export type TeamMessage = typeof TeamMessage.Type;

/** Durable handoff from a worker worktree into the run's primary workspace. */
export const TeamSettlement = Schema.Struct({
  id: Id,
  taskId: Id,
  attemptId: Id,
  owner: TeamOwner,
  sourceWorktreePath: TrimmedNonEmptyString,
  baseCommit: Commit,
  headCommit: Schema.NullOr(Commit),
  appliedCommit: Schema.NullOr(Commit),
  status: Schema.Literals(["pending", "ready", "applying", "applied", "conflict", "rejected"]),
  summary: Schema.NullOr(Schema.String.check(Schema.isMaxLength(8_000))),
  createdAt: Timestamp,
  updatedAt: Timestamp,
});
export type TeamSettlement = typeof TeamSettlement.Type;

export const TeamFailoverTrigger = Schema.Struct({
  kind: Schema.Literals(["provider-limit", "provider-unavailable", "attempt-failed"]),
  providerInstanceId: ProviderInstanceId,
  limitId: Schema.NullOr(TrimmedNonEmptyString.check(Schema.isMaxLength(128))),
  detail: Schema.String.check(Schema.isMaxLength(4_000)),
});
export type TeamFailoverTrigger = typeof TeamFailoverTrigger.Type;

export const TeamFailoverDecision = Schema.Struct({
  action: Schema.Literals(["retry", "switch", "pause"]),
  profileId: Schema.NullOr(Id),
  source: Schema.Literals(["user", "policy", "advisor"]),
  decidedAt: Timestamp,
});
export type TeamFailoverDecision = typeof TeamFailoverDecision.Type;

/** Durable record of a blocked attempt and the decision used to continue, switch or pause. */
export const TeamFailover = Schema.Struct({
  id: Id,
  taskId: Schema.NullOr(Id),
  attemptId: Id,
  fromProfileId: Id,
  candidateProfileIds: Schema.Array(Id).check(Schema.isMaxLength(40)),
  trigger: TeamFailoverTrigger,
  status: Schema.Literals(["pending", "decided", "applied", "paused", "exhausted"]),
  decision: Schema.NullOr(TeamFailoverDecision),
  createdAt: Timestamp,
  updatedAt: Timestamp,
});
export type TeamFailover = typeof TeamFailover.Type;

export const TeamWorkspace = Schema.Struct({
  root: TrimmedNonEmptyString,
  baseCommit: Commit,
  integrationHead: Commit,
  leadBranch: Schema.NullOr(TrimmedNonEmptyString),
  leadWorktreePath: Schema.NullOr(TrimmedNonEmptyString),
});
export type TeamWorkspace = typeof TeamWorkspace.Type;

export const TeamRun = Schema.Struct({
  id: Id,
  commandId: Id,
  projectId: ProjectId,
  revision: Count,
  executionMode: TeamExecutionMode.pipe(
    Schema.withDecodingDefault(Effect.succeed("orchestrated" as const)),
  ),
  runtimeMode: ManagedRuntimeMode,
  prompt: BoundedText,
  policy: TeamPolicy,
  lead: TeamOwner,
  acceptance: Schema.Array(TrimmedNonEmptyString.check(Schema.isMaxLength(2_000))).check(
    Schema.isMaxLength(20),
  ),
  decisions: Schema.Array(Schema.String.check(Schema.isMaxLength(8_000))).check(
    Schema.isMaxLength(200),
  ),
  status: Schema.Literals([
    "planning",
    "running",
    "review",
    "settling",
    "awaiting-provider-decision",
    "paused",
    "completed",
    "cancelled",
    "failed",
  ]),
  statusReason: Schema.NullOr(Schema.String.check(Schema.isMaxLength(8_000))),
  workspace: Schema.NullOr(TeamWorkspace),
  tasks: Schema.Array(TeamTask),
  attempts: Schema.Array(TeamAttempt),
  messages: Schema.Array(TeamMessage),
  settlements: Schema.Array(TeamSettlement),
  failovers: Schema.Array(TeamFailover),
  attachments: Schema.Array(ChatAttachment).check(
    Schema.isMaxLength(PROVIDER_SEND_TURN_MAX_ATTACHMENTS),
  ),
  createdAt: Timestamp,
  updatedAt: Timestamp,
});
export type TeamRun = typeof TeamRun.Type;

export const TeamStart = Schema.Struct({
  commandId: Id,
  projectId: ProjectId,
  runtimeMode: ManagedRuntimeMode,
  prompt: BoundedText,
  attachments: Schema.Array(ChatAttachment).check(
    Schema.isMaxLength(PROVIDER_SEND_TURN_MAX_ATTACHMENTS),
  ),
});
export type TeamStart = typeof TeamStart.Type;

export const TeamRunId = Schema.Struct({ id: Id });
export type TeamRunId = typeof TeamRunId.Type;

export const TeamControl = Schema.Struct({
  id: Id,
  revision: Count,
  action: Schema.Literals(["pause", "resume", "cancel"]),
});
export type TeamControl = typeof TeamControl.Type;

export const TeamProviderDecision = Schema.Struct({
  id: Id,
  revision: Count,
  failoverId: Id,
  action: TeamFailoverDecision.fields.action,
  profileId: Schema.NullOr(Id),
});
export type TeamProviderDecision = typeof TeamProviderDecision.Type;

export const TeamThreadInput = Schema.Struct({ threadId: ThreadId });
export type TeamThreadInput = typeof TeamThreadInput.Type;

export const TeamThreadTurnView = Schema.Struct({
  id: Id,
  role: Schema.Literals(["plan", "worker", "review", "integrate"]),
  taskId: TeamAttempt.fields.taskId,
  threadId: Schema.NullOr(ThreadId),
  model: Schema.String,
  status: Schema.Literals(["reserved", "dispatching", "dispatched", "settled"]),
  succeeded: Schema.Boolean,
  summary: Schema.NullOr(Schema.String),
  providerTurnId: TeamAttempt.fields.providerTurnId,
  resultMessageId: TeamAttempt.fields.resultMessageId,
});
export type TeamThreadTurnView = typeof TeamThreadTurnView.Type;

/** Thread-scoped compatibility projection backed entirely by durable run state. */
export const TeamThreadView = Schema.Struct({
  id: TeamRun.fields.id,
  threadId: ThreadId,
  revision: TeamRun.fields.revision,
  executionMode: TeamRun.fields.executionMode,
  objective: TeamRun.fields.prompt,
  prompt: TeamRun.fields.prompt,
  status: TeamRun.fields.status,
  statusReason: TeamRun.fields.statusReason,
  profiles: TeamPolicy.fields.profiles,
  lead: TeamModelProfile,
  leadOwner: TeamOwner,
  leadThreadId: Schema.NullOr(ThreadId),
  phase: Schema.Literals(["plan", "workers", "integrate", "done"]),
  notice: Schema.NullOr(Schema.String),
  workspace: TeamRun.fields.workspace,
  tasks: Schema.Array(TeamTask),
  attempts: Schema.Array(TeamAttempt),
  turns: Schema.Array(TeamThreadTurnView),
  messages: Schema.Array(TeamMessage),
  settlements: Schema.Array(TeamSettlement),
  failovers: Schema.Array(TeamFailover),
});
export type TeamThreadView = typeof TeamThreadView.Type;

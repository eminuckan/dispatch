import * as Schema from "effect/Schema";
import {
  ChatAttachment,
  ModelSelection,
  PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
  ThreadTurnStartCommand,
} from "./orchestration.ts";
import { MessageId, ProjectId, ThreadId, TurnId, TrimmedNonEmptyString } from "./baseSchemas.ts";

const Id = TrimmedNonEmptyString.check(Schema.isMaxLength(128));
const Count = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
export const TeamTier = Schema.Literals(["economy", "balanced", "capable"]);
export type TeamTier = typeof TeamTier.Type;
export const TeamModelProfile = Schema.Struct({
  id: Id,
  label: TrimmedNonEmptyString.check(Schema.isMaxLength(100)),
  selection: ModelSelection,
  tier: TeamTier,
  reviewRequired: Schema.optional(Schema.Boolean),
  lead: Schema.Boolean,
  worker: Schema.Boolean,
  // A user estimate is never an actual provider bill or subscription price.
  estimatedAttemptUsd: Schema.NullOr(
    Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0), Schema.isLessThanOrEqualTo(1_000_000)),
  ),
});
export type TeamModelProfile = typeof TeamModelProfile.Type;
export const TeamPolicy = Schema.Struct({
  revision: Count,
  mode: Schema.Literals(["off", "shadow", "auto"]),
  profiles: Schema.Array(TeamModelProfile).check(Schema.isMaxLength(40)),
  maxActive: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 5 })),
  // Legacy setting; acceptance, pause/cancel and explicit budgets govern continuation.
  maxAttempts: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 3 })),
  estimatedBudgetUsd: Schema.optional(
    Schema.NullOr(
      Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0), Schema.isLessThanOrEqualTo(1_000_000)),
    ),
  ),
  preferredCapableProfileId: Schema.optional(Schema.NullOr(Id)),
  confidenceThreshold: Schema.Finite.check(Schema.isBetween({ minimum: 0.8, maximum: 1 })),
});
export type TeamPolicy = typeof TeamPolicy.Type;
export const TeamSettings = Schema.Struct({ policy: TeamPolicy, jevConfigured: Schema.Boolean });
export type TeamSettings = typeof TeamSettings.Type;
export const TeamDraft = Schema.Struct({
  draftId: Id,
  revision: Count,
  policyRevision: Count,
  prompt: Schema.String.check(Schema.isMaxLength(64000)),
  // Non-text context is deliberately conservative until semantic inspection exists.
  hasAttachments: Schema.Boolean,
});
export type TeamDraft = typeof TeamDraft.Type;
export const TeamPlanningHints = Schema.Struct({
  context: Schema.Literals(["sufficient", "missing", "unknown"]),
  verification: Schema.Literals(["deterministic", "review", "unknown"]),
  delegation: Schema.Literals(["single", "separable", "unknown"]),
});
export type TeamPlanningHints = typeof TeamPlanningHints.Type;
export const TeamAssessment = Schema.Struct({
  draftId: Id,
  revision: Count,
  fingerprint: Id,
  policyRevision: Count,
  profileId: Schema.NullOr(Id),
  selection: Schema.NullOr(ModelSelection),
  tier: TeamTier,
  confidence: Schema.Finite,
  reason: Schema.String,
  source: Schema.Literals(["jev", "fallback"]),
  inputTokens: Schema.NullOr(Count),
  outputTokens: Schema.NullOr(Count),
  // Advisory only: never authorizes workers or replaces acceptance evidence.
  planning: Schema.optional(TeamPlanningHints),
});
export type TeamAssessment = typeof TeamAssessment.Type;
export class TeamError extends Schema.TaggedError<TeamError>()("TeamError", {
  code: Schema.Literals(["invalid", "conflict", "unavailable", "not-found", "persistence"]),
  message: Schema.String,
}) {}
export const TeamSettingsUpdate = Schema.Struct({ policy: TeamPolicy });
export const TeamSecretUpdate = Schema.Struct({
  // Write-only. Never returned in settings, assessments or events.
  apiKey: Schema.String.check(Schema.isMaxLength(512)),
});
export const TeamTask = Schema.Struct({
  id: Id,
  objective: TrimmedNonEmptyString,
  acceptance: Schema.Array(TrimmedNonEmptyString).check(Schema.isMinLength(1)),
  dependencies: Schema.Array(Id),
  profileId: Id,
  status: Schema.Literals(["pending", "running", "review", "accepted", "failed", "cancelled"]),
  generation: Count,
  attempts: Count,
  threadId: Schema.NullOr(ThreadId),
  context: Schema.String,
  result: Schema.NullOr(Schema.String),
  recoveryHistory: Schema.optional(
    Schema.Array(
      Schema.Struct({
        generation: Count,
        profileId: Id,
        result: Schema.NullOr(Schema.String),
        correction: TrimmedNonEmptyString,
      }),
    ),
  ),
});
export type TeamTask = typeof TeamTask.Type;
export const TeamExecutionTurn = Schema.Struct({
  id: Id,
  observedMessageSequence: Schema.optional(Count),
  resultMessageId: Schema.optional(MessageId),
  providerTurnId: Schema.optional(TurnId),
  estimatedAttemptUsd: Schema.optional(
    Schema.NullOr(
      Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0), Schema.isLessThanOrEqualTo(1_000_000)),
    ),
  ),
  role: Schema.Literals(["plan", "worker", "review", "integrate", "consult"]),
  taskId: Schema.NullOr(Id),
  command: ThreadTurnStartCommand,
  status: Schema.Literals(["reserved", "dispatching", "dispatched", "settled"]),
  result: Schema.NullOr(Schema.String),
  succeeded: Schema.Boolean,
});
export type TeamExecutionTurn = typeof TeamExecutionTurn.Type;
export const TeamExecution = Schema.Struct({
  workspaceRoot: Schema.String,
  baseCommit: Schema.String,
  leadThreadId: ThreadId,
  // Legacy clients may send this field; execution no longer uses a turn ceiling.
  maxTurns: Schema.optional(Schema.Int),
  turns: Schema.Array(TeamExecutionTurn),
  acceptance: Schema.optional(
    Schema.Array(TrimmedNonEmptyString).check(Schema.isMinLength(1), Schema.isMaxLength(20)),
  ),
  phase: Schema.Literals(["plan", "workers", "integrate", "done"]),
  notice: Schema.NullOr(Schema.String),
});
export const TeamPeerMessage = Schema.Struct({
  id: Id,
  fromThreadId: ThreadId,
  toThreadId: ThreadId,
  text: TrimmedNonEmptyString.check(Schema.isMaxLength(8000)),
  replyRequested: Schema.Boolean,
  inReplyTo: Schema.optional(Id),
  origin: Schema.optional(Schema.Literal("progress")),
  sourceSequence: Schema.optional(Count),
  createdAt: Schema.String,
  readAt: Schema.NullOr(Schema.String),
});
export type TeamPeerMessage = typeof TeamPeerMessage.Type;
export const TeamRun = Schema.Struct({
  id: Id,
  commandId: Id,
  projectId: ProjectId,
  revision: Count,
  objective: TrimmedNonEmptyString,
  policy: TeamPolicy,
  lead: TeamModelProfile,
  status: Schema.Literals([
    "planning",
    "running",
    "review",
    "completed",
    "paused",
    "cancelled",
    "failed",
  ]),
  tasks: Schema.Array(TeamTask),
  decisions: Schema.Array(Schema.String),
  messages: Schema.optional(Schema.Array(TeamPeerMessage)),
  createdAt: Schema.String,
  updatedAt: Schema.String,
  /** Persisted upload references that must survive queued team turns and restarts. */
  attachments: Schema.optional(
    Schema.Array(ChatAttachment).check(Schema.isMaxLength(PROVIDER_SEND_TURN_MAX_ATTACHMENTS)),
  ),
  execution: Schema.optional(TeamExecution),
});
export type TeamRun = typeof TeamRun.Type;
export const TeamStart = Schema.Struct({
  commandId: Id,
  projectId: ProjectId,
  draft: TeamDraft,
  fingerprint: Id,
  /** Attachments have already been persisted by the client upload flow. */
  attachments: Schema.optional(
    Schema.Array(ChatAttachment).check(Schema.isMaxLength(PROVIDER_SEND_TURN_MAX_ATTACHMENTS)),
  ),
  // Legacy clients may send this field; execution no longer uses a turn ceiling.
  maxTurns: Schema.optional(Schema.Int),
});
export type TeamStart = typeof TeamStart.Type;
export const TeamRunId = Schema.Struct({ id: Id });
export const TeamControl = Schema.Struct({
  id: Id,
  revision: Count,
  action: Schema.Literals(["pause", "resume", "cancel"]),
  maxTurns: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 100 }))),
});

export type TeamControl = typeof TeamControl.Type;

export const TeamResolve = Schema.Struct({
  prompt: Schema.String.check(Schema.isMaxLength(64000)),
  hasAttachments: Schema.Boolean,
});
// Bounded diagnostic input. This endpoint recommends; it cannot dispatch or settle an attempt.
export const TeamRecoveryInput = Schema.Struct({
  policyRevision: Count,
  currentProfileId: Id,
  objective: TrimmedNonEmptyString.check(Schema.isMaxLength(4000)),
  evidence: TrimmedNonEmptyString.check(Schema.isMaxLength(8000)),
  correction: Schema.String.check(Schema.isMaxLength(4000)),
  attemptsMade: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  inFlight: Schema.Boolean,
});
export type TeamRecoveryInput = typeof TeamRecoveryInput.Type;
export const TeamRecoveryAdvice = Schema.Struct({
  action: Schema.Literals([
    "wait",
    "stop",
    "repair_environment",
    "supply_context",
    "correct",
    "increase_effort",
    "new_worker",
    "lead_review",
  ]),
  profileId: Schema.NullOr(Id),
  reason: Schema.String,
  source: Schema.Literals(["jev", "policy"]),
});
export type TeamRecoveryAdvice = typeof TeamRecoveryAdvice.Type;

// Presentation read model: coordination prompts, review commands and context stay out of chat.
export const TeamThreadInput = Schema.Struct({ threadId: ThreadId });
export const TeamThreadView = Schema.Struct({
  id: Id,
  coordinationMessageIds: Schema.Array(MessageId),
  revision: Count,
  objective: Schema.String,
  status: TeamRun.fields.status,
  lead: TeamModelProfile,
  leadThreadId: ThreadId,
  phase: TeamExecution.fields.phase,
  notice: Schema.NullOr(Schema.String),
  maxTurns: Schema.optional(Schema.Int),
  tasks: Schema.Array(
    Schema.Struct({
      id: TeamTask.fields.id,
      objective: TeamTask.fields.objective,
      acceptance: TeamTask.fields.acceptance,
      dependencies: TeamTask.fields.dependencies,
      profileId: TeamTask.fields.profileId,
      status: TeamTask.fields.status,
      generation: TeamTask.fields.generation,
      attempts: TeamTask.fields.attempts,
      threadId: TeamTask.fields.threadId,
    }),
  ),
  turns: Schema.Array(
    Schema.Struct({
      id: Id,
      role: TeamExecutionTurn.fields.role,
      taskId: Schema.NullOr(Id),
      threadId: ThreadId,
      model: Schema.String,
      effort: Schema.NullOr(Schema.String),
      status: TeamExecutionTurn.fields.status,
      succeeded: Schema.Boolean,
      summary: Schema.NullOr(Schema.String),
      providerTurnId: Schema.optional(TurnId),
      resultMessageId: Schema.optional(MessageId),
    }),
  ),
});
export type TeamThreadView = typeof TeamThreadView.Type;

export const TeamPoolSuggestion = Schema.Struct({
  profiles: Schema.Array(TeamModelProfile),
  notes: Schema.Array(Schema.String),
  source: Schema.Literals(["jev", "catalog"]),
});

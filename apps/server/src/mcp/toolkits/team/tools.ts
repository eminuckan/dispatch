import { TeamError, TeamPeerMessage, ThreadId, TrimmedNonEmptyString } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as Tool from "effect/unstable/ai/Tool";
import * as Toolkit from "effect/unstable/ai/Toolkit";

import { TeamRuntime } from "../../../team/TeamRuntime.ts";
import { McpInvocationContext } from "../../McpInvocationContext.ts";

const dependencies = [McpInvocationContext, TeamRuntime];

const SendMessage = Tool.make("team_send_message", {
  description:
    "Send a durable mailbox message to another current member of this managed Dispatch team. Use team_read_messages to discover current teammate thread IDs and to check for replies. Sender identity comes from the authenticated provider session. Reuse id when retrying the same message, and set inReplyTo when replying to a received message. replyRequested records that you want a reply; delivery does not start a separate provider turn or answer user permissions or approvals.",
  parameters: Schema.Struct({
    id: TrimmedNonEmptyString.check(Schema.isMaxLength(128)),
    toThreadId: ThreadId,
    text: TrimmedNonEmptyString.check(Schema.isMaxLength(8000)),
    replyRequested: Schema.Boolean,
    inReplyTo: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(128))),
  }),
  success: TeamPeerMessage,
  failure: TeamError,
  dependencies,
})
  .annotate(Tool.Title, "Message teammate")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

const ReadMessages = Tool.make("team_read_messages", {
  description:
    "Read this managed team member's durable mailbox and current teammate progress. By default returns up to 40 unread messages and marks those returned messages read. Set includeRead to recover recent messages after a lost tool response. Call between meaningful work steps and before reporting a result when teammate input could affect the work. Reading messages does not accept tasks or answer user permissions or approvals.",
  parameters: Schema.Struct({ includeRead: Schema.optional(Schema.Boolean) }),
  success: Schema.Struct({
    runId: Schema.String,
    status: Schema.String,
    leadThreadId: ThreadId,
    members: Schema.Array(
      Schema.Struct({
        threadId: ThreadId,
        role: Schema.Literals(["lead", "worker"]),
        state: Schema.String,
        activity: Schema.String,
        needsUserInput: Schema.Boolean,
        summary: Schema.String,
      }),
    ),
    messages: Schema.Array(TeamPeerMessage),
  }),
  failure: TeamError,
  dependencies,
})
  .annotate(Tool.Title, "Read team messages")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.OpenWorld, false);

export const TeamToolkit = Toolkit.make(SendMessage, ReadMessages);

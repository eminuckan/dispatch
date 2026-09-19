import { TeamError, TeamPeerMessage, ThreadId, TrimmedNonEmptyString } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as Tool from "effect/unstable/ai/Tool";
import * as Toolkit from "effect/unstable/ai/Toolkit";
import { McpInvocationContext } from "../../McpInvocationContext.ts";
import { TeamRuntime } from "../../../team/TeamRuntime.ts";

const dependencies = [McpInvocationContext, TeamRuntime];
const SendMessage = Tool.make("team_send_message", {
  description:
    "Send a live question, suggestion, finding or correction to another member of your Dispatch team. Use team_read_messages to discover exact recipient thread IDs. Sender identity comes from your authenticated provider session. Set replyRequested for a question: an idle recipient is woken and its consultation answer is returned to your inbox. Active recipients read messages between work steps. This never answers user permissions or accepts work. Reuse id when retrying the same message. Set inReplyTo when answering a received question.",
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
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);
const ReadMessages = Tool.make("team_read_messages", {
  description:
    "Read and acknowledge up to 40 unread team messages and inspect current teammate progress. Call before meaningful work steps and before your final result, especially while waiting for advice. Use includeRead to recover the latest 40 messages after a lost tool response. Messages are durable across restart; reading them does not accept a task or respond to a user's approval request. Available only inside a managed Dispatch team.",
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
  .annotate(Tool.Title, "Read team messages and progress")
  .annotate(Tool.Destructive, false);
export const TeamToolkit = Toolkit.make(SendMessage, ReadMessages);

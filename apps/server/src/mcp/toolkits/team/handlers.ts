import * as Effect from "effect/Effect";

import { TeamRuntime } from "../../../team/TeamRuntime.ts";
import { McpInvocationContext } from "../../McpInvocationContext.ts";
import { TeamToolkit } from "./tools.ts";

export const TeamToolkitHandlersLive = TeamToolkit.toLayer(
  Effect.gen(function* () {
    const runtime = yield* TeamRuntime;
    return TeamToolkit.of({
      team_send_message: (input) =>
        Effect.flatMap(McpInvocationContext, (scope) =>
          runtime.sendMessage(scope.threadId, {
            id: input.id,
            toThreadId: input.toThreadId,
            text: input.text,
            replyRequested: input.replyRequested,
            ...(input.inReplyTo === undefined ? {} : { inReplyTo: input.inReplyTo }),
          }),
        ),
      team_read_messages: (input) =>
        Effect.flatMap(McpInvocationContext, (scope) =>
          runtime.readMessages(scope.threadId, input.includeRead ?? false),
        ),
    });
  }),
);

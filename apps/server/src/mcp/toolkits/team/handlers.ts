import * as Effect from "effect/Effect";
import { McpInvocationContext } from "../../McpInvocationContext.ts";
import { TeamRuntime } from "../../../team/TeamRuntime.ts";
import { TeamToolkit } from "./tools.ts";

export const TeamToolkitHandlersLive = TeamToolkit.toLayer(
  Effect.gen(function* () {
    const runtime = yield* TeamRuntime;
    return TeamToolkit.of({
      team_send_message: (input) =>
        Effect.flatMap(McpInvocationContext, (scope) => runtime.sendMessage(scope.threadId, input)),
      team_read_messages: (input) =>
        Effect.flatMap(McpInvocationContext, (scope) =>
          runtime.readMessages(scope.threadId, input.includeRead),
        ),
    });
  }),
);

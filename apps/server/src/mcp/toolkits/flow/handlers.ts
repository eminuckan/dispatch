import { FlowError, type ThreadId } from "@dispatch/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { FlowRuntime } from "../../../flow/FlowRuntime.ts";
import { McpInvocationContext } from "../../McpInvocationContext.ts";
import { FlowToolkit } from "./tools.ts";

export const FlowToolkitHandlersLive = FlowToolkit.toLayer(
  Effect.gen(function* () {
    const runtime = Option.getOrNull(yield* Effect.serviceOption(FlowRuntime));
    const authorized = <A>(operation: (threadId: ThreadId) => Effect.Effect<A, FlowError>) =>
      Effect.gen(function* () {
        const scope = yield* McpInvocationContext;
        if (!scope.capabilities.has("flow"))
          return yield* new FlowError({
            code: "invalid",
            message: "Flow is not enabled for this provider session.",
          });
        if (!runtime)
          return yield* new FlowError({
            code: "unavailable",
            message: "Flow is unavailable in this environment.",
          });
        return yield* operation(scope.threadId);
      });
    return FlowToolkit.of({
      flow_models: () =>
        authorized(() =>
          runtime!.models.pipe(
            Effect.map((providers) =>
              providers.flatMap((provider) =>
                provider.enabled &&
                provider.status === "ready" &&
                provider.auth.status !== "unauthenticated" &&
                provider.availability !== "unavailable"
                  ? provider.models
                      .filter((model) => !model.isLegacy)
                      .map((model) => ({
                        selection: { instanceId: provider.instanceId, model: model.slug },
                        providerName: provider.displayName ?? provider.instanceId,
                        modelName: model.name,
                      }))
                  : [],
              ),
            ),
            Effect.mapError(
              () => new FlowError({ code: "unavailable", message: "Could not list Flow models." }),
            ),
          ),
        ),
      flow_spawn: (input) => authorized((threadId) => runtime!.spawn(threadId, input)),
      flow_send: (input) => authorized((threadId) => runtime!.send(threadId, input)),
      flow_wait: (input) => authorized((threadId) => Effect.scoped(runtime!.wait(threadId, input))),
      flow_list: () =>
        authorized((threadId) =>
          Effect.flatMap(runtime!.view(threadId), (view) =>
            view
              ? Effect.succeed(view)
              : Effect.fail(new FlowError({ code: "not-found", message: "Flow was not found." })),
          ),
        ),
      flow_stop: (input) => authorized((threadId) => runtime!.stop(threadId, input.workerThreadId)),
    });
  }),
);

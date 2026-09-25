import { TeamError, type ThreadId } from "@dispatch/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { DISPATCH_CONNECT_SMART_ROUTING_SESSION_SECRET } from "../auth/DispatchConnectEnvironment.ts";
import { ServerSecretStore } from "../auth/ServerSecretStore.ts";
import { OrchestrationStore } from "./OrchestrationStore.ts";
import { teamThreadView } from "./presentation.ts";

/** Read-only access to managed runs created before the Flow migration. */
export const make = Effect.gen(function* () {
  const store = yield* OrchestrationStore;
  const secrets = yield* ServerSecretStore;
  for (const name of ["team-jev-api-key", DISPATCH_CONNECT_SMART_ROUTING_SESSION_SECRET]) {
    yield* secrets
      .remove(name)
      .pipe(
        Effect.catch((cause) =>
          Effect.logWarning("Could not remove retired routing secret", { name, cause }),
        ),
      );
  }

  const forThread = Effect.fn("LegacyTeamRuntime.forThread")(function* (threadId: ThreadId) {
    return teamThreadView(yield* store.findByThread(threadId));
  });
  const assertClientMessageAllowed = Effect.fn("LegacyTeamRuntime.assertClientMessageAllowed")(
    function* (threadId: ThreadId) {
      const run = yield* store.findByThread(threadId);
      if (run && run.lead.threadId !== threadId)
        return yield* new TeamError({
          code: "invalid",
          message:
            "Previous managed worker threads are read only. Open the lead thread for history.",
        });
    },
  );

  return { list: store.list, get: store.get, forThread, assertClientMessageAllowed };
});

export class TeamRuntime extends Context.Service<TeamRuntime, Effect.Success<typeof make>>()(
  "dispatch/team/TeamRuntime",
) {}

export const layer = Layer.effect(TeamRuntime, make);

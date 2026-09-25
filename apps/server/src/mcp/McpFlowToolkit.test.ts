import { expect, it } from "@effect/vitest";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@dispatch/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { McpSchema, McpServer } from "effect/unstable/ai";

import { FlowRuntime } from "../flow/FlowRuntime.ts";
import * as McpHttpServer from "./McpHttpServer.ts";
import * as McpInvocationContext from "./McpInvocationContext.ts";

const parentThreadId = ThreadId.make("lead");
const workerThreadId = ThreadId.make("flow-worker");
const selection = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-test" };
const worker = {
  threadId: workerThreadId,
  parentThreadId,
  assignment: "Check parser edge cases",
  modelSelection: selection,
  branch: "flow/flow-worker",
  worktreePath: null,
  state: "queued" as const,
  error: null,
  latestJob: null,
  createdAt: "2026-09-25T00:00:00.000Z",
  updatedAt: "2026-09-25T00:00:00.000Z",
};
const client = McpSchema.McpServerClient.of({
  clientId: 1,
  clientCapabilities: {},
  clientInfo: { name: "flow-test", version: "1.0.0" },
  protocolVersion: "2025-06-18",
  initializePayload: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "flow-test", version: "1.0.0" },
  },
  getClient: Effect.die("unused"),
});

it.effect("Flow MCP controls use the authenticated lead thread and require its capability", () => {
  const spawned: ThreadId[] = [];
  const runtime = {
    models: Effect.succeed([]),
    spawn: (threadId: ThreadId) => {
      spawned.push(threadId);
      return Effect.succeed(worker);
    },
    send: () => Effect.die("unused"),
    wait: () => Effect.die("unused"),
    stop: () => Effect.die("unused"),
    view: () =>
      Effect.succeed({
        parentThreadId,
        enabled: true,
        currentWorkerThreadId: null,
        workers: [worker],
      }),
  };
  const testLayer = McpHttpServer.FlowToolkitRegistrationLive.pipe(
    Layer.provideMerge(McpServer.McpServer.layer),
    Layer.provide(Layer.succeed(FlowRuntime, runtime as never)),
  );
  const invocation = (enabled: boolean): McpInvocationContext.McpInvocationScope => ({
    environmentId: EnvironmentId.make("environment"),
    threadId: parentThreadId,
    providerSessionId: "session",
    providerInstanceId: selection.instanceId,
    capabilities: enabled ? new Set(["flow"]) : new Set(),
    issuedAt: 1,
  });
  return Effect.scoped(
    Effect.gen(function* () {
      const server = yield* McpServer.McpServer;
      expect(server.tools.map(({ tool }) => tool.name).toSorted()).toEqual([
        "flow_list",
        "flow_models",
        "flow_send",
        "flow_spawn",
        "flow_stop",
        "flow_wait",
      ]);
      const input = { id: "spawn-1", assignment: worker.assignment, modelSelection: selection };
      const denied = yield* server
        .callTool({ name: "flow_spawn", arguments: input })
        .pipe(
          Effect.provideService(McpInvocationContext.McpInvocationContext, invocation(false)),
          Effect.provideService(McpSchema.McpServerClient, client),
        );
      expect(denied.isError).toBe(true);
      expect(spawned).toEqual([]);
      const allowed = yield* server
        .callTool({ name: "flow_spawn", arguments: input })
        .pipe(
          Effect.provideService(McpInvocationContext.McpInvocationContext, invocation(true)),
          Effect.provideService(McpSchema.McpServerClient, client),
        );
      expect(allowed.isError).toBe(false);
      expect(spawned).toEqual([parentThreadId]);
      expect(allowed.structuredContent).toMatchObject({ threadId: workerThreadId, parentThreadId });
    }),
  ).pipe(Effect.provide(testLayer));
});

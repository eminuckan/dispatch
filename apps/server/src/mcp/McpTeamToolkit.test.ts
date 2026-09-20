import { expect, it } from "@effect/vitest";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@dispatch/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { McpSchema, McpServer } from "effect/unstable/ai";

import { TeamRuntime } from "../team/TeamRuntime.ts";
import * as McpHttpServer from "./McpHttpServer.ts";
import * as McpInvocationContext from "./McpInvocationContext.ts";

const fromThreadId = ThreadId.make("team-runtime-worker");
const toThreadId = ThreadId.make("team-runtime-lead");
const environmentId = EnvironmentId.make("environment-team-mcp-test");
const invocation: McpInvocationContext.McpInvocationScope = {
  environmentId,
  threadId: fromThreadId,
  providerSessionId: "provider-session-team-mcp-test",
  providerInstanceId: ProviderInstanceId.make("codex"),
  capabilities: new Set(),
  issuedAt: 1,
};
const client = McpSchema.McpServerClient.of({
  clientId: 1,
  clientCapabilities: {},
  clientInfo: { name: "mcp-team-test", version: "1.0.0" },
  protocolVersion: "2025-06-18",
  initializePayload: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "mcp-team-test", version: "1.0.0" },
  },
  getClient: Effect.die("unused"),
});

it.effect(
  "registers durable team mailbox tools and derives sender from authenticated context",
  () => {
    const sent: Array<{
      readonly fromThreadId: ThreadId;
      readonly input: {
        readonly id: string;
        readonly toThreadId: ThreadId;
        readonly text: string;
        readonly replyRequested: boolean;
        readonly inReplyTo?: string | undefined;
      };
    }> = [];
    const reads: Array<{ readonly threadId: ThreadId; readonly includeRead: boolean }> = [];
    const runtime = {
      sendMessage: (senderThreadId: ThreadId, input: (typeof sent)[number]["input"]) => {
        sent.push({ fromThreadId: senderThreadId, input });
        return Effect.succeed({
          ...input,
          fromThreadId: senderThreadId,
          createdAt: "2026-09-20T12:00:00.000Z",
          readAt: null,
        });
      },
      readMessages: (threadId: ThreadId, includeRead: boolean) => {
        reads.push({ threadId, includeRead });
        return Effect.succeed({
          runId: "team-run",
          status: "running",
          leadThreadId: toThreadId,
          members: [
            {
              threadId: toThreadId,
              role: "lead" as const,
              state: "idle",
              activity: "",
              needsUserInput: false,
              summary: "",
            },
            {
              threadId: fromThreadId,
              role: "worker" as const,
              state: "running",
              activity: "Implementing",
              needsUserInput: false,
              summary: "Working on MCP",
            },
          ],
          messages: [],
        });
      },
    };
    const testLayer = McpHttpServer.TeamToolkitRegistrationLive.pipe(
      Layer.provideMerge(McpServer.McpServer.layer),
      Layer.provide(Layer.succeed(TeamRuntime, runtime as never)),
    );

    return Effect.scoped(
      Effect.gen(function* () {
        const server = yield* McpServer.McpServer;
        expect(server.tools.map(({ tool }) => tool.name).toSorted()).toEqual([
          "team_read_messages",
          "team_send_message",
        ]);

        const sendTool = server.tools.find(({ tool }) => tool.name === "team_send_message")?.tool;
        expect(sendTool?.description ?? "").toContain("durable mailbox");
        expect((sendTool?.description ?? "").toLowerCase()).not.toContain("wake");
        const sendProperties = (sendTool?.inputSchema as { properties?: Record<string, unknown> })
          ?.properties;
        expect(Object.keys(sendProperties ?? {}).toSorted()).toEqual([
          "id",
          "inReplyTo",
          "replyRequested",
          "text",
          "toThreadId",
        ]);

        const send = yield* server
          .callTool({
            name: "team_send_message",
            arguments: {
              id: "message-1",
              toThreadId,
              text: "Please verify the runtime boundary.",
              replyRequested: true,
            },
          })
          .pipe(
            Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
            Effect.provideService(McpSchema.McpServerClient, client),
          );
        expect(send.isError).toBe(false);
        expect(sent).toEqual([
          {
            fromThreadId,
            input: {
              id: "message-1",
              toThreadId,
              text: "Please verify the runtime boundary.",
              replyRequested: true,
            },
          },
        ]);
        expect(send.structuredContent).toMatchObject({ fromThreadId, toThreadId });

        const read = yield* server
          .callTool({ name: "team_read_messages", arguments: { includeRead: true } })
          .pipe(
            Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
            Effect.provideService(McpSchema.McpServerClient, client),
          );
        expect(read.isError).toBe(false);
        expect(reads).toEqual([{ threadId: fromThreadId, includeRead: true }]);
        expect(read.structuredContent).toMatchObject({
          runId: "team-run",
          leadThreadId: toThreadId,
        });
      }),
    ).pipe(Effect.provide(testLayer));
  },
);

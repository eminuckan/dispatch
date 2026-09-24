import * as NodeAssert from "node:assert/strict";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { OpenCode, type OpenCodeClient } from "@opencode/client";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import { HostProcessExecutablePath } from "@dispatch/shared/hostProcess";

import { OpenCodeRuntime, OpenCodeRuntimeLive } from "./opencodeRuntime.ts";

const testLayer = OpenCodeRuntimeLive.pipe(Layer.provideMerge(NodeServices.layer));

it.layer(testLayer)("OpenCodeRuntime inventory", (it) => {
  it.effect("aborts pending SDK requests when inventory loading is interrupted", () =>
    Effect.gen(function* () {
      const runtime = yield* OpenCodeRuntime;
      const started = yield* Queue.make<void>();
      const aborted = yield* Queue.make<string>();
      const client = OpenCode.make({
        baseUrl: "http://opencode.test",
        fetch: Object.assign(
          (input: string | Request | URL, init?: RequestInit) => {
            const request = input instanceof Request ? input : new Request(input.toString(), init);
            const path = new URL(request.url).pathname;
            if (path === "/api/integration") {
              return Promise.resolve(
                Response.json({ location: { directory: "/workspace/project" }, data: [] }),
              );
            }
            return new Promise<Response>((_resolve, reject) => {
              request.signal.addEventListener(
                "abort",
                () => {
                  Queue.offerUnsafe(aborted, path);
                  reject(request.signal.reason);
                },
                { once: true },
              );
              Queue.offerUnsafe(started, undefined);
            });
          },
          { preconnect: () => undefined },
        ),
      });

      const inventoryFiber = yield* runtime
        .loadOpenCodeInventory(client, "/workspace/project")
        .pipe(Effect.forkChild);
      yield* Queue.takeN(started, 5);
      yield* Fiber.interrupt(inventoryFiber);

      NodeAssert.deepEqual((yield* Queue.takeAll(aborted)).toSorted(), [
        "/api/agent",
        "/api/command",
        "/api/model",
        "/api/provider",
        "/api/skill",
      ]);
    }),
  );

  it.effect("loads v2 inventory after integration discovery and scopes every request", () =>
    Effect.gen(function* () {
      const runtime = yield* OpenCodeRuntime;
      const requests: Request[] = [];
      let integrationLoaded = false;
      const client = OpenCode.make({
        baseUrl: "http://opencode.test",
        fetch: Object.assign(
          async (input: string | Request | URL, init?: RequestInit) => {
            const request = input instanceof Request ? input : new Request(input.toString(), init);
            requests.push(request);
            const route = new URL(request.url).pathname;
            const location = { directory: "/workspace/project" };
            if (route === "/api/integration") {
              integrationLoaded = true;
              return Response.json({ location, data: [] });
            }
            NodeAssert.equal(integrationLoaded, true);
            const data =
              route === "/api/provider"
                ? [
                    {
                      id: "opencode-go",
                      name: "OpenCode Go",
                      activation: "enabled",
                      package: "@ai-sdk/openai-compatible",
                      headers: { authorization: "must-not-be-retained" },
                    },
                  ]
                : route === "/api/model"
                  ? [
                      {
                        id: "gpt-5.6-sol",
                        modelID: "gpt-5.6-sol",
                        providerID: "opencode-go",
                        name: "GPT-5.6 Sol",
                        capabilities: { tools: true, input: ["text"], output: ["text"] },
                        variants: [{ id: "low" }, { id: "high" }],
                        time: { released: 0 },
                        cost: [],
                        status: "active",
                        enabled: true,
                        limit: { context: 200000, output: 32000 },
                        headers: { authorization: "must-not-be-retained" },
                      },
                    ]
                  : route === "/api/agent"
                    ? [
                        { id: "build", name: "Build", mode: "primary", hidden: false },
                        { id: "summary", name: "Summary", mode: "primary", hidden: true },
                      ]
                    : route === "/api/command"
                      ? [{ name: "review", description: "Review changes" }]
                      : route === "/api/skill"
                        ? [
                            {
                              id: "review",
                              name: "Review",
                              description: "Review code changes",
                              path: "/skills/review/SKILL.md",
                              content: "must not be retained",
                            },
                          ]
                        : [];
            return Response.json({ location, data });
          },
          { preconnect: () => undefined },
        ),
      });
      const inventory = yield* runtime.loadOpenCodeInventory(client, "/workspace/project");

      NodeAssert.deepEqual(inventory, {
        providers: [{ id: "opencode-go", name: "OpenCode Go", activation: "enabled" }],
        models: [
          {
            id: "gpt-5.6-sol",
            providerID: "opencode-go",
            name: "GPT-5.6 Sol",
            enabled: true,
            capabilities: { input: ["text"] },
            variants: [{ id: "low" }, { id: "high" }],
          },
        ],
        agents: [
          { id: "build", name: "Build", mode: "primary", hidden: false },
          { id: "summary", name: "Summary", mode: "primary", hidden: true },
        ],
        commands: [{ name: "review", description: "Review changes" }],
        skills: [
          {
            id: "review",
            name: "Review",
            description: "Review code changes",
            path: "/skills/review/SKILL.md",
          },
        ],
      });
      NodeAssert.equal(new URL(requests[0]!.url).pathname, "/api/integration");
      NodeAssert.deepEqual(
        requests.map((request) => new URL(request.url).searchParams.get("location[directory]")),
        Array.from({ length: 6 }, () => "/workspace/project"),
      );
    }),
  );

  it.effect("does not turn a failed v2 inventory request into empty success", () =>
    Effect.gen(function* () {
      const runtime = yield* OpenCodeRuntime;
      const client = {
        integration: { list: () => Promise.resolve({ data: [] }) },
        provider: {
          list: () => Promise.resolve({ data: [] }),
        },
        model: { list: () => Promise.resolve({ data: [] }) },
        agent: { list: () => Promise.reject(new Error("agents endpoint unavailable")) },
        command: { list: () => Promise.resolve({ data: [] }) },
        skill: { list: () => Promise.resolve({ data: [] }) },
      } as unknown as OpenCodeClient;

      const error = yield* runtime
        .loadOpenCodeInventory(client, "/workspace/project")
        .pipe(Effect.flip);

      NodeAssert.equal(error.operation, "agent.list");
      NodeAssert.match(error.detail, /agents endpoint unavailable/);
    }),
  );

  it.effect("caps and drains command stdout and stderr when requested", () =>
    Effect.gen(function* () {
      const runtime = yield* OpenCodeRuntime;
      const executablePath = yield* HostProcessExecutablePath;
      const outputBytes = 2 * 1024 * 1024;
      const result = yield* runtime.runOpenCodeCommand({
        binaryPath: executablePath,
        args: [
          "-e",
          `process.stdout.write("o".repeat(${outputBytes})); process.stderr.write("e".repeat(${outputBytes}));`,
        ],
        maxOutputBytes: 64,
      });

      NodeAssert.equal(result.stdout, "o".repeat(64));
      NodeAssert.equal(result.stderr, "e".repeat(64));
      NodeAssert.equal(result.code, 0);
    }),
  );
});

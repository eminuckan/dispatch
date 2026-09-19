// @effect-diagnostics nodeBuiltinImport:off - lifecycle tests observe real native subprocess ownership.
import * as NodeChildProcess from "node:child_process";
import * as NodeNet from "node:net";

import type { OpenCodeClient } from "@opencode/client";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { it as effectIt } from "@effect/vitest";
import {
  HostProcessEnvironment,
  HostProcessExecutablePath,
  HostProcessPlatform,
} from "@t3tools/shared/hostProcess";
import * as Effect from "effect/Effect";
import * as Data from "effect/Data";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Scope from "effect/Scope";
import * as TestClock from "effect/testing/TestClock";
import { FetchHttpClient, HttpClient } from "effect/unstable/http";
import { describe, expect, it } from "vite-plus/test";

import {
  OpenCodeRuntime,
  OpenCodeRuntimeError,
  OpenCodeRuntimeLive,
  resolveOpenCodeConfigContent,
  resolveOpenCodeServerPassword,
  verifyOpenCodeServerVersion,
} from "./opencodeRuntime.ts";

describe("resolveOpenCodeConfigContent", () => {
  it("prefers the caller environment over the inherited environment", () => {
    expect(
      resolveOpenCodeConfigContent(
        { OPENCODE_CONFIG_CONTENT: '{"source":"caller"}' },
        { OPENCODE_CONFIG_CONTENT: '{"source":"process"}' },
      ),
    ).toBe('{"source":"caller"}');
  });

  it("falls back to the inherited environment and otherwise leaves config unset", () => {
    expect(
      resolveOpenCodeConfigContent(undefined, {
        OPENCODE_CONFIG_CONTENT: '{"source":"process"}',
      }),
    ).toBe('{"source":"process"}');
    expect(resolveOpenCodeConfigContent(undefined, {})).toBeUndefined();
  });
});

describe("resolveOpenCodeServerPassword", () => {
  it("uses the local environment password when settings do not provide one", () => {
    expect(
      resolveOpenCodeServerPassword(
        { external: false, environment: { OPENCODE_SERVER_PASSWORD: " env password " } },
        {},
      ),
    ).toBe(" env password ");
  });

  it("uses the settings password for a local server", () => {
    expect(
      resolveOpenCodeServerPassword({ external: false, serverPassword: " settings password " }, {}),
    ).toBe(" settings password ");
  });

  it("uses the settings password when local settings and environment differ", () => {
    expect(
      resolveOpenCodeServerPassword(
        {
          external: false,
          serverPassword: "settings-password",
          environment: { OPENCODE_SERVER_PASSWORD: "environment-password" },
        },
        {},
      ),
    ).toBe("settings-password");
  });

  it("does not send an inherited local password to an external server", () => {
    expect(
      resolveOpenCodeServerPassword(
        { external: true, environment: { OPENCODE_SERVER_PASSWORD: "local-secret" } },
        { OPENCODE_SERVER_PASSWORD: "inherited-secret" },
      ),
    ).toBeUndefined();
  });
});

function makeInfoClient(
  result: (options?: { readonly signal?: AbortSignal }) => Promise<unknown>,
): OpenCodeClient {
  return {
    server: {
      info: result,
    },
  } as unknown as OpenCodeClient;
}

describe("verifyOpenCodeServerVersion", () => {
  effectIt.effect("accepts a supported server version", () =>
    Effect.gen(function* () {
      const version = yield* verifyOpenCodeServerVersion(
        makeInfoClient(() => Promise.resolve({ version: "2.0.7" })),
      );
      expect(version).toBe("2.0.7");
    }),
  );

  effectIt.effect("rejects a server below the supported version", () =>
    Effect.gen(function* () {
      const error = yield* verifyOpenCodeServerVersion(
        makeInfoClient(() => Promise.resolve({ version: "1.99.0" })),
      ).pipe(Effect.flip);
      expect(error).toBeInstanceOf(OpenCodeRuntimeError);
      expect(error.detail).toContain("v1.99.0 is too old");
    }),
  );

  effectIt.effect("rejects a server above the supported v2 range", () =>
    Effect.gen(function* () {
      const error = yield* verifyOpenCodeServerVersion(
        makeInfoClient(() => Promise.resolve({ version: "3.0.0" })),
      ).pipe(Effect.flip);
      expect(error.detail).toContain("newer than the supported v2 API");
      expect(error.detail).toContain(">=2.0.0 <3.0.0");
    }),
  );

  for (const data of [{}, { version: "not-a-version" }]) {
    effectIt.effect(`rejects an invalid info response: ${JSON.stringify(data)}`, () =>
      Effect.gen(function* () {
        const error = yield* verifyOpenCodeServerVersion(
          makeInfoClient(() => Promise.resolve(data)),
        ).pipe(Effect.flip);
        expect(error).toBeInstanceOf(OpenCodeRuntimeError);
        expect(error.detail).toContain("supports OpenCode >=2.0.0 <3.0.0");
      }),
    );
  }

  effectIt.effect("preserves an unauthorized info error without leaking request headers", () =>
    Effect.gen(function* () {
      const error = yield* verifyOpenCodeServerVersion(
        makeInfoClient(() =>
          Promise.reject({
            _tag: "UnauthorizedError",
            message: "Unauthorized",
            response: { status: 401 },
            request: { headers: { authorization: "must-not-appear" } },
          }),
        ),
      ).pipe(Effect.flip);
      expect(error).toBeInstanceOf(OpenCodeRuntimeError);
      expect(error.detail).toContain("status=401");
      expect(error.detail).toContain("Unauthorized");
      expect(error.detail).not.toContain("must-not-appear");
    }),
  );

  effectIt.effect("aborts an info request when the version check times out", () =>
    Effect.gen(function* () {
      let requestSignal: AbortSignal | undefined;
      const checkFiber = yield* verifyOpenCodeServerVersion(
        makeInfoClient((options) => {
          requestSignal = options?.signal;
          return new Promise(() => undefined);
        }),
      ).pipe(Effect.flip, Effect.forkChild);

      yield* Effect.yieldNow;
      expect(requestSignal).toBeDefined();
      yield* TestClock.adjust("6 seconds");

      const error = yield* Fiber.join(checkFiber);
      expect(error.detail).toBe("Timed out while checking the OpenCode server version.");
      expect(requestSignal?.aborted).toBe(true);
    }).pipe(Effect.provide(TestClock.layer())),
  );
});

class LifecycleError extends Data.TaggedError("LifecycleError")<{ readonly cause: unknown }> {}

interface LifecycleEvent {
  readonly event: string;
  readonly pid: number;
}

const makeLifecycleControl = Effect.fn("makeLifecycleControl")(function* () {
  const events = yield* Queue.unbounded<LifecycleEvent>();
  const sockets = new Set<NodeNet.Socket>();
  const server = NodeNet.createServer((socket) => {
    sockets.add(socket);
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      buffer += chunk;
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        const parsed = JSON.parse(line) as LifecycleEvent;
        Queue.offerUnsafe(events, parsed);
      }
    });
    socket.on("close", () => {
      sockets.delete(socket);
      Queue.offerUnsafe(events, { event: "closed", pid: 0 });
    });
  });
  const port = yield* Effect.tryPromise({
    try: () =>
      new Promise<number>((resolve, reject) => {
        const onError = (error: Error) => reject(error);
        server.once("error", onError);
        server.listen(0, "127.0.0.1", () => {
          server.off("error", onError);
          const address = server.address();
          if (typeof address === "object" && address !== null) resolve(address.port);
          else reject(new Error("Lifecycle control server did not expose a TCP port."));
        });
      }),
    catch: (cause) => new LifecycleError({ cause }),
  });
  yield* Effect.addFinalizer(() =>
    Effect.callback<void, LifecycleError>((resume) => {
      for (const socket of sockets) socket.destroy();
      server.close((error) =>
        resume(error ? Effect.fail(new LifecycleError({ cause: error })) : Effect.void),
      );
    }).pipe(Effect.ignore),
  );

  const take = (event: string) =>
    Effect.gen(function* () {
      while (true) {
        const next = yield* Queue.take(events);
        if (next.event === event) return next;
      }
    });
  const collectUntilClosed = Effect.gen(function* () {
    const collected: LifecycleEvent[] = [];
    while (true) {
      const next = yield* Queue.take(events);
      collected.push(next);
      if (next.event === "closed") return collected;
    }
  });
  return { port, take, collectUntilClosed } as const;
});

const makeLifecycleFixture = Effect.fn("makeLifecycleFixture")(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const environment = yield* HostProcessEnvironment;
  const executablePath = yield* HostProcessExecutablePath;
  const platform = yield* HostProcessPlatform;
  const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-opencode-lifecycle-" });
  const isWindows = platform === "win32";
  const binaryPath = path.join(tempDir, isWindows ? "opencode.cmd" : "opencode");
  const scriptPath = path.join(tempDir, "opencode.mjs");

  yield* fs.writeFileString(
    scriptPath,
    `import { createServer } from "node:http";
import { createConnection } from "node:net";

const control = createConnection({ host: "127.0.0.1", port: Number(process.env.T3_TEST_CONTROL_PORT) });
const notify = (event, callback) => control.write(JSON.stringify({ event, pid: process.pid }) + "\\n", callback);
const port = Number(process.argv.find((arg) => arg.startsWith("--port="))?.slice(7));
const hostname = process.argv.find((arg) => arg.startsWith("--hostname="))?.slice(11) ?? "127.0.0.1";
let pendingResponse;
let terminateRequested = false;
let terminating = false;
const terminate = () => {
  if (terminating) return;
  terminating = true;
  notify("sigterm", () => process.exit(0));
};

const server = createServer((request, response) => {
  if (!request.url?.startsWith("/api/info")) {
    response.statusCode = 404;
    response.end();
    return;
  }
  pendingResponse = response;
  notify("info-request");
  response.on("finish", () => {
    pendingResponse = undefined;
  });
  response.on("close", () => {
    if (response.writableEnded) return;
    pendingResponse = undefined;
    notify("info-aborted");
    if (terminateRequested) terminate();
  });
  if (process.env.T3_TEST_INFO_MODE === "ready") {
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify({ version: "2.0.7", pid: process.pid, urls: [], paths: { tmp: "/tmp" } }));
  }
});

process.on("SIGTERM", () => {
  terminateRequested = true;
  if (!pendingResponse) terminate();
});
control.on("connect", () => {
  server.listen(port, hostname, () => {
    notify("listening");
    process.stdout.write("server listening on http://" + hostname + ":" + port + "\\n");
  });
});
`,
  );
  yield* fs.writeFileString(
    binaryPath,
    [
      ...(isWindows ? ["@echo off"] : ["#!/bin/sh"]),
      isWindows
        ? '"%T3_TEST_NODE_BINARY%" "%T3_TEST_OPENCODE_SCRIPT%" %*'
        : 'exec "$T3_TEST_NODE_BINARY" "$T3_TEST_OPENCODE_SCRIPT" "$@"',
      "",
    ].join("\n"),
  );
  if (!isWindows) yield* fs.chmod(binaryPath, 0o755);

  return { binaryPath, environment, executablePath, scriptPath, tempDir } as const;
});

const startUnrelatedSentinel = (executablePath: string) =>
  Effect.acquireRelease(
    Effect.callback<NodeChildProcess.ChildProcess, LifecycleError>((resume) => {
      const child = NodeChildProcess.spawn(
        executablePath,
        ["-e", "setInterval(() => {}, 60_000)"],
        {
          stdio: "ignore",
        },
      );
      child.once("spawn", () => resume(Effect.succeed(child)));
      child.once("error", (error) => resume(Effect.fail(new LifecycleError({ cause: error }))));
    }),
    (child) =>
      Effect.callback<void>((resume) => {
        if (child.exitCode !== null) {
          resume(Effect.void);
          return;
        }
        child.once("exit", () => resume(Effect.void));
        child.kill("SIGTERM");
      }),
  );

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (cause) {
    if (typeof cause === "object" && cause !== null && "code" in cause && cause.code === "ESRCH") {
      return false;
    }
    throw cause;
  }
}

describe("OpenCode server output", () => {
  effectIt.live(
    "aborts the pending info request and terminates only its owned process on startup timeout",
    () =>
      Effect.gen(function* () {
        const control = yield* makeLifecycleControl();
        const fixture = yield* makeLifecycleFixture();
        const sentinel = yield* startUnrelatedSentinel(fixture.executablePath);
        const runtime = yield* OpenCodeRuntime;

        const error = yield* Effect.scoped(
          runtime.startOpenCodeServerProcess({
            binaryPath: fixture.binaryPath,
            directory: fixture.tempDir,
            timeoutMs: 1_000,
            environment: {
              ...fixture.environment,
              T3_TEST_CONTROL_PORT: String(control.port),
              T3_TEST_INFO_MODE: "hang",
              T3_TEST_NODE_BINARY: fixture.executablePath,
              T3_TEST_OPENCODE_SCRIPT: fixture.scriptPath,
            },
          }),
        ).pipe(Effect.flip);
        const events = yield* control.collectUntilClosed;
        const ownedPid = events.find((event) => event.event === "listening")?.pid;

        expect(error.detail).toContain("Timed out waiting for the OpenCode v2 server API");
        expect(events.map((event) => event.event)).toContain("info-request");
        expect(events.map((event) => event.event)).toContain("info-aborted");
        expect(events.map((event) => event.event)).toContain("sigterm");
        expect(ownedPid).toBeTypeOf("number");
        expect(isProcessAlive(ownedPid!)).toBe(false);
        expect(sentinel.exitCode).toBeNull();
        expect(sentinel.killed).toBe(false);
      }).pipe(
        Effect.scoped,
        Effect.provide(OpenCodeRuntimeLive.pipe(Layer.provideMerge(NodeServices.layer))),
      ),
    10_000,
  );

  effectIt.live(
    "aborts the pending info request and terminates its process when startup is interrupted",
    () =>
      Effect.gen(function* () {
        const control = yield* makeLifecycleControl();
        const fixture = yield* makeLifecycleFixture();
        const runtime = yield* OpenCodeRuntime;
        const startFiber = yield* Effect.scoped(
          runtime.startOpenCodeServerProcess({
            binaryPath: fixture.binaryPath,
            directory: fixture.tempDir,
            timeoutMs: 10_000,
            environment: {
              ...fixture.environment,
              T3_TEST_CONTROL_PORT: String(control.port),
              T3_TEST_INFO_MODE: "hang",
              T3_TEST_NODE_BINARY: fixture.executablePath,
              T3_TEST_OPENCODE_SCRIPT: fixture.scriptPath,
            },
          }),
        ).pipe(Effect.forkChild);
        const request = yield* control.take("info-request");

        yield* Fiber.interrupt(startFiber);
        const events = yield* control.collectUntilClosed;

        expect(events.map((event) => event.event)).toContain("info-aborted");
        expect(events.map((event) => event.event)).toContain("sigterm");
        expect(isProcessAlive(request.pid)).toBe(false);
      }).pipe(
        Effect.scoped,
        Effect.provide(OpenCodeRuntimeLive.pipe(Layer.provideMerge(NodeServices.layer))),
      ),
    10_000,
  );

  effectIt.live(
    "keeps a ready process alive until its owning scope closes",
    () =>
      Effect.gen(function* () {
        const control = yield* makeLifecycleControl();
        const fixture = yield* makeLifecycleFixture();
        const runtime = yield* OpenCodeRuntime;
        const runtimeScope = yield* Scope.make();
        yield* Effect.addFinalizer(() => Scope.close(runtimeScope, Exit.void));
        const server = yield* runtime
          .startOpenCodeServerProcess({
            binaryPath: fixture.binaryPath,
            directory: fixture.tempDir,
            environment: {
              ...fixture.environment,
              T3_TEST_CONTROL_PORT: String(control.port),
              T3_TEST_INFO_MODE: "ready",
              T3_TEST_NODE_BINARY: fixture.executablePath,
              T3_TEST_OPENCODE_SCRIPT: fixture.scriptPath,
            },
          })
          .pipe(Effect.provideService(Scope.Scope, runtimeScope));
        const listening = yield* control.take("listening");

        expect(server.version).toBe("2.0.7");
        expect(yield* server.isRunning).toBe(true);
        expect(isProcessAlive(listening.pid)).toBe(true);

        yield* Scope.close(runtimeScope, Exit.void);
        const events = yield* control.collectUntilClosed;

        expect(events.map((event) => event.event)).toContain("sigterm");
        expect(isProcessAlive(listening.pid)).toBe(false);
      }).pipe(
        Effect.scoped,
        Effect.provide(OpenCodeRuntimeLive.pipe(Layer.provideMerge(NodeServices.layer))),
      ),
    10_000,
  );

  effectIt.live(
    "drains stdout and stderr after startup so server requests can finish",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const environment = yield* HostProcessEnvironment;
        const executablePath = yield* HostProcessExecutablePath;
        const platform = yield* HostProcessPlatform;
        const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-opencode-output-" });
        const isWindows = platform === "win32";
        const binaryPath = path.join(tempDir, isWindows ? "opencode.cmd" : "opencode");
        const scriptPath = path.join(tempDir, "opencode.mjs");

        yield* fs.writeFileString(
          scriptPath,
          `import { createServer } from "node:http";
const writeOutput = (stream) => new Promise((resolve, reject) => {
  stream.write("x".repeat(2 * 1024 * 1024), (error) => error ? reject(error) : resolve());
});
const port = Number(process.argv.find((arg) => arg.startsWith("--port="))?.slice(7));
const server = createServer(async (request, response) => {
  if (request.url.startsWith("/api/info")) {
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify({ version: "2.0.7", pid: process.pid, urls: [], paths: { tmp: "/tmp" } }));
    return;
  }
  await Promise.all([writeOutput(process.stdout), writeOutput(process.stderr)]);
  response.end("drained:" + process.cwd());
});
server.listen(port, "127.0.0.1", () => {
  process.stdout.write("server listening on http://127.0.0.1:" + server.address().port + "\\n");
});
`,
        );
        yield* fs.writeFileString(
          binaryPath,
          [
            ...(isWindows ? ["@echo off"] : ["#!/bin/sh"]),
            isWindows
              ? '"%T3_TEST_NODE_BINARY%" "%T3_TEST_OPENCODE_SCRIPT%" %*'
              : 'exec "$T3_TEST_NODE_BINARY" "$T3_TEST_OPENCODE_SCRIPT" "$@"',
            "",
          ].join("\n"),
        );
        if (!isWindows) {
          yield* fs.chmod(binaryPath, 0o755);
        }

        const runtime = yield* OpenCodeRuntime;
        const server = yield* runtime.startOpenCodeServerProcess({
          binaryPath,
          directory: tempDir,
          environment: {
            ...environment,
            T3_TEST_NODE_BINARY: executablePath,
            T3_TEST_OPENCODE_SCRIPT: scriptPath,
          },
        });
        const response = yield* HttpClient.get(`${server.url}/output`);
        const canonicalTempDir = yield* fs.realPath(tempDir);

        expect(yield* response.text).toBe(`drained:${canonicalTempDir}`);
        expect(yield* server.isRunning).toBe(true);
        expect(server.version).toBe("2.0.7");
      }).pipe(
        Effect.scoped,
        Effect.provide([
          OpenCodeRuntimeLive.pipe(Layer.provideMerge(NodeServices.layer)),
          FetchHttpClient.layer,
        ]),
      ),
    10_000,
  );

  effectIt.live(
    "redacts the managed password when the server exits during startup",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const environment = yield* HostProcessEnvironment;
        const executablePath = yield* HostProcessExecutablePath;
        const platform = yield* HostProcessPlatform;
        const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-opencode-exit-" });
        const isWindows = platform === "win32";
        const binaryPath = path.join(tempDir, isWindows ? "opencode.cmd" : "opencode");
        const scriptPath = path.join(tempDir, "opencode.mjs");

        yield* fs.writeFileString(
          scriptPath,
          "process.stdout.write(`failed password=${process.env.OPENCODE_SERVER_PASSWORD}\\n`); process.exit(17);\n",
        );
        yield* fs.writeFileString(
          binaryPath,
          [
            ...(isWindows ? ["@echo off"] : ["#!/bin/sh"]),
            isWindows
              ? '"%T3_TEST_NODE_BINARY%" "%T3_TEST_OPENCODE_SCRIPT%" %*'
              : 'exec "$T3_TEST_NODE_BINARY" "$T3_TEST_OPENCODE_SCRIPT" "$@"',
            "",
          ].join("\n"),
        );
        if (!isWindows) yield* fs.chmod(binaryPath, 0o755);

        const runtime = yield* OpenCodeRuntime;
        const error = yield* runtime
          .startOpenCodeServerProcess({
            binaryPath,
            directory: tempDir,
            serverPassword: "managed-test-password",
            environment: {
              ...environment,
              T3_TEST_NODE_BINARY: executablePath,
              T3_TEST_OPENCODE_SCRIPT: scriptPath,
            },
          })
          .pipe(Effect.flip);

        expect(error.detail).toContain("code: 17");
        expect(error.detail).toContain("[REDACTED_SECRET]");
        expect(error.detail).not.toContain("managed-test-password");
      }).pipe(
        Effect.scoped,
        Effect.provide(OpenCodeRuntimeLive.pipe(Layer.provideMerge(NodeServices.layer))),
      ),
    10_000,
  );
});

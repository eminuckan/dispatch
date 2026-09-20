import * as NodeCrypto from "node:crypto";
import * as NodeURL from "node:url";

import type { ChatAttachment, ProviderApprovalDecision, RuntimeMode } from "@dispatch/contracts";
import {
  type AgentInfo,
  type CommandInfo,
  type ModelInfo,
  OpenCode,
  type OpenCodeClient,
  type PermissionRuleset,
  type ProviderInfo,
  type SessionPromptInput,
  type SkillInfo,
} from "@opencode/client";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as P from "effect/Predicate";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import * as Scope from "effect/Scope";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import { isWindowsCommandNotFound } from "../processRunner.ts";
import { collectStreamAsString } from "./providerSnapshot.ts";
import * as NetService from "@dispatch/shared/Net";
import { HostProcessPlatform } from "@dispatch/shared/hostProcess";
import { compareSemverVersions, parseSemver } from "@dispatch/shared/semver";
import { resolveSpawnCommand } from "@dispatch/shared/shell";
const encodeUnknownJsonStringExit = Schema.encodeUnknownExit(Schema.fromJsonString(Schema.Unknown));

export const MINIMUM_OPENCODE_VERSION = "2.0.0";
export const MAXIMUM_OPENCODE_VERSION_EXCLUSIVE = "3.0.0";
export const SUPPORTED_OPENCODE_VERSION_RANGE = `>=${MINIMUM_OPENCODE_VERSION} <${MAXIMUM_OPENCODE_VERSION_EXCLUSIVE}`;
const OPENCODE_HEALTH_TIMEOUT = "5 seconds";
const OPENCODE_SERVER_RETRY_INTERVAL = "25 millis";

const OpenCodeServerInfoSchema = Schema.Struct({
  version: Schema.String,
});
const decodeOpenCodeServerInfo = Schema.decodeUnknownEffect(OpenCodeServerInfoSchema);

export function resolveOpenCodeConfigContent(
  inputEnvironment: Readonly<Record<string, string | undefined>> | undefined,
  inheritedEnvironment: Readonly<Record<string, string | undefined>> = process.env,
): string | undefined {
  return inputEnvironment?.OPENCODE_CONFIG_CONTENT ?? inheritedEnvironment.OPENCODE_CONFIG_CONTENT;
}

export function resolveOpenCodeServerPassword(
  input: {
    readonly external: boolean;
    readonly serverPassword?: string;
    readonly environment?: Readonly<Record<string, string | undefined>>;
  },
  inheritedEnvironment: Readonly<Record<string, string | undefined>> = process.env,
): string | undefined {
  if (input.serverPassword !== undefined) {
    return input.serverPassword;
  }
  if (input.external) {
    return undefined;
  }
  return input.environment === undefined
    ? inheritedEnvironment.OPENCODE_SERVER_PASSWORD
    : input.environment.OPENCODE_SERVER_PASSWORD;
}

const DEFAULT_OPENCODE_SERVER_TIMEOUT_MS = 30_000;
const DEFAULT_HOSTNAME = "127.0.0.1";
const OPENCODE_SERVER_STARTUP_MAX_OUTPUT_CHARS = 64 * 1024;
export interface OpenCodeServerProcess {
  readonly url: string;
  readonly serverPassword?: string;
  readonly version: string;
  readonly isRunning: Effect.Effect<boolean>;
  readonly exitCode: Effect.Effect<number, never>;
}

export interface OpenCodeServerConnection {
  readonly url: string;
  readonly serverPassword?: string;
  readonly version: string;
  readonly exitCode: Effect.Effect<number, never> | null;
  readonly external: boolean;
}

const OPENCODE_RUNTIME_ERROR_TAG = "OpenCodeRuntimeError";
export class OpenCodeRuntimeError extends Data.TaggedError(OPENCODE_RUNTIME_ERROR_TAG)<{
  readonly operation: string;
  readonly cause?: unknown;
  readonly detail: string;
}> {
  static readonly is = (u: unknown): u is OpenCodeRuntimeError =>
    P.isTagged(u, OPENCODE_RUNTIME_ERROR_TAG);
}

function encodeJsonStringForDiagnostics(input: unknown): string | undefined {
  const result = encodeUnknownJsonStringExit(input);
  return Exit.isSuccess(result) ? result.value : undefined;
}

export function openCodeRuntimeErrorDetail(cause: unknown): string {
  if (OpenCodeRuntimeError.is(cause)) return cause.detail;
  if (cause instanceof Error && cause.message.trim().length > 0) return cause.message.trim();
  if (typeof cause === "object" && cause !== null) {
    // Client failures may retain the Request object, including Authorization.
    // Extract only known-safe scalar diagnostics and never serialize the whole failure.
    const record = cause as Record<string, unknown>;
    const response =
      typeof record.response === "object" && record.response !== null
        ? (record.response as Record<string, unknown>)
        : undefined;
    const status = typeof response?.status === "number" ? response.status : undefined;
    const tag = typeof record._tag === "string" ? record._tag : undefined;
    const nestedError =
      typeof record.error === "object" && record.error !== null
        ? (record.error as Record<string, unknown>)
        : undefined;
    const message =
      (typeof record.message === "string" ? record.message : undefined) ??
      (typeof nestedError?.message === "string" ? nestedError.message : undefined);
    const detail = [tag, message].filter((value) => value && value.trim().length > 0).join(": ");
    if (status !== undefined) return detail ? `${detail} (status=${status})` : `status=${status}`;
    if (detail) return detail;
  }
  return encodeJsonStringForDiagnostics(cause) ?? String(cause);
}

export const runOpenCodeSdk = <A>(
  operation: string,
  fn: (signal: AbortSignal) => Promise<A>,
): Effect.Effect<A, OpenCodeRuntimeError> =>
  Effect.tryPromise({
    try: fn,
    catch: (cause) =>
      new OpenCodeRuntimeError({ operation, detail: openCodeRuntimeErrorDetail(cause), cause }),
  }).pipe(Effect.withSpan(`opencode.${operation}`));

const validateOpenCodeServerVersion = Effect.fn("validateOpenCodeServerVersion")(function* (
  value: unknown,
) {
  const info = yield* decodeOpenCodeServerInfo(value).pipe(
    Effect.mapError(
      (cause) =>
        new OpenCodeRuntimeError({
          operation: "server.info",
          detail: `OpenCode server returned an invalid info response. Dispatch supports OpenCode ${SUPPORTED_OPENCODE_VERSION_RANGE}.`,
          cause,
        }),
    ),
  );
  if (parseSemver(info.version) === null) {
    return yield* new OpenCodeRuntimeError({
      operation: "server.info",
      detail: `OpenCode server returned an invalid version. Dispatch supports OpenCode ${SUPPORTED_OPENCODE_VERSION_RANGE}.`,
    });
  }
  if (compareSemverVersions(info.version, MINIMUM_OPENCODE_VERSION) < 0) {
    return yield* new OpenCodeRuntimeError({
      operation: "server.info",
      detail: `OpenCode v${info.version} is too old. Dispatch supports OpenCode ${SUPPORTED_OPENCODE_VERSION_RANGE}.`,
    });
  }
  if (compareSemverVersions(info.version, MAXIMUM_OPENCODE_VERSION_EXCLUSIVE) >= 0) {
    return yield* new OpenCodeRuntimeError({
      operation: "server.info",
      detail: `OpenCode v${info.version} is newer than the supported v2 API. Dispatch supports OpenCode ${SUPPORTED_OPENCODE_VERSION_RANGE}.`,
    });
  }
  return info.version;
});

export const verifyOpenCodeServerVersion = Effect.fn("verifyOpenCodeServerVersion")(function* (
  client: OpenCodeClient,
) {
  const infoOption = yield* runOpenCodeSdk("server.info", (signal) =>
    client.server.info({ signal }),
  ).pipe(Effect.timeoutOption(OPENCODE_HEALTH_TIMEOUT));
  if (Option.isNone(infoOption)) {
    return yield* new OpenCodeRuntimeError({
      operation: "server.info",
      detail: "Timed out while checking the OpenCode server version.",
    });
  }

  return yield* validateOpenCodeServerVersion(infoOption.value);
});

export interface OpenCodeCommandResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly code: number;
}

export interface OpenCodeInventory {
  readonly providers: ReadonlyArray<Pick<ProviderInfo, "id" | "name" | "activation">>;
  readonly models: ReadonlyArray<
    Pick<ModelInfo, "id" | "providerID" | "name" | "enabled" | "variants">
  >;
  readonly agents: ReadonlyArray<Pick<AgentInfo, "id" | "name" | "mode" | "hidden">>;
  readonly skills: ReadonlyArray<OpenCodeSkill>;
  readonly commands?: ReadonlyArray<OpenCodeSlashCommand>;
}

export type OpenCodeSlashCommand = Pick<CommandInfo, "name" | "description">;

/** Command templates stay in OpenCode, which expands arguments and runs MCP prompts. */
export const loadOpenCodeCommands = (client: OpenCodeClient, directory: string) =>
  runOpenCodeSdk("command.list", (signal) =>
    client.command.list({ location: { directory } }, { signal }),
  ).pipe(
    Effect.map((result): ReadonlyArray<OpenCodeSlashCommand> =>
      result.data.map(({ name, description }) => ({
        name,
        ...(description === undefined ? {} : { description }),
      })),
    ),
  );

export interface ParsedOpenCodeModelSlug {
  readonly providerID: string;
  readonly modelID: string;
}

export interface OpenCodeSkill {
  readonly id: string;
  readonly name: string;
  readonly description?: string;
  readonly path: string;
}

export interface OpenCodeRuntimeShape {
  /**
   * Spawns a local OpenCode server process. Its lifetime is bound to the caller's
   * `Scope.Scope` — the child is killed automatically when that scope closes.
   * Consumers that want a long-lived server must create and hold a scope explicitly
   * (see {@link Scope.make}) and close it when done.
   */
  readonly startOpenCodeServerProcess: (input: {
    readonly binaryPath: string;
    readonly directory: string;
    readonly serverPassword?: string;
    readonly environment?: NodeJS.ProcessEnv;
    readonly port?: number;
    readonly hostname?: string;
    readonly timeoutMs?: number;
  }) => Effect.Effect<OpenCodeServerProcess, OpenCodeRuntimeError, Scope.Scope>;
  /**
   * Returns a handle to either an externally-managed OpenCode server (when
   * `serverUrl` is provided — no lifetime is attached to the caller's scope) or a
   * freshly spawned local server whose lifetime is bound to the caller's scope.
   */
  readonly connectToOpenCodeServer: (input: {
    readonly binaryPath: string;
    readonly directory: string;
    readonly serverUrl?: string | null;
    readonly serverPassword?: string;
    readonly environment?: NodeJS.ProcessEnv;
    readonly port?: number;
    readonly hostname?: string;
    readonly timeoutMs?: number;
  }) => Effect.Effect<OpenCodeServerConnection, OpenCodeRuntimeError, Scope.Scope>;
  readonly runOpenCodeCommand: (input: {
    readonly binaryPath: string;
    readonly args: ReadonlyArray<string>;
    readonly environment?: NodeJS.ProcessEnv;
    readonly cwd?: string;
    readonly maxOutputBytes?: number;
  }) => Effect.Effect<OpenCodeCommandResult, OpenCodeRuntimeError>;
  readonly createOpenCodeSdkClient: (input: {
    readonly baseUrl: string;
    readonly serverPassword?: string;
  }) => OpenCodeClient;
  readonly loadOpenCodeInventory: (
    client: OpenCodeClient,
    directory: string,
  ) => Effect.Effect<OpenCodeInventory, OpenCodeRuntimeError>;
  readonly loadOpenCodeSkills: (
    client: OpenCodeClient,
    directory: string,
  ) => Effect.Effect<ReadonlyArray<OpenCodeSkill>, OpenCodeRuntimeError>;
}

export function parseOpenCodeModelSlug(
  slug: string | null | undefined,
): ParsedOpenCodeModelSlug | null {
  if (typeof slug !== "string") {
    return null;
  }

  const trimmed = slug.trim();
  const separator = trimmed.indexOf("/");
  if (separator <= 0 || separator === trimmed.length - 1) {
    return null;
  }

  return {
    providerID: trimmed.slice(0, separator),
    modelID: trimmed.slice(separator + 1),
  };
}

export function openCodeQuestionId(index: number, question: { readonly header: string }): string {
  const header = question.header
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-");
  return header.length > 0 ? `question-${index}-${header}` : `question-${index}`;
}

/**
 * Attachments OpenCode can hand to a model as a native file part. Anything
 * else (ZIP, binaries, image formats like BMP/AVIF/SVG that model APIs
 * reject, or files over the direct-attachment size limit) would make the turn
 * fail before it starts, so those ride only as the file path ProviderService
 * puts in the prompt.
 */
const OPENCODE_NATIVE_IMAGE_MIMES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
const OPENCODE_NATIVE_FILE_PART_MAX_BYTES = 20 * 1024 * 1024;

function isOpenCodeNativeFilePart(input: {
  readonly mimeType: string;
  readonly sizeBytes: number;
}): boolean {
  if (input.sizeBytes > OPENCODE_NATIVE_FILE_PART_MAX_BYTES) {
    return false;
  }
  const normalized = input.mimeType.trim().toLowerCase();
  return (
    OPENCODE_NATIVE_IMAGE_MIMES.has(normalized) ||
    normalized.startsWith("text/") ||
    normalized === "application/pdf"
  );
}

export function toOpenCodeFileParts(input: {
  readonly attachments: ReadonlyArray<ChatAttachment> | undefined;
  readonly resolveAttachmentPath: (attachment: ChatAttachment) => string | null;
}): NonNullable<SessionPromptInput["files"]> {
  const parts: Array<NonNullable<SessionPromptInput["files"]>[number]> = [];

  for (const attachment of input.attachments ?? []) {
    if (
      attachment.type === "file" &&
      "source" in attachment &&
      attachment.source?._tag === "pasted-text"
    ) {
      continue;
    }
    if (!isOpenCodeNativeFilePart(attachment)) {
      continue;
    }
    const attachmentPath = input.resolveAttachmentPath(attachment);
    if (!attachmentPath) {
      continue;
    }

    parts.push({
      uri: NodeURL.pathToFileURL(attachmentPath).href,
      name: attachment.name,
    });
  }

  return parts;
}

export function buildOpenCodePermissionRules(
  runtimeMode: RuntimeMode,
  managedTeam = false,
): PermissionRuleset {
  if (managedTeam)
    return [
      ...buildOpenCodePermissionRules(runtimeMode),
      { action: "subagent", resource: "*", effect: "deny" },
    ];
  if (runtimeMode === "full-access") {
    return [
      { action: "*", resource: "*", effect: "allow" },
      { action: "external_directory", resource: "*", effect: "allow" },
    ];
  }

  // "Auto-accept edits" is documented as "auto-approve edits, ask before other
  // actions", so prompting for every edit ignores the mode the user picked.
  // "auto" is left asking on purpose: the docs say providers without an AI
  // reviewer, OpenCode among them, fall back to Supervised for that mode.
  const editAction = runtimeMode === "auto-accept-edits" ? "allow" : "ask";

  // Session rules override OpenCode's agent defaults. Allow reads and task
  // updates, but keep its default approval rules for environment files.
  return [
    { action: "*", resource: "*", effect: "ask" },
    { action: "read", resource: "*", effect: "allow" },
    { action: "read", resource: "*.env", effect: "ask" },
    { action: "read", resource: "*.env.*", effect: "ask" },
    { action: "read", resource: "*.env.example", effect: "allow" },
    { action: "glob", resource: "*", effect: "allow" },
    { action: "grep", resource: "*", effect: "allow" },
    { action: "lsp", resource: "*", effect: "allow" },
    { action: "skill", resource: "*", effect: "allow" },
    { action: "todowrite", resource: "*", effect: "allow" },
    { action: "shell", resource: "*", effect: "ask" },
    { action: "edit", resource: "*", effect: editAction },
    { action: "webfetch", resource: "*", effect: "ask" },
    { action: "websearch", resource: "*", effect: "ask" },
    { action: "codesearch", resource: "*", effect: "ask" },
    { action: "external_directory", resource: "*", effect: "ask" },
    { action: "doom_loop", resource: "*", effect: "ask" },
    { action: "question", resource: "*", effect: "allow" },
  ];
}

export function toOpenCodePermissionReply(
  decision: ProviderApprovalDecision,
): "once" | "always" | "reject" {
  switch (decision) {
    case "accept":
      return "once";
    case "acceptForSession":
    case "acceptAlways":
      return "always";
    case "decline":
    case "cancel":
    default:
      return "reject";
  }
}

export function toOpenCodeQuestionAnswers(
  request: {
    readonly questions: ReadonlyArray<{
      readonly header: string;
      readonly question: string;
    }>;
  },
  answers: Record<string, unknown>,
): Array<Array<string>> {
  return request.questions.map((question, index) => {
    const raw =
      answers[openCodeQuestionId(index, question)] ??
      answers[question.header] ??
      answers[question.question];
    if (Array.isArray(raw)) {
      return raw.filter((value): value is string => typeof value === "string");
    }
    if (typeof raw === "string") {
      return raw.trim().length > 0 ? [raw] : [];
    }
    return [];
  });
}

function ensureRuntimeError(
  operation: OpenCodeRuntimeError["operation"],
  detail: string,
  cause: unknown,
): OpenCodeRuntimeError {
  return OpenCodeRuntimeError.is(cause)
    ? cause
    : new OpenCodeRuntimeError({ operation, detail, cause });
}

const makeOpenCodeRuntime = Effect.gen(function* () {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const netService = yield* NetService.NetService;
  const hostPlatform = yield* HostProcessPlatform;
  const resolveCommand = (command: string, args: ReadonlyArray<string>, env?: NodeJS.ProcessEnv) =>
    resolveSpawnCommand(command, args, env ? { env } : {});

  const runOpenCodeCommand: OpenCodeRuntimeShape["runOpenCodeCommand"] = (input) =>
    Effect.gen(function* () {
      const spawnCommand = yield* resolveCommand(input.binaryPath, input.args, input.environment);
      const child = yield* spawner.spawn(
        ChildProcess.make(spawnCommand.command, spawnCommand.args, {
          detached: hostPlatform !== "win32",
          shell: spawnCommand.shell,
          ...(input.cwd ? { cwd: input.cwd } : {}),
          ...(input.environment ? { env: input.environment } : { extendEnv: true }),
        }),
      );
      const terminateCommandGroup =
        hostPlatform === "win32"
          ? child.kill({ killSignal: "SIGKILL" }).pipe(Effect.asVoid)
          : Effect.sync(() => {
              try {
                process.kill(-Number(child.pid), "SIGKILL");
              } catch {
                // The command and its process group may already have exited.
              }
            });
      yield* Effect.addFinalizer(() => terminateCommandGroup.pipe(Effect.ignore));
      const collectOptions =
        input.maxOutputBytes === undefined ? undefined : { maxBytes: input.maxOutputBytes };
      const [stdout, stderr, code] = yield* Effect.all(
        [
          collectStreamAsString(child.stdout, collectOptions),
          collectStreamAsString(child.stderr, collectOptions),
          child.exitCode,
        ],
        { concurrency: "unbounded" },
      );
      const exitCode = Number(code);
      if (yield* isWindowsCommandNotFound(exitCode, stderr)) {
        return yield* new OpenCodeRuntimeError({
          operation: "runOpenCodeCommand",
          detail: `spawn ${input.binaryPath} ENOENT`,
        });
      }
      return {
        stdout,
        stderr,
        code: exitCode,
      } satisfies OpenCodeCommandResult;
    }).pipe(
      Effect.scoped,
      Effect.mapError((cause) =>
        ensureRuntimeError(
          "runOpenCodeCommand",
          `Failed to execute '${input.binaryPath} ${input.args.join(" ")}': ${openCodeRuntimeErrorDetail(cause)}`,
          cause,
        ),
      ),
    );

  const createOpenCodeSdkClient: OpenCodeRuntimeShape["createOpenCodeSdkClient"] = (input) =>
    OpenCode.make({
      baseUrl: input.baseUrl,
      ...(input.serverPassword
        ? {
            headers: {
              authorization: `Basic ${Buffer.from(`opencode:${input.serverPassword}`, "utf8").toString("base64")}`,
            },
          }
        : {}),
    });

  const startOpenCodeServerProcess: OpenCodeRuntimeShape["startOpenCodeServerProcess"] = (input) =>
    Effect.gen(function* () {
      // Bind this server's lifetime to the caller's scope. When the caller's
      // scope closes, the spawned child is killed and all associated fibers
      // are interrupted automatically — no `close()` method needed.
      const runtimeScope = yield* Scope.Scope;

      const hostname = input.hostname ?? DEFAULT_HOSTNAME;
      const port =
        input.port !== undefined && input.port > 0
          ? input.port
          : yield* netService.findAvailablePort(0).pipe(
              Effect.mapError(
                (cause) =>
                  new OpenCodeRuntimeError({
                    operation: "startOpenCodeServerProcess",
                    detail: `Failed to find available port: ${openCodeRuntimeErrorDetail(cause)}`,
                    cause,
                  }),
              ),
            );
      const timeoutMs = input.timeoutMs ?? DEFAULT_OPENCODE_SERVER_TIMEOUT_MS;
      const args = ["serve", `--hostname=${hostname}`, `--port=${port}`];
      const spawnCommand = yield* resolveCommand(input.binaryPath, args, input.environment);
      const serverPassword =
        resolveOpenCodeServerPassword({
          external: false,
          ...(input.serverPassword !== undefined ? { serverPassword: input.serverPassword } : {}),
          ...(input.environment !== undefined ? { environment: input.environment } : {}),
        }) ?? NodeCrypto.randomBytes(32).toString("base64url");
      const configContent = resolveOpenCodeConfigContent(input.environment);
      const urlHostname = hostname.includes(":") ? `[${hostname}]` : hostname;
      const url = `http://${urlHostname}:${port}`;

      const child = yield* spawner
        .spawn(
          ChildProcess.make(spawnCommand.command, spawnCommand.args, {
            detached: hostPlatform !== "win32",
            shell: spawnCommand.shell,
            cwd: input.directory,
            env: {
              ...input.environment,
              OPENCODE_SERVER_PASSWORD: serverPassword,
              ...(configContent === undefined ? {} : { OPENCODE_CONFIG_CONTENT: configContent }),
            },
            extendEnv: input.environment === undefined,
          }),
        )
        .pipe(
          Effect.provideService(Scope.Scope, runtimeScope),
          Effect.mapError(
            (cause) =>
              new OpenCodeRuntimeError({
                operation: "startOpenCodeServerProcess",
                detail: `Failed to spawn OpenCode server process: ${openCodeRuntimeErrorDetail(cause)}`,
                cause,
              }),
          ),
        );

      const killOpenCodeProcessGroup = (signal: NodeJS.Signals) =>
        hostPlatform === "win32"
          ? child.kill({ killSignal: signal, forceKillAfter: "1 second" }).pipe(Effect.asVoid)
          : Effect.sync(() => {
              try {
                process.kill(-Number(child.pid), signal);
              } catch {
                // The direct child may already have exited after starting the
                // server; the process group kill is best-effort cleanup for
                // any serve process left in that group.
              }
            });
      const terminateChild = killOpenCodeProcessGroup("SIGTERM").pipe(
        Effect.andThen(Effect.sleep("1 second")),
        Effect.andThen(killOpenCodeProcessGroup("SIGKILL")),
        Effect.ignore,
      );
      yield* Scope.addFinalizer(runtimeScope, terminateChild);

      const stdoutRef = yield* Ref.make<string | null>("");
      const stderrRef = yield* Ref.make<string | null>("");
      yield* child.stdout.pipe(
        Stream.decodeText(),
        Stream.runForEach((chunk) =>
          Ref.update(stdoutRef, (stdout) =>
            stdout === null
              ? null
              : `${stdout}${chunk}`.slice(-OPENCODE_SERVER_STARTUP_MAX_OUTPUT_CHARS),
          ),
        ),
        Effect.ignore,
        Effect.forkIn(runtimeScope),
      );
      yield* child.stderr.pipe(
        Stream.decodeText(),
        Stream.runForEach((chunk) =>
          Ref.update(stderrRef, (stderr) =>
            stderr === null
              ? null
              : `${stderr}${chunk}`.slice(-OPENCODE_SERVER_STARTUP_MAX_OUTPUT_CHARS),
          ),
        ),
        Effect.ignore,
        Effect.forkIn(runtimeScope),
      );

      const serverExited = child.exitCode.pipe(
        Effect.flatMap((code) =>
          Effect.gen(function* () {
            const redact = (value: string) => value.replaceAll(serverPassword, "[REDACTED_SECRET]");
            const stdout = redact((yield* Ref.get(stdoutRef)) ?? "");
            const stderr = redact((yield* Ref.get(stderrRef)) ?? "");
            const exitCode = Number(code);
            return yield* new OpenCodeRuntimeError({
              operation: "startOpenCodeServerProcess",
              detail: [
                `OpenCode server exited before startup completed (code: ${String(exitCode)}).`,
                stdout.trim() ? `stdout:\n${stdout.trim()}` : null,
                stderr.trim() ? `stderr:\n${stderr.trim()}` : null,
              ]
                .filter(Boolean)
                .join("\n\n"),
              cause: { exitCode },
            });
          }),
        ),
      );

      const client = createOpenCodeSdkClient({ baseUrl: url, serverPassword });
      const readyExit = yield* Effect.exit(
        runOpenCodeSdk("server.info", (signal) => client.server.info({ signal })).pipe(
          Effect.retry(Schedule.spaced(OPENCODE_SERVER_RETRY_INTERVAL)),
          Effect.raceFirst(serverExited),
          Effect.timeoutOption(timeoutMs),
        ),
      );

      if (Exit.isFailure(readyExit)) {
        const squashed = Cause.squash(readyExit.cause);
        return yield* ensureRuntimeError(
          "startOpenCodeServerProcess",
          `Failed while waiting for OpenCode server startup: ${openCodeRuntimeErrorDetail(squashed)}`,
          squashed,
        );
      }

      const readyOption = readyExit.value;
      if (Option.isNone(readyOption)) {
        return yield* new OpenCodeRuntimeError({
          operation: "startOpenCodeServerProcess",
          detail: `Timed out waiting for the OpenCode v2 server API after ${timeoutMs}ms.`,
        });
      }

      // Keep draining both pipes until the process scope closes. Stopping the
      // readers can block OpenCode when its output buffers fill. Startup output
      // is no longer needed, so discard later output instead of retaining it.
      yield* Ref.set(stdoutRef, null);
      yield* Ref.set(stderrRef, null);

      const version = yield* validateOpenCodeServerVersion(readyOption.value);

      return {
        url,
        serverPassword,
        version,
        isRunning: child.isRunning.pipe(Effect.orElseSucceed(() => false)),
        exitCode: child.exitCode.pipe(
          Effect.map(Number),
          Effect.orElseSucceed(() => 0),
        ),
      } satisfies OpenCodeServerProcess;
    });

  const connectToOpenCodeServer: OpenCodeRuntimeShape["connectToOpenCodeServer"] = (input) => {
    const serverUrl = input.serverUrl?.trim();
    if (serverUrl) {
      const serverPassword = resolveOpenCodeServerPassword({
        external: true,
        ...(input.serverPassword !== undefined ? { serverPassword: input.serverPassword } : {}),
      });
      return verifyOpenCodeServerVersion(
        createOpenCodeSdkClient({
          baseUrl: serverUrl,
          ...(serverPassword !== undefined ? { serverPassword } : {}),
        }),
      ).pipe(
        Effect.map((version) => ({
          url: serverUrl,
          ...(serverPassword !== undefined ? { serverPassword } : {}),
          version,
          exitCode: null,
          external: true,
        })),
      );
    }

    return startOpenCodeServerProcess({
      binaryPath: input.binaryPath,
      directory: input.directory,
      ...(input.serverPassword !== undefined ? { serverPassword: input.serverPassword } : {}),
      ...(input.environment !== undefined ? { environment: input.environment } : {}),
      ...(input.port !== undefined ? { port: input.port } : {}),
      ...(input.hostname !== undefined ? { hostname: input.hostname } : {}),
      ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
    }).pipe(
      Effect.map((server) => ({
        url: server.url,
        ...(server.serverPassword !== undefined ? { serverPassword: server.serverPassword } : {}),
        version: server.version,
        exitCode: server.exitCode,
        external: false,
      })),
    );
  };

  const locationInput = (directory: string) => ({ location: { directory } });

  const loadProviders = (client: OpenCodeClient, directory: string) =>
    runOpenCodeSdk("provider.list", (signal) =>
      client.provider.list(locationInput(directory), { signal }),
    ).pipe(
      Effect.map((result) =>
        result.data.map(({ id, name, activation }) => ({ id, name, activation })),
      ),
    );

  const loadModels = (client: OpenCodeClient, directory: string) =>
    runOpenCodeSdk("model.list", (signal) =>
      client.model.list(locationInput(directory), { signal }),
    ).pipe(
      Effect.map((result) =>
        result.data.map(({ id, providerID, name, enabled, variants }) => ({
          id,
          providerID,
          name,
          enabled,
          variants: variants.map(({ id: variantID }) => ({ id: variantID })),
        })),
      ),
    );

  const loadAgents = (client: OpenCodeClient, directory: string) =>
    runOpenCodeSdk("agent.list", (signal) =>
      client.agent.list(locationInput(directory), { signal }),
    ).pipe(
      Effect.map((result) =>
        result.data.map(({ id, name, mode, hidden }) => ({ id, name, mode, hidden })),
      ),
    );

  const loadOpenCodeSkills: OpenCodeRuntimeShape["loadOpenCodeSkills"] = (client, directory) =>
    runOpenCodeSdk("skill.list", (signal) =>
      client.skill.list(locationInput(directory), { signal }),
    ).pipe(
      Effect.map((result) =>
        result.data.map(({ id, name, description, path }: SkillInfo) => ({
          id,
          name,
          ...(description === undefined ? {} : { description }),
          path,
        })),
      ),
    );

  const loadOpenCodeInventory: OpenCodeRuntimeShape["loadOpenCodeInventory"] = (
    client,
    directory,
  ) =>
    runOpenCodeSdk("integration.list", (signal) =>
      client.integration.list(locationInput(directory), { signal }),
    ).pipe(
      Effect.andThen(
        Effect.all(
          [
            loadProviders(client, directory),
            loadModels(client, directory),
            loadAgents(client, directory),
            loadOpenCodeSkills(client, directory),
            loadOpenCodeCommands(client, directory),
          ],
          { concurrency: "unbounded" },
        ),
      ),
      Effect.map(([providers, models, agents, skills, commands]) => ({
        providers,
        models,
        agents,
        skills,
        commands,
      })),
    );

  return {
    startOpenCodeServerProcess,
    connectToOpenCodeServer,
    runOpenCodeCommand,
    createOpenCodeSdkClient,
    loadOpenCodeInventory,
    loadOpenCodeSkills,
  } satisfies OpenCodeRuntimeShape;
});

export class OpenCodeRuntime extends Context.Service<OpenCodeRuntime, OpenCodeRuntimeShape>()(
  "dispatch/provider/opencodeRuntime",
) {}

export const OpenCodeRuntimeLive = Layer.effect(OpenCodeRuntime, makeOpenCodeRuntime).pipe(
  Layer.provide(NetService.layer),
);

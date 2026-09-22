import * as NodeOS from "node:os";
import {
  AuthAccessWriteScope,
  DispatchConnectBaseUrl,
  DispatchConnectEnvironmentConfigureInput,
  EnvironmentHttpApi,
} from "@dispatch/contracts";
import * as Console from "effect/Console";
import * as Crypto from "effect/Crypto";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as References from "effect/References";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { Command, Flag, GlobalFlag, Prompt } from "effect/unstable/cli";
import {
  FetchHttpClient,
  HttpClient,
  HttpClientRequest,
  HttpClientResponse,
} from "effect/unstable/http";
import * as HttpApiClient from "effect/unstable/httpapi/HttpApiClient";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import {
  DISPATCH_CONNECT_ENVIRONMENT_CONFIG_SECRET,
  DISPATCH_CONNECT_ENVIRONMENT_CREDENTIAL_SECRET,
  DISPATCH_CONNECT_MANAGED_ENDPOINT_CONFIG_SECRET,
} from "../auth/DispatchConnectEnvironment.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as BootService from "../cloud/bootService.ts";
import { getOrCreateEnvironmentKeyPairFromSecretStore } from "../cloud/environmentKeys.ts";
import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import { readPersistedServerRuntimeState } from "../serverRuntimeState.ts";
import { projectLocationFlags, resolveCliAuthConfig } from "./config.ts";
import { resolveCliCommand } from "./invocation.ts";
import {
  bootServiceLayer,
  offerServiceDuringOnboarding,
  recoverServiceOnboardingOffer,
} from "./service.ts";

const jsonFlag = Flag.Boolean("json").pipe(
  Flag.withDescription("Emit JSON instead of human-readable output."),
  Flag.withDefault(false),
);

function bytesToString(value: Uint8Array): string {
  return new TextDecoder().decode(value);
}

function stringToBytes(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

const DISPATCH_CONNECT_CLI_ACCOUNT_SECRET = "dispatch-connect-cli-account";
const DISPATCH_CONNECT_CLI_CLIENT_ID = "dispatch-cli";
const DEVICE_CODE_GRANT_TYPE = "urn:ietf:params:oauth:grant-type:device_code";

const DispatchConnectCliAccount = Schema.Struct({
  baseUrl: DispatchConnectBaseUrl,
  token: Schema.NonEmptyString,
});
type DispatchConnectCliAccount = typeof DispatchConnectCliAccount.Type;
const DispatchConnectCliAccountJson = Schema.fromJsonString(DispatchConnectCliAccount);
const decodeDispatchConnectCliAccount = Schema.decodeUnknownEffect(DispatchConnectCliAccountJson);
const encodeDispatchConnectCliAccount = Schema.encodeEffect(DispatchConnectCliAccountJson);

class DispatchConnectCliError extends Schema.TaggedError<DispatchConnectCliError>()(
  "DispatchConnectCliError",
  { message: Schema.String },
) {}

const PersistedDispatchConnectEnvironmentConfig = Schema.Struct({
  version: Schema.Literal(1),
  baseUrl: DispatchConnectEnvironmentConfigureInput.fields.baseUrl,
  environmentId: DispatchConnectEnvironmentConfigureInput.fields.environmentId,
});
type PersistedDispatchConnectEnvironmentConfig =
  typeof PersistedDispatchConnectEnvironmentConfig.Type;
const PersistedDispatchConnectEnvironmentConfigJson = Schema.fromJsonString(
  PersistedDispatchConnectEnvironmentConfig,
);
const decodePersistedDispatchConnectEnvironmentConfig = Schema.decodeUnknownEffect(
  PersistedDispatchConnectEnvironmentConfigJson,
);
const encodePersistedDispatchConnectEnvironmentConfig = Schema.encodeEffect(
  PersistedDispatchConnectEnvironmentConfigJson,
);

const DispatchConnectDeviceCodeResponse = Schema.Struct({
  device_code: Schema.NonEmptyString,
  user_code: Schema.NonEmptyString,
  verification_uri: Schema.NonEmptyString,
  verification_uri_complete: Schema.NonEmptyString,
  expires_in: Schema.Number,
  interval: Schema.Number,
});

const DispatchConnectDeviceTokenResponse = Schema.Struct({
  access_token: Schema.NonEmptyString,
  token_type: Schema.Literal("Bearer"),
  expires_in: Schema.Number,
  scope: Schema.String,
});

const DispatchConnectDeviceTokenError = Schema.Struct({
  error: Schema.Literals([
    "authorization_pending",
    "slow_down",
    "expired_token",
    "access_denied",
    "invalid_request",
    "invalid_grant",
  ]),
  error_description: Schema.String,
});

const DispatchConnectEnvironmentSummary = Schema.Struct({
  id: Schema.NonEmptyString,
  label: Schema.NonEmptyString,
  publicKey: Schema.NonEmptyString,
});
type DispatchConnectEnvironmentSummary = typeof DispatchConnectEnvironmentSummary.Type;

const DispatchConnectEnvironmentListResponse = Schema.Struct({
  environments: Schema.Array(DispatchConnectEnvironmentSummary),
});
const DispatchConnectEnvironmentCreateResponse = Schema.Struct({
  environment: DispatchConnectEnvironmentSummary,
  credential: DispatchConnectEnvironmentConfigureInput.fields.credential,
});
const DispatchConnectEnvironmentCredentialResponse = Schema.Struct({
  credential: DispatchConnectEnvironmentConfigureInput.fields.credential,
});

function normalizeDispatchConnectCliUrl(value: string): string | null {
  try {
    const parsed = new URL(value.trim());
    const loopback =
      parsed.protocol === "http:" &&
      (parsed.hostname === "localhost" ||
        parsed.hostname === "127.0.0.1" ||
        parsed.hostname === "[::1]");
    if (
      (parsed.protocol !== "https:" && !loopback) ||
      parsed.username ||
      parsed.password ||
      parsed.pathname !== "/" ||
      parsed.search ||
      parsed.hash
    ) {
      return null;
    }
    return parsed.origin;
  } catch {
    return null;
  }
}

export function resolveDispatchConnectCliUrl(
  env: Readonly<Record<string, string | undefined>> = process.env,
): string | null {
  const candidate = env.DISPATCH_CONNECT_URL?.trim() || env.T3CODE_CONNECT_URL?.trim() || "";
  return candidate ? normalizeDispatchConnectCliUrl(candidate) : null;
}

const readDispatchConnectCliAccount = Effect.fn("dispatch_connect.cli.read_account")(function* () {
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  const stored = yield* secrets.get(DISPATCH_CONNECT_CLI_ACCOUNT_SECRET);
  if (Option.isNone(stored)) return Option.none<DispatchConnectCliAccount>();
  return yield* decodeDispatchConnectCliAccount(bytesToString(stored.value)).pipe(
    Effect.map(Option.some),
    Effect.catchCause(() => Effect.succeedNone),
  );
});

const storeDispatchConnectCliAccount = Effect.fn("dispatch_connect.cli.store_account")(function* (
  account: DispatchConnectCliAccount,
) {
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  const encoded = yield* encodeDispatchConnectCliAccount(account);
  yield* secrets.set(DISPATCH_CONNECT_CLI_ACCOUNT_SECRET, stringToBytes(encoded));
});

const clearDispatchConnectCliAccount = Effect.fn("dispatch_connect.cli.clear_account")(
  function* () {
    const secrets = yield* ServerSecretStore.ServerSecretStore;
    yield* secrets.remove(DISPATCH_CONNECT_CLI_ACCOUNT_SECRET);
  },
);

const dispatchConnectDeviceLogin = Effect.fn("dispatch_connect.cli.device_login")(function* (
  baseUrl: DispatchConnectBaseUrl,
) {
  const httpClient = yield* HttpClient.HttpClient;
  const authorizationRequest = yield* HttpClientRequest.bodyJson(
    HttpClientRequest.post(`${baseUrl}/api/auth/device/code`),
    { client_id: DISPATCH_CONNECT_CLI_CLIENT_ID },
  );
  const authorizationResponse = yield* authorizationRequest.pipe(
    httpClient.execute,
    Effect.flatMap(HttpClientResponse.filterStatusOk),
  );
  const authorization = yield* HttpClientResponse.schemaBodyJson(DispatchConnectDeviceCodeResponse)(
    authorizationResponse,
  );
  yield* Console.log(
    [
      "Dispatch Connect authorization",
      "Open this URL in a browser:",
      `  ${authorization.verification_uri_complete || authorization.verification_uri}`,
      "",
      `Confirm this code when asked: ${authorization.user_code}`,
      "",
      "Waiting for approval. Press Ctrl+C to cancel.",
    ].join("\n"),
  );

  const expiresIn = Duration.seconds(Math.max(1, authorization.expires_in));
  let interval = Duration.seconds(Math.max(1, authorization.interval));
  const token = yield* Effect.gen(function* () {
    while (true) {
      yield* Effect.sleep(interval);
      const tokenRequest = yield* HttpClientRequest.bodyJson(
        HttpClientRequest.post(`${baseUrl}/api/auth/device/token`),
        {
          grant_type: DEVICE_CODE_GRANT_TYPE,
          device_code: authorization.device_code,
          client_id: DISPATCH_CONNECT_CLI_CLIENT_ID,
        },
      );
      const response = yield* httpClient.execute(tokenRequest);
      if (response.status >= 200 && response.status < 300) {
        return yield* HttpClientResponse.schemaBodyJson(DispatchConnectDeviceTokenResponse)(
          response,
        );
      }
      if (response.status >= 500) {
        yield* Effect.ignore(response.text);
        interval = Duration.sum(interval, Duration.seconds(5));
        continue;
      }
      const failure = yield* HttpClientResponse.schemaBodyJson(DispatchConnectDeviceTokenError)(
        response,
      );
      switch (failure.error) {
        case "authorization_pending":
          continue;
        case "slow_down":
          interval = Duration.sum(interval, Duration.seconds(5));
          continue;
        case "expired_token":
          return yield* new DispatchConnectCliError({
            message: "Dispatch Connect authorization expired.",
          });
        case "access_denied":
          return yield* new DispatchConnectCliError({
            message: "Dispatch Connect authorization was denied.",
          });
        default:
          return yield* new DispatchConnectCliError({
            message: failure.error_description || "Dispatch Connect authorization failed.",
          });
      }
    }
  }).pipe(
    Effect.timeout(expiresIn),
    Effect.catchTag("TimeoutError", () =>
      Effect.fail(
        new DispatchConnectCliError({ message: "Dispatch Connect authorization expired." }),
      ),
    ),
  );

  const account = DispatchConnectCliAccount.make({ baseUrl, token: token.access_token });
  yield* storeDispatchConnectCliAccount(account);
  return account;
});

const dispatchConnectAccountEnvironments = Effect.fn("dispatch_connect.cli.environments")(
  function* (account: DispatchConnectCliAccount) {
    const httpClient = yield* HttpClient.HttpClient;
    const response = yield* HttpClientRequest.get(`${account.baseUrl}/v1/environments`).pipe(
      HttpClientRequest.bearerToken(account.token),
      httpClient.execute,
      Effect.mapError(
        () => new DispatchConnectCliError({ message: "Could not reach Dispatch Connect." }),
      ),
    );
    if (response.status === 401 || response.status === 403) {
      yield* Effect.ignore(response.text);
      return Option.none<readonly DispatchConnectEnvironmentSummary[]>();
    }
    const payload = yield* response.pipe(
      HttpClientResponse.filterStatusOk,
      Effect.flatMap(HttpClientResponse.schemaBodyJson(DispatchConnectEnvironmentListResponse)),
      Effect.mapError(
        () =>
          new DispatchConnectCliError({
            message: "Dispatch Connect returned an invalid environment list response.",
          }),
      ),
    );
    return Option.some(payload.environments);
  },
);

const getOrAuthorizeDispatchConnectAccount = Effect.fn(
  "dispatch_connect.cli.get_or_authorize_account",
)(function* (baseUrl: DispatchConnectBaseUrl) {
  const existing = yield* readDispatchConnectCliAccount();
  if (Option.isSome(existing) && existing.value.baseUrl === baseUrl) {
    const environments = yield* dispatchConnectAccountEnvironments(existing.value);
    if (Option.isSome(environments)) {
      return { account: existing.value, environments: environments.value };
    }
    yield* clearDispatchConnectCliAccount();
    yield* Console.log("Stored Dispatch Connect session expired; authorizing again.\n");
  }
  const account = yield* dispatchConnectDeviceLogin(baseUrl);
  const environments = yield* dispatchConnectAccountEnvironments(account);
  if (Option.isNone(environments)) {
    return yield* new DispatchConnectCliError({
      message: "Dispatch Connect rejected the newly authorized session.",
    });
  }
  return { account, environments: environments.value };
});

const decodeDispatchConnectEnvironmentConfigureInput = Schema.decodeUnknownEffect(
  DispatchConnectEnvironmentConfigureInput,
);

const persistDispatchConnectEnvironment = Effect.fn("dispatch_connect.cli.persist_environment")(
  function* (input: {
    readonly baseUrl: DispatchConnectBaseUrl;
    readonly environmentId: string;
    readonly credential: string;
  }) {
    const decoded = yield* decodeDispatchConnectEnvironmentConfigureInput({
      baseUrl: input.baseUrl,
      environmentId: input.environmentId,
      credential: input.credential,
    });
    const secrets = yield* ServerSecretStore.ServerSecretStore;
    const previousCredential = yield* secrets.get(DISPATCH_CONNECT_ENVIRONMENT_CREDENTIAL_SECRET);
    yield* secrets.set(
      DISPATCH_CONNECT_ENVIRONMENT_CREDENTIAL_SECRET,
      stringToBytes(decoded.credential),
    );
    const encodedConfig = yield* encodePersistedDispatchConnectEnvironmentConfig({
      version: 1,
      baseUrl: decoded.baseUrl,
      environmentId: decoded.environmentId,
    });
    yield* secrets
      .set(DISPATCH_CONNECT_ENVIRONMENT_CONFIG_SECRET, stringToBytes(encodedConfig))
      .pipe(
        Effect.catch((error) => {
          const restore = Option.match(previousCredential, {
            onNone: () => secrets.remove(DISPATCH_CONNECT_ENVIRONMENT_CREDENTIAL_SECRET),
            onSome: (value) => secrets.set(DISPATCH_CONNECT_ENVIRONMENT_CREDENTIAL_SECRET, value),
          });
          return restore.pipe(Effect.ignore, Effect.andThen(Effect.fail(error)));
        }),
      );
    return decoded;
  },
);

const registerDispatchConnectEnvironment = Effect.fn("dispatch_connect.cli.register_environment")(
  function* (
    account: DispatchConnectCliAccount,
    environments: readonly DispatchConnectEnvironmentSummary[],
  ) {
    const secrets = yield* ServerSecretStore.ServerSecretStore;
    const httpClient = yield* HttpClient.HttpClient;
    const keyPair = yield* getOrCreateEnvironmentKeyPairFromSecretStore(secrets);
    const existing = environments.find(
      (environment) => environment.publicKey === keyPair.publicKey,
    );
    if (existing) {
      const response = yield* HttpClientRequest.post(
        `${account.baseUrl}/v1/environments/${encodeURIComponent(existing.id)}/credentials/rotate`,
      ).pipe(
        HttpClientRequest.bearerToken(account.token),
        httpClient.execute,
        Effect.flatMap(HttpClientResponse.filterStatusOk),
        Effect.flatMap(
          HttpClientResponse.schemaBodyJson(DispatchConnectEnvironmentCredentialResponse),
        ),
        Effect.mapError(
          () =>
            new DispatchConnectCliError({
              message: "Could not refresh this environment's Dispatch Connect credential.",
            }),
        ),
      );
      return yield* persistDispatchConnectEnvironment({
        baseUrl: account.baseUrl,
        environmentId: existing.id,
        credential: response.credential,
      });
    }

    const createRequestWithBody = yield* HttpClientRequest.bodyJson(
      HttpClientRequest.post(`${account.baseUrl}/v1/environments`).pipe(
        HttpClientRequest.bearerToken(account.token),
      ),
      {
        label: NodeOS.hostname() || "Dispatch environment",
        publicKey: keyPair.publicKey,
        endpoints: [],
      },
    ).pipe(
      Effect.mapError(
        () =>
          new DispatchConnectCliError({ message: "Could not prepare Dispatch Connect request." }),
      ),
    );
    const createResponse = yield* createRequestWithBody.pipe(
      httpClient.execute,
      Effect.flatMap(HttpClientResponse.filterStatusOk),
      Effect.mapError(
        () =>
          new DispatchConnectCliError({
            message: "Could not register this environment with Dispatch Connect.",
          }),
      ),
    );
    const response = yield* HttpClientResponse.schemaBodyJson(
      DispatchConnectEnvironmentCreateResponse,
    )(createResponse).pipe(
      Effect.mapError(
        () =>
          new DispatchConnectCliError({
            message: "Dispatch Connect returned an invalid environment registration response.",
          }),
      ),
    );
    return yield* persistDispatchConnectEnvironment({
      baseUrl: account.baseUrl,
      environmentId: response.environment.id,
      credential: response.credential,
    });
  },
);

const DISPATCH_CONNECT_CLI_LIVE_SERVER_TIMEOUT = Duration.seconds(5);

const withDispatchConnectCliSessionToken = <A, E, R>(
  environmentAuth: EnvironmentAuth.EnvironmentAuth["Service"],
  run: (token: string) => Effect.Effect<A, E, R>,
) =>
  Effect.acquireUseRelease(
    environmentAuth.issueSession({
      scopes: [AuthAccessWriteScope],
      subject: "dispatch-connect-cli",
      label: "dispatch connect cli",
    }),
    (issued) => run(issued.token),
    (issued) => environmentAuth.revokeSession(issued.sessionId).pipe(Effect.ignore({ log: true })),
  );

type LiveDispatchConnectActionResult =
  | { readonly status: "not-running" }
  | { readonly status: "succeeded"; readonly managedEndpointStatus?: string }
  | { readonly status: "failed" };

const runLiveDispatchConnectEnsure = Effect.fn("dispatch_connect.cli.run_live_ensure")(
  function* () {
    const config = yield* ServerConfig.ServerConfig;
    const runtimeState = yield* readPersistedServerRuntimeState(config.serverRuntimeStatePath);
    if (Option.isNone(runtimeState)) {
      return { status: "not-running" } satisfies LiveDispatchConnectActionResult;
    }
    const environmentAuth = yield* EnvironmentAuth.EnvironmentAuth;
    const result = yield* Effect.exit(
      withDispatchConnectCliSessionToken(environmentAuth, (token) =>
        HttpApiClient.make(EnvironmentHttpApi, { baseUrl: runtimeState.value.origin }).pipe(
          Effect.flatMap((client) =>
            client.auth.dispatchConnectManagedEndpointEnsure({
              headers: { authorization: `Bearer ${token}` },
            }),
          ),
          Effect.timeout(DISPATCH_CONNECT_CLI_LIVE_SERVER_TIMEOUT),
        ),
      ),
    );
    return Exit.isSuccess(result)
      ? ({
          status: "succeeded",
          managedEndpointStatus: result.value.status,
        } satisfies LiveDispatchConnectActionResult)
      : ({ status: "failed" } satisfies LiveDispatchConnectActionResult);
  },
);

const runLiveDispatchConnectDisable = Effect.fn("dispatch_connect.cli.run_live_disable")(
  function* () {
    const config = yield* ServerConfig.ServerConfig;
    const runtimeState = yield* readPersistedServerRuntimeState(config.serverRuntimeStatePath);
    if (Option.isNone(runtimeState)) {
      return { status: "not-running" } satisfies LiveDispatchConnectActionResult;
    }
    const environmentAuth = yield* EnvironmentAuth.EnvironmentAuth;
    const result = yield* Effect.exit(
      withDispatchConnectCliSessionToken(environmentAuth, (token) =>
        HttpApiClient.make(EnvironmentHttpApi, { baseUrl: runtimeState.value.origin }).pipe(
          Effect.flatMap((client) =>
            client.auth.dispatchConnectDisable({
              headers: { authorization: `Bearer ${token}` },
            }),
          ),
          Effect.timeout(DISPATCH_CONNECT_CLI_LIVE_SERVER_TIMEOUT),
        ),
      ),
    );
    return Exit.isSuccess(result)
      ? ({ status: "succeeded" } satisfies LiveDispatchConnectActionResult)
      : ({ status: "failed" } satisfies LiveDispatchConnectActionResult);
  },
);

const runDispatchConnectCommand = Effect.fn("dispatch_connect.cli.run_command")(function* <A, E>(
  flags: { readonly baseDir: Option.Option<string> },
  run: Effect.Effect<
    A,
    E,
    | ServerSecretStore.ServerSecretStore
    | EnvironmentAuth.EnvironmentAuth
    | BootService.BootService
    | Crypto.Crypto
    | FileSystem.FileSystem
    | HttpClient.HttpClient
    | Prompt.Environment
    | ServerConfig.ServerConfig
    | ServerEnvironment.ServerEnvironmentIdentity
  >,
  options?: { readonly quietLogs?: boolean },
) {
  const logLevel = yield* GlobalFlag.LogLevel;
  const config = yield* resolveCliAuthConfig(flags, logLevel);
  const minimumLogLevel = options?.quietLogs ? "Error" : config.logLevel;
  const runtimeLayer = Layer.mergeAll(
    ServerSecretStore.layer,
    EnvironmentAuth.runtimeLayer,
    bootServiceLayer(config),
  ).pipe(
    Layer.provideMerge(FetchHttpClient.layer),
    Layer.provideMerge(ServerConfig.layer(config)),
    Layer.provide(Layer.succeed(References.MinimumLogLevel, minimumLogLevel)),
  );
  return yield* run.pipe(Effect.provide(runtimeLayer));
});

const readPersistedDispatchConnectEnvironment = Effect.fn("dispatch_connect.cli.read_environment")(
  function* () {
    const secrets = yield* ServerSecretStore.ServerSecretStore;
    const stored = yield* secrets.get(DISPATCH_CONNECT_ENVIRONMENT_CONFIG_SECRET);
    if (Option.isNone(stored)) return Option.none<PersistedDispatchConnectEnvironmentConfig>();
    return yield* decodePersistedDispatchConnectEnvironmentConfig(bytesToString(stored.value)).pipe(
      Effect.map(Option.some),
      Effect.catchCause(() => Effect.succeedNone),
    );
  },
);

const clearLocalDispatchConnectEnvironment = Effect.fn(
  "dispatch_connect.cli.clear_local_environment",
)(function* () {
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  yield* Effect.all(
    [
      secrets.remove(DISPATCH_CONNECT_MANAGED_ENDPOINT_CONFIG_SECRET),
      secrets.remove(DISPATCH_CONNECT_ENVIRONMENT_CONFIG_SECRET),
      secrets.remove(DISPATCH_CONNECT_ENVIRONMENT_CREDENTIAL_SECRET),
    ],
    { concurrency: "unbounded", discard: true },
  );
});

const cleanupRemoteDispatchConnectManagedTunnel = Effect.fn(
  "dispatch_connect.cli.cleanup_remote_managed_tunnel",
)(function* () {
  const environment = yield* readPersistedDispatchConnectEnvironment();
  if (Option.isNone(environment)) return true;
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  const credential = yield* secrets.get(DISPATCH_CONNECT_ENVIRONMENT_CREDENTIAL_SECRET);
  if (Option.isNone(credential)) return false;
  const httpClient = yield* HttpClient.HttpClient;
  const response = yield* Effect.result(
    HttpClientRequest.delete(
      `${environment.value.baseUrl}/v1/environments/${encodeURIComponent(environment.value.environmentId)}/managed-tunnel`,
    ).pipe(HttpClientRequest.bearerToken(bytesToString(credential.value)), httpClient.execute),
  );
  if (Result.isFailure(response)) return false;
  return (
    (response.success.status >= 200 && response.success.status < 300) ||
    response.success.status === 404 ||
    response.success.status === 503
  );
});

const disconnectDispatchConnect = Effect.fn("dispatch_connect.cli.disconnect")(function* (input: {
  readonly clearAccount: boolean;
}) {
  const liveResult = yield* runLiveDispatchConnectDisable();
  if (liveResult.status !== "succeeded") {
    const remoteCleanup = yield* cleanupRemoteDispatchConnectManagedTunnel();
    if (!remoteCleanup) {
      yield* Console.warn(
        "Dispatch Connect was disabled locally, but the remote managed tunnel could not be confirmed removed.",
      );
    }
    yield* clearLocalDispatchConnectEnvironment();
  }
  if (input.clearAccount) {
    yield* clearDispatchConnectCliAccount();
    yield* Console.log(
      "Signed out of Dispatch Connect and disabled remote access for this environment.",
    );
  } else {
    yield* Console.log("Dispatch Connect remote access is disabled for this environment.");
  }
});

interface DispatchConnectCliStatus {
  readonly connectUrl: string | null;
  readonly authenticated: boolean;
  readonly environmentConfigured: boolean;
  readonly environmentId: string | null;
  readonly serverRunning: boolean;
}

function formatDispatchConnectStatus(
  status: DispatchConnectCliStatus,
  options?: { readonly json?: boolean },
): string {
  if (options?.json) return JSON.stringify(status, null, 2);
  return [
    "Dispatch Connect",
    `  Service: ${status.connectUrl ?? "not configured"}`,
    `  Account authorization: ${status.authenticated ? "stored" : "missing"}`,
    `  Environment: ${status.environmentConfigured ? (status.environmentId ?? "configured") : "not linked"}`,
    `  Local server: ${status.serverRunning ? "running" : "not running"}`,
  ].join("\n");
}

const setupDispatchConnect = Effect.fn("dispatch_connect.cli.setup")(function* () {
  const configuredUrl = resolveDispatchConnectCliUrl();
  if (!configuredUrl) {
    return yield* new DispatchConnectCliError({
      message:
        "Dispatch Connect is not configured. Set DISPATCH_CONNECT_URL to your Dispatch Connect service origin.",
    });
  }
  const baseUrl = DispatchConnectBaseUrl.make(configuredUrl);
  yield* Console.log("Dispatch Connect\n");
  const authorized = yield* getOrAuthorizeDispatchConnectAccount(baseUrl);
  const environment = yield* registerDispatchConnectEnvironment(
    authorized.account,
    authorized.environments,
  );
  yield* Console.log(`✓ Environment linked · ${environment.environmentId}`);

  const live = yield* runLiveDispatchConnectEnsure();
  if (live.status === "succeeded") {
    yield* Console.log(
      live.managedEndpointStatus === "running"
        ? "✓ Managed internet access ready"
        : `Managed internet access: ${live.managedEndpointStatus ?? "not enabled"}`,
    );
    return;
  }
  if (live.status === "failed") {
    yield* Effect.logWarning("Dispatch Connect live managed endpoint setup failed");
    yield* Console.warn(
      "The environment was linked, but the running server could not finish remote transport setup.",
    );
    return;
  }

  const background = yield* recoverServiceOnboardingOffer(offerServiceDuringOnboarding);
  if (background) {
    yield* Console.log(
      "\n✓ Background service ready\n\nDispatch will finish managed remote access when the server starts.",
    );
    return;
  }
  const serveCommand = yield* resolveCliCommand("serve");
  yield* Console.log(
    `\nNext\n  Start the server with \`${serveCommand}\` to finish managed remote access.`,
  );
});

const dispatchConnectLoginCommand = Command.make("login", {
  ...projectLocationFlags,
}).pipe(
  Command.withDescription("Authorize this CLI with Dispatch Connect."),
  Command.withHandler((flags) =>
    runDispatchConnectCommand(
      flags,
      Effect.gen(function* () {
        const configuredUrl = resolveDispatchConnectCliUrl();
        if (!configuredUrl) {
          return yield* new DispatchConnectCliError({
            message:
              "Dispatch Connect is not configured. Set DISPATCH_CONNECT_URL to your Dispatch Connect service origin.",
          });
        }
        yield* getOrAuthorizeDispatchConnectAccount(DispatchConnectBaseUrl.make(configuredUrl));
        yield* Console.log("✓ Signed in to Dispatch Connect");
      }),
    ),
  ),
);

const dispatchConnectLinkCommand = Command.make("link", {
  ...projectLocationFlags,
}).pipe(
  Command.withDescription("Link this environment to Dispatch Connect."),
  Command.withHandler((flags) => runDispatchConnectCommand(flags, setupDispatchConnect())),
);

const dispatchConnectStatusCommand = Command.make("status", {
  ...projectLocationFlags,
  json: jsonFlag,
}).pipe(
  Command.withDescription("Show Dispatch Connect account and environment state."),
  Command.withHandler((flags) =>
    runDispatchConnectCommand(
      flags,
      Effect.gen(function* () {
        const config = yield* ServerConfig.ServerConfig;
        const [account, environment, runtime] = yield* Effect.all(
          [
            readDispatchConnectCliAccount(),
            readPersistedDispatchConnectEnvironment(),
            readPersistedServerRuntimeState(config.serverRuntimeStatePath),
          ],
          { concurrency: "unbounded" },
        );
        const status: DispatchConnectCliStatus = {
          connectUrl: resolveDispatchConnectCliUrl(),
          authenticated: Option.isSome(account),
          environmentConfigured: Option.isSome(environment),
          environmentId: Option.isSome(environment) ? environment.value.environmentId : null,
          serverRunning: Option.isSome(runtime),
        };
        yield* Console.log(formatDispatchConnectStatus(status, { json: flags.json }));
      }),
      { quietLogs: flags.json },
    ),
  ),
);

const dispatchConnectUnlinkCommand = Command.make("unlink", {
  ...projectLocationFlags,
}).pipe(
  Command.withDescription(
    "Disable Dispatch Connect for this environment but keep account authorization.",
  ),
  Command.withHandler((flags) =>
    runDispatchConnectCommand(flags, disconnectDispatchConnect({ clearAccount: false })),
  ),
);

const dispatchConnectLogoutCommand = Command.make("logout", {
  ...projectLocationFlags,
}).pipe(
  Command.withDescription("Disable Dispatch Connect and clear stored account authorization."),
  Command.withHandler((flags) =>
    runDispatchConnectCommand(flags, disconnectDispatchConnect({ clearAccount: true })),
  ),
);

export const connectCommand = Command.make("connect", {
  ...projectLocationFlags,
}).pipe(
  Command.withDescription("Set up Dispatch Connect for this machine."),
  Command.withHandler((flags) => runDispatchConnectCommand(flags, setupDispatchConnect())),
  Command.withSubcommands([
    dispatchConnectLoginCommand,
    dispatchConnectLinkCommand,
    dispatchConnectStatusCommand,
    dispatchConnectUnlinkCommand,
    dispatchConnectLogoutCommand,
  ]),
);

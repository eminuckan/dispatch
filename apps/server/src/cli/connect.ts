import * as NodeOS from "node:os";
import {
  AuthAccessWriteScope,
  AuthRelayWriteScope,
  DispatchConnectBaseUrl,
  DispatchConnectEnvironmentConfigureInput,
  EnvironmentHttpApi,
  type RelayClientInstallProgressEvent,
  type RelayClientInstallProgressStage,
} from "@dispatch/contracts";
import { RelayOkResponse } from "@dispatch/contracts/relay";
import { HostProcessPlatform } from "@dispatch/shared/hostProcess";
import * as RelayClient from "@dispatch/shared/relayClient";
import { withRelayClientTracing } from "@dispatch/shared/relayTracing";
import * as Cause from "effect/Cause";
import * as Config from "effect/Config";
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
import * as CliState from "../cloud/CliState.ts";
import * as CliTokenManager from "../cloud/CliTokenManager.ts";
import { filterRelayResponse } from "../cloud/relayResponse.ts";
import { getOrCreateEnvironmentKeyPairFromSecretStore } from "../cloud/environmentKeys.ts";
import {
  CLOUD_LINKED_USER_ID,
  isAgentActivityPublishingEnabledValue,
  PUBLISH_AGENT_ACTIVITY_SECRET,
  RELAY_URL_SECRET,
} from "../cloud/config.ts";
import { relayUrlConfig } from "../cloud/publicConfig.ts";
import { headlessRelayClientTracingLayer } from "../cloud/relayTracing.ts";
import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ExternalLauncher from "../process/externalLauncher.ts";
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

const isCloudCliTokenManagerError = Schema.is(CliTokenManager.CloudCliTokenManagerError);

const headlessFlag = Flag.Boolean("headless").pipe(
  Flag.withDescription("Authorize without a local browser using the OAuth device flow."),
  Flag.withDefault(false),
);

/**
 * Inside an SSH session there is no local browser to complete the loopback
 * OAuth callback, so the device authorization grant is the only flow that
 * can work.
 */
export const headlessSessionConfig = Config.all({
  sshConnection: Config.String("SSH_CONNECTION").pipe(Config.option),
  sshTty: Config.String("SSH_TTY").pipe(Config.option),
}).pipe(
  Config.map(({ sshConnection, sshTty }) => Option.isSome(sshConnection) || Option.isSome(sshTty)),
);

const showDeviceAuthorizationPrompt = (prompt: CliTokenManager.DeviceAuthorizationPrompt) =>
  Console.log(formatDeviceAuthorizationPrompt(prompt));

function formatDeviceAuthorizationPrompt(
  prompt: CliTokenManager.DeviceAuthorizationPrompt,
): string {
  const minutes = Math.max(1, Math.round(Duration.toMinutes(prompt.expiresIn)));
  return [
    "Headless authorization",
    "Open this URL on a device with a browser:",
    `  ${prompt.verificationUriComplete ?? prompt.verificationUri}`,
    "",
    `Confirm this code when asked: ${prompt.userCode}`,
    "",
    `Waiting for approval (expires in ${minutes} min). Press Ctrl+C to cancel.`,
  ].join("\n");
}

/** Returns the connected account identity, if the flow could determine one. */
const authorizeCli = Effect.fn("cloud.cli.authorize")(function* (options: {
  readonly headless: boolean;
}) {
  const tokens = yield* CliTokenManager.CloudCliTokenManager;
  const useOutOfBandOAuth = options.headless || (yield* headlessSessionConfig);
  if (!useOutOfBandOAuth) {
    const authorization = yield* tokens.get;
    if (authorization._tag === "Authorized") {
      return authorization.token.identity ?? null;
    }
    yield* Console.log("\nHeadless mode enabled. A new authorization link is ready below.");
  }
  // A stored credential whose refresh fails (revoked, expired grant) must
  // fall through to a fresh device authorization, not dead-end the command.
  const existing = yield* tokens.getExisting.pipe(
    Effect.catchTag("CloudCliCredentialRefreshError", () =>
      Console.log(
        "The stored T3 Connect credential could not be refreshed; signing in again.",
      ).pipe(Effect.as(Option.none())),
    ),
  );
  if (Option.isSome(existing)) {
    return existing.value.identity ?? null;
  }
  const { token, identity } = yield* CliTokenManager.deviceAuthorizationLogin(
    showDeviceAuthorizationPrompt,
  ).pipe(
    Effect.mapError((cause) =>
      isCloudCliTokenManagerError(cause)
        ? cause
        : new CliTokenManager.CloudCliAuthorizationError({ cause }),
    ),
  );
  yield* tokens.store(token);
  return identity;
});

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

const persistDispatchConnectEnvironment = Effect.fn("dispatch_connect.cli.persist_environment")(
  function* (input: {
    readonly baseUrl: DispatchConnectBaseUrl;
    readonly environmentId: string;
    readonly credential: string;
  }) {
    const decoded = yield* Schema.decodeUnknownEffect(DispatchConnectEnvironmentConfigureInput)({
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

interface CloudCliStatus {
  readonly desired: boolean;
  readonly authenticated: boolean;
  readonly linked: boolean;
  readonly cloudUserId: string | null;
  readonly relayUrl: string | null;
  readonly publishAgentActivity: boolean;
  readonly relayClient: RelayClient.RelayClientStatus;
}

function formatRelayClientStatus(executable: RelayClient.RelayClientStatus): ReadonlyArray<string> {
  switch (executable.status) {
    case "available": {
      const source =
        executable.source === "path"
          ? "PATH"
          : executable.source === "managed"
            ? "managed install"
            : "configured override";
      return [
        `  Relay client: available via ${source}`,
        `    Path: ${executable.executablePath}`,
        `    Version: ${executable.version}`,
      ];
    }
    case "missing":
      return ["  Relay client: not installed"];
    case "unsupported":
      return [
        `  Relay client: unsupported on ${executable.platform}-${executable.arch}`,
        `    Managed version: ${executable.version}`,
      ];
  }
}

function formatCloudStatus(status: CloudCliStatus, options?: { readonly json?: boolean }): string {
  if (options?.json) {
    return JSON.stringify(status, null, 2);
  }

  const provisioned = status.linked
    ? "provisioned"
    : status.desired && status.authenticated
      ? "pending server startup"
      : "not provisioned";
  const nextStep = !status.authenticated
    ? "Run `dispatch connect legacy-t3 link` to authorize and enable T3 Connect."
    : !status.desired
      ? "Run `dispatch connect legacy-t3 link` to enable T3 Connect."
      : !status.linked
        ? "Start Dispatch to provision the environment link and launch its managed tunnel."
        : undefined;

  return [
    "T3 Connect",
    `  Exposure: ${status.desired ? "enabled" : "disabled"}`,
    `  Authorization: ${status.authenticated ? "stored credential" : "missing"}`,
    `  Environment link: ${provisioned}`,
    `  Relay: ${status.relayUrl ?? "not provisioned"}`,
    `  Publish agent activity: ${status.publishAgentActivity ? "enabled" : "disabled"}`,
    ...formatRelayClientStatus(status.relayClient),
    "",
    "This is saved setup, not a live connection check. Check the background service with `dispatch service status`.",
    ...(nextStep ? ["", `Next: ${nextStep}`] : []),
  ].join("\n");
}

const CLOUD_CLI_LIVE_SERVER_TIMEOUT = Duration.seconds(5);

const confirmRelayClientInstall = (version: string) =>
  Prompt.run(
    Prompt.Confirm({
      message: `The T3 relay client is required for T3 Connect. Download and install version ${version}?`,
      initial: false,
    }),
  );

function relayClientInstallProgressMessage(stage: RelayClientInstallProgressStage): string {
  switch (stage) {
    case "checking":
      return "Checking existing installation";
    case "waiting_for_lock":
      return "Waiting for installation lock";
    case "downloading":
      return "Downloading";
    case "verifying":
      return "Verifying download";
    case "installing":
      return "Installing";
    case "validating":
      return "Validating executable";
    case "activating":
      return "Activating installation";
  }
}

const reportRelayClientInstallProgress = (event: RelayClientInstallProgressEvent) =>
  event.type === "progress"
    ? Console.log(`Relay client: ${relayClientInstallProgressMessage(event.stage)}...`)
    : Effect.void;

export const acquireRelayClientForLink = Effect.fn("cloud.cli.acquire_relay_client_for_link")(
  function* <ConfirmError, ConfirmContext>(
    relayClient: RelayClient.RelayClient["Service"],
    confirmInstall: (version: string) => Effect.Effect<boolean, ConfirmError, ConfirmContext>,
    reportProgress: (event: RelayClientInstallProgressEvent) => Effect.Effect<void>,
  ) {
    const executable = yield* relayClient.resolve;
    if (executable.status === "available") {
      return Option.some(executable);
    }
    if (executable.status === "unsupported") {
      return Option.some(yield* relayClient.installWithProgress(reportProgress));
    }
    if (!(yield* confirmInstall(executable.version))) {
      return Option.none();
    }
    return Option.some(yield* relayClient.installWithProgress(reportProgress));
  },
);

const withCloudCliSessionToken = <A, E, R>(
  environmentAuth: EnvironmentAuth.EnvironmentAuth["Service"],
  run: (token: string) => Effect.Effect<A, E, R>,
) =>
  Effect.acquireUseRelease(
    environmentAuth.issueSession({
      scopes: [AuthRelayWriteScope],
      subject: "cloud-cli",
      label: "dispatch connect cli",
    }),
    (issued) => run(issued.token),
    (issued) => environmentAuth.revokeSession(issued.sessionId).pipe(Effect.ignore({ log: true })),
  );

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
          Effect.timeout(CLOUD_CLI_LIVE_SERVER_TIMEOUT),
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
          Effect.timeout(CLOUD_CLI_LIVE_SERVER_TIMEOUT),
        ),
      ),
    );
    return Exit.isSuccess(result)
      ? ({ status: "succeeded" } satisfies LiveDispatchConnectActionResult)
      : ({ status: "failed" } satisfies LiveDispatchConnectActionResult);
  },
);

type LiveCloudActionResult =
  | { readonly status: "not-running" }
  | { readonly status: "succeeded" }
  | { readonly status: "failed"; readonly cause: Cause.Cause<unknown> };

const runLiveCloudUnlink = Effect.fn("cloud.cli.run_live_unlink")(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const runtimeState = yield* readPersistedServerRuntimeState(config.serverRuntimeStatePath);
  if (Option.isNone(runtimeState)) {
    return { status: "not-running" } satisfies LiveCloudActionResult;
  }

  const environmentAuth = yield* EnvironmentAuth.EnvironmentAuth;
  const result = yield* Effect.exit(
    withCloudCliSessionToken(environmentAuth, (token) =>
      HttpApiClient.make(EnvironmentHttpApi, {
        baseUrl: runtimeState.value.origin,
      }).pipe(
        Effect.flatMap((client) =>
          client.connect.unlink({ headers: { authorization: `Bearer ${token}` } }),
        ),
        Effect.timeout(CLOUD_CLI_LIVE_SERVER_TIMEOUT),
      ),
    ),
  );
  return Exit.isSuccess(result)
    ? ({ status: "succeeded" } satisfies LiveCloudActionResult)
    : ({ status: "failed", cause: result.cause } satisfies LiveCloudActionResult);
});

type RelayUnlinkResult =
  | { readonly status: "not-authenticated" }
  | { readonly status: "revoked" }
  | { readonly status: "not-linked" };

type CloudDisconnectOperation = "live-server-unlink" | "relay-environment-unlink";

const logCloudDisconnectFailure = (
  operation: CloudDisconnectOperation,
  clearAuthorization: boolean,
  cause: Cause.Cause<unknown>,
) =>
  Effect.logWarning("T3 Connect disconnect operation failed.").pipe(
    Effect.annotateLogs({
      operation,
      clearAuthorization,
      cause: Cause.pretty(cause),
    }),
  );

const unlinkRelayEnvironment = Effect.fn("cloud.cli.unlink_relay_environment")(function* () {
  const tokens = yield* CliTokenManager.CloudCliTokenManager;
  const token = yield* tokens.getExisting;
  if (Option.isNone(token)) {
    return { status: "not-authenticated" } satisfies RelayUnlinkResult;
  }

  const environment = yield* ServerEnvironment.ServerEnvironmentIdentity;
  const environmentId = yield* environment.getEnvironmentId;
  const relayUrl = yield* relayUrlConfig;
  const httpClient = yield* HttpClient.HttpClient;
  const response = yield* HttpClientRequest.delete(
    `${relayUrl}/v1/client/environment-links/${encodeURIComponent(environmentId)}`,
  ).pipe(
    HttpClientRequest.bearerToken(token.value.accessToken),
    httpClient.execute,
    Effect.flatMap(filterRelayResponse),
    Effect.flatMap(HttpClientResponse.schemaBodyJson(RelayOkResponse)),
    withRelayClientTracing,
  );
  return response.ok
    ? ({ status: "revoked" } satisfies RelayUnlinkResult)
    : ({ status: "not-linked" } satisfies RelayUnlinkResult);
});

export const reportCloudDisconnectResults = Effect.fn("cloud.cli.report_disconnect_results")(
  function* (input: {
    readonly clearAuthorization: boolean;
    readonly liveResult: LiveCloudActionResult;
    readonly relayResult: Exit.Exit<RelayUnlinkResult, unknown>;
  }) {
    if (input.liveResult.status === "failed") {
      yield* logCloudDisconnectFailure(
        "live-server-unlink",
        input.clearAuthorization,
        input.liveResult.cause,
      );
      yield* Console.warn(
        "T3 Connect is disabled, but the running server could not stop its tunnel.\nRestart that server to stop the connector.",
      );
    } else {
      yield* Console.log("T3 Connect is disabled locally.");
    }

    if (Exit.isFailure(input.relayResult)) {
      yield* logCloudDisconnectFailure(
        "relay-environment-unlink",
        input.clearAuthorization,
        input.relayResult.cause,
      );
      yield* Console.warn(
        input.clearAuthorization
          ? "Could not revoke the relay-side environment record before signing out.\nThe stored CLI authorization was still removed locally."
          : "Could not revoke the relay-side environment record yet.\nRun `dispatch connect legacy-t3 unlink` again when the relay is reachable.",
      );
    } else if (input.relayResult.value.status === "revoked") {
      yield* Console.log("Revoked the relay-side environment record.");
    }
  },
);

const disconnectCloud = Effect.fn("cloud.cli.disconnect")(function* (options: {
  readonly clearAuthorization: boolean;
}) {
  yield* CliState.setCliDesiredCloudLink(false);
  const liveResult = yield* runLiveCloudUnlink();
  const relayResult = yield* Effect.exit(unlinkRelayEnvironment());
  yield* CliState.clearPersistedCloudLink;

  if (options.clearAuthorization) {
    const tokens = yield* CliTokenManager.CloudCliTokenManager;
    yield* tokens.clear;
  }

  yield* reportCloudDisconnectResults({
    clearAuthorization: options.clearAuthorization,
    liveResult,
    relayResult,
  });

  if (options.clearAuthorization) {
    yield* Console.log(
      "Signed out of T3 Connect locally.\nThe background service is managed separately with `dispatch service`.",
    );
  }
});

const runCloudCommand = Effect.fn("cloud.cli.run_cloud_command")(function* <A, E>(
  flags: { readonly baseDir: Option.Option<string> },
  run: Effect.Effect<
    A,
    E,
    | ServerSecretStore.ServerSecretStore
    | CliTokenManager.CloudCliTokenManager
    | RelayClient.RelayClient
    | EnvironmentAuth.EnvironmentAuth
    | BootService.BootService
    | Crypto.Crypto
    | FileSystem.FileSystem
    | HttpClient.HttpClient
    | Prompt.Environment
    | ServerConfig.ServerConfig
    | ServerEnvironment.ServerEnvironmentIdentity
  >,
  options?: {
    readonly quietLogs?: boolean;
  },
) {
  const logLevel = yield* GlobalFlag.LogLevel;
  const config = yield* resolveCliAuthConfig(flags, logLevel);
  const minimumLogLevel = options?.quietLogs ? "Error" : config.logLevel;
  const runtimeLayer = Layer.mergeAll(
    ServerSecretStore.layer,
    CliTokenManager.layer.pipe(
      Layer.provide(ServerSecretStore.layer),
      Layer.provide(ExternalLauncher.layer),
    ),
    RelayClient.layerCloudflared({ baseDir: config.baseDir }),
    EnvironmentAuth.runtimeLayer,
    bootServiceLayer(config),
    headlessRelayClientTracingLayer,
  ).pipe(
    Layer.provideMerge(FetchHttpClient.layer),
    Layer.provideMerge(ServerConfig.layer(config)),
    Layer.provide(Layer.succeed(References.MinimumLogLevel, minimumLogLevel)),
  );
  return yield* run.pipe(Effect.provide(runtimeLayer));
});

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

const setupDispatchConnect = Effect.fn("dispatch_connect.cli.setup")(function* (flags: {
  readonly baseDir: Option.Option<string>;
}) {
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
  Command.withHandler((flags) => runDispatchConnectCommand(flags, setupDispatchConnect(flags))),
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

const connectedAs = (identity: string | null): string => (identity ? ` as ${identity}` : "");

function formatRelayClientReady(version: string): string {
  return `✓ Relay client ready · cloudflared ${version}`;
}

const linkEnvironmentForConnect = Effect.fn("cloud.cli.link_environment")(function* (options: {
  readonly headless: boolean;
  readonly publishOnly?: boolean;
}) {
  const publishOnly = options.publishOnly ?? false;
  if (!publishOnly) {
    const relayClient = yield* RelayClient.RelayClient;
    const installed = yield* acquireRelayClientForLink(
      relayClient,
      confirmRelayClientInstall,
      reportRelayClientInstallProgress,
    );
    if (Option.isNone(installed)) {
      yield* Console.log("T3 Connect setup cancelled. The relay client was not installed.");
      return null;
    }
    yield* Console.log(formatRelayClientReady(installed.value.version));
  }

  const identity = yield* authorizeCli(options);
  yield* CliState.setCliDesiredCloudLink(true, publishOnly ? "publish_only" : "managed");
  if (publishOnly) {
    const secrets = yield* ServerSecretStore.ServerSecretStore;
    yield* secrets.set(PUBLISH_AGENT_ACTIVITY_SECRET, stringToBytes("true"));
  }
  return { identity } as const;
});

const connectLoginCommand = Command.make("login", {
  ...projectLocationFlags,
  headless: headlessFlag,
}).pipe(
  Command.withDescription("Authorize the T3 Connect CLI without enabling remote access."),
  Command.withHandler((flags) =>
    runCloudCommand(
      flags,
      Effect.gen(function* () {
        yield* Console.log("T3 Connect\n");
        const identity = yield* authorizeCli(flags);
        yield* Console.log(`✓ Signed in${connectedAs(identity)}`);
      }),
    ),
  ),
);

const connectLinkCommand = Command.make("link", {
  ...projectLocationFlags,
  headless: headlessFlag,
  publishOnly: Flag.Boolean("publish-only").pipe(
    Flag.withDescription(
      "Link to publish agent activity only — no managed tunnel. Reach this environment out of band (e.g. Tailscale).",
    ),
    Flag.withDefault(false),
  ),
}).pipe(
  Command.withDescription("Authorize this environment for T3 Connect on next start."),
  Command.withHandler((flags) =>
    runCloudCommand(
      flags,
      Effect.gen(function* () {
        yield* Console.log("T3 Connect\n");
        const linked = yield* linkEnvironmentForConnect(flags);
        if (linked) {
          const serveCommand = yield* resolveCliCommand("serve");
          yield* Console.log(
            flags.publishOnly
              ? `✓ Authorized${connectedAs(linked.identity)}\n\nNext\n  Start Dispatch to publish agent activity (no managed tunnel).`
              : `✓ Authorized${connectedAs(linked.identity)}\n\nNext\n  Start the server with \`${serveCommand}\` to make this machine reachable.`,
          );
        }
      }),
    ),
  ),
);

const connectStatusCommand = Command.make("status", {
  ...projectLocationFlags,
  json: jsonFlag,
}).pipe(
  Command.withDescription("Show persisted T3 Connect and relay client state."),
  Command.withHandler((flags) =>
    runCloudCommand(
      flags,
      Effect.gen(function* () {
        const secrets = yield* ServerSecretStore.ServerSecretStore;
        const relayClient = yield* RelayClient.RelayClient;
        const tokens = yield* CliTokenManager.CloudCliTokenManager;
        const [desired, authenticated, cloudUserId, relayUrl, publishAgentActivity, executable] =
          yield* Effect.all(
            [
              CliState.readCliDesiredCloudLink,
              tokens.hasCredential,
              secrets.get(CLOUD_LINKED_USER_ID),
              secrets.get(RELAY_URL_SECRET),
              secrets.get(PUBLISH_AGENT_ACTIVITY_SECRET),
              relayClient.resolve,
            ],
            { concurrency: "unbounded" },
          );
        const status: CloudCliStatus = {
          desired,
          authenticated,
          linked: Option.isSome(cloudUserId),
          cloudUserId: Option.isSome(cloudUserId) ? bytesToString(cloudUserId.value) : null,
          relayUrl: Option.isSome(relayUrl) ? bytesToString(relayUrl.value) : null,
          publishAgentActivity: isAgentActivityPublishingEnabledValue(
            Option.isSome(publishAgentActivity) ? bytesToString(publishAgentActivity.value) : null,
          ),
          relayClient: executable,
        };
        yield* Console.log(formatCloudStatus(status, { json: flags.json }));
      }),
      {
        quietLogs: flags.json,
      },
    ),
  ),
);

const connectPublishCommand = Command.make("publish", {
  ...projectLocationFlags,
  disable: Flag.Boolean("disable").pipe(
    Flag.withDescription("Stop publishing agent activity to your mobile clients."),
    Flag.withDefault(false),
  ),
}).pipe(
  Command.withDescription(
    "Toggle publishing agent activity (push notifications and Live Activities) to your mobile clients.",
  ),
  Command.withHandler((flags) =>
    runCloudCommand(
      flags,
      Effect.gen(function* () {
        const secrets = yield* ServerSecretStore.ServerSecretStore;
        const tokens = yield* CliTokenManager.CloudCliTokenManager;
        const enabled = !flags.disable;
        yield* secrets.set(
          PUBLISH_AGENT_ACTIVITY_SECRET,
          stringToBytes(enabled ? "true" : "false"),
        );
        if (!enabled) {
          // If enabling scheduled a publish-only link that hasn't been
          // provisioned yet, disabling must cancel it too — otherwise the next
          // start still links an environment whose only purpose was publishing.
          // A pending managed link is left alone; it exists for the tunnel.
          const linkedNow = Option.isSome(yield* secrets.get(CLOUD_LINKED_USER_ID));
          if (!linkedNow && (yield* CliState.readCliDesiredLinkMode) === "publish_only") {
            yield* CliState.setCliDesiredCloudLink(false);
            yield* Console.log("Cancelled the pending publish-only T3 Connect link.");
          }
          yield* Console.log("Publishing agent activity disabled.");
          return;
        }

        yield* Console.log("Publishing agent activity enabled.");
        const linked = Option.isSome(yield* secrets.get(CLOUD_LINKED_USER_ID));
        if (linked) {
          return;
        }

        // Publishing needs the relay to know this environment belongs to you.
        // Establish a tunnel-free publish-only link automatically so signing in
        // is all it takes — the mobile client can still reach the environment
        // out of band without T3 Connect.
        if (!(yield* tokens.hasCredential)) {
          yield* Console.log(
            "Run `dispatch connect legacy-t3 login` first so this environment can be authorized to publish.",
          );
          return;
        }
        // A link may already be desired (e.g. `t3 connect link` before the
        // server's first start). Never downgrade it: a desired managed link
        // also covers publishing, so only request a publish-only link when no
        // link is pending at all.
        if (yield* CliState.readCliDesiredCloudLink) {
          yield* Console.log(
            "A T3 Connect link is already pending. Start Dispatch to finish provisioning it; publishing starts once it links.",
          );
          return;
        }
        yield* CliState.setCliDesiredCloudLink(true, "publish_only");
        yield* Console.log(
          "Restart Dispatch to finish authorizing this environment to publish (no managed tunnel is created).",
        );
      }),
    ),
  ),
);

const connectUnlinkCommand = Command.make("unlink", {
  ...projectLocationFlags,
}).pipe(
  Command.withDescription("Disable T3 Connect while retaining the stored authorization."),
  Command.withHandler((flags) =>
    runCloudCommand(flags, disconnectCloud({ clearAuthorization: false })),
  ),
);

const connectLogoutCommand = Command.make("logout", {
  ...projectLocationFlags,
}).pipe(
  Command.withDescription("Disable T3 Connect and clear the stored CLI authorization."),
  Command.withHandler((flags) =>
    runCloudCommand(flags, disconnectCloud({ clearAuthorization: true })),
  ),
);

const legacyT3ConnectCommand = Command.make("legacy-t3", {
  ...projectLocationFlags,
  headless: headlessFlag,
}).pipe(
  Command.withDescription("Legacy T3 Connect compatibility commands."),
  Command.withHandler((flags) =>
    runCloudCommand(
      flags,
      Effect.gen(function* () {
        yield* Console.log("T3 Connect\n");
        const linked = yield* linkEnvironmentForConnect(flags);
        if (!linked) {
          return;
        }
        // Show which account was linked so an unexpected identity (an
        // authorization code for a different account) is visible before the
        // machine is brought online.
        yield* Console.log(`✓ Authorized${connectedAs(linked.identity)}`);

        // Authorization is stored. If service setup fails, preserve it and
        // show how to run the server manually.
        const background = yield* recoverServiceOnboardingOffer(offerServiceDuringOnboarding);
        if (background) {
          const platform = yield* HostProcessPlatform;
          yield* Console.log(
            platform === "darwin"
              ? "\n✓ Background service ready\n\nDispatch is set to run while you are logged in to this Mac. The server establishes the T3 Connect link on startup."
              : "\n✓ Background service ready\n\nDispatch is set to keep running after you log out. The server establishes the T3 Connect link on startup.",
          );
          return;
        }
        const serveCommand = yield* resolveCliCommand("serve");
        yield* Console.log(
          `\nNext\n  Start the server with \`${serveCommand}\` to make this machine reachable.`,
        );
      }),
    ),
  ),
  Command.withSubcommands([
    connectLoginCommand,
    connectLinkCommand,
    connectPublishCommand,
    connectStatusCommand,
    connectUnlinkCommand,
    connectLogoutCommand,
  ]),
);

export const connectCommand = Command.make("connect", {
  ...projectLocationFlags,
}).pipe(
  Command.withDescription("Set up Dispatch Connect for this machine."),
  Command.withHandler((flags) => runDispatchConnectCommand(flags, setupDispatchConnect(flags))),
  Command.withSubcommands([
    dispatchConnectLoginCommand,
    dispatchConnectLinkCommand,
    dispatchConnectStatusCommand,
    dispatchConnectUnlinkCommand,
    dispatchConnectLogoutCommand,
    legacyT3ConnectCommand,
  ]),
);

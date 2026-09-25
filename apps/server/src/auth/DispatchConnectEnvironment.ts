import {
  DispatchConnectBaseUrl,
  DispatchConnectControlPlaneEnvironmentId,
  DispatchConnectEnvironmentConnection,
  DispatchConnectManagedEndpointConfig,
  DispatchConnectPairingRegistrationResponse,
  TrimmedNonEmptyString,
  type DispatchConnectEnvironmentConfigureInput,
  type DispatchConnectEnvironmentIdentity,
  type DispatchConnectEnvironmentStatus,
  type DispatchConnectManagedEndpointStatus,
  type DispatchConnectPairingChallenge,
} from "@dispatch/contracts";
import * as RelayClient from "@dispatch/shared/relayClient";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";

import * as ManagedEndpointRuntime from "../cloud/ManagedEndpointRuntime.ts";
import * as ServerConfig from "../config.ts";
import { getOrCreateEnvironmentKeyPairFromSecretStore } from "../cloud/environmentKeys.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import { readPersistedServerRuntimeState } from "../serverRuntimeState.ts";
import * as ServerSecretStore from "./ServerSecretStore.ts";

export const DISPATCH_CONNECT_ENVIRONMENT_CONFIG_SECRET = "dispatch-connect-environment-config";
export const DISPATCH_CONNECT_ENVIRONMENT_CREDENTIAL_SECRET =
  "dispatch-connect-environment-credential";
export const DISPATCH_CONNECT_SMART_ROUTING_SESSION_SECRET =
  "dispatch-connect-smart-routing-session";
export const DISPATCH_CONNECT_MANAGED_ENDPOINT_CONFIG_SECRET =
  "dispatch-connect-managed-endpoint-runtime-config";

const PersistedDispatchConnectEnvironmentConfig = Schema.Struct({
  version: Schema.Literal(1),
  ...DispatchConnectEnvironmentConnection.fields,
});
type PersistedDispatchConnectEnvironmentConfig =
  typeof PersistedDispatchConnectEnvironmentConfig.Type;

const PersistedDispatchConnectEnvironmentConfigJson = Schema.fromJsonString(
  PersistedDispatchConnectEnvironmentConfig,
);
const decodeEnvironmentConfig = Schema.decodeUnknownEffect(
  PersistedDispatchConnectEnvironmentConfigJson,
);
const encodeEnvironmentConfig = Schema.encodeEffect(PersistedDispatchConnectEnvironmentConfigJson);

const DispatchConnectManagedEndpointConfigJson = Schema.fromJsonString(
  DispatchConnectManagedEndpointConfig,
);
const DispatchConnectManagedEndpointProvisionResponse = Schema.Struct({
  connectorToken: TrimmedNonEmptyString,
  tunnel: Schema.Struct({
    tunnelId: TrimmedNonEmptyString,
    tunnelName: TrimmedNonEmptyString,
  }),
});
const decodeManagedEndpointConfig = Schema.decodeUnknownEffect(
  DispatchConnectManagedEndpointConfigJson,
);
const encodeManagedEndpointConfig = Schema.encodeEffect(DispatchConnectManagedEndpointConfigJson);

export const DispatchConnectEnvironmentOperation = Schema.Literals([
  "identity",
  "read-config",
  "write-config",
  "read-credential",
  "write-credential",
  "remove-config",
  "remove-credential",
  "register-pairing",
  "read-managed-endpoint",
  "write-managed-endpoint",
  "remove-managed-endpoint",
  "ensure-managed-endpoint",
  "cleanup-managed-endpoint",
]);
export type DispatchConnectEnvironmentOperation = typeof DispatchConnectEnvironmentOperation.Type;

export class DispatchConnectEnvironmentError extends Schema.TaggedError<DispatchConnectEnvironmentError>()(
  "DispatchConnectEnvironmentError",
  {
    operation: DispatchConnectEnvironmentOperation,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Dispatch Connect environment operation failed (${this.operation}).`;
  }
}

export const isDispatchConnectEnvironmentError = Schema.is(DispatchConnectEnvironmentError);

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

const asError = (operation: DispatchConnectEnvironmentOperation, cause: unknown) =>
  new DispatchConnectEnvironmentError({ operation, cause });

const bytesToString = (bytes: Uint8Array): string => textDecoder.decode(bytes);
const stringToBytes = (value: string): Uint8Array => textEncoder.encode(value);

const canonicalBaseUrl = Effect.fn("DispatchConnectEnvironment.canonicalBaseUrl")(function* (
  baseUrl: string,
) {
  return yield* Effect.try({
    try: () => {
      const url = new URL(baseUrl);
      if (url.protocol !== "http:" && url.protocol !== "https:") {
        throw new Error("Dispatch Connect base URL must use HTTP or HTTPS.");
      }
      url.pathname = url.pathname.replace(/\/+$/u, "");
      url.search = "";
      url.hash = "";
      return DispatchConnectBaseUrl.make(url.toString().replace(/\/$/u, ""));
    },
    catch: (cause) => asError("write-config", cause),
  });
});

function managedEndpointStatus(
  status: ManagedEndpointRuntime.CloudManagedEndpointRuntimeStatus,
): DispatchConnectManagedEndpointStatus {
  switch (status.status) {
    case "disabled":
      return { status: "disabled" };
    case "running":
      return {
        status: "running",
        providerKind: "cloudflare_tunnel",
        ...(status.tunnelId ? { tunnelId: status.tunnelId } : {}),
        ...(status.tunnelName ? { tunnelName: status.tunnelName } : {}),
      };
    case "failed":
      return {
        status: "failed",
        providerKind: "cloudflare_tunnel",
        reason: status.reason,
        ...(status.tunnelId ? { tunnelId: status.tunnelId } : {}),
        ...(status.tunnelName ? { tunnelName: status.tunnelName } : {}),
      };
    case "unsupported":
      return { status: "unsupported", providerKind: "cloudflare_tunnel" };
  }
}

/** Server-only credential access for Connect transport. */
const readDispatchConnectEnvironmentConnection = Effect.fnUntraced(function* (
  secrets: ServerSecretStore.ServerSecretStore["Service"],
) {
  const bytes = yield* secrets
    .get(DISPATCH_CONNECT_ENVIRONMENT_CONFIG_SECRET)
    .pipe(Effect.mapError((cause) => asError("read-config", cause)));
  if (Option.isNone(bytes))
    return Option.none<{
      readonly connection: DispatchConnectEnvironmentConnection;
      readonly credential: string;
    }>();
  const config = yield* decodeEnvironmentConfig(bytesToString(bytes.value)).pipe(
    Effect.mapError((cause) => asError("read-config", cause)),
  );
  const credential = yield* secrets
    .get(DISPATCH_CONNECT_ENVIRONMENT_CREDENTIAL_SECRET)
    .pipe(Effect.mapError((cause) => asError("read-credential", cause)));
  if (Option.isNone(credential) || credential.value.byteLength === 0) {
    return yield* asError("read-credential", new Error("Dispatch Connect credential missing."));
  }
  return Option.some({
    connection: { baseUrl: config.baseUrl, environmentId: config.environmentId },
    credential: bytesToString(credential.value),
  });
});

export class DispatchConnectEnvironment extends Context.Service<
  DispatchConnectEnvironment,
  {
    readonly getIdentity: () => Effect.Effect<
      DispatchConnectEnvironmentIdentity,
      DispatchConnectEnvironmentError
    >;
    readonly getStatus: () => Effect.Effect<
      DispatchConnectEnvironmentStatus,
      DispatchConnectEnvironmentError
    >;
    readonly configure: (
      input: DispatchConnectEnvironmentConfigureInput,
    ) => Effect.Effect<DispatchConnectEnvironmentStatus, DispatchConnectEnvironmentError>;
    readonly disable: () => Effect.Effect<
      DispatchConnectEnvironmentStatus,
      DispatchConnectEnvironmentError
    >;
    readonly registerPairing: (
      challenge: DispatchConnectPairingChallenge,
    ) => Effect.Effect<boolean, DispatchConnectEnvironmentError>;
    readonly getManagedEndpointStatus: () => Effect.Effect<
      DispatchConnectManagedEndpointStatus,
      DispatchConnectEnvironmentError
    >;
    readonly ensureManagedEndpoint: () => Effect.Effect<
      DispatchConnectManagedEndpointStatus,
      DispatchConnectEnvironmentError
    >;
    readonly disableManagedEndpoint: () => Effect.Effect<
      DispatchConnectManagedEndpointStatus,
      DispatchConnectEnvironmentError
    >;
  }
>()("dispatch/auth/DispatchConnectEnvironment") {}

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  const environment = yield* ServerEnvironment.ServerEnvironment;
  const httpClient = yield* HttpClient.HttpClient;
  const endpointRuntime = yield* ManagedEndpointRuntime.CloudManagedEndpointRuntime;
  const relayClient = yield* RelayClient.RelayClient;
  const serverConfig = yield* ServerConfig.ServerConfig;
  const fileSystem = yield* FileSystem.FileSystem;
  const mutationSemaphore = yield* Semaphore.make(1);

  const readConfiguredConnection = () => readDispatchConnectEnvironmentConnection(secrets);

  const readManagedEndpointConfig = Effect.fn(
    "DispatchConnectEnvironment.readManagedEndpointConfig",
  )(function* () {
    const bytes = yield* secrets
      .get(DISPATCH_CONNECT_MANAGED_ENDPOINT_CONFIG_SECRET)
      .pipe(Effect.mapError((cause) => asError("read-managed-endpoint", cause)));
    if (Option.isNone(bytes)) return Option.none<DispatchConnectManagedEndpointConfig>();
    const decoded = yield* decodeManagedEndpointConfig(bytesToString(bytes.value)).pipe(
      Effect.mapError((cause) => asError("read-managed-endpoint", cause)),
    );
    return Option.some(decoded);
  });

  const getIdentity: DispatchConnectEnvironment["Service"]["getIdentity"] = Effect.fn(
    "DispatchConnectEnvironment.getIdentity",
  )(function* () {
    const descriptor = yield* environment.getDescriptor;
    const keyPair = yield* getOrCreateEnvironmentKeyPairFromSecretStore(secrets).pipe(
      Effect.mapError((cause) => asError("identity", cause)),
    );
    return {
      environmentId: descriptor.environmentId,
      label: descriptor.label,
      publicKey: keyPair.publicKey,
    } satisfies DispatchConnectEnvironmentIdentity;
  });

  const getStatus: DispatchConnectEnvironment["Service"]["getStatus"] = Effect.fn(
    "DispatchConnectEnvironment.getStatus",
  )(function* () {
    const configured = yield* readConfiguredConnection();
    if (Option.isNone(configured)) return { configured: false };
    return {
      configured: true,
      connection: configured.value.connection,
    } satisfies DispatchConnectEnvironmentStatus;
  });

  const configure: DispatchConnectEnvironment["Service"]["configure"] = (input) =>
    mutationSemaphore.withPermits(1)(
      Effect.gen(function* () {
        const previousConfigBytes = yield* secrets
          .get(DISPATCH_CONNECT_ENVIRONMENT_CONFIG_SECRET)
          .pipe(Effect.mapError((cause) => asError("read-config", cause)));
        const previousConfig = Option.isSome(previousConfigBytes)
          ? Option.some(
              yield* decodeEnvironmentConfig(bytesToString(previousConfigBytes.value)).pipe(
                Effect.mapError((cause) => asError("read-config", cause)),
              ),
            )
          : Option.none<PersistedDispatchConnectEnvironmentConfig>();
        const previousCredential = yield* secrets
          .get(DISPATCH_CONNECT_ENVIRONMENT_CREDENTIAL_SECRET)
          .pipe(Effect.mapError((cause) => asError("read-credential", cause)));
        const connection: DispatchConnectEnvironmentConnection = {
          baseUrl: yield* canonicalBaseUrl(input.baseUrl),
          environmentId: DispatchConnectControlPlaneEnvironmentId.make(input.environmentId),
        };
        const encodedConfig = yield* encodeEnvironmentConfig({
          version: 1,
          ...connection,
        }).pipe(Effect.mapError((cause) => asError("write-config", cause)));
        yield* secrets
          .set(DISPATCH_CONNECT_ENVIRONMENT_CREDENTIAL_SECRET, stringToBytes(input.credential))
          .pipe(Effect.mapError((cause) => asError("write-credential", cause)));
        yield* secrets
          .set(DISPATCH_CONNECT_ENVIRONMENT_CONFIG_SECRET, stringToBytes(encodedConfig))
          .pipe(
            Effect.mapError((cause) => asError("write-config", cause)),
            Effect.catch((error) => {
              const restoreCredential = Option.match(previousCredential, {
                onNone: () => secrets.remove(DISPATCH_CONNECT_ENVIRONMENT_CREDENTIAL_SECRET),
                onSome: (value) =>
                  secrets.set(DISPATCH_CONNECT_ENVIRONMENT_CREDENTIAL_SECRET, value),
              });
              return restoreCredential.pipe(
                Effect.catchCause((cause) =>
                  Effect.logWarning(
                    "Failed to restore Dispatch Connect credential after config error",
                    {
                      cause,
                    },
                  ),
                ),
                Effect.andThen(Effect.fail(error)),
              );
            }),
          );
        const connectionChanged = Option.match(previousConfig, {
          onNone: () => true,
          onSome: (previous) =>
            previous.baseUrl !== connection.baseUrl ||
            previous.environmentId !== connection.environmentId,
        });
        if (connectionChanged)
          yield* secrets
            .remove(DISPATCH_CONNECT_SMART_ROUTING_SESSION_SECRET)
            .pipe(Effect.mapError((cause) => asError("remove-credential", cause)));
        return {
          configured: true,
          connection,
        } satisfies DispatchConnectEnvironmentStatus;
      }),
    );

  const disable: DispatchConnectEnvironment["Service"]["disable"] = () =>
    mutationSemaphore.withPermits(1)(
      Effect.gen(function* () {
        yield* endpointRuntime.applyConfig(null);
        const remoteCleanupSucceeded = yield* cleanupRemoteManagedEndpoint();
        if (!remoteCleanupSucceeded) {
          yield* Effect.logWarning(
            "Dispatch Connect was disabled locally but managed tunnel cleanup did not complete",
          );
        }
        yield* secrets
          .remove(DISPATCH_CONNECT_MANAGED_ENDPOINT_CONFIG_SECRET)
          .pipe(Effect.mapError((cause) => asError("remove-managed-endpoint", cause)));
        yield* secrets
          .remove(DISPATCH_CONNECT_ENVIRONMENT_CONFIG_SECRET)
          .pipe(Effect.mapError((cause) => asError("remove-config", cause)));
        yield* secrets
          .remove(DISPATCH_CONNECT_ENVIRONMENT_CREDENTIAL_SECRET)
          .pipe(Effect.mapError((cause) => asError("remove-credential", cause)));
        yield* secrets
          .remove(DISPATCH_CONNECT_SMART_ROUTING_SESSION_SECRET)
          .pipe(Effect.mapError((cause) => asError("remove-credential", cause)));
        return { configured: false } satisfies DispatchConnectEnvironmentStatus;
      }),
    );

  const registerPairing: DispatchConnectEnvironment["Service"]["registerPairing"] = (challenge) =>
    mutationSemaphore.withPermits(1)(
      Effect.gen(function* () {
        const configured = yield* readConfiguredConnection();
        if (Option.isNone(configured)) return false;
        const baseUrl = configured.value.connection.baseUrl.replace(/\/+$/u, "");
        const url = `${baseUrl}/v1/environments/${encodeURIComponent(configured.value.connection.environmentId)}/pairings`;
        const response = yield* HttpClientRequest.post(url).pipe(
          HttpClientRequest.bearerToken(configured.value.credential),
          HttpClientRequest.bodyJson({
            code: challenge.shortCode,
            expiresAt: DateTime.formatIso(challenge.expiresAt),
          }),
          Effect.flatMap(httpClient.execute),
          Effect.flatMap(HttpClientResponse.filterStatusOk),
          Effect.flatMap(
            HttpClientResponse.schemaBodyJson(DispatchConnectPairingRegistrationResponse),
          ),
          // HttpClient failures can retain the originating request. Do not
          // carry that object into logs because it contains the dce bearer.
          Effect.mapError(() =>
            asError("register-pairing", new Error("Dispatch Connect rendezvous request failed.")),
          ),
        );
        if (response.pairing.code !== challenge.shortCode) {
          return yield* asError(
            "register-pairing",
            new Error("Dispatch Connect registered a different pairing code."),
          );
        }
        return true;
      }),
    );

  const getManagedEndpointStatus: DispatchConnectEnvironment["Service"]["getManagedEndpointStatus"] =
    Effect.fn("DispatchConnectEnvironment.getManagedEndpointStatus")(function* () {
      const config = yield* readManagedEndpointConfig();
      if (Option.isNone(config)) return { status: "disabled" };
      return managedEndpointStatus(yield* endpointRuntime.applyConfig(config.value));
    });

  const persistAndApplyManagedEndpoint = Effect.fn(
    "DispatchConnectEnvironment.persistAndApplyManagedEndpoint",
  )(function* (config: DispatchConnectManagedEndpointConfig) {
    const encoded = yield* encodeManagedEndpointConfig(config).pipe(
      Effect.mapError((cause) => asError("write-managed-endpoint", cause)),
    );
    yield* secrets
      .set(DISPATCH_CONNECT_MANAGED_ENDPOINT_CONFIG_SECRET, stringToBytes(encoded))
      .pipe(Effect.mapError((cause) => asError("write-managed-endpoint", cause)));
    return managedEndpointStatus(yield* endpointRuntime.applyConfig(config));
  });

  const ensureManagedEndpoint: DispatchConnectEnvironment["Service"]["ensureManagedEndpoint"] =
    () =>
      mutationSemaphore.withPermits(1)(
        Effect.gen(function* () {
          const configured = yield* readConfiguredConnection();
          if (Option.isNone(configured)) {
            return yield* asError(
              "ensure-managed-endpoint",
              new Error("Dispatch Connect is not configured for this environment."),
            );
          }

          const runtimeState = yield* readPersistedServerRuntimeState(
            serverConfig.serverRuntimeStatePath,
          ).pipe(Effect.provideService(FileSystem.FileSystem, fileSystem));
          if (Option.isNone(runtimeState) || runtimeState.value.port <= 0) {
            return yield* asError(
              "ensure-managed-endpoint",
              new Error("Dispatch server runtime origin is unavailable."),
            );
          }

          const initialRelayStatus = yield* relayClient.resolve;
          if (initialRelayStatus.status === "unsupported") {
            return {
              status: "unsupported",
              providerKind: "cloudflare_tunnel",
            } satisfies DispatchConnectManagedEndpointStatus;
          }

          const baseUrl = configured.value.connection.baseUrl.replace(/\/+$/u, "");
          const url = `${baseUrl}/v1/environments/${encodeURIComponent(configured.value.connection.environmentId)}/managed-tunnel`;
          const upstreamResponse = yield* HttpClientRequest.post(url).pipe(
            HttpClientRequest.bearerToken(configured.value.credential),
            HttpClientRequest.bodyJson({
              localOrigin: `http://127.0.0.1:${runtimeState.value.port}`,
            }),
            Effect.flatMap(httpClient.execute),
            Effect.mapError(() =>
              asError(
                "ensure-managed-endpoint",
                new Error("Dispatch Connect managed tunnel request failed."),
              ),
            ),
          );
          if (upstreamResponse.status === 503) {
            yield* Effect.ignore(upstreamResponse.text);
            return {
              status: "unsupported",
              providerKind: "cloudflare_tunnel",
            } satisfies DispatchConnectManagedEndpointStatus;
          }
          const response = yield* upstreamResponse.pipe(
            HttpClientResponse.filterStatusOk,
            Effect.flatMap(
              HttpClientResponse.schemaBodyJson(DispatchConnectManagedEndpointProvisionResponse),
            ),
            Effect.mapError(() =>
              asError(
                "ensure-managed-endpoint",
                new Error("Dispatch Connect managed tunnel request failed."),
              ),
            ),
          );

          if (initialRelayStatus.status === "missing") {
            const installResult = yield* Effect.result(relayClient.install);
            if (Result.isFailure(installResult)) {
              return {
                status: "failed",
                providerKind: "cloudflare_tunnel",
                reason: "Could not install the managed Cloudflare connector.",
              } satisfies DispatchConnectManagedEndpointStatus;
            }
          }

          return yield* persistAndApplyManagedEndpoint(
            DispatchConnectManagedEndpointConfig.make({
              providerKind: "cloudflare_tunnel",
              connectorToken: response.connectorToken,
              tunnelId: response.tunnel.tunnelId,
              tunnelName: response.tunnel.tunnelName,
            }),
          );
        }),
      );

  const cleanupRemoteManagedEndpoint = Effect.fn(
    "DispatchConnectEnvironment.cleanupRemoteManagedEndpoint",
  )(function* () {
    const configured = yield* readConfiguredConnection();
    if (Option.isNone(configured)) return true;
    const baseUrl = configured.value.connection.baseUrl.replace(/\/+$/u, "");
    const url = `${baseUrl}/v1/environments/${encodeURIComponent(configured.value.connection.environmentId)}/managed-tunnel`;
    const cleanupResult = yield* Effect.result(
      HttpClientRequest.delete(url).pipe(
        HttpClientRequest.bearerToken(configured.value.credential),
        httpClient.execute,
      ),
    );
    return (
      Result.isSuccess(cleanupResult) &&
      (cleanupResult.success.status === 404 ||
        (cleanupResult.success.status >= 200 && cleanupResult.success.status < 300))
    );
  });

  const disableManagedEndpoint: DispatchConnectEnvironment["Service"]["disableManagedEndpoint"] =
    () =>
      mutationSemaphore.withPermits(1)(
        Effect.gen(function* () {
          yield* endpointRuntime.applyConfig(null);
          const remoteCleanupSucceeded = yield* cleanupRemoteManagedEndpoint();
          yield* secrets
            .remove(DISPATCH_CONNECT_MANAGED_ENDPOINT_CONFIG_SECRET)
            .pipe(Effect.mapError((cause) => asError("remove-managed-endpoint", cause)));
          return remoteCleanupSucceeded
            ? ({ status: "disabled" } satisfies DispatchConnectManagedEndpointStatus)
            : ({
                status: "failed",
                providerKind: "cloudflare_tunnel",
                reason: "Local connector stopped, but remote managed tunnel cleanup failed.",
              } satisfies DispatchConnectManagedEndpointStatus);
        }),
      );

  const service = DispatchConnectEnvironment.of({
    getIdentity,
    getStatus,
    configure,
    disable,
    registerPairing,
    getManagedEndpointStatus,
    ensureManagedEndpoint,
    disableManagedEndpoint,
  });

  yield* readManagedEndpointConfig().pipe(
    Effect.flatMap(
      Option.match({
        onNone: () => Effect.void,
        onSome: (config) => endpointRuntime.applyConfig(config).pipe(Effect.asVoid),
      }),
    ),
    Effect.catch((cause) =>
      Effect.logWarning("Failed to restore Dispatch Connect managed endpoint configuration", {
        cause,
      }),
    ),
  );

  return service;
});

export const layer = Layer.effect(DispatchConnectEnvironment, make);

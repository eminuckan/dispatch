// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";

import * as NodeServices from "@effect/platform-node/NodeServices";
import * as RelayClient from "@dispatch/shared/relayClient";
import {
  DispatchConnectEnvironmentConfigureInput,
  DispatchConnectPairingChallenge,
  EnvironmentId,
} from "@dispatch/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";

import * as ManagedEndpointRuntime from "../cloud/ManagedEndpointRuntime.ts";
import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import {
  makePersistedServerRuntimeState,
  persistServerRuntimeState,
} from "../serverRuntimeState.ts";
import {
  DISPATCH_CONNECT_ENVIRONMENT_CONFIG_SECRET,
  DISPATCH_CONNECT_ENVIRONMENT_CREDENTIAL_SECRET,
  DISPATCH_CONNECT_MANAGED_ENDPOINT_CONFIG_SECRET,
  DISPATCH_CONNECT_SMART_ROUTING_SESSION_SECRET,
  DispatchConnectEnvironment,
  DispatchConnectEnvironmentError,
  layer,
} from "./DispatchConnectEnvironment.ts";
import * as ServerSecretStore from "./ServerSecretStore.ts";

const DCE_CREDENTIAL = `dce_${"A".repeat(43)}`;
const decodeConfigureInput = Schema.decodeUnknownSync(DispatchConnectEnvironmentConfigureInput);
const decodePairingChallenge = Schema.decodeUnknownSync(DispatchConnectPairingChallenge);
const decodePairingRequestBody = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({
      code: Schema.String,
      expiresAt: Schema.String,
    }),
  ),
);
const decodeManagedTunnelRequestBody = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Struct({ localOrigin: Schema.String })),
);

interface CapturedRequest {
  readonly url: string;
  readonly authorization: string | undefined;
  readonly body: Record<string, unknown>;
}

const makeTestLayer = (input: {
  readonly prefix: string;
  readonly requests?: CapturedRequest[];
  readonly appliedRuntimeConfigs?: Array<unknown>;
  readonly responseStatus?: number;
  readonly relayStatus?: RelayClient.RelayClientStatus;
  readonly relayInstalls?: { count: number };
}) => {
  const configLayer = ServerConfig.layerTest(process.cwd(), { prefix: input.prefix });
  const secretStoreLayer = ServerSecretStore.layer.pipe(Layer.provide(configLayer));
  const environmentLayer = Layer.succeed(ServerEnvironment.ServerEnvironment, {
    getEnvironmentId: Effect.succeed(EnvironmentId.make("local-environment")),
    getDescriptor: Effect.succeed({
      environmentId: EnvironmentId.make("local-environment"),
      label: "Dispatch workstation",
      platform: { os: "darwin" as const, arch: "arm64" as const },
      serverVersion: "0.0.0-test",
      capabilities: { repositoryIdentity: true },
    }),
  });
  const endpointRuntimeLayer = Layer.succeed(
    ManagedEndpointRuntime.CloudManagedEndpointRuntime,
    ManagedEndpointRuntime.CloudManagedEndpointRuntime.of({
      applyConfig: (config) =>
        Effect.sync(() => {
          input.appliedRuntimeConfigs?.push(config);
          return config
            ? {
                status: "running" as const,
                providerKind: "cloudflare_tunnel" as const,
                pid: 123,
                ...(config.tunnelId ? { tunnelId: config.tunnelId } : {}),
                ...(config.tunnelName ? { tunnelName: config.tunnelName } : {}),
              }
            : { status: "disabled" as const };
        }),
    }),
  );
  const availableRelayClient = {
    status: "available" as const,
    executablePath: "/tmp/cloudflared",
    source: "managed" as const,
    version: "test",
  };
  const relayClientLayer = Layer.succeed(
    RelayClient.RelayClient,
    RelayClient.RelayClient.of({
      resolve: Effect.succeed(input.relayStatus ?? availableRelayClient),
      install: Effect.sync(() => {
        if (input.relayInstalls) input.relayInstalls.count += 1;
        return availableRelayClient;
      }),
      installWithProgress: () =>
        Effect.sync(() => {
          if (input.relayInstalls) input.relayInstalls.count += 1;
          return availableRelayClient;
        }),
    }),
  );
  const httpLayer = Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) =>
      Effect.sync(() => {
        const isManagedTunnel = request.url.endsWith("/managed-tunnel");
        const bodyText =
          request.body._tag === "Uint8Array" ? new TextDecoder().decode(request.body.body) : "{}";
        const body =
          request.method === "DELETE"
            ? {}
            : isManagedTunnel
              ? decodeManagedTunnelRequestBody(bodyText)
              : decodePairingRequestBody(bodyText);
        input.requests?.push({
          url: request.url,
          authorization: request.headers.authorization,
          body,
        });
        const status = input.responseStatus ?? 201;
        if (isManagedTunnel && request.method === "DELETE") {
          return HttpClientResponse.fromWeb(
            request,
            Response.json({ deleted: true, remoteCleanup: "complete" }, { status: 200 }),
          );
        }
        if (isManagedTunnel) {
          return HttpClientResponse.fromWeb(
            request,
            status >= 200 && status < 300
              ? Response.json(
                  {
                    endpoint: {
                      kind: "cloudflare_tunnel",
                      httpBaseUrl: "https://env.remote.example",
                      wsBaseUrl: "wss://env.remote.example",
                      updatedAt: "2026-09-20T21:00:00Z",
                    },
                    connectorToken: "dispatch-cloudflare-token",
                    tunnel: {
                      tunnelId: "tunnel-id",
                      tunnelName: "dispatch-environment",
                    },
                  },
                  { status },
                )
              : Response.json({ error: "managed_tunnel_unavailable" }, { status }),
          );
        }
        const pairingBody = body as { readonly code: string; readonly expiresAt: string };
        return HttpClientResponse.fromWeb(
          request,
          status >= 200 && status < 300
            ? Response.json(
                {
                  pairing: {
                    code: pairingBody.code,
                    expiresAt: pairingBody.expiresAt,
                    pairingUri: `dispatch://connect/pair?code=${pairingBody.code}`,
                  },
                },
                { status },
              )
            : new Response("unavailable", { status }),
        );
      }),
    ),
  );

  const serviceLayer = layer.pipe(
    Layer.provide(secretStoreLayer),
    Layer.provide(environmentLayer),
    Layer.provide(endpointRuntimeLayer),
    Layer.provide(relayClientLayer),
    Layer.provide(httpLayer),
    Layer.provide(configLayer),
    Layer.provide(NodeServices.layer),
  );
  return Layer.mergeAll(serviceLayer, secretStoreLayer, configLayer).pipe(
    Layer.provide(NodeServices.layer),
  );
};

describe("DispatchConnectEnvironment", () => {
  it.effect(
    "exposes stable environment identity and stores config separately from the dce credential",
    () =>
      Effect.gen(function* () {
        const service = yield* DispatchConnectEnvironment;
        const secrets = yield* ServerSecretStore.ServerSecretStore;

        const firstIdentity = yield* service.getIdentity();
        const secondIdentity = yield* service.getIdentity();
        assert.equal(firstIdentity.environmentId, "local-environment");
        assert.equal(firstIdentity.label, "Dispatch workstation");
        assert.equal(secondIdentity.publicKey, firstIdentity.publicKey);
        assert.equal(
          NodeCrypto.createPublicKey(firstIdentity.publicKey).asymmetricKeyType,
          "ed25519",
        );
        assert.deepEqual(yield* service.getStatus(), { configured: false });

        const status = yield* service.configure(
          decodeConfigureInput({
            baseUrl: "https://connect.dispatch.example/",
            environmentId: "connect-environment",
            credential: DCE_CREDENTIAL,
          }),
        );
        assert.isTrue(status.configured);
        assert.equal(status.connection?.baseUrl, "https://connect.dispatch.example");
        assert.equal(status.connection?.environmentId, "connect-environment");
        const persistedStatus = yield* service.getStatus();
        assert.isTrue(persistedStatus.configured);
        assert.equal(persistedStatus.connection?.baseUrl, "https://connect.dispatch.example");
        assert.equal(persistedStatus.connection?.environmentId, "connect-environment");

        const storedConfig = yield* secrets.get(DISPATCH_CONNECT_ENVIRONMENT_CONFIG_SECRET);
        const storedCredential = yield* secrets.get(DISPATCH_CONNECT_ENVIRONMENT_CREDENTIAL_SECRET);
        assert.isTrue(Option.isSome(storedConfig));
        assert.isTrue(Option.isSome(storedCredential));
        if (Option.isSome(storedConfig)) {
          const text = new TextDecoder().decode(storedConfig.value);
          assert.notInclude(text, DCE_CREDENTIAL);
          assert.include(text, "connect-environment");
        }
        if (Option.isSome(storedCredential)) {
          assert.equal(new TextDecoder().decode(storedCredential.value), DCE_CREDENTIAL);
        }
        yield* secrets.set(
          DISPATCH_CONNECT_SMART_ROUTING_SESSION_SECRET,
          new TextEncoder().encode("account-session"),
        );
        const changed = yield* service.configure(
          decodeConfigureInput({
            baseUrl: "https://connect.dispatch.example/",
            environmentId: "connect-environment-2",
            credential: DCE_CREDENTIAL,
          }),
        );
        assert.equal(changed.connection?.environmentId, "connect-environment-2");
        assert.isTrue(
          Option.isNone(yield* secrets.get(DISPATCH_CONNECT_SMART_ROUTING_SESSION_SECRET)),
        );
        yield* secrets.set(
          DISPATCH_CONNECT_SMART_ROUTING_SESSION_SECRET,
          new TextEncoder().encode("account-session"),
        );

        assert.deepEqual(yield* service.disable(), { configured: false });
        assert.isTrue(
          Option.isNone(yield* secrets.get(DISPATCH_CONNECT_ENVIRONMENT_CONFIG_SECRET)),
        );
        assert.isTrue(
          Option.isNone(yield* secrets.get(DISPATCH_CONNECT_ENVIRONMENT_CREDENTIAL_SECRET)),
        );
        assert.isTrue(
          Option.isNone(yield* secrets.get(DISPATCH_CONNECT_SMART_ROUTING_SESSION_SECRET)),
        );
      }).pipe(
        Effect.provide(makeTestLayer({ prefix: "dispatch-connect-environment-config-test-" })),
      ),
  );

  it.effect(
    "registers the canonical environment pairing code and expiry using dce bearer auth",
    () => {
      const requests: CapturedRequest[] = [];
      return Effect.gen(function* () {
        const service = yield* DispatchConnectEnvironment;
        yield* service.configure(
          decodeConfigureInput({
            baseUrl: "https://connect.dispatch.example",
            environmentId: "connect-environment",
            credential: DCE_CREDENTIAL,
          }),
        );
        const expiresAt = DateTime.makeUnsafe("2026-09-20T21:00:00Z");
        const registered = yield* service.registerPairing(
          decodePairingChallenge({
            pairingId: "pairing-id",
            shortCode: "2345-ABCD-JKLM",
            pairingUrl: "https://environment.example/pair#token=2345ABCDJKLM",
            expiresAt,
          }),
        );

        assert.isTrue(registered);
        assert.deepEqual(requests, [
          {
            url: "https://connect.dispatch.example/v1/environments/connect-environment/pairings",
            authorization: `Bearer ${DCE_CREDENTIAL}`,
            body: {
              code: "2345-ABCD-JKLM",
              expiresAt: DateTime.formatIso(expiresAt),
            },
          },
        ]);
      }).pipe(
        Effect.provide(
          makeTestLayer({ prefix: "dispatch-connect-pairing-register-test-", requests }),
        ),
      );
    },
  );

  it.effect("fails registration when a configured Connect service rejects the rendezvous", () =>
    Effect.gen(function* () {
      const service = yield* DispatchConnectEnvironment;
      yield* service.configure(
        decodeConfigureInput({
          baseUrl: "https://connect.dispatch.example",
          environmentId: "connect-environment",
          credential: DCE_CREDENTIAL,
        }),
      );
      const error = yield* Effect.flip(
        service.registerPairing(
          decodePairingChallenge({
            pairingId: "pairing-id",
            shortCode: "2345-ABCD-JKLM",
            pairingUrl: "https://environment.example/pair#token=2345ABCDJKLM",
            expiresAt: DateTime.makeUnsafe("2026-09-20T21:00:00Z"),
          }),
        ),
      );
      assert.instanceOf(error, DispatchConnectEnvironmentError);
      assert.equal(error.operation, "register-pairing");
    }).pipe(
      Effect.provide(
        makeTestLayer({
          prefix: "dispatch-connect-pairing-failure-test-",
          responseStatus: 503,
        }),
      ),
    ),
  );

  it.effect(
    "provisions, persists, reports, and disables the Dispatch-managed Cloudflare runtime",
    () => {
      const appliedRuntimeConfigs: Array<unknown> = [];
      const requests: CapturedRequest[] = [];
      return Effect.gen(function* () {
        const service = yield* DispatchConnectEnvironment;
        const secrets = yield* ServerSecretStore.ServerSecretStore;
        const config = yield* ServerConfig.ServerConfig;

        yield* persistServerRuntimeState({
          path: config.serverRuntimeStatePath,
          state: yield* makePersistedServerRuntimeState({ config, port: 43173 }),
        }).pipe(Effect.provide(NodeServices.layer));
        yield* service.configure(
          decodeConfigureInput({
            baseUrl: "https://connect.dispatch.example",
            environmentId: "connect-environment",
            credential: DCE_CREDENTIAL,
          }),
        );

        assert.deepEqual(yield* service.getManagedEndpointStatus(), { status: "disabled" });
        assert.deepEqual(yield* service.ensureManagedEndpoint(), {
          status: "running",
          providerKind: "cloudflare_tunnel",
          tunnelId: "tunnel-id",
          tunnelName: "dispatch-environment",
        });
        assert.deepEqual(requests[0], {
          url: "https://connect.dispatch.example/v1/environments/connect-environment/managed-tunnel",
          authorization: `Bearer ${DCE_CREDENTIAL}`,
          body: { localOrigin: "http://127.0.0.1:43173" },
        });
        assert.isTrue(
          Option.isSome(yield* secrets.get(DISPATCH_CONNECT_MANAGED_ENDPOINT_CONFIG_SECRET)),
        );
        assert.deepEqual(yield* service.disableManagedEndpoint(), { status: "disabled" });
        assert.isTrue(
          Option.isNone(yield* secrets.get(DISPATCH_CONNECT_MANAGED_ENDPOINT_CONFIG_SECRET)),
        );
        assert.deepEqual(appliedRuntimeConfigs.at(-1), null);
      }).pipe(
        Effect.provide(
          makeTestLayer({
            prefix: "dispatch-connect-managed-endpoint-test-",
            appliedRuntimeConfigs,
            requests,
          }),
        ),
      );
    },
  );

  it.effect("installs cloudflared automatically when the managed connector is missing", () => {
    const relayInstalls = { count: 0 };
    return Effect.gen(function* () {
      const service = yield* DispatchConnectEnvironment;
      const config = yield* ServerConfig.ServerConfig;
      yield* persistServerRuntimeState({
        path: config.serverRuntimeStatePath,
        state: yield* makePersistedServerRuntimeState({ config, port: 43174 }),
      }).pipe(Effect.provide(NodeServices.layer));
      yield* service.configure(
        decodeConfigureInput({
          baseUrl: "https://connect.dispatch.example",
          environmentId: "connect-environment",
          credential: DCE_CREDENTIAL,
        }),
      );

      const status = yield* service.ensureManagedEndpoint();
      assert.equal(relayInstalls.count, 1);
      assert.equal(status.status, "running");
    }).pipe(
      Effect.provide(
        makeTestLayer({
          prefix: "dispatch-connect-managed-endpoint-install-test-",
          relayStatus: { status: "missing", version: "test" },
          relayInstalls,
        }),
      ),
    );
  });

  it.effect(
    "does not install cloudflared when the Connect deployment has no managed tunnel",
    () => {
      const relayInstalls = { count: 0 };
      return Effect.gen(function* () {
        const service = yield* DispatchConnectEnvironment;
        const config = yield* ServerConfig.ServerConfig;
        yield* persistServerRuntimeState({
          path: config.serverRuntimeStatePath,
          state: yield* makePersistedServerRuntimeState({ config, port: 43175 }),
        }).pipe(Effect.provide(NodeServices.layer));
        yield* service.configure(
          decodeConfigureInput({
            baseUrl: "https://connect.dispatch.example",
            environmentId: "connect-environment",
            credential: DCE_CREDENTIAL,
          }),
        );

        assert.deepEqual(yield* service.ensureManagedEndpoint(), {
          status: "unsupported",
          providerKind: "cloudflare_tunnel",
        });
        assert.equal(relayInstalls.count, 0);
      }).pipe(
        Effect.provide(
          makeTestLayer({
            prefix: "dispatch-connect-managed-endpoint-disabled-test-",
            responseStatus: 503,
            relayStatus: { status: "missing", version: "test" },
            relayInstalls,
          }),
        ),
      );
    },
  );
});

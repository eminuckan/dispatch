import * as NodeServices from "@effect/platform-node/NodeServices";
import { EnvironmentHttpApi, EnvironmentId } from "@dispatch/contracts";
import { expect, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as Etag from "effect/unstable/http/Etag";
import * as HttpPlatform from "effect/unstable/http/HttpPlatform";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";
import * as HttpApi from "effect/unstable/httpapi/HttpApi";
import * as HttpRouter from "effect/unstable/http/HttpRouter";

import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import * as EnvironmentAuth from "./EnvironmentAuth.ts";
import * as DispatchConnectEnvironment from "./DispatchConnectEnvironment.ts";
import * as ServerSecretStore from "./ServerSecretStore.ts";
import { authHttpApiLayer, environmentAuthenticatedAuthLayer } from "./http.ts";

const DEV_TOKEN = "reusable-dev-auth-token-that-is-long-enough";
class AuthTestApi extends HttpApi.make("environment").add(EnvironmentHttpApi.groups.auth) {}

const configLayer = Layer.effect(
  ServerConfig.ServerConfig,
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    return {
      ...config,
      mode: "web",
      devUrl: new URL("http://127.0.0.1:5173"),
      devAuthToken: Redacted.make(DEV_TOKEN),
    } satisfies ServerConfig.ServerConfig["Service"];
  }),
).pipe(Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-auth-http-test-" })));

const environmentAuthLayer = EnvironmentAuth.layer.pipe(
  Layer.provide(SqlitePersistenceMemory),
  Layer.provide(ServerSecretStore.layer),
  Layer.provide(ServerEnvironment.identityLayer),
  Layer.provide(configLayer),
);
let failDispatchConnectRegistration = false;
const dispatchConnectLayer = Layer.succeed(
  DispatchConnectEnvironment.DispatchConnectEnvironment,
  DispatchConnectEnvironment.DispatchConnectEnvironment.of({
    getIdentity: () =>
      Effect.succeed({
        environmentId: EnvironmentId.make("dispatch-connect-test-environment"),
        label: "Dispatch Connect test environment",
        publicKey: "test-ed25519-public-key",
      }),
    getStatus: () => Effect.succeed({ configured: false }),
    configure: (input) =>
      Effect.succeed({
        configured: true,
        connection: { baseUrl: input.baseUrl, environmentId: input.environmentId },
      }),
    disable: () => Effect.succeed({ configured: false }),
    registerPairing: () =>
      failDispatchConnectRegistration
        ? Effect.fail(
            new DispatchConnectEnvironment.DispatchConnectEnvironmentError({
              operation: "register-pairing",
              cause: new Error("Connect unavailable"),
            }),
          )
        : Effect.succeed(false),
    getManagedEndpointStatus: () => Effect.succeed({ status: "disabled" }),
    ensureManagedEndpoint: () =>
      Effect.succeed({
        status: "running",
        providerKind: "cloudflare_tunnel",
        tunnelId: "tunnel-id",
      }),
    disableManagedEndpoint: () => Effect.succeed({ status: "disabled" }),
  }),
);
const routesLayer = HttpApiBuilder.layer(AuthTestApi).pipe(
  Layer.provide(authHttpApiLayer),
  Layer.provide(environmentAuthenticatedAuthLayer),
  Layer.provide(dispatchConnectLayer),
  Layer.provideMerge(environmentAuthLayer),
  Layer.provide(configLayer),
  Layer.provideMerge(
    HttpPlatform.layer.pipe(
      Layer.provideMerge(NodeServices.layer),
      Layer.provideMerge(Etag.layerWeak),
    ),
  ),
  Layer.provide(NodeServices.layer),
);

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const postJson = (path: string, body: unknown, headers?: Readonly<Record<string, string>>) =>
  new Request(`http://127.0.0.1${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: encodeJson(body),
  });

it.effect("sets the selected browser session cookies through the HTTP route", () =>
  Effect.gen(function* () {
    const crypto = yield* Crypto.Crypto;
    const unusedSecretStore = ServerSecretStore.ServerSecretStore.of({
      get: () => Effect.succeed(Option.none()),
      set: () => Effect.void,
      create: () => Effect.void,
      getOrCreateRandom: () => Effect.die("Not used by these routes."),
      remove: () => Effect.void,
    });
    const requestContext = Context.make(Crypto.Crypto, crypto).pipe(
      Context.add(ServerSecretStore.ServerSecretStore, unusedSecretStore),
    );
    return yield* Effect.acquireUseRelease(
      Effect.sync(
        () =>
          [
            HttpRouter.toWebHandler(routesLayer, { disableLogger: true }),
            HttpRouter.toWebHandler(routesLayer, { disableLogger: true }),
          ] as const,
      ),
      ([environmentA, environmentB]) =>
        Effect.tryPromise(async () => {
          const devResponse = await environmentA.handler(
            postJson("/api/auth/browser-session", { credential: DEV_TOKEN }),
            requestContext,
          );
          expect(devResponse.status).toBe(200);
          const devCookies = devResponse.headers.getSetCookie();
          const devCookie = devCookies.find((cookie) => cookie.startsWith("t3_dev_session_"));
          expect(devCookie).toContain("HttpOnly");
          expect(devCookie).toContain(`=${DEV_TOKEN};`);
          expect(devCookies).toContainEqual(
            expect.stringMatching(/^t3_session_[^=]*=;.*Max-Age=0/),
          );
          const devCookieHeader = devCookie?.split(";", 1)[0] ?? "";
          const environmentBSession = await environmentB.handler(
            new Request("http://127.0.0.1/api/auth/session", {
              headers: { cookie: devCookieHeader },
            }),
            requestContext,
          );
          expect(environmentBSession.status).toBe(200);
          expect(await environmentBSession.json()).toMatchObject({ authenticated: true });

          const connectIdentityResponse = await environmentA.handler(
            new Request("http://127.0.0.1/api/auth/dispatch-connect/identity", {
              headers: { cookie: devCookieHeader },
            }),
            requestContext,
          );
          expect(connectIdentityResponse.status).toBe(200);
          expect(await connectIdentityResponse.json()).toMatchObject({
            environmentId: "dispatch-connect-test-environment",
            label: "Dispatch Connect test environment",
            publicKey: "test-ed25519-public-key",
          });

          const connectConfigureResponse = await environmentA.handler(
            postJson(
              "/api/auth/dispatch-connect/configure",
              {
                baseUrl: "https://connect.dispatch.example",
                environmentId: "connect-environment",
                credential: `dce_${"A".repeat(43)}`,
              },
              { cookie: devCookieHeader },
            ),
            requestContext,
          );
          expect(connectConfigureResponse.status).toBe(200);
          expect(await connectConfigureResponse.json()).toMatchObject({ configured: true });

          const managedEndpointResponse = await environmentA.handler(
            postJson(
              "/api/auth/dispatch-connect/managed-endpoint/ensure",
              {},
              { cookie: devCookieHeader },
            ),
            requestContext,
          );
          expect(managedEndpointResponse.status).toBe(200);
          expect(await managedEndpointResponse.json()).toMatchObject({
            status: "running",
            providerKind: "cloudflare_tunnel",
            tunnelId: "tunnel-id",
          });

          const pairingResponse = await environmentA.handler(
            postJson(
              "/api/auth/pairing-token",
              { scopes: ["orchestration:read"] },
              { cookie: devCookieHeader },
            ),
            requestContext,
          );
          expect(pairingResponse.status).toBe(200);
          const pairing = (await pairingResponse.json()) as { credential: string };
          const restrictedResponse = await environmentA.handler(
            postJson("/api/auth/browser-session", { credential: pairing.credential }),
            requestContext,
          );
          expect(restrictedResponse.status).toBe(200);
          const restrictedCookies = restrictedResponse.headers.getSetCookie();
          expect(restrictedCookies).toHaveLength(1);
          expect(restrictedCookies[0]).toMatch(/^t3_session_/);
          expect(restrictedCookies[0]).not.toContain("t3_dev_session_");

          const connectPairingResponse = await environmentA.handler(
            postJson(
              "/api/auth/dispatch-connect/pairing",
              { label: "Remote phone", scopes: ["orchestration:read"] },
              { cookie: devCookieHeader },
            ),
            requestContext,
          );
          expect(connectPairingResponse.status).toBe(200);
          expect(connectPairingResponse.headers.get("cache-control")).toBe("no-store");
          const connectPairing = (await connectPairingResponse.json()) as {
            shortCode: string;
            pairingUrl: string;
          };
          expect(connectPairing.shortCode).toMatch(
            /^[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{4}(?:-[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{4}){2}$/,
          );
          const normalizedCode = connectPairing.shortCode.replaceAll("-", "");
          const connectPairingUrl = new URL(connectPairing.pairingUrl);
          expect(connectPairingUrl.pathname).toBe("/pair");
          expect(new URLSearchParams(connectPairingUrl.hash.slice(1)).get("token")).toBe(
            normalizedCode,
          );

          const connectSessionResponse = await environmentA.handler(
            postJson("/api/auth/browser-session", { credential: connectPairing.shortCode }),
            requestContext,
          );
          expect(connectSessionResponse.status).toBe(200);

          failDispatchConnectRegistration = true;
          const failedConnectPairingResponse = await environmentA.handler(
            postJson(
              "/api/auth/dispatch-connect/pairing",
              { label: "Failed rendezvous" },
              { cookie: devCookieHeader },
            ),
            requestContext,
          );
          failDispatchConnectRegistration = false;
          expect(failedConnectPairingResponse.status).toBe(500);
          expect(await failedConnectPairingResponse.json()).toMatchObject({
            reason: "dispatch_connect_pairing_registration_failed",
          });

          const pairingLinksResponse = await environmentA.handler(
            new Request("http://127.0.0.1/api/auth/pairing-links", {
              headers: { cookie: devCookieHeader },
            }),
            requestContext,
          );
          expect(pairingLinksResponse.status).toBe(200);
          const pairingLinks = (await pairingLinksResponse.json()) as Array<{ label?: string }>;
          expect(pairingLinks.some((link) => link.label === "Failed rendezvous")).toBe(false);
        }),
      ([environmentA, environmentB]) =>
        Effect.promise(() => Promise.all([environmentA.dispose(), environmentB.dispose()])),
    );
  }).pipe(Effect.provide(NodeServices.layer)),
);

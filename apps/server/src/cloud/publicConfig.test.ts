import { assert, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";

import {
  hostedAppUrlConfig,
  makeCloudCliOAuthConfig,
  makeRelayUrlConfig,
  resolveHasCloudPublicConfig,
  resolveRelayClientTracingConfig,
} from "./publicConfig.ts";

const provideEnv = (env: Readonly<Record<string, string>>) =>
  Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env })));

it.effect("uses the statically injected relay URL when no runtime override exists", () =>
  Effect.gen(function* () {
    const relayUrl = yield* makeRelayUrlConfig("https://embedded.example.test///").pipe(
      provideEnv({}),
    );

    assert.equal(relayUrl, "https://embedded.example.test");
  }),
);

it.effect("prefers the Dispatch relay URL over legacy and statically injected values", () =>
  Effect.gen(function* () {
    const relayUrl = yield* makeRelayUrlConfig("https://embedded.example.test").pipe(
      provideEnv({
        DISPATCH_RELAY_URL: "https://dispatch.example.test///",
        T3CODE_RELAY_URL: "https://legacy.example.test",
      }),
    );

    assert.equal(relayUrl, "https://dispatch.example.test");
  }),
);

it.effect("accepts the legacy relay URL when the Dispatch name is absent", () =>
  Effect.gen(function* () {
    const relayUrl = yield* makeRelayUrlConfig("").pipe(
      provideEnv({ T3CODE_RELAY_URL: "https://legacy.example.test///" }),
    );

    assert.equal(relayUrl, "https://legacy.example.test");
  }),
);

it.effect("requires a relay URL when the server bundle has no injected value", () =>
  makeRelayUrlConfig("").pipe(provideEnv({}), Effect.flip),
);

it.effect("rejects an insecure runtime relay URL override", () =>
  makeRelayUrlConfig("https://embedded.example.test").pipe(
    provideEnv({ T3CODE_RELAY_URL: "http://runtime.example.test" }),
    Effect.flip,
  ),
);

it.effect("rejects an injected relay URL with a non-origin path", () =>
  makeRelayUrlConfig("https://embedded.example.test/path").pipe(provideEnv({}), Effect.flip),
);

it.effect("normalizes the hosted app URL to an absolute origin", () =>
  Effect.gen(function* () {
    assert.equal(
      yield* hostedAppUrlConfig.pipe(
        provideEnv({
          DISPATCH_HOSTED_APP_URL: "https://dispatch.example.test",
          T3CODE_HOSTED_APP_URL: "https://legacy.example.test",
        }),
      ),
      "https://dispatch.example.test",
    );
    assert.equal(
      yield* hostedAppUrlConfig.pipe(
        provideEnv({ T3CODE_HOSTED_APP_URL: "http://localhost:5733" }),
      ),
      "http://localhost:5733",
    );
  }),
);

it.effect("requires an explicit hosted app URL instead of defaulting to upstream", () =>
  hostedAppUrlConfig.pipe(provideEnv({}), Effect.flip),
);

it.effect("rejects malformed or insecure hosted app URLs", () =>
  Effect.gen(function* () {
    for (const value of [
      "app.t3.codes",
      "http://app.t3.codes",
      "https://app.t3.codes/nested",
      "https://app.t3.codes?alias=true",
    ]) {
      const result = yield* hostedAppUrlConfig.pipe(
        provideEnv({ T3CODE_HOSTED_APP_URL: value }),
        Effect.result,
      );
      assert.isTrue(Result.isFailure(result), value);
    }
  }),
);

it.effect("derives direct Clerk OAuth endpoints from statically injected public config", () =>
  Effect.gen(function* () {
    const config = yield* makeCloudCliOAuthConfig({
      clerkPublishableKeyFallback: "pk_test_Y2xlcmsuZXhhbXBsZS50ZXN0JA==",
      clerkCliOAuthClientIdFallback: "oauth_client_embedded",
    }).pipe(provideEnv({}));

    assert.deepEqual(config, {
      tokenEndpoint: "https://clerk.example.test/oauth/token",
      deviceAuthorizationEndpoint: "https://clerk.example.test/oauth/device_authorization",
      clientId: "oauth_client_embedded",
      loopbackPort: 34338,
      redirectUri: "http://127.0.0.1:34338/callback",
      scopes: ["openid", "profile", "email", "offline_access"],
    });
  }),
);

it.effect("prefers Dispatch Clerk OAuth config over legacy and statically injected values", () =>
  Effect.gen(function* () {
    const config = yield* makeCloudCliOAuthConfig({
      clerkPublishableKeyFallback: "pk_test_ZW1iZWRkZWQuZXhhbXBsZS50ZXN0JA==",
      clerkCliOAuthClientIdFallback: "oauth_client_embedded",
    }).pipe(
      provideEnv({
        DISPATCH_CLERK_PUBLISHABLE_KEY: "pk_test_ZGlzcGF0Y2guZXhhbXBsZS50ZXN0JA==",
        T3CODE_CLERK_PUBLISHABLE_KEY: "pk_test_bGVnYWN5LmV4YW1wbGUudGVzdCQ=",
        DISPATCH_CLERK_CLI_OAUTH_CLIENT_ID: "oauth_client_dispatch",
        T3CODE_CLERK_CLI_OAUTH_CLIENT_ID: "oauth_client_legacy",
      }),
    );

    assert.equal(config.tokenEndpoint, "https://dispatch.example.test/oauth/token");
    assert.equal(config.clientId, "oauth_client_dispatch");
  }),
);

it.effect("accepts legacy Clerk OAuth config when Dispatch names are absent", () =>
  Effect.gen(function* () {
    const config = yield* makeCloudCliOAuthConfig({
      clerkPublishableKeyFallback: "",
      clerkCliOAuthClientIdFallback: "",
    }).pipe(
      provideEnv({
        T3CODE_CLERK_PUBLISHABLE_KEY: "pk_test_bGVnYWN5LmV4YW1wbGUudGVzdCQ=",
        T3CODE_CLERK_CLI_OAUTH_CLIENT_ID: "oauth_client_legacy",
      }),
    );

    assert.equal(config.tokenEndpoint, "https://legacy.example.test/oauth/token");
    assert.equal(config.clientId, "oauth_client_legacy");
  }),
);

it.effect("requires Clerk OAuth config when the server bundle has no injected values", () =>
  makeCloudCliOAuthConfig({
    clerkPublishableKeyFallback: "",
    clerkCliOAuthClientIdFallback: "",
  }).pipe(provideEnv({}), Effect.flip),
);

it.effect("reports malformed Clerk publishable keys as typed configuration failures", () =>
  Effect.gen(function* () {
    const result = yield* makeCloudCliOAuthConfig({
      clerkPublishableKeyFallback: "pk_test_not-base64!!",
      clerkCliOAuthClientIdFallback: "oauth_client_embedded",
    }).pipe(provideEnv({}), Effect.result);

    assert.isTrue(Result.isFailure(result));
    if (Result.isFailure(result)) {
      assert.equal(result.failure.cause._tag, "SourceError");
      if (result.failure.cause._tag === "SourceError") {
        assert.equal(
          result.failure.cause.message,
          "Failed to derive Clerk Frontend API URL from the publishable key.",
        );
        assert.instanceOf(result.failure.cause.cause, Error);
      }
    }
  }),
);

it("resolves relay client tracing from runtime config with build-time fallback", () => {
  const fallback = {
    tracesUrl: "https://embedded.example.test/v1/traces",
    tracesDataset: "embedded-dataset",
    tracesToken: "embedded-token",
  };

  assert.deepEqual(resolveRelayClientTracingConfig({}, fallback), fallback);
  assert.deepEqual(
    resolveRelayClientTracingConfig(
      {
        DISPATCH_RELAY_CLIENT_OTLP_TRACES_URL: "https://dispatch.example.test/v1/traces",
        T3CODE_RELAY_CLIENT_OTLP_TRACES_URL: "https://legacy.example.test/v1/traces",
        DISPATCH_RELAY_CLIENT_OTLP_TRACES_DATASET: "dispatch-dataset",
        T3CODE_RELAY_CLIENT_OTLP_TRACES_DATASET: "legacy-dataset",
        DISPATCH_RELAY_CLIENT_OTLP_TRACES_TOKEN: "dispatch-token",
        T3CODE_RELAY_CLIENT_OTLP_TRACES_TOKEN: "legacy-token",
      },
      fallback,
    ),
    {
      tracesUrl: "https://dispatch.example.test/v1/traces",
      tracesDataset: "dispatch-dataset",
      tracesToken: "dispatch-token",
    },
  );
  assert.deepEqual(
    resolveRelayClientTracingConfig(
      {
        T3CODE_RELAY_CLIENT_OTLP_TRACES_URL: "https://legacy.example.test/v1/traces",
        T3CODE_RELAY_CLIENT_OTLP_TRACES_DATASET: "legacy-dataset",
        T3CODE_RELAY_CLIENT_OTLP_TRACES_TOKEN: "legacy-token",
      },
      fallback,
    ),
    {
      tracesUrl: "https://legacy.example.test/v1/traces",
      tracesDataset: "legacy-dataset",
      tracesToken: "legacy-token",
    },
  );
  assert.equal(
    resolveRelayClientTracingConfig(
      {
        T3CODE_RELAY_CLIENT_OTLP_TRACES_URL: "http://insecure.example.test/v1/traces",
        T3CODE_RELAY_CLIENT_OTLP_TRACES_DATASET: "runtime-dataset",
        T3CODE_RELAY_CLIENT_OTLP_TRACES_TOKEN: "runtime-token",
      },
      fallback,
    ),
    null,
  );
});

it("resolves cloud public-config presence with Dispatch precedence and legacy fallback", () => {
  const noFallback = {
    relayUrl: "",
    clerkPublishableKey: "",
    clerkCliOAuthClientId: "",
  };

  assert.isTrue(
    resolveHasCloudPublicConfig(
      {
        DISPATCH_RELAY_URL: "https://dispatch.example.test",
        T3CODE_RELAY_URL: "http://legacy-invalid.example.test",
        DISPATCH_CLERK_PUBLISHABLE_KEY: "pk_dispatch",
        T3CODE_CLERK_PUBLISHABLE_KEY: "",
        DISPATCH_CLERK_CLI_OAUTH_CLIENT_ID: "oauth_dispatch",
        T3CODE_CLERK_CLI_OAUTH_CLIENT_ID: "",
      },
      noFallback,
    ),
  );
  assert.isTrue(
    resolveHasCloudPublicConfig(
      {
        T3CODE_RELAY_URL: "https://legacy.example.test",
        T3CODE_CLERK_PUBLISHABLE_KEY: "pk_legacy",
        T3CODE_CLERK_CLI_OAUTH_CLIENT_ID: "oauth_legacy",
      },
      noFallback,
    ),
  );
  assert.isFalse(
    resolveHasCloudPublicConfig(
      {
        DISPATCH_RELAY_URL: "http://dispatch-invalid.example.test",
        T3CODE_RELAY_URL: "https://legacy.example.test",
        DISPATCH_CLERK_PUBLISHABLE_KEY: "pk_dispatch",
        DISPATCH_CLERK_CLI_OAUTH_CLIENT_ID: "oauth_dispatch",
      },
      noFallback,
    ),
  );
});

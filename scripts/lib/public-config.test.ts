// @effect-diagnostics nodeBuiltinImport:off - Tests exercise root env file precedence directly.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { loadRepoEnv, resolvePublicConfig } from "./public-config.ts";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    NodeFS.rmSync(directory, { recursive: true, force: true });
  }
});

describe("loadRepoEnv", () => {
  it("does not project cloud configuration for an unconfigured clone", () => {
    const env = loadRepoEnv({ baseEnv: {}, repoRoot: makeTemporaryDirectory() });

    expect(env.DISPATCH_CONNECT_URL).toBeUndefined();
    expect(env.VITE_DISPATCH_CONNECT_URL).toBeUndefined();
    expect(env.EXPO_PUBLIC_DISPATCH_CONNECT_URL).toBeUndefined();
    expect(env.DISPATCH_CLERK_PUBLISHABLE_KEY).toBeUndefined();
    expect(env.T3CODE_CLERK_PUBLISHABLE_KEY).toBeUndefined();
    expect(env.DISPATCH_CLERK_CLI_OAUTH_CLIENT_ID).toBeUndefined();
    expect(env.T3CODE_CLERK_CLI_OAUTH_CLIENT_ID).toBeUndefined();
    expect(env.VITE_CLERK_PUBLISHABLE_KEY).toBeUndefined();
    expect(env.EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY).toBeUndefined();
    expect(env.DISPATCH_CLERK_JWT_TEMPLATE).toBeUndefined();
    expect(env.T3CODE_CLERK_JWT_TEMPLATE).toBeUndefined();
    expect(env.VITE_CLERK_JWT_TEMPLATE).toBeUndefined();
    expect(env.EXPO_PUBLIC_CLERK_JWT_TEMPLATE).toBeUndefined();
    expect(env.DISPATCH_RELAY_URL).toBeUndefined();
    expect(env.T3CODE_RELAY_URL).toBeUndefined();
    expect(env.VITE_DISPATCH_RELAY_URL).toBeUndefined();
    expect(env.VITE_T3CODE_RELAY_URL).toBeUndefined();
    expect(env.DISPATCH_HOSTED_APP_URL).toBeUndefined();
    expect(env.T3CODE_HOSTED_APP_URL).toBeUndefined();
    expect(env.VITE_HOSTED_APP_URL).toBeUndefined();
    expect(env.DISPATCH_MOBILE_OTLP_TRACES_URL).toBeUndefined();
    expect(env.DISPATCH_MOBILE_OTLP_TRACES_DATASET).toBeUndefined();
    expect(env.DISPATCH_MOBILE_OTLP_TRACES_TOKEN).toBeUndefined();
    expect(env.T3CODE_MOBILE_OTLP_TRACES_URL).toBeUndefined();
    expect(env.T3CODE_MOBILE_OTLP_TRACES_DATASET).toBeUndefined();
    expect(env.T3CODE_MOBILE_OTLP_TRACES_TOKEN).toBeUndefined();
    expect(env.EXPO_PUBLIC_OTLP_TRACES_URL).toBeUndefined();
    expect(env.EXPO_PUBLIC_OTLP_TRACES_DATASET).toBeUndefined();
    expect(env.EXPO_PUBLIC_OTLP_TRACES_TOKEN).toBeUndefined();
    expect(env.DISPATCH_RELAY_CLIENT_OTLP_TRACES_URL).toBeUndefined();
    expect(env.DISPATCH_RELAY_CLIENT_OTLP_TRACES_DATASET).toBeUndefined();
    expect(env.DISPATCH_RELAY_CLIENT_OTLP_TRACES_TOKEN).toBeUndefined();
    expect(env.T3CODE_RELAY_CLIENT_OTLP_TRACES_URL).toBeUndefined();
    expect(env.T3CODE_RELAY_CLIENT_OTLP_TRACES_DATASET).toBeUndefined();
    expect(env.T3CODE_RELAY_CLIENT_OTLP_TRACES_TOKEN).toBeUndefined();
    expect(env.VITE_RELAY_OTLP_TRACES_URL).toBeUndefined();
    expect(env.VITE_RELAY_OTLP_TRACES_DATASET).toBeUndefined();
    expect(env.VITE_RELAY_OTLP_TRACES_TOKEN).toBeUndefined();
  });

  it("applies process, root local, and root precedence while preferring Dispatch aliases", () => {
    const repoRoot = makeTemporaryDirectory();
    NodeFS.writeFileSync(
      NodePath.join(repoRoot, ".env"),
      "T3CODE_CLERK_PUBLISHABLE_KEY=pk_root\nT3CODE_CLERK_JWT_TEMPLATE=template_root\nT3CODE_CLERK_CLI_OAUTH_CLIENT_ID=oauth_root\nT3CODE_RELAY_URL=https://root.example.test\n",
    );
    NodeFS.writeFileSync(
      NodePath.join(repoRoot, ".env.local"),
      "DISPATCH_CLERK_PUBLISHABLE_KEY=pk_local\nDISPATCH_CLERK_JWT_TEMPLATE=template_local\nDISPATCH_CLERK_CLI_OAUTH_CLIENT_ID=oauth_local\nDISPATCH_RELAY_URL=https://local.example.test\n",
    );

    expect(loadRepoEnv({ baseEnv: {}, repoRoot })).toMatchObject({
      DISPATCH_RELAY_URL: "https://local.example.test",
      T3CODE_RELAY_URL: "https://local.example.test",
    });
    expect(
      loadRepoEnv({
        baseEnv: {
          DISPATCH_CLERK_PUBLISHABLE_KEY: "pk_ci",
          T3CODE_CLERK_PUBLISHABLE_KEY: "pk_legacy_ci",
          DISPATCH_CLERK_JWT_TEMPLATE: "template_ci",
          T3CODE_CLERK_JWT_TEMPLATE: "template_legacy_ci",
          DISPATCH_CLERK_CLI_OAUTH_CLIENT_ID: "oauth_ci",
          T3CODE_CLERK_CLI_OAUTH_CLIENT_ID: "oauth_legacy_ci",
          DISPATCH_RELAY_URL: "https://ci.example.test",
          T3CODE_RELAY_URL: "https://legacy-ci.example.test",
          DISPATCH_HOSTED_APP_URL: "https://app.dispatch.example.test",
          T3CODE_HOSTED_APP_URL: "https://legacy-app.example.test",
        },
        repoRoot,
      }),
    ).toMatchObject({
      DISPATCH_CLERK_PUBLISHABLE_KEY: "pk_ci",
      T3CODE_CLERK_PUBLISHABLE_KEY: "pk_ci",
      DISPATCH_CLERK_CLI_OAUTH_CLIENT_ID: "oauth_ci",
      T3CODE_CLERK_CLI_OAUTH_CLIENT_ID: "oauth_ci",
      VITE_CLERK_PUBLISHABLE_KEY: "pk_ci",
      EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY: "pk_ci",
      DISPATCH_CLERK_JWT_TEMPLATE: "template_ci",
      T3CODE_CLERK_JWT_TEMPLATE: "template_ci",
      VITE_CLERK_JWT_TEMPLATE: "template_ci",
      EXPO_PUBLIC_CLERK_JWT_TEMPLATE: "template_ci",
      DISPATCH_RELAY_URL: "https://ci.example.test",
      T3CODE_RELAY_URL: "https://ci.example.test",
      VITE_DISPATCH_RELAY_URL: "https://ci.example.test",
      VITE_T3CODE_RELAY_URL: "https://ci.example.test",
      DISPATCH_HOSTED_APP_URL: "https://app.dispatch.example.test",
      T3CODE_HOSTED_APP_URL: "https://app.dispatch.example.test",
      VITE_HOSTED_APP_URL: "https://app.dispatch.example.test",
    });
  });

  it("prefers canonical Dispatch names over legacy aliases within one source", () => {
    expect(
      resolvePublicConfig({
        DISPATCH_CONNECT_URL: "https://connect.dispatch.example.test",
        DISPATCH_CLERK_PUBLISHABLE_KEY: "pk_dispatch",
        T3CODE_CLERK_PUBLISHABLE_KEY: "pk_legacy",
        DISPATCH_CLERK_JWT_TEMPLATE: "template_dispatch",
        T3CODE_CLERK_JWT_TEMPLATE: "template_legacy",
        DISPATCH_CLERK_CLI_OAUTH_CLIENT_ID: "oauth_dispatch",
        T3CODE_CLERK_CLI_OAUTH_CLIENT_ID: "oauth_legacy",
        DISPATCH_RELAY_URL: "https://dispatch.example.test",
        T3CODE_RELAY_URL: "https://legacy.example.test",
        DISPATCH_HOSTED_APP_URL: "https://app.dispatch.example.test",
        T3CODE_HOSTED_APP_URL: "https://legacy-app.example.test",
        DISPATCH_MOBILE_OTLP_TRACES_URL: "https://dispatch.example.test/mobile",
        T3CODE_MOBILE_OTLP_TRACES_URL: "https://legacy.example.test/mobile",
        DISPATCH_MOBILE_OTLP_TRACES_DATASET: "dispatch-mobile",
        T3CODE_MOBILE_OTLP_TRACES_DATASET: "legacy-mobile",
        DISPATCH_MOBILE_OTLP_TRACES_TOKEN: "dispatch-mobile-token",
        T3CODE_MOBILE_OTLP_TRACES_TOKEN: "legacy-mobile-token",
        DISPATCH_RELAY_CLIENT_OTLP_TRACES_URL: "https://dispatch.example.test/relay",
        T3CODE_RELAY_CLIENT_OTLP_TRACES_URL: "https://legacy.example.test/relay",
        DISPATCH_RELAY_CLIENT_OTLP_TRACES_DATASET: "dispatch-relay",
        T3CODE_RELAY_CLIENT_OTLP_TRACES_DATASET: "legacy-relay",
        DISPATCH_RELAY_CLIENT_OTLP_TRACES_TOKEN: "dispatch-relay-token",
        T3CODE_RELAY_CLIENT_OTLP_TRACES_TOKEN: "legacy-relay-token",
      }),
    ).toEqual({
      connectUrl: "https://connect.dispatch.example.test",
      clerkPublishableKey: "pk_dispatch",
      clerkJwtTemplate: "template_dispatch",
      clerkCliOAuthClientId: "oauth_dispatch",
      relayUrl: "https://dispatch.example.test",
      hostedAppUrl: "https://app.dispatch.example.test",
      mobileOtlpTracesUrl: "https://dispatch.example.test/mobile",
      mobileOtlpTracesDataset: "dispatch-mobile",
      mobileOtlpTracesToken: "dispatch-mobile-token",
      relayClientOtlpTracesUrl: "https://dispatch.example.test/relay",
      relayClientOtlpTracesDataset: "dispatch-relay",
      relayClientOtlpTracesToken: "dispatch-relay-token",
    });
  });

  it("accepts legacy framework aliases as root overrides", () => {
    expect(
      resolvePublicConfig({
        VITE_CLERK_PUBLISHABLE_KEY: "pk_legacy",
        VITE_CLERK_JWT_TEMPLATE: "template_legacy",
        T3CODE_CLERK_CLI_OAUTH_CLIENT_ID: "oauth_canonical",
        VITE_T3CODE_RELAY_URL: "https://legacy.example.test",
        VITE_HOSTED_APP_URL: "https://hosted.example.test",
        EXPO_PUBLIC_OTLP_TRACES_URL: "https://api.axiom.co/v1/traces",
        EXPO_PUBLIC_OTLP_TRACES_DATASET: "mobile-traces",
        EXPO_PUBLIC_OTLP_TRACES_TOKEN: "mobile-token",
      }),
    ).toEqual({
      connectUrl: undefined,
      clerkPublishableKey: "pk_legacy",
      clerkJwtTemplate: "template_legacy",
      clerkCliOAuthClientId: "oauth_canonical",
      relayUrl: "https://legacy.example.test",
      hostedAppUrl: "https://hosted.example.test",
      mobileOtlpTracesUrl: "https://api.axiom.co/v1/traces",
      mobileOtlpTracesDataset: "mobile-traces",
      mobileOtlpTracesToken: "mobile-token",
      relayClientOtlpTracesUrl: undefined,
      relayClientOtlpTracesDataset: undefined,
      relayClientOtlpTracesToken: undefined,
    });
  });

  it("projects the canonical Dispatch Connect origin to web and mobile clients", () => {
    expect(
      loadRepoEnv({
        baseEnv: { DISPATCH_CONNECT_URL: "https://connect.example.test" },
        repoRoot: makeTemporaryDirectory(),
      }),
    ).toEqual({
      DISPATCH_CONNECT_URL: "https://connect.example.test",
      T3CODE_CONNECT_URL: "https://connect.example.test",
      VITE_DISPATCH_CONNECT_URL: "https://connect.example.test",
      EXPO_PUBLIC_DISPATCH_CONNECT_URL: "https://connect.example.test",
    });
  });

  it("upgrades legacy branded inputs into canonical Dispatch projections", () => {
    expect(
      loadRepoEnv({
        baseEnv: {
          T3CODE_CLERK_PUBLISHABLE_KEY: "pk_legacy",
          T3CODE_CLERK_JWT_TEMPLATE: "template_legacy",
          T3CODE_CLERK_CLI_OAUTH_CLIENT_ID: "oauth_legacy",
          T3CODE_RELAY_URL: "https://legacy-relay.example.test",
          T3CODE_HOSTED_APP_URL: "https://legacy-app.example.test",
          T3CODE_MOBILE_OTLP_TRACES_DATASET: "legacy-mobile",
          T3CODE_RELAY_CLIENT_OTLP_TRACES_DATASET: "legacy-relay",
        },
        repoRoot: makeTemporaryDirectory(),
      }),
    ).toMatchObject({
      DISPATCH_CLERK_PUBLISHABLE_KEY: "pk_legacy",
      T3CODE_CLERK_PUBLISHABLE_KEY: "pk_legacy",
      DISPATCH_CLERK_JWT_TEMPLATE: "template_legacy",
      T3CODE_CLERK_JWT_TEMPLATE: "template_legacy",
      DISPATCH_CLERK_CLI_OAUTH_CLIENT_ID: "oauth_legacy",
      T3CODE_CLERK_CLI_OAUTH_CLIENT_ID: "oauth_legacy",
      DISPATCH_RELAY_URL: "https://legacy-relay.example.test",
      T3CODE_RELAY_URL: "https://legacy-relay.example.test",
      VITE_DISPATCH_RELAY_URL: "https://legacy-relay.example.test",
      VITE_T3CODE_RELAY_URL: "https://legacy-relay.example.test",
      DISPATCH_HOSTED_APP_URL: "https://legacy-app.example.test",
      T3CODE_HOSTED_APP_URL: "https://legacy-app.example.test",
      VITE_HOSTED_APP_URL: "https://legacy-app.example.test",
      DISPATCH_MOBILE_OTLP_TRACES_DATASET: "legacy-mobile",
      T3CODE_MOBILE_OTLP_TRACES_DATASET: "legacy-mobile",
      DISPATCH_RELAY_CLIENT_OTLP_TRACES_DATASET: "legacy-relay",
      T3CODE_RELAY_CLIENT_OTLP_TRACES_DATASET: "legacy-relay",
    });
  });

  it("projects Dispatch relay client tracing values to canonical and compatibility aliases", () => {
    expect(
      loadRepoEnv({
        baseEnv: {
          DISPATCH_RELAY_CLIENT_OTLP_TRACES_URL: "https://api.axiom.co/v1/traces",
          DISPATCH_RELAY_CLIENT_OTLP_TRACES_DATASET: "relay-client-traces",
          DISPATCH_RELAY_CLIENT_OTLP_TRACES_TOKEN: "relay-client-token",
        },
        repoRoot: makeTemporaryDirectory(),
      }),
    ).toEqual({
      DISPATCH_RELAY_CLIENT_OTLP_TRACES_URL: "https://api.axiom.co/v1/traces",
      DISPATCH_RELAY_CLIENT_OTLP_TRACES_DATASET: "relay-client-traces",
      DISPATCH_RELAY_CLIENT_OTLP_TRACES_TOKEN: "relay-client-token",
      T3CODE_RELAY_CLIENT_OTLP_TRACES_URL: "https://api.axiom.co/v1/traces",
      T3CODE_RELAY_CLIENT_OTLP_TRACES_DATASET: "relay-client-traces",
      T3CODE_RELAY_CLIENT_OTLP_TRACES_TOKEN: "relay-client-token",
      VITE_RELAY_OTLP_TRACES_URL: "https://api.axiom.co/v1/traces",
      VITE_RELAY_OTLP_TRACES_DATASET: "relay-client-traces",
      VITE_RELAY_OTLP_TRACES_TOKEN: "relay-client-token",
    });
  });

  it("projects Dispatch relay and mobile tracing values with legacy consumer aliases", () => {
    expect(
      loadRepoEnv({
        baseEnv: {
          DISPATCH_RELAY_URL: "https://relay.example.test",
          DISPATCH_MOBILE_OTLP_TRACES_URL: "https://api.axiom.co/v1/traces",
          DISPATCH_MOBILE_OTLP_TRACES_DATASET: "mobile-traces",
          DISPATCH_MOBILE_OTLP_TRACES_TOKEN: "mobile-token",
        },
        repoRoot: makeTemporaryDirectory(),
      }),
    ).toEqual({
      DISPATCH_RELAY_URL: "https://relay.example.test",
      T3CODE_RELAY_URL: "https://relay.example.test",
      VITE_DISPATCH_RELAY_URL: "https://relay.example.test",
      VITE_T3CODE_RELAY_URL: "https://relay.example.test",
      DISPATCH_MOBILE_OTLP_TRACES_URL: "https://api.axiom.co/v1/traces",
      DISPATCH_MOBILE_OTLP_TRACES_DATASET: "mobile-traces",
      DISPATCH_MOBILE_OTLP_TRACES_TOKEN: "mobile-token",
      T3CODE_MOBILE_OTLP_TRACES_URL: "https://api.axiom.co/v1/traces",
      T3CODE_MOBILE_OTLP_TRACES_DATASET: "mobile-traces",
      T3CODE_MOBILE_OTLP_TRACES_TOKEN: "mobile-token",
      EXPO_PUBLIC_OTLP_TRACES_URL: "https://api.axiom.co/v1/traces",
      EXPO_PUBLIC_OTLP_TRACES_DATASET: "mobile-traces",
      EXPO_PUBLIC_OTLP_TRACES_TOKEN: "mobile-token",
    });
  });
});

function makeTemporaryDirectory() {
  const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "dispatch-public-config-"));
  temporaryDirectories.push(directory);
  return directory;
}

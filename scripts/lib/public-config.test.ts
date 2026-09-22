// @effect-diagnostics nodeBuiltinImport:off - Tests exercise root env file precedence directly.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { loadRepoEnv, resolvePublicConfig } from "./public-config.ts";

const temporaryDirectories: string[] = [];

function makeTemporaryDirectory() {
  const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "dispatch-public-config-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    NodeFS.rmSync(directory, { recursive: true, force: true });
  }
});

describe("loadRepoEnv", () => {
  it("leaves an unconfigured clone independent of hosted services", () => {
    expect(loadRepoEnv({ baseEnv: {}, repoRoot: makeTemporaryDirectory() })).toEqual({});
    expect(resolvePublicConfig({})).toEqual({ connectUrl: undefined, hostedAppUrl: undefined });
  });

  it("applies process, root local, and root precedence", () => {
    const repoRoot = makeTemporaryDirectory();
    NodeFS.writeFileSync(
      NodePath.join(repoRoot, ".env"),
      "DISPATCH_CONNECT_URL=https://root.example.test\n",
    );
    expect(loadRepoEnv({ baseEnv: {}, repoRoot }).DISPATCH_CONNECT_URL).toBe(
      "https://root.example.test",
    );
    NodeFS.writeFileSync(
      NodePath.join(repoRoot, ".env.local"),
      "VITE_DISPATCH_CONNECT_URL=https://local.example.test\n",
    );
    expect(loadRepoEnv({ baseEnv: {}, repoRoot }).DISPATCH_CONNECT_URL).toBe(
      "https://local.example.test",
    );
    expect(
      loadRepoEnv({ baseEnv: { DISPATCH_CONNECT_URL: "https://ci.example.test" }, repoRoot }),
    ).toMatchObject({
      DISPATCH_CONNECT_URL: "https://ci.example.test",
      VITE_DISPATCH_CONNECT_URL: "https://ci.example.test",
      EXPO_PUBLIC_DISPATCH_CONNECT_URL: "https://ci.example.test",
    });
  });

  it("prefers canonical Dispatch names over framework and legacy host aliases", () => {
    expect(
      resolvePublicConfig({
        DISPATCH_CONNECT_URL: " https://connect.example.test ",
        VITE_DISPATCH_CONNECT_URL: "https://framework.example.test",
        DISPATCH_HOSTED_APP_URL: "https://app.example.test",
        T3CODE_HOSTED_APP_URL: "https://legacy.example.test",
      }),
    ).toEqual({
      connectUrl: "https://connect.example.test",
      hostedAppUrl: "https://app.example.test",
    });
  });

  it("accepts framework configuration and existing hosted app aliases", () => {
    expect(
      resolvePublicConfig({
        EXPO_PUBLIC_DISPATCH_CONNECT_URL: "https://connect.example.test",
        VITE_HOSTED_APP_URL: "https://app.example.test",
      }),
    ).toEqual({
      connectUrl: "https://connect.example.test",
      hostedAppUrl: "https://app.example.test",
    });
    expect(
      loadRepoEnv({
        baseEnv: { T3CODE_HOSTED_APP_URL: "https://app.example.test" },
        repoRoot: makeTemporaryDirectory(),
      }),
    ).toMatchObject({
      DISPATCH_HOSTED_APP_URL: "https://app.example.test",
      VITE_HOSTED_APP_URL: "https://app.example.test",
    });
  });

  it("does not turn retired account or relay settings into public build configuration", () => {
    const source = {
      T3CODE_CLERK_PUBLISHABLE_KEY: "retired-key",
      T3CODE_RELAY_URL: "https://retired.example.test",
      T3CODE_RELAY_CLIENT_OTLP_TRACES_TOKEN: "retired-tracing",
    };
    expect(resolvePublicConfig(source)).toEqual({ connectUrl: undefined, hostedAppUrl: undefined });
    const env = loadRepoEnv({ baseEnv: source, repoRoot: makeTemporaryDirectory() });
    expect(env.VITE_CLERK_PUBLISHABLE_KEY).toBeUndefined();
    expect(env.VITE_DISPATCH_RELAY_URL).toBeUndefined();
    expect(env.VITE_RELAY_OTLP_TRACES_TOKEN).toBeUndefined();
  });

  it("skips empty values without overriding a configured lower-priority source", () => {
    expect(
      resolvePublicConfig(
        { DISPATCH_CONNECT_URL: "  " },
        { DISPATCH_CONNECT_URL: "https://connect.example.test" },
      ).connectUrl,
    ).toBe("https://connect.example.test");
  });
});

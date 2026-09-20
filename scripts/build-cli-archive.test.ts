import { assert, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";

import { resolveCliMacSignIdentity } from "./build-cli-archive.ts";

it.effect("prefers the Dispatch CLI mac signing identity over the legacy alias", () =>
  Effect.gen(function* () {
    const identity = yield* resolveCliMacSignIdentity();
    assert.equal(identity, "Developer ID Application: Dispatch");
  }).pipe(
    Effect.provide(
      ConfigProvider.layer(
        ConfigProvider.fromEnv({
          env: {
            DISPATCH_CLI_MAC_SIGN_IDENTITY: " Developer ID Application: Dispatch ",
            T3CODE_CLI_MAC_SIGN_IDENTITY: "Developer ID Application: Legacy",
          },
        }),
      ),
    ),
  ),
);

it.effect("accepts the legacy CLI mac signing identity when Dispatch is absent", () =>
  Effect.gen(function* () {
    const identity = yield* resolveCliMacSignIdentity();
    assert.equal(identity, "Developer ID Application: Legacy");
  }).pipe(
    Effect.provide(
      ConfigProvider.layer(
        ConfigProvider.fromEnv({
          env: {
            T3CODE_CLI_MAC_SIGN_IDENTITY: " Developer ID Application: Legacy ",
          },
        }),
      ),
    ),
  ),
);

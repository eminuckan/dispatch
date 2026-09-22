import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Terminal from "effect/Terminal";

import * as BootService from "../cloud/bootService.ts";
import { resolveDispatchConnectCliUrl } from "./connect.ts";
import { recoverServiceOnboardingOffer } from "./service.ts";

it("resolves the canonical Dispatch Connect origin with legacy fallback", () => {
  assert.equal(
    resolveDispatchConnectCliUrl({
      DISPATCH_CONNECT_URL: "https://connect.dispatch.example/",
      T3CODE_CONNECT_URL: "https://legacy.example/",
    }),
    "https://connect.dispatch.example",
  );
  assert.equal(
    resolveDispatchConnectCliUrl({ T3CODE_CONNECT_URL: "https://legacy.example/" }),
    "https://legacy.example",
  );
});

it("accepts loopback HTTP for development and rejects unsafe Connect origins", () => {
  assert.equal(
    resolveDispatchConnectCliUrl({ DISPATCH_CONNECT_URL: "http://127.0.0.1:8787" }),
    "http://127.0.0.1:8787",
  );
  assert.equal(
    resolveDispatchConnectCliUrl({ DISPATCH_CONNECT_URL: "http://localhost:8787" }),
    "http://localhost:8787",
  );
  assert.equal(
    resolveDispatchConnectCliUrl({ DISPATCH_CONNECT_URL: "http://connect.example.test" }),
    null,
  );
  assert.equal(
    resolveDispatchConnectCliUrl({ DISPATCH_CONNECT_URL: "https://connect.example.test/path" }),
    null,
  );
  assert.equal(
    resolveDispatchConnectCliUrl({
      DISPATCH_CONNECT_URL: "https://user:pass@connect.example.test",
    }),
    null,
  );
});

it.effect("treats cancelling optional background setup as a successful skip", () =>
  Effect.gen(function* () {
    const result = yield* recoverServiceOnboardingOffer(Effect.fail(new Terminal.QuitError({})));
    assert.isFalse(result);
  }),
);

it.effect("keeps a successful connection when a remote service update is pending", () =>
  Effect.gen(function* () {
    const result = yield* recoverServiceOnboardingOffer(
      Effect.fail(new BootService.BootServiceUpdatePendingError()),
    );
    assert.isFalse(result);
  }),
);

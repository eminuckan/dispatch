import { EnvironmentId } from "@dispatch/contracts";
import { assert, it } from "@effect/vitest";

import type { ConnectedEnvironmentSummary } from "../../state/remote-runtime-types";
import {
  applyShowcaseLocalEnvironmentDisplayUrls,
  resolveShowcaseEnvironmentUpdateDisplayUrl,
  SHOWCASE_AVAILABLE_CLOUD_ENVIRONMENTS,
  SHOWCASE_CONNECTED_CLOUD_ENVIRONMENTS,
} from "./showcaseEnvironmentRows";

function environment(
  environmentId: string,
  environmentLabel: string,
  displayUrl = "http://127.0.0.1:3773/",
): ConnectedEnvironmentSummary {
  return {
    environmentId: EnvironmentId.make(environmentId),
    environmentLabel,
    displayUrl,
    isRelayManaged: false,
    isEnabled: true,
    connectionState: "connected",
    connectionError: null,
    connectionErrorTraceId: null,
  };
}

it("presents showcase transports as remote endpoints", () => {
  const environments = applyShowcaseLocalEnvironmentDisplayUrls([
    environment("runtime-id-1", "Moonbase Terminal"),
    environment("runtime-id-2", "Suspense Station"),
    environment("runtime-id-3", "Kernel Cabin"),
  ]);

  assert.deepStrictEqual(
    environments.map(({ displayUrl }) => displayUrl),
    [
      "https://moonbase.dispatch.test/",
      "https://suspense-station.dispatch.test/",
      "http://100.82.16.5:3773/",
    ],
  );
});

it("uses reserved Dispatch test domains for synthetic cloud endpoints", () => {
  assert.deepStrictEqual(
    SHOWCASE_CONNECTED_CLOUD_ENVIRONMENTS.map(({ displayUrl }) => displayUrl),
    ["https://aurora-gpu.dispatch.test"],
  );
  assert.deepStrictEqual(
    SHOWCASE_AVAILABLE_CLOUD_ENVIRONMENTS.map(({ environment }) => environment.endpoint),
    [
      {
        httpBaseUrl: "https://pocket-pi.dispatch.test",
        wsBaseUrl: "wss://pocket-pi.dispatch.test",
        providerKind: "t3_relay",
      },
    ],
  );
});

it("leaves environments outside the showcase fixture unchanged", () => {
  const original = environment(
    "runtime-id-4",
    "My Workstation",
    "https://workstation.example.test/",
  );

  assert.deepStrictEqual(applyShowcaseLocalEnvironmentDisplayUrls([original]), [original]);
});

it("does not persist a cosmetic showcase URL when only the label is saved", () => {
  assert.equal(
    resolveShowcaseEnvironmentUpdateDisplayUrl({
      actualDisplayUrl: "http://127.0.0.1:3773/",
      presentedDisplayUrl: "https://moonbase.dispatch.test/",
      submittedDisplayUrl: "https://moonbase.dispatch.test/",
    }),
    "http://127.0.0.1:3773/",
  );
  assert.equal(
    resolveShowcaseEnvironmentUpdateDisplayUrl({
      actualDisplayUrl: "http://127.0.0.1:3773/",
      presentedDisplayUrl: "https://moonbase.dispatch.test/",
      submittedDisplayUrl: "https://new-host.example.com/",
    }),
    "https://new-host.example.com/",
  );
});

import { describe, expect, it } from "@effect/vitest";

import {
  DispatchConnectPairingCode,
  DispatchConnectPairingSecret,
  buildDispatchConnectPairingUrl,
  formatDispatchConnectPairingCode,
  normalizeDispatchConnectPairingCredential,
} from "./dispatchConnect.ts";

describe("Dispatch Connect pairing", () => {
  it("formats the canonical pairing secret for manual entry", () => {
    const secret = DispatchConnectPairingSecret.make("2345ABCDJKLM");

    expect(formatDispatchConnectPairingCode(secret)).toBe("2345-ABCD-JKLM");
    expect(DispatchConnectPairingCode.make("2345-ABCD-JKLM")).toBe("2345-ABCD-JKLM");
  });

  it("normalizes grouped or lowercase pairing codes without rewriting unrelated credentials", () => {
    expect(normalizeDispatchConnectPairingCredential("2345-abcd-jklm")).toBe("2345ABCDJKLM");
    expect(normalizeDispatchConnectPairingCredential("  2345 ABCD JKLM  ")).toBe("2345ABCDJKLM");
    expect(normalizeDispatchConnectPairingCredential("2345abcdjklm")).toBe("2345abcdjklm");
    expect(normalizeDispatchConnectPairingCredential("legacy-token-with-dashes")).toBe(
      "legacy-token-with-dashes",
    );
  });

  it("keeps the pairing secret in the URL fragment", () => {
    const secret = DispatchConnectPairingSecret.make("2345ABCDJKLM");
    const pairingUrl = new URL(
      buildDispatchConnectPairingUrl("https://host.example/base?q=1", secret),
    );

    expect(pairingUrl.origin).toBe("https://host.example");
    expect(pairingUrl.pathname).toBe("/pair");
    expect(pairingUrl.searchParams.get("q")).toBe("1");
    expect(pairingUrl.searchParams.has("token")).toBe(false);
    expect(new URLSearchParams(pairingUrl.hash.slice(1)).get("token")).toBe(secret);
  });
});

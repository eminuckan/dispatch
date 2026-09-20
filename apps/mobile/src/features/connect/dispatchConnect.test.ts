import { describe, expect, it, vi } from "vite-plus/test";

import {
  formatDispatchConnectCode,
  normalizeDispatchConnectUrl,
  orderDispatchConnectEndpoints,
  parseDispatchConnectCode,
  readDispatchConnectCodeFromQrPayload,
  redeemDispatchConnectPairing,
} from "./dispatchConnect";

describe("Dispatch Connect mobile client", () => {
  it("normalizes the configured Connect origin", () => {
    expect(normalizeDispatchConnectUrl(" https://connect.example.com/ ")).toBe(
      "https://connect.example.com",
    );
    expect(normalizeDispatchConnectUrl("file:///tmp/connect")).toBeNull();
  });

  it("formats a manual environment code as 4-4-4", () => {
    expect(formatDispatchConnectCode("ab23 cd45-ef67gh")).toBe("AB23-CD45-EF67");
    expect(() => parseDispatchConnectCode("ABCD-EFGH-IJKL")).toThrow("invalid character");
  });

  it("recognizes the code-only Dispatch Connect QR without changing direct pairing QR payloads", () => {
    expect(
      readDispatchConnectCodeFromQrPayload("dispatch://connect/pair?code=ABCD-EFGH-JKLM"),
    ).toBe("ABCD-EFGH-JKLM");
    expect(
      readDispatchConnectCodeFromQrPayload("https://machine.tail.test/#token=direct-pairing"),
    ).toBeNull();
  });

  it("prefers Tailscale before the managed Cloudflare fallback", () => {
    expect(
      orderDispatchConnectEndpoints([
        {
          kind: "cloudflare_tunnel",
          httpBaseUrl: "https://fallback.test",
          wsBaseUrl: "wss://fallback.test",
        },
        {
          kind: "tailscale",
          httpBaseUrl: "https://machine.tail.test",
          wsBaseUrl: "wss://machine.tail.test",
        },
      ]).map((endpoint) => endpoint.kind),
    ).toEqual(["tailscale", "cloudflare_tunnel"]);
  });

  it("sends the SecureStore cookie explicitly when redeeming a code", async () => {
    const fetcher = vi.fn(async () =>
      Response.json({
        environment: {
          id: "env-1",
          label: "Mac mini",
          endpoints: [
            {
              kind: "tailscale",
              httpBaseUrl: "https://machine.tail.test",
              wsBaseUrl: "wss://machine.tail.test",
            },
          ],
        },
      }),
    );

    await redeemDispatchConnectPairing({
      baseUrl: "https://connect.example.com",
      deviceId: "device-1",
      code: "abcd efgh jklm",
      cookie: "better-auth.session_token=test",
      fetch: fetcher,
    });

    expect(fetcher).toHaveBeenCalledWith(
      "https://connect.example.com/v1/pairings/redeem",
      expect.objectContaining({
        credentials: "omit",
        headers: expect.objectContaining({ Cookie: "better-auth.session_token=test" }),
        body: JSON.stringify({ deviceId: "device-1", code: "ABCD-EFGH-JKLM" }),
      }),
    );
  });

  it("maps stable pairing API error codes to user-facing messages", async () => {
    const cases = [
      ["pairing_not_found", "invalid or no longer available"],
      ["pairing_expired", "has expired"],
      ["pairing_used", "has already been used"],
    ] as const;

    for (const [error, message] of cases) {
      await expect(
        redeemDispatchConnectPairing({
          baseUrl: "https://connect.example.com",
          deviceId: "device-1",
          code: "ABCD-EFGH-JKLM",
          cookie: "better-auth.session_token=test",
          fetch: async () => Response.json({ error }, { status: 400 }),
        }),
      ).rejects.toThrow(message);
    }
  });
});

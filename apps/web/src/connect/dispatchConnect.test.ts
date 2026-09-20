import { describe, expect, it, vi } from "vite-plus/test";

import {
  formatDispatchConnectCode,
  normalizeDispatchConnectUrl,
  orderDispatchConnectEndpoints,
  parseDispatchConnectCode,
  redeemDispatchConnectPairing,
} from "./dispatchConnect";

describe("Dispatch Connect client", () => {
  it("normalizes the configured Connect origin", () => {
    expect(normalizeDispatchConnectUrl(" https://connect.example.com/ ")).toBe(
      "https://connect.example.com",
    );
    expect(normalizeDispatchConnectUrl("file:///tmp/connect")).toBeNull();
    expect(normalizeDispatchConnectUrl("   ")).toBeNull();
  });

  it("formats a manual environment code as 4-4-4", () => {
    expect(formatDispatchConnectCode("ab23 cd45-ef67gh")).toBe("AB23-CD45-EF67");
    expect(() => parseDispatchConnectCode("ABCD-EFGH-IJKL")).toThrow("invalid character");
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

  it("redeems the code with the account device and returns ordered endpoints", async () => {
    const fetcher = vi.fn(async () =>
      Response.json({
        environment: {
          id: "env-1",
          label: "Mac mini",
          endpoints: [
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
          ],
        },
      }),
    );

    const result = await redeemDispatchConnectPairing({
      baseUrl: "https://connect.example.com",
      deviceId: "device-1",
      code: "abcd efgh jklm",
      fetch: fetcher,
    });

    expect(result.endpoints.map((endpoint) => endpoint.kind)).toEqual([
      "tailscale",
      "cloudflare_tunnel",
    ]);
    expect(fetcher).toHaveBeenCalledWith(
      "https://connect.example.com/v1/pairings/redeem",
      expect.objectContaining({
        method: "POST",
        credentials: "omit",
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
          fetch: async () => Response.json({ error }, { status: 400 }),
        }),
      ).rejects.toThrow(message);
    }
  });
});

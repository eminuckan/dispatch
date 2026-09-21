import * as NodeAssert from "node:assert/strict";
import * as NodeTest from "node:test";

import { loadConfig } from "./config.ts";

NodeTest.test("config has Dokploy-safe defaults and parses Connect overrides", () => {
  const config = loadConfig({
    DATABASE_URL: "postgres://dispatch:secret@postgres:5432/dispatch_connect",
    BETTER_AUTH_SECRET: "secret",
    BETTER_AUTH_URL: "https://connect.example.com/",
    CONNECT_CREDENTIAL_SECRET: "credential-secret",
    CONNECT_ALLOWED_ORIGINS: "https://app.example.com, https://desktop.example.com",
    CONNECT_PAIRING_TTL_SECONDS: "900",
  });

  NodeAssert.equal(config.host, "0.0.0.0");
  NodeAssert.equal(config.port, 8787);
  NodeAssert.equal(config.pairingTtlSeconds, 900);
  NodeAssert.equal(config.betterAuthUrl, "https://connect.example.com");
  NodeAssert.equal(config.credentialSecret, "credential-secret");
  NodeAssert.equal(config.deviceVerificationUrl, "https://connect.example.com/device");
  NodeAssert.equal(config.managedTunnel, null);
  NodeAssert.deepEqual(config.allowedOrigins, [
    "https://app.example.com",
    "https://desktop.example.com",
  ]);
});

NodeTest.test(
  "config enables device auth and managed Cloudflare only when explicitly configured",
  () => {
    const config = loadConfig({
      DATABASE_URL: "postgres://dispatch:secret@postgres:5432/dispatch_connect",
      BETTER_AUTH_SECRET: "secret",
      BETTER_AUTH_URL: "https://connect.example.com",
      CONNECT_DEVICE_VERIFICATION_URL: "https://app.example.com/device",
      CLOUDFLARE_ACCOUNT_ID: "account-id",
      CLOUDFLARE_API_TOKEN: "api-token",
      CLOUDFLARE_ZONE_ID: "zone-id",
      CONNECT_TUNNEL_DOMAIN: ".remote.example.com.",
    });

    NodeAssert.equal(config.deviceVerificationUrl, "https://app.example.com/device");
    NodeAssert.deepEqual(config.managedTunnel, {
      accountId: "account-id",
      apiToken: "api-token",
      zoneId: "zone-id",
      tunnelDomain: "remote.example.com",
    });
  },
);

NodeTest.test("config rejects partial managed Cloudflare settings", () => {
  NodeAssert.throws(
    () =>
      loadConfig({
        DATABASE_URL: "postgres://dispatch:secret@postgres:5432/dispatch_connect",
        BETTER_AUTH_SECRET: "secret",
        BETTER_AUTH_URL: "https://connect.example.com",
        CLOUDFLARE_ACCOUNT_ID: "account-id",
      }),
    /Managed Cloudflare Tunnel requires/,
  );
});

NodeTest.test("config requires database and Better Auth settings", () => {
  NodeAssert.throws(() => loadConfig({}), /is required/);
});

NodeTest.test("production requires an independent Connect credential secret", () => {
  NodeAssert.throws(
    () =>
      loadConfig({
        NODE_ENV: "production",
        DATABASE_URL: "postgres://dispatch:secret@postgres:5432/dispatch_connect",
        BETTER_AUTH_SECRET: "secret",
        BETTER_AUTH_URL: "https://connect.example.com",
      }),
    /CONNECT_CREDENTIAL_SECRET is required in production/,
  );
});

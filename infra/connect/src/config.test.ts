import assert from "node:assert/strict";
import test from "node:test";

import { loadConfig } from "./config.ts";

test("config has Dokploy-safe defaults and parses Connect overrides", () => {
  const config = loadConfig({
    DATABASE_URL: "postgres://dispatch:secret@postgres:5432/dispatch_connect",
    BETTER_AUTH_SECRET: "secret",
    BETTER_AUTH_URL: "https://connect.example.com/",
    CONNECT_CREDENTIAL_SECRET: "credential-secret",
    CONNECT_ALLOWED_ORIGINS: "https://app.example.com, https://desktop.example.com",
    CONNECT_PAIRING_TTL_SECONDS: "900",
  });

  assert.equal(config.host, "0.0.0.0");
  assert.equal(config.port, 8787);
  assert.equal(config.pairingTtlSeconds, 900);
  assert.equal(config.betterAuthUrl, "https://connect.example.com");
  assert.equal(config.credentialSecret, "credential-secret");
  assert.equal(config.deviceVerificationUrl, "https://connect.example.com/device");
  assert.equal(config.managedTunnel, null);
  assert.deepEqual(config.allowedOrigins, [
    "https://app.example.com",
    "https://desktop.example.com",
  ]);
});

test("config enables device auth and managed Cloudflare only when explicitly configured", () => {
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

  assert.equal(config.deviceVerificationUrl, "https://app.example.com/device");
  assert.deepEqual(config.managedTunnel, {
    accountId: "account-id",
    apiToken: "api-token",
    zoneId: "zone-id",
    tunnelDomain: "remote.example.com",
  });
});

test("config rejects partial managed Cloudflare settings", () => {
  assert.throws(
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

test("config requires database and Better Auth settings", () => {
  assert.throws(() => loadConfig({}), /is required/);
});

test("production requires an independent Connect credential secret", () => {
  assert.throws(
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

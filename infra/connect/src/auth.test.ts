import * as NodeAssert from "node:assert/strict";
import * as NodeTest from "node:test";

import { createConnectAuthPlugins } from "./auth.ts";
import type { ConnectConfig } from "./config.ts";

function config(deviceVerificationUrl: string): ConnectConfig {
  return {
    databaseUrl: "postgres://unused",
    betterAuthSecret: "12345678901234567890123456789012",
    credentialSecret: "abcdefghijklmnopqrstuvwxyz123456",
    betterAuthUrl: "https://connect.example.test",
    host: "127.0.0.1",
    port: 8787,
    pairingTtlSeconds: 600,
    allowedOrigins: [],
    deviceVerificationUrl,
    managedTunnel: null,
    smartRouting: null,
    trustedProxyCidrs: [],
  };
}

NodeTest.test("device authorization plugin uses the configured verification UI", () => {
  const plugins = createConnectAuthPlugins(config("https://connect.example.test/device")).map(
    (plugin) => plugin.id,
  );

  NodeAssert.equal(plugins.includes("device-authorization"), true);
});

import type { Pool } from "pg";
import { expo } from "@better-auth/expo";
import { betterAuth } from "better-auth";
import { getMigrations } from "better-auth/db/migration";
import { fromNodeHeaders, toNodeHandler } from "better-auth/node";
import { bearer, deviceAuthorization } from "better-auth/plugins";

import type { ConnectConfig } from "./config.ts";

export function createConnectAuthPlugins(config: ConnectConfig) {
  return [
    bearer(),
    expo(),
    deviceAuthorization({
      validateClient: (clientId) => clientId === "dispatch-cli",
      verificationUri: config.deviceVerificationUrl,
    }),
  ];
}

export function createConnectAuth(config: ConnectConfig, pool: Pool) {
  const plugins = createConnectAuthPlugins(config);
  const options = {
    database: pool,
    baseURL: config.betterAuthUrl,
    secret: config.betterAuthSecret,
    emailAndPassword: { enabled: true },
    trustedOrigins: [...config.allowedOrigins],
    plugins,
  };
  const auth = betterAuth(options);

  return {
    auth,
    nodeHandler: toNodeHandler(auth),
    getSession: (headers: import("node:http").IncomingHttpHeaders) =>
      auth.api.getSession({ headers: fromNodeHeaders(headers) }),
    migrate: async () => {
      const migrations = await getMigrations(options);
      await migrations.runMigrations();
    },
  };
}

export type ConnectAuth = ReturnType<typeof createConnectAuth>;

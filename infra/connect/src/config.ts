export interface ConnectConfig {
  readonly databaseUrl: string;
  readonly betterAuthSecret: string;
  readonly credentialSecret: string;
  readonly betterAuthUrl: string;
  readonly host: string;
  readonly port: number;
  readonly pairingTtlSeconds: number;
  readonly allowedOrigins: readonly string[];
  readonly deviceVerificationUrl: string;
  readonly managedTunnel: CloudflareManagedTunnelConfig | null;
}

export interface CloudflareManagedTunnelConfig {
  readonly accountId: string;
  readonly apiToken: string;
  readonly zoneId: string;
  readonly tunnelDomain: string;
}

function requireEnv(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function parseInteger(value: string | undefined, fallback: number, name: string): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

function parseManagedTunnelConfig(env: NodeJS.ProcessEnv): CloudflareManagedTunnelConfig | null {
  const entries = {
    accountId: env.CLOUDFLARE_ACCOUNT_ID?.trim() || "",
    apiToken: env.CLOUDFLARE_API_TOKEN?.trim() || "",
    zoneId: env.CLOUDFLARE_ZONE_ID?.trim() || "",
    tunnelDomain:
      env.CONNECT_TUNNEL_DOMAIN?.trim()
        .toLowerCase()
        .replace(/^\.+|\.+$/g, "") || "",
  };
  const configured = Object.values(entries).filter(Boolean).length;
  if (configured === 0) return null;
  if (configured !== 4) {
    throw new Error(
      "Managed Cloudflare Tunnel requires CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_API_TOKEN, CLOUDFLARE_ZONE_ID, and CONNECT_TUNNEL_DOMAIN",
    );
  }
  if (
    !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(
      entries.tunnelDomain,
    )
  ) {
    throw new Error("CONNECT_TUNNEL_DOMAIN must be a DNS hostname without a scheme or path");
  }
  return entries;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ConnectConfig {
  const betterAuthUrl = new URL(requireEnv(env, "BETTER_AUTH_URL"));
  const normalizedAuthUrl = betterAuthUrl.toString().replace(/\/$/, "");
  const betterAuthSecret = requireEnv(env, "BETTER_AUTH_SECRET");
  const configuredCredentialSecret = env.CONNECT_CREDENTIAL_SECRET?.trim();
  if (env.NODE_ENV === "production" && !configuredCredentialSecret) {
    throw new Error("CONNECT_CREDENTIAL_SECRET is required in production");
  }
  return {
    databaseUrl: requireEnv(env, "DATABASE_URL"),
    betterAuthSecret,
    credentialSecret: configuredCredentialSecret || betterAuthSecret,
    betterAuthUrl: normalizedAuthUrl,
    host: env.HOST?.trim() || "0.0.0.0",
    port: parseInteger(env.PORT, 8787, "PORT"),
    pairingTtlSeconds: parseInteger(
      env.CONNECT_PAIRING_TTL_SECONDS,
      600,
      "CONNECT_PAIRING_TTL_SECONDS",
    ),
    allowedOrigins: (env.CONNECT_ALLOWED_ORIGINS ?? "")
      .split(",")
      .map((origin) => origin.trim())
      .filter(Boolean),
    deviceVerificationUrl:
      env.CONNECT_DEVICE_VERIFICATION_URL?.trim() || `${normalizedAuthUrl}/device`,
    managedTunnel: parseManagedTunnelConfig(env),
  };
}

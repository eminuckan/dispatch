import { SMART_ROUTING_RESERVATION_NANOS } from "./smartRouting.ts";

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
  readonly smartRouting: SmartRoutingConfig | null;
  readonly trustedProxyCidrs: readonly string[];
}

export interface SmartRoutingConfig {
  readonly apiKey: string;
  readonly monthlyBudgetNanos: number;
  readonly dailyBudgetNanos: number;
  readonly accountMonthlyRequests: number;
  readonly accountDailyRequests: number;
  readonly newAccountDailyRequests: number;
  readonly accountBurstRequests: number;
  readonly accountMinuteRequests: number;
  readonly accountHourlyRequests: number;
  readonly environmentMinuteRequests: number;
  readonly maxEnvironmentsPerAccount: number;
  readonly ipMinuteRequests: number;
  readonly ipDailyRequests: number;
  readonly maxConcurrentPerAccount: number;
  readonly maxConcurrentGlobal: number;
  readonly requestCostNanos: number;
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
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

function parseBudget(value: string | undefined, fallback: number, name: string): number {
  const dollars = value === undefined || value === "" ? fallback : Number(value);
  if (!Number.isFinite(dollars) || dollars < 0 || dollars > 10_000) {
    throw new Error(`${name} must be between 0 and 10000 USD`);
  }
  return Math.floor(dollars * 1_000_000_000);
}

function parseSmartRoutingConfig(env: NodeJS.ProcessEnv): SmartRoutingConfig | null {
  const apiKey = env.CONNECT_JEV_API_KEY?.trim();
  if (!apiKey || env.CONNECT_SMART_ROUTING_ENABLED === "false") return null;
  if (apiKey.length > 512 || /[\r\n]/.test(apiKey))
    throw new Error("CONNECT_JEV_API_KEY is invalid");
  return {
    apiKey,
    monthlyBudgetNanos: parseBudget(
      env.CONNECT_ROUTING_MONTHLY_BUDGET_USD,
      25,
      "CONNECT_ROUTING_MONTHLY_BUDGET_USD",
    ),
    dailyBudgetNanos: parseBudget(
      env.CONNECT_ROUTING_DAILY_BUDGET_USD,
      2,
      "CONNECT_ROUTING_DAILY_BUDGET_USD",
    ),
    accountMonthlyRequests: parseInteger(
      env.CONNECT_ROUTING_ACCOUNT_MONTHLY_REQUESTS,
      10_000,
      "CONNECT_ROUTING_ACCOUNT_MONTHLY_REQUESTS",
    ),
    accountDailyRequests: parseInteger(
      env.CONNECT_ROUTING_ACCOUNT_DAILY_REQUESTS,
      1_000,
      "CONNECT_ROUTING_ACCOUNT_DAILY_REQUESTS",
    ),
    newAccountDailyRequests: parseInteger(
      env.CONNECT_ROUTING_NEW_ACCOUNT_DAILY_REQUESTS,
      100,
      "CONNECT_ROUTING_NEW_ACCOUNT_DAILY_REQUESTS",
    ),
    accountBurstRequests: parseInteger(
      env.CONNECT_ROUTING_ACCOUNT_BURST_REQUESTS,
      6,
      "CONNECT_ROUTING_ACCOUNT_BURST_REQUESTS",
    ),
    accountMinuteRequests: parseInteger(
      env.CONNECT_ROUTING_ACCOUNT_MINUTE_REQUESTS,
      30,
      "CONNECT_ROUTING_ACCOUNT_MINUTE_REQUESTS",
    ),
    accountHourlyRequests: parseInteger(
      env.CONNECT_ROUTING_ACCOUNT_HOURLY_REQUESTS,
      300,
      "CONNECT_ROUTING_ACCOUNT_HOURLY_REQUESTS",
    ),
    environmentMinuteRequests: parseInteger(
      env.CONNECT_ROUTING_ENVIRONMENT_MINUTE_REQUESTS,
      20,
      "CONNECT_ROUTING_ENVIRONMENT_MINUTE_REQUESTS",
    ),
    maxEnvironmentsPerAccount: parseInteger(
      env.CONNECT_ROUTING_ACCOUNT_ENVIRONMENTS,
      20,
      "CONNECT_ROUTING_ACCOUNT_ENVIRONMENTS",
    ),
    ipMinuteRequests: parseInteger(
      env.CONNECT_ROUTING_IP_MINUTE_REQUESTS,
      120,
      "CONNECT_ROUTING_IP_MINUTE_REQUESTS",
    ),
    ipDailyRequests: parseInteger(
      env.CONNECT_ROUTING_IP_DAILY_REQUESTS,
      5_000,
      "CONNECT_ROUTING_IP_DAILY_REQUESTS",
    ),
    maxConcurrentPerAccount: parseInteger(
      env.CONNECT_ROUTING_ACCOUNT_CONCURRENCY,
      2,
      "CONNECT_ROUTING_ACCOUNT_CONCURRENCY",
    ),
    maxConcurrentGlobal: parseInteger(
      env.CONNECT_ROUTING_GLOBAL_CONCURRENCY,
      32,
      "CONNECT_ROUTING_GLOBAL_CONCURRENCY",
    ),
    // Reserve the pinned model's full context ceiling. Successful calls settle reported usage;
    // unknown usage and failures retain the allowance because they may have been billed.
    requestCostNanos: SMART_ROUTING_RESERVATION_NANOS,
  };
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
    smartRouting: parseSmartRoutingConfig(env),
    trustedProxyCidrs: (env.CONNECT_TRUSTED_PROXY_CIDRS ?? "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean),
  };
}

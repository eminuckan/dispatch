// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalConsole:off globalTimers:off - This package intentionally uses the Node HTTP runtime directly.
import * as NodeHttp from "node:http";

import { createConnectAuth } from "./auth.ts";
import { loadConfig } from "./config.ts";
import { isAllowedCorsOrigin } from "./cors.ts";
import { dispatchConnectDevicePageHtml } from "./devicePage.ts";
import {
  ConnectDatabaseError,
  createConnectDatabase,
  type EndpointInput,
  type EndpointKind,
} from "./database.ts";
import {
  CloudflareManagedTunnelClient,
  ManagedTunnelError,
  ManagedTunnelService,
} from "./managedTunnel.ts";
import { pairingApiErrorCode, type PairingValidationError } from "./pairing.ts";
import { FixedWindowRateLimiter } from "./rateLimit.ts";
import { ConnectClientIp } from "./clientIp.ts";
import { cleanupLegacyRoutingRecords } from "./legacyRoutingRetention.ts";

class HttpError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message = code) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function writeJson(response: NodeHttp.ServerResponse, status: number, body: unknown): void {
  response.statusCode = status;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.end(JSON.stringify(body));
}

async function readJson(request: NodeHttp.IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > 64 * 1024) throw new HttpError(413, "payload_too_large");
    chunks.push(buffer);
  }
  if (size === 0) return {};
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      throw new Error("object required");
    return parsed as Record<string, unknown>;
  } catch {
    throw new HttpError(400, "invalid_json");
  }
}

function requiredString(body: Record<string, unknown>, key: string, maxLength = 4096): string {
  const value = body[key];
  if (typeof value !== "string" || value.trim().length === 0 || value.length > maxLength) {
    throw new HttpError(400, "invalid_request", `${key} must be a non-empty string`);
  }
  return value.trim();
}

function parseEndpointKind(value: string): EndpointKind {
  if (value === "tailscale" || value === "cloudflare_tunnel") return value;
  throw new HttpError(400, "invalid_endpoint_kind");
}

function validateUrl(value: string, protocols: readonly string[]): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new HttpError(400, "invalid_endpoint_url");
  }
  if (!protocols.includes(url.protocol)) throw new HttpError(400, "invalid_endpoint_url");
  return url.toString().replace(/\/$/, "");
}

function parseEndpoint(value: unknown): EndpointInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new HttpError(400, "invalid_endpoint");
  }
  const record = value as Record<string, unknown>;
  const kind = parseEndpointKind(requiredString(record, "kind", 32));
  return {
    kind,
    httpBaseUrl: validateUrl(requiredString(record, "httpBaseUrl"), ["http:", "https:"]),
    wsBaseUrl: validateUrl(requiredString(record, "wsBaseUrl"), ["ws:", "wss:"]),
  };
}

function parseEndpoints(value: unknown): readonly EndpointInput[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 2) throw new HttpError(400, "invalid_endpoints");
  const endpoints = value.map(parseEndpoint);
  if (new Set(endpoints.map((endpoint) => endpoint.kind)).size !== endpoints.length) {
    throw new HttpError(400, "duplicate_endpoint_kind");
  }
  return endpoints;
}

function bearerToken(request: NodeHttp.IncomingMessage): string | null {
  const header = request.headers.authorization;
  if (!header?.startsWith("Bearer ")) return null;
  const token = header.slice("Bearer ".length).trim();
  return token || null;
}

function applyCors(
  request: NodeHttp.IncomingMessage,
  response: NodeHttp.ServerResponse,
  allowedOrigins: readonly string[],
): void {
  const origin = request.headers.origin;
  if (!origin || !isAllowedCorsOrigin(origin, allowedOrigins)) return;
  response.setHeader("access-control-allow-origin", origin);
  response.setHeader("access-control-allow-credentials", "true");
  response.setHeader("vary", "Origin");
  response.setHeader("access-control-allow-headers", "authorization, content-type");
  response.setHeader("access-control-allow-methods", "GET, POST, PUT, DELETE, OPTIONS");
}

const config = loadConfig();
const database = createConnectDatabase(config);
const connectAuth = createConnectAuth(config, database.pool);
const managedTunnelService = config.managedTunnel
  ? new ManagedTunnelService({
      store: database,
      cloudflare: new CloudflareManagedTunnelClient(config.managedTunnel),
      tunnelDomain: config.managedTunnel.tunnelDomain,
    })
  : null;
const pairingRedeemDeviceLimiter = new FixedWindowRateLimiter(30, 60_000);
const pairingRedeemAccountLimiter = new FixedWindowRateLimiter(120, 60_000);
const clientIp = new ConnectClientIp(config.trustedProxyCidrs);
await connectAuth.migrate();
await database.migrate();
await cleanupLegacyRoutingRecords(database.pool);
const routingCleanup = setInterval(
  () => {
    void cleanupLegacyRoutingRecords(database.pool).catch(() =>
      console.error("[dispatch-connect] routing retention cleanup failed"),
    );
  },
  60 * 60 * 1000,
);
routingCleanup.unref();

const server = NodeHttp.createServer(async (request, response) => {
  const ip = clientIp.resolve(request);
  // Never allow a client-supplied header to bypass Better Auth's persistent signup limits.
  request.headers["x-dispatch-client-ip"] = ip;
  applyCors(request, response, config.allowedOrigins);
  if (request.method === "OPTIONS") {
    response.statusCode = 204;
    response.end();
    return;
  }

  const url = new URL(request.url ?? "/", config.betterAuthUrl);
  if (url.pathname === "/device" && request.method === "GET") {
    response.statusCode = 200;
    response.setHeader("content-type", "text/html; charset=utf-8");
    response.setHeader("cache-control", "no-store");
    response.setHeader("x-content-type-options", "nosniff");
    response.setHeader("x-frame-options", "DENY");
    response.setHeader(
      "content-security-policy",
      "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    );
    response.end(dispatchConnectDevicePageHtml());
    return;
  }
  if (url.pathname === "/health" && request.method === "GET") {
    try {
      await database.health();
      writeJson(response, 200, { ok: true, service: "dispatch-connect", version: "v1" });
    } catch {
      writeJson(response, 503, {
        ok: false,
        service: "dispatch-connect",
        error: "database_unavailable",
      });
    }
    return;
  }

  if (url.pathname === "/v1/managed-tunnel/capability" && request.method === "GET") {
    writeJson(response, 200, {
      available: managedTunnelService !== null,
      provider: managedTunnelService ? "cloudflare" : null,
    });
    return;
  }

  if (url.pathname === "/api/auth" || url.pathname.startsWith("/api/auth/")) {
    await connectAuth.nodeHandler(request, response);
    return;
  }

  try {
    const sessionUser = async () => {
      const session = await connectAuth.getSession(request.headers);
      if (!session) throw new HttpError(401, "authentication_required");
      return session.user;
    };

    if (url.pathname === "/v1/devices" && request.method === "POST") {
      const user = await sessionUser();
      const body = await readJson(request);
      const device = await database.createDevice(user.id, {
        label: requiredString(body, "label", 160),
        publicKey: requiredString(body, "publicKey", 4096),
      });
      writeJson(response, 201, { device });
      return;
    }

    if (url.pathname === "/v1/devices" && request.method === "GET") {
      const user = await sessionUser();
      const devices = await database.devicesForUser(user.id);
      writeJson(response, 200, { devices });
      return;
    }

    const deleteDeviceMatch = url.pathname.match(/^\/v1\/devices\/([^/]+)$/);
    if (deleteDeviceMatch && request.method === "DELETE") {
      const user = await sessionUser();
      await database.deleteDevice(user.id, decodeURIComponent(deleteDeviceMatch[1] ?? ""));
      response.statusCode = 204;
      response.end();
      return;
    }

    if (url.pathname === "/v1/environments" && request.method === "POST") {
      const user = await sessionUser();
      const body = await readJson(request);
      const created = await database.createEnvironment(user.id, {
        label: requiredString(body, "label", 160),
        publicKey: requiredString(body, "publicKey", 4096),
        endpoints: parseEndpoints(body.endpoints),
      });
      writeJson(response, 201, created);
      return;
    }

    if (url.pathname === "/v1/environments" && request.method === "GET") {
      const user = await sessionUser();
      const environments = await database.ownedEnvironments(user.id);
      writeJson(response, 200, { environments });
      return;
    }

    const rotateCredentialMatch = url.pathname.match(
      /^\/v1\/environments\/([^/]+)\/credentials\/rotate$/,
    );
    if (rotateCredentialMatch && request.method === "POST") {
      const user = await sessionUser();
      const environmentId = decodeURIComponent(rotateCredentialMatch[1] ?? "");
      const credential = await database.rotateEnvironmentCredential(user.id, environmentId);
      writeJson(response, 200, { credential });
      return;
    }

    const revokeCredentialsMatch = url.pathname.match(/^\/v1\/environments\/([^/]+)\/credentials$/);
    if (revokeCredentialsMatch && request.method === "DELETE") {
      const user = await sessionUser();
      const environmentId = decodeURIComponent(revokeCredentialsMatch[1] ?? "");
      await database.revokeEnvironmentCredentials(user.id, environmentId);
      response.statusCode = 204;
      response.end();
      return;
    }

    const managedTunnelMatch = url.pathname.match(/^\/v1\/environments\/([^/]+)\/managed-tunnel$/);
    if (managedTunnelMatch && request.method === "POST") {
      if (!managedTunnelService) throw new HttpError(503, "managed_tunnel_unavailable");
      const environmentId = decodeURIComponent(managedTunnelMatch[1] ?? "");
      const credential = bearerToken(request);
      if (!credential || !credential.startsWith("dce_"))
        throw new HttpError(401, "environment_auth_required");
      if (!(await database.verifyEnvironmentCredential(environmentId, credential))) {
        throw new HttpError(401, "environment_auth_invalid");
      }
      const body = await readJson(request);
      const result = await managedTunnelService.ensure(environmentId, body.localOrigin);
      writeJson(response, 200, result);
      return;
    }

    if (managedTunnelMatch && request.method === "DELETE") {
      if (!managedTunnelService) throw new HttpError(503, "managed_tunnel_unavailable");
      const environmentId = decodeURIComponent(managedTunnelMatch[1] ?? "");
      const credential = bearerToken(request);
      const allocation = credential?.startsWith("dce_")
        ? (await database.verifyEnvironmentCredential(environmentId, credential))
          ? await database.getManagedTunnelAllocation(environmentId)
          : (() => {
              throw new HttpError(401, "environment_auth_invalid");
            })()
        : await database.getManagedTunnelAllocationForOwner(
            (await sessionUser()).id,
            environmentId,
          );
      if (!allocation) throw new ManagedTunnelError("managed_tunnel_not_provisioned");
      const result = await managedTunnelService.remove(environmentId, allocation);
      writeJson(response, 200, { deleted: true, ...result });
      return;
    }

    const managedTunnelTokenMatch = url.pathname.match(
      /^\/v1\/environments\/([^/]+)\/managed-tunnel\/token$/,
    );
    if (managedTunnelTokenMatch && request.method === "GET") {
      if (!managedTunnelService) throw new HttpError(503, "managed_tunnel_unavailable");
      const environmentId = decodeURIComponent(managedTunnelTokenMatch[1] ?? "");
      const credential = bearerToken(request);
      if (!credential || !credential.startsWith("dce_"))
        throw new HttpError(401, "environment_auth_required");
      if (!(await database.verifyEnvironmentCredential(environmentId, credential))) {
        throw new HttpError(401, "environment_auth_invalid");
      }
      const result = await managedTunnelService.reconnectToken(environmentId);
      writeJson(response, 200, result);
      return;
    }

    const endpointMatch = url.pathname.match(
      /^\/v1\/environments\/([^/]+)\/endpoints\/(tailscale|cloudflare_tunnel)$/,
    );
    if (endpointMatch && request.method === "PUT") {
      const environmentId = decodeURIComponent(endpointMatch[1] ?? "");
      const kind = parseEndpointKind(endpointMatch[2] ?? "");
      const credential = bearerToken(request);
      if (!credential || !credential.startsWith("dce_"))
        throw new HttpError(401, "environment_auth_required");
      if (!(await database.verifyEnvironmentCredential(environmentId, credential))) {
        throw new HttpError(401, "environment_auth_invalid");
      }
      const body = await readJson(request);
      const endpoint = await database.upsertEndpoint(environmentId, {
        kind,
        httpBaseUrl: validateUrl(requiredString(body, "httpBaseUrl"), ["http:", "https:"]),
        wsBaseUrl: validateUrl(requiredString(body, "wsBaseUrl"), ["ws:", "wss:"]),
      });
      writeJson(response, 200, { endpoint });
      return;
    }

    const pairingCreateMatch = url.pathname.match(/^\/v1\/environments\/([^/]+)\/pairings$/);
    if (pairingCreateMatch && request.method === "POST") {
      const environmentId = decodeURIComponent(pairingCreateMatch[1] ?? "");
      const credential = bearerToken(request);
      if (!credential || !credential.startsWith("dce_"))
        throw new HttpError(401, "environment_auth_required");
      if (!(await database.verifyEnvironmentCredential(environmentId, credential))) {
        throw new HttpError(401, "environment_auth_invalid");
      }
      const body = await readJson(request);
      const requestedCode = requiredString(body, "code", 32);
      const requestedExpiresAt =
        typeof body.expiresAt === "string" && body.expiresAt.trim()
          ? new Date(body.expiresAt)
          : undefined;
      if (requestedExpiresAt && Number.isNaN(requestedExpiresAt.getTime())) {
        throw new HttpError(400, "invalid_expires_at");
      }
      const pairing = await database.createPairing(
        environmentId,
        requestedCode,
        requestedExpiresAt,
      );
      writeJson(response, 201, { pairing });
      return;
    }

    if (url.pathname === "/v1/pairings/redeem" && request.method === "POST") {
      const user = await sessionUser();
      const body = await readJson(request);
      const deviceId = requiredString(body, "deviceId", 128);
      if (
        !pairingRedeemAccountLimiter.consume(user.id) ||
        !pairingRedeemDeviceLimiter.consume(`${user.id}:${deviceId}`)
      ) {
        throw new HttpError(429, "pairing_rate_limited");
      }
      const environment = await database.redeemPairing(
        user.id,
        deviceId,
        requiredString(body, "code", 32),
      );
      writeJson(response, 200, { environment });
      return;
    }

    const deviceEnvironmentsMatch = url.pathname.match(/^\/v1\/devices\/([^/]+)\/environments$/);
    if (deviceEnvironmentsMatch && request.method === "GET") {
      const user = await sessionUser();
      const deviceId = decodeURIComponent(deviceEnvironmentsMatch[1] ?? "");
      const environments = await database.environmentsForDevice(user.id, deviceId);
      writeJson(response, 200, { environments });
      return;
    }

    const grantsMatch = url.pathname.match(/^\/v1\/environments\/([^/]+)\/grants$/);
    if (grantsMatch && request.method === "GET") {
      const user = await sessionUser();
      const environmentId = decodeURIComponent(grantsMatch[1] ?? "");
      const grants = await database.listGrants(user.id, environmentId);
      writeJson(response, 200, { grants });
      return;
    }

    const revokeMatch = url.pathname.match(/^\/v1\/environments\/([^/]+)\/grants\/([^/]+)$/);
    if (revokeMatch && request.method === "DELETE") {
      const user = await sessionUser();
      await database.revokeGrant(
        user.id,
        decodeURIComponent(revokeMatch[1] ?? ""),
        decodeURIComponent(revokeMatch[2] ?? ""),
      );
      response.statusCode = 204;
      response.end();
      return;
    }

    throw new HttpError(404, "not_found");
  } catch (error) {
    if (error instanceof HttpError) {
      writeJson(response, error.status, { error: error.code, message: error.message });
      return;
    }
    if (error instanceof ConnectDatabaseError) {
      const status =
        error.code === "not_found" ? 404 : error.code === "device_not_owned" ? 403 : 400;
      const isPairingError =
        error.code === "invalid" ||
        error.code === "expired" ||
        error.code === "used" ||
        error.code === "device_not_owned";
      const publicCode = isPairingError
        ? pairingApiErrorCode(error.code as PairingValidationError)
        : error.code;
      writeJson(response, status, { error: publicCode });
      return;
    }
    if (error instanceof ManagedTunnelError) {
      const status =
        error.code === "invalid_local_origin"
          ? 400
          : error.code === "managed_tunnel_upstream_error"
            ? 502
            : 404;
      writeJson(response, status, { error: error.code });
      return;
    }
    const pgCode =
      typeof error === "object" && error !== null && "code" in error ? String(error.code) : "";
    if (pgCode === "23505") {
      writeJson(response, 409, { error: "conflict" });
      return;
    }
    console.error("[dispatch-connect] request failed", error);
    writeJson(response, 500, { error: "internal_error" });
  }
});
server.requestTimeout = 10_000;
server.headersTimeout = 10_000;

server.listen(config.port, config.host, () => {
  console.log(`[dispatch-connect] listening on http://${config.host}:${config.port}`);
});

let shuttingDown = false;
const shutdown = async () => {
  if (shuttingDown) return;
  shuttingDown = true;
  clearInterval(routingCleanup);
  server.close();
  await database.close();
};

process.once("SIGTERM", () => void shutdown());
process.once("SIGINT", () => void shutdown());

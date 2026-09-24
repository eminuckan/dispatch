// @effect-diagnostics nodeBuiltinImport:off preferSchemaOverJson:off - The standalone Connect service uses Node HTTP directly.
import * as NodeCrypto from "node:crypto";
import type * as NodeHttp from "node:http";

import type { ConnectClientIp } from "./clientIp.ts";
import { FixedWindowRateLimiter } from "./rateLimit.ts";
import {
  SMART_ROUTING_MAX_BYTES,
  SmartRoutingError,
  type SmartRoutingOperation,
} from "./smartRouting.ts";
import type { SmartRoutingService } from "./smartRoutingService.ts";
import type { SmartRoutingSession, SmartRoutingStore } from "./smartRoutingStore.ts";

function writeJson(response: NodeHttp.ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(JSON.stringify(body));
}

async function readBody(request: NodeHttp.IncomingMessage): Promise<unknown> {
  if (
    request.headers["content-type"]?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json"
  )
    throw new SmartRoutingError(415, "unsupported_media_type");
  if (request.headers["content-encoding"] && request.headers["content-encoding"] !== "identity")
    throw new SmartRoutingError(415, "unsupported_content_encoding");
  if (Number(request.headers["content-length"] ?? 0) > SMART_ROUTING_MAX_BYTES)
    throw new SmartRoutingError(413, "smart_routing_payload_too_large");
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.byteLength;
    if (size > SMART_ROUTING_MAX_BYTES)
      throw new SmartRoutingError(413, "smart_routing_payload_too_large");
    chunks.push(buffer);
  }
  try {
    return JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)),
    ) as unknown;
  } catch {
    throw new SmartRoutingError(400, "smart_routing_invalid_request");
  }
}

export function createSmartRoutingHttpHandler(input: {
  readonly store: Pick<SmartRoutingStore, "authenticate">;
  readonly service: Pick<SmartRoutingService, "execute" | "capability"> | null;
  readonly clientIp: ConnectClientIp;
  readonly credentialSecret: string;
  readonly getSession: (token: string) => Promise<SmartRoutingSession | null>;
}) {
  const ingress = new FixedWindowRateLimiter(180, 60_000);
  return async (
    request: NodeHttp.IncomingMessage,
    response: NodeHttp.ServerResponse,
    pathname: string,
    ip: string,
  ): Promise<boolean> => {
    const match = pathname.match(
      /^\/v1\/environments\/([^/]+)\/smart-routing\/(capability|execution|profile|effort|workers|recommendations)$/,
    );
    if (!match) return false;
    try {
      if (!ingress.consume(input.clientIp.bucket(ip)))
        throw new SmartRoutingError(429, "smart_routing_rate_limited", 60);
      const action = match[2]!;
      if (request.method !== (action === "capability" ? "GET" : "POST"))
        throw new SmartRoutingError(405, "method_not_allowed");
      let environmentId: string;
      try {
        environmentId = decodeURIComponent(match[1]!);
      } catch {
        throw new SmartRoutingError(400, "smart_routing_invalid_request");
      }
      if (!environmentId || environmentId.length > 128)
        throw new SmartRoutingError(400, "smart_routing_invalid_request");
      const authorization = request.headers.authorization;
      const credential = authorization?.startsWith("Bearer ")
        ? authorization.slice(7).trim()
        : null;
      if (!credential) throw new SmartRoutingError(401, "environment_auth_required");
      const accountToken = request.headers["x-dispatch-connect-session"];
      if (typeof accountToken !== "string" || !accountToken.trim() || accountToken.length > 4096) {
        throw new SmartRoutingError(401, "smart_routing_session_required");
      }
      const session = await input.getSession(accountToken.trim());
      if (!session) throw new SmartRoutingError(401, "smart_routing_session_invalid");
      // Identity and account restrictions are resolved before accepting the body or contacting JEV.
      const principal = await input.store.authenticate(environmentId, credential, session);
      if (action === "capability") {
        writeJson(
          response,
          200,
          input.service
            ? await input.service.capability(principal)
            : { available: false, reason: "smart_routing_unavailable" },
        );
        return true;
      }
      if (!input.service) throw new SmartRoutingError(503, "smart_routing_unavailable");
      const body = await readBody(request);
      const ipHash = NodeCrypto.createHmac("sha256", input.credentialSecret)
        .update(input.clientIp.bucket(ip))
        .digest("hex");
      const result = await input.service.execute(
        principal,
        action as SmartRoutingOperation,
        body,
        ipHash,
      );
      writeJson(response, 200, result);
    } catch (error) {
      // No raw provider/DB exceptions, credentials or objective text reach the public response.
      const failure =
        error instanceof SmartRoutingError
          ? error
          : new SmartRoutingError(503, "smart_routing_unavailable");
      if (failure.retryAfter !== null)
        response.setHeader("retry-after", String(failure.retryAfter));
      if (!request.complete) response.setHeader("connection", "close");
      writeJson(response, failure.status, { error: failure.code });
    }
    return true;
  };
}

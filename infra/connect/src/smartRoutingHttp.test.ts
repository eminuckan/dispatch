// @effect-diagnostics nodeBuiltinImport:off preferSchemaOverJson:off globalFetch:off - These tests exercise the real Node HTTP boundary.
import * as NodeAssert from "node:assert/strict";
import * as NodeTest from "node:test";
import * as NodeHttp from "node:http";

import { ConnectClientIp } from "./clientIp.ts";
import { SmartRoutingError } from "./smartRouting.ts";
import { createSmartRoutingHttpHandler } from "./smartRoutingHttp.ts";
import type { SmartRoutingPrincipal } from "./smartRoutingStore.ts";

async function fixture(
  t: NodeTest.TestContext,
  options: { unavailable?: boolean; quotaExhausted?: boolean } = {},
) {
  let calls = 0;
  const seen: { principal: SmartRoutingPrincipal; ipHash: string }[] = [];
  const clientIp = new ConnectClientIp([]);
  const handler = createSmartRoutingHttpHandler({
    credentialSecret: "test-credential-secret",
    clientIp,
    getSession: async (token) =>
      token === "account-test-session"
        ? { accountId: "owner-from-database", sessionId: "session-1" }
        : token === "foreign-test-session"
          ? { accountId: "foreign-owner", sessionId: "session-2" }
          : null,
    store: {
      authenticate: async (environmentId, credential, session) => {
        if (
          environmentId !== "registered-env" ||
          credential !== "dce_valid-test-key" ||
          session.accountId !== "owner-from-database"
        )
          throw new SmartRoutingError(401, "environment_auth_invalid");
        return {
          accountId: "owner-from-database",
          environmentId,
          credentialId: "credential-1",
          sessionId: session.sessionId,
          newAccount: false,
        };
      },
    },
    service: options.unavailable
      ? null
      : {
          capability: async () => ({ available: true, reason: null }),
          execute: async (principal, _operation, _body, ipHash) => {
            if (options.quotaExhausted)
              throw new SmartRoutingError(429, "smart_routing_quota_exhausted", 60);
            calls++;
            seen.push({ principal, ipHash });
            return { mode: "direct", source: "jev", confidence: 0.99, reason: "One worker" };
          },
        },
  });
  const server = NodeHttp.createServer(async (request, response) => {
    if (
      !(await handler(
        request,
        response,
        new URL(request.url!, "http://localhost").pathname,
        clientIp.resolve(request),
      ))
    ) {
      response.writeHead(404).end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(
    () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  );
  const address = server.address();
  NodeAssert.ok(address && typeof address !== "string");
  const baseUrl = `http://127.0.0.1:${address.port}`;
  return { baseUrl, calls: () => calls, seen };
}

NodeTest.test(
  "HTTP router requires an authenticated registered environment before contacting the paid service",
  async (t) => {
    const f = await fixture(t);
    const route = `${f.baseUrl}/v1/environments/registered-env/smart-routing/execution`;
    for (const authorization of [
      undefined,
      "Bearer account-session-token",
      "Bearer dce_invalid-token",
    ]) {
      const response = await fetch(route, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-dispatch-connect-session": "account-test-session",
          ...(authorization ? { authorization } : {}),
        },
        body: "{}",
      });
      NodeAssert.equal(response.status, 401);
      NodeAssert.equal(response.headers.get("cache-control"), "no-store");
    }
    const wrongEnv = await fetch(
      `${f.baseUrl}/v1/environments/foreign-env/smart-routing/execution`,
      {
        method: "POST",
        headers: {
          authorization: "Bearer dce_valid-test-key",
          "content-type": "application/json",
          "x-dispatch-connect-session": "account-test-session",
        },
        body: "{}",
      },
    );
    NodeAssert.equal(wrongEnv.status, 401);
    NodeAssert.equal(f.calls(), 0);
    const valid = await fetch(route, {
      method: "POST",
      headers: {
        authorization: "Bearer dce_valid-test-key",
        "x-dispatch-connect-session": "account-test-session",
        "content-type": "application/json",
        "x-forwarded-for": "192.0.2.8",
      },
      body: "{}",
    });
    NodeAssert.equal(valid.status, 200);
    NodeAssert.equal(f.calls(), 1);
    NodeAssert.equal(f.seen[0]?.principal.accountId, "owner-from-database");
    NodeAssert.match(f.seen[0]!.ipHash, /^[a-f0-9]{64}$/);
  },
);

NodeTest.test(
  "HTTP transport enforces body bounds, encoding, method and JSON before inference",
  async (t) => {
    const f = await fixture(t);
    const route = `${f.baseUrl}/v1/environments/registered-env/smart-routing/execution`;
    const authorization = "Bearer dce_valid-test-key";
    for (const testCase of [
      { headers: { "content-type": "text/plain" }, body: "{}", status: 415 },
      { headers: { "content-type": "application/json-malformed" }, body: "{}", status: 415 },
      {
        headers: { "content-type": "application/json", "content-encoding": "gzip" },
        body: "{}",
        status: 415,
      },
      { headers: { "content-type": "application/json" }, body: "x".repeat(24_001), status: 413 },
      { headers: { "content-type": "application/json" }, body: "malformed", status: 400 },
    ]) {
      const response = await fetch(route, {
        method: "POST",
        headers: {
          authorization,
          "x-dispatch-connect-session": "account-test-session",
          ...testCase.headers,
        },
        body: testCase.body,
      });
      NodeAssert.equal(response.status, testCase.status);
    }
    NodeAssert.equal((await fetch(route, { headers: { authorization } })).status, 405);
    NodeAssert.equal(f.calls(), 0);
  },
);

NodeTest.test(
  "disabled or exhausted hosted service returns explicit fallback status without exposing secrets",
  async (t) => {
    const disabled = await fixture(t, { unavailable: true });
    const headers = {
      authorization: "Bearer dce_valid-test-key",
      "x-dispatch-connect-session": "account-test-session",
      "content-type": "application/json",
    };
    const capability = await fetch(
      `${disabled.baseUrl}/v1/environments/registered-env/smart-routing/capability`,
      { headers },
    );
    NodeAssert.deepEqual(await capability.json(), {
      available: false,
      reason: "smart_routing_unavailable",
    });
    const post = await fetch(
      `${disabled.baseUrl}/v1/environments/registered-env/smart-routing/profile`,
      { headers, method: "POST", body: "{}" },
    );
    NodeAssert.equal(post.status, 503);
    const exhausted = await fixture(t, { quotaExhausted: true });
    const quota = await fetch(
      `${exhausted.baseUrl}/v1/environments/registered-env/smart-routing/execution`,
      { headers, method: "POST", body: "{}" },
    );
    NodeAssert.equal(quota.status, 429);
    NodeAssert.equal(quota.headers.get("retry-after"), "60");
    NodeAssert.deepEqual(await quota.json(), { error: "smart_routing_quota_exhausted" });
    NodeAssert.equal(exhausted.calls(), 0);
  },
);

NodeTest.test(
  "missing, expired, revoked and foreign account sessions cannot spend through an active environment credential",
  async (t) => {
    const f = await fixture(t);
    for (const token of [null, "expired-session", "revoked-session", "foreign-test-session"]) {
      for (const operation of ["capability", "execution", "profile", "recommendations"]) {
        const response = await fetch(
          `${f.baseUrl}/v1/environments/registered-env/smart-routing/${operation}`,
          {
            method: operation === "capability" ? "GET" : "POST",
            headers: {
              authorization: "Bearer dce_valid-test-key",
              "content-type": "application/json",
              ...(token ? { "x-dispatch-connect-session": token } : {}),
            },
            ...(operation === "capability" ? {} : { body: "{}" }),
          },
        );
        NodeAssert.equal(response.status, 401);
        const body = JSON.stringify(await response.json());
        NodeAssert.equal(body.includes("dce_valid-test-key"), false);
        NodeAssert.equal(token ? body.includes(token) : false, false);
      }
    }
    NodeAssert.equal(f.calls(), 0);
  },
);

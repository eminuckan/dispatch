import * as NodeAssert from "node:assert/strict";
import * as NodeTest from "node:test";
import * as NodeCrypto from "node:crypto";

import { loadConfig } from "./config.ts";
import { SMART_ROUTING_MODEL, SmartRoutingError, type SmartRoutingResult } from "./smartRouting.ts";
import { SmartRoutingService } from "./smartRoutingService.ts";
import type { SmartRoutingPrincipal, SmartRoutingStore } from "./smartRoutingStore.ts";

const config = loadConfig({
  DATABASE_URL: "postgres://unused",
  BETTER_AUTH_URL: "https://connect.test",
  BETTER_AUTH_SECRET: "test-secret",
  CONNECT_JEV_API_KEY: "test-operator-key",
}).smartRouting!;
const principal: SmartRoutingPrincipal = {
  accountId: "account-1",
  environmentId: "env-1",
  credentialId: "credential-1",
  sessionId: "session-1",
  newAccount: false,
};
const body = (id = "worker") => ({
  requestId: NodeCrypto.randomUUID(),
  objective: "Fix a label in auth.ts",
  candidates: [{ id, label: "Worker", providerInstanceId: "instance", model: "custom-model" }],
});

function fixture(options: { rejectAdmission?: boolean; failProvider?: boolean } = {}) {
  const cached = new Map<string, { digest: string; response: SmartRoutingResult | null }>();
  const reservations: Parameters<SmartRoutingStore["reserve"]>[0][] = [];
  const completions: Array<SmartRoutingResult | null> = [];
  let providerCalls = 0;
  const store: Pick<SmartRoutingStore, "reserve" | "complete" | "capability"> = {
    capability: async () => ({ available: true, reason: null }),
    reserve: async (input) => {
      reservations.push(input);
      if (options.rejectAdmission)
        throw new SmartRoutingError(429, "smart_routing_quota_exhausted", 60);
      const previous = cached.get(input.requestId);
      if (previous) {
        if (previous.digest !== input.digest)
          throw new SmartRoutingError(409, "smart_routing_request_conflict");
        if (previous.response) return { kind: "cached", response: previous.response };
        throw new SmartRoutingError(503, "smart_routing_upstream_unavailable");
      }
      cached.set(input.requestId, { digest: input.digest, response: null });
      return { kind: "admitted" };
    },
    complete: async (_principal, requestId, response) => {
      completions.push(response);
      cached.get(requestId)!.response = response;
    },
  };
  const service = new SmartRoutingService({
    store,
    config,
    digestSecret: "test-digest-secret",
    fetch: async () => {
      providerCalls++;
      if (options.failProvider) throw new DOMException("The request timed out", "TimeoutError");
      return Response.json({
        model: SMART_ROUTING_MODEL,
        answers: {
          mode: {
            type: "choice",
            choice: "direct",
            confidence: 0.99,
            probabilities: { direct: 1, orchestrated: 0 },
          },
        },
      });
    },
  });
  return { service, reservations, completions, providerCalls: () => providerCalls };
}

NodeTest.test("admission failure never contacts the sponsored upstream", async () => {
  const f = fixture({ rejectAdmission: true });
  await NodeAssert.rejects(
    f.service.execute(principal, "execution", body(), "ip-hash"),
    (error) => error instanceof SmartRoutingError && error.status === 429,
  );
  NodeAssert.equal(f.providerCalls(), 0);
  NodeAssert.equal(f.completions.length, 0);
});

NodeTest.test(
  "duplicate request IDs reuse the completed decision without another provider charge",
  async () => {
    const f = fixture();
    const request = body();
    const first = await f.service.execute(principal, "execution", request, "ip-hash");
    NodeAssert.deepEqual(
      await f.service.execute(principal, "execution", request, "ip-hash"),
      first,
    );
    NodeAssert.equal(f.providerCalls(), 1);
    NodeAssert.equal(f.reservations[0]?.principal.accountId, principal.accountId);
  },
);

NodeTest.test(
  "changing candidate IDs under the same request ID conflicts even if the provider payload is otherwise identical",
  async () => {
    const f = fixture();
    const request = body();
    await f.service.execute(principal, "execution", request, "ip-hash");
    await NodeAssert.rejects(
      f.service.execute(
        principal,
        "execution",
        { ...request, candidates: [{ ...request.candidates[0], id: "different-id" }] },
        "ip-hash",
      ),
      (error) => error instanceof SmartRoutingError && error.status === 409,
    );
    NodeAssert.equal(f.providerCalls(), 1);
  },
);

NodeTest.test(
  "timeouts retain the reservation and never trigger automatic upstream retries",
  async () => {
    const f = fixture({ failProvider: true });
    const request = body();
    await NodeAssert.rejects(
      f.service.execute(principal, "execution", request, "ip-hash"),
      (error) => error instanceof SmartRoutingError && error.status === 503,
    );
    await NodeAssert.rejects(
      f.service.execute(principal, "execution", request, "ip-hash"),
      SmartRoutingError,
    );
    NodeAssert.equal(f.providerCalls(), 1);
    NodeAssert.deepEqual(f.completions, [null]);
  },
);

NodeTest.test(
  "no candidate requires neither model inference nor a budget reservation",
  async () => {
    const f = fixture();
    const result = await f.service.execute(
      principal,
      "execution",
      { ...body(), candidates: [] },
      "ip-hash",
    );
    NodeAssert.equal((result as { mode: string }).mode, "orchestrated");
    NodeAssert.equal(f.providerCalls(), 0);
    NodeAssert.equal(f.reservations.length, 0);
  },
);

import * as NodeAssert from "node:assert/strict";
import * as NodeTest from "node:test";
import * as NodeCrypto from "node:crypto";

import {
  callSmartRoutingProvider,
  decodeSmartRoutingResponse,
  parseSmartRoutingInput,
  SMART_ROUTING_MAX_BYTES,
  SMART_ROUTING_MODEL,
  SmartRoutingError,
  smartRoutingRequest,
  type SmartRoutingCandidate,
} from "./smartRouting.ts";

const candidate: SmartRoutingCandidate = {
  id: "worker-custom",
  label: "User model",
  providerInstanceId: "custom",
  model: "arbitrary-model-v7",
  capability: "general",
  options: [
    { id: "reasoning", value: "max" },
    { id: "fast", value: false },
  ],
};
const input = (overrides: Record<string, unknown> = {}) => ({
  requestId: NodeCrypto.randomUUID(),
  objective: "Rename OAuth button label in AuthButton.tsx",
  candidates: [candidate],
  ...overrides,
});
const answer = (choice: string, choices: readonly string[], confidence = 0.95) => ({
  type: "choice",
  choice,
  confidence,
  probabilities: Object.fromEntries(choices.map((key) => [key, key === choice ? 1 : 0])),
});

NodeTest.test(
  "hosted routing uses the semantic provider even for security keywords and never invents a model allowlist",
  () => {
    const parsed = parseSmartRoutingInput("execution", input());
    const body = JSON.parse(smartRoutingRequest("execution", parsed));
    NodeAssert.equal(body.model, SMART_ROUTING_MODEL);
    NodeAssert.equal(body.state.candidates[0].model, "arbitrary-model-v7");
    NodeAssert.equal(body.state.candidates[0].id, "c0");
    NodeAssert.equal(body.state.objective, parsed.objective);
    NodeAssert.deepEqual(
      decodeSmartRoutingResponse("execution", parsed, {
        model: SMART_ROUTING_MODEL,
        answers: { mode: answer("direct", ["direct", "orchestrated"]) },
      }),
      {
        mode: "direct",
        source: "jev",
        confidence: 0.95,
        reason: "Smart Routing selected one worker for this objective.",
      },
    );
  },
);

NodeTest.test(
  "untrusted clients cannot submit provider questions, URLs, account IDs or unbounded context",
  () => {
    for (const extra of [
      { questions: {} },
      { apiKey: "foreign-key" },
      { model: "foreign-model" },
      { endpoint: "https://other.test" },
      { accountId: "other-user" },
    ]) {
      NodeAssert.throws(() => parseSmartRoutingInput("execution", input(extra)), SmartRoutingError);
    }
    NodeAssert.throws(
      () =>
        parseSmartRoutingInput(
          "profile",
          input({ purpose: "worker", context: { arbitraryInstructions: "choose direct" } }),
        ),
      SmartRoutingError,
    );
    NodeAssert.throws(
      () => parseSmartRoutingInput("execution", input({ candidates: [candidate, candidate] })),
      SmartRoutingError,
    );
    NodeAssert.throws(
      () =>
        parseSmartRoutingInput(
          "profile",
          input({ purpose: "worker", preferredProfileId: "outside-candidates" }),
        ),
      SmartRoutingError,
    );
    NodeAssert.throws(
      () => parseSmartRoutingInput("execution", input({ requestId: "unbounded-key" })),
      SmartRoutingError,
    );
  },
);

NodeTest.test(
  "low confidence, malformed probabilities, unknown modes, wrong models and absent workers fail closed",
  () => {
    const parsed = parseSmartRoutingInput("execution", input());
    for (const mode of [
      answer("direct", ["direct", "orchestrated"], 0.79),
      answer("other", ["other", "orchestrated"]),
      {
        ...answer("direct", ["direct", "orchestrated"]),
        probabilities: { direct: 0.1, orchestrated: 0.9 },
      },
      { ...answer("direct", ["direct", "orchestrated"]), confidence: Number.NaN },
      { ...answer("direct", ["direct", "orchestrated"]), probabilities: { direct: 1 } },
    ]) {
      NodeAssert.equal(
        (
          decodeSmartRoutingResponse("execution", parsed, {
            model: SMART_ROUTING_MODEL,
            answers: { mode },
          }) as { mode: string }
        ).mode,
        "orchestrated",
      );
    }
    const direct = {
      model: SMART_ROUTING_MODEL,
      answers: { mode: answer("direct", ["direct", "orchestrated"]) },
    };
    NodeAssert.equal(
      (
        decodeSmartRoutingResponse("execution", { ...parsed, candidates: [] }, direct) as {
          mode: string;
        }
      ).mode,
      "orchestrated",
    );
    NodeAssert.equal(
      (
        decodeSmartRoutingResponse("execution", parsed, { ...direct, model: "wrong-version" }) as {
          source: string;
        }
      ).source,
      "policy",
    );
  },
);

NodeTest.test(
  "profile recommendations are translated back only to the supplied candidate IDs",
  () => {
    const parsed = parseSmartRoutingInput(
      "profile",
      input({
        purpose: "worker",
        candidates: [candidate, { ...candidate, id: "__proto__", model: "another-custom-model" }],
      }),
    );
    NodeAssert.equal(
      (
        decodeSmartRoutingResponse("profile", parsed, {
          model: SMART_ROUTING_MODEL,
          answers: { profile: answer("c1", ["c0", "c1"]) },
        }) as { profileId: string }
      ).profileId,
      "__proto__",
    );
    NodeAssert.equal(
      (
        decodeSmartRoutingResponse("profile", parsed, {
          model: SMART_ROUTING_MODEL,
          answers: { profile: answer("external-model", ["external-model"]) },
        }) as { profileId: string }
      ).profileId,
      candidate.id,
    );
  },
);

NodeTest.test(
  "recommendations bind every independent question to its candidate and require confident role and capability",
  () => {
    const parsed = parseSmartRoutingInput("recommendations", {
      requestId: NodeCrypto.randomUUID(),
      candidates: [candidate],
    });
    const request = JSON.parse(smartRoutingRequest("recommendations", parsed));
    NodeAssert.match(request.questions["role:c0"].instructions, /candidate c0/);
    NodeAssert.match(request.questions["capability:c0"].instructions, /candidate c0/);
    NodeAssert.equal("objective" in request.state, false);
    const answers = {
      "role:c0": answer("worker", ["lead_worker", "lead", "worker", "inactive"]),
      "capability:c0": answer("general", ["general", "complex", "frontier"]),
    };
    NodeAssert.deepEqual(
      decodeSmartRoutingResponse("recommendations", parsed, {
        model: SMART_ROUTING_MODEL,
        answers,
      }),
      { profiles: [{ id: candidate.id, worker: true, lead: false, capability: "general" }] },
    );
    NodeAssert.deepEqual(
      decodeSmartRoutingResponse("recommendations", parsed, {
        model: SMART_ROUTING_MODEL,
        answers: { ...answers, "capability:c0": { ...answers["capability:c0"], confidence: 0.5 } },
      }),
      { profiles: [] },
    );
  },
);

NodeTest.test(
  "the entire UTF-8 upstream request including server instructions stays within 24 KB",
  () => {
    const parsed = parseSmartRoutingInput("execution", input());
    NodeAssert.ok(
      Buffer.byteLength(smartRoutingRequest("execution", parsed)) <= SMART_ROUTING_MAX_BYTES,
    );
    NodeAssert.throws(
      () => smartRoutingRequest("execution", { ...parsed, objective: "界".repeat(8_000) }),
      (error) => error instanceof SmartRoutingError && error.status === 413,
    );
  },
);

NodeTest.test(
  "provider transport fixes the endpoint/model, bounds output and sends the operator key only upstream",
  async () => {
    let calls = 0;
    const fetcher: typeof fetch = async (url, init) => {
      calls++;
      NodeAssert.equal(url, "https://api.typesafe.ai/v1/systemone");
      NodeAssert.equal(init?.redirect, "error");
      NodeAssert.ok(init?.signal instanceof AbortSignal);
      NodeAssert.equal(new Headers(init?.headers).get("authorization"), "Bearer test-operator-key");
      return Response.json({ answers: {} });
    };
    NodeAssert.deepEqual(await callSmartRoutingProvider("test-operator-key", "{}", fetcher), {
      answers: {},
    });
    NodeAssert.equal(calls, 1);
    await NodeAssert.rejects(
      callSmartRoutingProvider(
        "test-operator-key",
        "{}",
        async () => new Response("x".repeat(SMART_ROUTING_MAX_BYTES + 1)),
      ),
      SmartRoutingError,
    );
    await NodeAssert.rejects(
      callSmartRoutingProvider(
        "test-operator-key",
        "{}",
        async () => new Response("no", { status: 503 }),
      ),
      SmartRoutingError,
    );
  },
);

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
const executionAnswers = (mode: "direct" | "orchestrated", confidence = 0.95) => ({
  mode: answer(mode, ["direct", "orchestrated"], confidence),
  difficulty: answer("routine", ["routine", "substantial", "frontier"]),
  workload: answer("short", ["short", "medium", "long"]),
  decomposition: answer("one_stream", ["one_stream", "independent_streams"]),
  risk: answer("bounded", ["bounded", "review_worthwhile"]),
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
    NodeAssert.deepEqual(Object.keys(body.questions), [
      "mode",
      "difficulty",
      "workload",
      "decomposition",
      "risk",
    ]);
    NodeAssert.deepEqual(
      decodeSmartRoutingResponse("execution", parsed, {
        model: SMART_ROUTING_MODEL,
        answers: executionAnswers("direct"),
      }),
      {
        mode: "direct",
        difficulty: "routine",
        workload: "short",
        source: "jev",
        confidence: 0.95,
        reason:
          "Smart Routing assessed routine, short, one_stream, bounded; selected an ordinary single-model conversation.",
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
  "malformed probabilities, unknown modes, wrong models and absent candidates fail closed",
  () => {
    const parsed = parseSmartRoutingInput("execution", input());
    for (const mode of [
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
            answers: { ...executionAnswers("direct"), mode },
          }) as { mode: string }
        ).mode,
        "orchestrated",
      );
    }
    const direct = {
      model: SMART_ROUTING_MODEL,
      answers: executionAnswers("direct"),
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
  "narrow task assessments make low-confidence but valid routing decisions usable",
  () => {
    const parsed = parseSmartRoutingInput("execution", input());
    const managed = decodeSmartRoutingResponse("execution", parsed, {
      model: SMART_ROUTING_MODEL,
      answers: {
        ...executionAnswers("orchestrated"),
        workload: answer("long", ["short", "medium", "long"]),
        mode: {
          type: "choice",
          choice: "orchestrated",
          confidence: 0.26,
          probabilities: { direct: 0.37, orchestrated: 0.63 },
        },
      },
    });
    NodeAssert.deepEqual(managed, {
      mode: "orchestrated",
      difficulty: "routine",
      workload: "long",
      source: "jev",
      confidence: 0.26,
      reason: "Smart Routing assessed routine, long, one_stream, bounded; selected a managed team.",
    });
    const direct = decodeSmartRoutingResponse("execution", parsed, {
      model: SMART_ROUTING_MODEL,
      answers: {
        ...executionAnswers("direct"),
        mode: {
          type: "choice",
          choice: "direct",
          confidence: 0.26,
          probabilities: { direct: 0.63, orchestrated: 0.37 },
        },
      },
    });
    NodeAssert.equal("source" in direct && direct.source, "jev");
    NodeAssert.equal("mode" in direct && direct.mode, "direct");
    const crossCutting = decodeSmartRoutingResponse("execution", parsed, {
      model: SMART_ROUTING_MODEL,
      answers: {
        ...executionAnswers("direct"),
        workload: answer("long", ["short", "medium", "long"]),
        decomposition: answer("independent_streams", ["one_stream", "independent_streams"]),
      },
    });
    NodeAssert.equal("mode" in crossCutting && crossCutting.mode, "orchestrated");
    const diagnostic = decodeSmartRoutingResponse("execution", parsed, {
      model: SMART_ROUTING_MODEL,
      answers: {
        ...executionAnswers("direct"),
        difficulty: answer("substantial", ["routine", "substantial", "frontier"]),
        workload: answer("medium", ["short", "medium", "long"]),
      },
    });
    NodeAssert.equal("mode" in diagnostic && diagnostic.mode, "orchestrated");
    const needlessTeam = decodeSmartRoutingResponse("execution", parsed, {
      model: SMART_ROUTING_MODEL,
      answers: executionAnswers("orchestrated"),
    });
    NodeAssert.equal("mode" in needlessTeam && needlessTeam.mode, "direct");
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
  "a valid close profile ranking is accepted without a blanket confidence cutoff",
  () => {
    const parsed = parseSmartRoutingInput(
      "profile",
      input({
        purpose: "lead",
        candidates: [candidate, { ...candidate, id: "second", model: "another-model" }],
      }),
    );
    const decision = decodeSmartRoutingResponse("profile", parsed, {
      model: SMART_ROUTING_MODEL,
      answers: {
        profile: {
          type: "choice",
          choice: "c1",
          confidence: 0.06,
          probabilities: { c0: 0.47, c1: 0.53 },
        },
      },
    });
    NodeAssert.equal("profileId" in decision && decision.profileId, "second");
    NodeAssert.equal("source" in decision && decision.source, "jev");
  },
);

NodeTest.test("routine worker selection favors a capable economical model", () => {
  const parsed = parseSmartRoutingInput(
    "profile",
    input({
      purpose: "worker",
      candidates: [
        {
          ...candidate,
          id: "sol",
          model: "gpt-6-sol",
          costClass: "premium",
          capability: "frontier",
        },
        {
          ...candidate,
          id: "luna",
          model: "gpt-6-luna",
          costClass: "economy",
          capability: "complex",
        },
        {
          ...candidate,
          id: "flash",
          model: "deepseek-v4.1-flash",
          costClass: "economy",
          capability: "complex",
        },
      ],
    }),
  );
  const request = JSON.parse(smartRoutingRequest("profile", parsed));
  NodeAssert.deepEqual(Object.keys(request.questions), ["profile", "difficulty"]);
  const profile = {
    type: "choice",
    choice: "c0",
    confidence: 0.7,
    probabilities: { c0: 0.55, c1: 0.35, c2: 0.1 },
  };
  const route = (difficulty: "routine" | "substantial") =>
    decodeSmartRoutingResponse("profile", parsed, {
      model: SMART_ROUTING_MODEL,
      answers: {
        profile,
        difficulty: answer(difficulty, ["routine", "substantial", "frontier"]),
      },
    });
  NodeAssert.deepEqual(route("routine"), {
    profileId: "luna",
    source: "jev",
    confidence: 0.7,
    reason: "Smart Routing selected an economical allowed model for routine work.",
  });
  const substantial = route("substantial");
  NodeAssert.equal("profileId" in substantial && substantial.profileId, "sol");
});

NodeTest.test("effort selection stays within advertised provider values", () => {
  const parsed = parseSmartRoutingInput(
    "effort",
    input({ effortChoices: ["low", "medium", "max"] }),
  );
  const request = JSON.parse(smartRoutingRequest("effort", parsed));
  NodeAssert.deepEqual(Object.keys(request.questions.effort.criteria), ["low", "medium", "max"]);
  NodeAssert.deepEqual(
    decodeSmartRoutingResponse("effort", parsed, {
      model: SMART_ROUTING_MODEL,
      answers: { effort: answer("max", ["low", "medium", "max"], 0.21) },
    }),
    {
      effort: "max",
      source: "jev",
      confidence: 0.21,
      reason: "Smart Routing selected a supported effort for this task.",
    },
  );
  const fallback = decodeSmartRoutingResponse("effort", parsed, {
    model: SMART_ROUTING_MODEL,
    answers: { effort: answer("ultra", ["ultra"]) },
  });
  NodeAssert.equal("effort" in fallback && fallback.effort, "medium");
});

NodeTest.test("premium effort follows assessed work difficulty", () => {
  const parsed = parseSmartRoutingInput(
    "effort",
    input({
      candidates: [{ ...candidate, model: "gpt-6-sol", costClass: "premium" }],
      effortChoices: ["low", "medium", "high", "max"],
    }),
  );
  const request = JSON.parse(smartRoutingRequest("effort", parsed));
  NodeAssert.deepEqual(Object.keys(request.questions), ["effort", "difficulty"]);
  for (const [difficulty, expected] of [
    ["routine", "medium"],
    ["substantial", "high"],
    ["frontier", "max"],
  ] as const) {
    const decision = decodeSmartRoutingResponse("effort", parsed, {
      model: SMART_ROUTING_MODEL,
      answers: {
        effort: answer("max", ["low", "medium", "high", "max"]),
        difficulty: answer(difficulty, ["routine", "substantial", "frontier"]),
      },
    });
    NodeAssert.equal("effort" in decision && decision.effort, expected);
  }
});

NodeTest.test("worker count is bounded by concurrency and can be zero", () => {
  const parsed = parseSmartRoutingInput(
    "workers",
    input({
      scope: "Two independent modules can be changed in parallel.",
      maxWorkers: 2,
    }),
  );
  const request = JSON.parse(smartRoutingRequest("workers", parsed));
  NodeAssert.deepEqual(Object.keys(request.questions.workers.criteria), ["w0", "w1", "w2"]);
  const choice = decodeSmartRoutingResponse("workers", parsed, {
    model: SMART_ROUTING_MODEL,
    answers: { workers: answer("w2", ["w0", "w1", "w2"], 0.3) },
  });
  NodeAssert.equal("workers" in choice && choice.workers, 2);
  NodeAssert.throws(
    () => parseSmartRoutingInput("workers", input({ scope: "Area", maxWorkers: 5 })),
    SmartRoutingError,
  );
});

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

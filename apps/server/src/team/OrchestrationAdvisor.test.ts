import { expect, it } from "@effect/vitest";
import { ProviderInstanceId, type TeamModelProfile } from "@dispatch/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";
import type * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";

import {
  DISPATCH_CONNECT_ENVIRONMENT_CONFIG_SECRET,
  DISPATCH_CONNECT_ENVIRONMENT_CREDENTIAL_SECRET,
  DISPATCH_CONNECT_SMART_ROUTING_SESSION_SECRET,
} from "../auth/DispatchConnectEnvironment.ts";
import { ServerSecretStore } from "../auth/ServerSecretStore.ts";
import { make } from "./OrchestrationAdvisor.ts";

const instanceId = ProviderInstanceId.make("codex");
const connectBaseUrl = "https://connect.opendispatch.dev";
const encoder = new TextEncoder();
const decoder = new TextDecoder();

const sessionSecret = (accountToken: string, origin = connectBaseUrl) =>
  encoder.encode(JSON.stringify({ version: 1, origin, accountToken }));

const profile = (id: string, overrides: Partial<TeamModelProfile> = {}): TeamModelProfile => ({
  id,
  label: id,
  selection: { instanceId, model: `model-${id}` },
  lead: true,
  worker: true,
  capability: "general",
  ...overrides,
});

function requestJson(request: HttpClientRequest.HttpClientRequest): Record<string, unknown> {
  if (request.body._tag !== "Uint8Array") throw new Error("Expected JSON request body");
  return JSON.parse(decoder.decode(request.body.body)) as Record<string, unknown>;
}

function fixture(input: {
  accountToken?: string | null;
  respond?: (request: HttpClientRequest.HttpClientRequest) => { status?: number; body: unknown };
}) {
  const secrets = new Map<string, Uint8Array>([
    [
      DISPATCH_CONNECT_ENVIRONMENT_CONFIG_SECRET,
      encoder.encode(
        JSON.stringify({
          version: 1,
          baseUrl: connectBaseUrl,
          environmentId: "environment-test",
        }),
      ),
    ],
    [DISPATCH_CONNECT_ENVIRONMENT_CREDENTIAL_SECRET, encoder.encode("dce_environment")],
    ["team-jev-api-key", encoder.encode("obsolete-user-jev-key")],
  ]);
  if (input.accountToken !== undefined && input.accountToken !== null)
    secrets.set(DISPATCH_CONNECT_SMART_ROUTING_SESSION_SECRET, sessionSecret(input.accountToken));

  const requests: HttpClientRequest.HttpClientRequest[] = [];
  const http = HttpClient.make((request) =>
    Effect.sync(() => {
      requests.push(request);
      const response = input.respond?.(request) ?? {
        body: { available: true, reason: null },
      };
      return HttpClientResponse.fromWeb(
        request,
        Response.json(response.body, { status: response.status ?? 200 }),
      );
    }),
  );

  return {
    requests,
    secrets,
    layer: Layer.mergeAll(
      Layer.mock(ServerSecretStore)({
        get: (name) => {
          const value = secrets.get(name);
          return Effect.succeed(value === undefined ? Option.none() : Option.some(value));
        },
        set: (name, value) =>
          Effect.sync(() => {
            secrets.set(name, Uint8Array.from(value));
          }),
        remove: (name) =>
          Effect.sync(() => {
            secrets.delete(name);
          }),
      }),
      Layer.succeed(HttpClient.HttpClient, http),
    ),
  };
}

it.effect("requires the local account session before contacting hosted Smart Routing", () => {
  const f = fixture({});
  return Effect.gen(function* () {
    const advisor = yield* make;
    expect(yield* advisor.status).toEqual({
      available: false,
      reason: "smart_routing_session_required",
    });
    expect(f.requests).toHaveLength(0);
  }).pipe(Effect.provide(f.layer));
});

it.effect("stores the account session write-only and sends both hosted credentials", () => {
  const f = fixture({});
  return Effect.gen(function* () {
    const advisor = yield* make;
    yield* advisor.setSmartRoutingSession({
      accountToken: " account-session ",
      baseUrl: `${connectBaseUrl}/`,
    });
    expect(yield* advisor.status).toEqual({ available: true, reason: null });

    expect(decoder.decode(f.secrets.get(DISPATCH_CONNECT_SMART_ROUTING_SESSION_SECRET))).toContain(
      '"origin":"https://connect.opendispatch.dev"',
    );
    expect(decoder.decode(f.secrets.get(DISPATCH_CONNECT_SMART_ROUTING_SESSION_SECRET))).toContain(
      '"accountToken":"account-session"',
    );
    expect(f.secrets.has("team-jev-api-key")).toBe(false);
    expect(f.requests).toHaveLength(1);
    expect(f.requests[0]?.headers.authorization).toBe("Bearer dce_environment");
    expect(f.requests[0]?.headers["x-dispatch-connect-session"]).toBe("account-session");
    expect(f.requests[0]?.url).toContain(
      "/v1/environments/environment-test/smart-routing/capability",
    );
  }).pipe(Effect.provide(f.layer));
});

it.effect(
  "clears the account session on logout without touching the environment credential",
  () => {
    const f = fixture({ accountToken: "account-session" });
    return Effect.gen(function* () {
      const advisor = yield* make;
      yield* advisor.setSmartRoutingSession({ accountToken: null, baseUrl: null });

      expect(f.secrets.has(DISPATCH_CONNECT_SMART_ROUTING_SESSION_SECRET)).toBe(false);
      expect(decoder.decode(f.secrets.get(DISPATCH_CONNECT_ENVIRONMENT_CREDENTIAL_SECRET))).toBe(
        "dce_environment",
      );
      expect(yield* advisor.status).toEqual({
        available: false,
        reason: "smart_routing_session_required",
      });
      expect(f.requests).toHaveLength(0);
    }).pipe(Effect.provide(f.layer));
  },
);

it.effect("never stores or forwards an account session for a different Connect origin", () => {
  const f = fixture({});
  return Effect.gen(function* () {
    const advisor = yield* make;
    const error = yield* advisor
      .setSmartRoutingSession({
        accountToken: "account-session",
        baseUrl: "https://other-connect.example",
      })
      .pipe(Effect.flip);

    expect(error.code).toBe("invalid");
    expect(error.message).toContain("different Connect origin");
    expect(f.secrets.has(DISPATCH_CONNECT_SMART_ROUTING_SESSION_SECRET)).toBe(false);
    expect(f.requests).toHaveLength(0);
  }).pipe(Effect.provide(f.layer));
});

it.effect("clears a persisted session binding when the linked Connect origin changes", () => {
  const f = fixture({ accountToken: "account-session" });
  f.secrets.set(
    DISPATCH_CONNECT_ENVIRONMENT_CONFIG_SECRET,
    encoder.encode(
      JSON.stringify({
        version: 1,
        baseUrl: "https://different-connect.example",
        environmentId: "environment-test",
      }),
    ),
  );
  return Effect.gen(function* () {
    const advisor = yield* make;
    expect(yield* advisor.status).toEqual({
      available: false,
      reason: "smart_routing_environment_required",
    });
    expect(f.secrets.has(DISPATCH_CONNECT_SMART_ROUTING_SESSION_SECRET)).toBe(false);
    expect(f.requests).toHaveLength(0);
  }).pipe(Effect.provide(f.layer));
});

it.effect("lets only a confident hosted execution decision select direct mode", () => {
  const f = fixture({
    accountToken: "account-session",
    respond: (request) => ({
      body: request.url.endsWith("/execution")
        ? {
            mode: "direct",
            difficulty: "routine",
            workload: "short",
            source: "jev",
            confidence: 0.91,
            reason: "One worker can handle the bounded objective.",
          }
        : { available: true, reason: null },
    }),
  });
  return Effect.gen(function* () {
    const advisor = yield* make;
    const decision = yield* advisor.routeExecution({
      objective: "Migrate authentication across server and web and preserve production data.",
      workers: [profile("worker")],
    });
    expect(decision).toMatchObject({
      mode: "direct",
      difficulty: "routine",
      workload: "short",
      source: "jev",
      confidence: 0.91,
    });
    expect(f.requests).toHaveLength(1);
    const request = f.requests[0]!;
    const body = requestJson(request);
    expect(body.requestId).toEqual(expect.any(String));
    expect(body.objective).toContain("Migrate authentication");
    if (request.body._tag !== "Uint8Array") throw new Error("Expected JSON request body");
    expect(request.body.body.byteLength).toBeLessThan(24_000);
  }).pipe(Effect.provide(f.layer));
});

it.effect("accepts an uncertain managed route without approving direct execution", () => {
  const f = fixture({
    accountToken: "account-session",
    respond: () => ({
      body: {
        mode: "orchestrated",
        difficulty: "substantial",
        workload: "medium",
        source: "jev",
        confidence: 0.26,
        reason: "Smart Routing could not confirm direct execution; using a managed team.",
      },
    }),
  });
  return Effect.gen(function* () {
    const advisor = yield* make;
    expect(
      yield* advisor.routeExecution({
        objective: "Apply the same dialog controls throughout the app.",
        workers: [profile("worker")],
      }),
    ).toMatchObject({ mode: "orchestrated", source: "jev", confidence: 0.26 });
  }).pipe(Effect.provide(f.layer));
});

it.effect(
  "accepts valid low-confidence execution and falls back when the request is oversized",
  () => {
    const lowConfidence = fixture({
      accountToken: "account-session",
      respond: () => ({
        body: {
          mode: "direct",
          difficulty: "routine",
          workload: "short",
          source: "jev",
          confidence: 0.79,
          reason: "Uncertain.",
        },
      }),
    });
    const oversized = fixture({ accountToken: "account-session" });
    return Effect.gen(function* () {
      const low = yield* Effect.provide(
        Effect.gen(function* () {
          const advisor = yield* make;
          return yield* advisor.routeExecution({
            objective: "Handle this task.",
            workers: [profile("worker")],
          });
        }),
        lowConfidence.layer,
      );
      expect(low).toMatchObject({ mode: "direct", source: "jev" });

      const tooLarge = yield* Effect.provide(
        Effect.gen(function* () {
          const advisor = yield* make;
          return yield* advisor.routeExecution({
            objective: "Handle this task.",
            workers: [
              profile("huge", {
                selection: { instanceId, model: "x".repeat(24_000) },
              }),
            ],
          });
        }),
        oversized.layer,
      );
      expect(tooLarge).toMatchObject({ mode: "orchestrated", source: "policy" });
      expect(oversized.requests).toHaveLength(0);
    });
  },
);

it.effect("accepts a legacy hosted decision without a task assessment", () => {
  const f = fixture({
    accountToken: "account-session",
    respond: () => ({
      body: { mode: "direct", source: "jev", confidence: 1, reason: "Incomplete." },
    }),
  });
  return Effect.gen(function* () {
    const advisor = yield* make;
    expect(
      yield* advisor.routeExecution({ objective: "Fix a dialog", workers: [profile("worker")] }),
    ).toMatchObject({ mode: "direct", difficulty: null, workload: null, source: "jev" });
  }).pipe(Effect.provide(f.layer));
});

it.effect("uses the highest advertised effort for economy models without a hosted call", () => {
  const f = fixture({ accountToken: "account-session" });
  return Effect.gen(function* () {
    const advisor = yield* make;
    const effort = yield* advisor.chooseEffort({
      objective: "Implement a focused change",
      profile: profile("luna", { selection: { instanceId, model: "gpt-6-luna" } }),
      choices: { optionId: "reasoningEffort", values: ["low", "high", "max"] },
    });
    expect(effort).toEqual({ optionId: "reasoningEffort", value: "max" });
    expect(f.requests).toHaveLength(0);
  }).pipe(Effect.provide(f.layer));
});

it.effect("asks JEV for an adaptable premium model's supported effort", () => {
  const f = fixture({
    accountToken: "account-session",
    respond: () => ({
      body: { effort: "high", source: "jev", confidence: 0.35, reason: "Task needs high effort" },
    }),
  });
  return Effect.gen(function* () {
    const advisor = yield* make;
    const effort = yield* advisor.chooseEffort({
      objective: "Design a difficult integration",
      profile: profile("sol", { selection: { instanceId, model: "gpt-6-sol" } }),
      choices: { optionId: "reasoningEffort", values: ["medium", "high", "max"] },
    });
    expect(effort).toEqual({ optionId: "reasoningEffort", value: "high" });
    expect(f.requests[0]?.url).toContain("/smart-routing/effort");
    expect(requestJson(f.requests[0]!).effortChoices).toEqual(["medium", "high", "max"]);
  }).pipe(Effect.provide(f.layer));
});

it.effect("keeps Standard worker capacity when hosted count selection falls back", () => {
  const f = fixture({
    accountToken: "account-session",
    respond: () => ({
      body: {
        workers: 0,
        source: "policy",
        confidence: 1,
        reason: "No valid worker count was selected.",
      },
    }),
  });
  return Effect.gen(function* () {
    const advisor = yield* make;
    const result = yield* advisor.chooseWorkerCount({
      objective: "Implement the API and client",
      scope: "Two independent areas",
      lead: profile("lead"),
      maxWorkers: 2,
    });
    expect(result).toMatchObject({ workers: 2, source: "policy" });
    expect(f.requests[0]?.url).toContain("/smart-routing/workers");
  }).pipe(Effect.provide(f.layer));
});

it.effect("clears the account session after hosted authentication failure", () => {
  const f = fixture({
    accountToken: "expired-session",
    respond: () => ({ status: 401, body: { error: "smart_routing_session_invalid" } }),
  });
  return Effect.gen(function* () {
    const advisor = yield* make;
    expect(yield* advisor.status).toEqual({
      available: false,
      reason: "smart_routing_session_invalid",
    });
    expect(f.secrets.has(DISPATCH_CONNECT_SMART_ROUTING_SESSION_SECRET)).toBe(false);

    expect(yield* advisor.status).toEqual({
      available: false,
      reason: "smart_routing_session_required",
    });
    expect(f.requests).toHaveLength(1);
  }).pipe(Effect.provide(f.layer));
});

it.effect("uses saved order when hosted profile selection is invalid or unconfident", () => {
  const f = fixture({
    accountToken: "account-session",
    respond: () => ({
      body: {
        profileId: "not-a-candidate",
        source: "jev",
        confidence: 0.99,
        reason: "Invalid candidate.",
      },
    }),
  });
  return Effect.gen(function* () {
    const advisor = yield* make;
    const first = profile("first");
    const second = profile("second");
    expect(
      yield* advisor.chooseProfile({
        purpose: "lead",
        objective: "Plan the task.",
        candidates: [first, second],
      }),
    ).toMatchObject({ profileId: "first", source: "policy" });
  }).pipe(Effect.provide(f.layer));
});

it.effect("selects the only eligible profile locally without contacting hosted routing", () => {
  const f = fixture({ accountToken: "account-session" });
  return Effect.gen(function* () {
    const advisor = yield* make;
    const only = profile("only");
    expect(
      yield* advisor.chooseProfile({
        purpose: "worker",
        objective: "Implement the bounded task.",
        candidates: [only],
      }),
    ).toMatchObject({ profileId: only.id, source: "policy", confidence: 1 });
    expect(f.requests).toHaveLength(0);
  }).pipe(Effect.provide(f.layer));
});

it.effect("enriches only explicit recommendation calls and preserves saved roles", () => {
  const f = fixture({
    accountToken: "account-session",
    respond: (request) => {
      const body = requestJson(request);
      const candidates = body.candidates as Array<{ id: string }>;
      return {
        body: {
          profiles: candidates.map(({ id }) => ({
            id,
            lead: false,
            worker: true,
            capability: "general",
          })),
        },
      };
    },
  });
  return Effect.gen(function* () {
    const advisor = yield* make;
    const saved = profile("saved", { lead: true, worker: false, capability: "frontier" });
    const pending = profile("pending", { lead: false, worker: false, capability: undefined });
    const result = yield* advisor.recommendProfiles([saved, pending]);
    expect(result[0]).toEqual(saved);
    expect(result[1]).toMatchObject({ lead: false, worker: true, capability: "general" });
    expect(f.requests).toHaveLength(1);
    expect(f.requests[0]?.url).toContain("/smart-routing/recommendations");
  }).pipe(Effect.provide(f.layer));
});

import { expect, it } from "@effect/vitest";
import {
  ProviderInstanceId,
  ProviderDriverKind,
  type ServerProvider,
  type TeamPolicy,
  TeamError,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";
import { ServerSecretStore } from "../auth/ServerSecretStore.ts";
import { ProviderRegistry } from "../provider/Services/ProviderRegistry.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import * as TeamStore from "./TeamStore.ts";
import { make } from "./TeamRouter.ts";
import { defaultTeamPolicy } from "./routing.ts";
const isTeamError = Schema.is(TeamError);
const provider: ServerProvider = {
  instanceId: ProviderInstanceId.make("codex"),
  driver: ProviderDriverKind.make("codex"),
  enabled: true,
  installed: true,
  version: null,
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-09-19T00:00:00.000Z",
  models: [{ slug: "large", name: "Large", isCustom: false, capabilities: null }],
  slashCommands: [],
  skills: [],
};
const policy: TeamPolicy = {
  ...defaultTeamPolicy,
  mode: "shadow",
  profiles: [
    {
      id: "lead",
      label: "Lead",
      selection: { instanceId: provider.instanceId, model: "large" },
      tier: "capable",
      lead: true,
      worker: true,
      estimatedAttemptUsd: null,
    },
  ],
};
const draft = {
  draftId: "d",
  revision: 1,
  policyRevision: 1,
  prompt: "edit a label",
  hasAttachments: false,
};
const fixture = (response?: unknown) => {
  let key: Uint8Array | undefined;
  let calls = 0;
  let currentProviders: ReadonlyArray<ServerProvider> = [provider];
  const http = HttpClient.make((request) =>
    Effect.sync(() => {
      calls++;
      return HttpClientResponse.fromWeb(
        request,
        Response.json(response ?? { secretEcho: "must-not-escape" }, {
          status: response ? 200 : 401,
        }),
      );
    }),
  );
  return {
    calls: () => calls,
    setProviders: (value: ReadonlyArray<ServerProvider>) => {
      currentProviders = value;
    },
    layer: Layer.mergeAll(
      TeamStore.layer.pipe(Layer.provide(SqlitePersistenceMemory)),
      Layer.mock(ServerSecretStore)({
        get: () => Effect.sync(() => Option.fromUndefinedOr(key)),
        set: (_name, value) =>
          Effect.sync(() => {
            key = value;
          }),
        remove: () =>
          Effect.sync(() => {
            key = undefined;
          }),
      }),
      Layer.mock(ProviderRegistry)({
        getProviders: Effect.sync(() => currentProviders),
        refreshInstance: () => Effect.sync(() => currentProviders),
      }),
      Layer.succeed(HttpClient.HttpClient, http),
    ),
  };
};
it.effect("requires BYOK and disables routing when the key is removed", () => {
  const f = fixture();
  return Effect.gen(function* () {
    const router = yield* make;
    const missing = yield* router.saveSettings(policy).pipe(Effect.flip);
    expect(missing.code).toBe("invalid");
    yield* router.setSecret("fixture-key");
    const saved = yield* router.saveSettings(policy);
    expect(saved.jevConfigured).toBe(true);
    expect("apiKey" in saved).toBe(false);
    const removed = yield* router.setSecret("");
    expect(removed.policy.mode).toBe("off");
    expect(removed.jevConfigured).toBe(false);
    expect(f.calls()).toBe(0);
  }).pipe(Effect.provide(f.layer));
});
const answer = (choice: string, keys: string[]) => ({
  type: "choice",
  choice,
  confidence: 0.99,
  probabilities: Object.fromEntries(keys.map((k) => [k, k === choice ? 1 : 0])),
});
const successful = {
  model: "jev-1.13.0",
  usage: { input_tokens: 123, output_tokens: 0 },
  answers: {
    complexity: answer("economy", ["economy", "balanced", "capable"]),
    risk: answer("ordinary", ["ordinary", "critical"]),
    reasoning: answer("routine", ["routine", "deliberate"]),
    context: answer("sufficient", ["sufficient", "missing"]),
    verification: answer("deterministic", ["deterministic", "review"]),
    delegation: answer("single", ["single", "separable"]),
  },
};
it.effect("reuses one evaluation across draft identities and refreshes after key rotation", () => {
  const f = fixture(successful);
  return Effect.gen(function* () {
    const router = yield* make;
    yield* router.setSecret("fixture-key");
    yield* router.saveSettings(policy);
    const first = yield* router.assess(draft);
    expect(first.planning?.verification).toBe("deterministic");
    const second = yield* router.assess({ ...draft, draftId: "second", revision: 2 });
    expect(second.draftId).toBe("second");
    expect(f.calls()).toBe(1);
    yield* router.setSecret("replacement-fixture-key");
    yield* router.assess(draft);
    expect(f.calls()).toBe(2);
  }).pipe(Effect.provide(f.layer));
});
it.effect("skips oversized state and in-flight recovery without imposing an attempt cap", () => {
  const f = fixture(successful);
  return Effect.gen(function* () {
    const router = yield* make;
    yield* router.setSecret("fixture-key");
    yield* router.saveSettings(policy);
    const large = yield* router.assess({ ...draft, prompt: "界".repeat(9000) });
    expect(large.source).toBe("fallback");
    yield* router.assess({ ...draft, hasAttachments: true });
    const recovery = {
      policyRevision: 1,
      currentProfileId: "lead",
      objective: "Fix",
      evidence: "Failure",
      correction: "",
      attemptsMade: 2,
      inFlight: false,
    };
    expect((yield* router.recover(recovery)).action).toBe("lead_review");
    expect((yield* router.recover({ ...recovery, attemptsMade: 1, inFlight: true })).action).toBe(
      "wait",
    );
    expect(f.calls()).toBe(1);
  }).pipe(Effect.provide(f.layer));
});
it.effect("rejects a different Jev version rather than trusting its calibration", () => {
  const f = fixture({ ...successful, model: "jev-unpinned" });
  return Effect.gen(function* () {
    const router = yield* make;
    yield* router.setSecret("fixture-key");
    yield* router.saveSettings(policy);
    expect((yield* router.assess(draft)).source).toBe("fallback");
  }).pipe(Effect.provide(f.layer));
});
it.effect("returns recovery advice without dispatching an agent", () => {
  const f = fixture({
    model: "jev-1.13.0",
    usage: { input_tokens: 140, output_tokens: 0 },
    answers: {
      cause: answer("environment", ["environment", "context", "local", "reasoning", "unknown"]),
      correction: answer("absent", ["actionable", "absent"]),
    },
  });
  return Effect.gen(function* () {
    const router = yield* make;
    yield* router.setSecret("fixture-key");
    yield* router.saveSettings(policy);
    expect(
      (yield* router.recover({
        policyRevision: 1,
        currentProfileId: "lead",
        objective: "Fix",
        evidence: "Tool permission denied",
        correction: "",
        attemptsMade: 1,
        inFlight: false,
      })).action,
    ).toBe("repair_environment");
    expect(f.calls()).toBe(1);
  }).pipe(Effect.provide(f.layer));
});
it.effect("sanitizes upstream failures and does not treat missing usage as zero", () => {
  const f = fixture();
  return Effect.gen(function* () {
    const router = yield* make;
    yield* router.setSecret("fixture-key");
    yield* router.saveSettings(policy);
    const assessment = yield* router.assess(draft);
    expect(assessment.tier).toBe("capable");
    expect(assessment.source).toBe("fallback");
    expect(assessment.inputTokens).toBeNull();
    expect(assessment.reason).not.toContain("must-not-escape");
    expect(f.calls()).toBe(1);
  }).pipe(Effect.provide(f.layer));
});
it.effect("does no inference for disabled routing and rejects stale settings", () => {
  const f = fixture();
  return Effect.gen(function* () {
    const router = yield* make;
    expect(yield* router.resolve({ prompt: "hello", hasAttachments: false })).toBeNull();
    const error = yield* router.assess(draft).pipe(Effect.flip);
    expect(isTeamError(error)).toBe(true);
    expect(error.code).toBe("conflict");
    expect(f.calls()).toBe(0);
  }).pipe(Effect.provide(f.layer));
});

it.effect(
  "invalidates a cached lead recommendation when its provider quota becomes exhausted",
  () => {
    const f = fixture(successful);
    return Effect.gen(function* () {
      const router = yield* make;
      yield* router.setSecret("fixture-key");
      const saved = yield* router.saveSettings(policy);
      const input = { ...draft, policyRevision: saved.policy.revision };
      expect((yield* router.assess(input)).profileId).toBe("lead");
      f.setProviders([
        {
          ...provider,
          usageLimits: {
            checkedAt: "2026-09-19T00:00:00.000Z",
            windows: [{ id: "weekly", kind: "weekly", label: "Weekly", usedPercent: 100 }],
          },
        },
      ]);
      expect((yield* router.assess(input)).profileId).toBeNull();
    }).pipe(Effect.provide(f.layer));
  },
);

it.effect(
  "creates a catalog fallback pool without changing saved settings or inventing models",
  () => {
    const f = fixture();
    f.setProviders([
      {
        ...provider,
        models: ["gpt-5.6-luna", "gpt-6-astra"].map((slug) => ({
          slug,
          name: slug,
          isCustom: false,
          capabilities: null,
        })),
      },
    ]);
    return Effect.gen(function* () {
      const router = yield* make;
      const suggestion = yield* router.suggestPool();
      expect(suggestion.profiles.every((p) => p.reviewRequired && !p.lead && !p.worker)).toBe(true);
      expect(suggestion.source).toBe("catalog");
      expect((yield* router.settings).policy.profiles).toEqual([]);
      expect(f.calls()).toBe(0);
    }).pipe(Effect.provide(f.layer));
  },
);

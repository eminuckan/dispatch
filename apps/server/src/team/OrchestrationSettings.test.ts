import { expect, it, vi } from "@effect/vitest";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
  type TeamModelProfile,
  type TeamSettings,
} from "@dispatch/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { ProviderRegistry } from "../provider/Services/ProviderRegistry.ts";
import { ProviderService } from "../provider/Services/ProviderService.ts";
import { OrchestrationAdvisor } from "./OrchestrationAdvisor.ts";
import { make } from "./OrchestrationSettings.ts";
import { OrchestrationStore } from "./OrchestrationStore.ts";

const instanceId = ProviderInstanceId.make("codex");
const savedProfile: TeamModelProfile = {
  id: "saved-lead",
  label: "Saved Lead",
  selection: { instanceId, model: "saved-model" },
  lead: true,
  worker: false,
  capability: "frontier",
};
const stored: TeamSettings = {
  policy: {
    revision: 3,
    enabled: true,
    flowMode: "standard",
    profiles: [savedProfile],
    maxActive: 3,
    maxAttempts: 2,
    providerLimitBehavior: "ask",
  },
  smartRouting: { available: false, reason: "smart_routing_session_required" },
};
const provider: ServerProvider = {
  instanceId,
  driver: ProviderDriverKind.make("codex"),
  enabled: true,
  installed: true,
  version: null,
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-09-21T00:00:00.000Z",
  models: ["saved-model", "new-model"].map((slug) => ({
    slug,
    name: slug,
    isCustom: false,
    capabilities: null,
  })),
  slashCommands: [],
  skills: [],
};

function settingsFixture(input: {
  configured: boolean;
  flowMode?: TeamSettings["policy"]["flowMode"];
  storedSmartRouting?: TeamSettings["smartRouting"];
  recommend: (profiles: ReadonlyArray<TeamModelProfile>) => ReadonlyArray<TeamModelProfile>;
  managedTeamNativeDelegation?: "blocked" | "uncontrolled";
  managedTeamNativeDelegationByProvider?: Readonly<
    Record<string, "blocked" | "uncontrolled" | "unknown">
  >;
  providers?: ReadonlyArray<ServerProvider>;
}) {
  const recommendProfiles = vi.fn((profiles: ReadonlyArray<TeamModelProfile>) =>
    Effect.succeed(input.recommend(profiles)),
  );
  const status = vi.fn(() =>
    Effect.succeed({
      available: input.configured,
      reason: input.configured ? null : "smart_routing_session_required",
    }),
  );
  const getCapabilities = vi.fn((candidateInstanceId: ServerProvider["instanceId"]) => {
    const delegation =
      input.managedTeamNativeDelegationByProvider?.[candidateInstanceId] ??
      input.managedTeamNativeDelegation ??
      "blocked";
    return Effect.succeed({
      sessionModelSwitch: "in-session" as const,
      ...(delegation === "unknown" ? {} : { managedTeamNativeDelegation: delegation }),
    });
  });
  const storedSettings: TeamSettings = {
    ...stored,
    policy: { ...stored.policy, flowMode: input.flowMode ?? "standard" },
    smartRouting: input.storedSmartRouting ?? stored.smartRouting,
  };
  return {
    getCapabilities,
    recommendProfiles,
    status,
    layer: Layer.mergeAll(
      Layer.mock(OrchestrationStore)({
        getSettings: Effect.succeed(storedSettings),
        saveSettings: (settings) => Effect.succeed(settings),
      }),
      Layer.mock(OrchestrationAdvisor)({
        configured: Effect.succeed(input.configured),
        localPrerequisites: Effect.succeed({ ready: true, reason: null }),
        status: Effect.suspend(status),
        setSmartRoutingSession: () => Effect.succeed(undefined),
        recommendProfiles,
      }),
      Layer.mock(ProviderRegistry)({ getProviders: Effect.succeed(input.providers ?? [provider]) }),
      Layer.mock(ProviderService)({ getCapabilities }),
    ),
  };
}

it.effect("keeps ordinary settings reads local in Standard Flow", () => {
  const f = settingsFixture({ configured: true, recommend: (profiles) => profiles });
  return Effect.gen(function* () {
    const service = yield* make;
    const result = yield* service.settings;
    expect(result.policy.flowMode).toBe("standard");
    expect(result.supportedProviderInstanceIds).toEqual([instanceId]);
    const recommendations = yield* service.recommendModels();
    expect(recommendations.source).toBe("catalog");
    expect(f.status).not.toHaveBeenCalled();
    expect(f.recommendProfiles).not.toHaveBeenCalled();
  }).pipe(Effect.provide(f.layer));
});

it.effect("does not trust persisted Smart Routing availability after restart", () => {
  const standard = settingsFixture({
    configured: true,
    storedSmartRouting: { available: true, reason: null },
    recommend: (profiles) => profiles,
  });
  const auto = settingsFixture({
    configured: false,
    flowMode: "auto",
    storedSmartRouting: { available: true, reason: null },
    recommend: (profiles) => profiles,
  });
  return Effect.gen(function* () {
    const standardService = yield* Effect.provide(make, standard.layer);
    const standardSettings = yield* standardService.settings;
    expect(standardSettings.smartRouting.available).toBe(false);
    expect(standard.status).not.toHaveBeenCalled();

    const autoService = yield* Effect.provide(make, auto.layer);
    const autoSettings = yield* autoService.settings;
    expect(autoSettings.smartRouting).toEqual({
      available: false,
      reason: "smart_routing_session_required",
    });
    expect(auto.status).toHaveBeenCalledOnce();
  });
});

it.effect("allows Worker-only Auto but still requires a Lead for Standard", () => {
  const f = settingsFixture({ configured: true, recommend: (profiles) => profiles });
  const workerOnly: TeamModelProfile = { ...savedProfile, lead: false, worker: true };
  return Effect.gen(function* () {
    const service = yield* make;
    const auto = yield* service.saveSettings({
      ...stored.policy,
      flowMode: "auto",
      profiles: [workerOnly],
    });
    expect(auto.policy.flowMode).toBe("auto");
    expect(auto.policy.profiles[0]).toMatchObject({ lead: false, worker: true });

    const error = yield* service
      .saveSettings({
        ...stored.policy,
        flowMode: "standard",
        profiles: [workerOnly],
      })
      .pipe(Effect.flip);
    expect(error.code).toBe("invalid");
    expect(error.message).toContain("Lead model");
  }).pipe(Effect.provide(f.layer));
});

function providerFixture(name: string, overrides: Partial<ServerProvider> = {}): ServerProvider {
  const candidateInstanceId = ProviderInstanceId.make(name);
  return {
    ...provider,
    instanceId: candidateInstanceId,
    models: [
      {
        slug: `${name}-model`,
        name: `${name}-model`,
        isCustom: false,
        capabilities: null,
      },
    ],
    ...overrides,
  };
}

it.effect("returns new catalog models unassigned when Smart Routing is unavailable", () => {
  const f = settingsFixture({
    configured: false,
    flowMode: "auto",
    recommend: (profiles) => profiles,
  });
  return Effect.gen(function* () {
    const service = yield* make;
    const result = yield* service.recommendModels();
    expect(f.recommendProfiles).not.toHaveBeenCalled();
    expect(result.source).toBe("catalog");
    expect(result.profiles[0]).toEqual(savedProfile);
    expect(result.profiles[1]).toMatchObject({
      selection: { instanceId, model: "new-model" },
      lead: false,
      worker: false,
    });
    expect(result.profiles[1]).not.toHaveProperty("capability");
  }).pipe(Effect.provide(f.layer));
});

it.effect(
  "preserves saved roles while accepting Smart Routing roles only for new catalog models",
  () => {
    const f = settingsFixture({
      configured: true,
      flowMode: "auto",
      recommend: (profiles) =>
        profiles.map((candidate) =>
          candidate.selection.model === "saved-model"
            ? { ...candidate, lead: false, worker: true, capability: "general" as const }
            : { ...candidate, lead: true, worker: true, capability: "complex" as const },
        ),
    });
    return Effect.gen(function* () {
      const service = yield* make;
      const result = yield* service.recommendModels();
      expect(f.recommendProfiles).toHaveBeenCalledOnce();
      expect(result.source).toBe("jev");
      expect(result.profiles[0]).toEqual(savedProfile);
      expect(result.profiles[1]).toMatchObject({ lead: true, worker: true, capability: "complex" });
    }).pipe(Effect.provide(f.layer));
  },
);

it.effect("reports catalog source when Smart Routing has no confident changes", () => {
  const f = settingsFixture({
    configured: true,
    flowMode: "auto",
    recommend: (profiles) => profiles,
  });
  return Effect.gen(function* () {
    const service = yield* make;
    const result = yield* service.recommendModels();
    expect(result.source).toBe("catalog");
    expect(result.notes.join(" ")).toContain("did not return a confident recommendation");
  }).pipe(Effect.provide(f.layer));
});

it.effect("recommends only providers eligible for managed orchestration", () => {
  const uncontrolled = providerFixture("uncontrolled");
  const notReady = providerFixture("not-ready", { status: "warning" });
  const unauthenticated = providerFixture("unauthenticated", {
    auth: { status: "unauthenticated" },
  });
  const unavailable = providerFixture("unavailable", {
    availability: "unavailable",
    unavailableReason: "Provider is unavailable.",
  });
  const eligible = providerFixture("eligible", { availability: "available" });
  const f = settingsFixture({
    configured: false,
    recommend: (profiles) => profiles,
    providers: [uncontrolled, notReady, unauthenticated, unavailable, eligible],
    managedTeamNativeDelegationByProvider: {
      [uncontrolled.instanceId]: "uncontrolled",
      [eligible.instanceId]: "blocked",
    },
  });

  return Effect.gen(function* () {
    const service = yield* make;
    const result = yield* service.recommendModels();

    expect(result.profiles.map((profile) => profile.selection)).toEqual([
      { instanceId: eligible.instanceId, model: "eligible-model" },
    ]);
    expect(f.getCapabilities).toHaveBeenCalledTimes(5);
    expect(
      f.getCapabilities.mock.calls.map(([candidateInstanceId]) => candidateInstanceId),
    ).toEqual([
      uncontrolled.instanceId,
      notReady.instanceId,
      unauthenticated.instanceId,
      unavailable.instanceId,
      eligible.instanceId,
    ]);
  }).pipe(Effect.provide(f.layer));
});

it.effect(
  "returns fresh native-delegation eligibility on settings, save, and session responses",
  () => {
    const savedUnavailable: ServerProvider = {
      ...provider,
      status: "warning",
      availability: "unavailable",
      unavailableReason: "Temporarily unavailable.",
    };
    const uncontrolled = providerFixture("uncontrolled");
    const unknown = providerFixture("unknown");
    const f = settingsFixture({
      configured: false,
      recommend: (profiles) => profiles,
      providers: [savedUnavailable, uncontrolled, unknown],
      managedTeamNativeDelegationByProvider: {
        [savedUnavailable.instanceId]: "blocked",
        [uncontrolled.instanceId]: "uncontrolled",
        [unknown.instanceId]: "unknown",
      },
    });

    return Effect.gen(function* () {
      const service = yield* make;
      const initial = yield* service.settings;
      expect(initial.policy.profiles).toEqual([savedProfile]);
      expect(initial.supportedProviderInstanceIds).toEqual([savedUnavailable.instanceId]);
      expect(f.status).not.toHaveBeenCalled();

      const saved = yield* service.saveSettings(stored.policy);
      expect(saved.policy.profiles).toEqual([savedProfile]);
      expect(saved.supportedProviderInstanceIds).toEqual([savedUnavailable.instanceId]);

      const session = yield* service.setSmartRoutingSession({ accountToken: null, baseUrl: null });
      expect(session.policy.profiles).toEqual([savedProfile]);
      expect(session.supportedProviderInstanceIds).toEqual([savedUnavailable.instanceId]);
    }).pipe(Effect.provide(f.layer));
  },
);

it.effect("rejects ready providers that cannot deterministically block native delegation", () => {
  const f = settingsFixture({
    configured: false,
    recommend: (profiles) => profiles,
    managedTeamNativeDelegation: "uncontrolled",
  });
  return Effect.gen(function* () {
    const service = yield* make;
    const error = yield* service.saveSettings(stored.policy).pipe(Effect.flip);
    expect(error.code).toBe("invalid");
    expect(error.message).toContain("cannot deterministically disable native subagents");
  }).pipe(Effect.provide(f.layer));
});

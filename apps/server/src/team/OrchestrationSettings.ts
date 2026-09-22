import {
  TeamError,
  type TeamModelProfile,
  type TeamModelRecommendations,
  type TeamPolicy,
  type TeamSettings,
  type TeamSmartRoutingSessionUpdate,
  type TeamSmartRoutingStatus,
} from "@dispatch/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";

import { ProviderRegistry } from "../provider/Services/ProviderRegistry.ts";
import { ProviderService } from "../provider/Services/ProviderService.ts";
import { OrchestrationAdvisor } from "./OrchestrationAdvisor.ts";
import { OrchestrationStore } from "./OrchestrationStore.ts";

const defaultOrchestrationPolicy: TeamPolicy = {
  revision: 0,
  enabled: false,
  flowMode: "standard",
  profiles: [],
  maxActive: 5,
  maxAttempts: 2,
  providerLimitBehavior: "ask",
};

function validatePolicy(policy: TeamPolicy): void {
  const ids = new Set<string>();
  for (const profile of policy.profiles) {
    if (ids.has(profile.id))
      throw new TeamError({ code: "invalid", message: "Flow model IDs must be unique." });
    ids.add(profile.id);
    if (!profile.lead && !profile.worker)
      throw new TeamError({
        code: "invalid",
        message: `${profile.label} must be enabled for Lead, Worker, or both.`,
      });
  }
  const hasLead = policy.profiles.some((profile) => profile.lead);
  const hasWorker = policy.profiles.some((profile) => profile.worker);
  if (policy.enabled && policy.flowMode === "standard" && !hasLead)
    throw new TeamError({
      code: "invalid",
      message: "Choose at least one Lead model before enabling Flow Standard.",
    });
  if (policy.enabled && policy.flowMode === "auto" && !hasLead && !hasWorker)
    throw new TeamError({
      code: "invalid",
      message: "Choose at least one Lead or Worker model before enabling Flow Auto.",
    });
}

export const make = Effect.gen(function* () {
  const store = yield* OrchestrationStore;
  const advisor = yield* OrchestrationAdvisor;
  const providers = yield* ProviderRegistry;
  const providerService = yield* ProviderService;
  const persisted = yield* store.getSettings;
  const persistedSmartRouting = persisted?.smartRouting;
  const smartRoutingRef = yield* Ref.make<TeamSmartRoutingStatus>(
    persistedSmartRouting?.available
      ? { available: false, reason: "smart_routing_unavailable" }
      : (persistedSmartRouting ?? {
          available: false,
          reason: "smart_routing_session_required",
        }),
  );

  const supportedProviderInstanceIds = Effect.fn(
    "OrchestrationSettings.supportedProviderInstanceIds",
  )(function* () {
    const snapshots = yield* providers.getProviders;
    return yield* Effect.filter(
      snapshots.map((provider) => provider.instanceId),
      (instanceId) =>
        providerService.getCapabilities(instanceId).pipe(
          Effect.map((capabilities) => capabilities.managedTeamNativeDelegation === "blocked"),
          Effect.orElseSucceed(() => false),
        ),
    );
  });

  const settings = Effect.gen(function* () {
    const stored = yield* store.getSettings;
    const local = yield* advisor.localPrerequisites;
    const cached = yield* Ref.get(smartRoutingRef);
    const smartRouting = !local.ready
      ? ({ available: false, reason: local.reason } satisfies TeamSmartRoutingStatus)
      : stored?.policy.flowMode === "auto"
        ? yield* advisor.status
        : cached;
    const supported = yield* supportedProviderInstanceIds();
    yield* Ref.set(smartRoutingRef, smartRouting);
    return stored
      ? { ...stored, smartRouting, supportedProviderInstanceIds: supported }
      : ({
          policy: defaultOrchestrationPolicy,
          smartRouting,
          supportedProviderInstanceIds: supported,
        } satisfies TeamSettings);
  });

  const saveSettings = Effect.fn("OrchestrationSettings.saveSettings")(function* (
    policy: TeamPolicy,
  ) {
    yield* Effect.try({
      try: () => validatePolicy(policy),
      catch: (error) =>
        Schema.is(TeamError)(error)
          ? error
          : new TeamError({ code: "invalid", message: "Invalid Flow settings." }),
    });

    // Settings are allowed to retain temporarily unavailable providers/models, but
    // when the selected instance is present its model identity must still be real.
    const snapshots = yield* providers.getProviders;
    for (const profile of policy.profiles) {
      const provider = snapshots.find(
        (candidate) => candidate.instanceId === profile.selection.instanceId,
      );
      if (provider && !provider.models.some((model) => model.slug === profile.selection.model))
        return yield* new TeamError({
          code: "invalid",
          message: `${profile.label} is no longer in that provider's model catalog.`,
        });
      if (provider?.status === "ready") {
        const capabilities = yield* providerService
          .getCapabilities(profile.selection.instanceId)
          .pipe(
            Effect.mapError(
              () =>
                new TeamError({
                  code: "unavailable",
                  message: `Could not verify managed Flow support for ${profile.label}.`,
                }),
            ),
          );
        if (capabilities.managedTeamNativeDelegation !== "blocked")
          return yield* new TeamError({
            code: "invalid",
            message: `${profile.label} cannot be used for Flow yet because its provider cannot deterministically disable native subagents.`,
          });
      }
    }

    const smartRouting =
      policy.flowMode === "auto" ? yield* advisor.status : yield* Ref.get(smartRoutingRef);
    yield* Ref.set(smartRoutingRef, smartRouting);
    const saved = yield* store.saveSettings({ policy, smartRouting });
    return { ...saved, supportedProviderInstanceIds: yield* supportedProviderInstanceIds() };
  });

  const setSmartRoutingSession = Effect.fnUntraced(function* (
    input: TeamSmartRoutingSessionUpdate,
  ) {
    yield* advisor.setSmartRoutingSession(input);
    const smartRouting = yield* advisor.status;
    yield* Ref.set(smartRoutingRef, smartRouting);
    const stored = yield* store.getSettings;
    const supported = yield* supportedProviderInstanceIds();
    return stored
      ? { ...stored, smartRouting, supportedProviderInstanceIds: supported }
      : ({
          policy: defaultOrchestrationPolicy,
          smartRouting,
          supportedProviderInstanceIds: supported,
        } satisfies TeamSettings);
  });

  const recommendModels = Effect.fn("OrchestrationSettings.recommendModels")(function* () {
    const current = yield* settings;
    const snapshots = yield* providers.getProviders;
    const existingBySelection = new Map(
      current.policy.profiles.map((profile) => [
        `${profile.selection.instanceId}\u0000${profile.selection.model}`,
        profile,
      ]),
    );
    const profiles: TeamModelProfile[] = [];
    const supported = new Set(current.supportedProviderInstanceIds ?? []);
    for (const provider of snapshots) {
      if (
        !supported.has(provider.instanceId) ||
        !provider.enabled ||
        provider.status !== "ready" ||
        provider.auth.status === "unauthenticated" ||
        provider.availability === "unavailable"
      )
        continue;
      for (const model of provider.models) {
        if (model.isLegacy) continue;
        const key = `${provider.instanceId}\u0000${model.slug}`;
        const existing = existingBySelection.get(key);
        profiles.push(
          existing ?? {
            id: `model-${provider.instanceId}-${profiles.length}`,
            label: `${provider.displayName ?? provider.instanceId} · ${model.name}`,
            selection: { instanceId: provider.instanceId, model: model.slug },
            lead: false,
            worker: false,
          },
        );
        if (profiles.length >= 40) break;
      }
      if (profiles.length >= 40) break;
    }

    // Hosted enrichment is deliberately advisory. Until it has a confident answer,
    // catalog entries stay unassigned so a missing advisor can never silently
    // authorize a model for managed execution.
    const smartRoutingAvailable =
      current.policy.flowMode === "auto" && current.smartRouting.available;
    const advised = smartRoutingAvailable
      ? yield* advisor.recommendProfiles(profiles).pipe(Effect.orElseSucceed(() => profiles))
      : profiles;
    const enriched = advised.map((profile) => {
      const existing = existingBySelection.get(
        `${profile.selection.instanceId}\u0000${profile.selection.model}`,
      );
      return existing ?? profile;
    });
    const recommendationApplied = enriched.some((profile, index) => {
      const before = profiles[index];
      if (!before) return false;
      const existing = existingBySelection.has(
        `${before.selection.instanceId}\u0000${before.selection.model}`,
      );
      return (
        !existing &&
        (profile.lead !== before.lead ||
          profile.worker !== before.worker ||
          profile.capability !== before.capability)
      );
    });
    return {
      profiles: enriched,
      source: smartRoutingAvailable && recommendationApplied ? "jev" : "catalog",
      notes: [
        smartRoutingAvailable && recommendationApplied
          ? "Smart Routing recommendations are starting points; your saved Lead and Worker choices stay authoritative."
          : smartRoutingAvailable
            ? "Smart Routing did not return a confident recommendation. Choose Lead and Worker models manually or refresh later."
            : "Choose Lead and Worker models manually for Flow Standard. Connect your account to unlock Smart Routing recommendations.",
      ],
    } satisfies TeamModelRecommendations;
  });

  return { settings, saveSettings, setSmartRoutingSession, recommendModels };
});

export class OrchestrationSettings extends Context.Service<
  OrchestrationSettings,
  Effect.Success<typeof make>
>()("dispatch/team/OrchestrationSettings") {}

export const layer = Layer.effect(OrchestrationSettings, make);

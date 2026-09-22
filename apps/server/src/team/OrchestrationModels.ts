import type { ServerProvider, TeamModelProfile, TeamPolicy } from "@dispatch/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { ProviderRegistry } from "../provider/Services/ProviderRegistry.ts";
import { ProviderService } from "../provider/Services/ProviderService.ts";

const capabilityRank = { general: 0, complex: 1, frontier: 2 } as const;
const directCapabilityRank = { general: 0, complex: 2, frontier: 3 } as const;

function quotaWindowMatchesModel(label: string, model: string): boolean {
  const scope = label.toLowerCase();
  const normalizedModel = model.toLowerCase();
  for (const family of ["opus", "sonnet", "haiku", "spark", "astra", "luna"] as const) {
    if (scope.includes(family) && !normalizedModel.includes(family)) return false;
  }
  return true;
}

/** A provider-reported exhausted window blocks new orchestration work until refreshed. */
export function orchestrationQuotaExhausted(provider: ServerProvider, model: string): boolean {
  return (
    provider.usageLimits?.windows.some(
      (window) =>
        quotaWindowMatchesModel(`${window.id} ${window.label}`, model) && window.usedPercent >= 100,
    ) ?? false
  );
}

export function orchestrationModelUsable(
  provider: ServerProvider | undefined,
  model: string,
): boolean {
  return Boolean(
    provider &&
    provider.enabled &&
    provider.status === "ready" &&
    provider.auth.status !== "unauthenticated" &&
    provider.availability !== "unavailable" &&
    provider.models.some((entry) => entry.slug === model && !entry.isLegacy) &&
    !orchestrationQuotaExhausted(provider, model),
  );
}

export function orderedRoleProfiles(
  policy: TeamPolicy,
  providers: ReadonlyArray<ServerProvider>,
  role: "lead" | "worker",
): ReadonlyArray<TeamModelProfile> {
  return policy.profiles.filter((profile) => {
    if (!profile[role]) return false;
    const provider = providers.find(
      (candidate) => candidate.instanceId === profile.selection.instanceId,
    );
    return orchestrationModelUsable(provider, profile.selection.model);
  });
}

export function directWorkerProfileOrder(
  candidates: ReadonlyArray<TeamModelProfile>,
): ReadonlyArray<TeamModelProfile> {
  return candidates
    .map((profile, index) => ({ profile, index }))
    .toSorted((left, right) => {
      const leftRank = left.profile.capability ? directCapabilityRank[left.profile.capability] : 1;
      const rightRank = right.profile.capability
        ? directCapabilityRank[right.profile.capability]
        : 1;
      return leftRank - rightRank || left.index - right.index;
    })
    .map(({ profile }) => profile);
}

export function equivalentProfileOrder(
  current: TeamModelProfile,
  candidates: ReadonlyArray<TeamModelProfile>,
): ReadonlyArray<TeamModelProfile> {
  const currentCapability = current.capability;
  if (!currentCapability) return candidates;
  const currentRank = capabilityRank[currentCapability];
  return candidates
    .filter(
      (candidate) =>
        candidate.id !== current.id &&
        candidate.capability !== undefined &&
        capabilityRank[candidate.capability] >= currentRank,
    )
    .toSorted((left, right) => {
      const leftRank = capabilityRank[left.capability!];
      const rightRank = capabilityRank[right.capability!];
      return leftRank - rightRank;
    });
}

export const makeOrchestrationModelCatalog = Effect.gen(function* () {
  const registry = yield* ProviderRegistry;
  const providers = yield* ProviderService;

  const runnableProfiles = Effect.fn("OrchestrationModelCatalog.runnableProfiles")(function* (
    policy: TeamPolicy,
    role: "lead" | "worker",
  ) {
    const snapshots = yield* registry.getProviders;
    const catalog = orderedRoleProfiles(policy, snapshots, role);
    return yield* Effect.filter(catalog, (profile) =>
      providers.getCapabilities(profile.selection.instanceId).pipe(
        Effect.map((capabilities) => capabilities.managedTeamNativeDelegation === "blocked"),
        Effect.orElseSucceed(() => false),
      ),
    );
  });

  const refreshProfile = Effect.fn("OrchestrationModelCatalog.refreshProfile")(function* (
    profile: TeamModelProfile,
  ) {
    yield* registry.refreshInstance(profile.selection.instanceId);
    const snapshots = yield* registry.getProviders;
    const provider = snapshots.find(
      (candidate) => candidate.instanceId === profile.selection.instanceId,
    );
    const capabilities = yield* providers
      .getCapabilities(profile.selection.instanceId)
      .pipe(Effect.option);
    return {
      usable: orchestrationModelUsable(provider, profile.selection.model),
      quotaExhausted: provider
        ? orchestrationQuotaExhausted(provider, profile.selection.model)
        : false,
      providerReady: Boolean(
        provider &&
        provider.enabled &&
        provider.status === "ready" &&
        provider.auth.status !== "unauthenticated" &&
        provider.availability !== "unavailable",
      ),
      managedSafe:
        capabilities._tag === "Some" &&
        capabilities.value.managedTeamNativeDelegation === "blocked",
    };
  });

  return { runnableProfiles, refreshProfile };
});

export class OrchestrationModelCatalog extends Context.Service<
  OrchestrationModelCatalog,
  Effect.Success<typeof makeOrchestrationModelCatalog>
>()("dispatch/team/OrchestrationModels/OrchestrationModelCatalog") {}

export const layer = Layer.effect(OrchestrationModelCatalog, makeOrchestrationModelCatalog);

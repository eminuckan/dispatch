import type { ServerProvider, TeamModelProfile, TeamPolicy } from "@t3tools/contracts";

/** A reported exhausted window remains blocking until the provider reports replenishment. */
export function quotaExhausted(provider: ServerProvider, model: string): boolean {
  return (
    provider.usageLimits?.windows.some((window) => {
      const scope = `${window.id} ${window.label}`.toLowerCase();
      for (const family of ["opus", "sonnet", "haiku", "spark"])
        if (scope.includes(family) && !model.toLowerCase().includes(family)) return false;
      return window.usedPercent >= 100;
    }) ?? false
  );
}
export function usableModel(provider: ServerProvider, model: string): boolean {
  return (
    provider.enabled &&
    provider.status === "ready" &&
    provider.auth.status !== "unauthenticated" &&
    provider.availability !== "unavailable" &&
    provider.models.some((entry) => entry.slug === model) &&
    !quotaExhausted(provider, model)
  );
}
export function eligiblePolicy(
  policy: TeamPolicy,
  providers: ReadonlyArray<ServerProvider>,
): TeamPolicy {
  const profiles = policy.profiles.filter((profile) =>
    providers.some(
      (provider) =>
        profile.reviewRequired !== true &&
        provider.instanceId === profile.selection.instanceId &&
        usableModel(provider, profile.selection.model),
    ),
  );
  return {
    ...policy,
    profiles,
    preferredCapableProfileId: profiles.some((p) => p.id === policy.preferredCapableProfileId)
      ? policy.preferredCapableProfileId
      : null,
  };
}

/** Catalog presence is availability evidence, never a capability or cost benchmark. */
export function poolCandidates(
  providers: ReadonlyArray<ServerProvider>,
  approved: ReadonlyArray<TeamModelProfile> = [],
) {
  const notes: string[] = [];
  const queues = providers
    .filter((provider) => provider.enabled && provider.status === "ready")
    .map((provider) => {
      if (!provider.usageLimits?.windows.length || provider.usageLimits.unavailable)
        notes.push(`${provider.displayName ?? provider.instanceId}: quota could not be confirmed.`);
      return provider.models
        .filter(
          (model) =>
            !model.isLegacy &&
            !/(?:^|\/)gpt-5\.6-terra(?:$|-)/.test(model.slug) &&
            usableModel(provider, model.slug),
        )
        .flatMap((model): TeamModelProfile[] => {
          const existing = approved.filter(
            (profile) =>
              profile.selection.instanceId === provider.instanceId &&
              profile.selection.model === model.slug &&
              !profile.reviewRequired,
          );
          if (existing.length) return existing;
          return [
            {
              id: `candidate-${provider.instanceId}-${provider.models.indexOf(model)}`,
              label: `${provider.displayName ?? provider.instanceId} · ${model.name}`,
              selection: { instanceId: provider.instanceId, model: model.slug },
              tier: "capable",
              reviewRequired: true,
              lead: false,
              worker: false,
              estimatedAttemptUsd: null,
            },
          ];
        });
    });
  const profiles: TeamModelProfile[] = approved.filter(
    (profile) =>
      !profile.reviewRequired &&
      providers.some(
        (provider) =>
          provider.instanceId === profile.selection.instanceId &&
          usableModel(provider, profile.selection.model),
      ),
  );
  const seen = new Set(profiles.map((profile) => profile.id));
  // Round-robin prevents a large aggregator catalog from hiding the other providers.
  for (let index = 0; profiles.length < 40 && queues.some((queue) => index < queue.length); index++)
    for (const queue of queues)
      if (queue[index] && profiles.length < 40 && !seen.has(queue[index]!.id)) {
        profiles.push(queue[index]!);
        seen.add(queue[index]!.id);
      }
  if (profiles.some((profile) => profile.reviewRequired))
    notes.push(
      "New profiles are inactive. Choose a task group and agent roles after reviewing model/effort suitability. No capability or price ranking was inferred from model names.",
    );
  return { profiles, notes };
}

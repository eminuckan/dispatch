import type { TeamModelProfile, TeamPolicy } from "@dispatch/contracts";

export const routingTierLabels = {
  economy: "Routine tasks",
  balanced: "Everyday tasks",
  capable: "Complex tasks",
} as const;

// The subscription UI must not preserve an invisible legacy dollar limit.
// Existing running teams retain their frozen policy and reservations.
export function subscriptionRoutingPolicy(policy: TeamPolicy): TeamPolicy {
  return {
    ...policy,
    estimatedBudgetUsd: null,
    profiles: policy.profiles.map((p) => ({ ...p, estimatedAttemptUsd: null })),
  };
}

export function findReadyCapableLead(
  profiles: ReadonlyArray<TeamModelProfile>,
): TeamModelProfile | undefined {
  return profiles.find(
    (profile) => profile.reviewRequired !== true && profile.lead && profile.tier === "capable",
  );
}

function normalizedRecommendedProfiles(
  profiles: ReadonlyArray<TeamModelProfile>,
): ReadonlyArray<TeamModelProfile> {
  return profiles.map((profile) => ({ ...profile, estimatedAttemptUsd: null }));
}

export function refreshedRecommendationPolicy(
  policy: TeamPolicy,
  profiles: ReadonlyArray<TeamModelProfile>,
): TeamPolicy {
  const normalized = normalizedRecommendedProfiles(profiles);
  const preferred = normalized.find(
    (profile) =>
      profile.id === policy.preferredCapableProfileId &&
      profile.reviewRequired !== true &&
      profile.lead &&
      profile.tier === "capable",
  );
  return {
    ...subscriptionRoutingPolicy(policy),
    profiles: normalized,
    preferredCapableProfileId: preferred?.id ?? null,
  };
}

export function initialRecommendedPolicy(
  policy: TeamPolicy,
  profiles: ReadonlyArray<TeamModelProfile>,
): TeamPolicy | null {
  const refreshed = refreshedRecommendationPolicy(policy, profiles);
  const lead = findReadyCapableLead(refreshed.profiles);
  return lead
    ? {
        ...refreshed,
        mode: "shadow",
        preferredCapableProfileId: lead.id,
      }
    : null;
}

export function recommendedProfileForModel(
  profiles: ReadonlyArray<TeamModelProfile>,
  instanceId: TeamModelProfile["selection"]["instanceId"],
  model: string,
): TeamModelProfile | undefined {
  const profile = profiles.find(
    (candidate) =>
      candidate.reviewRequired !== true &&
      candidate.selection.instanceId === instanceId &&
      candidate.selection.model === model,
  );
  return profile ? { ...profile, estimatedAttemptUsd: null } : undefined;
}

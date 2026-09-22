import type { ProviderInstanceId, TeamModelProfile } from "@dispatch/contracts";

export function recommendationForSelection(
  recommendations: ReadonlyArray<TeamModelProfile>,
  instanceId: ProviderInstanceId,
  model: string,
): TeamModelProfile | undefined {
  return recommendations.find(
    (recommendation) =>
      recommendation.selection.instanceId === instanceId &&
      recommendation.selection.model === model,
  );
}

export function recommendationForProfile(
  profile: TeamModelProfile,
  recommendations: ReadonlyArray<TeamModelProfile>,
): TeamModelProfile | undefined {
  return recommendationForSelection(
    recommendations,
    profile.selection.instanceId,
    profile.selection.model,
  );
}

/**
 * Recommendation refreshes may enrich internal capability metadata, but saved
 * Lead/Worker choices stay authoritative until the user explicitly applies a
 * role recommendation.
 */
export function mergeRecommendedCapabilities(
  profiles: ReadonlyArray<TeamModelProfile>,
  recommendations: ReadonlyArray<TeamModelProfile>,
): ReadonlyArray<TeamModelProfile> {
  return profiles.map((profile) => {
    if (profile.capability !== undefined) return profile;
    const recommendation = recommendationForProfile(profile, recommendations);
    return recommendation?.capability === undefined
      ? profile
      : { ...profile, capability: recommendation.capability };
  });
}

export function applyRecommendedRoles(
  profile: TeamModelProfile,
  recommendation: TeamModelProfile,
): TeamModelProfile {
  return {
    ...profile,
    lead: recommendation.lead,
    worker: recommendation.worker,
    ...(profile.capability === undefined && recommendation.capability !== undefined
      ? { capability: recommendation.capability }
      : {}),
  };
}

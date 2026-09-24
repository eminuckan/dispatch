import type {
  ProviderInstanceId,
  ServerProvider,
  TeamFlowMode,
  TeamModelProfile,
  TeamPolicy,
} from "@dispatch/contracts";
import { readyFlowProviders } from "../flowPolicy";

export function firstReadyStandardFlowModel(
  providers: ReadonlyArray<ServerProvider>,
  supportedProviderInstanceIds: ReadonlyArray<ProviderInstanceId> | undefined,
): Pick<TeamModelProfile, "label" | "selection"> | null {
  const provider = readyFlowProviders(providers, supportedProviderInstanceIds)[0];
  const model = provider?.models.find((candidate) => !candidate.isLegacy);
  if (!provider || !model) return null;
  return {
    label: `${provider.displayName ?? provider.instanceId} · ${model.name}`,
    selection: { instanceId: provider.instanceId, model: model.slug },
  };
}

export function prepareOnboardingFlowPolicy(input: {
  readonly policy: TeamPolicy;
  readonly recommendations: ReadonlyArray<TeamModelProfile>;
  readonly flowMode: TeamFlowMode;
}): TeamPolicy | null {
  const existingProfiles = input.policy.profiles;
  if (
    existingProfiles.length > 0 &&
    (input.flowMode === "auto" || existingProfiles.some((profile) => profile.lead))
  ) {
    return {
      ...input.policy,
      enabled: true,
      flowMode: input.flowMode,
      profiles: existingProfiles,
    };
  }

  const assigned =
    input.flowMode === "auto"
      ? input.recommendations
      : input.recommendations.filter((profile) => profile.lead || profile.worker);
  if (
    assigned.length > 0 &&
    (input.flowMode === "auto" || assigned.some((profile) => profile.lead))
  ) {
    return {
      ...input.policy,
      enabled: true,
      flowMode: input.flowMode,
      profiles: assigned,
    };
  }

  const first = input.recommendations[0];
  if (!first) return null;
  return {
    ...input.policy,
    enabled: true,
    flowMode: input.flowMode,
    profiles: [
      input.flowMode === "auto"
        ? { ...first, lead: false, worker: true }
        : { ...first, lead: true, worker: true },
    ],
  };
}

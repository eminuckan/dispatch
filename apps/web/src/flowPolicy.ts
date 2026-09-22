import type { ProviderInstanceId, ServerProvider, TeamPolicy } from "@dispatch/contracts";

export function readyFlowProviders(
  providers: ReadonlyArray<ServerProvider>,
  supportedProviderInstanceIds: ReadonlyArray<ProviderInstanceId> | undefined,
): ReadonlyArray<ServerProvider> {
  const supported = new Set(supportedProviderInstanceIds);
  return providers.filter(
    (provider) =>
      supported.has(provider.instanceId) &&
      provider.enabled &&
      provider.status === "ready" &&
      provider.auth.status !== "unauthenticated" &&
      provider.availability !== "unavailable" &&
      provider.models.some((model) => !model.isLegacy),
  );
}

export function hasFlowLead(policy: Pick<TeamPolicy, "profiles">): boolean {
  return policy.profiles.some((profile) => profile.lead);
}

export function hasAssignedFlowModel(policy: Pick<TeamPolicy, "profiles">): boolean {
  return policy.profiles.some((profile) => profile.lead || profile.worker);
}

export function hasRequiredFlowRole(policy: Pick<TeamPolicy, "flowMode" | "profiles">): boolean {
  return policy.flowMode === "auto" ? hasAssignedFlowModel(policy) : hasFlowLead(policy);
}

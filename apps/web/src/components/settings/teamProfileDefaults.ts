import type { TeamPolicy } from "@dispatch/contracts";

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

import type { TeamModelProfile, TeamPolicy } from "@t3tools/contracts";

// Starting policy hints, not benchmark scores or estimates of subscription usage.
// Match known families only; an unknown model needs the user's classification.
export function suggestRoutingTier(model: string): TeamModelProfile["tier"] | null {
  const slug = model.toLowerCase().split("/").at(-1) ?? model;
  if (/^gpt-5\.6-luna(?:$|-)/.test(slug) || slug.startsWith("claude-haiku-")) return "economy";
  if (/^gpt-5\.6-terra(?:$|-)/.test(slug) || slug.startsWith("claude-sonnet-")) return "balanced";
  if (/^gpt-(?:6-astra|5\.6-sol)(?:$|-)/.test(slug) || slug.startsWith("claude-opus-"))
    return "capable";
  return null;
}

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

import { describe, expect, it } from "vite-plus/test";
import { subscriptionRoutingPolicy } from "./teamProfileDefaults";
import { ProviderInstanceId, type TeamPolicy } from "@dispatch/contracts";

describe("routing profile defaults", () => {
  it("clears legacy estimates without changing routing permissions or mutating a running snapshot", () => {
    const policy = {
      mode: "shadow",
      revision: 4,
      maxActive: 5,
      maxAttempts: 2,
      confidenceThreshold: 0.9,
      estimatedBudgetUsd: 1,
      profiles: [
        {
          id: "a",
          label: "A",
          tier: "capable",
          lead: true,
          worker: false,
          selection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-6-astra" },
          estimatedAttemptUsd: 0.2,
        },
      ],
    } satisfies TeamPolicy;
    const next = subscriptionRoutingPolicy(policy);
    expect(next.estimatedBudgetUsd).toBeNull();
    expect(next.profiles[0]?.estimatedAttemptUsd).toBeNull();
    expect(next.profiles[0]?.worker).toBe(false);
    expect(next.profiles[0]?.selection).toEqual(policy.profiles[0]?.selection);
    expect(policy.estimatedBudgetUsd).toBe(1);
    expect(policy.profiles[0]?.estimatedAttemptUsd).toBe(0.2);
  });
});

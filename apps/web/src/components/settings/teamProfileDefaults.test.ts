import { describe, expect, it } from "vite-plus/test";
import {
  findReadyCapableLead,
  initialRecommendedPolicy,
  recommendedProfileForModel,
  refreshedRecommendationPolicy,
  subscriptionRoutingPolicy,
} from "./teamProfileDefaults";
import { ProviderInstanceId, type TeamModelProfile, type TeamPolicy } from "@dispatch/contracts";

const codex = ProviderInstanceId.make("codex");
const profile = (
  id: string,
  model: string,
  overrides: Partial<TeamModelProfile> = {},
): TeamModelProfile => ({
  id,
  label: model,
  selection: { instanceId: codex, model },
  tier: "capable",
  lead: true,
  worker: true,
  estimatedAttemptUsd: null,
  ...overrides,
});

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

  it("activates initial recommendations only when they include an approved capable lead", () => {
    const policy = {
      mode: "off",
      revision: 2,
      maxActive: 5,
      maxAttempts: 2,
      confidenceThreshold: 0.9,
      profiles: [],
    } satisfies TeamPolicy;
    expect(initialRecommendedPolicy(policy, [profile("lead", "gpt-6-astra")])).toMatchObject({
      mode: "shadow",
      preferredCapableProfileId: "lead",
      profiles: [{ id: "lead" }],
    });
    expect(
      initialRecommendedPolicy(policy, [
        profile("pending", "gpt-6-astra", { reviewRequired: true, lead: false }),
      ]),
    ).toBeNull();
  });

  it("refreshes recommendations without carrying a now-invalid preferred lead", () => {
    const current = {
      mode: "shadow",
      revision: 4,
      maxActive: 5,
      maxAttempts: 2,
      confidenceThreshold: 0.9,
      preferredCapableProfileId: "old-lead",
      profiles: [profile("old-lead", "old")],
    } satisfies TeamPolicy;
    const recommended = [profile("new-lead", "new", { estimatedAttemptUsd: 2 })];
    const next = refreshedRecommendationPolicy(current, recommended);
    expect(next.preferredCapableProfileId).toBeNull();
    expect(next.profiles).toEqual([{ ...recommended[0], estimatedAttemptUsd: null }]);
    expect(current.profiles[0]?.id).toBe("old-lead");
  });

  it("uses matching recommendation defaults for a manually added model", () => {
    const recommended = profile("recommended", "gpt-5.6-luna", {
      tier: "balanced",
      lead: false,
      selection: {
        instanceId: codex,
        model: "gpt-5.6-luna",
        options: [{ id: "reasoningEffort", value: "medium" }],
      },
      estimatedAttemptUsd: 1,
    });
    expect(findReadyCapableLead([recommended])).toBeUndefined();
    expect(recommendedProfileForModel([recommended], codex, "gpt-5.6-luna")).toEqual({
      ...recommended,
      estimatedAttemptUsd: null,
    });
    expect(recommendedProfileForModel([recommended], codex, "gpt-6-astra")).toBeUndefined();
    expect(
      recommendedProfileForModel(
        [{ ...recommended, reviewRequired: true, lead: false, worker: false }],
        codex,
        "gpt-5.6-luna",
      ),
    ).toBeUndefined();
  });
});

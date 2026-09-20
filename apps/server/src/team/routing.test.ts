import { describe, expect, it } from "vite-plus/test";
import { ProviderInstanceId, type TeamPolicy } from "@dispatch/contracts";
import {
  classify,
  defaultTeamPolicy,
  chooseProfile,
  expectedRetryCost,
  fingerprintDraft,
  validatePool,
  type JevResponse,
  planningHints,
  fitsJevState,
  requiresDeliberateReasoning,
} from "./routing.ts";
const choice = (choice: string, keys: string[], confidence = 0.99) => ({
  type: "choice" as const,
  choice,
  confidence,
  probabilities: Object.fromEntries(keys.map((k) => [k, k === choice ? 1 : 0])),
});
const response = (): JevResponse => ({
  model: "jev-1.13.0",
  usage: { input_tokens: 100, output_tokens: 0 },
  answers: {
    complexity: choice("economy", ["economy", "balanced", "capable"]),
    risk: choice("ordinary", ["ordinary", "critical"]),
    reasoning: choice("routine", ["routine", "deliberate"]),
  },
});
const policy: TeamPolicy = {
  ...defaultTeamPolicy,
  mode: "shadow",
  profiles: [
    {
      id: "cheap",
      label: "Cheap",
      selection: { instanceId: ProviderInstanceId.make("codex"), model: "small" },
      tier: "economy",
      lead: true,
      worker: true,
      estimatedAttemptUsd: 0.1,
    },
    {
      id: "strong",
      label: "Strong",
      selection: { instanceId: ProviderInstanceId.make("codex"), model: "large" },
      tier: "capable",
      lead: true,
      worker: true,
      estimatedAttemptUsd: null,
    },
  ],
};
describe("routing gates", () => {
  it("selects the explicitly preferred capable lead without overriding economy routing", () => {
    const astra = {
      ...policy.profiles[1]!,
      id: "astra",
      label: "Astra",
      selection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-6-astra" },
    };
    const pool = {
      ...policy,
      profiles: [...policy.profiles, astra],
      preferredCapableProfileId: "astra",
    };
    expect(chooseProfile(pool, "capable", "lead")?.id).toBe("astra");
    expect(chooseProfile(pool, "economy", "lead")?.id).toBe("cheap");
    expect(chooseProfile(pool, "capable", "worker")?.id).toBe("strong");
    expect(() =>
      validatePool({ ...defaultTeamPolicy, preferredCapableProfileId: "absent" }, []),
    ).toThrow();
  });
  it("does not infer a price ranking from a partially known peer set", () => {
    const base = policy.profiles[0]!;
    const profiles = [
      { ...base, id: "first", estimatedAttemptUsd: 3 },
      { ...base, id: "unknown", estimatedAttemptUsd: null },
      { ...base, id: "last", estimatedAttemptUsd: 1 },
    ];
    expect(chooseProfile({ ...policy, profiles }, "economy", "lead")?.id).toBe("first");
    expect(
      chooseProfile(
        { ...policy, profiles: profiles.filter((p) => p.estimatedAttemptUsd !== null) },
        "economy",
        "lead",
      )?.id,
    ).toBe("last");
  });
  it("keeps uncertain advisory signals separate from model admission", () => {
    const base = response();
    const result = {
      ...base,
      answers: {
        ...base.answers,
        delegation: choice("separable", ["single", "separable"], 0.55),
        verification: choice("deterministic", ["deterministic", "review"]),
      },
    };
    expect(classify(result, 0.9).tier).toBe("economy");
    expect(planningHints(result, 0.9)).toEqual({
      context: "unknown",
      verification: "deterministic",
      delegation: "unknown",
    });
    expect(planningHints(null, 0.9).verification).toBe("unknown");
  });
  it("bounds multibyte state without silently dropping task constraints", () => {
    expect(fitsJevState({ text: "small task" })).toBe(true);
    expect(fitsJevState({ text: "界".repeat(9000) })).toBe(false);
  });
  it("does not average away low confidence in a critical answer", () => {
    const original = response();
    const result = {
      ...original,
      answers: { ...original.answers, risk: { ...original.answers.risk, confidence: 0.55 } },
    };
    expect(classify(result, 0.9).tier).toBe("capable");
  });
  it("separates reasoning effort from model tier", () => {
    const original = response();
    const result = {
      ...original,
      answers: { ...original.answers, reasoning: choice("deliberate", ["routine", "deliberate"]) },
    };
    expect(classify(result, 0.9).tier).toBe("economy");
    expect(chooseProfile(policy, "economy", "lead", true)?.id).toBe("strong");
    const withEffort = {
      ...policy,
      profiles: policy.profiles.map((p) =>
        p.id === "cheap"
          ? {
              ...p,
              selection: { ...p.selection, options: [{ id: "reasoningEffort", value: "max" }] },
            }
          : p,
      ),
    };
    expect(chooseProfile(withEffort, "economy", "lead", true)?.id).toBe("cheap");
  });
  it("raises effort rather than complexity when only reasoning confidence is low", () => {
    const original = response();
    const uncertain = {
      ...original,
      answers: {
        ...original.answers,
        reasoning: choice("routine", ["routine", "deliberate"], 0.55),
      },
    };
    const outcome = classify(uncertain, 0.9);
    expect(outcome.tier).toBe("economy");
    expect(requiresDeliberateReasoning(uncertain, 0.9)).toBe(true);
    const pool = {
      ...policy,
      profiles: policy.profiles.map((p) =>
        p.id === "cheap"
          ? {
              ...p,
              selection: { ...p.selection, options: [{ id: "reasoningEffort", value: "max" }] },
            }
          : p,
      ),
    };
    expect(
      chooseProfile(pool, outcome.tier, "lead", requiresDeliberateReasoning(uncertain, 0.9))?.id,
    ).toBe("cheap");
    expect(chooseProfile(policy, outcome.tier, "lead", true)?.id).toBe("strong");
  });
  it("rejects malformed and inconsistent distributions", () => {
    const original = response();
    const result = {
      ...original,
      answers: {
        ...original.answers,
        risk: { ...original.answers.risk, probabilities: { ordinary: 0.1, critical: 0.9 } },
      },
    };
    expect(classify(result, 0.9).tier).toBe("capable");
  });
  it("uses economy only after every gate passes", () =>
    expect(classify(response(), 0.9).tier).toBe("economy"));
  it("does not downgrade when no capable profile is allowed", () =>
    expect(
      chooseProfile({ ...policy, profiles: [policy.profiles[0]!] }, "capable", "lead"),
    ).toBeNull());
  it("changes the fingerprint for prompt edits, attachments and pool edits", () => {
    const draft = {
      draftId: "draft",
      revision: 1,
      policyRevision: 0,
      prompt: "change a label",
      hasAttachments: false,
    };
    const original = fingerprintDraft(draft, policy, []);
    expect(fingerprintDraft({ ...draft, prompt: "change a payment" }, policy, [])).not.toBe(
      original,
    );
    expect(fingerprintDraft({ ...draft, hasAttachments: true }, policy, [])).not.toBe(original);
    expect(fingerprintDraft(draft, { ...policy, maxAttempts: 3 }, [])).not.toBe(original);
  });
  it("refuses a catalog model that was removed", () =>
    expect(() => validatePool(policy, [])).toThrow(/catalog/));
  it("accounts for repeated failed attempts and fallback", () => {
    expect(expectedRetryCost(0.1, 0.5, 3, 1)).toBeCloseTo(0.3);
    expect(expectedRetryCost(0.1, 0, 3, 1)).toBeCloseTo(1.3);
    expect(expectedRetryCost(0.1, 1, 3, 1)).toBeCloseTo(0.1);
    expect(() => expectedRetryCost(0.1, Number.NaN, 3, 1)).toThrow();
  });
  it("does not treat repeated failures as independent new chances", () => {
    // Half the tasks pass once; the remaining tasks cannot be fixed by repeating the same attempt.
    expect(expectedRetryCost(0.1, [0.5, 0, 0], 3, 1)).toBeCloseTo(0.7);
    expect(expectedRetryCost(0.1, [0.5, 1, 0], 3, 1)).toBeCloseTo(0.15);
    expect(() => expectedRetryCost(0.1, [], 3, 1)).toThrow();
    expect(() => expectedRetryCost(0.1, [0.5, Number.NaN, 0], 3, 1)).toThrow();
    expect(() => expectedRetryCost(0.1, [0.5, 1.1, 0], 3, 1)).toThrow();
  });
});

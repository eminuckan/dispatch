import { describe, expect, it } from "vite-plus/test";
import { ProviderInstanceId, type TeamPolicy, type TeamRecoveryInput } from "@t3tools/contracts";
import { defaultTeamPolicy } from "./routing.ts";
import { recoveryAdvice, type RecoveryResponse } from "./recovery.ts";
const profile = (id: string, model: string, effort: string, tier: "economy" | "capable") => ({
  id,
  label: id,
  selection: {
    instanceId: ProviderInstanceId.make("codex"),
    model,
    options: [{ id: "reasoningEffort", value: effort }],
  },
  tier,
  lead: true,
  worker: true,
  estimatedAttemptUsd: null,
});
const policy: TeamPolicy = {
  ...defaultTeamPolicy,
  mode: "shadow",
  maxAttempts: 3,
  profiles: [
    profile("astra-low", "astra", "low", "capable"),
    profile("astra-high", "astra", "high", "capable"),
    profile("astra-max", "astra", "max", "capable"),
    profile("luna-max", "luna", "max", "economy"),
  ],
};
const input: TeamRecoveryInput = {
  policyRevision: 0,
  currentProfileId: "astra-low",
  objective: "Implement the specified behavior",
  evidence: "A failing check",
  correction: "Fix the off-by-one boundary identified by the test",
  attemptsMade: 1,
  inFlight: false,
};
const choice = (chosen: string, keys: string[], confidence = 0.99) => ({
  type: "choice" as const,
  choice: chosen,
  probabilities: Object.fromEntries(keys.map((k) => [k, k === chosen ? 1 : 0])),
  confidence,
});
const response = (cause: string, correction = "actionable"): RecoveryResponse => ({
  model: "jev-1.13.0",
  usage: { input_tokens: 100, output_tokens: 0 },
  answers: {
    cause: choice(cause, ["environment", "context", "local", "reasoning", "unknown"]),
    correction: choice(correction, ["actionable", "absent"]),
  },
});
describe("recovery advice", () => {
  it("corrects a bounded failure without changing the model or effort", () => {
    expect(recoveryAdvice(input, policy, response("local"))).toMatchObject({
      action: "correct",
      profileId: "astra-low",
    });
    expect(recoveryAdvice({ ...input, correction: "" }, policy, response("local")).action).toBe(
      "lead_review",
    );
    expect(recoveryAdvice(input, policy, response("local", "absent")).action).toBe("lead_review");
  });
  it("raises Astra effort within the allowed pool before considering a different model", () => {
    expect(recoveryAdvice(input, policy, response("reasoning"))).toMatchObject({
      action: "increase_effort",
      profileId: "astra-high",
    });
    expect(
      recoveryAdvice(
        { ...input, currentProfileId: "astra-max", attemptsMade: 2 },
        policy,
        response("reasoning"),
      ).action,
    ).toBe("lead_review");
  });
  it("does not treat provider switches or unrelated options as effort upgrades", () => {
    const changed = {
      ...policy,
      profiles: policy.profiles.map((p) =>
        p.id === "astra-high" || p.id === "astra-max"
          ? { ...p, selection: { ...p.selection, instanceId: ProviderInstanceId.make("other") } }
          : p,
      ),
    };
    expect(recoveryAdvice(input, changed, response("reasoning")).action).toBe("lead_review");
  });
  it("repairs blockers without buying a stronger model", () => {
    expect(recoveryAdvice(input, policy, response("environment")).action).toBe(
      "repair_environment",
    );
    expect(recoveryAdvice(input, policy, response("context")).action).toBe("supply_context");
  });
  it("requires repeated reasoning failure before proposing another worker", () => {
    const cheap = { ...input, currentProfileId: "luna-max" };
    expect(recoveryAdvice(cheap, policy, response("reasoning")).action).toBe("lead_review");
    expect(
      recoveryAdvice({ ...cheap, attemptsMade: 2 }, policy, response("reasoning")).action,
    ).toBe("new_worker");
  });
  it("waits for in-flight work without imposing a correction attempt ceiling", () => {
    expect(recoveryAdvice({ ...input, inFlight: true }, policy, response("reasoning")).action).toBe(
      "wait",
    );
    expect(
      recoveryAdvice({ ...input, attemptsMade: 3 }, policy, response("reasoning")).action,
    ).toBe("increase_effort");
    const base = response("reasoning");
    const uncertain = {
      ...base,
      answers: { ...base.answers, cause: { ...base.answers.cause, confidence: 0.55 } },
    };
    expect(recoveryAdvice(input, policy, uncertain).action).toBe("lead_review");
    expect(
      recoveryAdvice(input, policy, { ...response("reasoning"), model: "different" }).action,
    ).toBe("lead_review");
  });
});

it("distinguishes missing responses, low confidence, unsupported versions and unknown causes", () => {
  expect(recoveryAdvice(input, policy, null).reason).toContain("No valid Jev recovery response");
  const low = response("local");
  const lowConfidence = {
    ...low,
    answers: { ...low.answers, cause: { ...low.answers.cause, confidence: 0.55 } },
  };
  expect(recoveryAdvice(input, policy, lowConfidence).reason).toContain(
    "0.55 is below the required 0.9",
  );
  expect(recoveryAdvice(input, policy, { ...low, model: "unexpected" }).reason).toContain(
    "unsupported classifier version",
  );
  expect(recoveryAdvice(input, policy, response("unknown")).reason).toContain(
    "could not distinguish",
  );
});

import { describe, expect, it } from "vite-plus/test";
import {
  ProviderInstanceId,
  type ServerProvider,
  type TeamModelProfile,
  type TeamPolicy,
} from "@dispatch/contracts";

import { firstReadyStandardFlowModel, prepareOnboardingFlowPolicy } from "./flowSetup.logic";

const profile = (id: string, lead = false, worker = false): TeamModelProfile => ({
  id,
  label: id,
  selection: { instanceId: ProviderInstanceId.make("codex"), model: id },
  lead,
  worker,
});

const policy: TeamPolicy = {
  revision: 0,
  enabled: false,
  flowMode: "standard",
  profiles: [],
  maxActive: 5,
  maxAttempts: 2,
  providerLimitBehavior: "ask",
};

describe("onboarding Flow policy", () => {
  it("selects a ready local catalog model for Standard without hosted recommendations", () => {
    const providers = [
      {
        instanceId: ProviderInstanceId.make("codex"),
        driver: "codex",
        displayName: "Codex",
        enabled: true,
        status: "ready",
        availability: "available",
        auth: { status: "authenticated" },
        models: [
          { slug: "legacy", name: "Legacy", isLegacy: true },
          { slug: "ready", name: "Ready", isLegacy: false },
        ],
      },
    ] as unknown as ReadonlyArray<ServerProvider>;
    expect(firstReadyStandardFlowModel(providers, [ProviderInstanceId.make("codex")])).toEqual({
      label: "Codex · Ready",
      selection: { instanceId: ProviderInstanceId.make("codex"), model: "ready" },
    });
    expect(firstReadyStandardFlowModel(providers, [])).toBeNull();
    expect(firstReadyStandardFlowModel(providers, undefined)).toBeNull();
  });

  it("skips a ready provider without managed Flow support when seeding Standard", () => {
    const providers = [
      {
        instanceId: ProviderInstanceId.make("unsafe-runtime"),
        displayName: "Unsupported runtime",
        enabled: true,
        status: "ready",
        auth: { status: "authenticated" },
        models: [{ slug: "first", name: "First" }],
      },
      {
        instanceId: ProviderInstanceId.make("safe-runtime"),
        displayName: "Supported runtime",
        enabled: true,
        status: "ready",
        auth: { status: "authenticated" },
        models: [{ slug: "second", name: "Second" }],
      },
    ] as unknown as ReadonlyArray<ServerProvider>;
    expect(
      firstReadyStandardFlowModel(providers, [ProviderInstanceId.make("safe-runtime")]),
    ).toEqual({
      label: "Supported runtime · Second",
      selection: { instanceId: ProviderInstanceId.make("safe-runtime"), model: "second" },
    });
    expect(
      firstReadyStandardFlowModel(
        providers.map((provider) => ({ ...provider, availability: "unavailable" })),
        [ProviderInstanceId.make("safe-runtime")],
      ),
    ).toBeNull();
  });

  it("uses hosted role recommendations when they contain a lead", () => {
    const result = prepareOnboardingFlowPolicy({
      policy,
      recommendations: [profile("lead", true, false), profile("worker", false, true)],
      flowMode: "auto",
    });
    expect(result).toMatchObject({ enabled: true, flowMode: "auto" });
    expect(result?.profiles.map((entry) => [entry.id, entry.lead, entry.worker])).toEqual([
      ["lead", true, false],
      ["worker", false, true],
    ]);
  });

  it("preserves Worker-only Auto setup without promoting it to Lead", () => {
    const existing = { ...policy, profiles: [profile("direct", false, true)] };
    const result = prepareOnboardingFlowPolicy({
      policy: existing,
      recommendations: [],
      flowMode: "auto",
    });

    expect(result?.profiles).toEqual(existing.profiles);
    expect(result).toMatchObject({ enabled: true, flowMode: "auto" });
  });

  it("keeps a direct-only recommendation unassigned for Auto", () => {
    const result = prepareOnboardingFlowPolicy({
      policy,
      recommendations: [profile("ready")],
      flowMode: "auto",
    });

    expect(result?.profiles).toEqual([profile("ready")]);
  });

  it("makes the first supported catalog model explicit Lead + Worker for Standard setup", () => {
    const result = prepareOnboardingFlowPolicy({
      policy,
      recommendations: [profile("ready")],
      flowMode: "standard",
    });
    expect(result?.profiles).toEqual([profile("ready", true, true)]);
  });

  it("keeps a user's existing lead setup and returns null when no supported model exists", () => {
    const existing = { ...policy, profiles: [profile("saved", true, false)] };
    expect(
      prepareOnboardingFlowPolicy({ policy: existing, recommendations: [], flowMode: "auto" })
        ?.profiles,
    ).toEqual(existing.profiles);
    expect(prepareOnboardingFlowPolicy({ policy, recommendations: [], flowMode: "standard" })).toBe(
      null,
    );
  });
});

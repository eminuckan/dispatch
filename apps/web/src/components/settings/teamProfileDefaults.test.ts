import { describe, expect, it } from "vite-plus/test";
import { ProviderInstanceId, type TeamModelProfile } from "@dispatch/contracts";

import {
  applyRecommendedRoles,
  mergeRecommendedCapabilities,
  recommendationForProfile,
  recommendationForSelection,
} from "./teamProfileDefaults";

const codex = ProviderInstanceId.make("codex");
const claude = ProviderInstanceId.make("claude");

const profile = (
  id: string,
  model: string,
  overrides: Partial<TeamModelProfile> = {},
): TeamModelProfile => ({
  id,
  label: model,
  selection: { instanceId: codex, model },
  lead: false,
  worker: true,
  ...overrides,
});

describe("orchestration model recommendations", () => {
  it("matches recommendations by provider instance and model instead of generated id", () => {
    const recommendation = profile("recommended-id", "gpt-5.6-luna", {
      lead: true,
      worker: false,
    });

    expect(recommendationForSelection([recommendation], codex, "gpt-5.6-luna")).toBe(
      recommendation,
    );
    expect(recommendationForProfile(profile("saved-id", "gpt-5.6-luna"), [recommendation])).toBe(
      recommendation,
    );
    expect(
      recommendationForProfile(
        profile("other-provider", "gpt-5.6-luna", {
          selection: { instanceId: claude, model: "gpt-5.6-luna" },
        }),
        [recommendation],
      ),
    ).toBeUndefined();
  });

  it("merges only missing capability metadata and preserves saved Lead/Worker choices", () => {
    const saved = profile("saved", "gpt-5.6-luna", { lead: false, worker: true });
    const classified = profile("recommended", "gpt-5.6-luna", {
      lead: true,
      worker: false,
      capability: "frontier",
    });
    const alreadyClassified = profile("existing-capability", "gpt-6", {
      lead: true,
      worker: true,
      capability: "complex",
    });

    const merged = mergeRecommendedCapabilities(
      [saved, alreadyClassified],
      [classified, profile("gpt-6-rec", "gpt-6", { capability: "frontier" })],
    );

    expect(merged[0]).toEqual({ ...saved, capability: "frontier" });
    expect(merged[0]?.lead).toBe(false);
    expect(merged[0]?.worker).toBe(true);
    expect(merged[1]).toBe(alreadyClassified);
  });

  it("changes roles only when a recommendation is explicitly applied", () => {
    const saved = profile("saved", "gpt-5.6-luna", {
      lead: false,
      worker: true,
      capability: "complex",
    });
    const recommendation = profile("recommended", "gpt-5.6-luna", {
      lead: true,
      worker: false,
      capability: "frontier",
    });

    expect(applyRecommendedRoles(saved, recommendation)).toEqual({
      ...saved,
      lead: true,
      worker: false,
    });
  });
});

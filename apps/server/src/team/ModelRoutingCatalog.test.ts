import { expect, it } from "@effect/vitest";
import {
  ProviderInstanceId,
  type ServerProviderModel,
  type TeamModelProfile,
} from "@dispatch/contracts";

import {
  highestSupportedEffort,
  modelRoutingPrior,
  profileUsesAutoEffort,
  selectionWithEffort,
  suggestedTeamRole,
  supportedModelEfforts,
} from "./ModelRoutingCatalog.ts";

it("keeps known economical workers at the highest supported effort", () => {
  const model: ServerProviderModel = {
    slug: "gpt-6-luna",
    name: "GPT-6 Luna",
    isCustom: false,
    capabilities: {
      optionDescriptors: [
        {
          id: "reasoningEffort",
          label: "Reasoning",
          type: "select",
          options: [
            { id: "low", label: "Low" },
            { id: "high", label: "High" },
          ],
        },
      ],
    },
  };
  const choices = supportedModelEfforts(model);
  expect(choices).toEqual({ optionId: "reasoningEffort", values: ["low", "high"] });
  expect(highestSupportedEffort(choices!.values)).toBe("high");
  expect(modelRoutingPrior(model.slug)).toMatchObject({
    costClass: "economy",
    effortStrategy: "highest",
  });
  expect(suggestedTeamRole(model.slug)).toMatchObject({ lead: false, worker: true });
});

it("keeps fixed user effort but allows an explicit Auto mode to override it", () => {
  const profile: TeamModelProfile = {
    id: "sol",
    label: "Sol",
    selection: {
      instanceId: ProviderInstanceId.make("codex"),
      model: "gpt-6-sol",
      options: [
        { id: "reasoningEffort", value: "high" },
        { id: "serviceTier", value: "priority" },
      ],
    },
    lead: true,
    worker: true,
  };
  expect(profileUsesAutoEffort(profile)).toBe(false);
  expect(profileUsesAutoEffort({ ...profile, effortMode: "auto" })).toBe(true);
  expect(
    selectionWithEffort(profile.selection, { optionId: "reasoningEffort", value: "medium" })
      .options,
  ).toEqual([
    { id: "serviceTier", value: "priority" },
    { id: "reasoningEffort", value: "medium" },
  ]);
  expect(modelRoutingPrior(profile.selection.model)).toMatchObject({
    costClass: "premium",
    effortStrategy: "adaptive",
  });
  expect(modelRoutingPrior("gpt-5.6-sol")).toMatchObject({
    costClass: "premium",
    effortStrategy: "adaptive",
  });
});

import { expect, it } from "@effect/vitest";
import {
  ProviderInstanceId,
  type ServerProviderModel,
  type TeamModelProfile,
} from "@dispatch/contracts";

import {
  highestSupportedEffort,
  limitDirectAutoEffort,
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

it("bounds premium direct effort by the routed task difficulty", () => {
  const profile: TeamModelProfile = {
    id: "sol",
    label: "Sol",
    selection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-6-sol" },
    lead: true,
    worker: true,
  };
  const choices = { optionId: "reasoningEffort", values: ["low", "medium", "high", "max"] };
  const selected = { optionId: "reasoningEffort", value: "max" };
  expect(limitDirectAutoEffort(profile, "routine", choices, selected)?.value).toBe("medium");
  expect(limitDirectAutoEffort(profile, "substantial", choices, selected)?.value).toBe("high");
  expect(limitDirectAutoEffort(profile, "frontier", choices, selected)?.value).toBe("max");
  expect(
    limitDirectAutoEffort(
      { ...profile, selection: { ...profile.selection, model: "gpt-6-luna" } },
      "routine",
      choices,
      selected,
    )?.value,
  ).toBe("max");
});

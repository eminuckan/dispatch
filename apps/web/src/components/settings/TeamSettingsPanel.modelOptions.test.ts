import { describe, expect, it } from "vite-plus/test";
import { ProviderInstanceId, type TeamModelProfile } from "@dispatch/contracts";

import {
  teamProfileRolesFromRecommendation,
  withTeamProfileModelOptions,
} from "./TeamSettingsPanel";

const profile: TeamModelProfile = {
  id: "luna-lead",
  label: "Luna",
  selection: {
    instanceId: ProviderInstanceId.make("codex"),
    model: "gpt-5.6-luna",
    options: [{ id: "variant", value: "high" }],
  },
  lead: true,
  worker: false,
  capability: "frontier",
};

describe("TeamSettingsPanel model options", () => {
  it("replaces provider options without changing the selected model or profile roles", () => {
    expect(
      withTeamProfileModelOptions(profile, [
        { id: "variant", value: "max" },
        { id: "fastMode", value: true },
      ]),
    ).toEqual({
      ...profile,
      selection: {
        instanceId: profile.selection.instanceId,
        model: profile.selection.model,
        options: [
          { id: "variant", value: "max" },
          { id: "fastMode", value: true },
        ],
      },
    });
  });

  it("removes only options when the provider returns no explicit selections", () => {
    expect(withTeamProfileModelOptions(profile, undefined)).toEqual({
      ...profile,
      selection: {
        instanceId: profile.selection.instanceId,
        model: profile.selection.model,
      },
    });
  });
});

describe("TeamSettingsPanel manual model roles", () => {
  it("does not grant an implicit Worker role without a recommendation", () => {
    expect(teamProfileRolesFromRecommendation(undefined)).toEqual({
      lead: false,
      worker: false,
    });
  });

  it("uses explicit recommendation roles when present", () => {
    expect(
      teamProfileRolesFromRecommendation({
        ...profile,
        lead: true,
        worker: true,
      }),
    ).toEqual({ lead: true, worker: true });
    expect(
      teamProfileRolesFromRecommendation({
        ...profile,
        lead: true,
        worker: false,
      }),
    ).toEqual({ lead: true, worker: false });
  });
});

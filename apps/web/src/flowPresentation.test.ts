import { describe, expect, it } from "vite-plus/test";
import { ProviderInstanceId, type TeamSettings } from "@dispatch/contracts";

import { flowAutoFallbackNotice, smartRoutingReasonMessage } from "./flowPresentation";

const settings: TeamSettings = {
  smartRouting: { available: false, reason: "smart_routing_session_required" },
  policy: {
    revision: 1,
    enabled: true,
    flowMode: "auto",
    profiles: [
      {
        id: "lead",
        label: "Lead",
        selection: { instanceId: ProviderInstanceId.make("codex"), model: "test" },
        lead: true,
        worker: false,
      },
    ],
    maxActive: 5,
    maxAttempts: 2,
    providerLimitBehavior: "ask",
  },
};

describe("Flow presentation", () => {
  it("turns hosted reason codes into product copy", () => {
    expect(smartRoutingReasonMessage("smart_routing_session_required")).toContain(
      "Sign in to Dispatch Connect",
    );
    expect(smartRoutingReasonMessage("smart_routing_quota_exhausted")).toContain(
      "Standard remains available",
    );
    expect(smartRoutingReasonMessage("A custom hosted message")).toBe("A custom hosted message");
  });

  it("keeps Auto selected while explaining the Standard fallback", () => {
    expect(flowAutoFallbackNotice(settings)).toContain("Auto is unavailable right now");
    expect(
      flowAutoFallbackNotice({ ...settings, smartRouting: { available: true, reason: null } }),
    ).toBe(null);
    expect(
      flowAutoFallbackNotice({ ...settings, policy: { ...settings.policy, flowMode: "standard" } }),
    ).toBe(null);
  });

  it("does not claim Standard fallback can run when Auto has only a Worker", () => {
    const workerOnly = {
      ...settings,
      policy: {
        ...settings.policy,
        profiles: settings.policy.profiles.map((profile) => ({
          ...profile,
          lead: false,
          worker: true,
        })),
      },
    } satisfies TeamSettings;

    expect(flowAutoFallbackNotice(workerOnly)).toContain("Standard fallback cannot start");
    expect(flowAutoFallbackNotice(workerOnly)).toContain("add one");
  });
});

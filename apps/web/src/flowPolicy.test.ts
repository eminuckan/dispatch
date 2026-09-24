import { describe, expect, it } from "vite-plus/test";
import { ProviderInstanceId, type TeamPolicy } from "@dispatch/contracts";

import { hasAssignedFlowModel, hasFlowLead, hasRequiredFlowRole } from "./flowPolicy";

function policy(flowMode: TeamPolicy["flowMode"], lead: boolean, worker: boolean): TeamPolicy {
  return {
    revision: 1,
    enabled: true,
    flowMode,
    profiles: [
      {
        id: "model",
        label: "Model",
        selection: { instanceId: ProviderInstanceId.make("codex"), model: "test" },
        lead,
        worker,
      },
    ],
    maxActive: 5,
    maxAttempts: 2,
    providerLimitBehavior: "ask",
  };
}

describe("Flow policy role readiness", () => {
  it("requires a Lead for Standard", () => {
    expect(hasRequiredFlowRole(policy("standard", true, false))).toBe(true);
    expect(hasRequiredFlowRole(policy("standard", false, true))).toBe(false);
  });

  it("allows Auto without role assignments when at least one model is allowed", () => {
    expect(hasRequiredFlowRole(policy("auto", false, true))).toBe(true);
    expect(hasRequiredFlowRole(policy("auto", true, false))).toBe(true);
    expect(hasRequiredFlowRole(policy("auto", false, false))).toBe(true);
    expect(hasRequiredFlowRole({ ...policy("auto", false, false), profiles: [] })).toBe(false);
  });

  it("keeps explicit Lead and assigned-model checks available for fallback presentation", () => {
    const workerOnly = policy("auto", false, true);
    expect(hasAssignedFlowModel(workerOnly)).toBe(true);
    expect(hasFlowLead(workerOnly)).toBe(false);
  });
});

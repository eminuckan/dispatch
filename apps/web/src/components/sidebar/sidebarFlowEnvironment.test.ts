import type { EnvironmentConnectionPhase } from "@dispatch/client-runtime/connection";
import { EnvironmentId } from "@dispatch/contracts";
import { describe, expect, it } from "vite-plus/test";

import { resolveSettingsScope } from "../settings/settingsScope";
import { resolveSidebarFlowEnvironment } from "./sidebarFlowEnvironment";

function environment(
  id: string,
  options: {
    phase?: EnvironmentConnectionPhase;
    teamRouting?: boolean;
    loaded?: boolean;
  } = {},
) {
  return {
    environmentId: EnvironmentId.make(id),
    label: id,
    connection: { phase: options.phase ?? "connected" },
    serverConfig: options.loaded === false ? null : { teamRouting: options.teamRouting ?? true },
  };
}

describe("sidebar Flow environment", () => {
  it("opens the connected remote environment's settings without a primary catalog entry", () => {
    const remote = environment("remote");
    const unsupported = environment("unsupported", { teamRouting: false });
    const environments = [unsupported, remote];
    const target = resolveSidebarFlowEnvironment({
      environments,
      preferredEnvironmentId: null,
      primaryEnvironmentId: null,
    });

    expect(target?.environmentId).toBe(remote.environmentId);
    const scope = resolveSettingsScope({ machine: target!.environmentId }, [], environments);
    expect(scope.kind).toBe("environment");
    expect(scope.environmentIds).toEqual([remote.environmentId]);
  });

  it("keeps Flow available when only a secondary environment supports it", () => {
    const primary = environment("primary", { teamRouting: false });
    const remote = environment("remote");
    expect(
      resolveSidebarFlowEnvironment({
        environments: [primary, remote],
        preferredEnvironmentId: primary.environmentId,
        primaryEnvironmentId: primary.environmentId,
      }),
    ).toBe(remote);
  });

  it("honors the current thread or draft environment over a capable primary", () => {
    const primary = environment("primary");
    const selected = environment("selected");
    expect(
      resolveSidebarFlowEnvironment({
        environments: [primary, selected],
        preferredEnvironmentId: selected.environmentId,
        primaryEnvironmentId: primary.environmentId,
      }),
    ).toBe(selected);
  });

  it("uses a capable primary when the route has no selected environment", () => {
    const primary = environment("primary");
    const remote = environment("remote");
    expect(
      resolveSidebarFlowEnvironment({
        environments: [remote, primary],
        preferredEnvironmentId: null,
        primaryEnvironmentId: primary.environmentId,
      }),
    ).toBe(primary);
  });

  it("replaces a stale or disconnected selection with a connected capable target", () => {
    const offline = environment("offline", { phase: "offline" });
    const remote = environment("remote");
    for (const preferredEnvironmentId of [offline.environmentId, EnvironmentId.make("removed")]) {
      expect(
        resolveSidebarFlowEnvironment({
          environments: [offline, remote],
          preferredEnvironmentId,
          primaryEnvironmentId: offline.environmentId,
        }),
      ).toBe(remote);
    }
  });

  it("does not offer settings without a connected environment advertising Flow", () => {
    const offline = environment("offline", { phase: "offline" });
    const loading = environment("loading", { loaded: false });
    const unsupported = environment("unsupported", { teamRouting: false });
    const unknown = { ...environment("unknown"), serverConfig: {} };
    expect(
      resolveSidebarFlowEnvironment({
        environments: [offline, loading, unsupported, unknown],
        preferredEnvironmentId: offline.environmentId,
        primaryEnvironmentId: loading.environmentId,
      }),
    ).toBeNull();
  });
});

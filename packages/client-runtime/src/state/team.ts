import { Atom } from "effect/unstable/reactivity";
import type { EnvironmentRegistry } from "../connection/registry.ts";
import { createEnvironmentRpcCommand, createEnvironmentRpcQueryAtomFamily } from "./runtime.ts";
export function createTeamEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  return {
    start: createEnvironmentRpcCommand(runtime, { label: "team:start", tag: "team.start" }),
    control: createEnvironmentRpcCommand(runtime, { label: "team:control", tag: "team.control" }),
    forThread: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "team:for-thread",
      tag: "team.forThread",
    }),
    get: createEnvironmentRpcQueryAtomFamily(runtime, { label: "team:get", tag: "team.get" }),
    list: createEnvironmentRpcQueryAtomFamily(runtime, { label: "team:list", tag: "team.list" }),
    settings: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "team:settings",
      tag: "team.settings",
    }),
    saveSettings: createEnvironmentRpcCommand(runtime, {
      label: "team:save-settings",
      tag: "team.saveSettings",
    }),
    setSmartRoutingSession: createEnvironmentRpcCommand(runtime, {
      label: "team:set-smart-routing-session",
      tag: "team.setSmartRoutingSession",
    }),
    recommendModels: createEnvironmentRpcCommand(runtime, {
      label: "team:recommend-models",
      tag: "team.recommendModels",
    }),
    providerDecision: createEnvironmentRpcCommand(runtime, {
      label: "team:provider-decision",
      tag: "team.providerDecision",
    }),
  };
}

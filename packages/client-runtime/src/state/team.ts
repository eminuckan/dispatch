import { Atom } from "effect/unstable/reactivity";
import type { EnvironmentRegistry } from "../connection/registry.ts";
import { createEnvironmentRpcCommand, createEnvironmentRpcQueryAtomFamily } from "./runtime.ts";
export function createTeamEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  return {
    start: createEnvironmentRpcCommand(runtime, { label: "team:start", tag: "team.start" }),
    control: createEnvironmentRpcCommand(runtime, { label: "team:control", tag: "team.control" }),
    get: createEnvironmentRpcQueryAtomFamily(runtime, { label: "team:get", tag: "team.get" }),
    list: createEnvironmentRpcQueryAtomFamily(runtime, { label: "team:list", tag: "team.list" }),
    recover: createEnvironmentRpcCommand(runtime, { label: "team:recover", tag: "team.recover" }),
    resolve: createEnvironmentRpcCommand(runtime, { label: "team:resolve", tag: "team.resolve" }),
    settings: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "team:settings",
      tag: "team.settings",
    }),
    saveSettings: createEnvironmentRpcCommand(runtime, {
      label: "team:save-settings",
      tag: "team.saveSettings",
    }),
    setSecret: createEnvironmentRpcCommand(runtime, {
      label: "team:set-secret",
      tag: "team.setSecret",
    }),
    assess: createEnvironmentRpcCommand(runtime, { label: "team:assess", tag: "team.assess" }),
  };
}

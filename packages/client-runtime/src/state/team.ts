import { Atom } from "effect/unstable/reactivity";
import type { EnvironmentRegistry } from "../connection/registry.ts";
import { createEnvironmentRpcQueryAtomFamily } from "./runtime.ts";
export function createTeamEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  return {
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
  };
}

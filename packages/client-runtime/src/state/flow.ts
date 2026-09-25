import { Atom } from "effect/unstable/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import { createEnvironmentRpcCommand, createEnvironmentRpcQueryAtomFamily } from "./runtime.ts";

export function createFlowEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  return {
    forThread: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "flow:for-thread",
      tag: "flow.forThread",
    }),
    stop: createEnvironmentRpcCommand(runtime, { label: "flow:stop", tag: "flow.stop" }),
  };
}

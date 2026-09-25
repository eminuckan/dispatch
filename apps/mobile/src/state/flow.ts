import { createFlowEnvironmentAtoms } from "@dispatch/client-runtime/state/flow";
import { connectionAtomRuntime } from "../connection/runtime";

export const flowEnvironment = createFlowEnvironmentAtoms(connectionAtomRuntime);

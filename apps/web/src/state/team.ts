import { createTeamEnvironmentAtoms } from "@t3tools/client-runtime/state/team";
import { connectionAtomRuntime } from "../connection/runtime";
export const teamEnvironment = createTeamEnvironmentAtoms(connectionAtomRuntime);

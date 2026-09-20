import { createTeamEnvironmentAtoms } from "@dispatch/client-runtime/state/team";
import { connectionAtomRuntime } from "../connection/runtime";
export const teamEnvironment = createTeamEnvironmentAtoms(connectionAtomRuntime);

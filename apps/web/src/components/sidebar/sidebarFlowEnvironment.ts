import type { EnvironmentConnectionPhase } from "@dispatch/client-runtime/connection";
import type { EnvironmentId } from "@dispatch/contracts";

interface FlowEnvironment {
  readonly environmentId: EnvironmentId;
  readonly connection: { readonly phase: EnvironmentConnectionPhase };
  readonly serverConfig: { readonly teamRouting?: boolean } | null;
}

export function resolveSidebarFlowEnvironment<T extends FlowEnvironment>({
  environments,
  preferredEnvironmentId,
  primaryEnvironmentId,
}: {
  environments: readonly T[];
  preferredEnvironmentId: EnvironmentId | null;
  primaryEnvironmentId: EnvironmentId | null;
}): T | null {
  const capable = environments.filter(
    (environment) =>
      environment.connection.phase === "connected" &&
      environment.serverConfig?.teamRouting === true,
  );
  return (
    capable.find((environment) => environment.environmentId === preferredEnvironmentId) ??
    capable.find((environment) => environment.environmentId === primaryEnvironmentId) ??
    capable[0] ??
    null
  );
}

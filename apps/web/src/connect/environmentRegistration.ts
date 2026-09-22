import { DispatchConnectControlPlaneEnvironmentId } from "@dispatch/contracts";

import {
  configureDispatchConnectEnvironment,
  fetchDispatchConnectEnvironmentIdentity,
} from "../environments/primary";
import {
  createDispatchConnectEnvironment,
  listDispatchConnectEnvironments,
  rotateDispatchConnectEnvironmentCredential,
} from "./dispatchConnect";

/**
 * Links the primary environment to the signed-in Connect account. This only
 * establishes the control-plane identity needed by hosted services. It does
 * not publish an endpoint, start a tunnel, or create a pairing grant.
 */
export async function ensurePrimaryDispatchConnectEnvironmentLinked(
  baseUrl: string,
): Promise<void> {
  const identity = await fetchDispatchConnectEnvironmentIdentity();
  const environments = await listDispatchConnectEnvironments({ baseUrl });
  const existing = environments.find((environment) => environment.publicKey === identity.publicKey);

  const registration = existing
    ? {
        environmentId: existing.id,
        credential: await rotateDispatchConnectEnvironmentCredential({
          baseUrl,
          environmentId: existing.id,
        }),
      }
    : await createDispatchConnectEnvironment({
        baseUrl,
        label: identity.label,
        publicKey: identity.publicKey,
        endpoints: [],
      }).then(({ environment, credential }) => ({
        environmentId: environment.id,
        credential,
      }));

  await configureDispatchConnectEnvironment({
    baseUrl,
    environmentId: DispatchConnectControlPlaneEnvironmentId.make(registration.environmentId),
    credential: registration.credential,
  });
}

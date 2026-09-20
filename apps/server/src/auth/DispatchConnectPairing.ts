import {
  DISPATCH_CONNECT_PAIRING_SUBJECT,
  DispatchConnectPairingId,
  DispatchConnectPairingSecret,
  buildDispatchConnectPairingUrl,
  formatDispatchConnectPairingCode,
  type DispatchConnectPairingChallenge,
  type DispatchConnectPairingCreateInput,
} from "@dispatch/contracts";
import * as Effect from "effect/Effect";

import type * as DispatchConnectEnvironment from "./DispatchConnectEnvironment.ts";
import type * as EnvironmentAuth from "./EnvironmentAuth.ts";

export const issueDispatchConnectPairingChallenge = Effect.fn(
  "DispatchConnectPairing.issueChallenge",
)(function* (input: {
  readonly environmentAuth: EnvironmentAuth.EnvironmentAuth["Service"];
  readonly dispatchConnect: DispatchConnectEnvironment.DispatchConnectEnvironment["Service"];
  readonly baseUrl: string;
  readonly pairing: DispatchConnectPairingCreateInput;
}) {
  const issued = yield* input.environmentAuth.createPairingLink({
    subject: DISPATCH_CONNECT_PAIRING_SUBJECT,
    ...(input.pairing.label ? { label: input.pairing.label } : {}),
    ...(input.pairing.scopes ? { scopes: input.pairing.scopes } : {}),
  });
  const secret = DispatchConnectPairingSecret.make(issued.credential);

  const challenge = {
    pairingId: DispatchConnectPairingId.make(issued.id),
    shortCode: formatDispatchConnectPairingCode(secret),
    pairingUrl: buildDispatchConnectPairingUrl(input.baseUrl, secret),
    expiresAt: issued.expiresAt,
  } satisfies DispatchConnectPairingChallenge;
  yield* input.dispatchConnect.registerPairing(challenge).pipe(
    Effect.catch((error) =>
      input.environmentAuth.revokePairingLink(issued.id).pipe(
        Effect.catch((cleanupCause) =>
          Effect.logWarning(
            "Failed to revoke local pairing grant after Dispatch Connect registration error",
            {
              pairingId: issued.id,
              cause: cleanupCause,
            },
          ),
        ),
        Effect.andThen(Effect.fail(error)),
      ),
    ),
  );
  return challenge;
});

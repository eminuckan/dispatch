import { expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import {
  DispatchConnectEnvironmentError,
  type DispatchConnectEnvironment,
} from "./DispatchConnectEnvironment.ts";
import type * as EnvironmentAuth from "./EnvironmentAuth.ts";
import { issueDispatchConnectPairingChallenge } from "./DispatchConnectPairing.ts";

it("uses one EnvironmentAuth pairing grant for both QR and short-code presentation", async () => {
  let receivedPairingInput: unknown;
  const createPairingLink = (input: unknown) => {
    receivedPairingInput = input;
    return Effect.succeed({
      id: "pairing-id",
      credential: "2345ABCDJKLM",
      scopes: ["orchestration:read"] as const,
      subject: "dispatch-connect-device-pairing",
      createdAt: DateTime.makeUnsafe("2026-09-20T20:00:00Z"),
      expiresAt: DateTime.makeUnsafe("2026-09-20T20:05:00Z"),
    });
  };
  const environmentAuth = {
    createPairingLink,
  } as unknown as EnvironmentAuth.EnvironmentAuth["Service"];
  const dispatchConnect = {
    registerPairing: () => Effect.succeed(false),
  } as unknown as DispatchConnectEnvironment["Service"];

  const challenge = await Effect.runPromise(
    issueDispatchConnectPairingChallenge({
      environmentAuth,
      dispatchConnect,
      baseUrl: "https://dispatch.example/environment",
      pairing: { label: "Emin's iPhone", scopes: ["orchestration:read"] },
    }),
  );

  expect(receivedPairingInput).toEqual({
    subject: "dispatch-connect-device-pairing",
    label: "Emin's iPhone",
    scopes: ["orchestration:read"],
  });
  expect(challenge.pairingId).toBe("pairing-id");
  expect(challenge.shortCode).toBe("2345-ABCD-JKLM");
  expect(challenge.pairingUrl).toBe("https://dispatch.example/pair#token=2345ABCDJKLM");
});

it("revokes the local pairing grant when configured Connect rendezvous registration fails", async () => {
  let revokedId: string | undefined;
  const environmentAuth = {
    createPairingLink: () =>
      Effect.succeed({
        id: "pairing-id",
        credential: "2345ABCDJKLM",
        scopes: ["orchestration:read"] as const,
        subject: "dispatch-connect-device-pairing",
        createdAt: DateTime.makeUnsafe("2026-09-20T20:00:00Z"),
        expiresAt: DateTime.makeUnsafe("2026-09-20T20:05:00Z"),
      }),
    revokePairingLink: (id: string) =>
      Effect.sync(() => {
        revokedId = id;
        return true;
      }),
  } as unknown as EnvironmentAuth.EnvironmentAuth["Service"];
  const dispatchConnect = {
    registerPairing: () =>
      Effect.fail(
        new DispatchConnectEnvironmentError({
          operation: "register-pairing",
          cause: new Error("Connect unavailable"),
        }),
      ),
  } as unknown as DispatchConnectEnvironment["Service"];

  const error = await Effect.runPromise(
    Effect.flip(
      issueDispatchConnectPairingChallenge({
        environmentAuth,
        dispatchConnect,
        baseUrl: "https://dispatch.example",
        pairing: {},
      }),
    ),
  );

  expect(error).toBeInstanceOf(DispatchConnectEnvironmentError);
  expect(revokedId).toBe("pairing-id");
});

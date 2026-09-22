import {
  DpopSigner,
  DpopKeyLoadError,
  DpopProofCreationError,
} from "@dispatch/client-runtime/authorization";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { createDpopProof, loadOrCreateDpopProofKeyPair } from "./dpop";

export const dpopSignerLayer = Layer.effect(
  DpopSigner,
  Effect.gen(function* () {
    const crypto = yield* Crypto.Crypto;
    const loadProofKey = yield* Effect.cached(
      loadOrCreateDpopProofKeyPair().pipe(Effect.provideService(Crypto.Crypto, crypto)),
    );
    return DpopSigner.of({
      thumbprint: loadProofKey.pipe(
        Effect.map((proofKey) => proofKey.thumbprint),
        Effect.mapError(
          (error) =>
            new DpopKeyLoadError({
              keyStore: "expo-secure-store",
              cause: error,
            }),
        ),
        Effect.withSpan("mobile.dpopSigner.loadThumbprint"),
      ),
      createProof: Effect.fn("mobile.dpopSigner.createProof")(function* (input) {
        const proofKey = yield* loadProofKey.pipe(
          Effect.mapError(
            (error) =>
              new DpopProofCreationError({
                method: input.method,
                url: input.url,
                cause: error,
              }),
          ),
        );
        return yield* createDpopProof({ ...input, proofKey }).pipe(
          Effect.provideService(Crypto.Crypto, crypto),
          Effect.map((proof) => proof.proof),
          Effect.mapError(
            (error) =>
              new DpopProofCreationError({
                method: input.method,
                url: input.url,
                cause: error,
              }),
          ),
        );
      }),
    });
  }),
);

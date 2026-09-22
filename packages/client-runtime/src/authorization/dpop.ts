import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type * as HttpMethod from "effect/unstable/http/HttpMethod";

export interface DpopProofInput {
  readonly method: HttpMethod.HttpMethod;
  readonly url: string;
  readonly accessToken?: string;
}

export class DpopKeyLoadError extends Schema.TaggedError<DpopKeyLoadError>()("DpopKeyLoadError", {
  keyStore: Schema.Literals(["expo-secure-store", "indexed-db"]),
  cause: Schema.Defect(),
}) {
  override get message(): string {
    return "Could not load DPoP proof key.";
  }
}

export class DpopProofCreationError extends Schema.TaggedError<DpopProofCreationError>()(
  "DpopProofCreationError",
  {
    method: Schema.String,
    url: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Could not create the DPoP proof for ${this.method} ${this.url}.`;
  }
}

export const DpopSignerError = Schema.Union([DpopKeyLoadError, DpopProofCreationError]);
export type DpopSignerError = typeof DpopSignerError.Type;

export class DpopSigner extends Context.Service<
  DpopSigner,
  {
    readonly thumbprint: Effect.Effect<string, DpopKeyLoadError>;
    readonly createProof: (input: DpopProofInput) => Effect.Effect<string, DpopProofCreationError>;
  }
>()("@dispatch/client-runtime/authorization/dpop/DpopSigner") {}

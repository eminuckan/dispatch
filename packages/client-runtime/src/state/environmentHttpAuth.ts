import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { FetchHttpClient, type HttpMethod } from "effect/unstable/http";

import { legacyRelayConnectionError } from "../connection/errors.ts";
import type { PreparedConnection, PreparedHttpAuthorization } from "../connection/model.ts";
import type { DpopSigner } from "../authorization/dpop.ts";
import {
  executeEnvironmentHttpRequest,
  makeEnvironmentHttpApiGroupClient,
  RemoteEnvironmentAuthFetchError,
  RemoteEnvironmentAuthTimeoutError,
  type RemoteEnvironmentRequestError,
} from "../rpc/http.ts";

export interface EnvironmentHttpAuthHeaders {
  readonly authorization?: string;
  readonly dpop?: string;
}

/**
 * Primary/local environments with no bearer or DPoP credential authenticate the
 * browser via a session cookie. A cross-origin `fetch` does not send cookies by
 * default, so those requests must opt into credentialed mode; bearer/DPoP
 * connections carry their credential in a header and need no cookies. Applied
 * per-request via `FetchHttpClient.RequestInit`, which the fetch client reads
 * from the fiber context at request time.
 */
const withEnvironmentCredentials = <A, E, R>(
  authorization: PreparedHttpAuthorization | null,
  request: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  authorization === null
    ? request.pipe(Effect.provideService(FetchHttpClient.RequestInit, { credentials: "include" }))
    : request;

/**
 * Build request-bound headers from the current environment credential:
 * - primary/local connections carry no credential,
 * - bearer connections send a static `Bearer` token,
 * - DPoP connections send a `DPoP` access token with a freshly signed proof
 *   bound to this request's method and URL.
 *
 * The DPoP signer is passed in (not resolved from context) and is only required
 * for DPoP connections, so bearer/primary connections work even when no
 * signer is available.
 */
const buildEnvironmentAuthHeaders = (
  authorization: PreparedHttpAuthorization | null,
  method: HttpMethod.HttpMethod,
  url: string,
  signer: Option.Option<DpopSigner["Service"]>,
): Effect.Effect<EnvironmentHttpAuthHeaders, RemoteEnvironmentAuthFetchError> =>
  Effect.gen(function* () {
    if (authorization === null) {
      return {};
    }
    if (authorization._tag === "Bearer") {
      return { authorization: `Bearer ${authorization.token}` };
    }
    if (Option.isNone(signer)) {
      return yield* new RemoteEnvironmentAuthFetchError({
        message: "No DPoP signer is available to authorize the environment request.",
        cause: authorization._tag,
      });
    }
    const proof = yield* signer.value
      .createProof({ method, url, accessToken: authorization.accessToken })
      .pipe(
        Effect.mapError(
          (cause) =>
            new RemoteEnvironmentAuthFetchError({
              message: "Could not create the environment request authorization proof.",
              cause,
            }),
        ),
      );
    return { authorization: `DPoP ${authorization.accessToken}`, dpop: proof };
  });

/** Sign each request with its prepared environment credential. */
export const executeAuthenticatedEnvironmentHttpRequest = Effect.fn(
  "clientRuntime.state.executeAuthenticatedEnvironmentHttpRequest",
)(function* <
  Group extends Parameters<typeof makeEnvironmentHttpApiGroupClient>[1],
  A,
  E,
  R,
>(input: {
  readonly prepared: PreparedConnection;
  readonly signer: Option.Option<DpopSigner["Service"]>;
  readonly method: HttpMethod.HttpMethod;
  readonly url: (httpBaseUrl: string) => string;
  readonly timeoutMs: number;
  readonly group: Group;
  readonly request: (input: {
    readonly client: Effect.Success<ReturnType<typeof makeEnvironmentHttpApiGroupClient<Group>>>;
    readonly headers: EnvironmentHttpAuthHeaders;
  }) => Effect.Effect<A, E, R>;
  /** Some endpoints report rejected credentials in a successful response. */
  readonly isUnauthorizedResponse?: (response: NoInfer<A>) => boolean;
}): Effect.fn.Return<
  A,
  RemoteEnvironmentRequestError,
  Effect.Services<ReturnType<typeof makeEnvironmentHttpApiGroupClient<Group>>> | R
> {
  const httpBaseUrl = input.prepared.httpBaseUrl;
  if (input.prepared.target._tag === "RelayConnectionTarget") {
    return yield* new RemoteEnvironmentAuthFetchError({
      message: legacyRelayConnectionError().message,
      cause: input.prepared.target._tag,
    });
  }
  return yield* Effect.gen(function* () {
    const authorization = input.prepared.httpAuthorization;
    const requestUrl = input.url(httpBaseUrl);
    const client = yield* makeEnvironmentHttpApiGroupClient(httpBaseUrl, input.group);
    const headers = yield* buildEnvironmentAuthHeaders(
      authorization,
      input.method,
      requestUrl,
      input.signer,
    );
    const result = yield* executeEnvironmentHttpRequest(
      requestUrl,
      input.timeoutMs,
      withEnvironmentCredentials(authorization, input.request({ client, headers })),
    );
    if (authorization?._tag === "Dpop" && input.isUnauthorizedResponse?.(result) === true) {
      return yield* new RemoteEnvironmentAuthFetchError({
        message: "The environment rejected the session authorization. Pair again to reconnect.",
        cause: result,
      });
    }
    return result;
  }).pipe(
    Effect.timeoutOrElse({
      duration: input.timeoutMs,
      orElse: () =>
        Effect.fail(new RemoteEnvironmentAuthTimeoutError(input.url(httpBaseUrl), input.timeoutMs)),
    }),
  );
});

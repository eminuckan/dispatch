import { describe, expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type AuthSessionState,
  type OrchestrationShellSnapshot,
  type OrchestrationThreadDetailSnapshot,
} from "@dispatch/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import { TestClock } from "effect/testing";
import type { HttpClient } from "effect/unstable/http";

import {
  BearerConnectionTarget,
  RelayConnectionTarget,
  type PreparedConnection,
  type PreparedHttpAuthorization,
} from "../connection/model.ts";
import { DpopSigner, type DpopProofInput } from "../authorization/dpop.ts";
import { remoteHttpClientLayer, type RemoteEnvironmentRequestError } from "../rpc/http.ts";
import {
  fetchEnvironmentPullRequestDiff,
  type PullRequestDiffCredentialRejectedError,
} from "./pullRequestDiffHttp.ts";
import { fetchEnvironmentSessionState } from "./session.ts";
import { fetchEnvironmentShellSnapshot } from "./shellSnapshotHttp.ts";
import { fetchEnvironmentThreadSnapshot } from "./threadSnapshotHttp.ts";

const TARGET = new BearerConnectionTarget({
  connectionId: "connection-1",
  environmentId: EnvironmentId.make("environment-1"),
  label: "Remote environment",
});
const PREPARED: PreparedConnection = {
  environmentId: TARGET.environmentId,
  label: TARGET.label,
  httpBaseUrl: "https://current.example.test",
  socketUrl: "wss://current.example.test/ws",
  httpAuthorization: {
    _tag: "Dpop",
    accessToken: "current-token",
    expiresAtEpochMs: Number.MAX_SAFE_INTEGER,
  },
  target: TARGET,
};
const CURRENT_ORIGIN = "https://current.example.test";
const DIFF = {
  projectId: ProjectId.make("project-1"),
  repository: "owner/repository",
  number: 42,
};
const DIFF_RESULT = { patch: "diff --git a/file.ts b/file.ts", truncated: false, nextCursor: null };
const AUTH = {
  policy: "remote-reachable",
  bootstrapMethods: ["one-time-token"],
  sessionMethods: ["dpop-access-token"],
  sessionCookieName: "t3_session",
} satisfies AuthSessionState["auth"];
const SESSION = {
  authenticated: true,
  auth: AUTH,
  scopes: ["orchestration:read", "orchestration:operate"],
  sessionMethod: "dpop-access-token",
} satisfies AuthSessionState;
const UNAUTHENTICATED_SESSION = { authenticated: false, auth: AUTH } satisfies AuthSessionState;
const SHELL = {
  snapshotSequence: 1,
  projects: [],
  threads: [],
  updatedAt: "2026-09-04T00:00:00.000Z",
} satisfies OrchestrationShellSnapshot;
const THREAD = {
  snapshotSequence: 2,
  thread: {
    id: ThreadId.make("thread-1"),
    projectId: ProjectId.make("project-1"),
    title: "Thread",
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    pullRequests: [],
    worktreePath: null,
    latestTurn: null,
    createdAt: "2026-09-04T00:00:00.000Z",
    updatedAt: "2026-09-04T00:00:00.000Z",
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    deletedAt: null,
    messages: [],
    proposedPlans: [],
    activities: [],
    checkpoints: [],
    session: null,
  },
  page: { beforeCursor: null, hasMore: false, snapshotSequence: 2 },
} satisfies OrchestrationThreadDetailSnapshot;

function credentialRejectedResponse(reason = "invalid_credential") {
  return Response.json(
    {
      _tag: "EnvironmentAuthInvalidError",
      code: "auth_invalid",
      reason,
      traceId: "trace-rejected",
    },
    { status: 401 },
  );
}

function makeHarness(reply: (requestNumber: number) => Response | Promise<Response>) {
  const calls: Array<{ readonly url: string; readonly init: RequestInit }> = [];
  const proofs: Array<DpopProofInput> = [];
  const signer = DpopSigner.of({
    thumbprint: Effect.succeed("test-thumbprint"),
    createProof: (input) =>
      Effect.sync(() => {
        proofs.push(input);
        return `proof-${proofs.length}`;
      }),
  });
  const fetchFn: typeof fetch = async (request, init) => {
    calls.push({ url: String(request), init: init ?? {} });
    return reply(calls.length);
  };
  return {
    calls,
    proofs,
    input: {
      prepared: PREPARED,
      signer: Option.some(signer),
    },
    httpLayer: remoteHttpClientLayer(fetchFn),
  };
}

type HttpInput = ReturnType<typeof makeHarness>["input"];
const LOADERS: ReadonlyArray<{
  readonly name: string;
  readonly method: string;
  readonly path: string;
  readonly response: unknown;
  readonly load: (
    input: HttpInput,
  ) => Effect.Effect<
    unknown,
    RemoteEnvironmentRequestError | PullRequestDiffCredentialRejectedError,
    HttpClient.HttpClient
  >;
}> = [
  {
    name: "PR diff",
    method: "POST",
    path: "/api/pull-requests/diff",
    response: DIFF_RESULT,
    load: (input: HttpInput) => fetchEnvironmentPullRequestDiff({ ...input, diff: DIFF }),
  },
  {
    name: "session permissions",
    method: "GET",
    path: "/api/auth/session",
    response: SESSION,
    load: fetchEnvironmentSessionState,
  },
  {
    name: "shell snapshot",
    method: "GET",
    path: "/api/orchestration/shell",
    response: SHELL,
    load: fetchEnvironmentShellSnapshot,
  },
  {
    name: "older thread history",
    method: "GET",
    path: "/api/orchestration/threads/thread-1",
    response: THREAD,
    load: (input: HttpInput) =>
      fetchEnvironmentThreadSnapshot({
        ...input,
        threadId: THREAD.thread.id,
        window: { turnLimit: 20, beforeCursor: "older-page" },
        reasoningMessages: true,
      }),
  },
];

describe("authenticated environment HTTP requests", () => {
  it.effect.each(LOADERS)("rejects an invalid $name response", (loader) =>
    Effect.gen(function* () {
      const harness = makeHarness(() => Response.json({}));
      const result = yield* loader
        .load(harness.input)
        .pipe(Effect.provide(harness.httpLayer), Effect.asVoid, Effect.flip);
      expect(result._tag).toBe("RemoteEnvironmentAuthInvalidJsonError");
      expect(harness.calls).toHaveLength(1);
    }),
  );

  it.effect.each([
    {
      name: "insufficient scope",
      reply: () =>
        Response.json(
          {
            _tag: "EnvironmentScopeRequiredError",
            code: "insufficient_scope",
            requiredScope: "orchestration:read",
            traceId: "trace-scope",
          },
          { status: 403 },
        ),
      errorTag: "EnvironmentScopeRequiredError",
    },
    {
      name: "missing credential",
      reply: () => credentialRejectedResponse("missing_credential"),
      errorTag: "EnvironmentAuthInvalidError",
    },
    {
      name: "Cloudflare 530",
      reply: () => new Response("error code: 1033", { status: 530 }),
      errorTag: "RemoteEnvironmentAuthUndeclaredStatusError",
    },
    {
      name: "network failure",
      reply: () => Promise.reject(new Error("Network unreachable")),
      errorTag: "RemoteEnvironmentAuthFetchError",
    },
  ])("preserves $name without retrying", ({ reply, errorTag }) =>
    Effect.gen(function* () {
      const harness = makeHarness(reply);
      const error = yield* fetchEnvironmentPullRequestDiff({ ...harness.input, diff: DIFF }).pipe(
        Effect.provide(harness.httpLayer),
        Effect.flip,
      );

      expect(error._tag).toBe(errorTag);
      expect(harness.calls).toHaveLength(1);
    }),
  );

  it.effect.each([
    { name: "cookie", authorization: null },
    { name: "bearer", authorization: { _tag: "Bearer", token: "bearer-token" } },
  ] satisfies ReadonlyArray<{ name: string; authorization: PreparedHttpAuthorization | null }>)(
    "leaves $name sessions unchanged without a DPoP signer",
    ({ authorization }) =>
      Effect.gen(function* () {
        const harness = makeHarness(() => Response.json(UNAUTHENTICATED_SESSION));
        const result = yield* fetchEnvironmentSessionState({
          prepared: { ...PREPARED, httpAuthorization: authorization },
          signer: Option.none(),
        }).pipe(Effect.provide(harness.httpLayer));

        expect(result).toEqual(UNAUTHENTICATED_SESSION);
        expect(harness.calls).toHaveLength(1);
        expect(new Headers(harness.calls[0]!.init.headers).get("authorization")).toBe(
          authorization === null ? null : "Bearer bearer-token",
        );
        expect(harness.calls[0]!.init.credentials).toBe(
          authorization === null ? "include" : undefined,
        );
      }),
  );

  it.effect.each(LOADERS)("signs $name using its exact method, URL, and prepared token", (loader) =>
    Effect.gen(function* () {
      const harness = makeHarness(() => Response.json(loader.response));
      const result = yield* loader.load(harness.input).pipe(Effect.provide(harness.httpLayer));
      expect(result).toEqual(loader.response);
      expect(harness.calls).toHaveLength(1);
      expect(harness.proofs).toEqual([
        {
          method: loader.method,
          url: `${CURRENT_ORIGIN}${loader.path}`,
          accessToken: "current-token",
        },
      ]);
      expect(harness.calls[0]!.url).toContain(`${CURRENT_ORIGIN}${loader.path}`);
      const headers = new Headers(harness.calls[0]!.init.headers);
      expect(headers.get("authorization")).toBe("DPoP current-token");
      expect(headers.get("dpop")).toBe("proof-1");
    }),
  );

  it.effect("retains the original credential rejection without trying legacy renewal", () =>
    Effect.gen(function* () {
      const harness = makeHarness(() => credentialRejectedResponse());
      const error = yield* fetchEnvironmentPullRequestDiff({ ...harness.input, diff: DIFF }).pipe(
        Effect.provide(harness.httpLayer),
        Effect.flip,
      );
      expect(error).toMatchObject({
        _tag: "PullRequestDiffCredentialRejectedError",
        traceId: "trace-rejected",
      });
      expect(harness.calls).toHaveLength(1);
    }),
  );

  it.effect("fails closed for a saved relay target before signing or fetching", () =>
    Effect.gen(function* () {
      const harness = makeHarness(() => Response.json(SESSION));
      const error = yield* fetchEnvironmentSessionState({
        ...harness.input,
        prepared: {
          ...PREPARED,
          target: new RelayConnectionTarget({
            environmentId: TARGET.environmentId,
            label: TARGET.label,
          }),
        },
      }).pipe(Effect.provide(harness.httpLayer), Effect.flip);
      expect(error.message).toContain("Pair again using Dispatch Connect or direct pairing");
      expect(harness.proofs).toEqual([]);
      expect(harness.calls).toEqual([]);
    }),
  );

  it.effect("requires a signer for DPoP requests", () =>
    Effect.gen(function* () {
      const harness = makeHarness(() => Response.json(SESSION));
      const error = yield* fetchEnvironmentSessionState({
        ...harness.input,
        signer: Option.none(),
      }).pipe(Effect.provide(harness.httpLayer), Effect.flip);
      expect(error.message).toContain("No DPoP signer");
      expect(harness.calls).toEqual([]);
    }),
  );

  it.effect("rejects an unauthenticated DPoP session response without hiding the failure", () =>
    Effect.gen(function* () {
      const harness = makeHarness(() => Response.json(UNAUTHENTICATED_SESSION));
      const error = yield* fetchEnvironmentSessionState(harness.input).pipe(
        Effect.provide(harness.httpLayer),
        Effect.flip,
      );
      expect(error.message).toContain("Pair again to reconnect");
      expect(harness.calls).toHaveLength(1);
    }),
  );

  it.effect("enforces the total request timeout while the signer is stalled", () =>
    Effect.gen(function* () {
      const harness = makeHarness(() => Response.json(SESSION));
      const started = yield* Deferred.make<void>();
      const fiber = yield* fetchEnvironmentSessionState({
        prepared: PREPARED,
        signer: Option.some(
          DpopSigner.of({
            thumbprint: Effect.succeed("key"),
            createProof: () =>
              Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never)),
          }),
        ),
        timeoutMs: 1000,
      }).pipe(Effect.provide(harness.httpLayer), Effect.flip, Effect.forkChild);
      yield* Deferred.await(started);
      yield* TestClock.adjust("1 second");
      expect(yield* Fiber.join(fiber)).toMatchObject({ _tag: "RemoteEnvironmentAuthTimeoutError" });
      expect(harness.calls).toEqual([]);
    }).pipe(Effect.provide(TestClock.layer())),
  );
});

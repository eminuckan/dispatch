// @effect-diagnostics nodeBuiltinImport:off cryptoRandomUUIDInEffect:off - Hosted request IDs need cryptographic UUIDs and this server module is Node-only.
import * as NodeCrypto from "node:crypto";

import {
  TeamError,
  TeamCapability,
  TeamExecutionMode,
  type TeamModelProfile,
  type TeamSmartRoutingSessionUpdate,
  type TeamSmartRoutingStatus,
} from "@dispatch/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import {
  FetchHttpClient,
  HttpClient,
  HttpClientRequest,
  HttpClientResponse,
} from "effect/unstable/http";

import {
  DISPATCH_CONNECT_SMART_ROUTING_SESSION_SECRET,
  readDispatchConnectEnvironmentConnection,
} from "../auth/DispatchConnectEnvironment.ts";
import { ServerSecretStore } from "../auth/ServerSecretStore.ts";

const MAX_REQUEST_BYTES = 24_000;
const LEGACY_JEV_SECRET = "team-jev-api-key";
const PersistedSmartRoutingSession = Schema.Struct({
  version: Schema.Literal(1),
  origin: Schema.String.check(Schema.isMaxLength(2_048)),
  accountToken: Schema.String.check(Schema.isMaxLength(4_096)),
});
type PersistedSmartRoutingSession = typeof PersistedSmartRoutingSession.Type;
const PersistedSmartRoutingSessionJson = Schema.fromJsonString(PersistedSmartRoutingSession);
const encodeSmartRoutingSession = Schema.encodeEffect(PersistedSmartRoutingSessionJson);
const decodeSmartRoutingSession = Schema.decodeUnknownEffect(PersistedSmartRoutingSessionJson);
const Probability = Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: 1 }));
const DecisionFields = {
  source: Schema.Literals(["jev", "policy"]),
  confidence: Probability,
  reason: Schema.String.check(Schema.isMaxLength(1_000)),
};
const ModeDecision = Schema.Struct({ mode: TeamExecutionMode, ...DecisionFields });
const ProfileDecision = Schema.Struct({ profileId: Schema.String, ...DecisionFields });
const Recommendations = Schema.Struct({
  profiles: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      lead: Schema.Boolean,
      worker: Schema.Boolean,
      capability: TeamCapability,
    }),
  ).check(Schema.isMaxLength(40)),
});
const Capability = Schema.Struct({
  available: Schema.Boolean,
  reason: Schema.NullOr(Schema.String),
});
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const decodeJson = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder("utf-8", { fatal: true });

function trustedConnectOrigin(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.username || url.password) return null;
    if (url.protocol === "https:") return url.origin;
    if (
      url.protocol === "http:" &&
      ["localhost", "127.0.0.1", "[::1]", "::1"].includes(url.hostname)
    )
      return url.origin;
    return null;
  } catch {
    return null;
  }
}

export type OrchestrationAdvisorSource = "jev" | "policy";
export interface OrchestrationAdvisorDecision {
  readonly profileId: string;
  readonly source: OrchestrationAdvisorSource;
  readonly confidence: number;
  readonly reason: string;
}
export interface OrchestrationExecutionModeDecision {
  readonly mode: TeamExecutionMode;
  readonly source: OrchestrationAdvisorSource;
  readonly confidence: number;
  readonly reason: string;
}

function candidateState(profile: TeamModelProfile) {
  return {
    id: profile.id,
    label: profile.label,
    providerInstanceId: profile.selection.instanceId,
    model: profile.selection.model,
    capability: profile.capability ?? null,
    options: profile.selection.options ?? [],
  };
}

function responseError(value: unknown): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const error = (value as Record<string, unknown>).error;
  return typeof error === "string" && error.length <= 256 ? error : null;
}

const boundedResponseJson = Effect.fnUntraced(function* (
  response: HttpClientResponse.HttpClientResponse,
) {
  const collected = yield* Stream.runFoldEffect(
    response.stream,
    () => ({ chunks: [] as Uint8Array[], size: 0 }),
    (state, chunk) => {
      const size = state.size + chunk.byteLength;
      if (size > MAX_REQUEST_BYTES) return Effect.fail("smart_routing_response_too_large" as const);
      return Effect.succeed({ chunks: [...state.chunks, Uint8Array.from(chunk)], size });
    },
  );
  const bytes = new Uint8Array(collected.size);
  let offset = 0;
  for (const chunk of collected.chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const text = yield* Effect.try({
    try: () => textDecoder.decode(bytes),
    catch: () => "smart_routing_invalid_response" as const,
  });
  return yield* decodeJson(text);
});

export const make = Effect.gen(function* () {
  const secrets = yield* ServerSecretStore;
  const http = yield* HttpClient.HttpClient;
  // The old user-funded advisor key is no longer part of Dispatch Flow. Best-effort cleanup
  // keeps stale installs from retaining a credential that can never be used again.
  yield* secrets.remove(LEGACY_JEV_SECRET).pipe(Effect.ignore);

  const sessionPersistenceError = () =>
    new TeamError({
      code: "persistence",
      message: "Could not update the Smart Routing account session.",
    });

  const clearInvalidSession = secrets
    .remove(DISPATCH_CONNECT_SMART_ROUTING_SESSION_SECRET)
    .pipe(Effect.ignore);

  const readSmartRoutingSession = Effect.fnUntraced(function* () {
    const bytes = yield* secrets
      .get(DISPATCH_CONNECT_SMART_ROUTING_SESSION_SECRET)
      .pipe(Effect.orElseSucceed(() => Option.none()));
    if (Option.isNone(bytes)) return Option.none<PersistedSmartRoutingSession>();
    const text = yield* Effect.try({
      try: () => textDecoder.decode(bytes.value),
      catch: () => "invalid-smart-routing-session" as const,
    }).pipe(Effect.option);
    if (Option.isNone(text)) {
      yield* clearInvalidSession;
      return Option.none<PersistedSmartRoutingSession>();
    }
    const decoded = yield* decodeSmartRoutingSession(text.value).pipe(Effect.option);
    if (Option.isNone(decoded)) {
      yield* clearInvalidSession;
      return Option.none<PersistedSmartRoutingSession>();
    }
    return decoded;
  });

  const setSmartRoutingSession = Effect.fnUntraced(
    function* (input: TeamSmartRoutingSessionUpdate) {
      if (input.accountToken === null) {
        yield* secrets.remove(DISPATCH_CONNECT_SMART_ROUTING_SESSION_SECRET);
        return;
      }
      const accountToken = input.accountToken.trim();
      if (!accountToken || accountToken.length > 4_096 || input.baseUrl === null)
        return yield* new TeamError({
          code: "invalid",
          message: "A valid Dispatch Connect session is required for Flow Auto.",
        });
      const origin = trustedConnectOrigin(input.baseUrl);
      if (!origin)
        return yield* new TeamError({
          code: "invalid",
          message: "Flow Auto requires a trusted Dispatch Connect origin.",
        });
      const configured = yield* readDispatchConnectEnvironmentConnection(secrets).pipe(
        Effect.orElseSucceed(() => Option.none()),
      );
      if (Option.isNone(configured))
        return yield* new TeamError({
          code: "invalid",
          message: "Link this environment to Dispatch Connect before enabling Flow Auto.",
        });
      const configuredOrigin = trustedConnectOrigin(configured.value.connection.baseUrl);
      if (!configuredOrigin || configuredOrigin !== origin)
        return yield* new TeamError({
          code: "invalid",
          message: "This Dispatch Connect session belongs to a different Connect origin.",
        });
      const encoded = yield* encodeSmartRoutingSession({ version: 1, origin, accountToken });
      yield* secrets.set(
        DISPATCH_CONNECT_SMART_ROUTING_SESSION_SECRET,
        textEncoder.encode(encoded),
      );
    },
    Effect.mapError((error) => (Schema.is(TeamError)(error) ? error : sessionPersistenceError())),
  );

  const routingContext = Effect.gen(function* () {
    const configured = yield* readDispatchConnectEnvironmentConnection(secrets).pipe(
      Effect.orElseSucceed(() => Option.none()),
    );
    if (Option.isNone(configured))
      return { ready: false, reason: "smart_routing_environment_required" } as const;
    const configuredOrigin = trustedConnectOrigin(configured.value.connection.baseUrl);
    if (!configuredOrigin) {
      yield* clearInvalidSession;
      return { ready: false, reason: "smart_routing_environment_required" } as const;
    }
    const accountSession = yield* readSmartRoutingSession();
    if (Option.isNone(accountSession))
      return { ready: false, reason: "smart_routing_session_required" } as const;
    if (accountSession.value.origin !== configuredOrigin) {
      yield* clearInvalidSession;
      return { ready: false, reason: "smart_routing_environment_required" } as const;
    }
    return {
      ready: true,
      reason: null,
      connection: configured.value.connection,
      credential: configured.value.credential,
      accountToken: accountSession.value.accountToken,
    } as const;
  });

  const localPrerequisites = routingContext.pipe(
    Effect.map((context) => ({ ready: context.ready, reason: context.reason })),
  );

  const request = Effect.fnUntraced(function* (
    operation: "capability" | "execution" | "profile" | "recommendations",
    body?: Record<string, unknown>,
  ) {
    const context = yield* routingContext;
    if (!context.ready) return { status: 401, value: null, reason: context.reason };
    const { connection, credential, accountToken } = context;
    const requestId = NodeCrypto.randomUUID();
    const encoded = operation === "capability" ? null : encodeJson({ requestId, ...body });
    if (encoded && textEncoder.encode(encoded).byteLength > MAX_REQUEST_BYTES)
      return { status: 413, value: null, reason: "smart_routing_payload_too_large" };
    const endpoint = `${connection.baseUrl.replace(/\/$/, "")}/v1/environments/${encodeURIComponent(connection.environmentId)}/smart-routing/${operation}`;
    const baseRequest =
      operation === "capability"
        ? HttpClientRequest.get(endpoint)
        : HttpClientRequest.post(endpoint);
    const payload = baseRequest.pipe(
      HttpClientRequest.setHeader("Authorization", `Bearer ${credential}`),
      HttpClientRequest.setHeader("x-dispatch-connect-session", accountToken),
      HttpClientRequest.setHeader("accept", "application/json"),
    );
    const result = yield* http
      .execute(
        encoded === null
          ? payload
          : payload.pipe(HttpClientRequest.bodyText(encoded, "application/json")),
      )
      .pipe(
        Effect.flatMap((response) => {
          return boundedResponseJson(response).pipe(
            Effect.map((value) => ({
              status: response.status,
              value,
              reason: response.status === 200 ? null : responseError(value),
            })),
            Effect.orElseSucceed(() => ({
              status: response.status === 200 ? 503 : response.status,
              value: null,
              reason: "smart_routing_invalid_response",
            })),
          );
        }),
        Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }),
        Effect.timeout("5 seconds"),
        Effect.orElseSucceed(() => ({
          status: 503,
          value: null,
          reason: "smart_routing_unavailable",
        })),
      );
    if (result.status === 401) yield* clearInvalidSession;
    return result;
  });

  const status: Effect.Effect<TeamSmartRoutingStatus> = Effect.gen(function* () {
    const result = yield* request("capability");
    const capability = yield* Schema.decodeUnknownEffect(Capability)(result.value).pipe(
      Effect.option,
    );
    if (result.status === 200 && Option.isSome(capability)) return capability.value;
    return { available: false, reason: result.reason ?? "smart_routing_unavailable" };
  });
  const configured = status.pipe(Effect.map((value) => value.available));

  const routeExecution = Effect.fnUntraced(function* (input: {
    readonly objective: string;
    readonly workers: ReadonlyArray<TeamModelProfile>;
  }): Effect.fn.Return<OrchestrationExecutionModeDecision> {
    const fallback: OrchestrationExecutionModeDecision = {
      mode: "orchestrated",
      source: "policy",
      confidence: 1,
      reason: "Using Flow Standard with your selected Lead and Worker models.",
    };
    if (input.workers.length === 0) return fallback;
    const result = yield* request("execution", {
      objective: input.objective,
      candidates: input.workers.map(candidateState),
    });
    const decision = yield* Schema.decodeUnknownEffect(ModeDecision)(result.value).pipe(
      Effect.option,
    );
    return result.status === 200 &&
      Option.isSome(decision) &&
      decision.value.source === "jev" &&
      decision.value.confidence >= 0.8
      ? decision.value
      : fallback;
  });

  const chooseProfile = Effect.fnUntraced(function* (input: {
    readonly purpose: "lead" | "worker" | "failover" | "review";
    readonly objective: string;
    readonly candidates: ReadonlyArray<TeamModelProfile>;
    readonly preferredProfileId?: string | null;
    readonly context?: unknown;
  }): Effect.fn.Return<OrchestrationAdvisorDecision> {
    const preferred =
      input.candidates.find((profile) => profile.id === input.preferredProfileId) ??
      input.candidates[0];
    if (!preferred) return yield* Effect.die("chooseProfile requires at least one candidate");
    const fallback: OrchestrationAdvisorDecision = {
      profileId: preferred.id,
      source: "policy",
      confidence: 1,
      reason: "Selected from your saved Flow model order.",
    };
    if (input.candidates.length === 1) return fallback;
    const context =
      input.context && typeof input.context === "object"
        ? (input.context as Record<string, unknown>)
        : null;
    const result = yield* request("profile", {
      purpose: input.purpose,
      objective: input.objective,
      candidates: input.candidates.map(candidateState),
      preferredProfileId: input.preferredProfileId ?? null,
      ...(context
        ? {
            context: {
              ...(typeof context.failedModel === "string"
                ? { failedModel: context.failedModel }
                : {}),
              ...(typeof context.role === "string" ? { role: context.role } : {}),
            },
          }
        : {}),
    });
    const decision = yield* Schema.decodeUnknownEffect(ProfileDecision)(result.value).pipe(
      Effect.option,
    );
    return result.status === 200 &&
      Option.isSome(decision) &&
      decision.value.source === "jev" &&
      decision.value.confidence >= 0.75 &&
      input.candidates.some((profile) => profile.id === decision.value.profileId)
      ? decision.value
      : fallback;
  });

  const recommendProfiles = Effect.fnUntraced(function* (
    profiles: ReadonlyArray<TeamModelProfile>,
  ): Effect.fn.Return<ReadonlyArray<TeamModelProfile>> {
    const pending = profiles.filter((profile) => !profile.lead && !profile.worker);
    const recommended = new Map<string, TeamModelProfile>();
    // Keep complete server-expanded questions inside the hosted 24 KB budget, including
    // the largest permitted candidate metadata. Each batch consumes one sponsored call.
    for (let offset = 0; offset < pending.length; offset += 4) {
      const batch = pending.slice(offset, offset + 4);
      const result = yield* request("recommendations", { candidates: batch.map(candidateState) });
      const response = yield* Schema.decodeUnknownEffect(Recommendations)(result.value).pipe(
        Effect.option,
      );
      if (result.status !== 200 || Option.isNone(response)) break;
      for (const recommendation of response.value.profiles) {
        const original = batch.find((profile) => profile.id === recommendation.id);
        if (original) recommended.set(original.id, { ...original, ...recommendation });
      }
    }
    return profiles.map((profile) => recommended.get(profile.id) ?? profile);
  });

  return {
    configured,
    status,
    localPrerequisites,
    setSmartRoutingSession,
    chooseProfile,
    routeExecution,
    recommendProfiles,
  };
});

export class OrchestrationAdvisor extends Context.Service<
  OrchestrationAdvisor,
  Effect.Success<typeof make>
>()("dispatch/team/OrchestrationAdvisor") {}

export const layer = Layer.effect(OrchestrationAdvisor, make);

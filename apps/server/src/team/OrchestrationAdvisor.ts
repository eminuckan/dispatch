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
import { highestSupportedEffort, modelRoutingPrior } from "./ModelRoutingCatalog.ts";

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
const isTeamError = Schema.is(TeamError);
const Probability = Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: 1 }));
const DecisionFields = {
  source: Schema.Literals(["jev", "policy"]),
  confidence: Probability,
  reason: Schema.String.check(Schema.isMaxLength(1_000)),
};
const ModeDecision = Schema.Struct({
  mode: TeamExecutionMode,
  difficulty: Schema.optional(Schema.Literals(["routine", "substantial", "frontier"])),
  workload: Schema.optional(Schema.Literals(["short", "medium", "long"])),
  ...DecisionFields,
});
const ProfileDecision = Schema.Struct({ profileId: Schema.String, ...DecisionFields });
const EffortDecision = Schema.Struct({ effort: Schema.String, ...DecisionFields });
const WorkerCountDecision = Schema.Struct({ workers: Schema.Int, ...DecisionFields });
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
const decodeCapability = Schema.decodeUnknownEffect(Capability);
const decodeModeDecision = Schema.decodeUnknownEffect(ModeDecision);
const decodeProfileDecision = Schema.decodeUnknownEffect(ProfileDecision);
const decodeEffortDecision = Schema.decodeUnknownEffect(EffortDecision);
const decodeWorkerCountDecision = Schema.decodeUnknownEffect(WorkerCountDecision);
const decodeRecommendations = Schema.decodeUnknownEffect(Recommendations);
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
  readonly difficulty: "routine" | "substantial" | "frontier" | null;
  readonly workload: "short" | "medium" | "long" | null;
  readonly source: OrchestrationAdvisorSource;
  readonly confidence: number;
  readonly reason: string;
}

function candidateState(profile: TeamModelProfile) {
  const prior = modelRoutingPrior(profile.selection.model);
  return {
    id: profile.id,
    label: profile.label,
    providerInstanceId: profile.selection.instanceId,
    model: profile.selection.model,
    capability: profile.capability ?? prior.capability,
    options: (profile.selection.options ?? [])
      .filter(
        (option) =>
          ["reasoningEffort", "variant", "serviceTier"].includes(option.id) &&
          option.id.length <= 64 &&
          (typeof option.value === "boolean" || option.value.length <= 128),
      )
      .slice(0, 3),
    costClass: prior.costClass,
    effortStrategy: prior.effortStrategy,
  };
}

function routingObjective(value: string): string {
  if (value.length <= 8_000) return value;
  return `${value.slice(0, 4_000)}\n...[middle omitted for routing]...\n${value.slice(-3_950)}`;
}

function routeRepresentatives(
  profiles: ReadonlyArray<TeamModelProfile>,
): ReadonlyArray<TeamModelProfile> {
  const selected: TeamModelProfile[] = [];
  for (const costClass of ["economy", "balanced", "premium", "scarce", "unknown"] as const) {
    const candidate = profiles.find(
      (profile) => modelRoutingPrior(profile.selection.model).costClass === costClass,
    );
    if (candidate) selected.push(candidate);
  }
  const seen = new Map<string, number>();
  for (const profile of selected) {
    const prior = modelRoutingPrior(profile.selection.model);
    const key = `${prior.costClass}:${profile.capability ?? prior.capability ?? "unknown"}`;
    seen.set(key, (seen.get(key) ?? 0) + 1);
  }
  for (const profile of profiles) {
    if (selected.includes(profile) || selected.length >= 12) continue;
    const prior = modelRoutingPrior(profile.selection.model);
    const key = `${prior.costClass}:${profile.capability ?? prior.capability ?? "unknown"}`;
    const count = seen.get(key) ?? 0;
    if (count >= 2) continue;
    seen.set(key, count + 1);
    selected.push(profile);
  }
  return selected;
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
    Effect.mapError((error) => (isTeamError(error) ? error : sessionPersistenceError())),
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
    operation: "capability" | "execution" | "profile" | "effort" | "workers" | "recommendations",
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
    const capability = yield* decodeCapability(result.value).pipe(Effect.option);
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
      difficulty: null,
      workload: null,
      source: "policy",
      confidence: 1,
      reason: "Using Flow Standard with your selected Lead and Worker models.",
    };
    if (input.workers.length === 0) return fallback;
    const result = yield* request("execution", {
      objective: routingObjective(input.objective),
      candidates: routeRepresentatives(input.workers).map(candidateState),
    });
    const decision = yield* decodeModeDecision(result.value).pipe(Effect.option);
    return result.status === 200 &&
      Option.isSome(decision) &&
      decision.value.source === "jev" &&
      (decision.value.mode === "orchestrated" || decision.value.mode === "direct")
      ? {
          ...decision.value,
          difficulty: decision.value.difficulty ?? null,
          workload: decision.value.workload ?? null,
        }
      : fallback;
  });

  const chooseProfile = Effect.fnUntraced(function* (input: {
    readonly purpose: "lead" | "worker" | "failover" | "review";
    readonly objective: string;
    readonly candidates: ReadonlyArray<TeamModelProfile>;
    readonly preferredProfileId?: string | null;
    readonly context?: unknown;
  }): Effect.fn.Return<OrchestrationAdvisorDecision> {
    if (input.candidates.length > 12) {
      const finalists: TeamModelProfile[] = [];
      let incomplete = false;
      for (let offset = 0; offset < input.candidates.length; offset += 12) {
        const batch = input.candidates.slice(offset, offset + 12);
        const winner = yield* chooseProfile({ ...input, candidates: batch });
        if (winner.source !== "jev" && batch.length > 1) incomplete = true;
        finalists.push(batch.find((candidate) => candidate.id === winner.profileId) ?? batch[0]!);
      }
      const final = yield* chooseProfile({ ...input, candidates: finalists });
      return incomplete
        ? {
            profileId: input.candidates[0]!.id,
            source: "policy" as const,
            confidence: 1,
            reason: "Smart Routing could not compare every eligible model.",
          }
        : final;
    }
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
      objective: routingObjective(input.objective),
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
    const decision = yield* decodeProfileDecision(result.value).pipe(Effect.option);
    return result.status === 200 &&
      Option.isSome(decision) &&
      decision.value.source === "jev" &&
      input.candidates.some((profile) => profile.id === decision.value.profileId)
      ? decision.value
      : fallback;
  });

  const chooseEffort = Effect.fnUntraced(function* (input: {
    readonly objective: string;
    readonly profile: TeamModelProfile;
    readonly choices: { readonly optionId: string; readonly values: ReadonlyArray<string> } | null;
  }): Effect.fn.Return<{ readonly optionId: string; readonly value: string } | null> {
    if (!input.choices) return null;
    const { optionId, values } = input.choices;
    if (values.length === 0) return null;
    const prior = modelRoutingPrior(input.profile.selection.model);
    if (prior.effortStrategy === "highest") {
      const value = highestSupportedEffort(values);
      return value ? { optionId, value } : null;
    }
    if (values.length === 1) return { optionId, value: values[0]! };
    const result = yield* request("effort", {
      objective: routingObjective(input.objective),
      candidates: [candidateState(input.profile)],
      effortChoices: values,
    });
    const decision = yield* decodeEffortDecision(result.value).pipe(Effect.option);
    const value =
      result.status === 200 && Option.isSome(decision) && values.includes(decision.value.effort)
        ? decision.value.effort
        : (values.find((candidate) => candidate === "medium") ?? values[0]!);
    return { optionId, value };
  });

  const chooseWorkerCount = Effect.fnUntraced(function* (input: {
    readonly objective: string;
    readonly scope: string;
    readonly lead: TeamModelProfile;
    readonly maxWorkers: number;
  }): Effect.fn.Return<{
    readonly workers: number;
    readonly source: OrchestrationAdvisorSource;
    readonly reason: string;
  }> {
    if (input.maxWorkers === 0)
      return { workers: 0, source: "policy", reason: "Concurrency allows Lead-only work." };
    const result = yield* request("workers", {
      objective: routingObjective(input.objective),
      scope: routingObjective(input.scope),
      maxWorkers: input.maxWorkers,
      candidates: [candidateState(input.lead)],
    });
    const decision = yield* decodeWorkerCountDecision(result.value).pipe(Effect.option);
    return result.status === 200 &&
      Option.isSome(decision) &&
      decision.value.source === "jev" &&
      decision.value.workers >= 0 &&
      decision.value.workers <= input.maxWorkers
      ? decision.value
      : {
          workers: input.maxWorkers,
          source: "policy",
          reason:
            "Smart Routing could not choose a worker count; Flow Standard will let the Lead delegate within the saved concurrency limit.",
        };
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
      const response = yield* decodeRecommendations(result.value).pipe(Effect.option);
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
    chooseEffort,
    chooseWorkerCount,
    routeExecution,
    recommendProfiles,
  };
});

export class OrchestrationAdvisor extends Context.Service<
  OrchestrationAdvisor,
  Effect.Success<typeof make>
>()("dispatch/team/OrchestrationAdvisor") {}

export const layer = Layer.effect(OrchestrationAdvisor, make);

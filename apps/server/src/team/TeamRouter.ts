import { eligiblePolicy, poolCandidates } from "./pool.ts";
import {
  TeamError,
  type TeamDraft,
  type TeamAssessment,
  type TeamModelProfile,
  type TeamPolicy,
  type TeamRecoveryInput,
  type ServerProvider,
} from "@dispatch/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";
import * as Semaphore from "effect/Semaphore";
import { ServerSecretStore } from "../auth/ServerSecretStore.ts";
import { ProviderRegistry } from "../provider/Services/ProviderRegistry.ts";
import { TeamStore } from "./TeamStore.ts";
import {
  Choice,
  validChoice,
  JEV_MODEL,
  JevResponse,
  chooseProfile,
  classify,
  fingerprintDraft,
  jevRequest,
  validatePool,
  fitsJevState,
  planningHints,
  requiresDeliberateReasoning,
} from "./routing.ts";
import * as NodeCrypto from "node:crypto";
import { RecoveryResponse, recoveryAdvice, recoveryRequest } from "./recovery.ts";

const SECRET = "team-jev-api-key";
const isTeamError = Schema.is(TeamError);
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const POOL_ROLE_CHOICES = ["lead_worker", "lead", "worker", "inactive"] as const;

function poolQuestion(kind: "tier" | "role" | "reasoning", profileId: string): string {
  return `${kind}:${profileId}`;
}

function profileCatalogEntry(profile: TeamModelProfile, providers: ReadonlyArray<ServerProvider>) {
  const provider = providers.find(
    (candidate) => candidate.instanceId === profile.selection.instanceId,
  );
  const model = provider?.models.find((candidate) => candidate.slug === profile.selection.model);
  const reasoning = model?.capabilities?.optionDescriptors?.find(
    (descriptor) =>
      descriptor.type === "select" &&
      ["reasoningEffort", "effort", "reasoning", "variant"].includes(descriptor.id),
  );
  return {
    profile,
    provider,
    model,
    reasoning: reasoning?.type === "select" ? reasoning : null,
  };
}

function recommendedPoolProfiles(input: {
  candidates: ReadonlyArray<TeamModelProfile>;
  providers: ReadonlyArray<ServerProvider>;
  answers: Readonly<Record<string, typeof Choice.Type>>;
  confidenceThreshold: number;
  selectCapableLead: boolean;
}): ReadonlyArray<TeamModelProfile> {
  const entries = input.candidates.map((profile) => profileCatalogEntry(profile, input.providers));
  const leadAnswer = input.selectCapableLead ? input.answers.capableLead : undefined;
  const leadProfileId =
    leadAnswer &&
    leadAnswer.confidence >= input.confidenceThreshold &&
    validChoice(
      leadAnswer,
      entries.map(({ profile }) => profile.id),
    )
      ? leadAnswer.choice
      : null;

  return entries.map(({ profile, reasoning }) => {
    const tier = input.answers[poolQuestion("tier", profile.id)];
    const role = input.answers[poolQuestion("role", profile.id)];
    const tierValid =
      tier !== undefined &&
      tier.confidence >= input.confidenceThreshold &&
      validChoice(tier, ["economy", "balanced", "capable"]);
    const roleValid =
      role !== undefined &&
      role.confidence >= input.confidenceThreshold &&
      validChoice(role, [...POOL_ROLE_CHOICES]);
    const selectedAsCapableLead = profile.id === leadProfileId;
    if ((!tierValid || !roleValid) && !selectedAsCapableLead) return profile;

    const roleChoice = roleValid ? role.choice : selectedAsCapableLead ? "lead_worker" : "inactive";
    const lead = selectedAsCapableLead || roleChoice === "lead_worker" || roleChoice === "lead";
    const worker = roleChoice === "lead_worker" || roleChoice === "worker";
    if (!lead && !worker) return profile;

    let options = profile.selection.options ?? [];
    if (reasoning) {
      const answer = input.answers[poolQuestion("reasoning", profile.id)];
      const optionIds = reasoning.options.map((option) => option.id);
      const value =
        answer && answer.confidence >= input.confidenceThreshold && validChoice(answer, optionIds)
          ? answer.choice
          : (reasoning.currentValue ?? reasoning.options.find((option) => option.isDefault)?.id);
      if (value) {
        options = [
          ...options.filter((option) => option.id !== reasoning.id),
          { id: reasoning.id, value },
        ];
      }
    }

    return {
      ...profile,
      reviewRequired: false,
      tier: selectedAsCapableLead ? "capable" : (tier!.choice as TeamModelProfile["tier"]),
      lead,
      worker,
      selection: { ...profile.selection, ...(options.length > 0 ? { options } : {}) },
    };
  });
}
export const make = Effect.gen(function* () {
  const secrets = yield* ServerSecretStore;
  const client = yield* HttpClient.HttpClient;
  const registry = yield* ProviderRegistry;
  const store = yield* TeamStore;
  const lock = yield* Semaphore.make(1);
  const inferenceLock = yield* Semaphore.make(2);
  const cache = new Map<string, TeamAssessment>();
  let credentialRevision = 0;
  const safeError = () =>
    new TeamError({
      code: "unavailable",
      message: "Jev could not be reached or its credentials/response were rejected.",
    });
  const settings = Effect.gen(function* () {
    const key = yield* secrets.get(SECRET).pipe(Effect.mapError(safeError));
    return { policy: yield* store.getPolicy, jevConfigured: Option.isSome(key) };
  });
  const saveSettings = Effect.fn("TeamRouter.saveSettings")(function* (policy: TeamPolicy) {
    if (
      policy.mode !== "off" &&
      Option.isNone(yield* secrets.get(SECRET).pipe(Effect.mapError(safeError)))
    )
      return yield* new TeamError({
        code: "invalid",
        message: "Add your Jev API key before enabling routing.",
      });
    const providers = yield* registry.getProviders;
    yield* Effect.try({
      try: () => validatePool(policy, providers),
      catch: (e) => (isTeamError(e) ? e : safeError()),
    });
    yield* store.savePolicy(policy);
    cache.clear();
    return yield* settings;
  }, lock.withPermits(1));
  const setSecret = Effect.fnUntraced(function* (apiKey: string) {
    credentialRevision++;
    cache.clear();
    if (apiKey.trim())
      yield* secrets
        .set(SECRET, new TextEncoder().encode(apiKey.trim()))
        .pipe(Effect.mapError(safeError));
    else {
      // Disable first: a failure removing the key cannot leave routing active.
      const policy = yield* store.getPolicy;
      if (policy.mode !== "off") yield* store.savePolicy({ ...policy, mode: "off" });
      yield* secrets.remove(SECRET).pipe(Effect.mapError(safeError));
    }
    credentialRevision++;
    cache.clear();
    return yield* settings;
  }, lock.withPermits(1));
  const assess = Effect.fnUntraced(function* (
    draft: TeamDraft,
    role: "lead" | "worker" = "lead",
  ): Effect.fn.Return<TeamAssessment, TeamError> {
    const policy = yield* store.getPolicy;
    if (draft.policyRevision !== policy.revision)
      return yield* new TeamError({
        code: "conflict",
        message: "Routing settings changed. Refresh the draft assessment.",
      });
    const providers = yield* registry.getProviders;
    const eligible = eligiblePolicy(policy, providers);
    const fingerprint = fingerprintDraft(draft, policy, providers, role);
    const startedCredentialRevision = credentialRevision;
    const cached = cache.get(fingerprint);
    if (cached) return { ...cached, draftId: draft.draftId, revision: draft.revision };
    let outcome = {
      tier: "capable" as const,
      confidence: 0,
      reason: "Jev is not configured; capable fallback.",
    } as ReturnType<typeof classify>;
    let response: JevResponse | null = null;
    const key = yield* secrets.get(SECRET).pipe(Effect.mapError(safeError));
    if (policy.mode !== "off" && Option.isNone(key))
      return yield* new TeamError({
        code: "unavailable",
        message: "Jev API key is required. Configure it in Orchestration settings.",
      });
    const request = jevRequest(draft.prompt);
    if (
      policy.mode !== "off" &&
      !draft.hasAttachments &&
      draft.prompt.trim() &&
      fitsJevState(request.state) &&
      Option.isSome(key)
    ) {
      const token = new TextDecoder().decode(key.value);
      // No prompt/key/body enters errors or logs. An aborted request is never retried implicitly.
      const result = yield* client
        .execute(
          HttpClientRequest.post("https://api.typesafe.ai/v1/systemone").pipe(
            HttpClientRequest.setHeader("Authorization", `Bearer ${token}`),
            HttpClientRequest.bodyJsonUnsafe(request),
          ),
        )
        .pipe(
          Effect.flatMap(HttpClientResponse.filterStatusOk),
          Effect.flatMap((res) => res.json),
          Effect.flatMap(Schema.decodeUnknownEffect(JevResponse)),
          Effect.timeout("4 seconds"),
          Effect.option,
        );
      if (Option.isSome(result) && result.value.model === JEV_MODEL) {
        response = result.value;
        outcome = classify(response, policy.confidenceThreshold);
      } else outcome.reason = "Jev unavailable or invalid; capable fallback.";
      const observed = Option.getOrNull(result);
      yield* store.recordRoutingUsage({
        fingerprint,
        model: observed?.model ?? JEV_MODEL,
        inputTokens: observed?.usage.input_tokens ?? null,
        outputTokens: observed?.usage.output_tokens ?? null,
        succeeded: response !== null,
      });
    } else if (draft.hasAttachments)
      outcome.reason = "Uninspected attachments require the capable profile.";
    else if (!fitsJevState(request.state))
      outcome.reason =
        "Task exceeds the preview context budget; no text was truncated. Capable fallback.";
    else if (policy.mode === "off") outcome.reason = "Routing is disabled.";
    const selected =
      policy.mode === "off"
        ? null
        : chooseProfile(
            eligible,
            outcome.tier,
            role,
            requiresDeliberateReasoning(response, policy.confidenceThreshold),
          );
    const assessment: TeamAssessment = {
      draftId: draft.draftId,
      revision: draft.revision,
      fingerprint,
      policyRevision: policy.revision,
      profileId: selected?.id ?? null,
      selection: selected?.selection ?? null,
      ...outcome,
      source: response ? "jev" : "fallback",
      inputTokens: response?.usage.input_tokens ?? null,
      outputTokens: response?.usage.output_tokens ?? null,
      planning: planningHints(response, policy.confidenceThreshold),
    };
    // Bounded process-local cache; submit rechecks exact content, policy and catalog.
    if (cache.size >= 256) cache.delete(cache.keys().next().value!);
    if (startedCredentialRevision !== credentialRevision)
      return yield* new TeamError({
        code: "conflict",
        message: "Jev credentials changed during assessment. Try again.",
      });
    if (response) cache.set(fingerprint, assessment);
    return assessment;
  }, inferenceLock.withPermits(1));
  const resolve = Effect.fnUntraced(function* (input: { prompt: string; hasAttachments: boolean }) {
    const policy = yield* store.getPolicy;
    if (policy.mode !== "auto") return null;
    const decision = yield* assess({
      ...input,
      draftId: "submit",
      revision: 0,
      policyRevision: policy.revision,
    });
    const latest = yield* store.getPolicy;
    if (latest.revision !== policy.revision)
      return yield* new TeamError({
        code: "conflict",
        message: "Routing policy changed during submission. Send again.",
      });
    if (!decision.selection)
      return yield* new TeamError({
        code: "unavailable",
        message: "No allowed model satisfies the task requirements.",
      });
    const providers = yield* registry.getProviders;
    yield* Effect.try({
      try: () => validatePool(latest, providers),
      catch: (e) => (isTeamError(e) ? e : safeError()),
    });
    const provider = providers.find((p) => p.instanceId === decision.selection?.instanceId);
    if (provider?.status !== "ready" || provider.auth.status === "unauthenticated")
      return yield* new TeamError({
        code: "unavailable",
        message: "The selected provider is not ready. Check Providers settings.",
      });
    return decision.selection;
  });
  const recover = Effect.fnUntraced(function* (input: TeamRecoveryInput) {
    const policy = yield* store.getPolicy;
    if (policy.revision !== input.policyRevision)
      return yield* new TeamError({
        code: "conflict",
        message: "Recovery policy changed. Refresh the assessment.",
      });
    const fallback = recoveryAdvice(input, policy, null);
    if (
      input.inFlight ||
      input.attemptsMade >= policy.maxAttempts ||
      policy.mode === "off" ||
      !policy.profiles.some((p) => p.id === input.currentProfileId && p.worker)
    )
      return fallback;
    const providers = yield* registry.getProviders;
    yield* Effect.try({
      try: () => validatePool(policy, providers),
      catch: (e) => (isTeamError(e) ? e : safeError()),
    });
    const key = yield* secrets.get(SECRET).pipe(Effect.mapError(safeError));
    const request = recoveryRequest(input);
    if (Option.isNone(key) || !fitsJevState(request.state)) return fallback;
    const startedCredentialRevision = credentialRevision;
    const result = yield* client
      .execute(
        HttpClientRequest.post("https://api.typesafe.ai/v1/systemone").pipe(
          HttpClientRequest.setHeader(
            "Authorization",
            `Bearer ${new TextDecoder().decode(key.value)}`,
          ),
          HttpClientRequest.bodyJsonUnsafe(request),
        ),
      )
      .pipe(
        Effect.flatMap(HttpClientResponse.filterStatusOk),
        Effect.flatMap((res) => res.json),
        Effect.flatMap(Schema.decodeUnknownEffect(RecoveryResponse)),
        Effect.timeout("4 seconds"),
        Effect.option,
      );
    const response = Option.getOrNull(result);
    yield* store.recordRoutingUsage({
      fingerprint: NodeCrypto.createHash("sha256")
        .update(encodeJson({ purpose: "recovery-v1", request, policyRevision: policy.revision }))
        .digest("hex"),
      model: response?.model ?? JEV_MODEL,
      inputTokens: response?.usage.input_tokens ?? null,
      outputTokens: response?.usage.output_tokens ?? null,
      succeeded: response?.model === JEV_MODEL,
    });
    if (
      startedCredentialRevision !== credentialRevision ||
      (yield* store.getPolicy).revision !== policy.revision
    )
      return yield* new TeamError({
        code: "conflict",
        message: "Recovery settings changed during assessment.",
      });
    return recoveryAdvice(input, eligiblePolicy(policy, yield* registry.getProviders), response);
  }, inferenceLock.withPermits(1));
  const suggestPool = Effect.fn("TeamRouter.suggestPool")(function* () {
    const snapshot = yield* registry.getProviders;
    yield* Effect.forEach(
      snapshot.filter((provider) => provider.enabled),
      (provider) =>
        registry
          .refreshInstance(provider.instanceId)
          .pipe(Effect.timeout("5 seconds"), Effect.option),
      { concurrency: 2 },
    );
    const providers = yield* registry.getProviders;
    const policy = yield* store.getPolicy;
    const candidates = poolCandidates(providers, policy.profiles);
    if (!candidates.profiles.length)
      return {
        profiles: [],
        notes: [
          ...candidates.notes,
          "No eligible model is available. Check provider authentication, quota, and model catalogs.",
        ],
        source: "catalog" as const,
      };
    const provisional = candidates.profiles.filter((profile) => profile.reviewRequired === true);
    const hasExistingCapableLead = candidates.profiles.some(
      (profile) => profile.reviewRequired !== true && profile.lead && profile.tier === "capable",
    );
    const catalogEntries = provisional.map((profile) => profileCatalogEntry(profile, providers));
    const request = {
      model: JEV_MODEL,
      state: {
        candidates: catalogEntries.map(({ profile, provider, model, reasoning }) => ({
          id: profile.id,
          provider: provider?.displayName ?? provider?.instanceId ?? profile.selection.instanceId,
          driver: provider?.driver ?? null,
          model: model?.slug ?? profile.selection.model,
          name: model?.name ?? profile.label,
          defaultModel: model?.isDefault === true,
          reasoning: reasoning
            ? {
                current: reasoning.currentValue ?? null,
                options: reasoning.options.map((option) => ({
                  id: option.id,
                  label: option.label,
                  default: option.isDefault === true,
                })),
              }
            : null,
        })),
        quota: providers.map((p) => ({
          instanceId: p.instanceId,
          windows: p.usageLimits?.windows ?? [],
        })),
      },
      questions: {
        ...(provisional.length > 0 && !hasExistingCapableLead
          ? {
              capableLead: {
                type: "choice" as const,
                instructions:
                  "Choose the best default lead for complex or uncertain coding work. A lead must plan, delegate, review, integrate, and recover reliably. Use the supplied provider/model identity and catalog metadata. Prefer quality and reliability over speed; quota headroom may break a close tie. Do not invent prices or unsupported options.",
                criteria: Object.fromEntries(
                  provisional.map((profile) => [profile.id, profile.label]),
                ),
              },
            }
          : {}),
        ...Object.fromEntries(
          catalogEntries.flatMap(({ profile, reasoning }) => {
            const questions: Array<[string, object]> = [
              [
                poolQuestion("tier", profile.id),
                {
                  type: "choice",
                  instructions:
                    "Recommend the lowest task group this model should handle by default in a coding-agent team. Use current model-family knowledge plus the supplied catalog metadata. Be conservative for unfamiliar models.",
                  criteria: {
                    economy: "Routine, mechanical, low-risk coding tasks",
                    balanced: "Everyday implementation and debugging across related files",
                    capable:
                      "Complex, ambiguous, high-impact, architecture, review, or integration work",
                  },
                },
              ],
              [
                poolQuestion("role", profile.id),
                {
                  type: "choice",
                  instructions:
                    "Recommend this model's default team roles for coding work. Leads must plan, delegate, review, integrate, and recover; workers must independently execute bounded implementation tasks. Choose inactive only when the model should not be used by orchestration by default.",
                  criteria: {
                    lead_worker: "Suitable both as team lead and delegated worker",
                    lead: "Suitable as lead but not a default delegated worker",
                    worker: "Suitable as delegated worker but not as team lead",
                    inactive: "Do not enable for orchestration by default",
                  },
                },
              ],
            ];
            if (reasoning && reasoning.options.length > 0)
              questions.push([
                poolQuestion("reasoning", profile.id),
                {
                  type: "choice",
                  instructions:
                    "Choose the default reasoning setting for this model when Dispatch orchestration uses it. Balance reliable coding quality with unnecessary reasoning cost. Use only the advertised options.",
                  criteria: Object.fromEntries(
                    reasoning.options.map((option) => [option.id, option.label]),
                  ),
                },
              ]);
            return questions;
          }),
        ),
      },
    };
    const key = yield* secrets.get(SECRET).pipe(Effect.mapError(safeError));
    const Response = Schema.Struct({
      model: Schema.String,
      answers: Schema.Record(Schema.String, Choice),
    });
    const result =
      Option.isSome(key) && provisional.length > 0 && fitsJevState(request.state)
        ? yield* client
            .execute(
              HttpClientRequest.post("https://api.typesafe.ai/v1/systemone").pipe(
                HttpClientRequest.setHeader(
                  "Authorization",
                  `Bearer ${new TextDecoder().decode(key.value)}`,
                ),
                HttpClientRequest.bodyJsonUnsafe(request),
              ),
            )
            .pipe(
              Effect.flatMap(HttpClientResponse.filterStatusOk),
              Effect.flatMap((res) => res.json),
              Effect.flatMap(Schema.decodeUnknownEffect(Response)),
              Effect.timeout("4 seconds"),
              Effect.option,
            )
        : Option.none();
    const jevResponse =
      Option.isSome(result) && result.value.model === JEV_MODEL ? result.value : null;
    const recommended = jevResponse
      ? recommendedPoolProfiles({
          candidates: provisional,
          providers,
          answers: jevResponse.answers,
          confidenceThreshold: policy.confidenceThreshold,
          selectCapableLead: !hasExistingCapableLead,
        })
      : provisional;
    const preserved = candidates.profiles.filter((profile) => profile.reviewRequired !== true);
    const latest = eligiblePolicy(
      { ...policy, profiles: [...preserved, ...recommended] },
      providers,
    );
    const remaining = recommended.filter(
      (profile) => !latest.profiles.some((chosen) => chosen.id === profile.id),
    );
    const configuredCount = recommended.filter((profile) => profile.reviewRequired !== true).length;
    return {
      profiles: [...latest.profiles, ...remaining],
      notes: [
        ...candidates.notes,
        ...(jevResponse && configuredCount > 0
          ? [
              `Jev recommended task groups, team roles, and reasoning defaults for ${configuredCount} new model${configuredCount === 1 ? "" : "s"}.`,
            ]
          : provisional.length > 0
            ? ["Jev did not return confident defaults for the new models; they remain inactive."]
            : []),
        "Existing customized profiles are preserved. Runtime rechecks provider availability and reported quota.",
      ],
      source: jevResponse && configuredCount > 0 ? ("jev" as const) : ("catalog" as const),
    };
  }, inferenceLock.withPermits(1));
  return { settings, saveSettings, setSecret, assess, resolve, recover, suggestPool };
});
export class TeamRouter extends Context.Service<TeamRouter, Effect.Success<typeof make>>()(
  "dispatch/team/TeamRouter",
) {}
export const layer = Layer.effect(TeamRouter, make);

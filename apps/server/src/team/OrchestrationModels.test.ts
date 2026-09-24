import { describe, expect, it } from "vite-plus/test";
import { it as effectIt } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
  type TeamModelProfile,
  type TeamPolicy,
} from "@dispatch/contracts";

import {
  directWorkerProfileOrder,
  equivalentProfileOrder,
  makeOrchestrationModelCatalog,
  orderedDirectProfiles,
  orchestrationModelUsable,
  orchestrationQuotaExhausted,
  orderedRoleProfiles,
} from "./OrchestrationModels.ts";
import { ProviderRegistry } from "../provider/Services/ProviderRegistry.ts";
import { ProviderService } from "../provider/Services/ProviderService.ts";

const codex = ProviderInstanceId.make("codex");
const claude = ProviderInstanceId.make("claude");

const provider = (
  instanceId: typeof codex,
  models: ReadonlyArray<string>,
  overrides: Partial<ServerProvider> = {},
): ServerProvider => ({
  instanceId,
  driver: ProviderDriverKind.make(instanceId === claude ? "claude" : "codex"),
  enabled: true,
  installed: true,
  version: null,
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-09-21T00:00:00.000Z",
  models: models.map((slug) => ({ slug, name: slug, isCustom: false, capabilities: null })),
  slashCommands: [],
  skills: [],
  ...overrides,
});

const profile = (
  id: string,
  instanceId: typeof codex,
  model: string,
  overrides: Partial<TeamModelProfile> = {},
): TeamModelProfile => ({
  id,
  label: id,
  selection: { instanceId, model },
  lead: true,
  worker: true,
  ...overrides,
});

const policy = (profiles: ReadonlyArray<TeamModelProfile>): TeamPolicy => ({
  revision: 1,
  enabled: true,
  flowMode: "standard",
  profiles,
  maxActive: 3,
  maxAttempts: 2,
  providerLimitBehavior: "ask",
});

describe("orchestration model ordering", () => {
  effectIt.effect("offers only allowed models to direct Auto regardless of Flow roles", () => {
    const saved = profile("saved", codex, "gpt-6-sol", {
      selection: {
        instanceId: codex,
        model: "gpt-6-sol",
        options: [
          { id: "reasoningEffort", value: "high" },
          { id: "serviceTier", value: "priority" },
        ],
      },
      effortMode: "fixed",
      lead: false,
      worker: false,
    });
    return Effect.gen(function* () {
      const catalog = yield* makeOrchestrationModelCatalog;
      const models = yield* catalog.runnableDirectProfiles(policy([saved]));
      expect(models.map((candidate) => candidate.selection.model)).toEqual(["gpt-6-sol"]);
      expect(models[0]?.selection).toEqual(saved.selection);
      expect(models[0]?.effortMode).toBe("fixed");
      expect(models.every((candidate) => !candidate.lead && !candidate.worker)).toBe(true);
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          Layer.mock(ProviderRegistry)({
            getProviders: Effect.succeed([
              provider(codex, ["gpt-6-sol", "gpt-6-luna"]),
              provider(claude, ["opus"], { supportsTextGeneration: false }),
            ]),
          }),
          Layer.mock(ProviderService)({}),
        ),
      ),
    );
  });

  it("excludes image-incompatible and unlisted models from image routes", () => {
    const textOnly = profile("text-only", codex, "deepseek-v4", {
      lead: false,
      worker: false,
    });
    const imageReady = profile("image-ready", codex, "gpt-6-sol", {
      lead: false,
      worker: false,
    });
    const unknown = profile("unknown", codex, "unknown-image-support", {
      lead: false,
      worker: false,
    });
    const snapshot = {
      ...provider(codex, ["deepseek-v4", "gpt-6-sol", "unknown-image-support", "unlisted"]),
      models: [
        {
          slug: "deepseek-v4",
          name: "DeepSeek",
          isCustom: false,
          capabilities: null,
          supportsImageInput: false,
        },
        {
          slug: "gpt-6-sol",
          name: "Sol",
          isCustom: false,
          capabilities: null,
          supportsImageInput: true,
        },
        { slug: "unknown-image-support", name: "Unknown", isCustom: false, capabilities: null },
        {
          slug: "unlisted",
          name: "Unlisted",
          isCustom: false,
          capabilities: null,
          supportsImageInput: true,
        },
      ],
    } satisfies ServerProvider;
    expect(
      orderedDirectProfiles(policy([textOnly, imageReady, unknown]), [snapshot], true).map(
        (candidate) => candidate.selection.model,
      ),
    ).toEqual(["gpt-6-sol"]);
    expect(
      orderedDirectProfiles(policy([textOnly, imageReady, unknown]), [snapshot]).map(
        (candidate) => candidate.selection.model,
      ),
    ).toEqual(["deepseek-v4", "gpt-6-sol", "unknown-image-support"]);
    expect(
      orderedRoleProfiles(policy([textOnly, imageReady, unknown]), [snapshot], "lead", true),
    ).toEqual([]);
  });

  it("preserves policy order while filtering by role, readiness and quota", () => {
    const first = profile("first", codex, "luna");
    const workerOnly = profile("worker-only", codex, "luna", { lead: false });
    const exhausted = profile("exhausted", claude, "opus");
    const last = profile("last", codex, "astra");
    const providers = [
      provider(codex, ["luna", "astra"]),
      provider(claude, ["opus"], {
        usageLimits: {
          checkedAt: "2026-09-21T00:00:00.000Z",
          windows: [{ id: "opus-weekly", kind: "weekly", label: "Opus weekly", usedPercent: 100 }],
        },
      }),
    ];

    expect(
      orderedRoleProfiles(policy([first, workerOnly, exhausted, last]), providers, "lead"),
    ).toEqual([first, last]);
    expect(
      orderedRoleProfiles(policy([first, workerOnly, exhausted, last]), providers, "worker"),
    ).toEqual([first, workerOnly, last]);
  });

  it("orders equivalent or stronger failover profiles without capability downgrade", () => {
    const current = profile("current", codex, "current", { capability: "complex" });
    const general = profile("general", codex, "general", { capability: "general" });
    const unknown = profile("unknown", codex, "unknown");
    const complex = profile("complex", codex, "complex", { capability: "complex" });
    const frontier = profile("frontier", codex, "frontier", { capability: "frontier" });

    expect(
      equivalentProfileOrder(current, [frontier, general, current, unknown, complex]).map(
        (p) => p.id,
      ),
    ).toEqual(["complex", "frontier"]);
  });

  it("prefers cheaper direct workers by capability tier while preserving policy order within a tier", () => {
    const frontier = profile("frontier", codex, "frontier", { capability: "frontier" });
    const generalFirst = profile("general-first", codex, "general-1", { capability: "general" });
    const unknownFirst = profile("unknown-first", codex, "unknown-1");
    const complexFirst = profile("complex-first", codex, "complex-1", { capability: "complex" });
    const generalSecond = profile("general-second", codex, "general-2", { capability: "general" });
    const unknownSecond = profile("unknown-second", codex, "unknown-2");
    const complexSecond = profile("complex-second", codex, "complex-2", { capability: "complex" });

    expect(
      directWorkerProfileOrder([
        frontier,
        generalFirst,
        unknownFirst,
        complexFirst,
        generalSecond,
        unknownSecond,
        complexSecond,
      ]).map((candidate) => candidate.id),
    ).toEqual([
      "general-first",
      "general-second",
      "unknown-first",
      "unknown-second",
      "complex-first",
      "complex-second",
      "frontier",
    ]);
  });
});

describe("orchestration quota filtering", () => {
  it("applies family-scoped exhaustion only to matching model families", () => {
    const snapshot = provider(claude, ["claude-opus", "claude-sonnet"], {
      usageLimits: {
        checkedAt: "2026-09-21T00:00:00.000Z",
        windows: [{ id: "opus-weekly", kind: "weekly", label: "Opus weekly", usedPercent: 100 }],
      },
    });

    expect(orchestrationQuotaExhausted(snapshot, "claude-opus")).toBe(true);
    expect(orchestrationQuotaExhausted(snapshot, "claude-sonnet")).toBe(false);
    expect(orchestrationModelUsable(snapshot, "claude-opus")).toBe(false);
    expect(orchestrationModelUsable(snapshot, "claude-sonnet")).toBe(true);
  });

  it("treats a generic exhausted window as blocking every model", () => {
    const snapshot = provider(codex, ["luna", "astra"], {
      usageLimits: {
        checkedAt: "2026-09-21T00:00:00.000Z",
        windows: [{ id: "weekly", kind: "weekly", label: "Weekly", usedPercent: 100 }],
      },
    });

    expect(orchestrationQuotaExhausted(snapshot, "luna")).toBe(true);
    expect(orchestrationQuotaExhausted(snapshot, "astra")).toBe(true);
  });
});

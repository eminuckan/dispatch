import { describe, expect, it } from "vite-plus/test";
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
  orchestrationModelUsable,
  orchestrationQuotaExhausted,
  orderedRoleProfiles,
} from "./OrchestrationModels.ts";

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

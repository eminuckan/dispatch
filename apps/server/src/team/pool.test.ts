import { describe, expect, it } from "vite-plus/test";
import { ProviderInstanceId, ProviderDriverKind, type ServerProvider } from "@dispatch/contracts";
import { eligiblePolicy, poolCandidates, quotaExhausted } from "./pool.ts";
import { defaultTeamPolicy } from "./routing.ts";
const provider: ServerProvider = {
  instanceId: ProviderInstanceId.make("claude"),
  driver: ProviderDriverKind.make("claudeAgent"),
  enabled: true,
  installed: true,
  version: null,
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-09-19T00:00:00.000Z",
  models: ["claude-opus-4", "claude-sonnet-4", "claude-haiku-4"].map((slug) => ({
    slug,
    name: slug,
    isCustom: false,
    capabilities: null,
  })),
  skills: [],
  slashCommands: [],
};
describe("orchestration pool eligibility", () => {
  it("excludes an exhausted family without blocking unaffected Claude models", () => {
    const limited = {
      ...provider,
      usageLimits: {
        checkedAt: provider.checkedAt,
        windows: [
          { id: "seven_day_opus", label: "Opus", kind: "weekly" as const, usedPercent: 100 },
        ],
      },
    };
    expect(quotaExhausted(limited, "claude-opus-4")).toBe(true);
    expect(quotaExhausted(limited, "claude-sonnet-4")).toBe(false);
    expect(poolCandidates([limited]).profiles.map((p) => p.selection.model)).toEqual([
      "claude-sonnet-4",
      "claude-haiku-4",
    ]);
    const original = poolCandidates([provider]).profiles.map((p) => ({
      ...p,
      reviewRequired: false,
      lead: true,
      worker: true,
    }));
    expect(
      eligiblePolicy({ ...defaultTeamPolicy, profiles: original }, [limited]).profiles,
    ).toHaveLength(2);
  });
  it("blocks shared exhausted quota and unavailable providers", () => {
    expect(
      poolCandidates([
        {
          ...provider,
          usageLimits: {
            checkedAt: provider.checkedAt,
            windows: [{ id: "five_hour", label: "Session", kind: "session", usedPercent: 100 }],
          },
        },
      ]).profiles,
    ).toEqual([]);
    expect(
      poolCandidates([
        { ...provider, enabled: false },
        { ...provider, auth: { status: "unauthenticated" } },
      ]).profiles,
    ).toEqual([]);
  });
  it("labels unknown quota and makes unknown catalog models provisional workers", () => {
    expect(poolCandidates([provider]).notes.join(" ")).toContain("could not be confirmed");
    expect(
      poolCandidates([
        {
          ...provider,
          models: [{ slug: "mystery-model", name: "New", isCustom: false, capabilities: null }],
        },
      ]).profiles,
    ).toEqual([expect.objectContaining({ lead: false, worker: false, reviewRequired: true })]);
  });
});

it("considers every ready adapter while excluding Terra only from generated defaults", () => {
  const openCode = {
    ...provider,
    instanceId: ProviderInstanceId.make("go"),
    driver: ProviderDriverKind.make("opencode"),
    models: ["gpt-5.6-terra", "gpt-5.6-luna", "gpt-6-astra"].map((slug) => ({
      slug,
      name: slug,
      isCustom: false,
      capabilities: null,
    })),
  };
  const profiles = poolCandidates([openCode]).profiles;
  expect(profiles.map((p) => p.selection.model)).toEqual(["gpt-5.6-luna", "gpt-6-astra"]);
  expect(profiles.every((p) => p.selection.instanceId === "go")).toBe(true);
  const terra = {
    ...profiles[0]!,
    reviewRequired: false,
    selection: { instanceId: openCode.instanceId, model: "gpt-5.6-terra" },
  };
  expect(
    eligiblePolicy({ ...defaultTeamPolicy, profiles: [terra] }, [openCode]).profiles,
  ).toHaveLength(1);
});

it("preserves approved model and effort variants without inferring capabilities for new entries", () => {
  const base = poolCandidates([provider]).profiles[0]!;
  const approved = [
    {
      ...base,
      id: "low",
      reviewRequired: false,
      tier: "economy" as const,
      lead: true,
      worker: true,
      selection: { ...base.selection, options: [{ id: "effort", value: "low" }] },
    },
    {
      ...base,
      id: "high",
      reviewRequired: false,
      tier: "balanced" as const,
      lead: true,
      worker: true,
      selection: { ...base.selection, options: [{ id: "effort", value: "high" }] },
    },
  ];
  const candidates = poolCandidates([provider], approved);
  expect(candidates.profiles.slice(0, 2)).toEqual(approved);
  expect(candidates.profiles.slice(2).every((p) => p.reviewRequired && !p.lead && !p.worker)).toBe(
    true,
  );
});

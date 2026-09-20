import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import type { TeamAssessment, TeamDraft } from "@dispatch/contracts";
import { createTeamDraftCoordinator } from "./teamDraft.ts";
const draft: TeamDraft = {
  draftId: "a",
  revision: 1,
  policyRevision: 1,
  prompt: "first",
  hasAttachments: false,
};
const result = (d: TeamDraft): TeamAssessment => ({
  ...d,
  fingerprint: "hash",
  profileId: null,
  selection: null,
  tier: "capable",
  confidence: 0,
  reason: "fallback",
  source: "fallback",
  inputTokens: null,
  outputTokens: null,
});
afterEach(() => vi.useRealTimers());
describe("composer assessment", () => {
  it("debounces idle rather than requesting on every keystroke", async () => {
    vi.useFakeTimers();
    const assess = vi.fn(async (d: TeamDraft) => result(d));
    const coordinator = createTeamDraftCoordinator({ assess, publish: vi.fn(), onError: vi.fn() });
    coordinator.schedule(draft);
    await vi.advanceTimersByTimeAsync(200);
    coordinator.schedule({ ...draft, revision: 2 });
    await vi.advanceTimersByTimeAsync(449);
    expect(assess).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(assess).toHaveBeenCalledOnce();
    coordinator.dispose();
  });
  it("ignores late responses after another edit and after disposal", async () => {
    vi.useFakeTimers();
    let resolve!: (r: TeamAssessment) => void;
    const publish = vi.fn();
    const coordinator = createTeamDraftCoordinator({
      assess: () =>
        new Promise((r) => {
          resolve = r;
        }),
      publish,
      onError: vi.fn(),
    });
    coordinator.schedule(draft);
    await vi.advanceTimersByTimeAsync(450);
    coordinator.schedule({ ...draft, revision: 2 });
    resolve(result(draft));
    await Promise.resolve();
    expect(publish.mock.calls.every((c) => c[0] === null)).toBe(true);
    coordinator.dispose();
    await vi.advanceTimersByTimeAsync(450);
  });
  it("does not classify incomplete IME input", async () => {
    vi.useFakeTimers();
    const assess = vi.fn(async (d: TeamDraft) => result(d));
    const coordinator = createTeamDraftCoordinator({ assess, publish: vi.fn(), onError: vi.fn() });
    coordinator.schedule(draft, true);
    await vi.advanceTimersByTimeAsync(1000);
    expect(assess).not.toHaveBeenCalled();
    coordinator.schedule(draft, false);
    await vi.advanceTimersByTimeAsync(450);
    expect(assess).toHaveBeenCalledOnce();
    coordinator.dispose();
  });
});

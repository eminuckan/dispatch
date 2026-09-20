// @effect-diagnostics globalTimers:off -- Browser draft debouncing lives outside an Effect runtime and owns its cancellation synchronously.
import type { TeamAssessment, TeamDraft } from "@dispatch/contracts";

/** Owns only preview work. It cannot create sessions, worktrees or provider turns. */
export function createTeamDraftCoordinator(options: {
  assess: (draft: TeamDraft) => Promise<TeamAssessment>;
  publish: (assessment: TeamAssessment | null) => void;
  onError: () => void;
  delayMs?: number;
}) {
  let generation = 0;
  let timer: ReturnType<typeof globalThis.setTimeout> | undefined;
  let disposed = false;
  const invalidate = () => {
    generation++;
    globalThis.clearTimeout(timer);
    timer = undefined;
    options.publish(null);
  };
  return {
    schedule(draft: TeamDraft, composing = false) {
      invalidate();
      if (disposed || composing || !draft.prompt.trim()) return;
      const expected = generation;
      timer = globalThis.setTimeout(() => {
        void options.assess(draft).then(
          (result) => {
            if (
              !disposed &&
              expected === generation &&
              result.draftId === draft.draftId &&
              result.revision === draft.revision &&
              result.policyRevision === draft.policyRevision
            )
              options.publish(result);
          },
          () => {
            if (!disposed && expected === generation) options.onError();
          },
        );
      }, options.delayMs ?? 450);
    },
    invalidate,
    dispose() {
      disposed = true;
      invalidate();
    },
  };
}

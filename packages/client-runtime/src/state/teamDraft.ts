import type { TeamAssessment, TeamDraft } from "@t3tools/contracts";

/** Owns only preview work. It cannot create sessions, worktrees or provider turns. */
export function createTeamDraftCoordinator(options: {
  assess: (draft: TeamDraft) => Promise<TeamAssessment>;
  publish: (assessment: TeamAssessment | null) => void;
  onError: () => void;
  delayMs?: number;
}) {
  let generation = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;
  const invalidate = () => {
    generation++;
    clearTimeout(timer);
    timer = undefined;
    options.publish(null);
  };
  return {
    schedule(draft: TeamDraft, composing = false) {
      invalidate();
      if (disposed || composing || !draft.prompt.trim()) return;
      const expected = generation;
      timer = setTimeout(() => {
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

import type { TeamThreadView, ThreadId } from "@dispatch/contracts";

export type TeamThreadComposerAccess = "checking" | "unavailable" | "worker" | null;
type TeamThreadOwnership = Pick<TeamThreadView, "leadThreadId" | "tasks">;

/**
 * Managed lead threads use the canonical `-lead` suffix; worker IDs are
 * checked against the persisted run before the generic composer is exposed.
 */
export function isTeamWorkerThreadCandidate(threadId: ThreadId | string): boolean {
  return threadId.startsWith("team-") && !threadId.endsWith("-lead");
}

export function resolveTeamThreadComposerAccess(input: {
  readonly threadId: ThreadId | string;
  readonly run: TeamThreadOwnership | null;
  readonly resolved: boolean;
  readonly error: string | null;
}): TeamThreadComposerAccess {
  if (!isTeamWorkerThreadCandidate(input.threadId)) return null;

  if (input.run !== null) {
    if (input.run.leadThreadId === input.threadId) return null;
    return input.run.tasks.some((task) => task.owner.threadId === input.threadId) ? "worker" : null;
  }
  if (input.error !== null) return "unavailable";
  return input.resolved ? null : "checking";
}

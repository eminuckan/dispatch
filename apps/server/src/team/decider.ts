import { TeamError, type TeamRun, type TeamTask } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

export const PlanProposal = Schema.Struct({
  acceptance: Schema.optional(
    Schema.Array(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(2000))).check(
      Schema.isMinLength(1),
      Schema.isMaxLength(20),
    ),
  ),
  tasks: Schema.Array(
    Schema.Struct({
      id: Schema.String.check(Schema.isPattern(/^[a-z][a-z0-9_-]{0,63}$/)),
      objective: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(8000)),
      acceptance: Schema.Array(
        Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(2000)),
      ).check(Schema.isMinLength(1), Schema.isMaxLength(20)),
      dependencies: Schema.Array(Schema.String).check(Schema.isMaxLength(50)),
      profileId: Schema.String,
      context: Schema.String.check(Schema.isMaxLength(32000)),
    }),
  ).check(Schema.isMaxLength(50)),
  rationale: Schema.String.check(Schema.isMaxLength(8000)),
});
export type PlanProposal = typeof PlanProposal.Type;
const invalid = (message: string): never => {
  throw new TeamError({ code: "invalid", message });
};

/** Native assistant output is only a proposal. This checks the whole DAG before any admission. */
export function acceptPlan(run: TeamRun, proposal: PlanProposal): TeamRun {
  if (run.status !== "planning") invalid("A plan can only be installed while planning.");
  const nodes = new Map(proposal.tasks.map((task) => [task.id, task]));
  if (nodes.size !== proposal.tasks.length) invalid("Task IDs must be unique.");
  const done = new Set<string>();
  const visiting = new Set<string>();
  function visit(id: string) {
    if (done.has(id)) return;
    if (visiting.has(id)) invalid("Task dependencies contain a cycle.");
    const task = nodes.get(id);
    if (!task) return invalid("A dependency is missing from the plan.");
    if (!run.policy.profiles.some((p) => p.id === task.profileId && p.worker))
      invalid("Worker profile is not allowed.");
    visiting.add(id);
    for (const dependency of task.dependencies) visit(dependency);
    visiting.delete(id);
    done.add(id);
  }
  for (const id of nodes.keys()) visit(id);
  return {
    ...run,
    status: proposal.tasks.length === 0 ? "review" : "running",
    tasks: proposal.tasks.map((task) => ({
      ...task,
      status: "pending",
      generation: 0,
      attempts: 0,
      threadId: null,
      result: null,
    })),
    decisions: [...run.decisions, proposal.rationale],
    ...(run.execution
      ? {
          execution: {
            ...run.execution,
            acceptance: proposal.acceptance ?? run.execution.acceptance,
          },
        }
      : {}),
  };
}

export function readyTasks(run: TeamRun, unresolvedEffects: number): ReadonlyArray<TeamTask> {
  if (run.status !== "running") return [];
  const accepted = new Set(run.tasks.filter((t) => t.status === "accepted").map((t) => t.id));
  // Keep one slot available to the lead. Unknown dispatches retain their slot.
  const slots = Math.max(0, run.policy.maxActive - 1 - unresolvedEffects);
  return run.tasks
    .filter(
      (t) =>
        t.status === "pending" &&
        t.attempts < run.policy.maxAttempts &&
        t.dependencies.every((id) => accepted.has(id)),
    )
    .slice(0, slots);
}
export function receiveResult(
  run: TeamRun,
  taskId: string,
  generation: number,
  result: string,
): TeamRun {
  const task = run.tasks.find((t) => t.id === taskId);
  if (!task || task.generation !== generation || task.status !== "running")
    invalid("Stale or unexpected worker result.");
  // A worker's assertion of success is not acceptance evidence.
  return {
    ...run,
    tasks: run.tasks.map((t) => (t.id === taskId ? { ...t, status: "review", result } : t)),
  };
}
export function acceptTask(
  run: TeamRun,
  taskId: string,
  generation: number,
  evidence: ReadonlyArray<{ criterion: string; passed: boolean; artifact: string }>,
): TeamRun {
  const task = run.tasks.find((t) => t.id === taskId);
  if (!task || task.generation !== generation || task.status !== "review")
    return invalid("Task is not awaiting acceptance at this generation.");
  for (const criterion of task.acceptance) {
    if (!evidence.some((e) => e.criterion === criterion && e.passed && e.artifact.trim()))
      invalid("Every acceptance criterion needs passing evidence.");
  }
  const tasks = run.tasks.map((t) => (t.id === taskId ? { ...t, status: "accepted" as const } : t));
  return {
    ...run,
    tasks,
    status: tasks.every((t) => t.status === "accepted") ? "review" : run.status,
  };
}
export function retryTask(
  run: TeamRun,
  taskId: string,
  nextProfileId: string,
  reason: string,
  mode: "continue" | "handoff" = "continue",
): TeamRun {
  if (run.status !== "running") invalid("Recovery cannot resume a paused or terminal run.");
  if (!reason.trim()) invalid("Recovery requires a concrete correction or handoff reason.");
  const task = run.tasks.find((t) => t.id === taskId);
  if (!task || !["review", "failed"].includes(task.status))
    return invalid("Only settled attempts may be retried.");
  if (task.attempts >= run.policy.maxAttempts)
    invalid(
      "Recovery exhausted without acceptance. Inspect the unresolved criteria before continuing.",
    );
  const normalize = (text: string) => text.trim().replace(/\s+/g, " ").toLowerCase();
  if (task.recoveryHistory?.some((entry) => normalize(entry.correction) === normalize(reason)))
    invalid("Repeated correction without a new approach. Work is preserved for lead review.");
  if (
    task.result?.trim() &&
    task.recoveryHistory?.some(
      (entry) => entry.result && normalize(entry.result) === normalize(task.result!),
    )
  )
    invalid(
      "Worker repeated a previous result without acceptance. Work is preserved for lead review.",
    );
  if (!run.policy.profiles.some((p) => p.id === nextProfileId && p.worker))
    invalid("Retry profile is outside the allowed pool.");
  const previous = run.policy.profiles.find((p) => p.id === task.profileId);
  const next = run.policy.profiles.find((p) => p.id === nextProfileId);
  if (
    mode === "continue" &&
    (!previous ||
      !next ||
      previous.selection.instanceId !== next.selection.instanceId ||
      previous.selection.model !== next.selection.model)
  )
    invalid("Changing model or provider requires an explicit new-worker handoff.");
  return {
    ...run,
    status: "running",
    tasks: run.tasks.map((t) =>
      t.id === taskId
        ? {
            ...t,
            status: "pending",
            profileId: nextProfileId,
            threadId: mode === "continue" ? t.threadId : null,
            result: null,
            recoveryHistory: [
              ...(t.recoveryHistory ?? []),
              {
                generation: t.generation,
                profileId: t.profileId,
                result: t.result,
                correction: reason.trim(),
              },
            ],
          }
        : t,
    ),
    decisions: [...run.decisions, reason],
  };
}
/** Rehydration uses persisted contracts and accepted dependencies, never a lead's compacted transcript. */
export function contextPack(run: TeamRun, task: TeamTask): string {
  return JSON.stringify({
    version: 1,
    runId: run.id,
    taskId: task.id,
    generation: task.generation,
    objective: run.objective,
    runAcceptance: run.execution?.acceptance ?? [],
    task: { objective: task.objective, acceptance: task.acceptance, context: task.context },
    decisions: run.decisions,
    recovery: task.recoveryHistory ?? [],
    dependencies: task.dependencies.map((id) => {
      const dep = run.tasks.find((t) => t.id === id);
      return { id, status: dep?.status, result: dep?.status === "accepted" ? dep.result : null };
    }),
  });
}

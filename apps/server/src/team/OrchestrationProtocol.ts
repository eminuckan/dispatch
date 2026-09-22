import { TeamError, type TeamRun, type TeamTask } from "@dispatch/contracts";
import * as Schema from "effect/Schema";

const Criterion = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(2_000));
const TaskId = Schema.String.check(Schema.isPattern(/^[a-z][a-z0-9_-]{0,63}$/));

export const OrchestrationPlan = Schema.Struct({
  acceptance: Schema.Array(Criterion).check(Schema.isMinLength(1), Schema.isMaxLength(20)),
  tasks: Schema.Array(
    Schema.Struct({
      id: TaskId,
      objective: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(8_000)),
      acceptance: Schema.Array(Criterion).check(Schema.isMinLength(1), Schema.isMaxLength(20)),
      dependencies: Schema.Array(TaskId).check(Schema.isMaxLength(50)),
      preferredProfileId: Schema.optional(Schema.NullOr(Schema.String)),
      context: Schema.String.check(Schema.isMaxLength(32_000)),
    }),
  ).check(Schema.isMaxLength(24)),
  rationale: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(8_000)),
});
export type OrchestrationPlan = typeof OrchestrationPlan.Type;

export const WorkerResult = Schema.Struct({
  summary: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(8_000)),
  commit: Schema.String.check(Schema.isMinLength(7), Schema.isMaxLength(256)),
  changedFiles: Schema.Array(Schema.String.check(Schema.isMaxLength(4_000))).check(
    Schema.isMaxLength(500),
  ),
  checks: Schema.Array(
    Schema.Struct({
      command: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128)),
      args: Schema.Array(Schema.String.check(Schema.isMaxLength(4_000))).check(
        Schema.isMaxLength(40),
      ),
      outcome: Schema.String.check(Schema.isMaxLength(4_000)),
    }),
  ).check(Schema.isMaxLength(40)),
  limitations: Schema.Array(Schema.String.check(Schema.isMaxLength(4_000))).check(
    Schema.isMaxLength(20),
  ),
});
export type WorkerResult = typeof WorkerResult.Type;

export const ReviewResult = Schema.Struct({
  action: Schema.Literals(["accept", "correct"]),
  summary: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(8_000)),
  checks: Schema.Array(
    Schema.Struct({
      criterionIndex: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 19 })),
      command: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128)),
      args: Schema.Array(Schema.String.check(Schema.isMaxLength(4_000))).check(
        Schema.isMaxLength(40),
      ),
    }),
  ).check(Schema.isMaxLength(20)),
});
export type ReviewResult = typeof ReviewResult.Type;

export const IntegrationResult = ReviewResult;
export type IntegrationResult = typeof IntegrationResult.Type;

export function parseProtocol<A, I>(schema: Schema.Codec<A, I>, text: string): A {
  const trimmed = text.trim();
  const json = trimmed.replace(/^```(?:json)?\s*\n([\s\S]*?)\n```$/, "$1");
  return Schema.decodeUnknownSync(Schema.fromJsonString(schema))(json);
}

export function validatePlanGraph(plan: OrchestrationPlan): void {
  const byId = new Map(plan.tasks.map((task) => [task.id, task]));
  if (byId.size !== plan.tasks.length)
    throw new TeamError({ code: "invalid", message: "Flow task IDs must be unique." });

  const complete = new Set<string>();
  const visiting = new Set<string>();
  const visit = (id: string): void => {
    if (complete.has(id)) return;
    if (visiting.has(id))
      throw new TeamError({
        code: "invalid",
        message: "Flow task dependencies contain a cycle.",
      });
    const task = byId.get(id);
    if (!task) throw new TeamError({ code: "invalid", message: `Missing task dependency: ${id}.` });
    visiting.add(id);
    for (const dependency of task.dependencies) visit(dependency);
    visiting.delete(id);
    complete.add(id);
  };
  for (const id of byId.keys()) visit(id);
}

export function reviewCoversAll(criteria: ReadonlyArray<string>, review: ReviewResult): boolean {
  if (review.action !== "accept") return true;
  return criteria.every((_, index) =>
    review.checks.some((check) => check.criterionIndex === index),
  );
}

export function taskDependenciesSettled(run: TeamRun, task: TeamTask): boolean {
  return task.dependencies.every(
    (dependency) =>
      run.tasks.find((candidate) => candidate.id === dependency)?.status === "settled",
  );
}

export function readyTasks(run: TeamRun): ReadonlyArray<TeamTask> {
  if (run.status !== "running") return [];
  const running = run.tasks.filter((task) =>
    ["running", "review", "settling"].includes(task.status),
  );
  const workerSlots = Math.max(0, run.policy.maxActive - 1 - running.length);
  return run.tasks
    .filter((task) => task.status === "pending" && taskDependenciesSettled(run, task))
    .slice(0, workerSlots);
}

export function sharedContextPack(run: TeamRun, task: TeamTask): string {
  const acceptedDependencies = task.dependencies.flatMap((dependencyId) => {
    const dependency = run.tasks.find((candidate) => candidate.id === dependencyId);
    if (!dependency || dependency.status !== "settled") return [];
    const settlement = dependency.settlementId
      ? run.settlements.find((candidate) => candidate.id === dependency.settlementId)
      : undefined;
    return [
      {
        id: dependency.id,
        objective:
          dependency.objective.length <= 800
            ? dependency.objective
            : `${dependency.objective.slice(0, 780)}...[truncated]`,
        result:
          dependency.result === null
            ? null
            : dependency.result.length <= 1_600
              ? dependency.result
              : `${dependency.result.slice(0, 1_580)}...[truncated]`,
        appliedCommit: settlement?.appliedCommit ?? null,
      },
    ];
  });
  const payload = {
    version: 2,
    runId: run.id,
    objective:
      run.prompt.length <= 6_000 ? run.prompt : `${run.prompt.slice(0, 5_980)}...[truncated]`,
    task: {
      id: task.id,
      objective:
        task.objective.length <= 4_000
          ? task.objective
          : `${task.objective.slice(0, 3_980)}...[truncated]`,
      acceptance: task.acceptance.map((criterion) =>
        criterion.length <= 500 ? criterion : `${criterion.slice(0, 480)}...[truncated]`,
      ),
      dependencies: task.dependencies,
    },
    acceptedDependencies,
    integrationHead: run.workspace?.integrationHead ?? null,
  };
  const encoded = JSON.stringify(payload);
  if (encoded.length <= 24_000) return encoded;
  return JSON.stringify({
    version: 2,
    runId: run.id,
    objective:
      run.prompt.length <= 2_000 ? run.prompt : `${run.prompt.slice(0, 1_980)}...[truncated]`,
    task: {
      id: task.id,
      objective:
        task.objective.length <= 1_500
          ? task.objective
          : `${task.objective.slice(0, 1_480)}...[truncated]`,
      acceptance: task.acceptance.map((criterion) =>
        criterion.length <= 220 ? criterion : `${criterion.slice(0, 200)}...[truncated]`,
      ),
      dependencies: task.dependencies,
    },
    acceptedDependencies: acceptedDependencies.map((dependency) => ({
      id: dependency.id,
      appliedCommit: dependency.appliedCommit,
    })),
    integrationHead: run.workspace?.integrationHead ?? null,
  });
}

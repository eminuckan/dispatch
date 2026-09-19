import { TeamError, type TeamExecutionTurn, type TeamRun } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

export const LeadReview = Schema.Struct({
  action: Schema.Literals(["accept", "correct"]),
  summary: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(8000)),
  checks: Schema.Array(
    Schema.Struct({
      criterionIndex: Schema.optional(
        Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 19 })),
      ),
      criterion: Schema.String.check(Schema.isMinLength(1)),
      command: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128)),
      args: Schema.Array(Schema.String.check(Schema.isMaxLength(4000))).check(
        Schema.isMaxLength(40),
      ),
    }),
  ).check(Schema.isMaxLength(20)),
});
export type LeadReview = typeof LeadReview.Type;

export function parseProposal<A, I>(schema: Schema.Codec<A, I>, text: string): A {
  // Only unwrap one complete JSON fence, never search prose for a convenient object.
  const input = text.trim().replace(/^```(?:json)?\s*\n([\s\S]*?)\n```$/, "$1");
  return Schema.decodeUnknownSync(Schema.fromJsonString(schema))(input);
}

export function admitExecutionTurn(run: TeamRun, turn: TeamExecutionTurn): TeamRun {
  const fail = (message: string): never => {
    throw new TeamError({ code: "invalid", message });
  };
  const execution = run.execution;
  if (!execution) return fail("Run has no execution contract.");
  if (turn.role !== "worker") {
    if (
      turn.command.threadId !== execution.leadThreadId ||
      turn.command.modelSelection?.instanceId !== run.lead.selection.instanceId ||
      turn.command.modelSelection?.model !== run.lead.selection.model
    )
      fail("Lead identity is fixed for the lifetime of the run.");
    return { ...run, execution: { ...execution, turns: [...execution.turns, turn] } };
  }
  const task = run.tasks.find((t) => t.id === turn.taskId);
  if (!task || task.status !== "pending" || task.attempts >= run.policy.maxAttempts)
    return fail("Worker is not ready or its attempt budget is exhausted.");
  if (
    task.dependencies.some((id) => !run.tasks.some((t) => t.id === id && t.status === "accepted"))
  )
    fail("Worker dependencies have not been accepted.");
  const profile = run.policy.profiles.find((p) => p.id === task.profileId && p.worker);
  if (
    !profile ||
    turn.command.modelSelection?.instanceId !== profile.selection.instanceId ||
    turn.command.modelSelection?.model !== profile.selection.model ||
    (task.threadId !== null && task.threadId !== turn.command.threadId)
  )
    fail("Worker identity differs from its approved contract.");
  return {
    ...run,
    tasks: run.tasks.map((t) =>
      t.id !== task.id
        ? t
        : {
            ...t,
            status: "running",
            generation: t.generation + 1,
            attempts: t.attempts + 1,
            threadId: turn.command.threadId,
          },
    ),
    execution: { ...execution, turns: [...execution.turns, turn] },
  };
}

export function reviewCoverage(
  criteria: ReadonlyArray<string>,
  checks: LeadReview["checks"],
): boolean {
  return criteria.every((criterion, index) =>
    checks.some(
      (check) =>
        check.criterionIndex === index ||
        (check.criterionIndex === undefined && check.criterion === criterion),
    ),
  );
}

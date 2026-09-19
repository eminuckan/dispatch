import {
  NumberField,
  NumberFieldGroup,
  NumberFieldInput,
  NumberFieldDecrement,
  NumberFieldIncrement,
} from "../ui/number-field";
import {
  UsersIcon,
  ChevronDownIcon,
  RefreshCwIcon,
  ArrowUpRightIcon,
  LockKeyholeIcon,
} from "lucide-react";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { useState } from "react";
import type { EnvironmentId, ProjectId, TeamAssessment, TeamRun } from "@t3tools/contracts";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { teamEnvironment } from "../../state/team";
import { useAtomCommand } from "../../state/use-atom-command";
import { useEnvironmentQuery } from "../../state/query";
import { randomUUID } from "../../lib/utils";
import { Button } from "../ui/button";

export function TeamRunControls({
  environmentId,
  projectId,
  prompt,
  assessment,
  hasAttachments,
  composing,
  showStart = true,
}: {
  environmentId: EnvironmentId;
  projectId: ProjectId;
  prompt: string;
  assessment: TeamAssessment | null;
  hasAttachments: boolean;
  composing: boolean;
  showStart?: boolean;
}) {
  const start = useAtomCommand(teamEnvironment.start, { reportFailure: false });
  const control = useAtomCommand(teamEnvironment.control, { reportFailure: false });
  const runs = useEnvironmentQuery(teamEnvironment.list({ environmentId, input: {} }));
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [maxTurns, setMaxTurns] = useState(20);
  const [command, setCommand] = useState<{ prompt: string; id: string } | null>(null);
  async function submit() {
    if (!assessment || pending) return;
    setPending(true);
    setMessage(null);
    const id = command?.prompt === prompt ? command.id : randomUUID();
    setCommand({ prompt, id });
    const result = await start({
      environmentId,
      input: {
        commandId: id,
        projectId,
        fingerprint: assessment.fingerprint,
        maxTurns,
        draft: {
          draftId: assessment.draftId,
          revision: assessment.revision,
          policyRevision: assessment.policyRevision,
          prompt,
          hasAttachments,
        },
      },
    });
    setPending(false);
    if (result._tag === "Failure") {
      const error = squashAtomCommandFailure(result);
      setMessage(error instanceof Error ? error.message : "Could not start team.");
    } else {
      setMessage("Team started in isolated worktrees. Your draft remains available.");
      runs.refresh();
    }
  }
  async function change(run: TeamRun, action: "pause" | "resume" | "cancel" | "extend_budget") {
    if (pending) return;
    setPending(true);
    const result = await control({
      environmentId,
      input: {
        id: run.id,
        revision: run.revision,
        action,
        ...(action === "extend_budget"
          ? { maxTurns: Math.min(100, (run.execution?.maxTurns ?? 0) + 5) }
          : {}),
      },
    });
    setPending(false);
    if (result._tag === "Failure") {
      const error = squashAtomCommandFailure(result);
      setMessage(
        error instanceof Error ? error.message : "Team control failed; refresh its state.",
      );
    }
    runs.refresh();
  }
  const projectRuns = (runs.data ?? []).filter((run) => run.projectId === projectId).slice(0, 5);
  if (!showStart && projectRuns.length === 0) return null;
  return (
    <Popover>
      <PopoverTrigger
        render={
          <Button
            size="sm"
            variant="ghost"
            className="shrink-0 gap-1.5 font-normal text-muted-foreground"
            aria-label="Team controls"
          />
        }
      >
        <UsersIcon className="size-3.5" />
        Team
        {projectRuns.some((run) => !["completed", "cancelled", "failed"].includes(run.status))
          ? " · active"
          : ""}
        <ChevronDownIcon className="size-3" />
      </PopoverTrigger>
      <PopoverPopup
        side="top"
        align="end"
        className="w-96 max-w-[calc(100vw-2rem)]"
        viewportClassName="max-h-[70vh] overflow-y-auto"
      >
        <div className="space-y-4 text-xs leading-relaxed">
          <div>
            <h2 className="text-sm font-medium text-foreground">Team</h2>
            <p className="mt-1 text-muted-foreground">
              A lead coordinates workers and checks their results.
            </p>
          </div>
          {showStart && (
            <>
              <div className="flex items-center justify-between gap-4">
                <div>
                  <p className="font-medium text-foreground">Turn limit</p>
                  <p className="mt-0.5 text-muted-foreground">
                    Lead, workers and retries combined.
                  </p>
                </div>
                <NumberField
                  aria-label="Team turn limit"
                  size="sm"
                  className="w-28 shrink-0"
                  min={1}
                  max={100}
                  step={1}
                  value={maxTurns}
                  onValueChange={(value) => setMaxTurns(value ?? 20)}
                  disabled={pending}
                >
                  <NumberFieldGroup>
                    <NumberFieldDecrement aria-label="Decrease team turn limit" />
                    <NumberFieldInput aria-label="Team turn limit" />
                    <NumberFieldIncrement aria-label="Increase team turn limit" />
                  </NumberFieldGroup>
                </NumberField>
              </div>
              <div className="flex items-start gap-2 text-muted-foreground">
                <LockKeyholeIcon className="mt-0.5 size-3.5 shrink-0" />
                <p>
                  Full access in separate worktrees. Starts from your latest commit; uncommitted
                  changes are excluded.
                </p>
              </div>
              <Button
                className="w-full"
                size="sm"
                disabled={pending || !assessment?.selection || hasAttachments || composing}
                onClick={() => void submit()}
              >
                {pending ? "Starting…" : "Start team"}
              </Button>
              {hasAttachments ? (
                <p className="text-muted-foreground">
                  Team runs currently support text-only requests.
                </p>
              ) : (
                !assessment?.selection && (
                  <p className="text-muted-foreground">
                    Waiting for an eligible lead. Check Orchestration settings if no model becomes
                    available.
                  </p>
                )
              )}
            </>
          )}
          {(projectRuns.length > 0 || runs.error) && (
            <div className="border-t pt-3">
              <div className="mb-2 flex items-center justify-between gap-2">
                <h3 className="font-medium text-foreground">Recent teams</h3>
                <Button
                  size="icon-xs"
                  variant="ghost"
                  onClick={runs.refresh}
                  aria-label="Refresh teams"
                >
                  <RefreshCwIcon className="size-3.5" />
                </Button>
              </div>
              <div className="divide-y divide-border/50">
                {projectRuns.map((run) => (
                  <div key={run.id} className="space-y-2 py-3 first:pt-0 last:pb-0">
                    <div className="flex items-start justify-between gap-3">
                      <p className="line-clamp-2 min-w-0 font-medium text-foreground">
                        {run.objective}
                      </p>
                      {run.execution && (
                        <a
                          aria-label="Open team lead"
                          className="shrink-0 rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
                          href={`/${environmentId}/${run.execution.leadThreadId}`}
                        >
                          <ArrowUpRightIcon className="size-3.5" />
                        </a>
                      )}
                    </div>
                    <div className="flex items-center justify-between text-muted-foreground">
                      <span className="capitalize">{run.status}</span>
                      <span className="tabular-nums">
                        {run.execution?.turns.length ?? 0} / {run.execution?.maxTurns ?? 0} turns
                      </span>
                    </div>
                    {(run.tasks.length > 0 || run.execution?.notice) && (
                      <details className="text-muted-foreground">
                        <summary className="w-fit cursor-pointer hover:text-foreground">
                          {run.tasks.length ? `${run.tasks.length} work items` : "Run details"}
                        </summary>
                        <div className="mt-2 space-y-2">
                          {run.tasks.map((task) => (
                            <div key={task.id} className="space-y-1">
                              <p>{task.objective}</p>
                              <div className="flex justify-between gap-2">
                                <span>
                                  {task.status} · attempt {task.attempts}
                                </span>
                                {task.threadId && (
                                  <a
                                    className="underline underline-offset-2"
                                    href={`/${environmentId}/${task.threadId}`}
                                  >
                                    Open worker
                                  </a>
                                )}
                              </div>
                            </div>
                          ))}
                          {run.execution?.notice && <p>{run.execution.notice}</p>}
                        </div>
                      </details>
                    )}
                    {!["completed", "cancelled", "failed"].includes(run.status) && (
                      <div className="flex flex-wrap items-center gap-1">
                        <Button
                          size="xs"
                          variant="outline"
                          disabled={pending}
                          onClick={() =>
                            void change(run, run.status === "paused" ? "resume" : "pause")
                          }
                        >
                          {run.status === "paused" ? "Resume" : "Pause admission"}
                        </Button>
                        {(run.execution?.maxTurns ?? 100) < 100 && (
                          <Button
                            size="xs"
                            variant="ghost"
                            disabled={pending}
                            onClick={() => void change(run, "extend_budget")}
                          >
                            Add up to 5 turns
                          </Button>
                        )}
                        <Button
                          size="xs"
                          variant="ghost"
                          disabled={pending}
                          onClick={() => void change(run, "cancel")}
                        >
                          Cancel
                        </Button>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}
          {(message || runs.error) && (
            <p role="status" className="border-t pt-3 text-muted-foreground">
              {message ?? runs.error}
            </p>
          )}
        </div>
      </PopoverPopup>
    </Popover>
  );
}

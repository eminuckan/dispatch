import { UsersIcon, ChevronDownIcon } from "lucide-react";
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
      <PopoverPopup side="top" align="end" className="w-96 max-w-[calc(100vw-2rem)] text-xs">
        <div className="max-h-96 space-y-3 overflow-y-auto leading-relaxed">
          <p className="font-medium text-foreground">Managed team</p>
          {showStart && (
            <div className="flex flex-wrap items-center gap-2">
              <Button
                size="sm"
                variant="outline"
                disabled={pending || !assessment?.selection || hasAttachments || composing}
                onClick={() => void submit()}
              >
                Start team
              </Button>
              <label>
                Turn limit{" "}
                <input
                  aria-label="Team turn limit"
                  className="ml-1 w-16 rounded-md border bg-background px-2 py-1 tabular-nums"
                  type="number"
                  min={1}
                  max={100}
                  value={maxTurns}
                  onChange={(e) =>
                    setMaxTurns(Math.min(100, Math.max(1, Number(e.target.value) || 1)))
                  }
                />
              </label>
              <Button size="sm" variant="ghost" onClick={runs.refresh}>
                Refresh teams
              </Button>
            </div>
          )}
          <p className="text-muted-foreground">
            Runs with full access in separate worktrees, starting from your latest commit. Unsaved
            changes are excluded. The turn limit includes the lead, workers and retries.
          </p>
          {!showStart && (
            <Button size="sm" variant="ghost" onClick={runs.refresh}>
              Refresh teams
            </Button>
          )}
          {projectRuns.map((run) => (
            <div key={run.id} className="mt-2 border-t pt-2">
              <div>
                {run.objective.slice(0, 100)} · {run.status} · {run.execution?.turns.length ?? 0}/
                {run.execution?.maxTurns ?? 0} turns
              </div>
              {run.execution && (
                <a className="underline" href={`/${environmentId}/${run.execution.leadThreadId}`}>
                  Open lead
                </a>
              )}
              {run.tasks.map((task) => (
                <div key={task.id}>
                  {task.objective.slice(0, 70)} · {task.status} · attempt {task.attempts}
                  {task.threadId && (
                    <>
                      {" "}
                      ·{" "}
                      <a className="underline" href={`/${environmentId}/${task.threadId}`}>
                        Open worker
                      </a>
                    </>
                  )}
                </div>
              ))}
              {run.execution?.notice && <p>{run.execution.notice}</p>}
              {!["completed", "cancelled", "failed"].includes(run.status) && (
                <div className="flex gap-2">
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={pending}
                    onClick={() => void change(run, run.status === "paused" ? "resume" : "pause")}
                  >
                    {run.status === "paused" ? "Resume" : "Pause admission"}
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={pending}
                    onClick={() => void change(run, "cancel")}
                  >
                    Cancel team
                  </Button>
                  {(run.execution?.maxTurns ?? 100) < 100 && (
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={pending}
                      onClick={() => void change(run, "extend_budget")}
                    >
                      Add up to 5 turns
                    </Button>
                  )}
                </div>
              )}
            </div>
          ))}
          {(message || runs.error) && (
            <p role="status" className="mt-2">
              {message ?? runs.error}
            </p>
          )}
        </div>
      </PopoverPopup>
    </Popover>
  );
}

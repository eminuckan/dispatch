import { useAtomCommand } from "../../state/use-atom-command";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { useRightPanelStore } from "../../rightPanelStore";
import { Link } from "@tanstack/react-router";
import type { TimelineEntry } from "../../session-logic";
import { teamConversationEntries, teamAgentName, teamTurnLabel } from "./teamConversation.logic";
import { useEffect, useState, type ReactNode } from "react";
import { ChevronRightIcon, RefreshCwIcon } from "lucide-react";
import type { EnvironmentId, TeamThreadView, ThreadId } from "@t3tools/contracts";
import { teamEnvironment } from "../../state/team";
import { useEnvironmentQuery } from "../../state/query";
import { Button } from "../ui/button";
import { ScrollArea } from "../ui/scroll-area";
import ChatMarkdown from "../ChatMarkdown";
import { useThreadShell } from "../../state/entities";

/** Exact persisted membership owns presentation; never classify arbitrary assistant JSON. */
export function TeamConversation({
  environmentId,
  threadId,
  children,
  entries,
}: {
  environmentId: EnvironmentId;
  threadId: ThreadId;
  entries: TimelineEntry[];
  children: (entries: TimelineEntry[]) => ReactNode;
}) {
  const query = useEnvironmentQuery(
    teamEnvironment.forThread({ environmentId, input: { threadId } }),
  );
  const run = query.data;
  const refresh = query.refresh;
  const live =
    run &&
    (!["completed", "cancelled", "failed"].includes(run.status) ||
      run.turns.some((t) => t.status !== "settled"));
  useEffect(() => {
    if (!live) return;
    // The team ledger also changes between native turns; do not subscribe to token deltas.
    const timer = window.setInterval(() => {
      if (!document.hidden) refresh();
    }, 3000);
    return () => window.clearInterval(timer);
  }, [live, refresh]);
  useEffect(() => {
    const onFocus = () => refresh();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [refresh]);

  if (!run) {
    if (query.isSuccess || !threadId.startsWith("team-")) return children(entries);
    return (
      <div className="p-6 text-sm text-muted-foreground" role="status">
        {query.error ? "Team activity could not be loaded." : "Loading team activity…"}
        {query.error && (
          <Button size="xs" variant="ghost" onClick={refresh}>
            Retry
          </Button>
        )}
      </div>
    );
  }
  const initialTurn = run.turns.find((turn) => turn.threadId === threadId);
  const objective =
    threadId === run.leadThreadId
      ? run.objective
      : (run.tasks.find((task) => task.threadId === threadId)?.objective ?? run.objective);
  const visibleEntries = teamConversationEntries(
    entries,
    run.coordinationMessageIds,
    initialTurn ? { id: `team-${initialTurn.id}`, objective } : undefined,
    run.turns,
  );
  return (
    <>
      {run.tasks.map((task) =>
        task.threadId && task.threadId !== threadId ? (
          <TeamPendingRequest
            key={task.threadId}
            environmentId={environmentId}
            threadId={task.threadId}
            name={teamAgentName(run, task.threadId)}
          />
        ) : null,
      )}
      {threadId !== run.leadThreadId && (
        <TeamPendingRequest
          environmentId={environmentId}
          threadId={run.leadThreadId}
          name={teamAgentName(run, run.leadThreadId)}
        />
      )}
      {query.error && (
        <p role="status" className="px-5 py-2 text-xs text-destructive">
          Activity refresh failed. Showing the last received state.
        </p>
      )}
      {children(visibleEntries)}
    </>
  );
}

function TeamPendingRequest({
  environmentId,
  threadId,
  name,
}: {
  environmentId: EnvironmentId;
  threadId: ThreadId;
  name: string;
}) {
  const shell = useThreadShell({ environmentId, threadId });
  if (!shell?.hasPendingApprovals && !shell?.hasPendingUserInput) return null;
  return (
    <Link
      to="/$environmentId/$threadId"
      params={{ environmentId, threadId }}
      className="px-5 py-2 text-sm text-foreground underline underline-offset-4"
      aria-live="polite"
    >
      {name} ·{" "}
      {shell.hasPendingApprovals && shell.hasPendingUserInput
        ? "Approval and answer needed"
        : shell.hasPendingApprovals
          ? "Approval needed"
          : "Answer needed"}
    </Link>
  );
}

function TeamAgentStatus({
  environmentId,
  threadId,
  fallback,
}: {
  environmentId: EnvironmentId;
  threadId: ThreadId | null;
  fallback: string;
}) {
  const shell = useThreadShell(threadId ? { environmentId, threadId } : null);
  return shell?.hasPendingApprovals
    ? "Approval needed"
    : shell?.hasPendingUserInput
      ? "Answer needed"
      : fallback;
}

function TeamAgentProgress({
  environmentId,
  threadId,
  objective,
}: {
  environmentId: EnvironmentId;
  threadId: ThreadId | null;
  objective: string;
}) {
  const shell = useThreadShell(threadId ? { environmentId, threadId } : null);
  return shell?.planProgress?.step ?? objective;
}

function TeamActivity({
  run,
  environmentId,
  threadId,
  cwd,
  refresh,
  error,
}: {
  run: TeamThreadView;
  environmentId: EnvironmentId;
  threadId: ThreadId;
  cwd: string | undefined;
  refresh: () => void;
  error: string | null;
}) {
  const control = useAtomCommand(teamEnvironment.control, { reportFailure: false });
  const [controlPending, setControlPending] = useState(false);
  const [controlError, setControlError] = useState<string | null>(null);
  async function change(action: "pause" | "resume" | "cancel") {
    if (controlPending) return;
    setControlPending(true);
    setControlError(null);
    const result = await control({
      environmentId,
      input: { id: run.id, revision: run.revision, action },
    });
    setControlPending(false);
    if (result._tag === "Failure") {
      const error = squashAtomCommandFailure(result);
      setControlError(error instanceof Error ? error.message : "Could not update orchestration.");
    }
    refresh();
  }
  const leadTurn = run.turns.findLast((turn) => turn.threadId === run.leadThreadId);
  const leadStatus = ["completed", "failed", "cancelled", "paused"].includes(run.status)
    ? run.status
    : leadTurn && leadTurn.status !== "settled"
      ? leadTurn.status === "reserved"
        ? "queued"
        : "running"
      : "waiting";
  const agents = [
    {
      id: run.leadThreadId,
      role: "Lead",
      name: teamAgentName(run, run.leadThreadId),
      objective: run.objective,
      model: run.lead.label,
      effort: run.turns.find((t) => t.threadId === run.leadThreadId)?.effort,
      status: leadStatus,
      attempts: 0,
    },
    ...run.tasks.map((task, index) => {
      const turn = run.turns.findLast((t) => t.role === "worker" && t.taskId === task.id);
      return {
        id: task.threadId,
        role: "Worker",
        name: task.threadId ? teamAgentName(run, task.threadId) : `Worker ${index + 1}`,
        objective: task.objective,
        model: turn?.model ?? "Waiting for assignment",
        effort: turn?.effort,
        status: task.status,
        attempts: task.attempts,
      };
    }),
  ];
  const working = new Set(
    run.turns
      .filter((turn) => turn.status === "dispatching" || turn.status === "dispatched")
      .map((turn) => turn.threadId),
  ).size;
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center justify-between px-3 py-2 text-xs text-muted-foreground">
        <span>
          {agents.length} agents<span className="mx-1.5">·</span>
          <span className="capitalize">{run.status}</span>
        </span>
        <Button
          size="icon-micro"
          variant="ghost-muted"
          aria-label="Refresh team activity"
          onClick={refresh}
        >
          <RefreshCwIcon className="size-3" />
        </Button>
      </div>
      <ScrollArea className="min-h-0 flex-1">
        <div className="space-y-1 px-2 pb-3">
          {agents.map((agent, index) => {
            const successful = ["accepted", "completed"].includes(agent.status);
            const active = ["planning", "running", "review"].includes(agent.status);
            const body = (
              <>
                <span
                  aria-hidden
                  className={`col-start-1 row-start-1 size-1.5 rounded-full ${successful ? "bg-success" : agent.status === "failed" ? "bg-destructive" : active ? "bg-info" : "bg-muted-foreground/50"}`}
                />
                <span className="col-start-2 row-start-1 flex min-w-0 items-baseline gap-2">
                  <span className="truncate text-sm font-medium">{agent.name}</span>
                  <span className="font-mono text-[.65rem] text-muted-foreground">
                    {agent.role}
                  </span>
                </span>
                <span className="col-start-3 row-start-1 text-right text-[.7rem] capitalize text-muted-foreground">
                  <TeamAgentStatus
                    environmentId={environmentId}
                    threadId={agent.id}
                    fallback={agent.status}
                  />
                </span>
                <span className="col-start-2 col-end-4 row-start-2 truncate text-xs text-muted-foreground">
                  <TeamAgentProgress
                    environmentId={environmentId}
                    threadId={agent.id}
                    objective={agent.objective}
                  />
                </span>
                <span className="col-start-2 col-end-4 row-start-3 truncate font-mono text-[.7rem] text-muted-foreground/70">
                  {[
                    agent.model,
                    agent.effort,
                    agent.attempts > 0 ? `attempt ${agent.attempts}` : null,
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                </span>
              </>
            );
            const rowClass =
              "grid h-[3.875rem] grid-cols-[0.375rem_minmax(0,1fr)_auto] grid-rows-[1.25rem_1.125rem_1rem] items-center gap-x-2 rounded-md px-1.5 py-1";
            return agent.id ? (
              <Link
                key={agent.id}
                to="/$environmentId/$threadId"
                params={{ environmentId, threadId: agent.id }}
                onClick={() => {
                  if (agent.id)
                    useRightPanelStore
                      .getState()
                      .open({ environmentId, threadId: agent.id }, "agents");
                }}
                aria-current={agent.id === threadId ? "page" : undefined}
                className={`${rowClass} hover:bg-accent/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${agent.id === threadId ? "bg-accent/40" : ""}`}
              >
                {body}
              </Link>
            ) : (
              <div key={run.tasks[index - 1]?.id ?? "unassigned"} className={rowClass}>
                {body}
              </div>
            );
          })}
          {error && (
            <p role="status" className="px-1.5 py-2 text-xs text-destructive">
              Activity refresh failed. Showing the last received state.
            </p>
          )}
          {run.notice && run.status !== "completed" && (
            <details className="px-1.5 pt-3 text-xs text-muted-foreground">
              <summary className="cursor-pointer py-1 hover:text-foreground">
                {run.status === "paused" ? "Why paused" : "Team status details"}
              </summary>
              <div className="py-2">
                <ChatMarkdown text={run.notice} cwd={cwd} environmentId={environmentId} />
              </div>
            </details>
          )}
          <details className="px-1.5 pt-3 text-xs text-muted-foreground">
            <summary className="cursor-pointer py-1 hover:text-foreground">
              Activity history
            </summary>
            <div className="mt-2 space-y-1">
              {run.turns.map((turn) => (
                <details key={turn.id} className="py-1">
                  <summary className="cursor-pointer py-1 hover:text-foreground">
                    {teamAgentName(run, turn.threadId)} · {teamTurnLabel(run, turn)}
                  </summary>
                  <div className="space-y-2 py-2">
                    <Link
                      to="/$environmentId/$threadId"
                      params={{ environmentId, threadId: turn.threadId }}
                      onClick={() =>
                        useRightPanelStore
                          .getState()
                          .open({ environmentId, threadId: turn.threadId }, "agents")
                      }
                      className="inline-flex items-center gap-1 hover:text-foreground hover:underline"
                    >
                      Open {teamAgentName(run, turn.threadId)}
                      <ChevronRightIcon className="size-3" />
                    </Link>
                    {turn.summary ? (
                      <ChatMarkdown text={turn.summary} cwd={cwd} environmentId={environmentId} />
                    ) : (
                      <p>
                        {turn.status === "settled"
                          ? turn.succeeded
                            ? "Handoff recorded."
                            : "This attempt needs attention. Check the team update."
                          : "The agent is working."}
                      </p>
                    )}
                  </div>
                </details>
              ))}
            </div>
          </details>
        </div>
      </ScrollArea>
      {controlError && (
        <p role="alert" className="px-3 py-1 text-xs text-destructive">
          {controlError}
        </p>
      )}
      {!["completed", "cancelled", "failed"].includes(run.status) && (
        <div className="flex items-center gap-1 px-3 py-1">
          <Button
            size="xs"
            variant="ghost"
            disabled={controlPending}
            onClick={() => void change(run.status === "paused" ? "resume" : "pause")}
          >
            {run.status === "paused" ? "Resume" : "Pause"}
          </Button>
          <Button
            size="xs"
            variant="ghost"
            disabled={controlPending}
            onClick={() => void change("cancel")}
          >
            Cancel
          </Button>
        </div>
      )}
      <footer className="flex items-center justify-between px-3 py-2 font-mono text-[.7rem] text-muted-foreground">
        <span>
          {working > 0
            ? `${working} working`
            : `${run.tasks.filter((task) => task.status === "accepted").length} / ${run.tasks.length} tasks accepted`}
        </span>
        <span>{run.turns.length} activity steps</span>
      </footer>
    </div>
  );
}

/** Uses the same query atom as the conversation: one polling owner, shared live data. */
export function TeamAgentsPanel({
  environmentId,
  threadId,
  cwd,
  children,
}: {
  environmentId: EnvironmentId | null;
  threadId: ThreadId | null;
  cwd: string | undefined;
  children: ReactNode;
}) {
  const query = useEnvironmentQuery(
    environmentId && threadId
      ? teamEnvironment.forThread({ environmentId, input: { threadId } })
      : null,
  );
  if (!environmentId || !threadId) return children;
  if (!query.data) {
    if (query.isSuccess || !threadId.startsWith("team-")) return children;
    return (
      <div className="p-4 text-xs text-muted-foreground" role="status">
        {query.error ? "Could not load team activity." : "Loading agents…"}
        {query.error && (
          <Button size="xs" variant="ghost" onClick={query.refresh}>
            Retry
          </Button>
        )}
      </div>
    );
  }
  return (
    <TeamActivity
      run={query.data}
      environmentId={environmentId}
      threadId={threadId}
      cwd={cwd}
      refresh={query.refresh}
      error={query.error}
    />
  );
}

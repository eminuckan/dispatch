import { useRightPanelStore } from "../../rightPanelStore";
import { Link } from "@tanstack/react-router";
import type { TimelineEntry } from "../../session-logic";
import { teamFollowUpEntries, teamAgentName, teamTurnLabel } from "./teamConversation.logic";
import { useEffect, type ReactNode } from "react";
import { ChevronRightIcon, RefreshCwIcon, UsersIcon } from "lucide-react";
import type { EnvironmentId, TeamThreadView, ThreadId } from "@t3tools/contracts";
import { teamEnvironment } from "../../state/team";
import { useEnvironmentQuery } from "../../state/query";
import { Button } from "../ui/button";
import { ScrollArea } from "../ui/scroll-area";
import ChatMarkdown from "../ChatMarkdown";

const phaseLabels = {
  plan: "Planning",
  workers: "Working with agents",
  integrate: "Verifying the combined result",
  done: "Finished",
};
/** Exact persisted membership owns presentation; never classify arbitrary assistant JSON. */
export function TeamConversation({
  environmentId,
  threadId,
  cwd,
  bottomInset,
  children,
  entries,
  onOpenAgents,
}: {
  environmentId: EnvironmentId;
  threadId: ThreadId;
  cwd: string | undefined;
  bottomInset: number;
  onOpenAgents: () => void;
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
  const followUps = teamFollowUpEntries(entries, run.coordinationMessageIds);
  return (
    <TeamChatActivity
      run={run}
      environmentId={environmentId}
      threadId={threadId}
      cwd={cwd}
      bottomInset={bottomInset}
      onOpenAgents={onOpenAgents}
      error={query.error}
      followUp={followUps.length > 0 ? children(followUps) : null}
    />
  );
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
                  {agent.status}
                </span>
                <span className="col-start-2 col-end-4 row-start-2 truncate text-xs text-muted-foreground">
                  {agent.objective}
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
            <p role="status" className="px-1.5 py-2 text-xs text-muted-foreground">
              {run.notice}
            </p>
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
                  <div className="py-2">
                    {turn.summary ? (
                      <ChatMarkdown text={turn.summary} cwd={cwd} environmentId={environmentId} />
                    ) : (
                      <p>
                        {turn.status === "settled" ? "Handoff recorded." : "The agent is working."}
                      </p>
                    )}
                  </div>
                </details>
              ))}
            </div>
          </details>
        </div>
      </ScrollArea>
      <footer className="flex items-center justify-between px-3 py-2 font-mono text-[.7rem] text-muted-foreground">
        <span>
          {working > 0
            ? `${working} working`
            : `${run.tasks.filter((task) => task.status === "accepted").length} / ${run.tasks.length} tasks accepted`}
        </span>
        <span>
          {run.turns.length} / {run.maxTurns} turns
        </span>
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

function TeamChatActivity({
  run,
  environmentId,
  threadId,
  cwd,
  bottomInset,
  onOpenAgents,
  error,
  followUp,
}: {
  run: TeamThreadView;
  environmentId: EnvironmentId;
  threadId: ThreadId;
  cwd: string | undefined;
  bottomInset: number;
  onOpenAgents: () => void;
  error: string | null;
  followUp: ReactNode;
}) {
  const isLead = run.leadThreadId === threadId;
  const turns = isLead ? run.turns : run.turns.filter((turn) => turn.threadId === threadId);
  const result = isLead
    ? run.notice
    : turns.findLast((turn) => turn.role === "worker" && turn.summary)?.summary;
  const latest = turns.at(-1);
  const active = turns.some((turn) => turn.status !== "settled");
  return (
    <ScrollArea className="flex-1">
      <div
        className="mx-auto w-full max-w-3xl space-y-5 px-5 pt-6"
        style={{ paddingBottom: Math.max(32, bottomInset + 24) }}
      >
        <p className="whitespace-pre-wrap text-sm leading-relaxed">
          {isLead
            ? run.objective
            : (run.tasks.find((task) => turns.some((turn) => turn.taskId === task.id))?.objective ??
              run.objective)}
        </p>
        <div className="flex items-center justify-between gap-3 text-xs text-muted-foreground">
          <span role="status" aria-live="polite" className="min-w-0 truncate">
            {latest ? (
              <>
                <Link
                  to="/$environmentId/$threadId"
                  params={{ environmentId, threadId: latest.threadId }}
                  onClick={() =>
                    useRightPanelStore
                      .getState()
                      .open({ environmentId, threadId: latest.threadId }, "agents")
                  }
                  className="hover:text-foreground hover:underline"
                >
                  {teamAgentName(run, latest.threadId)}
                </Link>{" "}
                · {teamTurnLabel(run, latest)}
              </>
            ) : (
              phaseLabels[run.phase]
            )}
          </span>
          <Button size="xs" variant="ghost" onClick={onOpenAgents}>
            <UsersIcon className="size-3.5" />
            Agents
            <ChevronRightIcon className="size-3" />
          </Button>
        </div>
        <details open={active} className="text-xs text-muted-foreground">
          <summary className="w-fit cursor-pointer py-1 hover:text-foreground">
            Team activity · {run.status}
          </summary>
          <div className="mt-2 space-y-2 border-l pl-3">
            {turns.slice(-8).map((turn) => (
              <div key={turn.id} className="flex flex-wrap items-baseline gap-x-1.5">
                <Link
                  to="/$environmentId/$threadId"
                  params={{ environmentId, threadId: turn.threadId }}
                  onClick={() =>
                    useRightPanelStore
                      .getState()
                      .open({ environmentId, threadId: turn.threadId }, "agents")
                  }
                  className="font-medium hover:text-foreground hover:underline"
                >
                  {teamAgentName(run, turn.threadId)}
                </Link>
                <span>
                  {turn.role === "worker" ? "worker" : "lead"} · {teamTurnLabel(run, turn)}
                </span>
              </div>
            ))}
            {turns.length > 8 && (
              <Button size="xs" variant="ghost" onClick={onOpenAgents}>
                View all activity
              </Button>
            )}
          </div>
        </details>
        {error && (
          <p role="status" className="text-xs text-destructive">
            Activity refresh failed. Showing the last received state.
          </p>
        )}
        {!isLead && run.notice && run.status !== "completed" && (
          <p role="status" className="text-sm text-muted-foreground">
            {run.notice}
          </p>
        )}
        {result && <ChatMarkdown text={result} cwd={cwd} environmentId={environmentId} />}
        {followUp && (
          <section>
            <h2 className="mb-3 text-sm font-medium">Conversation</h2>
            <div className="relative flex h-96 flex-col">{followUp}</div>
          </section>
        )}
      </div>
    </ScrollArea>
  );
}

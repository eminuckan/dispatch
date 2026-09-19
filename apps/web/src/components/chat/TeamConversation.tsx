import { Link } from "@tanstack/react-router";
import type { TimelineEntry } from "../../session-logic";
import { teamFollowUpEntries } from "./teamConversation.logic";
import { useEffect, type ReactNode } from "react";
import { BotIcon, CheckIcon, ChevronRightIcon, RefreshCwIcon, UsersIcon } from "lucide-react";
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
const turnLabels = {
  plan: "Plan",
  worker: "Worker result",
  review: "Lead review",
  integrate: "Final verification",
};

function Status({ value }: { value: string }) {
  const success = value === "completed" || value === "accepted";
  const failed = value === "failed";
  return (
    <span className="inline-flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground">
      <span
        aria-hidden
        className={`size-1.5 rounded-full ${success ? "bg-success" : failed ? "bg-destructive" : "bg-muted-foreground/50"}`}
      />
      <span className="capitalize">{value}</span>
    </span>
  );
}

/** Exact persisted membership owns presentation; never classify arbitrary assistant JSON. */
export function TeamConversation({
  environmentId,
  threadId,
  cwd,
  bottomInset,
  children,
  entries,
}: {
  environmentId: EnvironmentId;
  threadId: ThreadId;
  cwd: string | undefined;
  bottomInset: number;
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
    <TeamActivity
      run={run}
      environmentId={environmentId}
      threadId={threadId}
      cwd={cwd}
      bottomInset={bottomInset}
      refresh={refresh}
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
  bottomInset,
  refresh,
  error,
  followUp,
}: {
  run: TeamThreadView;
  environmentId: EnvironmentId;
  threadId: ThreadId;
  cwd: string | undefined;
  bottomInset: number;
  refresh: () => void;
  error: string | null;
  followUp: ReactNode;
}) {
  const isLead = run.leadThreadId === threadId;
  const workerTurns = run.turns.filter((t) => t.threadId === threadId && t.role === "worker");
  const currentTask = run.tasks.find(
    (t) => t.threadId === threadId || workerTurns.some((turn) => turn.taskId === t.id),
  );
  const activity = isLead
    ? run.turns
    : run.turns.filter(
        (t) =>
          t.threadId === threadId ||
          (t.role === "review" && workerTurns.some((worker) => worker.id === t.taskId)),
      );
  return (
    <ScrollArea className="flex-1">
      <div
        className="mx-auto w-full max-w-3xl space-y-6 px-5 pt-6"
        style={{ paddingBottom: Math.max(32, bottomInset + 24) }}
      >
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2 text-sm font-medium">
            <UsersIcon className="size-4 text-muted-foreground" />
            Team
            <Status value={run.status} />
          </div>
          <Button
            size="icon-xs"
            variant="ghost"
            aria-label="Refresh team activity"
            onClick={refresh}
          >
            <RefreshCwIcon className="size-3.5" />
          </Button>
        </div>
        <p className="whitespace-pre-wrap text-sm leading-relaxed">{run.objective}</p>
        <section aria-label="Team agents" className="space-y-1 text-sm">
          <Link
            to="/$environmentId/$threadId"
            params={{ environmentId, threadId: run.leadThreadId }}
            aria-current={isLead ? "page" : undefined}
            className="flex items-start gap-2 rounded-md p-2 hover:bg-accent"
          >
            <BotIcon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
            <div className="min-w-0 flex-1">
              <div className="font-medium">Lead</div>
              <div className="mt-0.5 text-xs text-muted-foreground">
                {run.lead.label}
                {run.turns[0]?.effort ? ` · ${run.turns[0].effort}` : ""} · {phaseLabels[run.phase]}
              </div>
            </div>
            <Status value={run.status} />
          </Link>
          <div className="ml-4 border-l border-border pl-3">
            {run.tasks.length === 0 && (
              <p className="px-2 py-3 text-xs text-muted-foreground">
                {["completed", "cancelled", "failed"].includes(run.status)
                  ? "No workers were assigned."
                  : run.status === "paused"
                    ? "Planning is paused."
                    : "The lead is preparing the work items."}
              </p>
            )}
            {run.tasks.map((task, index) => {
              const latest = run.turns.findLast((t) => t.role === "worker" && t.taskId === task.id);
              const body = (
                <>
                  <div className="min-w-0 flex-1">
                    <div className="truncate font-medium">{task.objective}</div>
                    <div className="mt-1 text-xs text-muted-foreground">
                      Worker {index + 1}
                      {latest
                        ? ` · ${latest.model}${latest.effort ? ` · ${latest.effort}` : ""}`
                        : " · Waiting for assignment"}
                      {task.attempts > 0 ? ` · Attempt ${task.attempts}` : ""}
                    </div>
                  </div>
                  <Status value={task.status} />
                  <ChevronRightIcon className="size-3.5 shrink-0 text-muted-foreground" />
                </>
              );
              return task.threadId ? (
                <Link
                  key={task.id}
                  to="/$environmentId/$threadId"
                  params={{ environmentId, threadId: task.threadId }}
                  aria-current={task.threadId === threadId ? "page" : undefined}
                  className="flex items-center gap-3 rounded-md px-2 py-3 hover:bg-accent"
                >
                  {body}
                </Link>
              ) : (
                <div key={task.id} className="flex items-center gap-3 px-2 py-3">
                  {body}
                </div>
              );
            })}
          </div>
        </section>
        {error && (
          <p role="status" className="text-sm text-destructive">
            Activity refresh failed. Showing the last received state.
          </p>
        )}
        {run.notice && (
          <section className="space-y-2 border-t pt-4">
            <h2 className="text-sm font-medium">
              {run.status === "completed" ? "Result" : "Team update"}
            </h2>
            <ChatMarkdown text={run.notice} cwd={cwd} environmentId={environmentId} />
          </section>
        )}
        {currentTask && (
          <section className="space-y-2 border-t pt-4">
            <h2 className="text-sm font-medium">Worker assignment</h2>
            <p className="text-sm">{currentTask.objective}</p>
            <ul className="list-disc space-y-1 pl-5 text-sm text-muted-foreground">
              {Array.from(new Set(currentTask.acceptance)).map((criterion) => (
                <li key={criterion}>{criterion}</li>
              ))}
            </ul>
          </section>
        )}
        <section className="space-y-3 border-t pt-4" aria-label="Team activity">
          <div className="flex justify-between text-sm">
            <h2 className="font-medium">Activity</h2>
            <span className="text-xs tabular-nums text-muted-foreground">
              {run.turns.length} / {run.maxTurns} turns
            </span>
          </div>
          {activity.map((turn) => (
            <details
              key={turn.id}
              className="group text-sm"
              open={turn.status !== "settled" || (!isLead && turn.role === "worker")}
            >
              <summary className="flex cursor-pointer items-center gap-2 rounded py-2 text-muted-foreground hover:text-foreground">
                {turn.status === "settled" && turn.succeeded ? (
                  <CheckIcon className="size-3.5" />
                ) : (
                  <ChevronRightIcon className="size-3.5" />
                )}
                <span className="flex-1">{turnLabels[turn.role]}</span>
                <span className="text-xs">
                  {turn.status === "settled"
                    ? turn.succeeded
                      ? "Finished"
                      : "Needs attention"
                    : turn.status === "reserved"
                      ? "Queued"
                      : "Working"}
                </span>
              </summary>
              <div className="pb-3 pl-5">
                {turn.summary ? (
                  <ChatMarkdown text={turn.summary} cwd={cwd} environmentId={environmentId} />
                ) : (
                  <p className="text-xs text-muted-foreground">
                    {turn.status === "settled"
                      ? turn.succeeded
                        ? "Handoff recorded."
                        : "This attempt did not finish successfully. Check the team update for the next step."
                      : "The agent is working. Its result will appear here."}
                  </p>
                )}
              </div>
            </details>
          ))}
        </section>
        {followUp && (
          <section className="border-t pt-4">
            <h2 className="mb-3 text-sm font-medium">Conversation</h2>
            <div className="relative flex h-96 flex-col">{followUp}</div>
          </section>
        )}
      </div>
    </ScrollArea>
  );
}

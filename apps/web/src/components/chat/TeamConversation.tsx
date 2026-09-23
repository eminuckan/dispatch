import { useAtomCommand } from "../../state/use-atom-command";
import { squashAtomCommandFailure } from "@dispatch/client-runtime/state/runtime";
import { useRightPanelStore } from "../../rightPanelStore";
import { Link } from "@tanstack/react-router";
import type { TimelineEntry } from "../../session-logic";
import {
  teamActivityAgents,
  teamConversationMessages,
  teamConversationEntries,
  teamAgentName,
  teamMailboxEntries,
  teamPrimaryRoleLabel,
  teamProviderDecisionState,
  teamTurnLabel,
  teamThreadRoleForRun,
} from "./teamConversation.logic";
import type { TeamConversationMessage } from "./teamConversation.logic";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { ChevronRightIcon, RefreshCwIcon } from "lucide-react";
import type { EnvironmentId, TeamThreadView, ThreadId } from "@dispatch/contracts";
import { scopeThreadRef } from "@dispatch/client-runtime/environment";
import { teamEnvironment } from "../../state/team";
import { useEnvironmentQuery } from "../../state/query";
import { useThread } from "../../state/entities";
import { Button } from "../ui/button";
import { ScrollArea } from "../ui/scroll-area";
import ChatMarkdown from "../ChatMarkdown";

function managedThreadRoleFromId(threadId: string): "lead" | "worker" | undefined {
  if (!threadId.startsWith("team-")) return undefined;
  if (threadId.endsWith("-lead")) return "lead";
  if (threadId.includes("-worker-")) return "worker";
  return undefined;
}

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
  children: (
    entries: TimelineEntry[],
    messages: ReadonlyArray<TeamConversationMessage>,
  ) => ReactNode;
}) {
  const query = useEnvironmentQuery(
    teamEnvironment.forThread({ environmentId, input: { threadId } }),
  );
  const run = query.data;
  const refresh = query.refresh;
  const live =
    run &&
    (!["completed", "cancelled", "failed"].includes(run.status) ||
      run.attempts.some((attempt) =>
        ["reserved", "dispatching", "running"].includes(attempt.status),
      ));
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
    if (query.isSuccess || !threadId.startsWith("team-")) {
      const threadRole = managedThreadRoleFromId(threadId);
      const visibleEntries = threadRole
        ? teamConversationEntries(entries, [], [], undefined, threadRole)
        : entries;
      return children(visibleEntries, []);
    }
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
  const initialAttempt = initialTurn
    ? run.attempts.find((attempt) => attempt.id === initialTurn.id)
    : undefined;
  const objective =
    threadId === run.leadThreadId
      ? run.objective
      : (run.tasks.find((task) => task.owner.threadId === threadId)?.objective ?? run.objective);
  const threadRole = teamThreadRoleForRun(run, threadId);
  const visibleEntries = teamConversationEntries(
    entries,
    run.attempts,
    run.turns,
    initialAttempt ? { id: initialAttempt.requestMessageId, objective } : undefined,
    threadRole ?? undefined,
  );
  const messages = teamConversationMessages(run, threadId);
  return (
    <>
      {run.notice ? (
        <p
          role="status"
          className="mx-4 mt-2 rounded-md border border-border/60 bg-muted/25 px-3 py-2 text-xs text-muted-foreground"
        >
          {run.notice}
        </p>
      ) : null}
      {children(visibleEntries, messages)}
    </>
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
      setControlError(error instanceof Error ? error.message : "Could not update Flow.");
    }
    refresh();
  }
  const leadThreadRef = useMemo(
    () => (run.leadThreadId === null ? null : scopeThreadRef(environmentId, run.leadThreadId)),
    [environmentId, run.leadThreadId],
  );
  const leadThread = useThread(leadThreadRef);
  const leadRunningTurnId =
    (leadThread?.session?.status === "running" ? leadThread.session.activeTurnId : null) ??
    (leadThread?.latestTurn?.state === "running" ? leadThread.latestTurn.turnId : null);
  const activeThreadActivity = useMemo(
    () =>
      run.leadThreadId === null
        ? null
        : { threadId: run.leadThreadId, runningTurnId: leadRunningTurnId },
    [leadRunningTurnId, run.leadThreadId],
  );
  const agents = teamActivityAgents(run, activeThreadActivity);
  const mailbox = teamMailboxEntries(run);
  const primaryRole = teamPrimaryRoleLabel(run);
  const working = new Set(
    run.attempts
      .filter((attempt) => ["dispatching", "running"].includes(attempt.status))
      .flatMap((attempt) => (attempt.owner.threadId ? [attempt.owner.threadId] : [])),
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
          {agents.map((agent) => {
            const successful = ["settled", "completed"].includes(agent.status);
            const attention = ["failed", "needs attention"].includes(agent.status);
            const active = [
              "planning",
              "starting",
              "running",
              "reviewing",
              "supervising",
              "verifying",
              "settling",
            ].includes(agent.status);
            const body = (
              <>
                <span
                  aria-hidden
                  className={`col-start-1 row-start-1 size-1.5 rounded-full ${successful ? "bg-success" : attention ? "bg-destructive" : active ? "bg-info" : "bg-muted-foreground/50"}`}
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
            const row = agent.id ? (
              <Link
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
              <div className={rowClass}>{body}</div>
            );
            return (
              <div key={agent.id ?? agent.name}>
                {row}
                {agent.context || agent.acceptance.length > 0 || agent.dependencies.length > 0 ? (
                  <details className="ml-6 px-1.5 text-xs text-muted-foreground">
                    <summary className="cursor-pointer py-1 hover:text-foreground">
                      {agent.role === "Worker" ? "Task context and acceptance" : "Acceptance"}
                    </summary>
                    <div className="space-y-2 pb-2 pl-1 leading-relaxed">
                      {agent.context ? (
                        <p className="whitespace-pre-wrap break-words">{agent.context}</p>
                      ) : null}
                      {agent.dependencies.length > 0 ? (
                        <div>
                          <p className="font-medium text-foreground/80">Depends on</p>
                          <ul className="list-disc pl-4">
                            {agent.dependencies.map((dependency) => (
                              <li key={dependency}>{dependency}</li>
                            ))}
                          </ul>
                        </div>
                      ) : null}
                      {agent.acceptance.length > 0 ? (
                        <div>
                          <p className="font-medium text-foreground/80">Completion checks</p>
                          <ul className="list-disc pl-4">
                            {agent.acceptance.map((criterion) => (
                              <li key={criterion}>{criterion}</li>
                            ))}
                          </ul>
                        </div>
                      ) : null}
                    </div>
                  </details>
                ) : null}
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
          <TeamProviderLimitDecision
            run={run}
            environmentId={environmentId}
            currentThreadId={threadId}
            refresh={refresh}
          />
          {mailbox.length > 0 ? (
            <details className="px-1.5 pt-3 text-xs text-muted-foreground">
              <summary className="cursor-pointer py-1 hover:text-foreground">
                Team messages ({mailbox.length})
              </summary>
              <div className="mt-2 space-y-3">
                {mailbox.slice(-20).map(({ message, from, to }) => (
                  <article key={message.id} className="space-y-1 border-l border-border/60 pl-2">
                    <p className="font-medium text-foreground/85">
                      {from} → {to}
                    </p>
                    <p className="whitespace-pre-wrap break-words">{message.text}</p>
                    <p className="text-[.65rem]">
                      {message.readAt ? "Read" : "Unread"} · {message.createdAt}
                    </p>
                  </article>
                ))}
                {mailbox.length > 20 ? <p>Showing the latest 20 messages.</p> : null}
              </div>
            </details>
          ) : null}
          <details className="px-1.5 pt-3 text-xs text-muted-foreground">
            <summary className="cursor-pointer py-1 hover:text-foreground">
              Activity history
            </summary>
            <div className="mt-2 space-y-1">
              {run.turns.map((turn) => (
                <details key={turn.id} className="py-1">
                  <summary className="cursor-pointer py-1 hover:text-foreground">
                    {turn.threadId
                      ? teamAgentName(run, turn.threadId)
                      : turn.role === "worker"
                        ? "Worker"
                        : primaryRole}{" "}
                    · {teamTurnLabel(run, turn)}
                  </summary>
                  <div className="space-y-2 py-2">
                    {turn.threadId ? (
                      <Link
                        to="/$environmentId/$threadId"
                        params={{ environmentId, threadId: turn.threadId }}
                        onClick={() =>
                          useRightPanelStore
                            .getState()
                            .open({ environmentId, threadId: turn.threadId! }, "agents")
                        }
                        className="inline-flex items-center gap-1 hover:text-foreground hover:underline"
                      >
                        Open {teamAgentName(run, turn.threadId)}
                        <ChevronRightIcon className="size-3" />
                      </Link>
                    ) : null}
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
            : `${run.tasks.filter((task) => task.status === "settled").length} / ${run.tasks.length} tasks accepted`}
        </span>
        <span>{run.turns.length} activity steps</span>
      </footer>
    </div>
  );
}

export function TeamProviderLimitDecision({
  run,
  environmentId,
  currentThreadId,
  refresh,
}: {
  run: TeamThreadView;
  environmentId: EnvironmentId;
  currentThreadId: ThreadId;
  refresh: () => void;
}) {
  const providerDecision = useAtomCommand(teamEnvironment.providerDecision, {
    reportFailure: false,
  });
  const decisionState = teamProviderDecisionState(run);
  const [pendingAction, setPendingAction] = useState<string | null>(null);
  const [decisionError, setDecisionError] = useState<string | null>(null);

  if (!decisionState) return null;

  const { failover, currentProfile, candidates } = decisionState;
  const triggerText =
    failover.trigger.kind === "provider-limit"
      ? "hit a provider limit"
      : failover.trigger.kind === "provider-unavailable"
        ? "became unavailable"
        : "could not continue on the current provider";

  async function decide(action: "switch" | "pause", profileId: string | null) {
    if (pendingAction) return;
    const actionKey = action === "switch" && profileId ? `switch:${profileId}` : action;
    setPendingAction(actionKey);
    setDecisionError(null);
    const result = await providerDecision({
      environmentId,
      input: {
        id: run.id,
        revision: run.revision,
        failoverId: failover.id,
        action,
        profileId,
      },
    });
    setPendingAction(null);
    if (result._tag === "Failure") {
      const error = squashAtomCommandFailure(result);
      setDecisionError(error instanceof Error ? error.message : "Could not continue Flow.");
    } else if (action === "switch") {
      const nextLeadThreadId = result.value.lead.threadId;
      if (nextLeadThreadId && nextLeadThreadId !== currentThreadId) {
        useRightPanelStore.getState().open({ environmentId, threadId: nextLeadThreadId }, "agents");
      }
    }
    refresh();
  }

  return (
    <section
      aria-label="Provider limit decision"
      className="mx-1.5 my-2 space-y-2 rounded-md border border-border bg-muted/30 p-3"
    >
      <div className="space-y-1">
        <p className="text-xs font-medium text-foreground">Flow needs your choice</p>
        <p className="text-xs text-muted-foreground">
          {currentProfile?.label ?? "The current model"} {triggerText}. Flow can continue with
          another selected model/provider, or you can pause it here.
        </p>
        {failover.trigger.detail ? (
          <p className="text-[.7rem] text-muted-foreground/80">{failover.trigger.detail}</p>
        ) : null}
      </div>
      {candidates.length > 0 ? (
        <div className="flex flex-wrap gap-1.5">
          {candidates.map((profile) => {
            const key = `switch:${profile.id}`;
            return (
              <Button
                key={profile.id}
                size="xs"
                variant="secondary"
                disabled={pendingAction !== null}
                onClick={() => void decide("switch", profile.id)}
              >
                {pendingAction === key ? "Switching…" : `Continue with ${profile.label}`}
              </Button>
            );
          })}
        </div>
      ) : (
        <p className="text-xs text-muted-foreground">
          No alternate selected model is available right now. Pause Flow and adjust your models if
          needed.
        </p>
      )}
      <div className="flex items-center gap-1.5">
        <Button
          size="xs"
          variant="ghost"
          disabled={pendingAction !== null}
          onClick={() => void decide("pause", null)}
        >
          {pendingAction === "pause" ? "Pausing…" : "Pause Flow"}
        </Button>
        {decisionError ? (
          <Button size="xs" variant="ghost" onClick={refresh}>
            Refresh
          </Button>
        ) : null}
      </div>
      {decisionError ? (
        <p role="alert" className="text-xs text-destructive">
          {decisionError}
        </p>
      ) : null}
    </section>
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

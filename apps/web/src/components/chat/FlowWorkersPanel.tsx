import type { EnvironmentId, ThreadId } from "@dispatch/contracts";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useState, type ReactNode } from "react";

import { flowEnvironment } from "../../state/flow";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";

export function FlowWorkersPanel({
  environmentId,
  threadId,
  supported,
  expected,
  hasNativeAgents,
  children,
}: {
  environmentId: EnvironmentId | null;
  threadId: ThreadId | null;
  supported: boolean;
  expected: boolean;
  hasNativeAgents: boolean;
  children: ReactNode;
}) {
  const navigate = useNavigate();
  const stop = useAtomCommand(flowEnvironment.stop, { reportFailure: false });
  const [stopping, setStopping] = useState<ThreadId | null>(null);
  const [stopError, setStopError] = useState<string | null>(null);
  const query = useEnvironmentQuery(
    supported && environmentId && threadId
      ? flowEnvironment.forThread({ environmentId, input: { threadId } })
      : null,
  );
  const active =
    query.data?.workers.some((worker) => worker.state === "queued" || worker.state === "working") ??
    false;
  const live = expected || query.data?.enabled === true || active;
  const refresh = query.refresh;

  useEffect(() => {
    if (!live) return;
    const refreshWhenVisible = () => {
      if (!document.hidden) refresh();
    };
    const timer = window.setInterval(refreshWhenVisible, active ? 2_500 : 5_000);
    window.addEventListener("focus", refreshWhenVisible);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", refreshWhenVisible);
    };
  }, [active, live, refresh]);

  if (!supported || !environmentId) return children;
  if (!query.data)
    return expected ? (
      <div className="flex h-full min-h-0 flex-col">
        <div
          className="flex items-center justify-between gap-2 border-b border-border/60 px-3 py-2 text-xs"
          role={query.error ? "alert" : "status"}
        >
          <span>{query.error ? "Could not load Flow workers." : "Loading Flow workers…"}</span>
          {query.error ? (
            <Button size="xs" variant="ghost" onClick={query.refresh}>
              Retry
            </Button>
          ) : null}
        </div>
        {hasNativeAgents ? <div className="min-h-0 flex-1 overflow-auto">{children}</div> : null}
      </div>
    ) : (
      children
    );
  const { parentThreadId, workers } = query.data;
  if (!query.data.enabled && workers.length === 0) return children;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <section
        className="max-h-[45%] shrink-0 overflow-y-auto border-b border-border/60 px-3 py-2"
        aria-label="Flow workers"
      >
        <div className="flex items-center justify-between gap-2">
          <h3 className="text-xs font-medium">Flow workers</h3>
          <span className="text-[11px] text-muted-foreground">{workers.length}</span>
        </div>
        {workers.length === 0 ? (
          <p className="mt-1 text-xs text-muted-foreground">
            The lead can start workers when a task benefits from delegation.
          </p>
        ) : (
          <div className="mt-2 divide-y divide-border/50">
            {workers.map((worker) => (
              <div key={worker.threadId} className="py-2 first:pt-0 last:pb-0">
                <div className="flex items-start justify-between gap-2">
                  <button
                    type="button"
                    className="min-w-0 text-left text-xs font-medium hover:underline focus-visible:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                    onClick={() =>
                      void navigate({
                        to: "/$environmentId/$threadId",
                        params: { environmentId, threadId: worker.threadId },
                      })
                    }
                  >
                    <span className="block truncate">{worker.assignment}</span>
                  </button>
                  <span className="shrink-0 text-[11px] text-muted-foreground">{worker.state}</span>
                </div>
                <p className="mt-0.5 truncate text-[11px] text-muted-foreground">
                  {worker.modelSelection.model}
                </p>
                {worker.latestJob?.result ? (
                  <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">
                    {worker.latestJob.result}
                  </p>
                ) : worker.error || worker.latestJob?.error ? (
                  <p className="mt-1 text-xs text-destructive" role="status">
                    {worker.error ?? worker.latestJob?.error}
                  </p>
                ) : null}
                {worker.state !== "stopped" ? (
                  <Button
                    size="xs"
                    variant="ghost"
                    className="mt-1"
                    disabled={stopping === worker.threadId}
                    onClick={() => {
                      setStopping(worker.threadId);
                      setStopError(null);
                      void stop({
                        environmentId,
                        input: { parentThreadId, workerThreadId: worker.threadId },
                      }).then((result) => {
                        setStopping(null);
                        if (result._tag === "Failure") setStopError("Could not stop worker.");
                        query.refresh();
                      });
                    }}
                  >
                    Stop
                  </Button>
                ) : null}
              </div>
            ))}
          </div>
        )}
        {query.error ? (
          <div
            className="mt-1 flex items-center justify-between gap-2 text-xs text-destructive"
            role="alert"
          >
            <span>Could not refresh Flow workers.</span>
            <Button size="xs" variant="ghost" onClick={query.refresh}>
              Retry
            </Button>
          </div>
        ) : null}
        {stopError ? (
          <p className="mt-1 text-xs text-destructive" role="alert">
            {stopError}
          </p>
        ) : null}
      </section>
      {hasNativeAgents ? <div className="min-h-0 flex-1 overflow-auto">{children}</div> : null}
    </div>
  );
}

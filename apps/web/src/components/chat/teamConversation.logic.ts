import { teamAgentDisplayName } from "@dispatch/shared/teamAgentNames";
import type {
  MessageId,
  ModelSelection,
  TeamAttempt,
  TeamMessage,
  TeamThreadView,
} from "@dispatch/contracts";
import {
  isTeamProtocolRole,
  looksLikeTeamProtocol,
  TEAM_SUPERVISION_PROMPT_MARKER,
  teamProtocolSummary,
} from "@dispatch/shared/teamProtocolPresentation";
import type { TimelineEntry } from "../../session-logic";

export function teamProviderDecisionState(
  run: Pick<TeamThreadView, "status" | "failovers" | "profiles">,
) {
  if (run.status !== "awaiting-provider-decision") return null;
  const failover = run.failovers.findLast((candidate) => candidate.status === "pending");
  if (!failover) return null;
  const byId = new Map(run.profiles.map((profile) => [profile.id, profile]));
  return {
    failover,
    currentProfile: byId.get(failover.fromProfileId) ?? null,
    candidates: failover.candidateProfileIds.flatMap((id) => {
      const profile = byId.get(id);
      return profile ? [profile] : [];
    }),
  };
}

// Exact managed-thread membership lets us hide only scheduler prompts while
// preserving the provider's real reasoning/tool/message stream in the normal
// chat timeline. Structured scheduler replies are rendered as human text.
export function teamConversationEntries(
  entries: ReadonlyArray<TimelineEntry>,
  attempts: ReadonlyArray<
    Pick<TeamAttempt, "id" | "requestMessageId"> & Partial<Pick<TeamAttempt, "role">>
  >,
  turns: TeamThreadView["turns"] = [],
  initialMessage?: { id: string; objective: string },
  managedThreadRole?: "lead" | "worker",
): TimelineEntry[] {
  const internal = new Set(attempts.map((attempt) => attempt.requestMessageId));
  const scopeAttempts = new Set(
    attempts.flatMap((attempt) => (attempt.role === "scope" ? [attempt.id] : [])),
  );
  const protocolTurns = turns.filter((turn) => isTeamProtocolRole(turn.role));
  const byTurn = new Map(
    protocolTurns.flatMap((turn) =>
      turn.providerTurnId ? [[turn.providerTurnId, turn] as const] : [],
    ),
  );
  const byResult = new Map(
    protocolTurns.flatMap((turn) =>
      turn.resultMessageId ? [[turn.resultMessageId, turn] as const] : [],
    ),
  );
  const turnById = new Map(protocolTurns.map((turn) => [turn.id, turn]));
  const byRequest = new Map<string, (typeof protocolTurns)[number]>(
    attempts.flatMap((attempt) => {
      const turn = turnById.get(attempt.id);
      return turn ? [[attempt.requestMessageId, turn] as const] : [];
    }),
  );
  let precedingRequest: (typeof protocolTurns)[number] | undefined;
  let unknownManagedRequest = false;

  return entries.flatMap((entry): TimelineEntry[] => {
    if (entry.kind !== "message") return [entry];
    if (entry.message.role === "assistant") {
      const turn =
        byResult.get(entry.message.id) ??
        (entry.message.turnId ? byTurn.get(entry.message.turnId) : undefined) ??
        (precedingRequest?.providerTurnId ? undefined : precedingRequest);
      if (!turn || !isTeamProtocolRole(turn.role)) {
        const inferredRole = managedThreadRole === "lead" ? "plan" : managedThreadRole;
        const inferredSummary =
          inferredRole === "plan"
            ? (teamProtocolSummary("scope", entry.message.text) ??
              teamProtocolSummary(inferredRole, entry.message.text))
            : inferredRole
              ? teamProtocolSummary(inferredRole, entry.message.text)
              : null;
        if (inferredSummary)
          return [{ ...entry, message: { ...entry.message, text: inferredSummary } }];
        if (
          managedThreadRole &&
          entry.message.streaming &&
          looksLikeManagedThreadProtocol(managedThreadRole, entry.message.text)
        ) {
          return [];
        }
        // A freshly reserved scheduler request can reach the native timeline a
        // moment before its team-ledger/receipt metadata. The reserved team-*
        // namespace is exact enough to suppress only protocol-shaped leakage
        // during that short window; normal commentary remains visible.
        if (unknownManagedRequest && looksLikeTeamProtocol(entry.message.text)) return [];
        return [entry];
      }
      const finalResult = !turn.resultMessageId || turn.resultMessageId === entry.message.id;
      if (!finalResult && turn.role !== "plan") return [entry];
      const protocolRole = scopeAttempts.has(turn.id) ? "scope" : turn.role;
      const summary = teamProtocolSummary(protocolRole, entry.message.text);
      if (summary) return [{ ...entry, message: { ...entry.message, text: summary } }];
      if (!looksLikeTeamProtocol(entry.message.text)) return [entry];
      if (entry.message.streaming) return [];
      if (!finalResult) return [];
      const member = turn.role === "worker" ? "worker" : "lead";
      return [
        {
          ...entry,
          message: {
            ...entry.message,
            text: `The ${member}’s structured response could not be read. Check the team status in Agents.`,
          },
        },
      ];
    }
    if (entry.message.role !== "user") return [entry];
    precedingRequest = byRequest.get(entry.message.id);
    unknownManagedRequest = precedingRequest === undefined && entry.message.id.startsWith("team-");
    if (entry.message.id === initialMessage?.id) {
      return [{ ...entry, message: { ...entry.message, text: initialMessage.objective } }];
    }
    return internal.has(entry.message.id) || entry.message.id.startsWith("team-") ? [] : [entry];
  });
}

function looksLikeManagedThreadProtocol(role: "lead" | "worker", text: string): boolean {
  const object = text.trim().replace(/^```(?:json)?\s*/, "");
  if (/^\{\s*$/u.test(object)) return true;
  const firstKey = /^\{\s*"([^"\\]*)/u.exec(object)?.[1];
  if (firstKey === undefined) return false;
  const keys =
    role === "lead"
      ? ["summary", "independentAreas", "risks", "acceptance", "tasks", "rationale"]
      : ["summary", "commit", "changedFiles", "checks", "limitations"];
  return keys.some(
    (key) => key === firstKey || (!object.includes(`"${firstKey}"`) && key.startsWith(firstKey)),
  );
}

export function teamAgentName(
  run: Pick<import("@dispatch/contracts").TeamThreadView, "id" | "leadThreadId" | "tasks">,
  threadId: string,
): string {
  const workerThreadIds = run.tasks.flatMap((task) =>
    task.owner.threadId ? [task.owner.threadId] : [],
  );
  return teamAgentDisplayName(
    run.id,
    [...(run.leadThreadId ? [run.leadThreadId] : []), ...workerThreadIds],
    threadId,
  );
}

export function teamThreadRoleForRun(
  run: Pick<TeamThreadView, "leadThreadId" | "tasks">,
  threadId: string,
): "lead" | "worker" | null {
  if (run.leadThreadId === threadId) return "lead";
  return run.tasks.some((task) => task.owner.threadId === threadId) ? "worker" : null;
}

export function teamThreadComposerAccess(
  threadId: string,
  run: TeamThreadView | null,
  queryResolved: boolean,
): "lead" | "worker" | "checking" | null {
  if (!threadId.startsWith("team-")) return null;
  if (!queryResolved) return "checking";
  if (!run) return null;
  return teamThreadRoleForRun(run, threadId);
}

/**
 * The selection a managed lead thread actually runs with: the latest lead
 * attempt frozen for that exact thread. Managed attempts never read the
 * thread's own model selection, so the composer must show this instead of the
 * profile copy the thread was created with.
 */
export function teamLeadThreadSelection(
  run: Pick<TeamThreadView, "leadThreadId" | "attempts">,
  threadId: string,
): ModelSelection | null {
  if (run.leadThreadId !== threadId) return null;
  return (
    run.attempts.findLast(
      (attempt) => attempt.owner.role === "lead" && attempt.owner.threadId === threadId,
    )?.selection ?? null
  );
}

export function teamPrimaryRoleLabel(
  run: Pick<import("@dispatch/contracts").TeamThreadView, "executionMode">,
): "Direct" | "Lead" {
  return run.executionMode === "direct" ? "Direct" : "Lead";
}

export function teamTurnLabel(
  run: import("@dispatch/contracts").TeamThreadView,
  turn: import("@dispatch/contracts").TeamThreadView["turns"][number],
): string {
  const supervision = run.attempts.some(
    (attempt) =>
      attempt.id === turn.id &&
      attempt.role === "review" &&
      attempt.taskId === null &&
      attempt.prompt.startsWith(TEAM_SUPERVISION_PROMPT_MARKER),
  );
  if (turn.status === "reserved") return supervision ? "supervising workers" : "queued";
  if (turn.status !== "settled")
    return turn.role === "review"
      ? supervision
        ? "supervising workers"
        : "reviewing worker"
      : turn.role === "integrate"
        ? "verifying result"
        : turn.role === "plan"
          ? "planning"
          : "working";
  if (!turn.succeeded) return "needs attention";
  if (turn.role === "plan") return "plan ready";
  if (turn.role === "integrate")
    return run.status === "completed" ? "result verified" : "verification reported";
  if (turn.role === "review") return supervision ? "supervision update" : "review finished";
  const task = run.tasks.find((t) => t.id === turn.taskId);
  const latest = run.turns.findLast((t) => t.role === "worker" && t.taskId === turn.taskId);
  return task?.status === "settled" && latest?.id === turn.id
    ? "accepted by lead"
    : "reported result";
}

export type TeamAgentActivityStatus =
  | "planning"
  | "queued"
  | "starting"
  | "running"
  | "reviewing"
  | "supervising"
  | "verifying"
  | "settling"
  | "waiting"
  | "needs attention"
  | "paused"
  | "completed"
  | "cancelled"
  | "failed";

export interface TeamActivityAgent {
  readonly id:
    | TeamThreadView["leadThreadId"]
    | TeamThreadView["tasks"][number]["owner"]["threadId"];
  readonly role: "Direct" | "Lead" | "Worker";
  readonly name: string;
  readonly objective: string;
  readonly context: string | null;
  readonly acceptance: ReadonlyArray<string>;
  readonly dependencies: ReadonlyArray<string>;
  readonly model: string;
  readonly effort: string | undefined;
  readonly status: TeamAgentActivityStatus;
  readonly attempts: number;
}

function attemptActivityStatus(
  attempt: TeamAttempt,
  role: "lead" | "worker",
): TeamAgentActivityStatus | null {
  const supervision =
    attempt.role === "review" &&
    attempt.taskId === null &&
    attempt.prompt.startsWith(TEAM_SUPERVISION_PROMPT_MARKER);
  switch (attempt.status) {
    case "reserved":
      return supervision ? "supervising" : "queued";
    case "dispatching":
      return supervision ? "supervising" : "starting";
    case "running":
      if (attempt.role === "plan") return "planning";
      if (attempt.role === "integrate") return "verifying";
      if (attempt.role === "review")
        return supervision ? "supervising" : role === "lead" ? "reviewing" : "running";
      return "running";
    default:
      return null;
  }
}

function reasoningEffort(attempt: TeamAttempt | undefined): string | undefined {
  const value = attempt?.selection.options?.find((option) =>
    ["reasoningEffort", "effort", "reasoning", "variant"].includes(option.id),
  )?.value;
  return typeof value === "string" ? value : undefined;
}

function leadActivityStatus(
  run: TeamThreadView,
  attempt: TeamAttempt | undefined,
  nativeRunningTurnId: string | null,
  currentThreadWorking: boolean,
): TeamAgentActivityStatus {
  const active = attempt && attemptActivityStatus(attempt, "lead");
  if (nativeRunningTurnId !== null) {
    if (attempt?.providerTurnId === nativeRunningTurnId && active) return active;
    return "running";
  }
  if (currentThreadWorking) return "running";
  if (active) return active;
  switch (run.status) {
    case "planning":
      return "planning";
    case "review":
      return "reviewing";
    case "settling":
      return "verifying";
    case "running":
      return "supervising";
    case "paused":
      return "paused";
    case "awaiting-provider-decision":
      return "needs attention";
    case "completed":
      return "completed";
    case "cancelled":
      return "cancelled";
    case "failed":
      return "failed";
  }
}

function workerActivityStatus(
  run: TeamThreadView,
  task: TeamThreadView["tasks"][number],
  attempt: TeamAttempt | undefined,
): TeamAgentActivityStatus {
  const active = attempt && attemptActivityStatus(attempt, "worker");
  if (active) return active;

  switch (task.status) {
    case "settled":
      return "completed";
    case "failed":
      return "failed";
    case "cancelled":
      return "cancelled";
    case "blocked":
      return "needs attention";
    case "review":
      return "reviewing";
    case "settling":
      return "settling";
  }

  if (attempt?.status === "succeeded") {
    return run.status === "paused" ? "needs attention" : "settling";
  }
  if (attempt?.status === "failed") {
    return run.status === "paused" ? "needs attention" : "failed";
  }
  if (attempt?.status === "cancelled") return "cancelled";
  if (task.status === "pending") return run.status === "paused" ? "paused" : "queued";
  if (run.status === "paused") return "paused";
  return "running";
}

/** Derives truthful row state from the latest managed attempt before the scheduler phase. */
export function teamActivityAgents(
  run: TeamThreadView,
  activeThread: { threadId: string; runningTurnId: string | null; working?: boolean } | null = null,
): ReadonlyArray<TeamActivityAgent> {
  const leadAttempt =
    run.attempts.findLast(
      (attempt) =>
        attempt.owner.role === "lead" &&
        ["reserved", "dispatching", "running"].includes(attempt.status),
    ) ?? run.attempts.findLast((attempt) => attempt.owner.role === "lead");
  const primaryRole = teamPrimaryRoleLabel(run);
  const nativeRunningTurnId =
    activeThread?.threadId === run.leadThreadId ? activeThread.runningTurnId : null;
  const currentThreadWorking =
    activeThread?.threadId === run.leadThreadId && activeThread.working === true;
  const agents: TeamActivityAgent[] = [
    {
      id: run.leadThreadId,
      role: primaryRole,
      name: run.leadThreadId ? teamAgentName(run, run.leadThreadId) : primaryRole,
      objective: run.objective,
      context: null,
      acceptance: [],
      dependencies: [],
      model: run.lead.label,
      effort: reasoningEffort(leadAttempt),
      status: leadActivityStatus(run, leadAttempt, nativeRunningTurnId, currentThreadWorking),
      attempts: run.attempts.filter((attempt) => attempt.owner.role === "lead").length,
    },
    ...run.tasks.map((task, index) => {
      const attempt =
        run.attempts.findLast(
          (candidate) =>
            candidate.role === "work" &&
            candidate.taskId === task.id &&
            ["reserved", "dispatching", "running"].includes(candidate.status),
        ) ??
        run.attempts.findLast(
          (candidate) => candidate.role === "work" && candidate.taskId === task.id,
        );
      const dependencies = task.dependencies.map(
        (dependencyId) =>
          run.tasks.find((candidate) => candidate.id === dependencyId)?.objective ?? "Another task",
      );
      return {
        id: task.owner.threadId,
        role: "Worker" as const,
        name: task.owner.threadId ? teamAgentName(run, task.owner.threadId) : `Worker ${index + 1}`,
        objective: task.objective,
        context: task.context ?? null,
        acceptance: task.acceptance,
        dependencies,
        model: attempt?.selection.model ?? "Waiting for assignment",
        effort: reasoningEffort(attempt),
        status: workerActivityStatus(run, task, attempt),
        attempts: task.attemptIds.length,
      };
    }),
  ];
  return agents;
}

export interface TeamMailboxEntry {
  readonly message: TeamMessage;
  readonly from: string;
  readonly to: string;
}

export interface TeamConversationMessage {
  readonly id: string;
  readonly createdAt: string;
  readonly text: string;
  readonly from: string;
  readonly to: string;
  readonly deliveryStatus: NonNullable<TeamMessage["delivery"]>["status"] | null;
  readonly providerMessageId: MessageId | null;
}

/** Adds stable member names to durable mailbox entries for the read-only activity panel. */
export function teamMailboxEntries(
  run: Pick<TeamThreadView, "id" | "leadThreadId" | "tasks" | "messages" | "executionMode">,
): ReadonlyArray<TeamMailboxEntry> {
  const ownerName = (owner: TeamMessage["from"]) =>
    owner.threadId
      ? teamAgentName(run, owner.threadId)
      : owner.role === "lead"
        ? teamPrimaryRoleLabel(run)
        : "Worker";
  return run.messages.map((message) => ({
    message,
    from: ownerName(message.from),
    to: ownerName(message.to),
  }));
}

/** Projects each durable mailbox record into the sender and recipient chats. */
export function teamConversationMessages(
  run: Pick<TeamThreadView, "id" | "leadThreadId" | "tasks" | "messages" | "executionMode">,
  threadId: string,
): ReadonlyArray<TeamConversationMessage> {
  const seen = new Set<string>();
  return teamMailboxEntries(run).flatMap(({ message, from, to }) => {
    if (
      seen.has(message.id) ||
      (message.from.threadId !== threadId && message.to.threadId !== threadId)
    ) {
      return [];
    }
    seen.add(message.id);
    return [
      {
        id: message.id,
        createdAt: message.createdAt,
        text: message.text,
        from,
        to,
        deliveryStatus: message.delivery?.status ?? null,
        providerMessageId: message.delivery?.providerMessageId ?? null,
      },
    ];
  });
}

export function teamMessageDeliveryLabel(
  status: TeamConversationMessage["deliveryStatus"],
): string | null {
  switch (status) {
    case "pending":
      return "Waiting for dispatch";
    case "queued":
      return "Waiting for a safe handoff";
    case "steered":
      return "Added to the active turn";
    case "sent":
      return "Accepted by agent";
    case "failed":
      return "Delivery failed";
    case "closed":
      return "Flow ended before delivery";
    case null:
      return null;
  }
}

import * as Predicate from "effect/Predicate";

interface Receipt {
  readonly turnId: string | null;
  readonly pendingMessageId: string | null;
  readonly state: string;
}

interface Activity {
  readonly turnId: string | null;
  readonly kind: string;
  readonly payload: unknown;
}

/** Follow message-mode answers through their provider continuation turns. */
export function settledFlowReceipt<R extends Receipt>(
  receipts: ReadonlyArray<R>,
  initial: R,
  activities: ReadonlyArray<Activity>,
): R | null {
  let receipt = initial;
  if (receipt.state === "pending" || receipt.state === "running") return null;
  const visited = new Set<string>();
  while (receipt.turnId) {
    if (visited.has(receipt.turnId)) return null;
    visited.add(receipt.turnId);
    const requestIds = new Set(
      activities.flatMap((activity) => {
        if (
          activity.turnId !== receipt.turnId ||
          activity.kind !== "user-input.requested" ||
          !Predicate.isObject(activity.payload) ||
          activity.payload.responseMode !== "message" ||
          typeof activity.payload.requestId !== "string"
        )
          return [];
        return [activity.payload.requestId];
      }),
    );
    const resolution = activities.findLast(
      (activity) =>
        activity.kind === "user-input.resolved" &&
        activity.turnId === receipt.turnId &&
        Predicate.isObject(activity.payload) &&
        typeof activity.payload.requestId === "string" &&
        requestIds.has(activity.payload.requestId),
    );
    if (
      !resolution ||
      !Predicate.isObject(resolution.payload) ||
      typeof resolution.payload.requestId !== "string"
    )
      break;
    const requestId = resolution.payload.requestId;
    const continuation = receipts.find(
      (entry) => entry.pendingMessageId === `async-answer:${requestId}`,
    );
    if (!continuation || continuation.state === "pending" || continuation.state === "running")
      return null;
    receipt = continuation;
  }
  return receipt;
}

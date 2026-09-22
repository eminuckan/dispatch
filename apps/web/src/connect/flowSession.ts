import type { TeamSmartRoutingSessionUpdate } from "@dispatch/contracts";

import { normalizeDispatchConnectUrl } from "./dispatchConnect";

export function dispatchFlowSessionPayload(
  baseUrl: string | null,
  accountToken: string | null,
): TeamSmartRoutingSessionUpdate {
  const token = accountToken?.trim() || null;
  const normalizedBaseUrl = normalizeDispatchConnectUrl(baseUrl ?? undefined);
  if (!token || !normalizedBaseUrl) return { accountToken: null, baseUrl: null };
  return { accountToken: token, baseUrl: normalizedBaseUrl };
}

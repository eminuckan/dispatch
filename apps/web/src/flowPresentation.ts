import type { TeamSettings } from "@dispatch/contracts";
import { hasFlowLead } from "./flowPolicy";

export function smartRoutingReasonMessage(reason: string | null): string {
  switch (reason) {
    case "smart_routing_environment_required":
      return "Link this environment to Dispatch Connect to use Flow Auto.";
    case "smart_routing_session_required":
    case "smart_routing_session_invalid":
      return "Sign in to Dispatch Connect to use Flow Auto.";
    case "smart_routing_account_blocked":
      return "Flow Auto is unavailable for this Dispatch Connect account.";
    case "smart_routing_budget_exhausted":
    case "smart_routing_quota_exhausted":
      return "Flow Auto has reached its hosted routing limit. Standard remains available.";
    case "smart_routing_rate_limited":
    case "smart_routing_busy":
    case "smart_routing_environment_limit":
    case "smart_routing_request_pending":
      return "Flow Auto is temporarily busy. Standard remains available.";
    case "smart_routing_payload_too_large":
      return "This request is too large for Flow Auto. Standard remains available.";
    case "smart_routing_invalid_response":
    case "smart_routing_upstream_unavailable":
    case "smart_routing_unavailable":
    case null:
      return "Flow Auto is temporarily unavailable. Standard remains available.";
    default:
      return reason.startsWith("smart_routing_")
        ? "Flow Auto is temporarily unavailable. Standard remains available."
        : reason;
  }
}

export function flowAutoFallbackNotice(settings: TeamSettings | null | undefined): string | null {
  if (!settings || settings.policy.flowMode !== "auto" || settings.smartRouting.available)
    return null;
  if (!hasFlowLead(settings.policy)) {
    return `Auto is unavailable right now. ${smartRoutingReasonMessage(settings.smartRouting.reason)} This Flow setup has no Lead, so Standard fallback cannot start until you add one.`;
  }
  return `Auto is unavailable right now. ${smartRoutingReasonMessage(settings.smartRouting.reason)} Running this task with Standard instead.`;
}

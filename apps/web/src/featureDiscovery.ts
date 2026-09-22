import * as Schema from "effect/Schema";
import { useMemo } from "react";

import { useLocalStorage } from "./hooks/useLocalStorage";

const DISMISSED_FEATURES_STORAGE_KEY = "dispatch:feature-discovery-dismissed:v1";
const DismissedFeatureIds = Schema.Array(Schema.String);

export const FEATURE_DISCOVERIES = {
  flow: {
    id: "dispatch-flow-v1",
    title: "Introducing Dispatch Flow",
    description: "Plan, delegate, and review work with your selected agents.",
    actionLabel: "Explore Flow",
    to: "/settings/orchestration",
    capability: "teamRouting",
  },
} as const;

export function useFeatureDiscoveryDismissal(id: string) {
  const empty = useMemo<readonly string[]>(() => [], []);
  const [dismissedIds, setDismissedIds] = useLocalStorage(
    DISMISSED_FEATURES_STORAGE_KEY,
    empty,
    DismissedFeatureIds,
  );
  const dismissed = dismissedIds.includes(id);
  return {
    dismissed,
    dismiss: () => {
      setDismissedIds((current) => (current.includes(id) ? current : [...current, id]));
    },
  };
}

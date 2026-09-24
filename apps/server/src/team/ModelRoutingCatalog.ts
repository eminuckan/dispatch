import type {
  ModelSelection,
  ServerProviderModel,
  TeamCapability,
  TeamModelProfile,
} from "@dispatch/contracts";

/** Qualitative, revisable priors; these are not a live price feed or provider quota data. */
const EVIDENCE = {
  lunaSol: "https://artificialanalysis.ai/models/comparisons/gpt-6-luna-vs-gpt-6-sol",
  deepseekLuna:
    "https://artificialanalysis.ai/models/comparisons/deepseek-v4-1-flash-vs-gpt-5-6-luna",
  astraFable:
    "https://artificialanalysis.ai/models/comparisons/gpt-6-astra-high-vs-claude-fable-5-1-xhigh",
  deepSwe: "https://deepswe.datacurve.ai/",
} as const;

export type ModelRouteClass = "economy" | "balanced" | "premium" | "scarce" | "unknown";
export type ModelEffortStrategy = "highest" | "adaptive";

export function modelRoutingPrior(model: string): {
  readonly costClass: ModelRouteClass;
  readonly effortStrategy: ModelEffortStrategy;
  readonly capability: TeamCapability | null;
  readonly evidence: readonly string[];
} {
  const name = model.toLowerCase();
  if (/\bgpt[- ]?(?:5\.6|6)[- ]?luna\b/.test(name))
    return {
      costClass: "economy",
      effortStrategy: "highest",
      capability: "complex",
      evidence: name.includes("5.6")
        ? [EVIDENCE.deepseekLuna, EVIDENCE.deepSwe]
        : [EVIDENCE.lunaSol],
    };
  if (/\bdeepseek[- /]?v4(?:\.1)?[- ]?flash\b/.test(name))
    return {
      costClass: "economy",
      effortStrategy: "highest",
      capability: "complex",
      evidence: [EVIDENCE.deepseekLuna],
    };
  if (/\bgpt[- ]?(?:5\.6|6)[- ]?sol\b/.test(name))
    return {
      costClass: "premium",
      effortStrategy: "adaptive",
      capability: "frontier",
      evidence: name.includes("5.6") ? [EVIDENCE.deepSwe] : [EVIDENCE.lunaSol],
    };
  if (/\b(?:claude[- /]?)?opus\b/.test(name))
    return {
      costClass: "premium",
      effortStrategy: "adaptive",
      capability: "frontier",
      evidence: [EVIDENCE.deepSwe],
    };
  if (/\b(?:gpt[- ]?6[- ]?astra|fable)\b/.test(name))
    return {
      costClass: "scarce",
      effortStrategy: "adaptive",
      capability: "frontier",
      evidence: [EVIDENCE.astraFable],
    };
  return { costClass: "unknown", effortStrategy: "adaptive", capability: null, evidence: [] };
}

const EFFORT_RANK = ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"];

export function supportedModelEfforts(model: ServerProviderModel): {
  readonly optionId: string;
  readonly values: readonly string[];
} | null {
  const descriptor = model.capabilities?.optionDescriptors?.find(
    (option) =>
      option.type === "select" && (option.id === "reasoningEffort" || option.id === "variant"),
  );
  if (!descriptor || descriptor.type !== "select") return null;
  const values = descriptor.options
    .map((option) => option.id)
    .filter((value) => EFFORT_RANK.includes(value.toLowerCase()));
  return values.length > 0 ? { optionId: descriptor.id, values } : null;
}

export function selectionWithEffort(
  selection: ModelSelection,
  effort: { readonly optionId: string; readonly value: string } | null,
): ModelSelection {
  if (!effort) return selection;
  const options = (selection.options ?? []).filter((option) => option.id !== effort.optionId);
  return { ...selection, options: [...options, { id: effort.optionId, value: effort.value }] };
}

export function highestSupportedEffort(values: readonly string[]): string | null {
  return (
    [...values].toSorted(
      (a, b) => EFFORT_RANK.indexOf(b.toLowerCase()) - EFFORT_RANK.indexOf(a.toLowerCase()),
    )[0] ?? null
  );
}

export function limitDirectAutoEffort(
  profile: TeamModelProfile,
  difficulty: "routine" | "substantial" | "frontier" | null,
  choices: { readonly optionId: string; readonly values: ReadonlyArray<string> } | null,
  effort: { readonly optionId: string; readonly value: string } | null,
): typeof effort {
  if (!choices || !effort || difficulty === null || difficulty === "frontier") return effort;
  const costClass = modelRoutingPrior(profile.selection.model).costClass;
  if (costClass !== "premium" && costClass !== "scarce") return effort;
  const ceiling = EFFORT_RANK.indexOf(difficulty === "routine" ? "medium" : "high");
  const selected = EFFORT_RANK.indexOf(effort.value.toLowerCase());
  if (selected <= ceiling) return effort;
  const allowed = choices.values.filter((value) => {
    const rank = EFFORT_RANK.indexOf(value.toLowerCase());
    return rank >= 0 && rank <= ceiling;
  });
  const value = highestSupportedEffort(allowed);
  return value ? { optionId: effort.optionId, value } : effort;
}

export function profileUsesAutoEffort(profile: TeamModelProfile): boolean {
  if (profile.effortMode) return profile.effortMode === "auto";
  return !(profile.selection.options ?? []).some(
    (option) => option.id === "reasoningEffort" || option.id === "variant",
  );
}

export function suggestedTeamRole(
  model: string,
): Pick<TeamModelProfile, "lead" | "worker" | "capability"> | null {
  const prior = modelRoutingPrior(model);
  if (!prior.capability) return null;
  if (prior.costClass === "economy")
    return { lead: false, worker: true, capability: prior.capability };
  if (prior.costClass === "premium")
    return { lead: true, worker: true, capability: prior.capability };
  if (prior.costClass === "scarce")
    return { lead: true, worker: false, capability: prior.capability };
  return null;
}

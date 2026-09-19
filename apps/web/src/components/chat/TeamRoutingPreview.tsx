import { useAtomValue } from "@effect/atom-react";
import { serverEnvironment } from "../../state/server";
import { TeamRunControls } from "./TeamRunControls";
import { randomUUID } from "../../lib/utils";
import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { Button } from "../ui/button";
import type { EnvironmentId, ProjectId, TeamAssessment } from "@t3tools/contracts";
import { createTeamDraftCoordinator } from "@t3tools/client-runtime/state/team-draft";
import { teamEnvironment } from "../../state/team";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";

const RoutingContext = createContext<ReturnType<typeof useRoutingState> | null>(null);
export const useComposerRouting = () => useContext(RoutingContext);

export function TeamRoutingProvider(props: RoutingProps & { children: ReactNode }) {
  const config = useAtomValue(serverEnvironment.configValueAtom(props.environmentId));
  return config?.teamRouting === true ? <RoutingProviderContent {...props} /> : props.children;
}

type RoutingProps = {
  environmentId: EnvironmentId;
  projectId: ProjectId | null;
  prompt: string;
  hasAttachments: boolean;
  composing: boolean;
  allowRouting: boolean;
};
function RoutingProviderContent(props: RoutingProps & { children: ReactNode }) {
  const state = useRoutingState(props);
  return <RoutingContext value={state}>{props.children}</RoutingContext>;
}
function useRoutingState({
  environmentId,
  projectId,
  prompt,
  hasAttachments,
  composing,
  allowRouting,
}: RoutingProps) {
  const settings = useEnvironmentQuery(teamEnvironment.settings({ environmentId, input: {} }));
  const assess = useAtomCommand(teamEnvironment.assess, { reportFailure: false });
  const [result, setResult] = useState<{
    key: string;
    assessment: TeamAssessment | null;
    failed: boolean;
  } | null>(null);
  const [draftId] = useState(randomUUID);
  const revision = useRef(0);
  const enabled = allowRouting && settings.data?.policy.mode !== "off" && settings.data !== null;
  const save = useAtomCommand(teamEnvironment.saveSettings, { reportFailure: false });
  const [saving, setSaving] = useState(false);
  const [modeError, setModeError] = useState<string | null>(null);
  async function setMode(mode: "off" | "shadow" | "auto") {
    if (!settings.data || saving) return false;
    setSaving(true);
    const result = await save({
      environmentId,
      input: { policy: { ...settings.data.policy, mode } },
    });
    setSaving(false);
    if (result._tag === "Failure") {
      setModeError("Could not change routing. Check Orchestration settings and try again.");
      return false;
    }
    setModeError(null);
    settings.refresh();
    return true;
  }
  const policyRevision = settings.data?.policy.revision ?? 0;
  const requestKey = JSON.stringify([
    environmentId,
    prompt,
    hasAttachments,
    composing,
    enabled,
    policyRevision,
  ]);
  const assessment = result?.key === requestKey ? result.assessment : null;
  const failed = result?.key === requestKey && result.failed;
  useEffect(() => {
    const coordinator = createTeamDraftCoordinator({
      assess: async (draft) => {
        const result = await assess({ environmentId, input: draft });
        if (result._tag === "Failure") throw new Error("Assessment unavailable");
        return result.value;
      },
      publish: (assessment) => {
        if (assessment) setResult({ key: requestKey, assessment, failed: false });
      },
      onError: () => setResult({ key: requestKey, assessment: null, failed: true }),
    });
    if (enabled)
      coordinator.schedule(
        {
          draftId,
          revision: ++revision.current,
          policyRevision,
          prompt,
          hasAttachments,
        },
        composing,
      );
    return () => coordinator.dispose();
  }, [
    draftId,
    assess,
    environmentId,
    prompt,
    hasAttachments,
    composing,
    enabled,
    policyRevision,
    requestKey,
  ]);
  const profile = settings.data?.policy.profiles.find((p) => p.id === assessment?.profileId);
  const effort = profile?.selection.options?.find((option) =>
    ["reasoningEffort", "effort"].includes(option.id),
  )?.value;
  const modelLabel = profile?.label.replace(/^.*? · /, "") ?? "No eligible model";
  const summary = failed
    ? "Routing unavailable"
    : assessment
      ? `${modelLabel}${typeof effort === "string" ? ` · ${effort}` : ""}`
      : prompt.trim()
        ? "Choosing model…"
        : "Chooses when you type";
  return {
    environmentId,
    projectId,
    prompt,
    hasAttachments,
    composing,
    allowRouting,
    settings,
    assessment,
    failed,
    summary,
    enabled,
    setMode,
    saving,
    modeError,
    automatic: allowRouting && settings.data?.policy.mode === "auto",
  };
}

export function TeamRoutingPickerDetails() {
  const routing = useComposerRouting();
  if (!routing?.allowRouting || !routing.settings.data) return null;
  return (
    <div className="border-b px-3 py-3 text-xs" data-model-picker-content>
      <div className="flex items-center justify-between gap-3">
        <span className="font-medium">Jev routing</span>
        <div className="flex items-center gap-1" aria-label="Routing mode">
          {(
            [
              ["off", "Manual"],
              ["shadow", "Preview"],
              ["auto", "Auto"],
            ] as const
          ).map(([mode, label]) => (
            <Button
              key={mode}
              size="xs"
              variant={routing.settings.data?.policy.mode === mode ? "secondary" : "ghost"}
              aria-pressed={routing.settings.data?.policy.mode === mode}
              disabled={routing.saving}
              onClick={() => void routing.setMode(mode)}
            >
              {label}
            </Button>
          ))}
        </div>
      </div>
      {routing.enabled && (
        <p className="mt-2 text-muted-foreground" role="status">
          {routing.summary}
        </p>
      )}
      {routing.settings.data.policy.mode === "shadow" && (
        <p className="mt-1 text-muted-foreground">Preview only. Send uses your selected model.</p>
      )}
      {routing.automatic && (
        <p className="mt-1 text-muted-foreground">
          Select a model below to return to manual selection.
        </p>
      )}
      {routing.enabled && (
        <details className="mt-2 text-muted-foreground">
          <summary className="cursor-pointer hover:text-foreground">Decision details</summary>
          <div className="mt-2 space-y-2">
            <p>{routing.assessment?.reason ?? "Waiting for a draft assessment."}</p>
            <p>
              Allowed lead models:{" "}
              {routing.settings.data.policy.profiles
                .filter((p) => p.lead)
                .map((p) => p.label)
                .join(", ")}
            </p>
            <p>Manage models in Settings → Orchestration.</p>
          </div>
        </details>
      )}
      {routing.modeError && (
        <p role="alert" className="mt-2 text-destructive">
          {routing.modeError}
        </p>
      )}
    </div>
  );
}

export function TeamRoutingActions() {
  const routing = useComposerRouting();
  if (!routing?.projectId) return null;
  return (
    <TeamRunControls
      environmentId={routing.environmentId}
      projectId={routing.projectId}
      prompt={routing.prompt}
      assessment={routing.assessment}
      hasAttachments={routing.hasAttachments}
      composing={routing.composing}
      showStart={routing.enabled && !!routing.prompt.trim()}
    />
  );
}

export function TeamManualModelControls({ children }: { children: ReactNode }) {
  const routing = useComposerRouting();
  return routing?.automatic ? null : children;
}

import { useAtomValue } from "@effect/atom-react";
import { serverEnvironment } from "../../state/server";
import { Switch } from "../ui/switch";
import { useNavigate } from "@tanstack/react-router";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { useRightPanelStore } from "../../rightPanelStore";
import { randomUUID } from "../../lib/utils";
import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import type { EnvironmentId, ProjectId, TeamAssessment } from "@t3tools/contracts";
import { createTeamDraftCoordinator } from "@t3tools/client-runtime/state/team-draft";
import { teamEnvironment } from "../../state/team";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";

const RoutingContext = createContext<ReturnType<typeof useTeamRoutingState> | null>(null);
export const useComposerRouting = () => useContext(RoutingContext);

export function TeamRoutingProvider({
  state,
  children,
}: {
  state: ReturnType<typeof useTeamRoutingState>;
  children: ReactNode;
}) {
  return <RoutingContext value={state}>{children}</RoutingContext>;
}

type RoutingProps = {
  scopeKey: string;
  environmentId: EnvironmentId;
  projectId: ProjectId | null;
  prompt: string;
  hasAttachments: boolean;
  composing: boolean;
  allowRouting: boolean;
};
export function useTeamRoutingState({
  scopeKey,
  environmentId,
  projectId,
  prompt,
  hasAttachments,
  composing,
  allowRouting,
}: RoutingProps) {
  const config = useAtomValue(serverEnvironment.configValueAtom(environmentId));
  const available = config?.teamRouting === true;
  const [enabledScope, setEnabledScope] = useState<string | null>(null);
  const orchestration = available && allowRouting && enabledScope === scopeKey;
  const navigate = useNavigate();
  const start = useAtomCommand(teamEnvironment.start, { reportFailure: false });
  const starting = useRef(false);
  const [pending, setPending] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);
  const command = useRef<{ key: string; id: string } | null>(null);
  const settings = useEnvironmentQuery(
    available ? teamEnvironment.settings({ environmentId, input: {} }) : null,
  );
  const assess = useAtomCommand(teamEnvironment.assess, { reportFailure: false });
  const [result, setResult] = useState<{
    key: string;
    assessment: TeamAssessment | null;
    failed: boolean;
  } | null>(null);
  const [draftId] = useState(randomUUID);
  const revision = useRef(0);
  const enabled = orchestration && settings.data?.policy.mode !== "off" && settings.data !== null;
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
  async function setOrchestration(on: boolean) {
    if (pending || saving) return;
    if (on && settings.data?.policy.mode === "off" && !(await setMode("shadow"))) return;
    setEnabledScope(on ? scopeKey : null);
    setStartError(null);
  }
  const blocked = pending
    ? "Starting team"
    : !settings.data?.jevConfigured
      ? "Add your Jev key in Orchestration settings"
      : hasAttachments
        ? "Orchestration currently supports text-only requests"
        : composing
          ? "Finish typing to start orchestration"
          : !assessment?.selection
            ? failed
              ? "Routing unavailable; check Orchestration settings"
              : "Choosing team lead"
            : null;
  async function submit() {
    if (!orchestration || blocked || !assessment || !projectId || starting.current) return;
    starting.current = true;
    setPending(true);
    setStartError(null);
    const key = JSON.stringify([scopeKey, prompt, assessment.fingerprint]);
    if (command.current?.key !== key) command.current = { key, id: randomUUID() };
    const response = await start({
      environmentId,
      input: {
        commandId: command.current.id,
        projectId,
        fingerprint: assessment.fingerprint,
        draft: {
          draftId: assessment.draftId,
          revision: assessment.revision,
          policyRevision: assessment.policyRevision,
          prompt,
          hasAttachments,
        },
      },
    });
    starting.current = false;
    setPending(false);
    if (response._tag === "Failure") {
      const error = squashAtomCommandFailure(response);
      setStartError(error instanceof Error ? error.message : "Could not start orchestration.");
      return;
    }
    if (response.value.execution) {
      const threadId = response.value.execution.leadThreadId;
      useRightPanelStore.getState().open({ environmentId, threadId }, "agents");
      await navigate({ to: "/$environmentId/$threadId", params: { environmentId, threadId } });
    }
  }
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
    available,
    orchestration,
    setOrchestration,
    pending,
    blocked,
    submit,
    startError,
    automatic: orchestration,
  };
}

export function TeamRoutingPickerDetails() {
  const routing = useComposerRouting();
  if (!routing?.orchestration) return null;
  return (
    <div className="px-3 py-3 text-xs" data-model-picker-content>
      <p className="font-medium">Orchestration chooses the team lead</p>
      <p className="mt-1 text-muted-foreground" role="status">
        {routing.summary}
      </p>
      <p className="mt-1 text-muted-foreground">
        Selecting a model turns orchestration off for this draft.
      </p>
    </div>
  );
}

export function TeamRoutingActions() {
  const routing = useComposerRouting();
  if (!routing?.available || !routing.allowRouting || !routing.projectId) return null;
  return (
    <label className="flex shrink-0 cursor-pointer items-center gap-1.5 text-xs text-muted-foreground">
      <Switch
        size="sm"
        checked={routing.orchestration}
        disabled={routing.pending || routing.saving || !routing.settings.data}
        onCheckedChange={(on) => void routing.setOrchestration(on)}
      />
      Orchestration
    </label>
  );
}

export function TeamRoutingStatus() {
  const routing = useComposerRouting();
  const error = routing?.startError ?? routing?.modeError;
  return error ? (
    <p className="px-3 py-1 text-xs text-destructive" role="alert">
      {error}
    </p>
  ) : null;
}

export function TeamManualModelControls({ children }: { children: ReactNode }) {
  const routing = useComposerRouting();
  return routing?.automatic ? null : children;
}

import { useAtomValue } from "@effect/atom-react";
import { scopeThreadRef } from "@dispatch/client-runtime/environment";
import { serverEnvironment } from "../../state/server";
import { Switch } from "../ui/switch";
import { useNavigate } from "@tanstack/react-router";
import { squashAtomCommandFailure } from "@dispatch/client-runtime/state/runtime";
import { useRightPanelStore } from "../../rightPanelStore";
import { randomUUID } from "../../lib/utils";
import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import type {
  ChatAttachment,
  EnvironmentId,
  ProjectId,
  TeamAssessment,
  TeamSettings,
} from "@dispatch/contracts";
import { createTeamDraftCoordinator } from "@dispatch/client-runtime/state/team-draft";
import { teamEnvironment } from "../../state/team";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { waitForThreadShell } from "../../state/entities";
import type {
  ComposerFileAttachment,
  ComposerImageAttachment,
  ComposerThreadDraftState,
  ComposerThreadTarget,
} from "../../composerDraftStore";
import {
  awaitAttachmentUploads,
  forgetDraftAttachmentUploads,
  getUploadedAttachments,
  startAttachmentUpload,
} from "../../lib/attachmentUploadQueue";
import { ATTACHMENT_ONLY_BOOTSTRAP_PROMPT } from "./composerPromptHistory";

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
  hasUnsupportedContext: boolean;
  attachments: ReadonlyArray<ComposerImageAttachment | ComposerFileAttachment>;
  attachmentUploadsCapabilityKnown: boolean;
  supportsAttachmentUploads: boolean;
  attachmentDraftTarget: ComposerThreadTarget;
  composing: boolean;
  allowRouting: boolean;
};

export function isTeamRoutingReady(
  serverCapable: boolean,
  settings: TeamSettings | null | undefined,
): boolean {
  return (
    serverCapable &&
    settings !== null &&
    settings !== undefined &&
    settings.jevConfigured &&
    settings.policy.profiles.some(
      (profile) => profile.lead && profile.tier === "capable" && profile.reviewRequired !== true,
    )
  );
}

export function clearStartedTeamDraftIfUnchanged(input: {
  currentDraft: Pick<ComposerThreadDraftState, "prompt" | "images" | "files"> | null;
  promptSnapshot: string;
  attachmentIds: ReadonlyArray<string>;
  clear: () => void;
}): boolean {
  const currentIds = input.currentDraft
    ? [...input.currentDraft.images, ...input.currentDraft.files].map((attachment) => attachment.id)
    : null;
  if (
    !input.currentDraft ||
    input.currentDraft.prompt !== input.promptSnapshot ||
    currentIds?.length !== input.attachmentIds.length ||
    !currentIds.every((id, index) => id === input.attachmentIds[index])
  ) {
    return false;
  }
  input.clear();
  return true;
}
export function useTeamRoutingState({
  scopeKey,
  environmentId,
  projectId,
  prompt,
  hasAttachments,
  hasUnsupportedContext,
  attachments,
  attachmentUploadsCapabilityKnown,
  supportsAttachmentUploads,
  attachmentDraftTarget,
  composing,
  allowRouting,
}: RoutingProps) {
  const config = useAtomValue(serverEnvironment.configValueAtom(environmentId));
  const available = config?.teamRouting === true;
  const navigate = useNavigate();
  const start = useAtomCommand(teamEnvironment.start, { reportFailure: false });
  const starting = useRef(false);
  const [pending, setPending] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);
  const command = useRef<{ key: string; id: string } | null>(null);
  const settings = useEnvironmentQuery(
    available ? teamEnvironment.settings({ environmentId, input: {} }) : null,
  );
  const ready = isTeamRoutingReady(available, settings.data);
  const [enabledScope, setEnabledScope] = useState<string | null>(null);
  const orchestration = ready && allowRouting && enabledScope === scopeKey;
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
  const promptForRouting =
    prompt.trim() || (hasAttachments ? ATTACHMENT_ONLY_BOOTSTRAP_PROMPT : "");
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
    promptForRouting,
    hasAttachments,
    hasUnsupportedContext,
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
    if (enabled && (promptForRouting.length > 0 || hasAttachments))
      coordinator.schedule(
        {
          draftId,
          revision: ++revision.current,
          policyRevision,
          prompt: promptForRouting,
          hasAttachments,
        },
        composing,
      );
    return () => coordinator.dispose();
  }, [
    draftId,
    assess,
    environmentId,
    promptForRouting,
    hasAttachments,
    hasUnsupportedContext,
    composing,
    enabled,
    policyRevision,
    requestKey,
  ]);
  const profile = settings.data?.policy.profiles.find((p) => p.id === assessment?.profileId);
  const effort = profile?.selection.options?.find((option) =>
    ["reasoningEffort", "effort", "reasoning", "variant"].includes(option.id),
  )?.value;
  const modelLabel = profile?.label.replace(/^.*? · /, "") ?? "No eligible model";
  const summary = failed
    ? "Routing unavailable"
    : assessment
      ? `${modelLabel}${typeof effort === "string" ? ` · ${effort}` : ""}`
      : promptForRouting
        ? "Choosing model…"
        : "Chooses when you type";
  async function setOrchestration(on: boolean) {
    if (pending || saving) return;
    if (on && !ready) return;
    if (on && settings.data?.policy.mode === "off" && !(await setMode("shadow"))) return;
    setEnabledScope(on ? scopeKey : null);
    setStartError(null);
  }
  const blocked = pending
    ? "Starting team"
    : !settings.data?.jevConfigured
      ? "Add your Jev key in Orchestration settings"
      : hasUnsupportedContext
        ? "Remove terminal, preview, or review context to start orchestration"
        : !promptForRouting && !hasAttachments
          ? "Add a prompt or attachment"
          : composing
            ? "Finish typing to start orchestration"
            : !assessment?.selection
              ? failed
                ? "Routing unavailable; check Orchestration settings"
                : "Choosing team lead"
              : null;
  async function submit(): Promise<boolean> {
    if (!orchestration || blocked || !assessment || !projectId || starting.current) return false;
    starting.current = true;
    setPending(true);
    setStartError(null);
    try {
      const key = JSON.stringify([
        scopeKey,
        promptForRouting,
        assessment.fingerprint,
        attachments.map((attachment) => attachment.id),
      ]);
      if (command.current?.key !== key) command.current = { key, id: randomUUID() };
      const commandId = command.current.id;
      let uploadedAttachments: ChatAttachment[] = [];
      if (attachments.length > 0) {
        if (!attachmentUploadsCapabilityKnown || !supportsAttachmentUploads) {
          setStartError("This server cannot upload attachments for orchestration.");
          return false;
        }
        for (const attachment of attachments) {
          startAttachmentUpload({
            environmentId,
            image: attachment,
            draftTarget: attachmentDraftTarget,
          });
        }
        await awaitAttachmentUploads(attachments.map((attachment) => attachment.id));
        const ready = getUploadedAttachments({ environmentId, images: attachments });
        if (ready === null) {
          setStartError("Retry or remove failed uploads before starting orchestration.");
          return false;
        }
        uploadedAttachments = ready;
      }
      const response = await start({
        environmentId,
        input: {
          commandId,
          projectId,
          fingerprint: assessment.fingerprint,
          draft: {
            draftId: assessment.draftId,
            revision: assessment.revision,
            policyRevision: assessment.policyRevision,
            prompt: promptForRouting,
            hasAttachments,
          },
          ...(uploadedAttachments.length > 0 ? { attachments: uploadedAttachments } : {}),
        },
      });
      if (response._tag === "Failure") {
        const error = squashAtomCommandFailure(response);
        setStartError(error instanceof Error ? error.message : "Could not start orchestration.");
        return false;
      }
      if (uploadedAttachments.length > 0) forgetDraftAttachmentUploads(attachments);
      if (response.value.execution) {
        const threadId = response.value.execution.leadThreadId;
        try {
          const ready = await waitForThreadShell(scopeThreadRef(environmentId, threadId));
          if (!ready) {
            setStartError(
              "Team started, but its lead thread is still syncing. Try opening it again.",
            );
            return true;
          }
          useRightPanelStore.getState().open({ environmentId, threadId }, "agents");
          await navigate({ to: "/$environmentId/$threadId", params: { environmentId, threadId } });
        } catch {
          setStartError(
            "Team started, but its lead thread is still syncing. Try opening it again.",
          );
          return true;
        }
      }
      return true;
    } catch (error) {
      setStartError(error instanceof Error ? error.message : "Could not start orchestration.");
      return false;
    } finally {
      starting.current = false;
      setPending(false);
    }
  }
  return {
    environmentId,
    projectId,
    prompt,
    hasAttachments,
    hasUnsupportedContext,
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
    ready,
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
  if (!routing?.ready || !routing.allowRouting || !routing.projectId) return null;
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

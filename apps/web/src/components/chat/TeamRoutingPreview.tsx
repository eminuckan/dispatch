import { useAtomValue } from "@effect/atom-react";
import { scopeThreadRef } from "@dispatch/client-runtime/environment";
import { serverEnvironment } from "../../state/server";
import { Switch } from "../ui/switch";
import { useNavigate } from "@tanstack/react-router";
import { squashAtomCommandFailure } from "@dispatch/client-runtime/state/runtime";
import { useRightPanelStore } from "../../rightPanelStore";
import { randomUUID } from "../../lib/utils";
import { createContext, useContext, useRef, useState, type ReactNode } from "react";
import type {
  ChatAttachment,
  EnvironmentId,
  ProjectId,
  RuntimeMode,
  TeamSettings,
} from "@dispatch/contracts";
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
import { flowAutoFallbackNotice } from "../../flowPresentation";
import { hasFlowLead, hasRequiredFlowRole } from "../../flowPolicy";

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
  runtimeMode: RuntimeMode;
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
    settings.policy.enabled &&
    hasRequiredFlowRole(settings.policy)
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
  runtimeMode,
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
  const promptForRouting =
    prompt.trim() || (hasAttachments ? ATTACHMENT_ONLY_BOOTSTRAP_PROMPT : "");
  const flowMode = settings.data?.policy.flowMode ?? "standard";
  const smartRouting = flowMode === "auto" && settings.data?.smartRouting.available === true;
  const hasLead = settings.data ? hasFlowLead(settings.data.policy) : false;
  const autoFallbackNeedsLead = flowMode === "auto" && !smartRouting && !hasLead;
  const autoManagedNeedsLead = flowMode === "auto" && smartRouting && !hasLead;
  const fallbackNotice = orchestration ? flowAutoFallbackNotice(settings.data) : null;
  const autoLeadNotice =
    orchestration && autoManagedNeedsLead
      ? "Worker-only Auto can run direct work. If Smart Routing chooses a managed team, add a Lead before that task can start."
      : null;
  const modeLabel = flowMode === "auto" ? "Flow · Auto" : "Flow · Standard";
  const summary =
    flowMode === "auto"
      ? smartRouting
        ? autoManagedNeedsLead
          ? "Worker-only Auto is ready for direct execution; managed-team decisions require a selected Lead"
          : "Smart Routing chooses direct execution or a managed team from your selected models"
        : autoFallbackNeedsLead
          ? "Auto is unavailable; Standard fallback needs a selected Lead before this task can start"
          : "Auto is unavailable, so this run will use Standard with your selected models"
      : "Standard uses your selected Lead and Worker models without hosted routing";
  async function setOrchestration(on: boolean) {
    if (pending) return;
    if (on && !ready) return;
    setEnabledScope(on ? scopeKey : null);
    setStartError(null);
  }
  const blocked = pending
    ? "Starting team"
    : hasUnsupportedContext
      ? "Remove terminal, preview, or review context to start Flow"
      : !promptForRouting && !hasAttachments
        ? "Add a prompt or attachment"
        : composing
          ? "Finish typing to start Flow"
          : null;
  async function submit(): Promise<boolean> {
    if (!orchestration || blocked || !projectId || starting.current) return false;
    starting.current = true;
    setPending(true);
    setStartError(null);
    try {
      const key = JSON.stringify([
        scopeKey,
        projectId,
        runtimeMode,
        promptForRouting,
        attachments.map((attachment) => attachment.id),
      ]);
      if (command.current?.key !== key) command.current = { key, id: randomUUID() };
      const commandId = command.current.id;
      let uploadedAttachments: ChatAttachment[] = [];
      if (attachments.length > 0) {
        if (!attachmentUploadsCapabilityKnown || !supportsAttachmentUploads) {
          setStartError("This server cannot upload attachments for Flow.");
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
          setStartError("Retry or remove failed uploads before starting Flow.");
          return false;
        }
        uploadedAttachments = ready;
      }
      const response = await start({
        environmentId,
        input: {
          commandId,
          projectId,
          runtimeMode,
          prompt: promptForRouting,
          attachments: uploadedAttachments,
        },
      });
      if (response._tag === "Failure") {
        const error = squashAtomCommandFailure(response);
        setStartError(error instanceof Error ? error.message : "Could not start Flow.");
        return false;
      }
      if (uploadedAttachments.length > 0) forgetDraftAttachmentUploads(attachments);
      const threadId = response.value.lead.threadId;
      if (threadId) {
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
      setStartError(error instanceof Error ? error.message : "Could not start Flow.");
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
    summary,
    flowMode,
    smartRouting,
    autoFallbackNeedsLead,
    autoManagedNeedsLead,
    fallbackNotice,
    autoLeadNotice,
    modeLabel,
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
      <p className="font-medium">{routing.flowMode === "auto" ? "Flow Auto" : "Flow Standard"}</p>
      <p className="mt-1 text-muted-foreground" role="status">
        {routing.summary}
      </p>
      <p className="mt-1 text-muted-foreground">Selecting a model turns Flow off for this draft.</p>
    </div>
  );
}

export function TeamRoutingActions() {
  const routing = useComposerRouting();
  if (!routing || !routing.allowRouting || !routing.projectId) return null;
  if (!routing.ready) return null;
  return (
    <label className="flex shrink-0 cursor-pointer items-center gap-1.5 text-xs text-muted-foreground">
      <Switch
        size="sm"
        checked={routing.orchestration}
        disabled={routing.pending || !routing.settings.data}
        onCheckedChange={(on) => void routing.setOrchestration(on)}
      />
      {routing.modeLabel}
    </label>
  );
}

export function TeamRoutingStatus() {
  const routing = useComposerRouting();
  const error = routing?.startError;
  if (error)
    return (
      <p className="px-3 py-1 text-xs text-destructive" role="alert">
        {error}
      </p>
    );
  const notice = routing?.fallbackNotice ?? routing?.autoLeadNotice ?? null;
  return notice ? (
    <p className="px-3 py-1 text-xs text-muted-foreground" role="status">
      {notice}
    </p>
  ) : null;
}

export function TeamManualModelControls({ children }: { children: ReactNode }) {
  const routing = useComposerRouting();
  return routing?.automatic ? null : children;
}

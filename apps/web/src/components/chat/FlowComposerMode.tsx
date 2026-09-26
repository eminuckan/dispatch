import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, ProjectId, ThreadId } from "@dispatch/contracts";
import { createContext, useContext, useState, type ReactNode } from "react";

import { serverEnvironment } from "../../state/server";
import { Switch } from "../ui/switch";

const FlowContext = createContext<ReturnType<typeof useFlowComposerMode> | null>(null);
export const useFlowComposerModeContext = () => useContext(FlowContext);

export function FlowComposerModeProvider({
  state,
  children,
}: {
  state: ReturnType<typeof useFlowComposerMode>;
  children: ReactNode;
}) {
  return <FlowContext value={state}>{children}</FlowContext>;
}

export function useFlowComposerMode(input: {
  environmentId: EnvironmentId;
  projectId: ProjectId | null;
  threadId: ThreadId | null;
  initialEnabled: boolean;
  allowRouting: boolean;
  onExistingThreadChange: (enabled: boolean) => Promise<void>;
  onDraftChange: (enabled: boolean) => void;
}) {
  const config = useAtomValue(serverEnvironment.configValueAtom(input.environmentId));
  const available = config?.flow === true;
  const [pending, setPending] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);
  const enabled = input.allowRouting && available && input.initialEnabled;

  async function setEnabled(enabled: boolean) {
    if (pending || !available || !input.allowRouting) return;
    setStartError(null);
    if (input.threadId) {
      setPending(true);
      try {
        await input.onExistingThreadChange(enabled);
      } catch (cause) {
        setStartError(cause instanceof Error ? cause.message : "Could not change Flow mode.");
        setPending(false);
        return;
      }
      setPending(false);
    }
    if (!input.threadId) input.onDraftChange(enabled);
  }

  return {
    enabled,
    available,
    ready: available && input.allowRouting && input.projectId !== null,
    allowRouting: input.allowRouting,
    projectId: input.projectId,
    setEnabled,
    pending,
    blocked: pending ? "Changing Flow mode" : null,
    startError,
  };
}

export function FlowModelPickerDetails() {
  const flow = useFlowComposerModeContext();
  if (!flow?.enabled) return null;
  return (
    <div className="px-3 py-3 text-xs" data-model-picker-content>
      <p className="font-medium">Flow</p>
      <p className="mt-1 text-muted-foreground">
        The selected model leads this thread. It can start workers when delegation helps.
      </p>
    </div>
  );
}

export function FlowComposerToggle() {
  const flow = useFlowComposerModeContext();
  if (!flow?.ready) return null;
  return (
    <label className="flex shrink-0 cursor-pointer items-center gap-1.5 text-xs text-muted-foreground">
      <Switch
        size="sm"
        checked={flow.enabled}
        aria-label="Flow"
        aria-checked={flow.enabled}
        disabled={flow.pending}
        onCheckedChange={(enabled) => void flow.setEnabled(enabled)}
      />
      Flow
    </label>
  );
}

export function FlowComposerStatus() {
  const error = useFlowComposerModeContext()?.startError;
  return error ? (
    <p className="px-3 py-1 text-xs text-destructive" role="alert">
      {error}
    </p>
  ) : null;
}

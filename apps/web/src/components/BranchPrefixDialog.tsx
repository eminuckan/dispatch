import {
  DEFAULT_SERVER_SETTINGS,
  getBranchPrefixValidationError,
  normalizeBranchPrefix,
  type EnvironmentId,
  type ProjectId,
} from "@dispatch/contracts";
import { useId, useState, type ReactNode } from "react";
import { useNavigate } from "@tanstack/react-router";

import { useEnvironment } from "../state/environments";
import { SettingsScopeProvider, useSettingsScope } from "./settings/SettingsScopeContext";
import { useSettingsProjectGroups } from "./settings/useSettingsProjectGroups";
import { useClearScopedSettings, useUpdateScopedSettings } from "./settings/useScopedSettings";
import { Button } from "./ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "./ui/dialog";
import { Input } from "./ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "./ui/select";

export function BranchPrefixDialog({
  environmentId,
  projectId,
  onClose,
}: {
  environmentId: EnvironmentId;
  projectId: ProjectId;
  onClose: () => void;
}) {
  const environment = useEnvironment(environmentId);
  const navigate = useNavigate();
  const groups = useSettingsProjectGroups();
  const group = groups.find((candidate) =>
    candidate.memberProjects.some(
      (member) => member.environmentId === environmentId && member.id === projectId,
    ),
  );
  const member = group?.memberProjects.find(
    (candidate) => candidate.environmentId === environmentId && candidate.id === projectId,
  );
  const [scope, setScope] = useState("project");
  const [pending, setPending] = useState(false);
  const search =
    scope === "environment"
      ? { machine: environmentId }
      : {
          machine: environmentId,
          // A removed checkout must stay unavailable instead of broadening a write.
          project: group?.projectKey ?? projectId,
          checkout: member?.physicalProjectKey ?? projectId,
        };
  const projectLabel = `${group?.displayName ?? "Unavailable"} · ${environment?.label ?? "Unavailable"}`;
  const scopeLabel = scope === "environment" ? (environment?.label ?? "Unavailable") : projectLabel;

  return (
    <Dialog open onOpenChange={(open) => !open && !pending && onClose()}>
      <DialogPopup className="max-w-md" bottomStickOnMobile={false} showCloseButton={!pending}>
        <DialogHeader>
          <DialogTitle>Branch prefix</DialogTitle>
          <DialogDescription>
            Customize new branch names. Leave empty for no prefix.
          </DialogDescription>
        </DialogHeader>
        <SettingsScopeProvider
          search={search}
          onChange={(next) => {
            if (pending) return;
            void navigate({ to: "/settings/source-control", search: next });
            onClose();
          }}
        >
          <BranchPrefixForm
            key={JSON.stringify([search.project, search.machine, search.checkout])}
            pending={pending}
            onPendingChange={setPending}
            onClose={onClose}
            scopeControl={
              <div className="space-y-2">
                <div className="text-sm font-medium">Apply to</div>
                <Select
                  value={scope}
                  disabled={pending}
                  onValueChange={(value) => {
                    if (value && !pending) setScope(value);
                  }}
                >
                  <SelectTrigger
                    aria-label="Branch prefix scope"
                    className="w-full"
                    title={scopeLabel}
                  >
                    <SelectValue>
                      {scope === "environment" ? "Environment" : "Project"} · {scopeLabel}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectPopup>
                    <SelectItem value="project">Project · {projectLabel}</SelectItem>
                    <SelectItem value="environment">
                      Environment · {environment?.label ?? "Unavailable"}
                    </SelectItem>
                  </SelectPopup>
                </Select>
              </div>
            }
          />
        </SettingsScopeProvider>
      </DialogPopup>
    </Dialog>
  );
}

function BranchPrefixForm({
  scopeControl,
  pending,
  onPendingChange,
  onClose,
}: {
  scopeControl: ReactNode;
  pending: boolean;
  onPendingChange: (pending: boolean) => void;
  onClose: () => void;
}) {
  const { scope, target, connectedEnvironments } = useSettingsScope();
  const updateSettings = useUpdateScopedSettings();
  const clearSettings = useClearScopedSettings();
  const [draft, setDraft] = useState<{ value: string } | { inherit: true } | null>(null);
  const inputId = useId();
  const hintId = useId();
  const projectScope = scope.kind === "project" || scope.kind === "checkout";
  const overridden = target?.sources.branchPrefix === "project";
  const prefix = target?.settings.branchPrefix ?? DEFAULT_SERVER_SETTINGS.branchPrefix;
  const environmentPrefix =
    connectedEnvironments.find((environment) => environment.environmentId === target?.environmentId)
      ?.serverConfig?.settings.branchPrefix ?? DEFAULT_SERVER_SETTINGS.branchPrefix;
  const inherit = draft !== null && "inherit" in draft;
  const value = inherit ? environmentPrefix : draft && "value" in draft ? draft.value : prefix;
  const supported =
    target !== null &&
    scope.kind !== "unavailable" &&
    connectedEnvironments.length > 0 &&
    connectedEnvironments.every(
      (environment) =>
        environment.serverConfig?.environment.capabilities.branchPrefixSettings === true &&
        (!projectScope ||
          environment.serverConfig.environment.capabilities.projectSettingsOverrides === true),
    );
  const error = getBranchPrefixValidationError(value);
  const dirty = inherit
    ? overridden
    : draft !== null && (normalizeBranchPrefix(value) !== prefix || (projectScope && !overridden));
  const canReset = projectScope
    ? !inherit && (overridden || draft !== null)
    : value !== DEFAULT_SERVER_SETTINGS.branchPrefix;

  return (
    <form
      className="flex min-h-0 flex-col"
      onSubmit={async (event) => {
        event.preventDefault();
        if (!supported || pending || !dirty || error) return;
        onPendingChange(true);
        try {
          const saved = inherit
            ? await clearSettings(["branchPrefix"])
            : await updateSettings({ branchPrefix: normalizeBranchPrefix(value) });
          if (saved === true) onClose();
        } finally {
          onPendingChange(false);
        }
      }}
    >
      <DialogPanel className="space-y-5">
        {scopeControl}
        <div className="space-y-2">
          <div className="flex min-h-6 items-center justify-between gap-3">
            <label htmlFor={inputId} className="text-sm font-medium">
              Prefix
            </label>
            {canReset ? (
              <Button
                type="button"
                size="xs"
                variant="ghost"
                className="h-6 px-1 text-xs text-muted-foreground"
                disabled={!supported || pending}
                onClick={() =>
                  setDraft(
                    projectScope
                      ? { inherit: true }
                      : { value: DEFAULT_SERVER_SETTINGS.branchPrefix },
                  )
                }
              >
                {projectScope ? "Use environment default" : "Reset to dispatch/"}
              </Button>
            ) : null}
          </div>
          <Input
            id={inputId}
            aria-label="Branch prefix"
            aria-describedby={hintId}
            aria-invalid={error !== null}
            value={value}
            placeholder="No prefix"
            onChange={(event) => setDraft({ value: event.target.value })}
            disabled={!supported || pending}
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            className="font-mono"
          />
          <p
            id={hintId}
            className={error ? "text-xs text-destructive" : "text-xs text-muted-foreground"}
            role={error ? "alert" : undefined}
          >
            {!supported
              ? scope.kind === "unavailable"
                ? scope.message
                : "Connect and update this environment to set a prefix."
              : (error ?? (
                  <>
                    {inherit ? "Environment default: " : "Example: "}
                    <span className="font-mono">{normalizeBranchPrefix(value)}fix-login</span>
                  </>
                ))}
          </p>
        </div>
      </DialogPanel>
      <DialogFooter>
        <Button type="button" variant="outline" disabled={pending} onClick={onClose}>
          Cancel
        </Button>
        <Button type="submit" disabled={!supported || pending || !dirty || error !== null}>
          {pending ? "Saving…" : "Save"}
        </Button>
      </DialogFooter>
    </form>
  );
}

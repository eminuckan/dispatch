import {
  DEFAULT_SERVER_SETTINGS,
  getBranchPrefixValidationError,
  normalizeBranchPrefix,
} from "@dispatch/contracts";
import { useId, useState } from "react";

import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { useSettingsScope } from "./SettingsScopeContext";
import { searchableSetting } from "./settingsSearch";
import { SettingResetButton, SettingsRow } from "./settingsLayout";
import {
  useClearScopedSettings,
  useScopedSettings,
  useScopedSettingsMixed,
  useScopedSettingSource,
  useUpdateScopedSettings,
} from "./useScopedSettings";

export function BranchPrefixSetting() {
  const { search } = useSettingsScope();
  const prefix = useScopedSettings((settings) => settings.branchPrefix);
  const mixed = useScopedSettingsMixed(["branchPrefix"]);
  // Scope changes start a fresh edit. Incoming settings leave the user's draft
  // intact, including optimistic updates that may fail and an explicitly empty value.
  return (
    <BranchPrefixEditor
      key={JSON.stringify([search.project, search.machine, search.checkout])}
      prefix={prefix}
      mixed={mixed}
    />
  );
}

function BranchPrefixEditor({ prefix, mixed }: { prefix: string; mixed: boolean }) {
  const { connectedEnvironments, scope } = useSettingsScope();
  const source = useScopedSettingSource(["branchPrefix"]);
  const updateSettings = useUpdateScopedSettings();
  const clearSettings = useClearScopedSettings();
  const [draft, setDraft] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const inputId = useId();
  const hintId = useId();
  const supported =
    connectedEnvironments.length > 0 &&
    connectedEnvironments.every(
      (environment) =>
        environment.serverConfig?.environment.capabilities.branchPrefixSettings === true,
    );
  const value = draft ?? (mixed ? "" : prefix);
  const error = draft === null ? null : getBranchPrefixValidationError(value);
  const inherited = (scope.kind === "project" || scope.kind === "checkout") && source !== "project";
  const dirty = draft !== null && (mixed || inherited || normalizeBranchPrefix(value) !== prefix);

  async function save() {
    if (!supported || pending || !dirty || error) return;
    setPending(true);
    try {
      if (await updateSettings({ branchPrefix: normalizeBranchPrefix(value) })) setDraft(null);
    } finally {
      setPending(false);
    }
  }

  async function reset(inherit: boolean) {
    if (!supported || pending) return;
    setPending(true);
    try {
      const saved = inherit
        ? await clearSettings(["branchPrefix"])
        : await updateSettings({ branchPrefix: DEFAULT_SERVER_SETTINGS.branchPrefix });
      if (saved) setDraft(null);
    } finally {
      setPending(false);
    }
  }

  return (
    <SettingsRow
      serverScoped
      settingKeys={["branchPrefix"]}
      mixed={mixed}
      {...searchableSetting("branch-prefix")}
      description="Used for generated branch names and the New branch form. Leave empty for no prefix."
      onResetOverride={() => void reset(true)}
      resetAction={
        supported && !pending && (mixed || prefix !== DEFAULT_SERVER_SETTINGS.branchPrefix) ? (
          <SettingResetButton
            label="branch prefix"
            tooltip="Reset to dispatch/"
            onClick={() => void reset(false)}
          />
        ) : null
      }
      control={
        <form
          className="flex w-full flex-col gap-1.5 sm:min-w-64"
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          <div className="flex items-center gap-2">
            <Input
              id={inputId}
              aria-label="Branch prefix"
              aria-describedby={hintId}
              aria-invalid={error !== null}
              size="sm"
              className="min-w-0 font-mono"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              placeholder={mixed ? "Mixed" : "No prefix"}
              value={value}
              onChange={(event) => setDraft(event.target.value)}
              disabled={!supported || pending}
            />
            <Button
              type="submit"
              size="sm"
              variant="outline"
              disabled={!supported || pending || !dirty || error !== null}
            >
              {pending ? "Saving…" : "Save"}
            </Button>
          </div>
          <span
            id={hintId}
            className={error ? "text-destructive text-xs" : "text-muted-foreground text-xs"}
            role={error ? "alert" : undefined}
          >
            {!supported
              ? "Connect and update the selected environments to set a prefix."
              : (error ??
                (mixed && draft === null
                  ? "Enter a prefix to apply to all selected targets."
                  : `Example: ${normalizeBranchPrefix(value)}fix-login`))}
          </span>
        </form>
      }
    />
  );
}

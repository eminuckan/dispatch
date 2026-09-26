import { useAtomValue } from "@effect/atom-react";
import type {
  EnvironmentId,
  FlowWorkerProfile,
  ModelSelection,
  ProviderInstanceId,
  ServerProvider,
  UnifiedSettings,
} from "@dispatch/contracts";
import { createModelSelection } from "@dispatch/shared/model";
import * as Equal from "effect/Equal";
import { PlusIcon, Trash2Icon } from "lucide-react";
import { useState } from "react";

import { getCustomModelOptionsByInstance } from "../../modelSelection";
import { randomUUID } from "../../lib/utils";
import {
  applyProviderInstanceSettings,
  deriveProviderInstanceEntries,
  sortProviderInstanceEntries,
} from "../../providerInstances";
import { EMPTY_SERVER_PROVIDERS, serverEnvironment } from "../../state/server";
import { ProviderModelPicker } from "../chat/ProviderModelPicker";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Textarea } from "../ui/textarea";
import { toastManager } from "../ui/toast";
import { useSettingsScope } from "./SettingsScopeContext";
import { SettingsPageContainer, SettingsSection } from "./settingsLayout";
import { useScopedModelDisabledReason } from "./useScopedModelAvailability";
import {
  useClearScopedSettings,
  useScopedSettingSource,
  useScopedSettings,
  useScopedSettingsMixed,
  useUpdateScopedSettings,
} from "./useScopedSettings";

const TIERS = [
  {
    id: "deep",
    title: "Deep work",
    description: "Use stronger models for difficult implementation, investigation, and review.",
    newName: "Deep worker",
  },
  {
    id: "routine",
    title: "Routine work",
    description: "Use economical models for frequent, bounded tasks. Review them carefully.",
    newName: "Routine worker",
  },
] as const;

type ProfileDraft = {
  readonly base: ReadonlyArray<FlowWorkerProfile>;
  readonly profiles: ReadonlyArray<FlowWorkerProfile>;
};

function syncPristineDraft(
  draft: ProfileDraft,
  remote: ReadonlyArray<FlowWorkerProfile>,
): ProfileDraft {
  return Equal.equals(draft.base, draft.profiles) && !Equal.equals(draft.base, remote)
    ? { base: remote, profiles: remote }
    : draft;
}

function effortDescriptor(providers: ReadonlyArray<ServerProvider>, selection: ModelSelection) {
  const provider = providers.find((item) => item.instanceId === selection.instanceId);
  const model = provider?.models.find((item) => item.slug === selection.model);
  return model?.capabilities?.optionDescriptors?.find(
    (option) =>
      option.type === "select" &&
      (option.id === "reasoningEffort" || option.id === "effort" || option.id === "thinkingLevel"),
  );
}

function ProfileRow({
  profile,
  providers,
  settings,
  disabled,
  onChange,
  onRemove,
}: {
  profile: FlowWorkerProfile;
  providers: ReadonlyArray<ServerProvider>;
  settings: UnifiedSettings;
  disabled: boolean;
  onChange: (next: FlowWorkerProfile) => void;
  onRemove: () => void;
}) {
  const entries = sortProviderInstanceEntries(
    applyProviderInstanceSettings(deriveProviderInstanceEntries(providers), settings),
  );
  const options = getCustomModelOptionsByInstance(
    settings,
    providers,
    profile.modelSelection.instanceId,
    profile.modelSelection.model,
  );
  const disabledReason = useScopedModelDisabledReason(settings, entries);
  const descriptor = effortDescriptor(providers, profile.modelSelection);
  const effort =
    descriptor?.type === "select"
      ? profile.modelSelection.options?.find((option) => option.id === descriptor.id)?.value
      : undefined;

  return (
    <div className="space-y-3 px-3 py-3 sm:px-4">
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1 space-y-1.5">
          <label htmlFor={`flow-name-${profile.id}`} className="text-xs text-muted-foreground">
            Worker name
          </label>
          <Input
            id={`flow-name-${profile.id}`}
            size="sm"
            value={profile.name}
            maxLength={80}
            disabled={disabled}
            onChange={(event) => onChange({ ...profile, name: event.target.value })}
          />
        </div>
        <Button
          size="icon-sm"
          variant="ghost-muted"
          className="mt-5 shrink-0"
          aria-label={`Remove ${profile.name || "worker"}`}
          disabled={disabled}
          onClick={onRemove}
        >
          <Trash2Icon className="size-4" />
        </Button>
      </div>
      <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_minmax(10rem,0.7fr)]">
        <div className="min-w-0 space-y-1.5">
          <span className="block text-xs text-muted-foreground">Provider and model</span>
          <ProviderModelPicker
            activeInstanceId={profile.modelSelection.instanceId}
            model={profile.modelSelection.model}
            lockedProvider={null}
            instanceEntries={entries}
            modelOptionsByInstance={options}
            triggerVariant="outline"
            triggerClassName="w-full justify-between"
            triggerAriaLabel={`${profile.name || "Worker"} model`}
            disabled={disabled}
            getModelDisabledReason={disabledReason}
            onInstanceModelChange={(instanceId: ProviderInstanceId, model: string) => {
              const reason = disabledReason(instanceId, model);
              if (reason) {
                toastManager.add({
                  type: "warning",
                  title: "Model unavailable",
                  description: reason,
                });
                return;
              }
              onChange({ ...profile, modelSelection: createModelSelection(instanceId, model) });
            }}
          />
        </div>
        <div className="min-w-0 space-y-1.5">
          <span className="block text-xs text-muted-foreground">Effort</span>
          {descriptor?.type === "select" ? (
            <Select
              value={typeof effort === "string" ? effort : "provider-default"}
              onValueChange={(value) => {
                if (value === null) return;
                const remaining = (profile.modelSelection.options ?? []).filter(
                  (option) => option.id !== descriptor.id,
                );
                onChange({
                  ...profile,
                  modelSelection: createModelSelection(
                    profile.modelSelection.instanceId,
                    profile.modelSelection.model,
                    value === "provider-default"
                      ? remaining
                      : [...remaining, { id: descriptor.id, value }],
                  ),
                });
              }}
              disabled={disabled}
            >
              <SelectTrigger
                size="sm"
                className="w-full"
                aria-label={`${profile.name || "Worker"} effort`}
              >
                <SelectValue>
                  {(value: string | null) =>
                    descriptor.options.find((option) => option.id === value)?.label ??
                    "Provider default"
                  }
                </SelectValue>
              </SelectTrigger>
              <SelectPopup align="start" alignItemWithTrigger={false}>
                <SelectItem value="provider-default">Provider default</SelectItem>
                {descriptor.options.map((option) => (
                  <SelectItem key={option.id} value={option.id}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          ) : (
            <p className="flex min-h-7 items-center text-xs text-muted-foreground">
              This model has no effort control.
            </p>
          )}
        </div>
      </div>
      <div className="space-y-1.5">
        <label htmlFor={`flow-use-${profile.id}`} className="text-xs text-muted-foreground">
          Best for · required
        </label>
        <Textarea
          id={`flow-use-${profile.id}`}
          value={profile.description}
          maxLength={300}
          rows={2}
          disabled={disabled}
          placeholder="What should the lead delegate to this worker?"
          onChange={(event) => onChange({ ...profile, description: event.target.value })}
        />
      </div>
    </div>
  );
}

function FlowSettingsEditor({ providers }: { providers: ReadonlyArray<ServerProvider> }) {
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  const clearSettings = useClearScopedSettings();
  const mixed = useScopedSettingsMixed(["flowWorkerProfiles"]);
  const source = useScopedSettingSource(["flowWorkerProfiles"]);
  const { connectedEnvironments } = useSettingsScope();
  const [storedDraft, setDraft] = useState<ProfileDraft>(() => ({
    base: settings.flowWorkerProfiles,
    profiles: settings.flowWorkerProfiles,
  }));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const draft = syncPristineDraft(storedDraft, settings.flowWorkerProfiles);
  const dirty = !Equal.equals(draft.base, draft.profiles);
  const changedRemotely = !Equal.equals(draft.base, settings.flowWorkerProfiles);
  const updateProfiles = (
    update: (profiles: ReadonlyArray<FlowWorkerProfile>) => ReadonlyArray<FlowWorkerProfile>,
  ) =>
    setDraft((current) => {
      const fresh = syncPristineDraft(current, settings.flowWorkerProfiles);
      return { ...fresh, profiles: update(fresh.profiles) };
    });

  const entries = sortProviderInstanceEntries(
    applyProviderInstanceSettings(deriveProviderInstanceEntries(providers), settings),
  );
  const disabledReason = useScopedModelDisabledReason(settings, entries);
  const firstModel = providers.flatMap((provider) =>
    provider.enabled &&
    provider.status === "ready" &&
    provider.auth.status !== "unauthenticated" &&
    provider.availability !== "unavailable"
      ? provider.models
          .filter((model) => !model.isLegacy && !disabledReason(provider.instanceId, model.slug))
          .map((model) => createModelSelection(provider.instanceId, model.slug))
      : [],
  )[0];
  const unavailable = connectedEnvironments.length === 0;
  const setProfile = (next: FlowWorkerProfile) =>
    updateProfiles((profiles) =>
      profiles.map((profile) => (profile.id === next.id ? next : profile)),
    );
  const discard = () => {
    setDraft({ base: settings.flowWorkerProfiles, profiles: settings.flowWorkerProfiles });
    setError(null);
  };
  const save = async () => {
    const profiles = draft.profiles.map((profile) => ({
      ...profile,
      name: profile.name.trim(),
      description: profile.description.trim(),
    }));
    if (profiles.some((profile) => !profile.name || !profile.description)) {
      setError("Give every worker a name and a description of when the lead should use it.");
      return;
    }
    if (changedRemotely) {
      setError(
        "Worker settings changed elsewhere. Discard this draft and edit the latest version.",
      );
      return;
    }
    setSaving(true);
    setError(null);
    const saved = await updateSettings({ flowWorkerProfiles: profiles });
    setSaving(false);
    if (saved) setDraft({ base: profiles, profiles });
    else setError("Could not save the worker pool. Try again.");
  };

  return (
    <SettingsPageContainer>
      <div className="flex flex-wrap items-start justify-between gap-3 px-3 sm:px-4">
        <div className="min-w-64 flex-1 space-y-1">
          <h1 className="text-base font-medium">Flow</h1>
          <p className="text-sm text-muted-foreground">
            Choose the workers your lead can call on. The lead picks a worker for each assignment,
            follows its progress, and reviews every result.
          </p>
        </div>
        <div className="ml-auto flex items-center gap-2">
          <Button size="sm" variant="ghost" disabled={!dirty || saving} onClick={discard}>
            Discard
          </Button>
          <Button
            size="sm"
            disabled={!dirty || saving || unavailable || changedRemotely}
            onClick={() => void save()}
          >
            {saving ? "Saving…" : "Save changes"}
          </Button>
        </div>
      </div>
      {mixed ? (
        <p className="px-3 text-xs text-muted-foreground sm:px-4">
          Selected scopes have different worker pools. Saving applies this pool to all of them.
        </p>
      ) : null}
      {source === "project" && !dirty ? (
        <div className="px-3 sm:px-4">
          <Button
            size="xs"
            variant="ghost-muted"
            onClick={() => clearSettings(["flowWorkerProfiles"])}
          >
            Use environment worker pool
          </Button>
        </div>
      ) : null}
      {changedRemotely && dirty ? (
        <p className="px-3 text-xs text-warning sm:px-4" role="alert">
          Worker settings changed elsewhere. Discard this draft to load the latest version.
        </p>
      ) : null}
      {error ? (
        <p className="px-3 text-xs text-destructive sm:px-4" role="alert">
          {error}
        </p>
      ) : null}
      {TIERS.map((tier) => {
        const profiles = draft.profiles.filter((profile) => profile.tier === tier.id);
        return (
          <SettingsSection
            key={tier.id}
            id={tier.id === "deep" ? "flow" : "flow-routine"}
            title={tier.title}
            headerAction={
              <Button
                size="xs"
                variant="ghost-muted"
                disabled={saving || unavailable || !firstModel || draft.profiles.length >= 24}
                onClick={() => {
                  if (!firstModel) return;
                  updateProfiles((profiles) => [
                    ...profiles,
                    {
                      id: randomUUID(),
                      name: tier.newName,
                      tier: tier.id,
                      description: "",
                      modelSelection: firstModel,
                    },
                  ]);
                }}
              >
                <PlusIcon className="size-3.5" /> Add worker
              </Button>
            }
          >
            {profiles.length === 0 ? (
              <p className="px-3 py-3 text-sm text-muted-foreground sm:px-4">
                {tier.description}{" "}
                {firstModel
                  ? "Add a worker to make it available to the lead."
                  : "Connect a provider to add a worker."}
              </p>
            ) : (
              profiles.map((profile) => (
                <ProfileRow
                  key={profile.id}
                  profile={profile}
                  providers={providers}
                  settings={settings}
                  disabled={saving}
                  onChange={setProfile}
                  onRemove={() =>
                    updateProfiles((profiles) =>
                      profiles.filter((entry) => entry.id !== profile.id),
                    )
                  }
                />
              ))
            )}
          </SettingsSection>
        );
      })}
      <p className="px-3 text-xs text-muted-foreground sm:px-4">
        Turn on Flow in a thread’s composer. Workers use Git worktrees where available or share a
        project folder that is not a Git repository. Your lead chooses the workspace and handles
        integration.
      </p>
    </SettingsPageContainer>
  );
}

export function TeamSettingsPanel({ environmentId }: { environmentId: EnvironmentId }) {
  const config = useAtomValue(serverEnvironment.configValueAtom(environmentId));
  const { scope } = useSettingsScope();
  if (config?.flow !== true)
    return (
      <SettingsPageContainer>
        <p className="px-3 text-sm text-muted-foreground">
          Update this environment’s server to use Flow.
        </p>
      </SettingsPageContainer>
    );
  return (
    <FlowSettingsEditor
      key={JSON.stringify(scope)}
      providers={config.providers ?? EMPTY_SERVER_PROVIDERS}
    />
  );
}

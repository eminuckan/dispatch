import { useAtomValue } from "@effect/atom-react";
import { useState, type ReactNode } from "react";
import { Trash2Icon } from "lucide-react";
import type {
  EnvironmentId,
  TeamSettings,
  TeamPolicy,
  TeamModelProfile,
  ServerProvider,
} from "@t3tools/contracts";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { randomUUID } from "../../lib/utils";
import { deriveProviderInstanceEntries } from "../../providerInstances";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { teamEnvironment } from "../../state/team";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Switch } from "../ui/switch";
import { Select, SelectTrigger, SelectValue, SelectPopup, SelectItem } from "../ui/select";
import { ProviderModelPicker } from "../chat/ProviderModelPicker";
import { SettingsPageContainer, SettingsSection, SettingsRow } from "./settingsLayout";
import { routingTierLabels, subscriptionRoutingPolicy } from "./teamProfileDefaults";

function ProfileOptions({
  initiallyOpen,
  children,
}: {
  initiallyOpen: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(initiallyOpen);
  return (
    <details
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
      className="text-xs text-muted-foreground"
    >
      {children}
    </details>
  );
}

function Choice({
  label,
  value,
  options,
  onChange,
  disabled = false,
}: {
  label: string;
  value: string;
  options: ReadonlyArray<{ value: string; label: string; disabled?: boolean }>;
  onChange: (value: string) => void;
  disabled?: boolean;
}) {
  return (
    <Select
      value={value}
      onValueChange={(v) => {
        if (v !== null) onChange(v);
      }}
      disabled={disabled}
    >
      <SelectTrigger size="sm" aria-label={label} className="w-auto max-w-full sm:max-w-72">
        <SelectValue>{options.find((o) => o.value === value)?.label ?? value}</SelectValue>
      </SelectTrigger>
      <SelectPopup align="end" alignItemWithTrigger={false}>
        {options.map((o) => (
          <SelectItem key={o.value} value={o.value} disabled={o.disabled}>
            {o.label}
          </SelectItem>
        ))}
      </SelectPopup>
    </Select>
  );
}

export function TeamSettingsPanel({ environmentId }: { environmentId: EnvironmentId }) {
  const config = useAtomValue(serverEnvironment.configValueAtom(environmentId));
  return config?.teamRouting === true ? (
    <TeamSettingsPanelContent environmentId={environmentId} />
  ) : (
    <SettingsPageContainer>
      <p className="text-sm text-muted-foreground">
        This environment does not support Jev routing. Update its server to continue.
      </p>
    </SettingsPageContainer>
  );
}
function TeamSettingsPanelContent({ environmentId }: { environmentId: EnvironmentId }) {
  const settings = useEnvironmentQuery(teamEnvironment.settings({ environmentId, input: {} }));
  const config = useAtomValue(serverEnvironment.configValueAtom(environmentId));
  if (settings.error)
    return (
      <SettingsPageContainer>
        <p role="alert" className="text-sm text-destructive">
          {settings.error}
        </p>
      </SettingsPageContainer>
    );
  if (!settings.data)
    return (
      <SettingsPageContainer>
        <span className="sr-only" role="status">
          Loading routing settings
        </span>
      </SettingsPageContainer>
    );
  return (
    <TeamSettingsForm
      key={`${environmentId}:${settings.data.policy.revision}`}
      environmentId={environmentId}
      initial={settings.data}
      providers={config?.providers ?? []}
      refresh={settings.refresh}
    />
  );
}
function TeamSettingsForm({
  environmentId,
  initial,
  providers,
  refresh,
}: {
  environmentId: EnvironmentId;
  initial: TeamSettings;
  providers: ReadonlyArray<ServerProvider>;
  refresh: () => void;
}) {
  const [policy, setPolicy] = useState<TeamPolicy>(() => subscriptionRoutingPolicy(initial.policy));
  const [key, setKey] = useState("");
  const [editingKey, setEditingKey] = useState(false);
  const [newVariantId, setNewVariantId] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const save = useAtomCommand(teamEnvironment.saveSettings, { reportFailure: false });
  const suggest = useAtomCommand(teamEnvironment.suggestPool, { reportFailure: false });
  const [poolNote, setPoolNote] = useState<string | null>(null);
  async function createPool() {
    if (pending) return;
    setPending(true);
    const result = await suggest({ environmentId, input: {} });
    setPending(false);
    if (result._tag === "Failure") {
      const error = squashAtomCommandFailure(result);
      setPoolNote(error instanceof Error ? error.message : "Could not create a suggested pool.");
      return;
    }
    if (result.value.profiles.length)
      setPolicy((p) => ({
        ...p,
        profiles: result.value.profiles,
        preferredCapableProfileId: result.value.profiles.some(
          (profile) => profile.id === p.preferredCapableProfileId,
        )
          ? p.preferredCapableProfileId
          : null,
      }));
    setPoolNote(
      `${result.value.source === "jev" ? "Jev-assisted" : "Provider inventory"} starting pool. ${result.value.notes.join(" ")}`,
    );
  }
  const secret = useAtomCommand(teamEnvironment.setSecret, { reportFailure: false });
  const available = providers.filter((p) => p.enabled && p.availability !== "unavailable");
  const first = available.find((p) => p.models.length > 0);
  const dirty =
    JSON.stringify(policy) !== JSON.stringify(subscriptionRoutingPolicy(initial.policy)) ||
    initial.policy.estimatedBudgetUsd != null ||
    initial.policy.profiles.some((p) => p.estimatedAttemptUsd !== null);
  function updateProfile(id: string, update: Partial<TeamModelProfile>) {
    setPolicy((p) => ({
      ...p,
      preferredCapableProfileId:
        p.preferredCapableProfileId === id &&
        (update.lead === false || (update.tier && update.tier !== "capable"))
          ? null
          : p.preferredCapableProfileId,
      profiles: p.profiles.map((profile) =>
        profile.id === id
          ? { ...profile, ...update, ...(update.tier ? { reviewRequired: false } : {}) }
          : profile,
      ),
    }));
  }
  async function persist(kind: "policy" | "key" | "remove-key") {
    if (pending) return;
    setPending(true);
    setMessage(null);
    try {
      const result =
        kind === "policy"
          ? await save({ environmentId, input: { policy: subscriptionRoutingPolicy(policy) } })
          : await secret({ environmentId, input: { apiKey: kind === "remove-key" ? "" : key } });
      if (result._tag === "Failure") {
        const error = squashAtomCommandFailure(result);
        setMessage(error instanceof Error ? error.message : "Could not save routing settings.");
      } else {
        setKey("");
        setEditingKey(false);
        refresh();
        setMessage(
          kind === "policy"
            ? "Routing settings saved."
            : kind === "key"
              ? "Key saved securely."
              : "Key removed. Routing is off.",
        );
      }
    } finally {
      setPending(false);
    }
  }
  function addModel(instanceId: string, slug: string) {
    const provider = available.find((p) => p.instanceId === instanceId);
    const model = provider?.models.find((m) => m.slug === slug);
    if (!provider || !model) return;
    if (
      policy.profiles.some(
        (p) => p.selection.instanceId === instanceId && p.selection.model === slug,
      )
    ) {
      setMessage("That model is already in your routing pool.");
      return;
    }
    setPolicy((p) => ({
      ...p,
      profiles: [
        ...p.profiles,
        {
          id: randomUUID(),
          label: `${provider.displayName ?? provider.instanceId} · ${model.name}`,
          selection: { instanceId: provider.instanceId, model: model.slug },
          tier: "capable",
          reviewRequired: true,
          lead: false,
          worker: false,
          estimatedAttemptUsd: null,
        },
      ],
    }));
    setMessage(null);
  }
  return (
    <SettingsPageContainer>
      <SettingsSection id="routing-connection" title="Jev connection">
        <SettingsRow
          title="API key"
          description={
            initial.jevConfigured
              ? "Saved in this environment’s private secret store."
              : "Add your TypeSafe key to enable routing."
          }
          control={
            initial.jevConfigured && !editingKey ? (
              <Button
                size="sm"
                variant="outline"
                disabled={pending}
                onClick={() => setEditingKey(true)}
              >
                Replace key
              </Button>
            ) : undefined
          }
        >
          {(!initial.jevConfigured || editingKey) && (
            <div className="flex flex-wrap items-center gap-2">
              <Input
                aria-label="Jev API key"
                type="password"
                autoComplete="off"
                value={key}
                onChange={(e) => setKey(e.target.value)}
                placeholder="Enter API key"
                className="min-w-0 flex-1"
              />
              <Button
                size="sm"
                disabled={pending || !key.trim()}
                onClick={() => void persist("key")}
              >
                Save key
              </Button>
              {initial.jevConfigured && (
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={pending}
                  onClick={() => {
                    setKey("");
                    setEditingKey(false);
                  }}
                >
                  Cancel
                </Button>
              )}
            </div>
          )}
          {initial.jevConfigured && editingKey && (
            <Button
              size="xs"
              variant="ghost"
              disabled={pending}
              onClick={() => void persist("remove-key")}
            >
              Remove saved key
            </Button>
          )}
        </SettingsRow>
        <SettingsRow
          title="Composer control"
          description="Turn Orchestration on for a new task to select its lead and workers automatically. With it off, your selected model handles normal messages."
        />
      </SettingsSection>
      <SettingsSection
        id="routing-models"
        title="Allowed models"
        headerAction={
          first && (
            <ProviderModelPicker
              activeInstanceId={first.instanceId}
              model={first.models[0]!.slug}
              lockedProvider={null}
              instanceEntries={deriveProviderInstanceEntries(available)}
              modelOptionsByInstance={new Map(available.map((p) => [p.instanceId, p.models]))}
              onInstanceModelChange={addModel}
              triggerLabel="Add model"
              triggerAriaLabel="Add routing model"
              size="xs"
              disabled={pending}
            />
          )
        }
      >
        <SettingsRow
          title="Suggested starting pool"
          description="Collect models from all ready providers and reported quota. Existing approved profiles are reused; new models require task-group and role review."
          control={
            <Button
              size="sm"
              variant="outline"
              disabled={pending}
              onClick={() => void createPool()}
            >
              {pending ? "Working…" : "Build model pool"}
            </Button>
          }
        >
          {poolNote && (
            <p className="text-xs text-muted-foreground" role="status">
              {poolNote}
            </p>
          )}
        </SettingsRow>
        {policy.profiles.length === 0 && (
          <SettingsRow
            title="Choose the models you want Jev to use"
            description={
              first
                ? "Add models from your connected subscriptions. Task groups are suggested for known model families; you can customize them."
                : "Enable a provider in Settings → Providers, then add its models here."
            }
          />
        )}
        {policy.profiles.map((profile) => {
          const provider = providers.find((p) => p.instanceId === profile.selection.instanceId);
          const model = provider?.models.find((m) => m.slug === profile.selection.model);
          const effort = profile.selection.options?.find((o) =>
            ["reasoningEffort", "effort"].includes(o.id),
          )?.value;
          return (
            <SettingsRow
              key={profile.id}
              title={model?.name ?? profile.selection.model}
              description={`${provider?.displayName ?? profile.selection.instanceId} · ${profile.reviewRequired ? "Needs review · inactive" : routingTierLabels[profile.tier]} · ${typeof effort === "string" ? effort : "Provider default effort"}`}
              control={
                <Button
                  size="icon-sm"
                  variant="ghost"
                  aria-label={`Remove ${profile.label}`}
                  disabled={pending}
                  onClick={() =>
                    setPolicy((p) => ({
                      ...p,
                      profiles: p.profiles.filter((v) => v.id !== profile.id),
                      preferredCapableProfileId:
                        p.preferredCapableProfileId === profile.id
                          ? null
                          : p.preferredCapableProfileId,
                    }))
                  }
                >
                  <Trash2Icon className="size-3.5" />
                </Button>
              }
            >
              {(!provider?.enabled || !model || provider.availability === "unavailable") && (
                <p className="text-xs text-destructive">
                  This model is unavailable. Reconnect its provider or remove it before saving.
                </p>
              )}
              <ProfileOptions initiallyOpen={profile.id === newVariantId}>
                <summary className="w-fit cursor-pointer py-1 hover:text-foreground">
                  Customize
                </summary>
                <div className="mt-3 space-y-3">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <span>Task group</span>
                    <Choice
                      label={`Task group for ${profile.label}`}
                      value={profile.reviewRequired ? "unreviewed" : profile.tier}
                      options={[
                        { value: "unreviewed", label: "Choose task group", disabled: true },
                        ...Object.entries(routingTierLabels).map(([value, label]) => ({
                          value,
                          label,
                        })),
                      ]}
                      onChange={(tier) =>
                        updateProfile(profile.id, { tier: tier as TeamModelProfile["tier"] })
                      }
                      disabled={pending}
                    />
                  </div>
                  <p>
                    Choose this from your evaluation or explicit preference. Model names and Jev
                    confidence are not capability measurements.
                  </p>
                  {(model?.capabilities?.optionDescriptors ?? []).map((option) => {
                    const value = profile.selection.options?.find((o) => o.id === option.id)?.value;
                    const change = (v: string | boolean | null) =>
                      updateProfile(profile.id, {
                        selection: {
                          ...profile.selection,
                          options: [
                            ...(profile.selection.options ?? []).filter((o) => o.id !== option.id),
                            ...(v === null ? [] : [{ id: option.id, value: v }]),
                          ],
                        },
                      });
                    return (
                      <div
                        key={option.id}
                        className="flex flex-wrap items-center justify-between gap-3"
                      >
                        <span>{option.label}</span>
                        {option.type === "boolean" ? (
                          <Switch
                            aria-label={`${option.label} for ${profile.label}`}
                            checked={
                              typeof value === "boolean" ? value : (option.currentValue ?? false)
                            }
                            onCheckedChange={change}
                            disabled={pending}
                          />
                        ) : (
                          <Choice
                            label={`${option.label} for ${profile.label}`}
                            value={typeof value === "string" ? value : "__default"}
                            options={[
                              { value: "__default", label: "Provider default" },
                              ...option.options.map((o) => ({ value: o.id, label: o.label })),
                            ]}
                            onChange={(v) => change(v === "__default" ? null : v)}
                            disabled={pending}
                          />
                        )}
                      </div>
                    );
                  })}
                  <Button
                    size="xs"
                    variant="outline"
                    disabled={pending || policy.profiles.length >= 40}
                    onClick={() => {
                      const id = randomUUID();
                      setNewVariantId(id);
                      setPolicy((p) => ({ ...p, profiles: [...p.profiles, { ...profile, id }] }));
                      setMessage(
                        "Added a profile. Choose its reasoning effort below before saving.",
                      );
                    }}
                  >
                    Add effort variant
                  </Button>
                  <div className="flex items-center justify-between gap-3">
                    <span>Can lead a team</span>
                    <Switch
                      aria-label={`Allow ${profile.label} as lead`}
                      checked={profile.lead}
                      disabled={pending}
                      onCheckedChange={(lead) => updateProfile(profile.id, { lead })}
                    />
                  </div>
                  <div className="flex items-center justify-between gap-3">
                    <span>Can work on delegated tasks</span>
                    <Switch
                      aria-label={`Allow ${profile.label} as worker`}
                      checked={profile.worker}
                      disabled={pending}
                      onCheckedChange={(worker) => updateProfile(profile.id, { worker })}
                    />
                  </div>
                </div>
              </ProfileOptions>
            </SettingsRow>
          );
        })}
        {policy.profiles.length > 0 && (
          <SettingsRow
            title="Preferred lead for complex tasks"
            description="Used for complex or uncertain requests. Routine tasks can use other models."
            control={
              <Choice
                label="Preferred complex-task lead"
                value={policy.preferredCapableProfileId ?? "__pool"}
                options={[
                  { value: "__pool", label: "Use model list order" },
                  ...policy.profiles
                    .filter((p) => p.lead && p.tier === "capable")
                    .map((p) => ({ value: p.id, label: p.label })),
                ]}
                onChange={(value) =>
                  setPolicy((p) => ({
                    ...p,
                    preferredCapableProfileId: value === "__pool" ? null : value,
                  }))
                }
                disabled={pending}
              />
            }
          />
        )}
      </SettingsSection>
      <SettingsSection id="routing-teams" title="Team limits">
        <SettingsRow
          title="Simultaneous agents"
          description="Includes the lead. More workers can use your subscription allowance faster."
          control={
            <Choice
              label="Maximum active agents"
              value={String(policy.maxActive)}
              options={[1, 2, 3, 4, 5].map((n) => ({
                value: String(n),
                label: n === 1 ? "1 · Lead only" : `${n} agents`,
              }))}
              onChange={(v) => setPolicy((p) => ({ ...p, maxActive: Number(v) }))}
              disabled={pending}
            />
          }
        />
        <SettingsRow
          title="Attempts per worker"
          description="Includes the first attempt and corrections for one work item. Repeated failures pause the team for review."
          control={
            <Choice
              label="Attempts per worker"
              value={String(policy.maxAttempts)}
              options={[1, 2, 3].map((n) => ({ value: String(n), label: String(n) }))}
              onChange={(v) => setPolicy((p) => ({ ...p, maxAttempts: Number(v) }))}
              disabled={pending}
            />
          }
        />
      </SettingsSection>
      <div className="flex flex-wrap items-center gap-3 px-3 sm:px-4">
        <Button size="sm" disabled={pending || !dirty} onClick={() => void persist("policy")}>
          {pending ? "Working…" : "Save changes"}
        </Button>
        {dirty && (
          <Button
            size="sm"
            variant="ghost"
            disabled={pending}
            onClick={() => {
              setPolicy(subscriptionRoutingPolicy(initial.policy));
              setMessage(null);
            }}
          >
            Reset changes
          </Button>
        )}
        {message && (
          <p role="status" className="text-xs text-muted-foreground">
            {message}
          </p>
        )}
        {initial.policy.estimatedBudgetUsd != null && (
          <p className="text-xs text-muted-foreground">
            Saving removes the previous dollar estimate limit. Team turn and attempt limits remain.
          </p>
        )}
      </div>
    </SettingsPageContainer>
  );
}

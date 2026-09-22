import { useAtomValue } from "@effect/atom-react";
import { useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { Trash2Icon } from "lucide-react";
import type {
  EnvironmentId,
  ProviderOptionSelection,
  ServerProvider,
  TeamFlowMode,
  TeamModelProfile,
  TeamPolicy,
  TeamProviderLimitBehavior,
  TeamSettings,
} from "@dispatch/contracts";
import { squashAtomCommandFailure } from "@dispatch/client-runtime/state/runtime";
import { createModelSelection } from "@dispatch/shared/model";

import { randomUUID } from "../../lib/utils";
import { smartRoutingReasonMessage } from "../../flowPresentation";
import {
  hasAssignedFlowModel,
  hasFlowLead,
  hasRequiredFlowRole,
  readyFlowProviders,
} from "../../flowPolicy";
import { deriveProviderInstanceEntries } from "../../providerInstances";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { teamEnvironment } from "../../state/team";
import { useAtomCommand } from "../../state/use-atom-command";
import { usePrimaryEnvironmentId } from "../../state/environments";
import {
  DispatchConnectAccountAccess,
  DispatchConnectAuthActions,
} from "../../connect/DispatchConnectAccountAccess";
import { readDispatchConnectAccountToken } from "../../connect/accountToken";
import { resolveDispatchConnectUrl } from "../../connect/dispatchConnect";
import { ensurePrimaryDispatchConnectEnvironmentLinked } from "../../connect/environmentRegistration";
import { dispatchFlowSessionPayload } from "../../connect/flowSession";
import { ProviderModelPicker } from "../chat/ProviderModelPicker";
import { TraitsPicker } from "../chat/TraitsPicker";
import { Button } from "../ui/button";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import {
  Dialog,
  DialogClose,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import {
  SETTINGS_PICKER_TRIGGER_CLASSNAME,
  SettingsPageContainer,
  SettingsRow,
  SettingsSection,
} from "./settingsLayout";
import {
  applyRecommendedRoles,
  mergeRecommendedCapabilities,
  recommendationForProfile,
  recommendationForSelection,
} from "./teamProfileDefaults";

const PROVIDER_LIMIT_OPTIONS: ReadonlyArray<{
  value: TeamProviderLimitBehavior;
  label: string;
}> = [
  { value: "ask", label: "Ask me" },
  { value: "auto", label: "Continue with another selected provider" },
  { value: "pause", label: "Pause Flow" },
];

const FLOW_MODE_OPTIONS: ReadonlyArray<{ value: TeamFlowMode; label: string }> = [
  { value: "standard", label: "Standard" },
  { value: "auto", label: "Auto" },
];

function Choice({
  label,
  value,
  options,
  onChange,
  disabled = false,
}: {
  label: string;
  value: string;
  options: ReadonlyArray<{ value: string; label: string }>;
  onChange: (value: string) => void;
  disabled?: boolean;
}) {
  return (
    <Select
      value={value}
      onValueChange={(next) => {
        if (next !== null) onChange(next);
      }}
      disabled={disabled}
    >
      <SelectTrigger size="sm" aria-label={label} className="w-auto max-w-full sm:max-w-80">
        <SelectValue>
          {options.find((option) => option.value === value)?.label ?? value}
        </SelectValue>
      </SelectTrigger>
      <SelectPopup align="end" alignItemWithTrigger={false}>
        {options.map((option) => (
          <SelectItem key={option.value} value={option.value}>
            {option.label}
          </SelectItem>
        ))}
      </SelectPopup>
    </Select>
  );
}

function roleLabel(profile: Pick<TeamModelProfile, "lead" | "worker">): string {
  if (profile.lead && profile.worker) return "Lead + Worker";
  if (profile.lead) return "Lead";
  if (profile.worker) return "Worker";
  return "No role";
}

export function withTeamProfileModelOptions(
  profile: TeamModelProfile,
  options: ReadonlyArray<ProviderOptionSelection> | undefined,
): TeamModelProfile {
  return {
    ...profile,
    selection: createModelSelection(profile.selection.instanceId, profile.selection.model, options),
  };
}

export function teamProfileRolesFromRecommendation(
  recommendation: TeamModelProfile | undefined,
): Pick<TeamModelProfile, "lead" | "worker"> {
  return recommendation && (recommendation.lead || recommendation.worker)
    ? { lead: recommendation.lead, worker: recommendation.worker }
    : { lead: false, worker: false };
}

export function TeamSettingsPanel({ environmentId }: { environmentId: EnvironmentId }) {
  const config = useAtomValue(serverEnvironment.configValueAtom(environmentId));
  return config?.teamRouting === true ? (
    <TeamSettingsPanelContent environmentId={environmentId} />
  ) : (
    <SettingsPageContainer>
      <p className="text-sm text-muted-foreground">
        This environment does not support Dispatch Flow. Update its server to continue.
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
          Loading Flow settings
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
  const [policy, setPolicy] = useState<TeamPolicy>(initial.policy);
  const navigate = useNavigate();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const connectBaseUrl = resolveDispatchConnectUrl();
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [recommendationNote, setRecommendationNote] = useState<string | null>(null);
  const [recommendations, setRecommendations] = useState<ReadonlyArray<TeamModelProfile>>([]);
  const [autoConfirmationOpen, setAutoConfirmationOpen] = useState(false);

  const saveSettings = useAtomCommand(teamEnvironment.saveSettings, { reportFailure: false });
  const setSmartRoutingSession = useAtomCommand(teamEnvironment.setSmartRoutingSession, {
    reportFailure: false,
  });
  const recommendModels = useAtomCommand(teamEnvironment.recommendModels, { reportFailure: false });

  const readyProviders = readyFlowProviders(providers, initial.supportedProviderInstanceIds);
  const modelOptionsByInstance = new Map(
    readyProviders.map((provider) => [
      provider.instanceId,
      provider.models.filter((model) => !model.isLegacy),
    ]),
  );
  const firstProvider = readyProviders[0];
  const firstModel = firstProvider
    ? modelOptionsByInstance.get(firstProvider.instanceId)?.[0]
    : undefined;

  const hasUnsavedEdits = JSON.stringify(policy) !== JSON.stringify(initial.policy);
  const hasLead = hasFlowLead(policy);
  const hasAssignedModel = hasAssignedFlowModel(policy);
  const hasRequiredRole = hasRequiredFlowRole(policy);
  const hasUnassignedModel = policy.profiles.some((profile) => !profile.lead && !profile.worker);
  const policyValid = (!policy.enabled || hasRequiredRole) && !hasUnassignedModel;

  function updateProfile(id: string, update: Partial<TeamModelProfile>) {
    setPolicy((current) => ({
      ...current,
      profiles: current.profiles.map((profile) =>
        profile.id === id ? { ...profile, ...update } : profile,
      ),
    }));
    setMessage(null);
  }

  function setEnabled(enabled: boolean) {
    if (enabled && !hasRequiredRole) {
      setMessage(
        policy.flowMode === "auto"
          ? "Choose at least one Lead or Worker model before enabling Flow Auto."
          : "Choose at least one Lead model before enabling Flow Standard.",
      );
      return;
    }
    setPolicy((current) => ({ ...current, enabled }));
    setMessage(null);
  }

  function requestFlowMode(mode: TeamFlowMode) {
    setMessage(null);
    if (mode === "standard") {
      setPolicy((current) => ({ ...current, flowMode: "standard" }));
      return;
    }
    if (!initial.smartRouting.available) {
      setMessage(
        "Sign in to Dispatch Connect and link this environment before enabling Flow Auto.",
      );
      return;
    }
    setAutoConfirmationOpen(true);
  }

  async function syncCurrentSmartRoutingSession(accountToken: string): Promise<boolean> {
    const result = await setSmartRoutingSession({
      environmentId,
      input: dispatchFlowSessionPayload(connectBaseUrl, accountToken),
    });
    if (result._tag === "Failure") {
      const error = squashAtomCommandFailure(result);
      setMessage(
        error instanceof Error ? error.message : "Could not enable Flow Auto for this environment.",
      );
      return false;
    }
    refresh();
    return true;
  }

  async function prepareAutoForToken(accountToken: string, refreshAccount?: () => void) {
    if (pending || !connectBaseUrl) return;
    setPending(true);
    setMessage(null);
    try {
      if (environmentId === primaryEnvironmentId) {
        await ensurePrimaryDispatchConnectEnvironmentLinked(connectBaseUrl);
      }
      await syncCurrentSmartRoutingSession(accountToken);
      refreshAccount?.();
    } catch (cause) {
      setMessage(
        cause instanceof Error
          ? cause.message
          : "Could not link this environment to Dispatch Connect.",
      );
    } finally {
      setPending(false);
    }
  }

  async function savePolicy() {
    if (pending || !hasUnsavedEdits || !policyValid) return;
    setPending(true);
    setMessage(null);
    try {
      const result = await saveSettings({ environmentId, input: { policy } });
      if (result._tag === "Failure") {
        const error = squashAtomCommandFailure(result);
        setMessage(error instanceof Error ? error.message : "Could not save Flow settings.");
        return;
      }
      setPolicy(result.value.policy);
      setMessage("Flow settings saved.");
      refresh();
    } finally {
      setPending(false);
    }
  }

  async function refreshRecommendations() {
    if (pending || hasUnsavedEdits) return;
    setPending(true);
    setRecommendationNote(null);
    try {
      const result = await recommendModels({ environmentId, input: {} });
      if (result._tag === "Failure") {
        const error = squashAtomCommandFailure(result);
        setRecommendationNote(
          error instanceof Error ? error.message : "Could not refresh model recommendations.",
        );
        return;
      }
      setRecommendations(result.value.profiles);
      setPolicy((current) => ({
        ...current,
        profiles: mergeRecommendedCapabilities(current.profiles, result.value.profiles),
      }));
      setRecommendationNote(
        `${result.value.source === "jev" ? "Smart Routing recommendations refreshed." : "Ready provider models refreshed."} ${result.value.notes.join(" ")}`,
      );
    } finally {
      setPending(false);
    }
  }

  function addModel(instanceId: TeamModelProfile["selection"]["instanceId"], modelSlug: string) {
    const provider = readyProviders.find((candidate) => candidate.instanceId === instanceId);
    const model = modelOptionsByInstance
      .get(instanceId)
      ?.find((candidate) => candidate.slug === modelSlug);
    if (!provider || !model) return;
    if (
      policy.profiles.some(
        (profile) =>
          profile.selection.instanceId === instanceId && profile.selection.model === modelSlug,
      )
    ) {
      setMessage("That model is already selected for Flow.");
      return;
    }

    const recommendation = recommendationForSelection(recommendations, instanceId, modelSlug);
    const roles = teamProfileRolesFromRecommendation(recommendation);
    const hasRecommendedRole = roles.lead || roles.worker;
    const profile: TeamModelProfile = {
      id: randomUUID(),
      label: `${provider.displayName ?? provider.instanceId} · ${model.name}`,
      selection: { instanceId, model: modelSlug },
      ...roles,
      ...(recommendation?.capability === undefined
        ? {}
        : { capability: recommendation.capability }),
    };
    setPolicy((current) => ({ ...current, profiles: [...current.profiles, profile] }));
    setMessage(
      hasRecommendedRole
        ? `Added ${model.name} with the refreshed Lead/Worker recommendation. You can change it before saving.`
        : null,
    );
  }

  return (
    <SettingsPageContainer>
      <SettingsSection id="routing-general" title="Dispatch Flow">
        <SettingsRow
          title="Enable Flow"
          description={
            hasRequiredRole
              ? "Makes Flow available in the composer for this environment."
              : policy.flowMode === "auto"
                ? "Choose at least one Lead or Worker model before enabling Flow Auto."
                : "Choose at least one Lead model before enabling Flow Standard."
          }
          control={
            <Switch
              aria-label="Enable Flow"
              checked={policy.enabled}
              disabled={pending}
              onCheckedChange={setEnabled}
            />
          }
        />
        <SettingsRow
          title="Flow mode"
          description={
            policy.flowMode === "standard"
              ? "Standard uses your selected Lead and Worker models without a Dispatch Connect account."
              : initial.smartRouting.available
                ? "Auto uses Dispatch-hosted Smart Routing to choose direct execution or a managed team. Worker-only setups can run direct work; managed-team or Standard fallback still needs a Lead."
                : hasLead
                  ? "Auto stays selected and can fall back to Standard while Smart Routing is unavailable."
                  : "Auto stays selected, but Standard fallback cannot start until you add a Lead."
          }
          control={
            <Dialog open={autoConfirmationOpen} onOpenChange={setAutoConfirmationOpen}>
              <Choice
                label="Flow mode"
                value={policy.flowMode}
                options={FLOW_MODE_OPTIONS}
                onChange={(value) => requestFlowMode(value as TeamFlowMode)}
                disabled={pending}
              />
              <DialogPopup className="sm:max-w-lg">
                <DialogHeader>
                  <DialogTitle>Enable Flow Auto?</DialogTitle>
                  <DialogDescription>
                    Auto uses Dispatch-hosted Smart Routing. Dispatch covers the routing service;
                    your coding-model usage continues on your own provider accounts.
                  </DialogDescription>
                </DialogHeader>
                <DialogPanel className="space-y-2 text-sm text-muted-foreground">
                  <p>
                    Auto sends the task objective and minimal selected-model metadata to Dispatch's
                    hosted router, which may use JEV to make the routing decision.
                  </p>
                  <p>
                    Flow remains controlled by this environment. If hosted routing is unavailable,
                    the run continues with Standard and shows that fallback.
                  </p>
                </DialogPanel>
                <DialogFooter>
                  <DialogClose render={<Button variant="outline" disabled={pending} />}>
                    Cancel
                  </DialogClose>
                  <Button
                    disabled={pending}
                    onClick={() => {
                      setPolicy((current) => ({ ...current, flowMode: "auto" }));
                      setAutoConfirmationOpen(false);
                      setMessage(null);
                    }}
                  >
                    Enable Auto
                  </Button>
                </DialogFooter>
              </DialogPopup>
            </Dialog>
          }
        />
        <SettingsRow
          id="routing-provider-limits"
          title="Provider limits"
          description="What Dispatch should do when a selected provider reaches its usage limit."
          control={
            <Choice
              label="Provider limit behavior"
              value={policy.providerLimitBehavior}
              options={PROVIDER_LIMIT_OPTIONS}
              onChange={(value) =>
                setPolicy((current) => ({
                  ...current,
                  providerLimitBehavior: value as TeamProviderLimitBehavior,
                }))
              }
              disabled={pending}
            />
          }
        />
      </SettingsSection>

      <SettingsSection
        id="routing-models"
        title="Models Flow can use"
        headerAction={
          firstProvider && firstModel ? (
            <ProviderModelPicker
              activeInstanceId={firstProvider.instanceId}
              model={firstModel.slug}
              lockedProvider={null}
              instanceEntries={deriveProviderInstanceEntries(readyProviders)}
              modelOptionsByInstance={modelOptionsByInstance}
              onInstanceModelChange={addModel}
              triggerLabel="Add model"
              triggerAriaLabel="Add Flow model"
              size="xs"
              disabled={pending || policy.profiles.length >= 40}
            />
          ) : undefined
        }
      >
        {initial.supportedProviderInstanceIds === undefined ? (
          <p className="text-xs text-muted-foreground" role="status">
            Update this environment's server to choose supported Flow models.
          </p>
        ) : null}
        {policy.profiles.length === 0 ? (
          <SettingsRow
            title="No models selected"
            description={
              firstProvider
                ? "Add models, then choose whether each one can Lead, execute Worker tasks, or both. Worker models can also handle simple Auto work directly."
                : "Connect a provider that supports Flow in Settings → Providers before adding models."
            }
          />
        ) : null}

        {policy.profiles.map((profile) => {
          const provider = providers.find(
            (candidate) => candidate.instanceId === profile.selection.instanceId,
          );
          const model = provider?.models.find(
            (candidate) => candidate.slug === profile.selection.model,
          );
          const unavailable =
            !provider?.enabled ||
            provider.status !== "ready" ||
            provider.auth.status === "unauthenticated" ||
            provider.availability === "unavailable" ||
            !model;
          const recommendation = recommendationForProfile(profile, recommendations);
          const recommendationHasRole =
            recommendation !== undefined && (recommendation.lead || recommendation.worker);
          const recommendationDiffers =
            recommendationHasRole &&
            (recommendation.lead !== profile.lead || recommendation.worker !== profile.worker);

          return (
            <SettingsRow
              key={profile.id}
              title={model?.name ?? profile.selection.model}
              description={`${provider?.displayName ?? profile.selection.instanceId} · ${roleLabel(profile)}`}
              control={
                <div className="flex min-w-0 items-center justify-end gap-1">
                  {!unavailable && provider && model ? (
                    <TraitsPicker
                      provider={provider.driver}
                      instanceId={provider.instanceId}
                      models={provider.models}
                      model={profile.selection.model}
                      prompt=""
                      onPromptChange={() => {}}
                      modelOptions={profile.selection.options ?? []}
                      allowPromptInjectedEffort={false}
                      planModeEnabled={false}
                      size="xs"
                      triggerVariant="ghost"
                      triggerClassName={SETTINGS_PICKER_TRIGGER_CLASSNAME}
                      onModelOptionsChange={(options) =>
                        updateProfile(profile.id, {
                          selection: withTeamProfileModelOptions(profile, options).selection,
                        })
                      }
                    />
                  ) : null}
                  <Button
                    size="icon-sm"
                    variant="ghost"
                    aria-label={`Remove ${profile.label}`}
                    disabled={pending}
                    onClick={() => {
                      setPolicy((current) => ({
                        ...current,
                        profiles: current.profiles.filter(
                          (candidate) => candidate.id !== profile.id,
                        ),
                      }));
                      setMessage(null);
                    }}
                  >
                    <Trash2Icon className="size-3.5" />
                  </Button>
                </div>
              }
            >
              <div className="flex flex-wrap items-center gap-x-5 gap-y-2 py-1 text-xs text-muted-foreground">
                <label className="flex cursor-pointer items-center gap-2">
                  <Switch
                    size="sm"
                    aria-label={`Allow ${profile.label} as Lead`}
                    checked={profile.lead}
                    disabled={pending}
                    onCheckedChange={(lead) => updateProfile(profile.id, { lead })}
                  />
                  Lead
                </label>
                <label className="flex cursor-pointer items-center gap-2">
                  <Switch
                    size="sm"
                    aria-label={`Allow ${profile.label} as Worker`}
                    checked={profile.worker}
                    disabled={pending}
                    onCheckedChange={(worker) => updateProfile(profile.id, { worker })}
                  />
                  Worker
                </label>
                {recommendationDiffers ? (
                  <div className="flex flex-wrap items-center gap-2">
                    <span>Smart Routing suggests {roleLabel(recommendation)}</span>
                    <Button
                      size="xs"
                      variant="outline"
                      disabled={pending}
                      onClick={() =>
                        updateProfile(profile.id, applyRecommendedRoles(profile, recommendation))
                      }
                    >
                      Apply recommendation
                    </Button>
                  </div>
                ) : null}
              </div>
              {unavailable ? (
                <p className="text-xs text-muted-foreground">
                  This model is currently unavailable. Flow will use another eligible selected model
                  until its provider is ready again.
                </p>
              ) : null}
              {!profile.lead && !profile.worker ? (
                <p className="text-xs text-destructive">
                  Choose Lead, Worker, or remove this model before saving.
                </p>
              ) : null}
            </SettingsRow>
          );
        })}
      </SettingsSection>

      <SettingsSection id="routing-teams" title="Team limits">
        <SettingsRow
          title="Simultaneous agents"
          description="Maximum agents active at once. Auto may use one direct executor; managed teams count the lead and workers."
          control={
            <Choice
              label="Maximum active agents"
              value={String(policy.maxActive)}
              options={[1, 2, 3, 4, 5].map((count) => ({
                value: String(count),
                label: count === 1 ? "1 agent · no delegation" : `${count} agents`,
              }))}
              onChange={(value) =>
                setPolicy((current) => ({ ...current, maxActive: Number(value) }))
              }
              disabled={pending}
            />
          }
        />
        <SettingsRow
          title="Attempts per worker"
          description="Includes the first attempt and corrections for one delegated task."
          control={
            <Choice
              label="Attempts per worker"
              value={String(policy.maxAttempts)}
              options={[1, 2, 3].map((count) => ({
                value: String(count),
                label: String(count),
              }))}
              onChange={(value) =>
                setPolicy((current) => ({ ...current, maxAttempts: Number(value) }))
              }
              disabled={pending}
            />
          }
        />
      </SettingsSection>

      <SettingsSection id="routing-recommendations" title="Smart Routing">
        <DispatchConnectAccountAccess>
          {(account) => (
            <SettingsRow
              title="Dispatch Connect"
              description={
                initial.smartRouting.available
                  ? "Auto is available. Dispatch covers Smart Routing; coding-model usage stays on your provider accounts."
                  : smartRoutingReasonMessage(initial.smartRouting.reason)
              }
              control={
                <div className="flex flex-wrap items-center justify-end gap-2">
                  {initial.smartRouting.available ? (
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => void navigate({ to: "/settings/connections" })}
                    >
                      Manage account
                    </Button>
                  ) : account.pending ? (
                    <Button size="sm" variant="outline" disabled>
                      Checking account…
                    </Button>
                  ) : !account.configured ? (
                    <Button size="sm" variant="outline" disabled>
                      Connect unavailable
                    </Button>
                  ) : !account.signedIn ? (
                    <DispatchConnectAuthActions
                      disabled={pending}
                      onAuthenticated={async () => {
                        account.refresh();
                        if (!connectBaseUrl) return;
                        const token = readDispatchConnectAccountToken(connectBaseUrl);
                        if (token && environmentId === primaryEnvironmentId) {
                          await prepareAutoForToken(token, account.refresh);
                        }
                      }}
                    />
                  ) : environmentId === primaryEnvironmentId && account.accountToken ? (
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={pending}
                      onClick={() =>
                        void prepareAutoForToken(account.accountToken!, account.refresh)
                      }
                    >
                      Link environment for Auto
                    </Button>
                  ) : (
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => void navigate({ to: "/settings/connections" })}
                    >
                      Manage Connect
                    </Button>
                  )}
                  <Button size="sm" variant="ghost" disabled={pending} onClick={refresh}>
                    Refresh status
                  </Button>
                </div>
              }
            >
              <p className="text-xs text-muted-foreground">
                Auto sends the task objective and minimal selected-model metadata to Dispatch's
                hosted router and TypeSafe's JEV for routing decisions. Standard does not use the
                hosted routing service.
              </p>
            </SettingsRow>
          )}
        </DispatchConnectAccountAccess>
        <SettingsRow
          title="Model recommendations"
          description={
            hasUnsavedEdits
              ? "Save or reset your current model changes before refreshing recommendations."
              : "Refresh optional role and capability suggestions. Saved Lead and Worker choices are never overwritten automatically."
          }
          control={
            <Button
              size="sm"
              variant="outline"
              disabled={pending || hasUnsavedEdits}
              onClick={() => void refreshRecommendations()}
            >
              {pending ? "Working…" : "Refresh recommendations"}
            </Button>
          }
        >
          {recommendationNote ? (
            <p className="text-xs text-muted-foreground" role="status">
              {recommendationNote}
            </p>
          ) : null}
        </SettingsRow>
      </SettingsSection>

      <div className="flex flex-wrap items-center gap-3 px-3 sm:px-4">
        <Button
          size="sm"
          disabled={pending || !hasUnsavedEdits || !policyValid}
          onClick={() => void savePolicy()}
        >
          {pending ? "Working…" : "Save changes"}
        </Button>
        {hasUnsavedEdits ? (
          <Button
            size="sm"
            variant="ghost"
            disabled={pending}
            onClick={() => {
              setPolicy(initial.policy);
              setMessage(null);
            }}
          >
            Reset changes
          </Button>
        ) : null}
        {!policyValid ? (
          <p className="text-xs text-destructive">
            {hasUnassignedModel
              ? "Every selected model needs Lead, Worker, or both."
              : policy.flowMode === "auto" && !hasAssignedModel
                ? "Choose at least one Lead or Worker model before enabling Flow Auto."
                : "Choose at least one Lead model before enabling Flow Standard."}
          </p>
        ) : null}
        {message ? (
          <p role="status" className="text-xs text-muted-foreground">
            {message}
          </p>
        ) : null}
      </div>
    </SettingsPageContainer>
  );
}

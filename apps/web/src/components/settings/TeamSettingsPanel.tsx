import { randomUUID } from "../../lib/utils";
import { useAtomValue } from "@effect/atom-react";
import { useState } from "react";
import type {
  EnvironmentId,
  TeamSettings,
  TeamPolicy,
  TeamModelProfile,
  ServerProvider,
} from "@t3tools/contracts";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { teamEnvironment } from "../../state/team";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Input } from "../ui/input";

export function TeamSettingsPanel({ environmentId }: { environmentId: EnvironmentId }) {
  const config = useAtomValue(serverEnvironment.configValueAtom(environmentId));
  return config?.teamRouting === true ? (
    <TeamSettingsPanelContent environmentId={environmentId} />
  ) : null;
}
function TeamSettingsPanelContent({ environmentId }: { environmentId: EnvironmentId }) {
  const settings = useEnvironmentQuery(teamEnvironment.settings({ environmentId, input: {} }));
  const config = useAtomValue(serverEnvironment.configValueAtom(environmentId));
  if (settings.error) return <p className="px-8 py-4 text-sm text-destructive">{settings.error}</p>;
  if (!settings.data) return null;
  return (
    <TeamSettingsForm
      key={`${environmentId}:${settings.data.policy.revision}:${settings.data.jevConfigured}`}
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
  const [key, setKey] = useState("");
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const save = useAtomCommand(teamEnvironment.saveSettings, { reportFailure: false });
  const secret = useAtomCommand(teamEnvironment.setSecret, { reportFailure: false });
  const available = providers.filter((p) => p.enabled && p.availability !== "unavailable");
  function updateProfile(id: string, update: Partial<TeamModelProfile>) {
    setPolicy((p) => ({
      ...p,
      preferredCapableProfileId:
        p.preferredCapableProfileId === id &&
        (update.lead === false || (update.tier && update.tier !== "capable"))
          ? null
          : p.preferredCapableProfileId,
      profiles: p.profiles.map((profile) =>
        profile.id === id ? { ...profile, ...update } : profile,
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
          ? await save({ environmentId, input: { policy } })
          : await secret({ environmentId, input: { apiKey: kind === "remove-key" ? "" : key } });
      if (result._tag === "Failure") {
        const error = squashAtomCommandFailure(result);
        setMessage(error instanceof Error ? error.message : "Could not save routing settings.");
      } else {
        setKey("");
        refresh();
        setMessage("Saved.");
      }
    } finally {
      setPending(false);
    }
  }
  const selectClass = "h-8 rounded-md border bg-background px-2 text-xs";
  return (
    <section className="border-t px-8 py-6" aria-labelledby="team-router-title">
      <h2 id="team-router-title" className="text-sm font-semibold">
        Jev routing
      </h2>
      <p className="mt-1 text-xs text-muted-foreground">
        Choose the models and reasoning options routing may use on this environment. Shadow mode
        previews decisions without changing your selected model.
      </p>
      <div className="mt-4 flex flex-wrap items-center gap-2">
        <label className="text-xs" htmlFor="team-mode">
          Mode
        </label>
        <select
          id="team-mode"
          className={selectClass}
          value={policy.mode}
          onChange={(e) => setPolicy((p) => ({ ...p, mode: e.target.value as TeamPolicy["mode"] }))}
        >
          <option value="off">Off</option>
          <option value="shadow" disabled={!initial.jevConfigured}>
            Shadow preview
          </option>
          <option value="auto" disabled={!initial.jevConfigured}>
            Automatic (experimental)
          </option>
        </select>
        <label className="ml-3 text-xs" htmlFor="team-cap">
          Active agents, including lead
        </label>
        <select
          id="team-cap"
          className={selectClass}
          value={policy.maxActive}
          onChange={(e) => setPolicy((p) => ({ ...p, maxActive: Number(e.target.value) }))}
        >
          {[1, 2, 3, 4, 5].map((n) => (
            <option key={n}>{n}</option>
          ))}
        </select>
      </div>
      <p className="mt-3 text-xs text-muted-foreground">
        Only the {policy.profiles.length} profiles below are eligible. Models in the chat picker are
        not automatically added. Jev classifies the task; this pool determines the model.
      </p>
      <label className="mt-3 flex flex-wrap items-center gap-2 text-xs">
        High-complexity and uncertain-task lead
        <select
          aria-label="Preferred capable lead"
          className={selectClass}
          value={policy.preferredCapableProfileId ?? ""}
          onChange={(e) =>
            setPolicy((p) => ({ ...p, preferredCapableProfileId: e.target.value || null }))
          }
        >
          <option value="">Use capable pool order / known cost estimates</option>
          {policy.profiles
            .filter((p) => p.lead && p.tier === "capable")
            .map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
              </option>
            ))}
        </select>
      </label>
      <label className="mt-3 flex flex-wrap items-center gap-2 text-xs">
        Estimated USD budget per team (optional)
        <Input
          aria-label="Estimated team budget USD"
          type="number"
          min="0"
          step="0.01"
          className="w-28"
          value={policy.estimatedBudgetUsd ?? ""}
          onChange={(e) =>
            setPolicy((p) => ({
              ...p,
              estimatedBudgetUsd: e.target.value === "" ? null : Number(e.target.value),
            }))
          }
        />
      </label>
      <p className="mt-1 text-xs text-muted-foreground">
        A planning cap based on your per-turn estimates, not an API bill or subscription quota.
        Unknown estimates block admission when this cap is set.
      </p>
      <div className="mt-4 space-y-3">
        {policy.profiles.map((profile) => {
          const provider = providers.find((p) => p.instanceId === profile.selection.instanceId);
          const model = provider?.models.find((m) => m.slug === profile.selection.model);
          return (
            <div key={profile.id} className="flex flex-wrap items-center gap-2 border-b pb-3">
              <span className="min-w-36 text-xs">{profile.label}</span>
              <select
                aria-label={`Quality tier for ${profile.label}`}
                className={selectClass}
                value={profile.tier}
                onChange={(e) =>
                  updateProfile(profile.id, { tier: e.target.value as TeamModelProfile["tier"] })
                }
              >
                <option value="economy">Economy</option>
                <option value="balanced">Balanced</option>
                <option value="capable">Capable</option>
              </select>
              <label className="text-xs">
                <input
                  type="checkbox"
                  checked={profile.lead}
                  onChange={(e) => updateProfile(profile.id, { lead: e.target.checked })}
                />{" "}
                Lead
              </label>
              <label className="text-xs">
                <input
                  type="checkbox"
                  checked={profile.worker}
                  onChange={(e) => updateProfile(profile.id, { worker: e.target.checked })}
                />{" "}
                Worker
              </label>
              {(model?.capabilities?.optionDescriptors ?? []).map((option) => {
                const value = profile.selection.options?.find((o) => o.id === option.id)?.value;
                const change = (v: string | boolean) =>
                  updateProfile(profile.id, {
                    selection: {
                      ...profile.selection,
                      options: [
                        ...(profile.selection.options ?? []).filter((o) => o.id !== option.id),
                        { id: option.id, value: v },
                      ],
                    },
                  });
                return option.type === "boolean" ? (
                  <label key={option.id} className="text-xs">
                    <input
                      type="checkbox"
                      checked={typeof value === "boolean" ? value : (option.currentValue ?? false)}
                      onChange={(e) => change(e.target.checked)}
                    />{" "}
                    {option.label}
                  </label>
                ) : (
                  <select
                    key={option.id}
                    className={selectClass}
                    aria-label={`${option.label} for ${profile.label}`}
                    value={typeof value === "string" ? value : ""}
                    onChange={(e) => change(e.target.value)}
                  >
                    <option value="" disabled>
                      Default {option.label}
                    </option>
                    {option.options.map((o) => (
                      <option value={o.id} key={o.id}>
                        {o.label}
                      </option>
                    ))}
                  </select>
                );
              })}
              <label className="text-xs">
                Estimated USD / turn
                <Input
                  aria-label={`Estimated USD per turn for ${profile.label}`}
                  type="number"
                  min="0"
                  step="0.001"
                  className="w-28"
                  value={profile.estimatedAttemptUsd ?? ""}
                  onChange={(e) =>
                    updateProfile(profile.id, {
                      estimatedAttemptUsd: e.target.value === "" ? null : Number(e.target.value),
                    })
                  }
                />
              </label>
              <Button
                size="sm"
                variant="ghost"
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
                Remove
              </Button>
            </div>
          );
        })}
      </div>
      <select
        aria-label="Add allowed model"
        className={`${selectClass} mt-3 max-w-full`}
        value=""
        onChange={(e) => {
          const [instanceId, slug] = e.target.value.split("\u001f");
          const provider = available.find((p) => p.instanceId === instanceId);
          const model = provider?.models.find((m) => m.slug === slug);
          if (!provider || !model) return;
          setPolicy((p) => ({
            ...p,
            profiles: [
              ...p.profiles,
              {
                id: randomUUID(),
                label: `${provider.displayName ?? provider.instanceId} · ${model.name}`,
                selection: { instanceId: provider.instanceId, model: model.slug },
                tier: "capable",
                lead: true,
                worker: true,
                estimatedAttemptUsd: null,
              },
            ],
          }));
        }}
      >
        <option value="" disabled>
          Add a model to the allowed pool…
        </option>
        {available.flatMap((p) =>
          p.models.map((m) => (
            <option key={`${p.instanceId}/${m.slug}`} value={`${p.instanceId}\u001f${m.slug}`}>
              {p.displayName ?? p.instanceId} · {m.name}
            </option>
          )),
        )}
      </select>
      <div className="mt-4 flex items-center gap-2">
        <Button size="sm" disabled={pending} onClick={() => void persist("policy")}>
          Save routing policy
        </Button>
      </div>
      <div className="mt-6 flex flex-wrap items-center gap-2">
        <label className="text-xs" htmlFor="jev-secret">
          Jev API key {initial.jevConfigured ? "(configured)" : "(not configured)"}
        </label>
        <Input
          id="jev-secret"
          type="password"
          autoComplete="off"
          className="max-w-72"
          value={key}
          onChange={(e) => setKey(e.target.value)}
          placeholder="Enter on this device"
        />
        <Button size="sm" disabled={pending || !key.trim()} onClick={() => void persist("key")}>
          Save key
        </Button>
        {initial.jevConfigured && (
          <Button
            size="sm"
            variant="ghost"
            disabled={pending}
            onClick={() => void persist("remove-key")}
          >
            Remove key
          </Button>
        )}
      </div>
      <p className="mt-2 text-xs text-muted-foreground">
        Enabling routing sends draft text to TypeSafe after a typing pause. Bring your own Jev key
        to enable routing. Your key stays in this environment's private secret store. Removing it
        disables routing. Confidence is not a guarantee of correctness; start in shadow mode.
      </p>
      {message && (
        <p role="status" className="mt-3 text-xs">
          {message}
        </p>
      )}
    </section>
  );
}

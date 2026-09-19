import { createFileRoute } from "@tanstack/react-router";
import { TeamSettingsPanel } from "../components/settings/TeamSettingsPanel";
import { useSettingsScope } from "../components/settings/SettingsScopeContext";

function SettingsOrchestrationRoute() {
  const { environment } = useSettingsScope();
  return environment ? (
    <TeamSettingsPanel environmentId={environment.environmentId} />
  ) : (
    <p className="p-8 text-sm text-muted-foreground">
      Connect an environment to configure routing.
    </p>
  );
}
export const Route = createFileRoute("/settings/orchestration")({
  component: SettingsOrchestrationRoute,
});

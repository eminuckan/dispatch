import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId } from "@dispatch/contracts";

import { serverEnvironment } from "../../state/server";
import { SettingsPageContainer, SettingsSection } from "./settingsLayout";

export function TeamSettingsPanel({ environmentId }: { environmentId: EnvironmentId }) {
  const config = useAtomValue(serverEnvironment.configValueAtom(environmentId));
  return (
    <SettingsPageContainer>
      <SettingsSection id="flow" title="Flow">
        {config?.flow === true ? (
          <div className="space-y-2 text-sm text-muted-foreground">
            <p>Turn on Flow in a thread’s composer when you want its agent to coordinate work.</p>
            <p>
              The model you select leads the thread. It can start workers with explicit assignments
              and model choices. Workers use separate Git worktrees; the lead reviews and integrates
              their work.
            </p>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">
            Update this environment’s server to use Flow.
          </p>
        )}
      </SettingsSection>
    </SettingsPageContainer>
  );
}

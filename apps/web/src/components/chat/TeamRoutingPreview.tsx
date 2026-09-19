import { useAtomValue } from "@effect/atom-react";
import { serverEnvironment } from "../../state/server";
import { TeamRunControls } from "./TeamRunControls";
import { randomUUID } from "../../lib/utils";
import { useEffect, useRef, useState } from "react";
import type { EnvironmentId, ProjectId, TeamAssessment } from "@t3tools/contracts";
import { createTeamDraftCoordinator } from "@t3tools/client-runtime/state/team-draft";
import { teamEnvironment } from "../../state/team";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";

export function TeamRoutingPreview(props: Parameters<typeof TeamRoutingPreviewContent>[0]) {
  const config = useAtomValue(serverEnvironment.configValueAtom(props.environmentId));
  return config?.teamRouting === true ? <TeamRoutingPreviewContent {...props} /> : null;
}

function TeamRoutingPreviewContent({
  environmentId,
  projectId,
  prompt,
  hasAttachments,
  composing,
}: {
  environmentId: EnvironmentId;
  projectId: ProjectId | null;
  prompt: string;
  hasAttachments: boolean;
  composing: boolean;
}) {
  const settings = useEnvironmentQuery(teamEnvironment.settings({ environmentId, input: {} }));
  const assess = useAtomCommand(teamEnvironment.assess, { reportFailure: false });
  const [result, setResult] = useState<{
    key: string;
    assessment: TeamAssessment | null;
    failed: boolean;
  } | null>(null);
  const [draftId] = useState(randomUUID);
  const revision = useRef(0);
  const enabled = settings.data?.policy.mode !== "off" && settings.data !== null;
  const policyRevision = settings.data?.policy.revision ?? 0;
  const requestKey = JSON.stringify([
    environmentId,
    prompt,
    hasAttachments,
    composing,
    enabled,
    policyRevision,
  ]);
  const assessment = result?.key === requestKey ? result.assessment : null;
  const failed = result?.key === requestKey && result.failed;
  useEffect(() => {
    const coordinator = createTeamDraftCoordinator({
      assess: async (draft) => {
        const result = await assess({ environmentId, input: draft });
        if (result._tag === "Failure") throw new Error("Assessment unavailable");
        return result.value;
      },
      publish: (assessment) => {
        if (assessment) setResult({ key: requestKey, assessment, failed: false });
      },
      onError: () => setResult({ key: requestKey, assessment: null, failed: true }),
    });
    if (enabled)
      coordinator.schedule(
        {
          draftId,
          revision: ++revision.current,
          policyRevision,
          prompt,
          hasAttachments,
        },
        composing,
      );
    return () => coordinator.dispose();
  }, [
    draftId,
    assess,
    environmentId,
    prompt,
    hasAttachments,
    composing,
    enabled,
    policyRevision,
    requestKey,
  ]);
  if (!enabled || !prompt.trim())
    return projectId ? (
      <div className="px-4 pb-2">
        <TeamRunControls
          environmentId={environmentId}
          projectId={projectId}
          prompt=""
          assessment={null}
          hasAttachments={false}
          composing={false}
          showStart={false}
        />
      </div>
    ) : null;
  const profile = settings.data?.policy.profiles.find((p) => p.id === assessment?.profileId);
  const effort = profile?.selection.options?.find((option) =>
    ["reasoningEffort", "effort"].includes(option.id),
  )?.value;
  return (
    <div className="px-4 pb-2 text-xs text-muted-foreground" role="status" aria-live="polite">
      {failed
        ? "Jev preview unavailable; your selected model is unchanged."
        : assessment
          ? `Jev preview: ${profile?.label ?? "no eligible model"}${typeof effort === "string" ? ` · ${effort}` : ""} · ${assessment.tier} — ${assessment.reason}`
          : "Jev preview pending…"}
      <span className="block">
        Allowed lead pool:{" "}
        {settings.data?.policy.profiles
          .filter((p) => p.lead)
          .map((p) => p.label)
          .join(", ") || "empty"}
        .
      </span>
      {assessment?.planning && (
        <span className="block">
          {[
            assessment.planning.context === "missing"
              ? "Missing context needs clarification."
              : null,
            assessment.planning.verification === "deterministic"
              ? "Verify with a reproducible check."
              : null,
            assessment.planning.verification === "review"
              ? "Outcome needs judgment-based review."
              : null,
            assessment.planning.delegation === "separable"
              ? "Separate work items may help; lead decides."
              : null,
          ]
            .filter(Boolean)
            .join(" ")}
        </span>
      )}
      {projectId && (
        <TeamRunControls
          environmentId={environmentId}
          projectId={projectId}
          prompt={prompt}
          assessment={assessment}
          hasAttachments={hasAttachments}
          composing={composing}
        />
      )}
    </div>
  );
}

import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { ProjectId } from "./baseSchemas.ts";
import { ProviderInstanceId } from "./providerInstance.ts";
import { TeamRun, TeamStart } from "./team.ts";

const decodeTeamStart = Schema.decodeUnknownSync(TeamStart);
const encodeTeamStart = Schema.encodeSync(TeamStart);
const decodeTeamRun = Schema.decodeUnknownSync(TeamRun);
const encodeTeamRun = Schema.encodeSync(TeamRun);
const instanceId = ProviderInstanceId.make("codex");

const attachments = [
  {
    type: "image" as const,
    id: "uploaded-image",
    name: "diagram.png",
    mimeType: "image/png",
    sizeBytes: 1024,
  },
  {
    type: "file" as const,
    id: "uploaded-file",
    name: "notes.md",
    mimeType: "text/markdown",
    sizeBytes: 512,
  },
];

describe("team attachment contracts", () => {
  it("round trips image and file references through TeamStart and TeamRun", () => {
    const start = {
      commandId: "command-1",
      projectId: ProjectId.make("project-1"),
      draft: {
        draftId: "draft-1",
        revision: 1,
        policyRevision: 2,
        prompt: "Review these files",
        hasAttachments: true,
      },
      fingerprint: "fingerprint-1",
      attachments,
    };
    const profile = {
      id: "lead-profile",
      label: "Lead",
      selection: { instanceId, model: "test" },
      tier: "capable" as const,
      lead: true,
      worker: true,
      estimatedAttemptUsd: null,
    };
    const run = {
      id: "run-1",
      commandId: start.commandId,
      projectId: start.projectId,
      revision: 0,
      objective: start.draft.prompt,
      policy: {
        revision: 2,
        mode: "auto" as const,
        profiles: [profile],
        maxActive: 1,
        maxAttempts: 1,
        confidenceThreshold: 0.9,
      },
      lead: profile,
      status: "planning" as const,
      tasks: [],
      decisions: [],
      createdAt: "2026-09-20T00:00:00.000Z",
      updatedAt: "2026-09-20T00:00:00.000Z",
      attachments,
    };

    expect(decodeTeamStart(encodeTeamStart(start))).toEqual(start);
    expect(decodeTeamRun(encodeTeamRun(run))).toEqual(run);
  });

  it("keeps legacy clients valid when attachment references are omitted", () => {
    const start = decodeTeamStart({
      commandId: "command-legacy",
      projectId: ProjectId.make("project-legacy"),
      draft: {
        draftId: "draft-legacy",
        revision: 0,
        policyRevision: 0,
        prompt: "No attachments",
        hasAttachments: false,
      },
      fingerprint: "fingerprint-legacy",
    });
    const run = decodeTeamRun({
      id: "run-legacy",
      commandId: "command-legacy",
      projectId: ProjectId.make("project-legacy"),
      revision: 0,
      objective: "No attachments",
      policy: {
        revision: 0,
        mode: "off",
        profiles: [],
        maxActive: 1,
        maxAttempts: 1,
        confidenceThreshold: 0.9,
      },
      lead: {
        id: "lead-profile",
        label: "Lead",
        selection: { instanceId, model: "test" },
        tier: "capable",
        lead: true,
        worker: true,
        estimatedAttemptUsd: null,
      },
      status: "planning",
      tasks: [],
      decisions: [],
      createdAt: "2026-09-20T00:00:00.000Z",
      updatedAt: "2026-09-20T00:00:00.000Z",
    });

    expect(start).not.toHaveProperty("attachments");
    expect(run).not.toHaveProperty("attachments");
  });
});

import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";

import { ATTACHMENT_ONLY_BOOTSTRAP_PROMPT } from "./composerPromptHistory";
import { clearStartedTeamDraftIfUnchanged, useTeamRoutingState } from "./TeamRoutingPreview";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => ({
  start: vi.fn(),
  assess: vi.fn(),
  save: vi.fn(),
  navigate: vi.fn(),
  openPanel: vi.fn(),
  waitForThreadShell: vi.fn(),
  startAttachmentUpload: vi.fn(),
  awaitAttachmentUploads: vi.fn(),
  getUploadedAttachments: vi.fn(),
  forgetDraftAttachmentUploads: vi.fn(),
  scheduledDrafts: [] as Array<Record<string, unknown>>,
}));

vi.mock("@effect/atom-react", () => ({ useAtomValue: () => ({ teamRouting: true }) }));
vi.mock("@t3tools/client-runtime/state/runtime", () => ({
  squashAtomCommandFailure: (failure: { cause?: unknown }) => failure.cause ?? new Error("failed"),
}));
vi.mock("../../state/server", () => ({
  serverEnvironment: { configValueAtom: () => "server-config" },
}));
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => mocks.navigate }));
vi.mock("../../rightPanelStore", () => ({
  useRightPanelStore: { getState: () => ({ open: mocks.openPanel }) },
}));
vi.mock("../../state/team", () => ({
  teamEnvironment: {
    start: "start",
    assess: "assess",
    saveSettings: "saveSettings",
    settings: () => "settings",
  },
}));
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: (command: string) =>
    command === "start" ? mocks.start : command === "assess" ? mocks.assess : mocks.save,
}));
vi.mock("../../state/query", () => ({
  useEnvironmentQuery: () => ({
    data: {
      jevConfigured: true,
      policy: {
        revision: 3,
        mode: "shadow",
        profiles: [
          {
            id: "lead",
            label: "Lead model",
            selection: { instanceId: "codex", model: "test" },
          },
        ],
      },
    },
    refresh: vi.fn(),
  }),
}));
vi.mock("@t3tools/client-runtime/state/team-draft", () => ({
  createTeamDraftCoordinator: (options: { publish: (value: unknown) => void }) => ({
    schedule: (draft: Record<string, unknown>) => {
      mocks.scheduledDrafts.push(draft);
      options.publish({
        draftId: draft.draftId,
        revision: draft.revision,
        fingerprint: "fingerprint",
        policyRevision: draft.policyRevision,
        profileId: "lead",
        selection: { instanceId: "codex", model: "test" },
        tier: "capable",
        confidence: 1,
        reason: "test",
        source: "jev",
        inputTokens: null,
        outputTokens: null,
      });
    },
    dispose: vi.fn(),
  }),
}));
vi.mock("../../state/entities", () => ({ waitForThreadShell: mocks.waitForThreadShell }));
vi.mock("../../lib/attachmentUploadQueue", () => ({
  startAttachmentUpload: mocks.startAttachmentUpload,
  awaitAttachmentUploads: mocks.awaitAttachmentUploads,
  getUploadedAttachments: mocks.getUploadedAttachments,
  forgetDraftAttachmentUploads: mocks.forgetDraftAttachmentUploads,
}));

const environmentId = EnvironmentId.make("env");
const projectId = ProjectId.make("project");
const attachment = {
  type: "image" as const,
  id: "draft-image",
  name: "shot.png",
  mimeType: "image/png",
  sizeBytes: 42,
  previewUrl: "blob:test",
  file: {} as File,
};
const uploadedAttachment = {
  type: "image" as const,
  id: "uploaded-image",
  name: "shot.png",
  mimeType: "image/png",
  sizeBytes: 42,
};

type RoutingState = ReturnType<typeof useTeamRoutingState>;
let latest: RoutingState | null = null;
let renderer: ReactTestRenderer | null = null;

function Harness(
  props: Partial<Parameters<typeof useTeamRoutingState>[0]> & {
    prompt?: string;
  },
) {
  latest = useTeamRoutingState({
    scopeKey: "draft:one",
    environmentId,
    projectId,
    prompt: "Fix it",
    hasAttachments: false,
    hasUnsupportedContext: false,
    attachments: [],
    attachmentUploadsCapabilityKnown: true,
    supportsAttachmentUploads: true,
    attachmentDraftTarget: "draft-one" as Parameters<
      typeof useTeamRoutingState
    >[0]["attachmentDraftTarget"],
    composing: false,
    allowRouting: true,
    ...props,
  });
  return null;
}

async function mountAndEnable(props: Parameters<typeof Harness>[0] = {}) {
  await act(async () => {
    renderer = create(<Harness {...props} />);
  });
  await act(async () => {
    await latest!.setOrchestration(true);
  });
  await act(async () => {});
  expect(latest?.orchestration).toBe(true);
  expect(latest?.assessment).not.toBeNull();
}

async function submitRouting(): Promise<boolean> {
  let started = false;
  await act(async () => {
    started = await latest!.submit();
  });
  return started;
}

beforeEach(() => {
  latest = null;
  mocks.start.mockReset();
  mocks.assess.mockReset();
  mocks.save.mockReset();
  mocks.navigate.mockReset();
  mocks.openPanel.mockReset();
  mocks.waitForThreadShell.mockReset().mockResolvedValue(true);
  mocks.startAttachmentUpload.mockReset();
  mocks.awaitAttachmentUploads.mockReset().mockResolvedValue(undefined);
  mocks.getUploadedAttachments.mockReset().mockReturnValue([uploadedAttachment]);
  mocks.forgetDraftAttachmentUploads.mockReset();
  mocks.scheduledDrafts.length = 0;
});

afterEach(async () => {
  if (renderer) await act(async () => renderer?.unmount());
  renderer = null;
});

describe("team routing attachments", () => {
  it("assesses and starts an attachment-only draft with the bootstrap prompt", async () => {
    mocks.start.mockResolvedValue({
      _tag: "Success",
      value: { execution: { leadThreadId: ThreadId.make("team-lead") } },
    });
    await mountAndEnable({ prompt: "", hasAttachments: true, attachments: [attachment] });

    expect(mocks.scheduledDrafts.at(-1)).toMatchObject({
      prompt: ATTACHMENT_ONLY_BOOTSTRAP_PROMPT,
      hasAttachments: true,
    });
    const started = await submitRouting();
    expect(started).toBe(true);
    expect(mocks.startAttachmentUpload).toHaveBeenCalledWith(
      expect.objectContaining({ environmentId, image: attachment }),
    );
    expect(mocks.start.mock.calls[0]?.[0].input).toMatchObject({
      draft: { prompt: ATTACHMENT_ONLY_BOOTSTRAP_PROMPT, hasAttachments: true },
      attachments: [uploadedAttachment],
    });
    expect(mocks.forgetDraftAttachmentUploads).toHaveBeenCalledWith([attachment]);
  });

  it("blocks terminal, preview, or review context without starting a team", async () => {
    await mountAndEnable({ hasUnsupportedContext: true });
    expect(latest?.blocked).toContain("Remove terminal, preview, or review context");
    expect(await submitRouting()).toBe(false);
    expect(mocks.start).not.toHaveBeenCalled();
  });

  it("keeps ownership of uploads when upload collection fails", async () => {
    mocks.getUploadedAttachments.mockReturnValue(null);
    await mountAndEnable({ hasAttachments: true, attachments: [attachment] });
    expect(await submitRouting()).toBe(false);
    expect(mocks.start).not.toHaveBeenCalled();
    expect(mocks.forgetDraftAttachmentUploads).not.toHaveBeenCalled();
  });

  it("keeps client ownership on TeamStart failure and forgets tracking only after acceptance", async () => {
    mocks.start.mockResolvedValueOnce({ _tag: "Failure", cause: new Error("no") });
    await mountAndEnable({ hasAttachments: true, attachments: [attachment] });
    expect(await submitRouting()).toBe(false);
    expect(mocks.forgetDraftAttachmentUploads).not.toHaveBeenCalled();

    mocks.start.mockResolvedValueOnce({
      _tag: "Success",
      value: { execution: { leadThreadId: ThreadId.make("team-lead") } },
    });
    expect(await submitRouting()).toBe(true);
    expect(mocks.forgetDraftAttachmentUploads).toHaveBeenCalledTimes(1);
  });

  it("treats accepted TeamStart as started when readiness times out and reuses its command id", async () => {
    mocks.start.mockResolvedValue({
      _tag: "Success",
      value: { execution: { leadThreadId: ThreadId.make("team-lead") } },
    });
    mocks.waitForThreadShell.mockResolvedValue(false);
    await mountAndEnable({ hasAttachments: true, attachments: [attachment] });

    const firstStarted = await submitRouting();
    expect(firstStarted).toBe(true);
    expect(latest?.startError).toContain("Team started");
    const secondStarted = await submitRouting();
    expect(secondStarted).toBe(true);
    expect(mocks.start).toHaveBeenCalledTimes(2);
    expect(mocks.start.mock.calls[0]?.[0].input.commandId).toBe(
      mocks.start.mock.calls[1]?.[0].input.commandId,
    );
    expect(mocks.navigate).not.toHaveBeenCalled();

    const replacement = { ...attachment, id: "draft-image-replaced" };
    await act(async () => {
      renderer!.update(<Harness hasAttachments attachments={[replacement]} />);
    });
    await act(async () => {});
    expect(await submitRouting()).toBe(true);
    expect(mocks.start.mock.calls[2]?.[0].input.commandId).not.toBe(
      mocks.start.mock.calls[1]?.[0].input.commandId,
    );
  });
});

describe("started team draft clearing", () => {
  const draft = {
    prompt: "Fix it",
    images: [attachment],
    files: [],
  };

  it("clears an unchanged draft snapshot after a confirmed start", () => {
    const clear = vi.fn();
    expect(
      clearStartedTeamDraftIfUnchanged({
        currentDraft: draft,
        promptSnapshot: "Fix it",
        attachmentIds: [attachment.id],
        clear,
      }),
    ).toBe(true);
    expect(clear).toHaveBeenCalledOnce();
  });

  it("does not clear a draft changed while TeamStart was in flight", () => {
    const clear = vi.fn();
    expect(
      clearStartedTeamDraftIfUnchanged({
        currentDraft: { ...draft, prompt: "I changed this" },
        promptSnapshot: "Fix it",
        attachmentIds: [attachment.id],
        clear,
      }),
    ).toBe(false);
    expect(clear).not.toHaveBeenCalled();
  });
});

import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import {
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type TeamSettings,
} from "@dispatch/contracts";

import { ATTACHMENT_ONLY_BOOTSTRAP_PROMPT } from "./composerPromptHistory";
import {
  clearStartedTeamDraftIfUnchanged,
  isTeamRoutingReady,
  TeamRoutingActions,
  TeamRoutingProvider,
  useTeamRoutingState,
} from "./TeamRoutingPreview";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => ({
  start: vi.fn(),
  navigate: vi.fn(),
  openPanel: vi.fn(),
  waitForThreadShell: vi.fn(),
  startAttachmentUpload: vi.fn(),
  awaitAttachmentUploads: vi.fn(),
  getUploadedAttachments: vi.fn(),
  forgetDraftAttachmentUploads: vi.fn(),
  settingsData: null as TeamSettings | null,
  teamRoutingCapable: true,
}));

vi.mock("@effect/atom-react", () => ({
  useAtomValue: () => ({ teamRouting: mocks.teamRoutingCapable }),
}));
vi.mock("@dispatch/client-runtime/state/runtime", () => ({
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
    settings: () => "settings",
  },
}));
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: () => mocks.start,
}));
vi.mock("../../state/query", () => ({
  useEnvironmentQuery: () => ({
    data: mocks.settingsData,
    refresh: vi.fn(),
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
const configuredSettings = {
  smartRouting: { available: false, reason: "smart_routing_session_required" },
  policy: {
    revision: 3,
    enabled: true,
    flowMode: "standard" as const,
    profiles: [
      {
        id: "lead",
        label: "Lead model",
        selection: { instanceId: ProviderInstanceId.make("codex"), model: "test" },
        lead: true,
        worker: false,
      },
    ],
    maxActive: 5,
    maxAttempts: 2,
    providerLimitBehavior: "ask" as const,
  },
} satisfies TeamSettings;

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
    runtimeMode: "approval-required",
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

function ActionsHarness(props: Partial<Parameters<typeof useTeamRoutingState>[0]> = {}) {
  const state = useTeamRoutingState({
    scopeKey: "draft:actions",
    environmentId,
    projectId,
    runtimeMode: "approval-required",
    prompt: "Fix it",
    hasAttachments: false,
    hasUnsupportedContext: false,
    attachments: [],
    attachmentUploadsCapabilityKnown: true,
    supportsAttachmentUploads: true,
    attachmentDraftTarget: "draft-actions" as Parameters<
      typeof useTeamRoutingState
    >[0]["attachmentDraftTarget"],
    composing: false,
    allowRouting: true,
    ...props,
  });
  return (
    <TeamRoutingProvider state={state}>
      <TeamRoutingActions />
    </TeamRoutingProvider>
  );
}

async function mountAndEnable(props: Parameters<typeof Harness>[0] = {}) {
  await act(async () => {
    renderer = create(<Harness {...props} />);
  });
  await act(async () => {
    await latest!.setOrchestration(true);
  });
  expect(latest?.orchestration).toBe(true);
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
  mocks.settingsData = configuredSettings;
  mocks.start.mockReset();
  mocks.navigate.mockReset();
  mocks.openPanel.mockReset();
  mocks.waitForThreadShell.mockReset().mockResolvedValue(true);
  mocks.startAttachmentUpload.mockReset();
  mocks.awaitAttachmentUploads.mockReset().mockResolvedValue(undefined);
  mocks.getUploadedAttachments.mockReset().mockReturnValue([uploadedAttachment]);
  mocks.forgetDraftAttachmentUploads.mockReset();
  mocks.teamRoutingCapable = true;
});

describe("team routing readiness", () => {
  it("requires Lead for Standard but allows a Worker-only Auto setup", () => {
    expect(isTeamRoutingReady(true, null)).toBe(false);
    expect(isTeamRoutingReady(false, configuredSettings)).toBe(false);
    expect(isTeamRoutingReady(true, configuredSettings)).toBe(true);
    expect(
      isTeamRoutingReady(true, {
        ...configuredSettings,
        policy: {
          ...configuredSettings.policy,
          profiles: configuredSettings.policy.profiles.map((profile) => ({
            ...profile,
            lead: false,
          })),
        },
      }),
    ).toBe(false);
    expect(
      isTeamRoutingReady(true, {
        ...configuredSettings,
        smartRouting: { available: true, reason: null },
        policy: {
          ...configuredSettings.policy,
          flowMode: "auto",
          profiles: configuredSettings.policy.profiles.map((profile) => ({
            ...profile,
            lead: false,
            worker: true,
          })),
        },
      }),
    ).toBe(true);
    expect(
      isTeamRoutingReady(true, {
        ...configuredSettings,
        policy: {
          ...configuredSettings.policy,
          enabled: false,
        },
      }),
    ).toBe(false);
    expect(
      isTeamRoutingReady(true, {
        ...configuredSettings,
        policy: {
          ...configuredSettings.policy,
          profiles: configuredSettings.policy.profiles.map((profile) => ({
            ...profile,
            worker: false,
          })),
        },
      }),
    ).toBe(true);
  });

  it("stays unavailable until settings finish loading and enables without a preflight RPC", async () => {
    mocks.settingsData = null;
    await act(async () => {
      renderer = create(<Harness />);
    });
    expect(latest?.ready).toBe(false);
    expect(mocks.start).not.toHaveBeenCalled();

    await act(async () => {
      await latest!.setOrchestration(true);
    });
    expect(latest?.orchestration).toBe(false);
    expect(mocks.start).not.toHaveBeenCalled();

    mocks.settingsData = configuredSettings;
    await act(async () => {
      renderer!.update(<Harness />);
    });
    expect(latest?.ready).toBe(true);

    await act(async () => {
      await latest!.setOrchestration(true);
    });
    expect(latest?.orchestration).toBe(true);
    expect(latest?.automatic).toBe(true);
    expect(latest?.flowMode).toBe("standard");
    expect(latest?.summary).toBe(
      "Standard uses your selected Lead and Worker models without hosted routing",
    );
    expect(mocks.start).not.toHaveBeenCalled();

    await act(async () => {
      await latest!.setOrchestration(false);
    });
    expect(latest?.automatic).toBe(false);
    expect(mocks.start).not.toHaveBeenCalled();
  });

  it("shows setup only for a supported loaded draft that is not ready", async () => {
    mocks.settingsData = {
      ...configuredSettings,
      policy: { ...configuredSettings.policy, enabled: false },
    };
    await act(async () => {
      renderer = create(<ActionsHarness />);
    });
    const setup = renderer!.root
      .findAllByType("button")
      .find((button) => button.children.includes("Set up Flow"));
    expect(setup).toBeDefined();
    await act(async () => {
      setup!.props.onClick();
    });
    expect(mocks.navigate).toHaveBeenCalledWith({ to: "/settings/orchestration" });

    mocks.settingsData = null;
    await act(async () => {
      renderer!.update(<ActionsHarness />);
    });
    expect(renderer!.root.findAllByType("button")).toHaveLength(0);

    mocks.settingsData = {
      ...configuredSettings,
      policy: { ...configuredSettings.policy, enabled: false },
    };
    mocks.teamRoutingCapable = false;
    await act(async () => {
      renderer!.update(<ActionsHarness />);
    });
    expect(renderer!.root.findAllByType("button")).toHaveLength(0);

    mocks.teamRoutingCapable = true;
    await act(async () => {
      renderer!.update(<ActionsHarness projectId={null} />);
    });
    expect(renderer!.root.findAllByType("button")).toHaveLength(0);

    await act(async () => {
      renderer!.update(<ActionsHarness allowRouting={false} />);
    });
    expect(renderer!.root.findAllByType("button")).toHaveLength(0);

    mocks.settingsData = configuredSettings;
    await act(async () => {
      renderer!.update(<ActionsHarness />);
    });
    expect(renderer!.root.findAll((node) => node.props.role === "switch")).toHaveLength(1);
    expect(
      renderer!.root
        .findAllByType("button")
        .some((button) => button.children.includes("Set up Flow")),
    ).toBe(false);
  });

  it("keeps Auto selected and runs through Standard when Smart Routing is unavailable", async () => {
    mocks.settingsData = {
      ...configuredSettings,
      policy: { ...configuredSettings.policy, flowMode: "auto" },
    };
    await mountAndEnable();

    expect(latest?.flowMode).toBe("auto");
    expect(latest?.smartRouting).toBe(false);
    expect(latest?.orchestration).toBe(true);
    expect(latest?.fallbackNotice).toContain("Running this task with Standard instead");
    expect(latest?.summary).toContain("use Standard");
  });

  it("keeps Worker-only Auto selectable but reports when fallback cannot start", async () => {
    mocks.settingsData = {
      ...configuredSettings,
      policy: {
        ...configuredSettings.policy,
        flowMode: "auto",
        profiles: configuredSettings.policy.profiles.map((profile) => ({
          ...profile,
          lead: false,
          worker: true,
        })),
      },
    };
    await mountAndEnable();

    expect(latest?.ready).toBe(true);
    expect(latest?.autoFallbackNeedsLead).toBe(true);
    expect(latest?.fallbackNotice).toContain("Standard fallback cannot start");
    expect(latest?.summary).toContain("fallback needs a selected Lead");
  });

  it("uses Smart Routing only when Auto is selected and the hosted capability is available", async () => {
    mocks.settingsData = {
      ...configuredSettings,
      smartRouting: { available: true, reason: null },
      policy: { ...configuredSettings.policy, flowMode: "auto" },
    };
    await mountAndEnable();

    expect(latest?.flowMode).toBe("auto");
    expect(latest?.smartRouting).toBe(true);
    expect(latest?.modeLabel).toBe("Flow · Auto");
    expect(latest?.fallbackNotice).toBeNull();
  });

  it("reports managed-team Lead coverage without blocking Worker-only direct Auto", async () => {
    mocks.settingsData = {
      ...configuredSettings,
      smartRouting: { available: true, reason: null },
      policy: {
        ...configuredSettings.policy,
        flowMode: "auto",
        profiles: configuredSettings.policy.profiles.map((profile) => ({
          ...profile,
          lead: false,
          worker: true,
        })),
      },
    };
    await mountAndEnable();

    expect(latest?.ready).toBe(true);
    expect(latest?.smartRouting).toBe(true);
    expect(latest?.autoManagedNeedsLead).toBe(true);
    expect(latest?.autoLeadNotice).toContain("Worker-only Auto can run direct work");
    expect(latest?.summary).toContain("managed-team decisions require a selected Lead");
  });
});

afterEach(async () => {
  if (renderer) await act(async () => renderer?.unmount());
  renderer = null;
});

describe("team routing attachments", () => {
  it("starts an attachment-only draft directly with the bootstrap prompt", async () => {
    const returnedLeadThreadId = ThreadId.make("returned-team-lead");
    mocks.start.mockResolvedValue({
      _tag: "Success",
      value: { lead: { threadId: returnedLeadThreadId } },
    });
    await mountAndEnable({ prompt: "", hasAttachments: true, attachments: [attachment] });

    const started = await submitRouting();
    expect(started).toBe(true);
    expect(mocks.startAttachmentUpload).toHaveBeenCalledWith(
      expect.objectContaining({ environmentId, image: attachment }),
    );
    expect(mocks.start.mock.calls[0]?.[0].input).toMatchObject({
      projectId,
      runtimeMode: "approval-required",
      prompt: ATTACHMENT_ONLY_BOOTSTRAP_PROMPT,
      attachments: [uploadedAttachment],
    });
    expect(mocks.forgetDraftAttachmentUploads).toHaveBeenCalledWith([attachment]);
    expect(mocks.navigate).toHaveBeenCalledWith({
      to: "/$environmentId/$threadId",
      params: { environmentId, threadId: returnedLeadThreadId },
    });
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
      value: { lead: { threadId: ThreadId.make("team-lead") } },
    });
    expect(await submitRouting()).toBe(true);
    expect(mocks.forgetDraftAttachmentUploads).toHaveBeenCalledTimes(1);
  });

  it("treats accepted TeamStart as started when readiness times out and reuses its command id", async () => {
    mocks.start.mockResolvedValue({
      _tag: "Success",
      value: { lead: { threadId: ThreadId.make("team-lead") } },
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

  it("forwards the composer runtime mode and gives a mode change a new command identity", async () => {
    mocks.start.mockResolvedValue({
      _tag: "Success",
      value: { lead: { threadId: ThreadId.make("team-lead") } },
    });
    mocks.waitForThreadShell.mockResolvedValue(false);
    await mountAndEnable({ runtimeMode: "approval-required" });

    expect(await submitRouting()).toBe(true);
    const supervised = mocks.start.mock.calls[0]?.[0].input;
    expect(supervised.runtimeMode).toBe("approval-required");

    await act(async () => {
      renderer!.update(<Harness runtimeMode="full-access" />);
    });
    await act(async () => {});
    expect(await submitRouting()).toBe(true);
    const fullAccess = mocks.start.mock.calls[1]?.[0].input;
    expect(fullAccess.runtimeMode).toBe("full-access");
    expect(fullAccess.commandId).not.toBe(supervised.commandId);
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

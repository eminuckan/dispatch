import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { beforeEach, expect, it, vi } from "vite-plus/test";
import {
  EnvironmentId,
  ProviderInstanceId,
  ThreadId,
  type TeamThreadView,
} from "@dispatch/contracts";

const mocks = vi.hoisted(() => ({
  providerDecision: vi.fn(),
  openPanel: vi.fn(),
}));

vi.mock("../../state/team", () => ({
  teamEnvironment: {
    control: Symbol("control"),
    providerDecision: Symbol("providerDecision"),
    forThread: vi.fn(),
  },
}));
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: () => mocks.providerDecision,
}));
vi.mock("../../rightPanelStore", () => ({
  useRightPanelStore: { getState: () => ({ open: mocks.openPanel }) },
}));
vi.mock("@dispatch/client-runtime/state/runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@dispatch/client-runtime/state/runtime")>();
  return {
    ...actual,
    squashAtomCommandFailure: (failure: { cause?: unknown }) =>
      failure.cause ?? new Error("failed"),
  };
});

import { TeamProviderLimitDecision } from "./TeamConversation";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const environmentId = EnvironmentId.make("environment");
const instanceId = ProviderInstanceId.make("codex");
const currentThreadId = ThreadId.make("team-lead");

function run(): TeamThreadView {
  const profiles: TeamThreadView["profiles"] = [
    {
      id: "current",
      label: "Current Luna",
      selection: { instanceId, model: "luna" },
      lead: true,
      worker: true,
    },
    {
      id: "backup",
      label: "Backup Astra",
      selection: { instanceId, model: "astra" },
      lead: true,
      worker: true,
    },
  ];
  return {
    id: "run-1",
    threadId: ThreadId.make("team-lead"),
    revision: 7,
    executionMode: "orchestrated",
    objective: "Ship the change",
    prompt: "Ship the change",
    status: "awaiting-provider-decision",
    statusReason: "Provider limit reached.",
    profiles,
    lead: profiles[0]!,
    leadOwner: {
      role: "lead",
      profileId: "current",
      threadId: ThreadId.make("team-lead"),
      taskId: null,
    },
    leadThreadId: ThreadId.make("team-lead"),
    phase: "workers",
    notice: "Provider limit reached.",
    workspace: null,
    tasks: [],
    attempts: [],
    turns: [],
    messages: [],
    settlements: [],
    failovers: [
      {
        id: "failover-1",
        taskId: null,
        attemptId: "attempt-1",
        fromProfileId: "current",
        candidateProfileIds: ["backup"],
        trigger: {
          kind: "provider-limit",
          providerInstanceId: instanceId,
          limitId: "weekly",
          detail: "Weekly provider limit reached.",
        },
        status: "pending",
        decision: null,
        createdAt: "now",
        updatedAt: "now",
      },
    ],
  };
}

function button(renderer: ReactTestRenderer, text: string) {
  const match = renderer.root.findAll(
    (node) => node.type === "button" && node.props.children === text,
  )[0];
  if (!match) throw new Error(`Missing button: ${text}`);
  return match;
}

beforeEach(() => {
  mocks.openPanel.mockReset();
  mocks.providerDecision.mockReset().mockResolvedValue({
    _tag: "Success",
    value: {
      lead: { role: "lead", profileId: "current", threadId: currentThreadId, taskId: null },
    },
  });
});

it("renders provider-limit guidance and switches to the selected candidate with exact RPC input", async () => {
  const refresh = vi.fn();
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(
      <TeamProviderLimitDecision
        run={run()}
        environmentId={environmentId}
        currentThreadId={currentThreadId}
        refresh={refresh}
      />,
    );
  });

  const text = JSON.stringify(renderer.toJSON());
  expect(text).toContain("Current Luna");
  expect(text).toContain("hit a provider limit");
  expect(text).toContain("another selected model/provider");
  expect(text).toContain("Backup Astra");

  await act(async () => {
    button(renderer, "Continue with Backup Astra").props.onClick();
    await Promise.resolve();
    await Promise.resolve();
  });
  expect(mocks.providerDecision).toHaveBeenCalledWith({
    environmentId,
    input: {
      id: "run-1",
      revision: 7,
      failoverId: "failover-1",
      action: "switch",
      profileId: "backup",
    },
  });
  expect(refresh).toHaveBeenCalledOnce();
  expect(mocks.openPanel).not.toHaveBeenCalled();
});

it("opens the authoritative replacement lead after a successful cross-provider switch", async () => {
  const refresh = vi.fn();
  const replacementLeadThreadId = ThreadId.make("team-run-1-lead-replacement");
  mocks.providerDecision.mockResolvedValueOnce({
    _tag: "Success",
    value: {
      lead: {
        role: "lead",
        profileId: "backup",
        threadId: replacementLeadThreadId,
        taskId: null,
      },
    },
  });
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(
      <TeamProviderLimitDecision
        run={run()}
        environmentId={environmentId}
        currentThreadId={currentThreadId}
        refresh={refresh}
      />,
    );
  });

  await act(async () => {
    button(renderer, "Continue with Backup Astra").props.onClick();
    await Promise.resolve();
    await Promise.resolve();
  });

  expect(mocks.openPanel).toHaveBeenCalledOnce();
  expect(mocks.openPanel).toHaveBeenCalledWith(
    { environmentId, threadId: replacementLeadThreadId },
    "agents",
  );
  expect(refresh).toHaveBeenCalledOnce();
});

it("can pause a pending failover and surfaces command errors with a refresh action", async () => {
  const refresh = vi.fn();
  mocks.providerDecision.mockResolvedValueOnce({ _tag: "Failure", cause: new Error("stale run") });
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(
      <TeamProviderLimitDecision
        run={run()}
        environmentId={environmentId}
        currentThreadId={currentThreadId}
        refresh={refresh}
      />,
    );
  });

  await act(async () => {
    button(renderer, "Pause Flow").props.onClick();
    await Promise.resolve();
    await Promise.resolve();
  });
  expect(mocks.providerDecision).toHaveBeenCalledWith({
    environmentId,
    input: {
      id: "run-1",
      revision: 7,
      failoverId: "failover-1",
      action: "pause",
      profileId: null,
    },
  });
  expect(refresh).toHaveBeenCalledOnce();
  expect(mocks.openPanel).not.toHaveBeenCalled();
  expect(JSON.stringify(renderer.toJSON())).toContain("stale run");

  await act(async () => {
    button(renderer, "Refresh").props.onClick();
  });
  expect(refresh).toHaveBeenCalledTimes(2);
});

it("renders nothing outside awaiting-provider-decision", async () => {
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(
      <TeamProviderLimitDecision
        run={{ ...run(), status: "running" }}
        environmentId={environmentId}
        currentThreadId={currentThreadId}
        refresh={vi.fn()}
      />,
    );
  });
  expect(renderer.toJSON()).toBeNull();
});

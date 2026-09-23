import { act, create, type ReactTestRenderer } from "react-test-renderer";
import type { ReactNode } from "react";
import { beforeEach, expect, it, vi } from "vite-plus/test";
import {
  EnvironmentId,
  MessageId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type TeamThreadView,
} from "@dispatch/contracts";
import type { TimelineEntry } from "../../session-logic";

const mocks = vi.hoisted(() => ({
  providerDecision: vi.fn(),
  openPanel: vi.fn(),
  query: vi.fn(),
  thread: vi.fn(),
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
vi.mock("../../state/query", () => ({ useEnvironmentQuery: mocks.query }));
vi.mock("../../state/entities", () => ({ useThread: mocks.thread }));
vi.mock("@tanstack/react-router", () => ({
  Link: ({ children }: { children: ReactNode }) => <a>{children}</a>,
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

import { TeamAgentsPanel, TeamConversation, TeamProviderLimitDecision } from "./TeamConversation";
import { teamAgentName } from "./teamConversation.logic";

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

function assistantEntry(id: string, text: string): Extract<TimelineEntry, { kind: "message" }> {
  return {
    id,
    kind: "message",
    createdAt: "now",
    message: {
      id: MessageId.make(id),
      role: "assistant",
      text,
      turnId: null,
      streaming: false,
      createdAt: "now",
      updatedAt: "now",
    },
  };
}

it("keeps structured output readable across lead and worker thread selection while the run view is absent", async () => {
  const windowStub = {
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    setInterval: vi.fn(() => 1),
    clearInterval: vi.fn(),
  };
  vi.stubGlobal("window", windowStub);
  vi.stubGlobal("document", { hidden: false });
  mocks.query.mockReturnValue({
    data: null,
    error: null,
    isPending: false,
    isSuccess: true,
    refresh: vi.fn(),
  });

  const planEntry = assistantEntry(
    "plan-follow-up",
    JSON.stringify({
      acceptance: ["Saved profiles remain unchanged."],
      tasks: [
        {
          id: "ui-profile",
          objective: "Keep profiles independent by effort.",
          acceptance: ["The selected effort remains visible."],
          dependencies: [],
          context: "Private planning context.",
        },
      ],
      rationale: "This is the lead's complete plan.",
    }),
  );
  const workerEntry = assistantEntry(
    "worker-settlement",
    JSON.stringify({
      summary: "The profile rows now show their selected effort.",
      commit: "abcdef0123456789",
      changedFiles: ["TeamSettingsPanel.tsx"],
      checks: [{ command: "vp", args: ["test", "run"], outcome: "passed" }],
      limitations: ["The integrated browser pass is pending."],
    }),
  );
  const ordinaryJson = assistantEntry("manual-json", '{"summary":"A normal JSON example."}');

  const view = (threadId: ThreadId, entries: TimelineEntry[]) => (
    <TeamConversation environmentId={environmentId} threadId={threadId} entries={entries}>
      {(visible) => (
        <div>
          {visible.flatMap((entry) => (entry.kind === "message" ? [entry.message.text] : []))}
        </div>
      )}
    </TeamConversation>
  );

  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(view(ThreadId.make("team-run-1-lead"), [planEntry]));
  });
  expect(JSON.stringify(renderer.toJSON())).toContain("This is the lead's complete plan.");
  expect(JSON.stringify(renderer.toJSON())).not.toContain('"acceptance"');
  expect(JSON.stringify(renderer.toJSON())).not.toContain("Private planning context.");

  await act(async () => {
    renderer.update(view(ThreadId.make("team-run-1-worker-task"), [workerEntry, ordinaryJson]));
  });
  const workerText = JSON.stringify(renderer.toJSON());
  expect(workerText).toContain("The profile rows now show their selected effort.");
  expect(workerText).not.toContain("abcdef0123456789");
  const workerOutput = renderer.toJSON();
  if (!workerOutput || Array.isArray(workerOutput)) throw new Error("Expected worker output.");
  expect(workerOutput.children).toContain('{"summary":"A normal JSON example."}');

  await act(async () => {
    renderer.update(view(ThreadId.make("team-run-1-lead"), [planEntry]));
    renderer.unmount();
  });
  vi.unstubAllGlobals();
});

it("tracks the lead thread while the Agents panel is opened from a worker chat", async () => {
  const workerThreadId = ThreadId.make("team-run-1-worker-task");
  const flow = { ...run(), status: "paused" as const, failovers: [] };
  mocks.query.mockReturnValue({ data: flow, error: null, refresh: vi.fn() });
  let leadThread: unknown = {
    session: { status: "running", activeTurnId: TurnId.make("manual-lead-turn") },
    latestTurn: null,
  };
  mocks.thread.mockImplementation(() => leadThread);

  const view = () => (
    <TeamAgentsPanel environmentId={environmentId} threadId={workerThreadId} cwd={undefined}>
      <div>worker chat</div>
    </TeamAgentsPanel>
  );
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(view());
  });
  expect(mocks.thread).toHaveBeenCalledWith({ environmentId, threadId: currentThreadId });
  const leadStatus = () =>
    renderer.root.findAll(
      (node) =>
        node.type === "span" &&
        typeof node.props.className === "string" &&
        node.props.className.includes("text-right") &&
        node.children.length === 1,
    )[0]?.children[0];
  expect(leadStatus()).toBe("running");

  leadThread = {
    session: { status: "idle", activeTurnId: null },
    latestTurn: { state: "completed", turnId: TurnId.make("manual-lead-turn") },
  };
  await act(async () => {
    renderer.update(view());
  });
  expect(leadStatus()).toBe("paused");
  await act(async () => renderer.unmount());
});

it("shows each durable Flow message once in both member chats while switching routes", async () => {
  const workerThreadId = ThreadId.make("team-run-1-worker-task");
  const task: TeamThreadView["tasks"][number] = {
    id: "task-1",
    objective: "Update the feature",
    context: "Keep the change focused.",
    acceptance: ["The direct message appears in this chat."],
    dependencies: [],
    owner: { role: "worker", profileId: "current", threadId: workerThreadId, taskId: "task-1" },
    branch: null,
    worktreePath: null,
    status: "running",
    attemptIds: [],
    settlementId: null,
    result: null,
  };
  const message = {
    id: "flow-message-1",
    from: { role: "lead" as const, profileId: "current", threadId: currentThreadId, taskId: null },
    to: task.owner,
    text: "Please check the retry path.",
    replyRequested: false,
    createdAt: "2026-09-23T11:00:00.000Z",
    readAt: null,
    delivery: { status: "sent" as const },
  };
  const teamRun = { ...run(), status: "running" as const, tasks: [task], messages: [message] };
  const fromName = teamAgentName(teamRun, currentThreadId);
  const toName = teamAgentName(teamRun, workerThreadId);
  mocks.query.mockReturnValue({
    data: teamRun,
    error: null,
    isPending: false,
    isSuccess: true,
    refresh: vi.fn(),
  });
  vi.stubGlobal("window", {
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    setInterval: vi.fn(() => 1),
    clearInterval: vi.fn(),
  });
  vi.stubGlobal("document", { hidden: false });

  const view = (threadId: ThreadId) => (
    <TeamConversation environmentId={environmentId} threadId={threadId} entries={[]}>
      {(_entries, messages) => (
        <div>
          {messages.map((entry) => (
            <article key={entry.id} data-id={entry.id}>
              Flow message · {entry.from} → {entry.to}: {entry.text} · {entry.deliveryStatus}
            </article>
          ))}
        </div>
      )}
    </TeamConversation>
  );
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(view(currentThreadId));
  });
  const assertMessageVisibleOnce = () => {
    const articles = renderer.root.findAll((node) => node.props["data-id"] === message.id);
    expect(articles).toHaveLength(1);
    expect(articles[0]?.children).toEqual([
      "Flow message · ",
      fromName,
      " → ",
      toName,
      ": ",
      message.text,
      " · ",
      "sent",
    ]);
  };
  assertMessageVisibleOnce();

  await act(async () => renderer.update(view(workerThreadId)));
  assertMessageVisibleOnce();

  await act(async () => renderer.update(view(ThreadId.make("team-unrelated-worker"))));
  expect(JSON.stringify(renderer.toJSON())).not.toContain(message.text);
  await act(async () => renderer.unmount());
  vi.unstubAllGlobals();
});

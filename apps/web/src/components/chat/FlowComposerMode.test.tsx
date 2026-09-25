import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { describe, expect, it, vi } from "vite-plus/test";
import { EnvironmentId, ProjectId, ThreadId } from "@dispatch/contracts";

import { useFlowComposerMode } from "./FlowComposerMode";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => ({ capable: true }));
vi.mock("@effect/atom-react", () => ({
  useAtomValue: () => ({ flow: mocks.capable }),
}));
vi.mock("../../state/server", () => ({
  serverEnvironment: { configValueAtom: () => "config" },
}));

const environmentId = EnvironmentId.make("env");
const projectId = ProjectId.make("project");
const threadId = ThreadId.make("thread");
const onExistingThreadChange = vi.fn(async () => undefined);

type Input = Parameters<typeof useFlowComposerMode>[0];
let state: ReturnType<typeof useFlowComposerMode>;
function Harness(props: Input) {
  state = useFlowComposerMode(props);
  return null;
}

function input(overrides: Partial<Input> = {}): Input {
  return {
    environmentId,
    projectId,
    threadId: null,
    initialEnabled: false,
    allowRouting: true,
    onExistingThreadChange,
    onDraftChange: vi.fn(),
    ...overrides,
  };
}

async function mount(props: Input) {
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(<Harness {...props} />);
  });
  return renderer;
}

describe("Flow composer mode", () => {
  it("keeps a draft's explicit choice without routing or changing its model", async () => {
    const onDraftChange = vi.fn();
    const renderer = await mount(input({ onDraftChange }));
    expect(state.enabled).toBe(false);
    await act(async () => {
      await state.setEnabled(true);
    });
    expect(onDraftChange).toHaveBeenCalledWith(true);
    await act(async () => {
      renderer.update(<Harness {...input({ onDraftChange, initialEnabled: true })} />);
    });
    expect(state.enabled).toBe(true);
    expect(onExistingThreadChange).not.toHaveBeenCalled();
    await act(async () => {
      renderer.unmount();
    });
  });

  it("persists changes to an existing thread", async () => {
    onExistingThreadChange.mockClear();
    const renderer = await mount(input({ threadId, initialEnabled: true }));
    expect(state.enabled).toBe(true);
    await act(async () => {
      await state.setEnabled(false);
    });
    expect(onExistingThreadChange).toHaveBeenCalledWith(false);
    expect(state.enabled).toBe(true);
    await act(async () => {
      renderer.update(<Harness {...input({ threadId, initialEnabled: false })} />);
    });
    expect(state.enabled).toBe(false);
    await act(async () => {
      renderer.unmount();
    });
  });

  it("does not enable Flow on an older server", async () => {
    mocks.capable = false;
    const renderer = await mount(input());
    await act(async () => {
      await state.setEnabled(true);
    });
    expect(state.enabled).toBe(false);
    await act(async () => {
      renderer.unmount();
    });
    mocks.capable = true;
  });
});

import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@dispatch/contracts";
import { forwardRef, useImperativeHandle } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { deriveProviderInstanceEntries } from "../../providerInstances";
import type { ModelEsque } from "./providerIconUtils";
import { ModelPickerContent } from "./ModelPickerContent";

const mockState = vi.hoisted(() => ({
  onListRender: vi.fn<() => void>(),
  scrollElement: null as unknown,
}));

vi.mock("@effect/atom-react", () => ({ useAtomValue: () => undefined }));
vi.mock("@legendapp/list/react", () => ({
  LegendList: forwardRef(function MockLegendList(_props, ref) {
    useImperativeHandle(ref, () => ({ getScrollableNode: () => mockState.scrollElement }), []);
    mockState.onListRender();
    return null;
  }),
}));
vi.mock("~/hooks/useSettings", () => ({
  useClientSettings: (selector: (settings: object) => unknown) => selector({}),
  useUpdateClientSettings: () => () => {},
}));
vi.mock("../../state/server", () => ({ primaryServerKeybindingsAtom: {} }));
vi.mock("../../commandPaletteBus", () => ({ isCommandPaletteOpen: () => false }));
vi.mock("../../keybindings", () => ({
  modelPickerJumpCommandForIndex: () => null,
  modelPickerJumpIndexFromCommand: () => null,
  resolveShortcutCommand: () => null,
  shortcutLabelForCommand: () => null,
}));
vi.mock("./ModelListRow", () => ({ ModelListRow: () => null }));
vi.mock("./ModelPickerSidebar", () => ({ ModelPickerSidebar: () => null }));
vi.mock("../ui/button", () => ({ Button: () => null }));
vi.mock("../ui/tooltip", () => ({
  TooltipProvider: ({ children }: { children?: React.ReactNode }) => children,
}));
vi.mock("../ui/combobox", () => {
  const passthrough = ({ children }: { children?: React.ReactNode }) => children;
  return {
    Combobox: passthrough,
    ComboboxEmpty: passthrough,
    ComboboxInput: () => null,
    ComboboxItem: passthrough,
    ComboboxListVirtualized: passthrough,
  };
});

const instanceId = ProviderInstanceId.make("codex");

function providerEntry() {
  const provider: ServerProvider = {
    instanceId,
    driver: ProviderDriverKind.make("codex"),
    enabled: true,
    installed: true,
    version: null,
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-08-28T00:00:00.000Z",
    models: [],
    slashCommands: [],
    skills: [],
  };
  return deriveProviderInstanceEntries([provider])[0]!;
}

const instanceEntries = [providerEntry()];
const modelOptions: ModelEsque[] = Array.from({ length: 6 }, (_, index) => ({
  slug: `model-${index}`,
  name: `Model ${index}`,
}));
const modelOptionsByInstance = new Map([[instanceId, modelOptions]]);
const onInstanceModelChange = () => {};

let renderer: ReactTestRenderer | null = null;
const frameCallbacks = new Map<number, FrameRequestCallback>();
let nextFrameId = 0;

class TestScrollableElement {
  scrollTop = 0;
  scrollHeight = 100;
  clientHeight = 200;
}

afterEach(() => {
  if (renderer) {
    act(() => renderer?.unmount());
    renderer = null;
  }
  frameCallbacks.clear();
  vi.unstubAllGlobals();
});

describe("ModelPickerContent render stability", () => {
  it("settles scroll-fade updates when favorites are unset", () => {
    mockState.onListRender.mockClear();
    mockState.scrollElement = new TestScrollableElement();
    nextFrameId = 0;
    frameCallbacks.clear();
    const testWindow = {
      addEventListener: () => {},
      removeEventListener: () => {},
      requestAnimationFrame: (callback: FrameRequestCallback) => {
        const id = ++nextFrameId;
        frameCallbacks.set(id, callback);
        return id;
      },
      cancelAnimationFrame: (id: number) => {
        frameCallbacks.delete(id);
      },
      setTimeout: () => 1,
      clearTimeout: () => {},
    };
    vi.stubGlobal("window", testWindow);
    vi.stubGlobal("HTMLElement", TestScrollableElement);
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);

    act(() => {
      renderer = create(
        <ModelPickerContent
          activeInstanceId={instanceId}
          model="model-0"
          lockedProvider={null}
          instanceEntries={instanceEntries}
          modelOptionsByInstance={modelOptionsByInstance}
          terminalOpen={false}
          onInstanceModelChange={onInstanceModelChange}
        />,
      );
    });

    expect(frameCallbacks.size).toBeGreaterThan(0);
    const rendersBeforeMeasurement = mockState.onListRender.mock.calls.length;
    const initialFrames = [...frameCallbacks.values()];
    frameCallbacks.clear();
    act(() => initialFrames.forEach((measure) => measure(16)));

    expect(mockState.onListRender).toHaveBeenCalledTimes(rendersBeforeMeasurement + 1);
    const followUpFrames = [...frameCallbacks.values()];
    frameCallbacks.clear();
    act(() => followUpFrames.forEach((measure) => measure(32)));
    expect(mockState.onListRender).toHaveBeenCalledTimes(rendersBeforeMeasurement + 1);
    expect(frameCallbacks.size).toBe(0);
  });
});

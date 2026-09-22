import { DEFAULT_UNIFIED_SETTINGS, type UnifiedSettings } from "@dispatch/contracts";
import { act, type ReactNode } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  prefix: "dispatch/",
  mixed: false,
  supported: true,
  projectScope: false,
  search: { machine: "one" },
  update: vi.fn<(patch: { branchPrefix: string }) => Promise<boolean>>(),
  clear: vi.fn<() => Promise<boolean>>(),
}));
vi.mock("./useScopedSettings", () => ({
  useScopedSettings: (selector: (settings: UnifiedSettings) => unknown) =>
    selector({ ...DEFAULT_UNIFIED_SETTINGS, branchPrefix: state.prefix }),
  useScopedSettingsMixed: () => state.mixed,
  useScopedSettingSource: () => "environment",
  useUpdateScopedSettings: () => state.update,
  useClearScopedSettings: () => state.clear,
}));
vi.mock("./SettingsScopeContext", () => ({
  useSettingsScope: () => ({
    scope: { kind: state.projectScope ? "checkout" : "environment" },
    search: state.search,
    connectedEnvironments: [
      {
        serverConfig: { environment: { capabilities: { branchPrefixSettings: state.supported } } },
      },
    ],
  }),
}));
vi.mock("./settingsSearch", () => ({ searchableSetting: (id: string) => ({ id, title: id }) }));
vi.mock("./settingsLayout", () => ({
  SettingsRow: ({ control }: { control: ReactNode }) => control,
  SettingResetButton: "button",
}));
vi.mock("../ui/input", () => ({ Input: "input" }));
vi.mock("../ui/button", () => ({ Button: "button" }));

import { BranchPrefixSetting } from "./BranchPrefixSetting";

let renderer: ReactTestRenderer | null = null;
function render() {
  act(() => {
    if (renderer) renderer.update(<BranchPrefixSetting />);
    else renderer = create(<BranchPrefixSetting />);
  });
}
function edit(value: string) {
  act(() => renderer!.root.findByType("input").props.onChange({ target: { value } }));
}
async function submit() {
  await act(async () => renderer!.root.findByType("form").props.onSubmit({ preventDefault() {} }));
}
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  state.prefix = "dispatch/";
  state.search = { machine: "one" };
  state.mixed = false;
  state.supported = true;
  state.projectScope = false;
  state.update.mockReset().mockImplementation(async (patch) => {
    state.prefix = patch.branchPrefix;
    return true;
  });
  state.clear.mockReset().mockResolvedValue(true);
});
afterEach(async () => {
  await act(async () => renderer?.unmount());
  renderer = null;
  vi.unstubAllGlobals();
});

describe("branch prefix editing", () => {
  it("can pin an inherited value as a project override", async () => {
    state.projectScope = true;
    render();
    edit("dispatch/");
    await submit();
    expect(state.update).toHaveBeenCalledWith({ branchPrefix: "dispatch/" });
  });
  it("preserves case and nesting, shows the normalized example, and saves one trailing slash", async () => {
    render();
    edit("  Luna/Tasks  ");
    expect(
      renderer!.root
        .findAllByType("span")
        .some((span) => span.children.includes("Example: Luna/Tasks/fix-login")),
    ).toBe(true);
    await submit();
    expect(state.prefix).toBe("Luna/Tasks/");
  });

  it("keeps the draft through an optimistic settings update and rollback after failed save", async () => {
    state.update.mockResolvedValue(false);
    render();
    edit("Luna/Work");
    state.prefix = "Luna/Work/";
    render();
    expect(renderer!.root.findByType("input").props.value).toBe("Luna/Work");
    state.prefix = "dispatch/";
    render();
    await submit();
    expect(renderer!.root.findByType("input").props.value).toBe("Luna/Work");
    expect(renderer!.root.findByType("button").props.disabled).toBe(false);
  });

  it("treats an explicitly empty mixed edit as no prefix, then resets the draft when scope changes", async () => {
    state.mixed = true;
    render();
    expect(renderer!.root.findByType("button").props.disabled).toBe(true);
    edit("");
    expect(renderer!.root.findByType("button").props.disabled).toBe(false);
    await submit();
    expect(state.update).toHaveBeenCalledWith({ branchPrefix: "" });
    edit("Unfinished/");
    state.search = { machine: "two" };
    state.prefix = "Other/";
    state.mixed = false;
    render();
    expect(renderer!.root.findByType("input").props.value).toBe("Other/");
  });

  it("blocks invalid prefixes and old environments without discarding the draft", async () => {
    render();
    edit("bad..prefix/");
    await submit();
    expect(state.update).not.toHaveBeenCalled();
    expect(renderer!.root.findByProps({ role: "alert" })).toBeDefined();
    edit("Luna/");
    state.supported = false;
    render();
    await submit();
    expect(state.update).not.toHaveBeenCalled();
    expect(renderer!.root.findByType("input").props.value).toBe("Luna/");
    expect(renderer!.root.findByType("input").props.disabled).toBe(true);
  });
});

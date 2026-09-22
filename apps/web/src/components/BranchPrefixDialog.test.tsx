import { DEFAULT_SERVER_SETTINGS, EnvironmentId, ProjectId } from "@dispatch/contracts";
import { act, type ReactNode } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import type { ResolvedSettingsScope } from "./settings/settingsScope";

const state = vi.hoisted(() => ({
  environmentPrefix: "dispatch/",
  projectPrefix: undefined as string | undefined,
  branchSupported: true as boolean | undefined,
  projectSupported: true,
  connected: true,
  projectAvailable: true,
  save: vi.fn<
    (scope: ResolvedSettingsScope, patch: { branchPrefix: string }) => Promise<boolean>
  >(),
  clear: vi.fn<(scope: ResolvedSettingsScope, keys: readonly string[]) => Promise<boolean>>(),
  close: vi.fn(),
}));

const environmentId = EnvironmentId.make("environment-test");
const projectId = ProjectId.make("project-test");

function environment() {
  return {
    environmentId,
    label: "Laptop",
    connection: { phase: state.connected ? "connected" : "offline" },
    serverConfig: {
      settings: {
        ...DEFAULT_SERVER_SETTINGS,
        branchPrefix: state.environmentPrefix,
        projectSettingsOverrides:
          state.projectPrefix === undefined
            ? {}
            : { [projectId]: { branchPrefix: state.projectPrefix } },
      },
      environment: {
        capabilities: {
          branchPrefixSettings: state.branchSupported,
          projectSettingsOverrides: state.projectSupported,
        },
      },
    },
  };
}

vi.mock("@tanstack/react-router", () => ({ useNavigate: () => vi.fn() }));
vi.mock("../state/environments", () => ({
  useEnvironment: () => environment(),
  useEnvironments: () => ({ environments: [environment()] }),
  usePrimaryEnvironmentId: () => environmentId,
}));
vi.mock("./settings/useSettingsProjectGroups", () => ({
  useSettingsProjectGroups: () =>
    state.projectAvailable
      ? [
          {
            projectKey: "logical-project",
            displayName: "Dispatch",
            memberProjects: [
              {
                id: projectId,
                environmentId,
                workspaceRoot: "/repo",
                physicalProjectKey: "physical-project",
              },
            ],
          },
        ]
      : [],
}));
vi.mock("./settings/useScopedSettings", async () => {
  const { useSettingsScope } = await import("./settings/SettingsScopeContext");
  return {
    useUpdateScopedSettings: () => {
      const { scope } = useSettingsScope();
      return (patch: { branchPrefix: string }) => state.save(scope, patch);
    },
    useClearScopedSettings: () => {
      const { scope } = useSettingsScope();
      return (keys: readonly string[]) => state.clear(scope, keys);
    },
  };
});
vi.mock("./ui/dialog", () => ({
  Dialog: ({
    children,
    onOpenChange,
  }: {
    children: ReactNode;
    onOpenChange: (open: boolean) => void;
  }) => (
    <div
      data-testid="dialog"
      onKeyDown={(event) => {
        if (event.key === "Escape") onOpenChange(false);
      }}
    >
      {children}
    </div>
  ),
  DialogPopup: "section",
  DialogHeader: "header",
  DialogTitle: "h2",
  DialogDescription: "p",
  DialogPanel: "div",
  DialogFooter: "footer",
}));
vi.mock("./ui/select", () => ({
  Select: ({
    children,
    value,
    onValueChange,
    disabled,
  }: {
    children: ReactNode;
    value: string;
    onValueChange: (value: string) => void;
    disabled: boolean;
  }) => (
    <select
      value={value}
      disabled={disabled}
      onChange={(event) => onValueChange(event.target.value)}
    >
      {children}
    </select>
  ),
  SelectTrigger: "div",
  SelectValue: "span",
  SelectPopup: "div",
  SelectItem: "option",
}));
vi.mock("./ui/input", () => ({ Input: "input" }));
vi.mock("./ui/button", () => ({ Button: "button" }));

import { BranchPrefixDialog } from "./BranchPrefixDialog";

let renderer: ReactTestRenderer | null = null;
function deferredWrite() {
  let resolve!: (value: boolean) => void;
  const promise = new Promise<boolean>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}
function render() {
  act(() => {
    const dialog = (
      <BranchPrefixDialog
        environmentId={environmentId}
        projectId={projectId}
        onClose={state.close}
      />
    );
    if (renderer) renderer.update(dialog);
    else renderer = create(dialog);
  });
}
function input() {
  return renderer!.root.findByType("input");
}
function button(label: string) {
  return renderer!.root
    .findAllByType("button")
    .find((candidate) => candidate.children.includes(label))!;
}
function click(label: string) {
  act(() => {
    const target = button(label);
    if (!target.props.disabled) target.props.onClick();
  });
}
function edit(value: string) {
  act(() => input().props.onChange({ target: { value } }));
}
function changeScope(value: string) {
  act(() => renderer!.root.findByType("select").props.onChange({ target: { value } }));
}
function submitForm(): Promise<void> {
  return renderer!.root.findByType("form").props.onSubmit({ preventDefault() {} });
}
async function submit() {
  await act(async () => {
    await submitForm();
  });
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  state.environmentPrefix = "dispatch/";
  state.projectPrefix = undefined;
  state.branchSupported = true;
  state.projectSupported = true;
  state.connected = true;
  state.projectAvailable = true;
  state.close.mockReset();
  state.save.mockReset().mockImplementation(async (scope, patch) => {
    if (scope.kind === "checkout") state.projectPrefix = patch.branchPrefix;
    else if (scope.kind === "environment") state.environmentPrefix = patch.branchPrefix;
    return true;
  });
  state.clear.mockReset().mockImplementation(async () => {
    state.projectPrefix = undefined;
    return true;
  });
});
afterEach(async () => {
  await act(async () => renderer?.unmount());
  renderer = null;
  vi.unstubAllGlobals();
});

describe("branch prefix dialog", () => {
  it("retains a draft through an optimistic failed save, then closes only after a successful retry", async () => {
    const write = deferredWrite();
    state.save.mockImplementationOnce((_scope, patch) => {
      state.projectPrefix = patch.branchPrefix;
      return write.promise;
    });
    render();
    edit("  Luna/Tasks  ");
    let submission: Promise<void> | undefined;
    await act(async () => {
      submission = submitForm();
    });
    expect(input().props.value).toBe("  Luna/Tasks  ");
    expect(state.close).not.toHaveBeenCalled();
    state.projectPrefix = undefined;
    render();
    await act(async () => {
      write.resolve(false);
      await submission;
    });
    expect(input().props.value).toBe("  Luna/Tasks  ");
    expect(button("Save").props.disabled).toBe(false);
    expect(state.close).not.toHaveBeenCalled();
    await submit();
    expect(state.projectPrefix).toBe("Luna/Tasks/");
    expect(state.save).toHaveBeenLastCalledWith(
      expect.objectContaining({
        kind: "checkout",
        environmentId,
        members: [
          expect.objectContaining({
            id: projectId,
            environmentId,
            physicalProjectKey: "physical-project",
          }),
        ],
      }),
      { branchPrefix: "Luna/Tasks/" },
    );
    expect(state.close).toHaveBeenCalledOnce();
  });

  it("changes scopes without saving and replaces each unsaved draft with the selected saved value", () => {
    state.projectPrefix = "Project/";
    state.environmentPrefix = "Team/";
    render();
    edit("Unfinished-project/");
    changeScope("environment");
    expect(input().props.value).toBe("Team/");
    edit("Unfinished-environment/");
    changeScope("project");
    expect(input().props.value).toBe("Project/");
    expect(state.save).not.toHaveBeenCalled();
    expect(state.clear).not.toHaveBeenCalled();
    expect(state.close).not.toHaveBeenCalled();
  });

  it("stages inheritance without a write and Cancel discards it", () => {
    state.projectPrefix = "Project/";
    state.environmentPrefix = "Team/";
    render();
    click("Use environment default");
    expect(input().props.value).toBe("Team/");
    expect(state.clear).not.toHaveBeenCalled();
    click("Cancel");
    expect(state.projectPrefix).toBe("Project/");
    expect(state.save).not.toHaveBeenCalled();
    expect(state.clear).not.toHaveBeenCalled();
    expect(state.close).toHaveBeenCalledOnce();
  });

  it("retains a failed inheritance reset for retry and clears the override only on Save", async () => {
    state.projectPrefix = "Project/";
    state.environmentPrefix = "Team/";
    state.clear.mockResolvedValueOnce(false);
    render();
    click("Use environment default");
    await submit();
    expect(state.close).not.toHaveBeenCalled();
    expect(state.projectPrefix).toBe("Project/");
    expect(input().props.value).toBe("Team/");
    await submit();
    expect(state.clear).toHaveBeenLastCalledWith(
      expect.objectContaining({ kind: "checkout", environmentId }),
      ["branchPrefix"],
    );
    expect(state.projectPrefix).toBeUndefined();
    expect(state.environmentPrefix).toBe("Team/");
    expect(state.save).not.toHaveBeenCalled();
    expect(state.close).toHaveBeenCalledOnce();
  });

  it("starts at dispatch/ and saves an empty prefix as an explicit project override", async () => {
    render();
    expect(input().props.value).toBe("dispatch/");
    edit("");
    await submit();
    expect(state.projectPrefix).toBe("");
    expect(state.environmentPrefix).toBe("dispatch/");
    expect(state.save).toHaveBeenCalledWith(expect.objectContaining({ kind: "checkout" }), {
      branchPrefix: "",
    });
    expect(state.clear).not.toHaveBeenCalled();
    expect(state.close).toHaveBeenCalledOnce();
  });

  it("stages the environment reset to dispatch/ and preserves project overrides when saved", async () => {
    state.projectPrefix = "Project/";
    state.environmentPrefix = "Team/";
    render();
    changeScope("environment");
    click("Reset to dispatch/");
    expect(input().props.value).toBe("dispatch/");
    expect(state.environmentPrefix).toBe("Team/");
    expect(state.save).not.toHaveBeenCalled();
    await submit();
    expect(state.environmentPrefix).toBe("dispatch/");
    expect(state.projectPrefix).toBe("Project/");
    expect(state.clear).not.toHaveBeenCalled();
    expect(state.close).toHaveBeenCalledOnce();
  });

  it("blocks target changes, dismissal, cancel, and duplicate submission while a write is pending", async () => {
    const write = deferredWrite();
    state.save.mockReturnValueOnce(write.promise);
    render();
    edit("Pending/");
    let submission: Promise<void> | undefined;
    await act(async () => {
      submission = submitForm();
    });
    expect(input().props.disabled).toBe(true);
    expect(renderer!.root.findByType("select").props.disabled).toBe(true);
    expect(renderer!.root.findByType("section").props.showCloseButton).toBe(false);
    expect(button("Cancel").props.disabled).toBe(true);
    changeScope("environment");
    expect(renderer!.root.findByType("select").props.value).toBe("project");
    act(() =>
      renderer!.root.findByProps({ "data-testid": "dialog" }).props.onKeyDown({ key: "Escape" }),
    );
    click("Cancel");
    await submit();
    expect(state.close).not.toHaveBeenCalled();
    expect(state.save).toHaveBeenCalledOnce();
    await act(async () => {
      write.resolve(true);
      await submission;
    });
    expect(state.close).toHaveBeenCalledOnce();
  });

  it.each([
    ["unsupported prefix", { branchSupported: false }],
    ["unadvertised prefix", { branchSupported: undefined }],
    ["unsupported project overrides", { projectSupported: false }],
    ["offline environment", { connected: false }],
    ["removed project", { projectAvailable: false }],
  ])("blocks saves and reset for %s", async (_label, unavailable) => {
    state.projectPrefix = "Project/";
    render();
    edit("Draft/");
    Object.assign(state, unavailable);
    render();
    expect(input().props.disabled).toBe(true);
    expect(button("Save").props.disabled).toBe(true);
    const reset = renderer!.root
      .findAllByType("button")
      .find((candidate) => candidate.children.includes("Use environment default"));
    if (reset) expect(reset.props.disabled).toBe(true);
    await submit();
    expect(state.save).not.toHaveBeenCalled();
    expect(state.clear).not.toHaveBeenCalled();
    expect(state.close).not.toHaveBeenCalled();
  });

  it("rejects invalid prefix input and allows a corrected value without discarding it", async () => {
    render();
    edit("bad..prefix/");
    await submit();
    expect(renderer!.root.findByProps({ role: "alert" })).toBeDefined();
    expect(state.save).not.toHaveBeenCalled();
    expect(state.close).not.toHaveBeenCalled();
    edit("Good/Nested/");
    await submit();
    expect(state.projectPrefix).toBe("Good/Nested/");
    expect(state.close).toHaveBeenCalledOnce();
  });
});

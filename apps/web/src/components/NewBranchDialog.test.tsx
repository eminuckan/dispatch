import { act, type ReactNode } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

vi.mock("./ui/dialog", () => ({
  Dialog: ({ children }: { children: ReactNode }) => children,
  DialogPopup: "section",
  DialogHeader: "header",
  DialogTitle: "h2",
  DialogDescription: "p",
  DialogPanel: "div",
  DialogFooter: "footer",
}));
vi.mock("./ui/input", () => ({ Input: "input" }));
vi.mock("./ui/button", () => ({ Button: "button" }));

import { NewBranchDialog } from "./NewBranchDialog";

let renderer: ReactTestRenderer | null = null;
beforeEach(() => vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true));
afterEach(async () => {
  await act(async () => renderer?.unmount());
  renderer = null;
  vi.unstubAllGlobals();
});

function edit(value: string) {
  act(() => renderer!.root.findByType("input").props.onChange({ target: { value } }));
}
async function submit() {
  await act(async () => renderer!.root.findByType("form").props.onSubmit({ preventDefault() {} }));
}

describe("new branch draft", () => {
  it("prefills once, keeps a custom name through a settings refresh and failed creation, then retries exactly that name", async () => {
    const onCreate = vi
      .fn<(name: string) => Promise<string | null>>()
      .mockResolvedValueOnce("Branch already exists")
      .mockResolvedValueOnce(null);
    const onClose = vi.fn();
    act(() => {
      renderer = create(
        <NewBranchDialog initialName="Luna/Tasks/" onCreate={onCreate} onClose={onClose} />,
      );
    });
    expect(renderer!.root.findByType("input").props.value).toBe("Luna/Tasks/");
    await submit();
    expect(onCreate).not.toHaveBeenCalled();
    edit("Fix/My-task");
    act(() => {
      renderer!.update(
        <NewBranchDialog initialName="dispatch/" onCreate={onCreate} onClose={onClose} />,
      );
    });
    expect(renderer!.root.findByType("input").props.value).toBe("Fix/My-task");
    await submit();
    expect(onCreate).toHaveBeenLastCalledWith("Fix/My-task");
    expect(onClose).not.toHaveBeenCalled();
    expect(renderer!.root.findByProps({ role: "alert" }).children).toEqual([
      "Branch already exists",
    ]);
    expect(renderer!.root.findByType("input").props.value).toBe("Fix/My-task");
    edit("Fix/Other-task");
    await submit();
    expect(onCreate).toHaveBeenLastCalledWith("Fix/Other-task");
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("starts empty when prefix is disabled and keeps existing whitespace-to-hyphen branch creation behavior", async () => {
    const onCreate = vi.fn<(name: string) => Promise<string | null>>().mockResolvedValue(null);
    act(() => {
      renderer = create(<NewBranchDialog initialName="" onCreate={onCreate} onClose={() => {}} />);
    });
    expect(renderer!.root.findByType("input").props.value).toBe("");
    await submit();
    expect(onCreate).not.toHaveBeenCalled();
    edit("  Team/My task  ");
    await submit();
    expect(onCreate).toHaveBeenCalledWith("Team/My-task");
  });
});

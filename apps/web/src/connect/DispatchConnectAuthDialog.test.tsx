import { act, type ReactNode } from "react";
import { create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const auth = vi.hoisted(() => ({
  signIn: vi.fn(),
  signUp: vi.fn(),
}));

vi.mock("./authClient", () => ({
  getDispatchConnectAuthClient: () => ({
    signIn: { email: auth.signIn },
    signUp: { email: auth.signUp },
  }),
}));

vi.mock("../components/ui/button", () => ({ Button: "button" }));
vi.mock("../components/ui/input", () => ({ Input: "input" }));
vi.mock("../components/ui/spinner", () => ({ Spinner: "spinner" }));
vi.mock("../components/ui/dialog", () => ({
  Dialog: ({
    children,
    open,
    onOpenChange,
  }: {
    readonly children: ReactNode;
    readonly open: boolean;
    readonly onOpenChange: (open: boolean) => void;
  }) => (
    <div data-dialog-root data-open={open}>
      <button data-dialog-close-control onClick={() => onOpenChange(false)} />
      {children}
    </div>
  ),
  DialogClose: ({ children }: { readonly children: ReactNode }) => <button>{children}</button>,
  DialogDescription: "p",
  DialogFooter: "footer",
  DialogHeader: "header",
  DialogPanel: "section",
  DialogPopup: "dialog-popup",
  DialogTitle: "h2",
}));

import { DispatchConnectAuthDialog } from "./DispatchConnectAuthDialog";

let renderer: ReactTestRenderer | null = null;

function textOf(node: ReactTestInstance): string {
  return node.children.map((child) => (typeof child === "string" ? child : textOf(child))).join("");
}

function button(label: string): ReactTestInstance {
  const match = renderer!.root
    .findAllByType("button")
    .find((candidate) => textOf(candidate).trim() === label);
  if (!match) throw new Error(`Button not found: ${label}`);
  return match;
}

function input(name: "email" | "password"): ReactTestInstance {
  return renderer!.root.findAllByType("input").find((candidate) => candidate.props.name === name)!;
}

function form(): ReactTestInstance {
  return renderer!.root.findByType("form");
}

async function flush() {
  await Promise.resolve();
  await Promise.resolve();
}

function renderDialog(onAuthenticated = vi.fn()) {
  act(() => {
    renderer = create(
      <DispatchConnectAuthDialog onAuthenticated={onAuthenticated}>
        {({ openSignIn }) => <button onClick={openSignIn}>Open</button>}
      </DispatchConnectAuthDialog>,
    );
  });
  act(() => button("Open").props.onClick());
  return onAuthenticated;
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  auth.signIn.mockReset();
  auth.signUp.mockReset();
});

afterEach(async () => {
  await act(async () => renderer?.unmount());
  renderer = null;
  vi.unstubAllGlobals();
});

describe("DispatchConnectAuthDialog", () => {
  it("switches to account creation without dropping email and submits through the shared client", async () => {
    auth.signUp.mockResolvedValue({ error: null });
    const onAuthenticated = renderDialog();

    act(() => {
      input("email").props.onChange({ target: { value: "person@example.com" } });
      input("password").props.onChange({ target: { value: "secret-pass" } });
    });
    act(() => button("Create account").props.onClick());

    expect(input("email").props.value).toBe("person@example.com");
    expect(input("password").props.value).toBe("secret-pass");
    expect(input("password").props.autoComplete).toBe("new-password");

    await act(async () => {
      form().props.onSubmit({ preventDefault() {} });
      await flush();
    });

    expect(auth.signUp).toHaveBeenCalledWith({
      email: "person@example.com",
      password: "secret-pass",
      name: "person@example.com",
    });
    expect(auth.signIn).not.toHaveBeenCalled();
    expect(onAuthenticated).toHaveBeenCalledTimes(1);
    expect(input("password").props.value).toBe("");
  });

  it("clears only the password when the dialog closes", () => {
    renderDialog();
    act(() => {
      input("email").props.onChange({ target: { value: "person@example.com" } });
      input("password").props.onChange({ target: { value: "do-not-retain" } });
    });

    act(() => renderer!.root.findByProps({ "data-dialog-close-control": true }).props.onClick());

    expect(input("email").props.value).toBe("person@example.com");
    expect(input("password").props.value).toBe("");
  });

  it("blocks duplicate submits and turns fetch failures into a useful retryable error", async () => {
    let reject!: (error: Error) => void;
    auth.signIn.mockReturnValue(
      new Promise((_, rejectPromise) => {
        reject = rejectPromise;
      }),
    );
    renderDialog();
    act(() => {
      input("email").props.onChange({ target: { value: "person@example.com" } });
      input("password").props.onChange({ target: { value: "secret-pass" } });
    });
    act(() => {
      form().props.onSubmit({ preventDefault() {} });
      form().props.onSubmit({ preventDefault() {} });
    });

    expect(auth.signIn).toHaveBeenCalledTimes(1);

    await act(async () => {
      reject(new Error("Failed to fetch"));
      await flush();
    });

    const alert = renderer!.root.find((node) => node.props.role === "alert");
    expect(textOf(alert)).toContain("Could not reach Dispatch Connect");
  });
});

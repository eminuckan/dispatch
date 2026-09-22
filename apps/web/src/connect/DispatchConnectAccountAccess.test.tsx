import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  token: "account-token" as string | null,
  listeners: new Set<() => void>(),
  session: {
    data: {
      user: {
        name: "Dispatch User",
        email: "user@example.com",
        image: "https://example.com/avatar.png",
      },
    } as { user: { name: string; email: string; image: string | null } } | null,
    isPending: false,
    error: null as Error | null,
  },
  refetch: vi.fn(),
  signOut: vi.fn(),
  clear: vi.fn(),
}));

vi.mock("./authClient", () => ({
  getDispatchConnectAuthClient: () => ({
    useSession: () => ({ ...state.session, refetch: state.refetch }),
    signOut: state.signOut,
  }),
}));

vi.mock("./dispatchConnect", () => ({
  resolveDispatchConnectUrl: () => "https://connect.dispatch.test",
}));

vi.mock("./accountToken", () => ({
  readDispatchConnectAccountToken: () => state.token,
  subscribeDispatchConnectAccountToken: (_baseUrl: string, listener: () => void) => {
    state.listeners.add(listener);
    return () => state.listeners.delete(listener);
  },
  clearDispatchConnectAccountToken: (baseUrl: string) => {
    state.clear(baseUrl);
    state.token = null;
    for (const listener of state.listeners) listener();
  },
}));

import {
  DispatchConnectAccountAccess,
  type DispatchConnectAccountView,
} from "./DispatchConnectAccountAccess";

let renderer: ReactTestRenderer | null = null;
let latest: DispatchConnectAccountView | null = null;
let peerLatest: DispatchConnectAccountView | null = null;

function renderAccess({ withPeer = false }: { readonly withPeer?: boolean } = {}) {
  act(() => {
    renderer = create(
      <>
        <DispatchConnectAccountAccess>
          {(account) => {
            latest = account;
            return <span />;
          }}
        </DispatchConnectAccountAccess>
        {withPeer ? (
          <DispatchConnectAccountAccess>
            {(account) => {
              peerLatest = account;
              return <span />;
            }}
          </DispatchConnectAccountAccess>
        ) : null}
      </>,
    );
  });
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  state.token = "account-token";
  state.listeners.clear();
  state.session.data = {
    user: {
      name: "Dispatch User",
      email: "user@example.com",
      image: "https://example.com/avatar.png",
    },
  };
  state.session.isPending = false;
  state.session.error = null;
  state.refetch.mockReset().mockResolvedValue(undefined);
  state.signOut.mockReset();
  state.clear.mockReset();
  latest = null;
  peerLatest = null;
});

afterEach(async () => {
  await act(async () => renderer?.unmount());
  renderer = null;
  vi.unstubAllGlobals();
});

describe("DispatchConnectAccountAccess", () => {
  it("clears the bearer token across account subscribers only after successful sign out", async () => {
    state.signOut.mockResolvedValue({ error: null });
    renderAccess({ withPeer: true });

    expect(latest?.signedIn).toBe(true);
    expect(peerLatest?.signedIn).toBe(true);
    expect(latest?.user).toEqual({
      name: "Dispatch User",
      email: "user@example.com",
      image: "https://example.com/avatar.png",
    });

    await act(async () => {
      await latest!.signOut();
    });

    expect(state.signOut).toHaveBeenCalledTimes(1);
    expect(state.clear).toHaveBeenCalledWith("https://connect.dispatch.test");
    expect(state.refetch).toHaveBeenCalledTimes(1);
    expect(latest?.accountToken).toBeNull();
    expect(latest?.signedIn).toBe(false);
    expect(peerLatest?.accountToken).toBeNull();
    expect(peerLatest?.signedIn).toBe(false);
  });

  it("keeps the authenticated account state when sign out fails", async () => {
    state.signOut.mockRejectedValue(new Error("Failed to fetch"));
    renderAccess();

    expect(latest?.signedIn).toBe(true);
    await act(async () => {
      await latest!.signOut();
    });

    expect(state.clear).not.toHaveBeenCalled();
    expect(state.refetch).not.toHaveBeenCalled();
    expect(latest?.accountToken).toBe("account-token");
    expect(latest?.signedIn).toBe(true);
    expect(latest?.error).toContain("Could not reach Dispatch Connect");
  });

  it.each([
    ["a pending session refresh", true, null],
    ["a session fetch error", false, new Error("Failed to fetch")],
  ])(
    "does not report signed in from cached session and token during %s",
    (_label, isPending, error) => {
      state.session.isPending = isPending;
      state.session.error = error;
      renderAccess();

      expect(latest?.signedIn).toBe(false);
      expect(latest?.accountToken).toBe("account-token");
      expect(latest?.user?.email).toBe("user@example.com");
    },
  );

  it("surfaces session fetch failures and retries the shared session", () => {
    state.session.data = null;
    state.session.error = new Error("Failed to fetch");
    renderAccess();

    expect(latest?.error).toContain("Could not reach Dispatch Connect");
    act(() => latest!.refresh());
    expect(state.refetch).toHaveBeenCalledTimes(1);
  });
});

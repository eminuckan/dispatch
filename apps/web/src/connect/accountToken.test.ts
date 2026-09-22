import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import {
  clearDispatchConnectAccountToken,
  readDispatchConnectAccountToken,
  storeDispatchConnectAccountToken,
  subscribeDispatchConnectAccountToken,
} from "./accountToken";

function createStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() {
      return values.size;
    },
    clear() {
      values.clear();
    },
    getItem(key) {
      return values.get(key) ?? null;
    },
    key(index) {
      return [...values.keys()][index] ?? null;
    },
    removeItem(key) {
      values.delete(key);
    },
    setItem(key, value) {
      values.set(key, value);
    },
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Dispatch Connect account token lifecycle", () => {
  it("notifies Flow session sync only when the stored credential actually changes", () => {
    const browser = Object.assign(new EventTarget(), { localStorage: createStorage() });
    vi.stubGlobal("window", browser);
    const listener = vi.fn();
    const unsubscribe = subscribeDispatchConnectAccountToken(
      "https://connect.dispatch.test/",
      listener,
    );

    storeDispatchConnectAccountToken("https://connect.dispatch.test", " token-one ");
    expect(readDispatchConnectAccountToken("https://connect.dispatch.test")).toBe("token-one");
    expect(listener).toHaveBeenCalledTimes(1);

    storeDispatchConnectAccountToken("https://connect.dispatch.test", "token-one");
    expect(listener).toHaveBeenCalledTimes(1);

    storeDispatchConnectAccountToken("https://connect.dispatch.test", "token-two");
    expect(listener).toHaveBeenCalledTimes(2);

    clearDispatchConnectAccountToken("https://connect.dispatch.test");
    expect(readDispatchConnectAccountToken("https://connect.dispatch.test")).toBeNull();
    expect(listener).toHaveBeenCalledTimes(3);

    clearDispatchConnectAccountToken("https://connect.dispatch.test");
    expect(listener).toHaveBeenCalledTimes(3);

    unsubscribe();
    storeDispatchConnectAccountToken("https://connect.dispatch.test", "token-three");
    expect(listener).toHaveBeenCalledTimes(3);
  });
});

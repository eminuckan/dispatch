import { describe, expect, it, vi } from "vite-plus/test";

import { createMemoryStorage, readMigratedStorageItem, writeMigratedStorageItem } from "./storage";

describe("Dispatch storage migration", () => {
  it("adopts a legacy t3code value and removes it after the canonical write", () => {
    const storage = createMemoryStorage();
    storage.setItem("t3code:client-settings:v1", "legacy-value");

    expect(readMigratedStorageItem(storage, "dispatch:client-settings:v1")).toBe("legacy-value");
    expect(storage.getItem("dispatch:client-settings:v1")).toBe("legacy-value");
    expect(storage.getItem("t3code:client-settings:v1")).toBeNull();
  });

  it("keeps legacy state when the canonical write fails", () => {
    const values = new Map([["t3code:theme", "grove"]]);
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: vi.fn((key: string, value: string) => {
        if (key === "dispatch:theme") throw new Error("storage unavailable");
        values.set(key, value);
      }),
      removeItem: vi.fn((key: string) => values.delete(key)),
    };

    expect(readMigratedStorageItem(storage, "dispatch:theme")).toBe("grove");
    expect(values.get("t3code:theme")).toBe("grove");
    expect(values.has("dispatch:theme")).toBe(false);
    expect(storage.removeItem).not.toHaveBeenCalled();
  });

  it("canonical writes win and clear stale legacy input", () => {
    const storage = createMemoryStorage();
    storage.setItem("t3code.diffFileTreeOpen", "false");

    writeMigratedStorageItem(storage, "dispatch.diffFileTreeOpen", "true");

    expect(storage.getItem("dispatch.diffFileTreeOpen")).toBe("true");
    expect(storage.getItem("t3code.diffFileTreeOpen")).toBeNull();
  });
});

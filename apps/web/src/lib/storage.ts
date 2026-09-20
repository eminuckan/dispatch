import { Debouncer } from "@tanstack/react-pacer";

export interface StateStorage<R = unknown> {
  getItem: (name: string) => string | null | Promise<string | null>;
  setItem: (name: string, value: string) => R;
  removeItem: (name: string) => R;
}

export interface SyncStateStorage<R = unknown> extends StateStorage<R> {
  getItem: (name: string) => string | null;
}

export interface DeferredStorage<TValue> {
  getItem: (name: string) => string | null | Promise<string | null>;
  setItem: (name: string, value: TValue) => void;
  removeItem: (name: string) => void;
  flush: () => void;
}

export function createMemoryStorage(): SyncStateStorage {
  const store = new Map<string, string>();
  return {
    getItem: (name) => store.get(name) ?? null,
    setItem: (name, value) => {
      store.set(name, value);
    },
    removeItem: (name) => {
      store.delete(name);
    },
  };
}

function isStateStorage(
  storage: Partial<StateStorage> | null | undefined,
): storage is StateStorage {
  return (
    storage !== null &&
    storage !== undefined &&
    typeof storage.getItem === "function" &&
    typeof storage.setItem === "function" &&
    typeof storage.removeItem === "function"
  );
}

export function resolveStorage(
  storage: Partial<StateStorage> | null | undefined,
): SyncStateStorage {
  return isStateStorage(storage) ? (storage as SyncStateStorage) : createMemoryStorage();
}

type SyncStorageLike = Pick<SyncStateStorage, "getItem" | "setItem" | "removeItem">;

export function legacyT3CodeStorageKey(canonicalKey: string): string | null {
  if (canonicalKey.startsWith("dispatch:")) {
    return `t3code:${canonicalKey.slice("dispatch:".length)}`;
  }
  if (canonicalKey.startsWith("dispatch.")) {
    return `t3code.${canonicalKey.slice("dispatch.".length)}`;
  }
  return null;
}

function legacyKeysFor(
  canonicalKey: string,
  additionalLegacyKeys: readonly string[] = [],
): readonly string[] {
  const derivedLegacyKey = legacyT3CodeStorageKey(canonicalKey);
  return [
    ...new Set([...(derivedLegacyKey === null ? [] : [derivedLegacyKey]), ...additionalLegacyKeys]),
  ];
}

/**
 * Reads the Dispatch key first, then adopts legacy T3 Code storage in place.
 * Legacy state is removed only after the canonical write succeeds.
 */
export function readMigratedStorageItem(
  storage: SyncStorageLike,
  canonicalKey: string,
  additionalLegacyKeys: readonly string[] = [],
): string | null {
  const canonicalValue = storage.getItem(canonicalKey);
  if (canonicalValue !== null) {
    for (const legacyKey of legacyKeysFor(canonicalKey, additionalLegacyKeys)) {
      try {
        storage.removeItem(legacyKey);
      } catch {
        // Canonical state is already available; stale compatibility input is harmless.
      }
    }
    return canonicalValue;
  }

  for (const legacyKey of legacyKeysFor(canonicalKey, additionalLegacyKeys)) {
    const legacyValue = storage.getItem(legacyKey);
    if (legacyValue === null) continue;
    try {
      storage.setItem(canonicalKey, legacyValue);
      try {
        storage.removeItem(legacyKey);
      } catch {
        // The canonical copy is durable; stale compatibility input is harmless.
      }
    } catch {
      // Keep serving the legacy value when canonical storage is temporarily unavailable.
    }
    return legacyValue;
  }
  return null;
}

export function writeMigratedStorageItem(
  storage: SyncStorageLike,
  canonicalKey: string,
  value: string,
  additionalLegacyKeys: readonly string[] = [],
): void {
  storage.setItem(canonicalKey, value);
  for (const legacyKey of legacyKeysFor(canonicalKey, additionalLegacyKeys)) {
    try {
      storage.removeItem(legacyKey);
    } catch {
      // Canonical state already won; legacy cleanup is best-effort.
    }
  }
}

export function removeMigratedStorageItem(
  storage: SyncStorageLike,
  canonicalKey: string,
  additionalLegacyKeys: readonly string[] = [],
): void {
  for (const legacyKey of legacyKeysFor(canonicalKey, additionalLegacyKeys)) {
    storage.removeItem(legacyKey);
  }
  storage.removeItem(canonicalKey);
}

export function createMigratingStorage(
  storage: SyncStorageLike,
  additionalLegacyKeysByCanonicalKey: Readonly<Record<string, readonly string[]>> = {},
): SyncStateStorage {
  return {
    getItem: (name) =>
      readMigratedStorageItem(storage, name, additionalLegacyKeysByCanonicalKey[name] ?? []),
    setItem: (name, value) =>
      writeMigratedStorageItem(
        storage,
        name,
        value,
        additionalLegacyKeysByCanonicalKey[name] ?? [],
      ),
    removeItem: (name) =>
      removeMigratedStorageItem(storage, name, additionalLegacyKeysByCanonicalKey[name] ?? []),
  };
}

/** Keep the latest value and serialize it when the debounce fires or `flush` runs. */
export function createDeferredStorage<TValue>(
  baseStorage: Partial<StateStorage> | null | undefined,
  serialize: (value: TValue) => string,
  debounceMs: number = 300,
): DeferredStorage<TValue> {
  const resolvedStorage = resolveStorage(baseStorage);
  const debouncedSetItem = new Debouncer(
    (name: string, value: TValue) => {
      resolvedStorage.setItem(name, serialize(value));
    },
    { wait: debounceMs },
  );

  return {
    getItem: (name) => resolvedStorage.getItem(name),
    setItem: (name, value) => {
      debouncedSetItem.maybeExecute(name, value);
    },
    removeItem: (name) => {
      debouncedSetItem.cancel();
      // cancel() leaves the captured value in Pacer's lastArgs.
      debouncedSetItem.reset();
      resolvedStorage.removeItem(name);
    },
    flush: () => {
      debouncedSetItem.flush();
    },
  };
}

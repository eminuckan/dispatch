import { EnvironmentId } from "@dispatch/contracts";
import * as Arr from "effect/Array";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import { pipe } from "effect/Function";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import {
  isRelayManagedConnection,
  type SavedRemoteConnection,
  toStableSavedRemoteConnection,
} from "../lib/connection";
import * as MobileSecureStorage from "./mobile-secure-storage";

const CONNECTIONS_KEY = "dispatch.connections";
const LEGACY_CONNECTIONS_KEY = "t3code.connections";
// The client activity reporter keeps its established ID across auth migrations.
const AGENT_AWARENESS_DEVICE_ID_KEY = "dispatch.agent-awareness.device-id";
const LEGACY_AGENT_AWARENESS_DEVICE_ID_KEY = "t3code.agent-awareness.device-id";
const RECENT_THREAD_SHORTCUTS_KEY = "dispatch.recent-thread-shortcuts";
const LEGACY_RECENT_THREAD_SHORTCUTS_KEY = "t3code.recent-thread-shortcuts";

export class MobileStorageDecodeError extends Schema.TaggedError<MobileStorageDecodeError>()(
  "MobileStorageDecodeError",
  {
    key: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to decode mobile storage value for key ${this.key}.`;
  }
}

export class MobileStorageEncodeError extends Schema.TaggedError<MobileStorageEncodeError>()(
  "MobileStorageEncodeError",
  {
    key: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to encode mobile storage value for key ${this.key}.`;
  }
}

export class MobileDeviceIdGenerationError extends Schema.TaggedError<MobileDeviceIdGenerationError>()(
  "MobileDeviceIdGenerationError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "Failed to generate the mobile client id.";
  }
}

export interface RecentThreadShortcut {
  readonly environmentId: string;
  readonly threadId: string;
  readonly title: string;
}

export class MobileStorage extends Context.Service<
  MobileStorage,
  {
    readonly loadSavedConnections: Effect.Effect<
      ReadonlyArray<SavedRemoteConnection>,
      MobileSecureStorage.MobileSecureStorageError
    >;
    readonly saveConnection: (
      connection: SavedRemoteConnection,
    ) => Effect.Effect<
      void,
      MobileSecureStorage.MobileSecureStorageError | MobileStorageEncodeError
    >;
    readonly clearSavedConnection: (
      environmentId: EnvironmentId,
    ) => Effect.Effect<
      void,
      MobileSecureStorage.MobileSecureStorageError | MobileStorageEncodeError
    >;
    readonly loadOrCreateMobileClientId: Effect.Effect<
      string,
      MobileSecureStorage.MobileSecureStorageError | MobileDeviceIdGenerationError
    >;
    readonly loadRecentThreadShortcuts: Effect.Effect<
      ReadonlyArray<RecentThreadShortcut>,
      MobileSecureStorage.MobileSecureStorageError
    >;
    readonly saveRecentThreadShortcuts: (
      threads: ReadonlyArray<RecentThreadShortcut>,
    ) => Effect.Effect<
      void,
      MobileSecureStorage.MobileSecureStorageError | MobileStorageEncodeError
    >;
  }
>()("@dispatch/mobile/persistence/MobileStorage") {}

export const make = Effect.fn("MobileStorage.make")(function* () {
  const secureStorage = yield* MobileSecureStorage.MobileSecureStorage;

  const migrateLegacyValue = Effect.fn("MobileStorage.migrateLegacyValue")(function* (
    key: string,
    legacyKey: string,
    value: string,
  ) {
    const writeResult = yield* Effect.result(secureStorage.setItem(key, value));
    if (writeResult._tag === "Failure") {
      yield* Effect.logWarning("Could not migrate legacy mobile storage value.").pipe(
        Effect.annotateLogs({ error: writeResult.failure, key, legacyKey }),
      );
      return;
    }
    yield* secureStorage
      .removeItem(legacyKey)
      .pipe(
        Effect.catch((error) =>
          Effect.logWarning("Could not remove migrated legacy mobile storage value.").pipe(
            Effect.annotateLogs({ error, key, legacyKey }),
          ),
        ),
      );
  });

  const parseJson = <A>(key: string, raw: string): A | null => {
    if (!raw.trim()) return null;
    try {
      return JSON.parse(raw) as A;
    } catch (cause) {
      console.warn(
        "[mobile-storage] ignored invalid JSON",
        new MobileStorageDecodeError({ key, cause }),
      );
      return null;
    }
  };

  const readJson = Effect.fn("MobileStorage.readJson")(function* <A>(
    key: string,
    legacyKey: string,
  ) {
    const raw = (yield* secureStorage.getItem(key)) ?? "";
    const parsed = parseJson<A>(key, raw);
    if (parsed !== null) return parsed;

    const legacyRaw = (yield* secureStorage.getItem(legacyKey)) ?? "";
    const legacyParsed = parseJson<A>(legacyKey, legacyRaw);
    if (legacyParsed === null) return null;
    yield* migrateLegacyValue(key, legacyKey, legacyRaw);
    return legacyParsed;
  });

  const readString = Effect.fn("MobileStorage.readString")(function* (
    key: string,
    legacyKey: string,
  ) {
    const current = yield* secureStorage.getItem(key);
    if (current?.trim()) return current;
    const legacy = yield* secureStorage.getItem(legacyKey);
    if (!legacy?.trim()) return null;
    yield* migrateLegacyValue(key, legacyKey, legacy);
    return legacy;
  });

  const writeJson = Effect.fn("MobileStorage.writeJson")(function* (key: string, value: unknown) {
    const encoded = yield* Effect.try({
      try: () => JSON.stringify(value),
      catch: (cause) => new MobileStorageEncodeError({ key, cause }),
    });
    yield* secureStorage.setItem(key, encoded);
  });

  const loadSavedConnections = readJson<{
    readonly connections?: ReadonlyArray<SavedRemoteConnection>;
  }>(CONNECTIONS_KEY, LEGACY_CONNECTIONS_KEY).pipe(
    Effect.map((parsed) =>
      pipe(
        parsed?.connections ?? [],
        Arr.filter(
          (connection) =>
            !!connection.environmentId &&
            (!!connection.bearerToken?.trim() || isRelayManagedConnection(connection)),
        ),
      ),
    ),
  );

  const saveConnection = Effect.fn("MobileStorage.saveConnection")(function* (
    connection: SavedRemoteConnection,
  ) {
    const current = yield* loadSavedConnections;
    const stableConnection = toStableSavedRemoteConnection(connection);
    const next = current.some((entry) => entry.environmentId === connection.environmentId)
      ? pipe(
          current,
          Arr.map((entry) =>
            entry.environmentId === connection.environmentId ? stableConnection : entry,
          ),
        )
      : pipe(current, Arr.append(stableConnection));
    yield* writeJson(CONNECTIONS_KEY, { connections: next });
  });

  const clearSavedConnection = Effect.fn("MobileStorage.clearSavedConnection")(function* (
    environmentId: EnvironmentId,
  ) {
    const current = yield* loadSavedConnections;
    const next = pipe(
      current,
      Arr.filter((entry) => entry.environmentId !== environmentId),
    );
    yield* writeJson(CONNECTIONS_KEY, { connections: next });
  });

  const loadOrCreateMobileClientId = Effect.gen(function* () {
    const existing = yield* readString(
      AGENT_AWARENESS_DEVICE_ID_KEY,
      LEGACY_AGENT_AWARENESS_DEVICE_ID_KEY,
    );
    if (existing !== null) return existing;
    const deviceId = yield* Effect.tryPromise({
      try: () => import("../lib/uuid").then(({ uuidv4 }) => uuidv4()),
      catch: (cause) => new MobileDeviceIdGenerationError({ cause }),
    });
    yield* secureStorage.setItem(AGENT_AWARENESS_DEVICE_ID_KEY, deviceId);
    return deviceId;
  });

  // Threads most recently opened on this device, newest first — the source
  // for the launcher's dynamic "recent thread" app shortcuts.
  const loadRecentThreadShortcuts = readJson<{
    readonly threads?: ReadonlyArray<RecentThreadShortcut>;
  }>(RECENT_THREAD_SHORTCUTS_KEY, LEGACY_RECENT_THREAD_SHORTCUTS_KEY).pipe(
    Effect.map((parsed) =>
      pipe(
        parsed?.threads ?? [],
        Arr.filter(
          (thread) =>
            typeof thread?.environmentId === "string" &&
            thread.environmentId.length > 0 &&
            typeof thread.threadId === "string" &&
            thread.threadId.length > 0 &&
            typeof thread.title === "string",
        ),
      ),
    ),
  );

  return MobileStorage.of({
    loadSavedConnections,
    saveConnection,
    clearSavedConnection,
    loadOrCreateMobileClientId,
    loadRecentThreadShortcuts,
    saveRecentThreadShortcuts: (threads) => writeJson(RECENT_THREAD_SHORTCUTS_KEY, { threads }),
  });
});

export const layer = Layer.effect(MobileStorage, make());

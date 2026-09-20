import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { beforeEach, vi } from "vite-plus/test";

const openDatabaseAsync = vi.hoisted(() => vi.fn());
const backupDatabaseAsync = vi.hoisted(() => vi.fn());
const deleteDatabaseAsync = vi.hoisted(() => vi.fn());
const databaseFiles = vi.hoisted(() => new Set<string>());

vi.mock("expo-sqlite", () => ({
  openDatabaseAsync,
  backupDatabaseAsync,
  deleteDatabaseAsync,
  defaultDatabaseDirectory: "file:///sqlite",
}));

vi.mock("expo-file-system", () => ({
  File: class MockFile {
    name: string;

    constructor(...parts: Array<unknown>) {
      this.name = String(parts.at(-1));
    }

    get exists() {
      return databaseFiles.has(this.name);
    }

    move(destination: { readonly name: string }) {
      databaseFiles.delete(this.name);
      databaseFiles.add(destination.name);
      this.name = destination.name;
      return Promise.resolve();
    }
  },
}));

import { decodeLegacyCacheRecord, make } from "./mobile-database";

function makeDatabase() {
  return {
    closeAsync: vi.fn(() => Promise.resolve()),
    execAsync: vi.fn(() => Promise.resolve()),
    withExclusiveTransactionAsync: vi.fn(
      (run: (transaction: { execAsync: () => Promise<void> }) => Promise<void>) =>
        run({ execAsync: () => Promise.resolve() }),
    ),
    getFirstAsync: vi.fn((sql: string) =>
      Promise.resolve(sql.includes("PRAGMA user_version") ? { user_version: 1 } : null),
    ),
    getAllAsync: vi.fn(() => Promise.resolve([])),
    runAsync: vi.fn(() => Promise.resolve()),
  };
}

describe("mobile database legacy cache migration", () => {
  beforeEach(() => {
    databaseFiles.clear();
    vi.clearAllMocks();
    backupDatabaseAsync.mockResolvedValue(undefined);
    deleteDatabaseAsync.mockImplementation((name: string) => {
      databaseFiles.delete(name);
      return Promise.resolve();
    });
  });

  it.effect("keeps acquisition failures typed on database operations", () =>
    Effect.scoped(
      Effect.gen(function* () {
        openDatabaseAsync.mockRejectedValueOnce(new Error("SQLite unavailable"));

        const database = yield* make;
        const result = yield* Effect.result(database.loadPreferencesJson);

        expect(result).toMatchObject({
          _tag: "Failure",
          failure: { _tag: "MobileDatabaseError", operation: "open" },
        });
      }),
    ),
  );

  it.effect("creates fresh databases under the Dispatch filename", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const database = makeDatabase();
        openDatabaseAsync.mockImplementation((name: string) => {
          databaseFiles.add(name);
          return Promise.resolve(database);
        });

        yield* make;

        expect(openDatabaseAsync).toHaveBeenCalledWith(
          "dispatch-client.db",
          undefined,
          "file:///sqlite",
        );
        expect(openDatabaseAsync).not.toHaveBeenCalledWith(
          "t3code-client.db",
          expect.anything(),
          expect.anything(),
        );
        expect(databaseFiles.has("dispatch-client.db")).toBe(true);
      }),
    ),
  );

  it.effect("backs up an existing T3 database before opening the Dispatch filename", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const legacyDatabase = makeDatabase();
        const migrationDatabase = makeDatabase();
        const canonicalDatabase = makeDatabase();
        databaseFiles.add("t3code-client.db");
        openDatabaseAsync.mockImplementation((name: string) => {
          databaseFiles.add(name);
          if (name === "t3code-client.db") return Promise.resolve(legacyDatabase);
          if (name === "dispatch-client.migration.db") return Promise.resolve(migrationDatabase);
          return Promise.resolve(canonicalDatabase);
        });

        yield* make;

        expect(backupDatabaseAsync).toHaveBeenCalledWith({
          sourceDatabase: legacyDatabase,
          destDatabase: migrationDatabase,
        });
        expect(databaseFiles.has("dispatch-client.db")).toBe(true);
        expect(databaseFiles.has("t3code-client.db")).toBe(true);
        expect(databaseFiles.has("dispatch-client.migration.db")).toBe(false);
        expect(migrationDatabase.closeAsync).toHaveBeenCalledTimes(1);
        expect(legacyDatabase.closeAsync).toHaveBeenCalledTimes(1);
      }),
    ),
  );

  it("maps legacy thread records to their SQLite identity", () => {
    const payload = JSON.stringify({
      schemaVersion: 2,
      environmentId: "environment-1",
      threadId: "thread-1",
      snapshot: {},
    });

    expect(decodeLegacyCacheRecord("connection-thread-snapshots", payload)).toEqual({
      environmentId: "environment-1",
      kind: "thread",
      cacheKey: "thread-1",
      schemaVersion: 2,
      payload,
    });
  });

  it("preserves the old shell payload for schema decoding after migration", () => {
    const payload = JSON.stringify({
      schemaVersion: 1,
      environmentId: "environment-1",
      snapshotReceivedAt: "2026-07-01T00:00:00.000Z",
      snapshot: {},
    });

    expect(decodeLegacyCacheRecord("shell-snapshots", payload)).toEqual({
      environmentId: "environment-1",
      kind: "shell",
      cacheKey: "snapshot",
      schemaVersion: 1,
      payload,
    });
  });

  it("skips malformed legacy records", () => {
    expect(decodeLegacyCacheRecord("connection-vcs-refs", "{not-json")).toBeNull();
    expect(
      decodeLegacyCacheRecord(
        "connection-vcs-refs",
        JSON.stringify({ schemaVersion: 1, environmentId: "environment-1" }),
      ),
    ).toBeNull();
  });
});

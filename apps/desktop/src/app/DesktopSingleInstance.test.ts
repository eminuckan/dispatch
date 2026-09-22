import * as NodePath from "@effect/platform-node/NodePath";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";

import type { BrowserWindow } from "electron";

import * as ElectronApp from "../electron/ElectronApp.ts";
import * as ElectronWindow from "../electron/ElectronWindow.ts";
import * as DesktopConfig from "./DesktopConfig.ts";
import * as DesktopEnvironment from "./DesktopEnvironment.ts";
import * as DesktopSingleInstance from "./DesktopSingleInstance.ts";

function fixture(options: { primary?: boolean; userData?: string; existingPath?: string } = {}) {
  const events: string[] = [];
  const listeners = new Map<string, () => void>();
  const app = {
    setPath: (name: string, value: string) =>
      Effect.sync(() => {
        events.push(`${name}:${value}`);
      }),
    requestSingleInstanceLock: Effect.sync(() => {
      events.push("lock");
      return options.primary ?? true;
    }),
    releaseSingleInstanceLock: Effect.sync(() => {
      events.push("release");
    }),
    quit: Effect.sync(() => {
      events.push("quit");
    }),
    on: (event: string, listener: () => void) =>
      Effect.acquireRelease(
        Effect.sync(() => {
          listeners.set(event, listener);
        }),
        () =>
          Effect.sync(() => {
            listeners.delete(event);
          }),
      ),
  } satisfies Pick<
    ElectronApp.ElectronApp["Service"],
    "setPath" | "requestSingleInstanceLock" | "releaseSingleInstanceLock" | "quit" | "on"
  >;
  const environment = DesktopEnvironment.layer({
    dirname: "/repo/apps/desktop/dist-electron",
    homeDirectory: "/Users/alice",
    platform: "darwin",
    processArch: "arm64",
    appVersion: "1.2.3",
    appPath: "/Applications/Dispatch.app/Contents/Resources/app.asar",
    isPackaged: true,
    resourcesPath: "/Applications/Dispatch.app/Contents/Resources",
    runningUnderArm64Translation: false,
  }).pipe(
    Layer.provide(
      Layer.mergeAll(
        NodeServices.layer,
        NodePath.layerPosix,
        DesktopConfig.layerTest(
          options.userData ? { DISPATCH_DESKTOP_USER_DATA_DIR: options.userData } : {},
        ),
      ),
    ),
  );
  const layer = DesktopSingleInstance.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        environment,
        Layer.succeed(ElectronApp.ElectronApp, app as ElectronApp.ElectronApp["Service"]),
        FileSystem.layerNoop({ exists: (path) => Effect.succeed(path === options.existingPath) }),
      ),
    ),
  );
  return { layer, events, listeners };
}

describe("DesktopSingleInstance", () => {
  it.effect("takes the lock in the isolated profile and releases it after shutdown", () =>
    Effect.gen(function* () {
      const test = fixture({ userData: "/isolated/profile" });
      yield* Effect.scoped(Layer.build(test.layer));
      assert.deepEqual(test.events, ["userData:/isolated/profile", "lock", "release"]);
    }),
  );

  it.effect("keeps an existing legacy profile before acquiring the lock", () =>
    Effect.gen(function* () {
      const path = "/Users/alice/Library/Application Support/t3-jev";
      const test = fixture({ existingPath: path });
      yield* Effect.scoped(Layer.build(test.layer));
      assert.deepEqual(test.events, [`userData:${path}`, "lock", "release"]);
    }),
  );

  it.effect("quits a secondary instance before application startup", () =>
    Effect.gen(function* () {
      const test = fixture({ primary: false, userData: "/isolated/profile" });
      const exit = yield* Effect.exit(
        Effect.scoped(
          Effect.gen(function* () {
            yield* Layer.build(test.layer);
            test.events.push("start backend");
          }),
        ),
      );
      assert.isTrue(Exit.hasInterrupts(exit));
      assert.deepEqual(test.events, ["userData:/isolated/profile", "lock", "quit"]);
    }),
  );

  it.effect(
    "reveals the primary window for a second launch and removes its listener on shutdown",
    () =>
      Effect.gen(function* () {
        const test = fixture({ userData: "/isolated/profile" });
        const revealed = yield* Deferred.make<void>();
        const window = { id: 1 } as BrowserWindow;
        const windows = {
          currentMainOrFirst: Effect.succeedSome(window),
          reveal: (current: BrowserWindow) =>
            Effect.gen(function* () {
              assert.strictEqual(current, window);
              yield* Deferred.succeed(revealed, undefined);
            }),
        } as ElectronWindow.ElectronWindow["Service"];
        yield* Effect.scoped(
          Effect.gen(function* () {
            const instance = yield* DesktopSingleInstance.DesktopSingleInstance;
            yield* instance.configure;
            test.listeners.get("second-instance")!();
            yield* Deferred.await(revealed);
          }).pipe(
            Effect.provide(test.layer),
            Effect.provideService(ElectronWindow.ElectronWindow, windows),
          ),
        );
        assert.equal(test.listeners.size, 0);
        assert.equal(test.events.at(-1), "release");
      }),
  );
});

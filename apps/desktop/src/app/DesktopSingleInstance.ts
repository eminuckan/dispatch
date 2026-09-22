import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Scope from "effect/Scope";

import * as ElectronApp from "../electron/ElectronApp.ts";
import * as ElectronWindow from "../electron/ElectronWindow.ts";
import * as DesktopAppIdentity from "./DesktopAppIdentity.ts";

export class DesktopSingleInstance extends Context.Service<
  DesktopSingleInstance,
  {
    readonly configure: Effect.Effect<void, never, ElectronWindow.ElectronWindow | Scope.Scope>;
  }
>()("@dispatch/desktop/app/DesktopSingleInstance") {}

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const app = yield* ElectronApp.ElectronApp;
  // The lock creates userData, so resolve legacy or isolated state before taking it.
  const userDataPath = yield* DesktopAppIdentity.resolveUserDataPath;
  yield* app.setPath("userData", userDataPath);
  const isPrimaryInstance = yield* Effect.acquireRelease(
    app.requestSingleInstanceLock,
    (acquired) => (acquired ? app.releaseSingleInstanceLock : Effect.void),
  );
  if (!isPrimaryInstance) {
    yield* app.quit;
    // quit is asynchronous; prevent the secondary instance from starting a backend.
    return yield* Effect.interrupt;
  }

  return DesktopSingleInstance.of({
    configure: Effect.gen(function* () {
      const window = yield* ElectronWindow.ElectronWindow;
      const reveal = window.currentMainOrFirst.pipe(
        Effect.flatMap((current) =>
          Option.isSome(current) ? window.reveal(current.value) : Effect.void,
        ),
      );
      const context = yield* Effect.context<never>();
      yield* app.on("second-instance", () => {
        void Effect.runPromiseWith(context)(reveal);
      });
    }).pipe(Effect.withSpan("desktop.singleInstance.configure")),
  });
});

export const layer = Layer.effect(DesktopSingleInstance, make);

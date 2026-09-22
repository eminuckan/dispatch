import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PlatformError from "effect/PlatformError";

import * as DesktopEnvironment from "./DesktopEnvironment.ts";
import * as DesktopLinuxIntegration from "./DesktopLinuxIntegration.ts";

interface RecordedRegistration {
  readonly directories: string[];
  readonly files: Array<{ readonly path: string; readonly content: string }>;
}

const makeEnvironment = (overrides: Record<string, unknown> = {}) =>
  DesktopEnvironment.DesktopEnvironment.of({
    platform: "linux",
    isPackaged: true,
    isDevelopment: false,
    displayName: "Dispatch (Alpha)",
    linuxDesktopEntryName: "com.eminuckan.Dispatch.desktop",
    linuxWmClass: "dispatch",
    linuxApplicationsDir: "/home/alice/.local/share/applications",
    appImagePath: Option.some("/home/alice/Applications/T3-Code.AppImage"),
    path: { join: (...parts: ReadonlyArray<string>) => parts.join("/") },
    ...overrides,
  } as unknown as DesktopEnvironment.DesktopEnvironment["Service"]);

const makeHandlerLayer = (
  recorded: RecordedRegistration,
  input: {
    readonly environment?: Record<string, unknown>;
    readonly writeError?: PlatformError.PlatformError;
    readonly existingEntry?: string;
  } = {},
) =>
  DesktopLinuxIntegration.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(DesktopEnvironment.DesktopEnvironment, makeEnvironment(input.environment)),
        FileSystem.layerNoop({
          readFileString: () => Effect.succeed(input.existingEntry ?? ""),
          makeDirectory: (path) =>
            Effect.sync(() => {
              recorded.directories.push(path);
            }),
          writeFileString: (path, content) =>
            input.writeError
              ? Effect.fail(input.writeError)
              : Effect.sync(() => {
                  recorded.files.push({ path, content });
                }),
        }),
      ),
    ),
  );

const runRegister = (
  recorded: RecordedRegistration,
  input: Parameters<typeof makeHandlerLayer>[1] = {},
) =>
  Effect.gen(function* () {
    const handler = yield* DesktopLinuxIntegration.DesktopLinuxIntegration;
    yield* handler.register;
  }).pipe(Effect.provide(makeHandlerLayer(recorded, input)));

const emptyRecording = (): RecordedRegistration => ({
  directories: [],
  files: [],
});

describe("DesktopLinuxIntegration", () => {
  it("renders a hidden portal identity entry with freedesktop Exec quoting", () => {
    const entry = DesktopLinuxIntegration.renderDesktopEntry({
      displayName: "Dispatch (Nightly)",
      execTarget: '/home/al ice/Apps/T3 "100%" $HOME\\x.AppImage',
    });

    assert.include(entry, "[Desktop Entry]");
    assert.include(entry, "Name=Dispatch (Nightly)");
    // Exec composes both escaping layers: a literal backslash becomes four
    // backslashes in the file, a quote three characters, a dollar sign two
    // backslashes plus the sign.
    assert.include(
      entry,
      'Exec="/home/al ice/Apps/T3 \\\\"100%%\\\\" \\\\$HOME\\\\\\\\x.AppImage"',
    );
    assert.include(entry, "NoDisplay=true");
    assert.notInclude(entry, "StartupWMClass=");
    assert.notInclude(entry, "MimeType=");
    assert.notInclude(entry, "%U");
  });

  it("carries structured context on registration errors", () => {
    const writeError = new DesktopLinuxIntegration.DesktopLinuxIntegrationError({
      desktopEntryPath: "/home/alice/.local/share/applications/com.t3tools.T3Code.desktop",
      cause: new Error("boom"),
    });
    assert.equal(
      writeError.message,
      "Failed to write the desktop identity entry at '/home/alice/.local/share/applications/com.t3tools.T3Code.desktop'.",
    );
    assert.equal(
      writeError.desktopEntryPath,
      "/home/alice/.local/share/applications/com.t3tools.T3Code.desktop",
    );
  });
  it.effect("writes a portal identity entry without URL scheme claims", () => {
    const recorded = emptyRecording();

    return Effect.gen(function* () {
      yield* runRegister(recorded);

      assert.deepEqual(recorded.directories, ["/home/alice/.local/share/applications"]);
      assert.equal(recorded.files.length, 1);
      assert.equal(
        recorded.files[0]?.path,
        "/home/alice/.local/share/applications/com.eminuckan.Dispatch.desktop",
      );
      assert.include(
        recorded.files[0]?.content,
        'Exec="/home/alice/Applications/T3-Code.AppImage"',
      );
      assert.notInclude(recorded.files[0]?.content, "MimeType=");
      assert.notInclude(recorded.files[0]?.content, "%U");
    });
  });

  it.effect("falls back to the process executable outside an AppImage", () => {
    const recorded = emptyRecording();

    return Effect.gen(function* () {
      yield* runRegister(recorded, { environment: { appImagePath: Option.none() } });

      assert.include(
        recorded.files[0]?.content,
        `Exec=${DesktopLinuxIntegration.escapeDesktopEntryExecArgument(process.execPath)}`,
      );
    });
  });

  it.effect("does not rewrite the pre-ready entry while the portal can be reading it", () => {
    const recorded = emptyRecording();

    return Effect.gen(function* () {
      yield* runRegister(recorded, {
        existingEntry: DesktopLinuxIntegration.renderDesktopEntry({
          displayName: "Dispatch (Alpha)",
          execTarget: "/home/alice/Applications/T3-Code.AppImage",
        }),
      });

      assert.deepEqual(recorded.files, []);
      assert.deepEqual(recorded.directories, []);
    });
  });

  it.effect("writes the portal identity without claiming the URL scheme in development", () => {
    const nonLinux = emptyRecording();
    const unpackaged = emptyRecording();

    return Effect.gen(function* () {
      yield* runRegister(nonLinux, { environment: { platform: "darwin" } });
      yield* runRegister(unpackaged, {
        environment: {
          isPackaged: false,
          linuxDesktopEntryName: "com.t3tools.T3Code.Development.desktop",
        },
      });

      assert.deepEqual(nonLinux.files, []);
      assert.equal(
        unpackaged.files[0]?.path,
        "/home/alice/.local/share/applications/com.t3tools.T3Code.Development.desktop",
      );
    });
  });

  it.effect("never fails startup when registration cannot complete", () => {
    const writeFailed = emptyRecording();

    return Effect.gen(function* () {
      yield* runRegister(writeFailed, {
        writeError: PlatformError.systemError({
          _tag: "PermissionDenied",
          module: "FileSystem",
          method: "writeFileString",
          description: "read-only filesystem",
          pathOrDescriptor: "/home/alice/.local/share/applications/com.t3tools.T3Code.desktop",
        }),
      });

      assert.deepEqual(writeFailed.files, []);
    });
  });
});

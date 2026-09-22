import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as DesktopEnvironment from "./DesktopEnvironment.ts";
import { makeComponentLogger } from "./DesktopObservability.ts";

// AppImage integration tools choose their own desktop filenames. Keep a stable,
// hidden entry so screen-capture portals can resolve Dispatch's application identity.
const { logInfo, logWarning } = makeComponentLogger("desktop-linux-integration");

export class DesktopLinuxIntegrationError extends Schema.TaggedError<DesktopLinuxIntegrationError>()(
  "DesktopLinuxIntegrationError",
  {
    desktopEntryPath: Schema.String,
    cause: Schema.optionalKey(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Failed to write the desktop identity entry at '${this.desktopEntryPath}'.`;
  }
}

const escapeDesktopEntryString = (value: string): string =>
  value
    .replaceAll("\\", "\\\\")
    .replaceAll("\n", "\\n")
    .replaceAll("\r", "\\r")
    .replaceAll("\t", "\\t");

// Exec values are unescaped twice by implementations: first the general
// string-value rules, then the Exec quoting rules — so writing composes the
// layers in reverse. The argument is double-quoted with reserved characters
// backslash-escaped and literal percent signs doubled (field codes), and the
// general string escaping is applied on top: a literal backslash ends up as
// four backslashes in the file, a quote as \\", a dollar sign as \\$.
export function escapeDesktopEntryExecArgument(value: string): string {
  const quoted = value
    .replaceAll("\\", () => "\\\\")
    .replaceAll("`", () => "\\`")
    .replaceAll("$", () => "\\$")
    .replaceAll('"', () => '\\"')
    .replaceAll("%", () => "%%");
  return escapeDesktopEntryString(`"${quoted}"`);
}

// The AppImage integration entry owns the window identity and icon. This
// hidden portal identity entry must not compete with it for StartupWMClass matching.
export function renderDesktopEntry(input: {
  readonly displayName: string;
  readonly execTarget: string;
}): string {
  return [
    "[Desktop Entry]",
    "Type=Application",
    `Name=${escapeDesktopEntryString(input.displayName)}`,
    `Exec=${escapeDesktopEntryExecArgument(input.execTarget)}`,
    "Terminal=false",
    "NoDisplay=true",
    "StartupNotify=false",
    "",
  ].join("\n");
}

export class DesktopLinuxIntegration extends Context.Service<
  DesktopLinuxIntegration,
  {
    readonly register: Effect.Effect<void>;
  }
>()("@dispatch/desktop/app/DesktopLinuxIntegration") {}

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const fileSystem = yield* FileSystem.FileSystem;

  const desktopEntryPath = environment.path.join(
    environment.linuxApplicationsDir,
    environment.linuxDesktopEntryName,
  );

  const writeDesktopEntry = Effect.gen(function* () {
    // Inside the mounted AppImage, process.execPath points at a transient
    // /tmp/.mount_* path — the entry must launch the AppImage itself.
    const execTarget = Option.getOrElse(environment.appImagePath, () => process.execPath);
    const content = renderDesktopEntry({
      displayName: environment.displayName,
      execTarget,
    });
    // Pre-ready setup normally wrote this already. Avoid truncating a valid
    // entry while the portal may be reading it during startup.
    const existing = yield* fileSystem
      .readFileString(desktopEntryPath)
      .pipe(Effect.orElseSucceed(() => null));
    if (existing === content) return;
    yield* fileSystem.makeDirectory(environment.linuxApplicationsDir, { recursive: true });
    yield* fileSystem.writeFileString(desktopEntryPath, content);
  }).pipe(
    Effect.mapError(
      (cause) =>
        new DesktopLinuxIntegrationError({
          desktopEntryPath,
          cause,
        }),
    ),
  );

  const register = Effect.gen(function* () {
    if (environment.platform !== "linux") {
      return;
    }
    yield* writeDesktopEntry;
    yield* logInfo("registered desktop portal identity", { desktopEntryPath });
  }).pipe(
    // A read-only home must not block startup; screen capture can report the missing identity.
    Effect.catch((error) =>
      logWarning("Desktop portal identity registration failed", {
        desktopEntryPath: error.desktopEntryPath,
        message: error.message,
      }),
    ),
    Effect.withSpan("desktop.linuxIntegration.register"),
  );

  return DesktopLinuxIntegration.of({ register });
});

export const layer = Layer.effect(DesktopLinuxIntegration, make);

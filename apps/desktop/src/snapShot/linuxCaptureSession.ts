// @effect-diagnostics nodeBuiltinImport:off -- Reads portal-owned screenshot files at the native boundary.
import * as NodeFSP from "node:fs/promises";
import * as NodeURL from "node:url";
import type { SnapShotKeyChord } from "@dispatch/contracts";
import { nativeImage } from "electron";

// Linux helpers that need no D-Bus. Keep this module free of dbus-next so the main
// process can answer "which desktop is this" and read a PNG without loading it.

export const HYPRLAND_CAPTURE_ACTION = "capture-window";
export const NIRI_CAPTURE_PATH = "/com/eminuckan/dispatch/SnapShot";
export const NIRI_CAPTURE_INTERFACE = "com.eminuckan.dispatch.SnapShot";
export const LEGACY_NIRI_CAPTURE_PATH = "/com/t3tools/SnapShot";
export const LEGACY_NIRI_CAPTURE_INTERFACE = "com.t3tools.SnapShot";

const DISPATCH_PRODUCTION_APP_IDS = new Set([
  "com.eminuckan.dispatch",
  "com.eminuckan.Dispatch",
  "com.t3tools.T3Code",
]);
const DISPATCH_DEVELOPMENT_APP_IDS = new Set([
  "com.eminuckan.dispatch.dev",
  "com.eminuckan.Dispatch.Development",
  "com.t3tools.T3Code.Development",
]);

export function niriCaptureBusNames(appId: string): readonly string[] {
  const names = DISPATCH_PRODUCTION_APP_IDS.has(appId)
    ? [
        "com.eminuckan.dispatch.SnapShot",
        "com.eminuckan.Dispatch.SnapShot",
        "com.t3tools.T3Code.SnapShot",
      ]
    : DISPATCH_DEVELOPMENT_APP_IDS.has(appId)
      ? [
          "com.eminuckan.dispatch.dev.SnapShot",
          "com.eminuckan.Dispatch.Development.SnapShot",
          "com.t3tools.T3Code.Development.SnapShot",
        ]
      : [`${appId}.SnapShot`];
  return [...new Set(names)];
}

function niriBinding(destination: string, path: string, iface: string): string {
  return `Ctrl+Shift+2 repeat=false { spawn "gdbus" "call" "--session" "--dest" "${destination}" "--object-path" "${path}" "--method" "${iface}.Capture"; }`;
}

function isDesktopSession(env: NodeJS.ProcessEnv, desktop: string): boolean {
  return (
    !env.FLATPAK_ID &&
    !env.SNAP &&
    Boolean(env.XDG_CURRENT_DESKTOP?.split(":").some((name) => name.toLowerCase() === desktop))
  );
}

export function isGnomeCaptureSession(env: NodeJS.ProcessEnv): boolean {
  return isDesktopSession(env, "gnome");
}

export function isKdeCaptureSession(env = process.env): boolean {
  return isDesktopSession(env, "kde");
}

export function isHyprlandCaptureSession(env = process.env): boolean {
  return isDesktopSession(env, "hyprland");
}

export function niriCaptureBinding(appId: string): string {
  return niriBinding(niriCaptureBusNames(appId)[0]!, NIRI_CAPTURE_PATH, NIRI_CAPTURE_INTERFACE);
}

/** Current writer first, then exact forms emitted by pre-Dispatch Niri bindings. */
export function niriCaptureBindingCandidates(appId: string): readonly string[] {
  return [
    niriCaptureBinding(appId),
    ...niriCaptureBusNames(appId).map((destination) =>
      niriBinding(destination, LEGACY_NIRI_CAPTURE_PATH, LEGACY_NIRI_CAPTURE_INTERFACE),
    ),
  ];
}

const KEY_NAMES: Readonly<Record<string, string>> = {
  " ": "space",
  escape: "Escape",
  esc: "Escape",
  enter: "Return",
  tab: "Tab",
  backspace: "BackSpace",
  delete: "Delete",
  insert: "Insert",
  home: "Home",
  end: "End",
  pageup: "Page_Up",
  pagedown: "Page_Down",
  arrowup: "Up",
  arrowdown: "Down",
  arrowleft: "Left",
  arrowright: "Right",
  up: "Up",
  down: "Down",
  left: "Left",
  right: "Right",
  "+": "plus",
  "-": "minus",
  "=": "equal",
  ",": "comma",
  ".": "period",
  "/": "slash",
  ";": "semicolon",
  "'": "apostrophe",
  "[": "bracketleft",
  "]": "bracketright",
  "\\": "backslash",
  "`": "grave",
  "!": "exclam",
  "@": "at",
  "#": "numbersign",
  $: "dollar",
  "%": "percent",
  "^": "asciicircum",
  "&": "ampersand",
  "*": "asterisk",
  "(": "parenleft",
  ")": "parenright",
  _: "underscore",
  ":": "colon",
  '"': "quotedbl",
  "{": "braceleft",
  "}": "braceright",
  "|": "bar",
  "<": "less",
  ">": "greater",
  "?": "question",
  "~": "asciitilde",
};

export function portalShortcutTrigger(shortcut: SnapShotKeyChord): string {
  const key = shortcut.key.toLowerCase();
  const keysym =
    KEY_NAMES[key] ??
    (/^[a-z0-9]$/.test(key) || /^f([1-9]|1\d|2[0-4])$/.test(key) ? key.toUpperCase() : undefined);
  if (!keysym)
    throw new Error("This key isn't supported as a Wayland capture shortcut. Choose another key.");
  return [
    shortcut.ctrlKey || shortcut.modKey ? "CTRL" : null,
    shortcut.altKey ? "ALT" : null,
    shortcut.shiftKey ? "SHIFT" : null,
    shortcut.metaKey ? "LOGO" : null,
    keysym,
  ]
    .filter(Boolean)
    .join("+");
}

const PNG_HEADER = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const MAX_PNG_BYTES = 32 * 1024 * 1024;

export function resizeLinuxCapture(png: Buffer): Buffer {
  if (png.length > MAX_PNG_BYTES || !png.subarray(0, 8).equals(PNG_HEADER)) {
    throw new Error("Invalid or oversized window screenshot.");
  }
  const image = nativeImage.createFromBuffer(png);
  if (image.isEmpty()) throw new Error("The window screenshot is empty.");
  const { width, height } = image.getSize();
  const scale = Math.min(2_560 / width, 1_600 / height, 1);
  return scale < 1
    ? image
        .resize({
          width: Math.max(1, Math.round(width * scale)),
          height: Math.max(1, Math.round(height * scale)),
          quality: "best",
        })
        .toPNG()
    : png;
}

export async function readPortalPng(uri: string): Promise<Buffer> {
  // fileURLToPath rejects network schemes/hosts. Never delete a portal-owned file.
  const file = await NodeFSP.open(NodeURL.fileURLToPath(uri), "r");
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > MAX_PNG_BYTES) throw new Error("Invalid screenshot file.");
    const buffer = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await file.read(buffer, offset, buffer.length - offset, offset);
      if (!bytesRead) throw new Error("Incomplete screenshot file.");
      offset += bytesRead;
    }
    return resizeLinuxCapture(buffer);
  } finally {
    await file.close();
  }
}

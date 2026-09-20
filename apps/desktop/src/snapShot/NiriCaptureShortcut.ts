// @effect-diagnostics globalTimers:off -- Bound session-bus registration at a native callback boundary.
import { Message, MessageType, NameFlag, RequestNameReply, sessionBus } from "dbus-next";

import {
  LEGACY_NIRI_CAPTURE_INTERFACE,
  LEGACY_NIRI_CAPTURE_PATH,
  NIRI_CAPTURE_INTERFACE,
  NIRI_CAPTURE_PATH,
  niriCaptureBusNames,
} from "./linuxCaptureSession.ts";

/** Niri owns the keybinding; this endpoint triggers capture without first focusing Dispatch. */
export async function startNiriCaptureShortcut(
  appId: string,
  onCapture: () => void,
  onFailure: () => void,
  bus = sessionBus(),
): Promise<() => void> {
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    bus.disconnect();
  };
  const failure = new Promise<never>((_, reject) => {
    bus.on("error", (error: Error) => {
      reject(error);
      if (!closed) onFailure();
      close();
    });
  });
  void failure.catch(() => undefined);
  bus.addMethodHandler((message: Message) => {
    const canonical =
      message.path === NIRI_CAPTURE_PATH && message.interface === NIRI_CAPTURE_INTERFACE;
    const legacy =
      message.path === LEGACY_NIRI_CAPTURE_PATH &&
      message.interface === LEGACY_NIRI_CAPTURE_INTERFACE;
    if ((!canonical && !legacy) || message.member !== "Capture") return false;
    if (message.signature || message.body.length) {
      // Preserve dbus-next's numeric reply serial; its newError factory has incorrect types.
      const reply = Message.newMethodReturn(message, "s", ["Capture takes no arguments."]);
      reply.type = MessageType.ERROR;
      reply.errorName = "org.freedesktop.DBus.Error.InvalidArgs";
      bus.send(reply);
      return true;
    }
    if (!closed) onCapture();
    bus.send(Message.newMethodReturn(message));
    return true;
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const [canonicalName, ...legacyNames] = niriCaptureBusNames(appId);
    const result = await Promise.race([
      bus.requestName(canonicalName!, NameFlag.DO_NOT_QUEUE),
      failure,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("Niri capture shortcut registration timed out.")),
          5_000,
        );
      }),
    ]);
    if (result !== RequestNameReply.PRIMARY_OWNER)
      throw new Error("Another Dispatch instance already owns the capture shortcut.");
    // Old Niri configs address the former prod/dev names. Queue for those aliases
    // without replacing an older running app; D-Bus grants them after that owner exits.
    await Promise.all(legacyNames.map((name) => bus.requestName(name, 0)));
    return close;
  } catch (error) {
    close();
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

import * as NodeEvents from "node:events";
import { Message, MessageType, NameFlag, RequestNameReply, type MessageBus } from "dbus-next";
import { expect, it, vi } from "vite-plus/test";

import { startNiriCaptureShortcut } from "./NiriCaptureShortcut.ts";
import {
  LEGACY_NIRI_CAPTURE_INTERFACE,
  LEGACY_NIRI_CAPTURE_PATH,
  NIRI_CAPTURE_INTERFACE,
  NIRI_CAPTURE_PATH,
} from "./linuxCaptureSession.ts";

class FakeBus extends NodeEvents.EventEmitter {
  readonly handlers: Array<(message: Message) => boolean> = [];
  readonly requested: Array<{ name: string; flags: number }> = [];
  readonly send = vi.fn();
  readonly disconnect = vi.fn();

  addMethodHandler(handler: (message: Message) => boolean) {
    this.handlers.push(handler);
  }

  async requestName(name: string, flags: number) {
    this.requested.push({ name, flags });
    return name === "com.t3tools.T3Code.SnapShot"
      ? RequestNameReply.IN_QUEUE
      : RequestNameReply.PRIMARY_OWNER;
  }
}

function captureCall(path: string, iface: string) {
  return new Message({
    type: MessageType.METHOD_CALL,
    serial: 1,
    path,
    interface: iface,
    member: "Capture",
    signature: "",
    body: [],
  });
}

it("owns the canonical Dispatch name while accepting legacy Niri calls when aliases are free", async () => {
  const bus = new FakeBus();
  const capture = vi.fn();
  const failure = vi.fn();

  const stop = await startNiriCaptureShortcut(
    "com.eminuckan.Dispatch",
    capture,
    failure,
    bus as unknown as MessageBus,
  );

  expect(bus.requested).toEqual([
    { name: "com.eminuckan.dispatch.SnapShot", flags: NameFlag.DO_NOT_QUEUE },
    { name: "com.eminuckan.Dispatch.SnapShot", flags: 0 },
    { name: "com.t3tools.T3Code.SnapShot", flags: 0 },
  ]);
  expect(failure).not.toHaveBeenCalled();

  expect(bus.handlers[0]!(captureCall(NIRI_CAPTURE_PATH, NIRI_CAPTURE_INTERFACE))).toBe(true);
  expect(
    bus.handlers[0]!(captureCall(LEGACY_NIRI_CAPTURE_PATH, LEGACY_NIRI_CAPTURE_INTERFACE)),
  ).toBe(true);
  expect(capture).toHaveBeenCalledTimes(2);

  stop();
  expect(bus.disconnect).toHaveBeenCalledOnce();
});

it("uses a distinct canonical dev name and ignores a busy legacy alias", async () => {
  const bus = new FakeBus();
  bus.requestName = vi.fn(async (name: string, flags: number) => {
    bus.requested.push({ name, flags });
    return name === "com.t3tools.T3Code.Development.SnapShot"
      ? RequestNameReply.IN_QUEUE
      : RequestNameReply.PRIMARY_OWNER;
  });

  const stop = await startNiriCaptureShortcut(
    "com.eminuckan.Dispatch.Development",
    vi.fn(),
    vi.fn(),
    bus as unknown as MessageBus,
  );

  expect(bus.requested).toEqual([
    { name: "com.eminuckan.dispatch.dev.SnapShot", flags: NameFlag.DO_NOT_QUEUE },
    { name: "com.eminuckan.Dispatch.Development.SnapShot", flags: 0 },
    { name: "com.t3tools.T3Code.Development.SnapShot", flags: 0 },
  ]);
  stop();
});

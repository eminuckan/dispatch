import * as Effect from "effect/Effect";

import {
  generateBrowserDpopKey,
  readStoredBrowserDpopKey,
  writeStoredBrowserDpopKey,
} from "../cloud/dpop";
import { listDispatchConnectDevices, registerDispatchConnectDevice } from "./dispatchConnect";

const DEVICE_STORAGE_KEY = "dispatch.connect.device.v1";

interface StoredConnectDevice {
  readonly deviceId: string;
  readonly publicKey: string;
}

let ephemeralDevice: StoredConnectDevice | null = null;

function parseStoredDevice(value: string | null): StoredConnectDevice | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const record = parsed as Record<string, unknown>;
    return typeof record.deviceId === "string" && typeof record.publicKey === "string"
      ? { deviceId: record.deviceId, publicKey: record.publicKey }
      : null;
  } catch {
    return null;
  }
}

function loadStoredDevice(): StoredConnectDevice | null {
  try {
    return parseStoredDevice(window.localStorage.getItem(DEVICE_STORAGE_KEY));
  } catch {
    return ephemeralDevice;
  }
}

function persistDevice(device: StoredConnectDevice): void {
  ephemeralDevice = device;
  try {
    window.localStorage.setItem(DEVICE_STORAGE_KEY, JSON.stringify(device));
  } catch {
    // Private browsing or a locked-down host may make storage unavailable.
  }
}

async function loadOrCreatePublicKey(): Promise<string> {
  const proofKey = await Effect.runPromise(
    readStoredBrowserDpopKey().pipe(
      Effect.flatMap((stored) =>
        stored
          ? Effect.succeed(stored)
          : generateBrowserDpopKey.pipe(Effect.tap(writeStoredBrowserDpopKey)),
      ),
    ),
  );
  const { crv, kty, x, y } = proofKey.publicJwk;
  return JSON.stringify({ crv, kty, x, y });
}

export async function ensureDispatchConnectDevice(baseUrl: string): Promise<string> {
  const publicKey = await loadOrCreatePublicKey();
  const existing = loadStoredDevice();
  const registeredDevices = await listDispatchConnectDevices({ baseUrl });
  const cachedRegistration =
    existing?.publicKey === publicKey
      ? registeredDevices.find(
          (device) => device.id === existing.deviceId && device.publicKey === publicKey,
        )
      : undefined;
  if (cachedRegistration) return cachedRegistration.id;

  const registered = registeredDevices.find((device) => device.publicKey === publicKey);
  if (registered) {
    persistDevice({ deviceId: registered.id, publicKey });
    return registered.id;
  }

  const device = await registerDispatchConnectDevice({
    baseUrl,
    label: window.desktopBridge ? "Dispatch Desktop" : "Dispatch Web",
    publicKey,
  });
  persistDevice({ deviceId: device.id, publicKey });
  return device.id;
}

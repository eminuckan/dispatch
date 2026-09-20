import * as SecureStore from "expo-secure-store";
import * as Effect from "effect/Effect";

import { cryptoLayer, loadOrCreateDpopProofKeyPair } from "../cloud/dpop";
import { listDispatchConnectDevices, registerDispatchConnectDevice } from "./dispatchConnect";

const DEVICE_STORAGE_KEY = "dispatch.connect.device.v1";

interface StoredConnectDevice {
  readonly deviceId: string;
  readonly publicKey: string;
}

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

export async function ensureDispatchConnectDevice(input: {
  readonly baseUrl: string;
  readonly cookie: string;
}): Promise<string> {
  const proofKey = await Effect.runPromise(
    loadOrCreateDpopProofKeyPair().pipe(Effect.provide(cryptoLayer)),
  );
  const { crv, kty, x, y } = proofKey.publicJwk;
  const publicKey = JSON.stringify({ crv, kty, x, y });
  const existing = parseStoredDevice(await SecureStore.getItemAsync(DEVICE_STORAGE_KEY));
  const registeredDevices = await listDispatchConnectDevices({
    baseUrl: input.baseUrl,
    cookie: input.cookie,
  });
  const cachedRegistration =
    existing?.publicKey === publicKey
      ? registeredDevices.find(
          (device) => device.id === existing.deviceId && device.publicKey === publicKey,
        )
      : undefined;
  if (cachedRegistration) return cachedRegistration.id;

  const registered = registeredDevices.find((device) => device.publicKey === publicKey);
  if (registered) {
    await SecureStore.setItemAsync(
      DEVICE_STORAGE_KEY,
      JSON.stringify({ deviceId: registered.id, publicKey } satisfies StoredConnectDevice),
    );
    return registered.id;
  }

  const device = await registerDispatchConnectDevice({
    baseUrl: input.baseUrl,
    label: "Dispatch Mobile",
    publicKey,
    cookie: input.cookie,
  });
  await SecureStore.setItemAsync(
    DEVICE_STORAGE_KEY,
    JSON.stringify({ deviceId: device.id, publicKey } satisfies StoredConnectDevice),
  );
  return device.id;
}

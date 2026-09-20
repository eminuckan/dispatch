export const DISPATCH_CONNECT_CODE_LENGTH = 12;
const DISPATCH_CONNECT_CODE_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";

export type DispatchConnectEndpointKind = "tailscale" | "cloudflare_tunnel";

export interface DispatchConnectEndpoint {
  readonly kind: DispatchConnectEndpointKind;
  readonly httpBaseUrl: string;
  readonly wsBaseUrl: string;
  readonly updatedAt?: string;
}

export interface DispatchConnectEnvironment {
  readonly id: string;
  readonly label: string;
  readonly endpoints: readonly DispatchConnectEndpoint[];
}

export interface DispatchConnectDevice {
  readonly id: string;
  readonly publicKey: string;
}

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export function normalizeDispatchConnectUrl(value: string | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;

  try {
    const url = new URL(trimmed);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url.toString().replace(/\/$/, "");
  } catch {
    return null;
  }
}

export function resolveDispatchConnectUrl(): string | null {
  return normalizeDispatchConnectUrl(process.env.EXPO_PUBLIC_DISPATCH_CONNECT_URL);
}

export function formatDispatchConnectCode(value: string): string {
  const raw = value
    .toUpperCase()
    .replace(/[^A-Z0-9]/gu, "")
    .slice(0, DISPATCH_CONNECT_CODE_LENGTH);
  return raw.match(/.{1,4}/gu)?.join("-") ?? "";
}

export function parseDispatchConnectCode(value: string): string {
  const formatted = formatDispatchConnectCode(value);
  const raw = formatted.replace(/-/gu, "");
  if (raw.length !== DISPATCH_CONNECT_CODE_LENGTH) {
    throw new Error("Enter the 12-character Dispatch Connect pairing code.");
  }
  if ([...raw].some((character) => !DISPATCH_CONNECT_CODE_ALPHABET.includes(character))) {
    throw new Error("That Dispatch Connect pairing code contains an invalid character.");
  }
  return formatted;
}

export function readDispatchConnectCodeFromQrPayload(payload: string): string | null {
  const trimmed = payload.trim();
  if (!trimmed) return null;

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }
  if (url.protocol !== "dispatch:" || url.hostname !== "connect" || url.pathname !== "/pair") {
    return null;
  }
  const code = url.searchParams.get("code");
  if (!code) {
    throw new Error("Dispatch Connect QR code does not contain an environment pairing code.");
  }
  return parseDispatchConnectCode(code);
}

function parseEndpoint(value: unknown): DispatchConnectEndpoint | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (record.kind !== "tailscale" && record.kind !== "cloudflare_tunnel") return null;
  if (typeof record.httpBaseUrl !== "string" || typeof record.wsBaseUrl !== "string") return null;

  try {
    const http = new URL(record.httpBaseUrl);
    const ws = new URL(record.wsBaseUrl);
    if (!["http:", "https:"].includes(http.protocol) || !["ws:", "wss:"].includes(ws.protocol)) {
      return null;
    }
  } catch {
    return null;
  }

  return {
    kind: record.kind,
    httpBaseUrl: record.httpBaseUrl.replace(/\/$/, ""),
    wsBaseUrl: record.wsBaseUrl.replace(/\/$/, ""),
    ...(typeof record.updatedAt === "string" ? { updatedAt: record.updatedAt } : {}),
  };
}

export function orderDispatchConnectEndpoints(
  endpoints: readonly DispatchConnectEndpoint[],
): readonly DispatchConnectEndpoint[] {
  return [...endpoints].sort((left, right) => {
    const priority = (kind: DispatchConnectEndpointKind) => (kind === "tailscale" ? 0 : 1);
    return priority(left.kind) - priority(right.kind);
  });
}

function connectErrorMessage(payload: unknown, fallback: string): string {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return fallback;
  const record = payload as Record<string, unknown>;
  if (typeof record.message === "string" && record.message.trim()) return record.message;
  if (typeof record.error === "string" && record.error.trim()) {
    switch (record.error) {
      case "authentication_required":
        return "Sign in to Dispatch Connect first.";
      case "pairing_not_found":
        return "That Dispatch Connect pairing code is invalid or no longer available.";
      case "pairing_expired":
        return "That Dispatch Connect pairing code has expired.";
      case "pairing_used":
        return "That Dispatch Connect pairing code has already been used.";
      case "device_not_owned":
        return "This Dispatch Connect device is not registered to the signed-in account.";
      default:
        return record.error.replace(/_/gu, " ");
    }
  }
  return fallback;
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

function cookieHeaders(cookie: string): Record<string, string> {
  return cookie
    ? { Cookie: cookie, "content-type": "application/json" }
    : { "content-type": "application/json" };
}

export async function registerDispatchConnectDevice(input: {
  readonly baseUrl: string;
  readonly label: string;
  readonly publicKey: string;
  readonly cookie: string;
  readonly fetch?: FetchLike;
}): Promise<DispatchConnectDevice> {
  const fetcher = input.fetch ?? fetch;
  const response = await fetcher(`${input.baseUrl}/v1/devices`, {
    method: "POST",
    credentials: "omit",
    headers: cookieHeaders(input.cookie),
    body: JSON.stringify({ label: input.label, publicKey: input.publicKey }),
  });
  const payload = await readJson(response);
  if (!response.ok) {
    throw new Error(
      connectErrorMessage(payload, "Could not register this device with Dispatch Connect."),
    );
  }
  const device =
    payload && typeof payload === "object" && !Array.isArray(payload)
      ? (payload as Record<string, unknown>).device
      : null;
  if (!device || typeof device !== "object" || Array.isArray(device)) {
    throw new Error("Dispatch Connect returned an invalid device response.");
  }
  const id = (device as Record<string, unknown>).id;
  if (typeof id !== "string" || !id.trim()) {
    throw new Error("Dispatch Connect returned an invalid device response.");
  }
  const publicKey = (device as Record<string, unknown>).publicKey;
  if (typeof publicKey !== "string" || !publicKey.trim()) {
    throw new Error("Dispatch Connect returned an invalid device response.");
  }
  return { id, publicKey };
}

export async function listDispatchConnectDevices(input: {
  readonly baseUrl: string;
  readonly cookie: string;
  readonly fetch?: FetchLike;
}): Promise<readonly DispatchConnectDevice[]> {
  const fetcher = input.fetch ?? fetch;
  const response = await fetcher(`${input.baseUrl}/v1/devices`, {
    method: "GET",
    credentials: "omit",
    headers: input.cookie ? { Cookie: input.cookie } : undefined,
  });
  const payload = await readJson(response);
  if (!response.ok) {
    throw new Error(connectErrorMessage(payload, "Could not load Dispatch Connect devices."));
  }
  const devices =
    payload && typeof payload === "object" && !Array.isArray(payload)
      ? (payload as Record<string, unknown>).devices
      : null;
  if (!Array.isArray(devices)) {
    throw new Error("Dispatch Connect returned an invalid devices response.");
  }
  return devices.flatMap((device): DispatchConnectDevice[] => {
    if (!device || typeof device !== "object" || Array.isArray(device)) return [];
    const record = device as Record<string, unknown>;
    return typeof record.id === "string" && typeof record.publicKey === "string"
      ? [{ id: record.id, publicKey: record.publicKey }]
      : [];
  });
}

export async function redeemDispatchConnectPairing(input: {
  readonly baseUrl: string;
  readonly deviceId: string;
  readonly code: string;
  readonly cookie: string;
  readonly fetch?: FetchLike;
}): Promise<DispatchConnectEnvironment> {
  const code = parseDispatchConnectCode(input.code);
  const fetcher = input.fetch ?? fetch;
  const response = await fetcher(`${input.baseUrl}/v1/pairings/redeem`, {
    method: "POST",
    credentials: "omit",
    headers: cookieHeaders(input.cookie),
    body: JSON.stringify({ deviceId: input.deviceId, code }),
  });
  const payload = await readJson(response);
  if (!response.ok) {
    throw new Error(
      connectErrorMessage(payload, "Could not redeem the Dispatch Connect pairing code."),
    );
  }
  const environment =
    payload && typeof payload === "object" && !Array.isArray(payload)
      ? (payload as Record<string, unknown>).environment
      : null;
  if (!environment || typeof environment !== "object" || Array.isArray(environment)) {
    throw new Error("Dispatch Connect returned an invalid environment response.");
  }
  const record = environment as Record<string, unknown>;
  if (typeof record.id !== "string" || typeof record.label !== "string") {
    throw new Error("Dispatch Connect returned an invalid environment response.");
  }
  const endpoints = Array.isArray(record.endpoints)
    ? record.endpoints
        .map(parseEndpoint)
        .filter((entry): entry is DispatchConnectEndpoint => entry !== null)
    : [];
  if (endpoints.length === 0) {
    throw new Error("This environment has no reachable Dispatch Connect endpoint yet.");
  }
  return {
    id: record.id,
    label: record.label,
    endpoints: orderDispatchConnectEndpoints(endpoints),
  };
}

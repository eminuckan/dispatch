import { dispatchConnectAuthorizationHeader } from "./accountToken";

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
  readonly publicKey?: string;
  readonly endpoints: readonly DispatchConnectEndpoint[];
}

export interface DispatchConnectEnvironmentRegistration {
  readonly environment: DispatchConnectEnvironment & { readonly publicKey: string };
  readonly credential: string;
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
  return normalizeDispatchConnectUrl(
    import.meta.env.VITE_DISPATCH_CONNECT_URL as string | undefined,
  );
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

function authenticatedHeaders(
  baseUrl: string,
  headers?: Readonly<Record<string, string>>,
): Record<string, string> {
  const authorization = dispatchConnectAuthorizationHeader(baseUrl);
  return {
    ...headers,
    ...(authorization ? { authorization } : {}),
  };
}

function parseEnvironment(value: unknown): DispatchConnectEnvironment | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (typeof record.id !== "string" || typeof record.label !== "string") return null;
  const endpoints = Array.isArray(record.endpoints)
    ? record.endpoints
        .map(parseEndpoint)
        .filter((entry): entry is DispatchConnectEndpoint => entry !== null)
    : [];
  return {
    id: record.id,
    label: record.label,
    ...(typeof record.publicKey === "string" ? { publicKey: record.publicKey } : {}),
    endpoints: orderDispatchConnectEndpoints(endpoints),
  };
}

export async function registerDispatchConnectDevice(input: {
  readonly baseUrl: string;
  readonly label: string;
  readonly publicKey: string;
  readonly fetch?: FetchLike;
}): Promise<DispatchConnectDevice> {
  const fetcher = input.fetch ?? fetch;
  const response = await fetcher(`${input.baseUrl}/v1/devices`, {
    method: "POST",
    credentials: "omit",
    headers: authenticatedHeaders(input.baseUrl, { "content-type": "application/json" }),
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
  readonly fetch?: FetchLike;
}): Promise<readonly DispatchConnectDevice[]> {
  const fetcher = input.fetch ?? fetch;
  const response = await fetcher(`${input.baseUrl}/v1/devices`, {
    method: "GET",
    credentials: "omit",
    headers: authenticatedHeaders(input.baseUrl),
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
  readonly fetch?: FetchLike;
}): Promise<DispatchConnectEnvironment> {
  const code = parseDispatchConnectCode(input.code);
  const fetcher = input.fetch ?? fetch;
  const response = await fetcher(`${input.baseUrl}/v1/pairings/redeem`, {
    method: "POST",
    credentials: "omit",
    headers: authenticatedHeaders(input.baseUrl, { "content-type": "application/json" }),
    body: JSON.stringify({ deviceId: input.deviceId, code }),
  });
  const payload = await readJson(response);
  if (!response.ok) {
    throw new Error(
      connectErrorMessage(payload, "Could not redeem the Dispatch Connect pairing code."),
    );
  }
  const environmentPayload =
    payload && typeof payload === "object" && !Array.isArray(payload)
      ? (payload as Record<string, unknown>).environment
      : null;
  const environment = parseEnvironment(environmentPayload);
  if (!environment) {
    throw new Error("Dispatch Connect returned an invalid environment response.");
  }
  if (environment.endpoints.length === 0) {
    throw new Error("This environment has no reachable Dispatch Connect endpoint yet.");
  }
  return environment;
}

export async function listDispatchConnectEnvironments(input: {
  readonly baseUrl: string;
  readonly fetch?: FetchLike;
}): Promise<readonly DispatchConnectEnvironment[]> {
  const fetcher = input.fetch ?? fetch;
  const response = await fetcher(`${input.baseUrl}/v1/environments`, {
    method: "GET",
    credentials: "omit",
    headers: authenticatedHeaders(input.baseUrl),
  });
  const payload = await readJson(response);
  if (!response.ok) {
    throw new Error(connectErrorMessage(payload, "Could not load Dispatch Connect environments."));
  }
  const values =
    payload && typeof payload === "object" && !Array.isArray(payload)
      ? (payload as Record<string, unknown>).environments
      : null;
  if (!Array.isArray(values)) {
    throw new Error("Dispatch Connect returned an invalid environments response.");
  }
  return values.flatMap((value): DispatchConnectEnvironment[] => {
    const environment = parseEnvironment(value);
    return environment ? [environment] : [];
  });
}

export async function createDispatchConnectEnvironment(input: {
  readonly baseUrl: string;
  readonly label: string;
  readonly publicKey: string;
  readonly endpoints?: readonly DispatchConnectEndpoint[];
  readonly fetch?: FetchLike;
}): Promise<DispatchConnectEnvironmentRegistration> {
  const fetcher = input.fetch ?? fetch;
  const response = await fetcher(`${input.baseUrl}/v1/environments`, {
    method: "POST",
    credentials: "omit",
    headers: authenticatedHeaders(input.baseUrl, { "content-type": "application/json" }),
    body: JSON.stringify({
      label: input.label,
      publicKey: input.publicKey,
      endpoints: input.endpoints ?? [],
    }),
  });
  const payload = await readJson(response);
  if (!response.ok) {
    throw new Error(connectErrorMessage(payload, "Could not register this environment."));
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("Dispatch Connect returned an invalid environment registration response.");
  }
  const record = payload as Record<string, unknown>;
  const environment = parseEnvironment(record.environment);
  if (
    !environment?.publicKey ||
    typeof record.credential !== "string" ||
    !record.credential.trim()
  ) {
    throw new Error("Dispatch Connect returned an invalid environment registration response.");
  }
  return {
    environment: { ...environment, publicKey: environment.publicKey },
    credential: record.credential,
  };
}

export async function rotateDispatchConnectEnvironmentCredential(input: {
  readonly baseUrl: string;
  readonly environmentId: string;
  readonly fetch?: FetchLike;
}): Promise<string> {
  const fetcher = input.fetch ?? fetch;
  const response = await fetcher(
    `${input.baseUrl}/v1/environments/${encodeURIComponent(input.environmentId)}/credentials/rotate`,
    {
      method: "POST",
      credentials: "omit",
      headers: authenticatedHeaders(input.baseUrl),
    },
  );
  const payload = await readJson(response);
  if (!response.ok) {
    throw new Error(
      connectErrorMessage(payload, "Could not refresh this environment's Connect credential."),
    );
  }
  const credential =
    payload && typeof payload === "object" && !Array.isArray(payload)
      ? (payload as Record<string, unknown>).credential
      : null;
  if (typeof credential !== "string" || !credential.trim()) {
    throw new Error("Dispatch Connect returned an invalid environment credential response.");
  }
  return credential;
}

export async function upsertDispatchConnectEnvironmentEndpoint(input: {
  readonly baseUrl: string;
  readonly environmentId: string;
  readonly credential: string;
  readonly endpoint: DispatchConnectEndpoint;
  readonly fetch?: FetchLike;
}): Promise<void> {
  const fetcher = input.fetch ?? fetch;
  const response = await fetcher(
    `${input.baseUrl}/v1/environments/${encodeURIComponent(input.environmentId)}/endpoints/${input.endpoint.kind}`,
    {
      method: "PUT",
      credentials: "omit",
      headers: {
        authorization: `Bearer ${input.credential}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        httpBaseUrl: input.endpoint.httpBaseUrl,
        wsBaseUrl: input.endpoint.wsBaseUrl,
      }),
    },
  );
  const payload = await readJson(response);
  if (!response.ok) {
    throw new Error(connectErrorMessage(payload, "Could not publish this environment endpoint."));
  }
}

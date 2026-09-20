const TOKEN_STORAGE_PREFIX = "dispatch-connect:account-token:";

function storageKey(baseUrl: string): string {
  return `${TOKEN_STORAGE_PREFIX}${baseUrl.replace(/\/$/u, "")}`;
}

function storage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

export function readDispatchConnectAccountToken(baseUrl: string): string | null {
  const token = storage()?.getItem(storageKey(baseUrl))?.trim();
  return token ? token : null;
}

export function storeDispatchConnectAccountToken(baseUrl: string, token: string): void {
  const normalized = token.trim();
  if (!normalized) return;
  storage()?.setItem(storageKey(baseUrl), normalized);
}

export function clearDispatchConnectAccountToken(baseUrl: string): void {
  storage()?.removeItem(storageKey(baseUrl));
}

export function dispatchConnectAuthorizationHeader(baseUrl: string): string | null {
  const token = readDispatchConnectAccountToken(baseUrl);
  return token ? `Bearer ${token}` : null;
}

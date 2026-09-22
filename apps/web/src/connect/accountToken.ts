const TOKEN_STORAGE_PREFIX = "dispatch-connect:account-token:";
const TOKEN_CHANGE_EVENT = "dispatch:connect-account-token-change";

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

function notifyTokenChange(baseUrl: string): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(
    new CustomEvent(TOKEN_CHANGE_EVENT, {
      detail: { baseUrl: baseUrl.replace(/\/$/u, "") },
    }),
  );
}

export function readDispatchConnectAccountToken(baseUrl: string): string | null {
  const token = storage()?.getItem(storageKey(baseUrl))?.trim();
  return token ? token : null;
}

export function storeDispatchConnectAccountToken(baseUrl: string, token: string): void {
  const normalized = token.trim();
  if (!normalized) return;
  const target = storage();
  const key = storageKey(baseUrl);
  if (target?.getItem(key)?.trim() === normalized) return;
  target?.setItem(key, normalized);
  notifyTokenChange(baseUrl);
}

export function clearDispatchConnectAccountToken(baseUrl: string): void {
  const target = storage();
  const key = storageKey(baseUrl);
  if (target?.getItem(key) === null) return;
  target?.removeItem(key);
  notifyTokenChange(baseUrl);
}

export function subscribeDispatchConnectAccountToken(
  baseUrl: string,
  listener: () => void,
): () => void {
  if (typeof window === "undefined") return () => {};
  const normalizedBaseUrl = baseUrl.replace(/\/$/u, "");
  const key = storageKey(baseUrl);
  const onLocalChange = (event: Event) => {
    const detail = (event as CustomEvent<{ readonly baseUrl?: string }>).detail;
    if (detail?.baseUrl === normalizedBaseUrl) listener();
  };
  const onStorage = (event: StorageEvent) => {
    if (event.key === key) listener();
  };
  window.addEventListener(TOKEN_CHANGE_EVENT, onLocalChange);
  window.addEventListener("storage", onStorage);
  return () => {
    window.removeEventListener(TOKEN_CHANGE_EVENT, onLocalChange);
    window.removeEventListener("storage", onStorage);
  };
}

export function dispatchConnectAuthorizationHeader(baseUrl: string): string | null {
  const token = readDispatchConnectAccountToken(baseUrl);
  return token ? `Bearer ${token}` : null;
}

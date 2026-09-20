import { deviceAuthorizationClient } from "better-auth/client/plugins";
import { createAuthClient } from "better-auth/react";

import { readDispatchConnectAccountToken, storeDispatchConnectAccountToken } from "./accountToken";
import { resolveDispatchConnectUrl } from "./dispatchConnect";

function createDispatchConnectAuthClient(baseURL: string) {
  return createAuthClient({
    baseURL,
    fetchOptions: {
      credentials: "omit",
      auth: {
        type: "Bearer",
        token: () => readDispatchConnectAccountToken(baseURL) ?? undefined,
      },
      onSuccess(context) {
        const token = context.response.headers.get("set-auth-token")?.trim();
        if (token) storeDispatchConnectAccountToken(baseURL, token);
      },
    },
    plugins: [deviceAuthorizationClient()],
  });
}

export type DispatchConnectAuthClient = ReturnType<typeof createDispatchConnectAuthClient>;

let cachedClient: { readonly baseUrl: string; readonly client: DispatchConnectAuthClient } | null =
  null;

export function getDispatchConnectAuthClient(): DispatchConnectAuthClient | null {
  const baseUrl = resolveDispatchConnectUrl();
  if (!baseUrl) return null;
  if (cachedClient?.baseUrl === baseUrl) return cachedClient.client;
  const client = createDispatchConnectAuthClient(baseUrl);
  cachedClient = { baseUrl, client };
  return client;
}

import { expoClient } from "@better-auth/expo/client";
import { createAuthClient } from "better-auth/react";
import * as SecureStore from "expo-secure-store";

import { resolveDispatchConnectUrl } from "./dispatchConnect";

function createDispatchConnectAuthClient(baseURL: string) {
  return createAuthClient({
    baseURL,
    plugins: [
      expoClient({
        storage: SecureStore,
        storagePrefix: "dispatch-connect",
      }),
    ],
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

import { useCallback, useRef, useState, useSyncExternalStore, type ReactNode } from "react";

import {
  clearDispatchConnectAccountToken,
  readDispatchConnectAccountToken,
  subscribeDispatchConnectAccountToken,
} from "./accountToken";
import { getDispatchConnectAuthClient, type DispatchConnectAuthClient } from "./authClient";
import { describeDispatchConnectAuthError } from "./DispatchConnectAuthDialog";
import { resolveDispatchConnectUrl } from "./dispatchConnect";

export interface DispatchConnectAccountUserView {
  readonly name: string | null;
  readonly email: string | null;
  readonly image: string | null;
}

export interface DispatchConnectAccountView {
  readonly configured: boolean;
  readonly signedIn: boolean;
  readonly pending: boolean;
  readonly error: string | null;
  readonly accountToken: string | null;
  readonly user: DispatchConnectAccountUserView | null;
  readonly signOutPending: boolean;
  readonly signOut: () => Promise<boolean>;
  readonly refresh: () => void;
}

const UNCONFIGURED_ACCOUNT: DispatchConnectAccountView = {
  configured: false,
  signedIn: false,
  pending: false,
  error: null,
  accountToken: null,
  user: null,
  signOutPending: false,
  signOut: async () => false,
  refresh: () => {},
};

export function DispatchConnectAccountAccess({
  children,
}: {
  readonly children: (view: DispatchConnectAccountView) => ReactNode;
}) {
  const client = getDispatchConnectAuthClient();
  const baseUrl = resolveDispatchConnectUrl();
  if (!client || !baseUrl) return children(UNCONFIGURED_ACCOUNT);
  return (
    <ConfiguredDispatchConnectAccountAccess key={baseUrl} client={client} baseUrl={baseUrl}>
      {children}
    </ConfiguredDispatchConnectAccountAccess>
  );
}

function ConfiguredDispatchConnectAccountAccess({
  client,
  baseUrl,
  children,
}: {
  readonly client: DispatchConnectAuthClient;
  readonly baseUrl: string;
  readonly children: (view: DispatchConnectAccountView) => ReactNode;
}) {
  const { data: session, isPending, error, refetch } = client.useSession();
  const signOutInFlight = useRef(false);
  const [signOutPending, setSignOutPending] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const subscribe = useCallback(
    (listener: () => void) => subscribeDispatchConnectAccountToken(baseUrl, listener),
    [baseUrl],
  );
  const getSnapshot = useCallback(() => readDispatchConnectAccountToken(baseUrl), [baseUrl]);
  const accountToken = useSyncExternalStore(subscribe, getSnapshot, () => null);

  const refresh = useCallback(() => {
    setActionError(null);
    void refetch();
  }, [refetch]);

  const signOut = useCallback(async () => {
    if (signOutInFlight.current) return false;
    signOutInFlight.current = true;
    setSignOutPending(true);
    setActionError(null);
    try {
      const result = await client.signOut();
      if (result.error) {
        setActionError(
          describeDispatchConnectAuthError(
            result.error.message,
            "Could not sign out of Dispatch Connect.",
          ),
        );
        return false;
      }
      clearDispatchConnectAccountToken(baseUrl);
      await refetch();
      return true;
    } catch (cause) {
      setActionError(
        describeDispatchConnectAuthError(cause, "Could not sign out of Dispatch Connect."),
      );
      return false;
    } finally {
      signOutInFlight.current = false;
      setSignOutPending(false);
    }
  }, [baseUrl, client, refetch]);

  const sessionUser = session?.user;
  const user = sessionUser
    ? {
        name: sessionUser.name?.trim() || null,
        email: sessionUser.email?.trim() || null,
        image: sessionUser.image?.trim() || null,
      }
    : null;

  return children({
    configured: true,
    signedIn: !isPending && !error && session != null && accountToken !== null,
    pending: isPending,
    error:
      actionError ??
      (error
        ? describeDispatchConnectAuthError(
            error.message,
            "Could not load your Dispatch Connect account.",
          )
        : null),
    accountToken,
    user,
    signOutPending,
    signOut,
    refresh,
  });
}

export { DispatchConnectAuthActions } from "./DispatchConnectAuthDialog";

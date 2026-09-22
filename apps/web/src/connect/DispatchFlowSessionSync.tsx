import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId } from "@dispatch/contracts";
import { useCallback, useEffect, useRef, useSyncExternalStore } from "react";

import { appAtomRegistry } from "../rpc/atomRegistry";
import { environmentServerConfigsAtom } from "../state/server";
import { teamEnvironment } from "../state/team";
import { useAtomCommand } from "../state/use-atom-command";
import {
  readDispatchConnectAccountToken,
  subscribeDispatchConnectAccountToken,
} from "./accountToken";
import { getDispatchConnectAuthClient, type DispatchConnectAuthClient } from "./authClient";
import { resolveDispatchConnectUrl } from "./dispatchConnect";
import { dispatchFlowSessionPayload } from "./flowSession";

export function DispatchFlowSessionSync() {
  const client = getDispatchConnectAuthClient();
  const baseUrl = resolveDispatchConnectUrl();
  if (!client || !baseUrl) return null;
  return <ConfiguredDispatchFlowSessionSync client={client} baseUrl={baseUrl} />;
}

function ConfiguredDispatchFlowSessionSync({
  client,
  baseUrl,
}: {
  readonly client: DispatchConnectAuthClient;
  readonly baseUrl: string;
}) {
  const serverConfigs = useAtomValue(environmentServerConfigsAtom);
  const setSmartRoutingSession = useAtomCommand(teamEnvironment.setSmartRoutingSession, {
    reportFailure: false,
  });
  const { data: session, isPending, error, refetch } = client.useSession();
  const subscribe = useCallback(
    (listener: () => void) => subscribeDispatchConnectAccountToken(baseUrl, listener),
    [baseUrl],
  );
  const getSnapshot = useCallback(() => readDispatchConnectAccountToken(baseUrl), [baseUrl]);
  const accountToken = useSyncExternalStore(subscribe, getSnapshot, () => null);
  const lastSynced = useRef(new Map<EnvironmentId, string | null>());
  const lastSessionRefreshToken = useRef<string | null>(null);
  const syncQueue = useRef(Promise.resolve());

  useEffect(() => {
    if (!accountToken) {
      lastSessionRefreshToken.current = null;
      return;
    }
    if (!isPending && !error && !session && lastSessionRefreshToken.current !== accountToken) {
      lastSessionRefreshToken.current = accountToken;
      void refetch();
    }
  }, [accountToken, error, isPending, refetch, session]);

  // A token alone is not proof of an active Connect session. While session
  // validation is pending or failed, clear the server copy so Auto cannot keep
  // using a stale account credential. The persisted Flow mode itself is left alone.
  const desiredToken = !isPending && !error && session && accountToken ? accountToken : null;

  useEffect(() => {
    const targets = [...serverConfigs.entries()]
      .filter(([, config]) => config.teamRouting === true)
      .map(([environmentId]) => environmentId);
    const targetSet = new Set(targets);
    for (const environmentId of lastSynced.current.keys()) {
      if (!targetSet.has(environmentId)) lastSynced.current.delete(environmentId);
    }

    syncQueue.current = syncQueue.current.then(async () => {
      await Promise.all(
        targets.map(async (environmentId) => {
          if (lastSynced.current.get(environmentId) === desiredToken) return;
          const result = await setSmartRoutingSession({
            environmentId,
            input: dispatchFlowSessionPayload(baseUrl, desiredToken),
          });
          if (result._tag === "Failure") return;
          lastSynced.current.set(environmentId, desiredToken);
          appAtomRegistry.refresh(teamEnvironment.settings({ environmentId, input: {} }));
        }),
      );
    });
  }, [baseUrl, desiredToken, serverConfigs, setSmartRoutingSession]);

  return null;
}

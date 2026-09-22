import { useState } from "react";
import { DispatchConnectControlPlaneEnvironmentId } from "@dispatch/contracts";

import {
  DispatchConnectAccountAccess,
  DispatchConnectAuthActions,
  type DispatchConnectAccountView,
} from "../../connect/DispatchConnectAccountAccess";
import {
  createDispatchConnectEnvironment,
  listDispatchConnectEnvironments,
  resolveDispatchConnectUrl,
  rotateDispatchConnectEnvironmentCredential,
  type DispatchConnectEndpoint,
  upsertDispatchConnectEnvironmentEndpoint,
} from "../../connect/dispatchConnect";
import {
  configureDispatchConnectEnvironment,
  createDispatchConnectPairingChallenge,
  ensureDispatchConnectManagedEndpoint,
  fetchDispatchConnectEnvironmentIdentity,
} from "../../environments/primary";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogClose,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { QRCodeSvg } from "../ui/qr-code";
import { Spinner } from "../ui/spinner";
import { SettingsRow, SettingsSection } from "./settingsLayout";

export function DispatchConnectAccountSettings({
  tailscaleEndpoint,
}: {
  readonly tailscaleEndpoint?: DispatchConnectEndpoint | null;
}) {
  return (
    <DispatchConnectAccountAccess>
      {(account) =>
        account.configured ? (
          <ConfiguredDispatchConnectAccountSettings
            account={account}
            tailscaleEndpoint={tailscaleEndpoint ?? null}
          />
        ) : null
      }
    </DispatchConnectAccountAccess>
  );
}

function ConfiguredDispatchConnectAccountSettings({
  account,
  tailscaleEndpoint,
}: {
  readonly account: DispatchConnectAccountView;
  readonly tailscaleEndpoint: DispatchConnectEndpoint | null;
}) {
  const baseUrl = resolveDispatchConnectUrl();
  const [actionError, setActionError] = useState<string | null>(null);
  const [isActing, setIsActing] = useState(false);
  const [pairingOpen, setPairingOpen] = useState(false);
  const [pairingChallenge, setPairingChallenge] = useState<Awaited<
    ReturnType<typeof createDispatchConnectPairingChallenge>
  > | null>(null);
  const [remoteAccessStatus, setRemoteAccessStatus] = useState<string | null>(null);

  const pairDevice = async () => {
    if (!baseUrl) return;
    setActionError(null);
    setPairingChallenge(null);
    setIsActing(true);
    try {
      const identity = await fetchDispatchConnectEnvironmentIdentity();
      const environments = await listDispatchConnectEnvironments({ baseUrl });
      const existingEnvironment = environments.find(
        (environment) => environment.publicKey === identity.publicKey,
      );

      let environmentId: string;
      let credential: string;
      if (existingEnvironment) {
        environmentId = existingEnvironment.id;
        credential = await rotateDispatchConnectEnvironmentCredential({
          baseUrl,
          environmentId,
        });
      } else {
        const created = await createDispatchConnectEnvironment({
          baseUrl,
          label: identity.label,
          publicKey: identity.publicKey,
          endpoints: tailscaleEndpoint ? [tailscaleEndpoint] : [],
        });
        environmentId = created.environment.id;
        credential = created.credential;
      }

      await configureDispatchConnectEnvironment({
        baseUrl,
        environmentId: DispatchConnectControlPlaneEnvironmentId.make(environmentId),
        credential,
      });

      if (tailscaleEndpoint) {
        await upsertDispatchConnectEnvironmentEndpoint({
          baseUrl,
          environmentId,
          credential,
          endpoint: tailscaleEndpoint,
        });
      }

      let managedEndpointReady = false;
      try {
        const managedEndpoint = await ensureDispatchConnectManagedEndpoint();
        managedEndpointReady = managedEndpoint.status === "running";
        if (!managedEndpointReady && !tailscaleEndpoint) {
          throw new Error(
            managedEndpoint.status === "failed"
              ? managedEndpoint.reason
              : "This Dispatch Connect deployment does not provide managed internet access. Enable Tailscale or configure a managed tunnel on the Connect server.",
          );
        }
      } catch (cause) {
        if (!tailscaleEndpoint) throw cause;
      }

      const challenge = await createDispatchConnectPairingChallenge({ label: "Dispatch device" });
      setPairingChallenge(challenge);
      setRemoteAccessStatus(
        tailscaleEndpoint
          ? managedEndpointReady
            ? "Tailscale preferred · managed internet fallback ready"
            : "Tailscale ready"
          : "Managed internet access ready",
      );
      setPairingOpen(true);
    } catch (cause) {
      setActionError(
        cause instanceof Error
          ? cause.message
          : "Could not prepare Dispatch Connect remote access.",
      );
    } finally {
      setIsActing(false);
    }
  };

  const accountDescription = account.user?.email
    ? account.user.email
    : "Optional account for discovering and pairing your environments. Direct pairing works without an account.";

  return (
    <SettingsSection title="Dispatch Connect">
      <SettingsRow
        title="Account"
        description={accountDescription}
        status={actionError ?? account.error}
        control={
          account.pending ? (
            <span className="inline-flex h-7 items-center gap-2 text-xs text-muted-foreground">
              <Spinner className="size-3.5" />
              Checking…
            </span>
          ) : account.signedIn ? (
            <Button
              size="sm"
              variant="outline"
              disabled={isActing || account.signOutPending}
              onClick={() => void account.signOut()}
            >
              {account.signOutPending ? "Signing out…" : "Sign out"}
            </Button>
          ) : account.error ? (
            <Button size="sm" variant="outline" disabled={isActing} onClick={account.refresh}>
              Retry
            </Button>
          ) : (
            <DispatchConnectAuthActions disabled={isActing} onAuthenticated={account.refresh} />
          )
        }
      />
      {account.signedIn ? (
        <SettingsRow
          title="Remote access"
          description={
            remoteAccessStatus ??
            "Pair another Dispatch device. Tailscale is preferred when available; managed internet access is the fallback."
          }
          status={actionError}
          control={
            <Dialog open={pairingOpen} onOpenChange={setPairingOpen}>
              <Button size="sm" disabled={isActing} onClick={() => void pairDevice()}>
                {isActing ? (
                  <>
                    <Spinner className="size-3.5" />
                    Preparing…
                  </>
                ) : (
                  "Pair device"
                )}
              </Button>
              <DialogPopup className="sm:max-w-md">
                <DialogHeader>
                  <DialogTitle>Pair with Dispatch Connect</DialogTitle>
                  <DialogDescription>
                    Scan this QR code in Dispatch, or enter the same one-time code on the other
                    device.
                  </DialogDescription>
                </DialogHeader>
                <DialogPanel className="space-y-4">
                  {pairingChallenge ? (
                    <>
                      <div className="flex justify-center rounded-xl border border-border/60 bg-muted/30 p-4">
                        <QRCodeSvg
                          value={`dispatch://connect/pair?code=${encodeURIComponent(pairingChallenge.shortCode)}`}
                          size={160}
                          level="M"
                          marginSize={2}
                          title="Dispatch Connect pairing code"
                        />
                      </div>
                      <div className="rounded-lg border border-border/70 bg-muted/20 px-4 py-3 text-center">
                        <p className="text-xs text-muted-foreground">Pairing code</p>
                        <p className="mt-1 font-mono text-xl font-semibold tracking-[0.16em]">
                          {pairingChallenge.shortCode}
                        </p>
                      </div>
                    </>
                  ) : null}
                </DialogPanel>
                <DialogFooter>
                  <DialogClose render={<Button variant="outline" />}>Done</DialogClose>
                </DialogFooter>
              </DialogPopup>
            </Dialog>
          }
        />
      ) : null}
    </SettingsSection>
  );
}

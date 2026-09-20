import { useState } from "react";
import { DispatchConnectControlPlaneEnvironmentId } from "@dispatch/contracts";

import {
  getDispatchConnectAuthClient,
  type DispatchConnectAuthClient,
} from "../../connect/authClient";
import { clearDispatchConnectAccountToken } from "../../connect/accountToken";
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
import { Input } from "../ui/input";
import { QRCodeSvg } from "../ui/qr-code";
import { Spinner } from "../ui/spinner";
import { SettingsRow, SettingsSection } from "./settingsLayout";

export function DispatchConnectAccountSettings({
  tailscaleEndpoint,
}: {
  readonly tailscaleEndpoint?: DispatchConnectEndpoint | null;
}) {
  const client = getDispatchConnectAuthClient();
  if (!client) return null;
  return (
    <ConfiguredDispatchConnectAccountSettings
      client={client}
      tailscaleEndpoint={tailscaleEndpoint ?? null}
    />
  );
}

function ConfiguredDispatchConnectAccountSettings({
  client,
  tailscaleEndpoint,
}: {
  readonly client: DispatchConnectAuthClient;
  readonly tailscaleEndpoint: DispatchConnectEndpoint | null;
}) {
  const baseUrl = resolveDispatchConnectUrl();
  const { data: session, isPending, error, refetch } = client.useSession();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [actionError, setActionError] = useState<string | null>(null);
  const [isActing, setIsActing] = useState(false);
  const [authMode, setAuthMode] = useState<"sign-in" | "sign-up">("sign-in");
  const [pairingOpen, setPairingOpen] = useState(false);
  const [pairingChallenge, setPairingChallenge] = useState<Awaited<
    ReturnType<typeof createDispatchConnectPairingChallenge>
  > | null>(null);
  const [remoteAccessStatus, setRemoteAccessStatus] = useState<string | null>(null);

  const signIn = async () => {
    const normalizedEmail = email.trim();
    if (!normalizedEmail || !password) {
      setActionError("Enter your email and password.");
      return;
    }
    setActionError(null);
    setIsActing(true);
    try {
      const result = await client.signIn.email({ email: normalizedEmail, password });
      if (result.error) {
        setActionError(result.error.message ?? "Could not sign in to Dispatch Connect.");
        return;
      }
      await refetch();
      setPassword("");
      setDialogOpen(false);
    } catch (cause) {
      setActionError(
        cause instanceof Error ? cause.message : "Could not sign in to Dispatch Connect.",
      );
    } finally {
      setIsActing(false);
    }
  };

  const signUp = async () => {
    const normalizedEmail = email.trim();
    if (!normalizedEmail || !password) {
      setActionError("Enter your email and password.");
      return;
    }
    setActionError(null);
    setIsActing(true);
    try {
      const result = await client.signUp.email({
        email: normalizedEmail,
        password,
        name: normalizedEmail,
      });
      if (result.error) {
        setActionError(result.error.message ?? "Could not create the Dispatch Connect account.");
        return;
      }
      await refetch();
      setPassword("");
      setDialogOpen(false);
    } catch (cause) {
      setActionError(
        cause instanceof Error ? cause.message : "Could not create the Dispatch Connect account.",
      );
    } finally {
      setIsActing(false);
    }
  };

  const openAuthDialog = (mode: "sign-in" | "sign-up") => {
    setAuthMode(mode);
    setActionError(null);
    setDialogOpen(true);
  };

  const signOut = async () => {
    setActionError(null);
    setIsActing(true);
    try {
      const result = await client.signOut();
      if (result.error) {
        setActionError(result.error.message ?? "Could not sign out of Dispatch Connect.");
        return;
      }
      if (baseUrl) clearDispatchConnectAccountToken(baseUrl);
      await refetch();
    } catch (cause) {
      setActionError(
        cause instanceof Error ? cause.message : "Could not sign out of Dispatch Connect.",
      );
    } finally {
      setIsActing(false);
    }
  };

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

  const sessionError = error?.message ?? null;
  const accountDescription = session?.user.email
    ? session.user.email
    : "Optional account for discovering and pairing your environments. Direct pairing works without an account.";

  return (
    <SettingsSection title="Dispatch Connect">
      <SettingsRow
        title="Account"
        description={accountDescription}
        status={actionError ?? sessionError}
        control={
          isPending ? (
            <span className="inline-flex h-7 items-center gap-2 text-xs text-muted-foreground">
              <Spinner className="size-3.5" />
              Checking…
            </span>
          ) : session ? (
            <Button size="sm" variant="outline" disabled={isActing} onClick={() => void signOut()}>
              {isActing ? "Signing out…" : "Sign out"}
            </Button>
          ) : (
            <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
              <div className="flex items-center gap-2">
                <Button size="sm" variant="outline" onClick={() => openAuthDialog("sign-in")}>
                  Sign in
                </Button>
                <Button size="sm" variant="outline" onClick={() => openAuthDialog("sign-up")}>
                  Create account
                </Button>
              </div>
              <DialogPopup className="sm:max-w-md">
                <DialogHeader>
                  <DialogTitle>
                    {authMode === "sign-in"
                      ? "Sign in to Dispatch Connect"
                      : "Create Dispatch Connect account"}
                  </DialogTitle>
                  <DialogDescription>
                    Connect is optional. An account lets this client discover environments linked to
                    you.
                  </DialogDescription>
                </DialogHeader>
                <DialogPanel className="space-y-3">
                  <label className="block space-y-1.5">
                    <span className="text-xs font-medium text-foreground">Email</span>
                    <Input
                      type="email"
                      autoComplete="email"
                      value={email}
                      disabled={isActing}
                      onChange={(event) => setEmail(event.target.value)}
                    />
                  </label>
                  <label className="block space-y-1.5">
                    <span className="text-xs font-medium text-foreground">Password</span>
                    <Input
                      type="password"
                      autoComplete="current-password"
                      value={password}
                      disabled={isActing}
                      onChange={(event) => setPassword(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") {
                          void (authMode === "sign-in" ? signIn() : signUp());
                        }
                      }}
                    />
                  </label>
                  {actionError ? <p className="text-xs text-destructive">{actionError}</p> : null}
                </DialogPanel>
                <DialogFooter>
                  <DialogClose render={<Button variant="outline" disabled={isActing} />}>
                    Cancel
                  </DialogClose>
                  <Button
                    disabled={isActing}
                    onClick={() => void (authMode === "sign-in" ? signIn() : signUp())}
                  >
                    {isActing
                      ? authMode === "sign-in"
                        ? "Signing in…"
                        : "Creating…"
                      : authMode === "sign-in"
                        ? "Sign in"
                        : "Create account"}
                  </Button>
                </DialogFooter>
              </DialogPopup>
            </Dialog>
          )
        }
      />
      {session ? (
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

import { useCallback, useState, useSyncExternalStore, type ReactNode } from "react";

import { Button } from "../components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../components/ui/dialog";
import { Input } from "../components/ui/input";
import { Spinner } from "../components/ui/spinner";
import {
  readDispatchConnectAccountToken,
  subscribeDispatchConnectAccountToken,
} from "./accountToken";
import { getDispatchConnectAuthClient, type DispatchConnectAuthClient } from "./authClient";
import { resolveDispatchConnectUrl } from "./dispatchConnect";

export interface DispatchConnectAccountView {
  readonly configured: boolean;
  readonly signedIn: boolean;
  readonly pending: boolean;
  readonly error: string | null;
  readonly accountToken: string | null;
  readonly refresh: () => void;
}

const UNCONFIGURED_ACCOUNT: DispatchConnectAccountView = {
  configured: false,
  signedIn: false,
  pending: false,
  error: null,
  accountToken: null,
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
    <ConfiguredDispatchConnectAccountAccess client={client} baseUrl={baseUrl}>
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
  const subscribe = useCallback(
    (listener: () => void) => subscribeDispatchConnectAccountToken(baseUrl, listener),
    [baseUrl],
  );
  const getSnapshot = useCallback(() => readDispatchConnectAccountToken(baseUrl), [baseUrl]);
  const accountToken = useSyncExternalStore(subscribe, getSnapshot, () => null);
  return children({
    configured: true,
    signedIn: !isPending && !error && session != null && accountToken !== null,
    pending: isPending,
    error: error?.message ?? null,
    accountToken,
    refresh: () => void refetch(),
  });
}

export function DispatchConnectAuthActions({
  onAuthenticated,
  disabled = false,
}: {
  readonly onAuthenticated?: () => void | Promise<void>;
  readonly disabled?: boolean;
}) {
  const client = getDispatchConnectAuthClient();
  if (!client) return null;
  return (
    <ConfiguredDispatchConnectAuthActions
      client={client}
      onAuthenticated={onAuthenticated}
      disabled={disabled}
    />
  );
}

function ConfiguredDispatchConnectAuthActions({
  client,
  onAuthenticated,
  disabled,
}: {
  readonly client: DispatchConnectAuthClient;
  readonly onAuthenticated: (() => void | Promise<void>) | undefined;
  readonly disabled: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<"sign-in" | "sign-up">("sign-in");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function show(nextMode: "sign-in" | "sign-up") {
    setMode(nextMode);
    setError(null);
    setOpen(true);
  }

  async function submit() {
    if (pending) return;
    const normalizedEmail = email.trim();
    if (!normalizedEmail || !password) {
      setError("Enter your email and password.");
      return;
    }
    setPending(true);
    setError(null);
    try {
      const result =
        mode === "sign-in"
          ? await client.signIn.email({ email: normalizedEmail, password })
          : await client.signUp.email({
              email: normalizedEmail,
              password,
              name: normalizedEmail,
            });
      if (result.error) {
        setError(
          result.error.message ??
            (mode === "sign-in"
              ? "Could not sign in to Dispatch Connect."
              : "Could not create the Dispatch Connect account."),
        );
        return;
      }
      setPassword("");
      setOpen(false);
      await onAuthenticated?.();
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : mode === "sign-in"
            ? "Could not sign in to Dispatch Connect."
            : "Could not create the Dispatch Connect account.",
      );
    } finally {
      setPending(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" variant="outline" disabled={disabled} onClick={() => show("sign-in")}>
          Sign in
        </Button>
        <Button size="sm" variant="ghost" disabled={disabled} onClick={() => show("sign-up")}>
          Create account
        </Button>
      </div>
      <DialogPopup className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>
            {mode === "sign-in" ? "Sign in to Dispatch Connect" : "Create Dispatch Connect account"}
          </DialogTitle>
          <DialogDescription>
            Dispatch Connect is required for Flow Auto. Standard works without an account.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel className="space-y-3">
          <label className="block space-y-1.5">
            <span className="text-xs font-medium text-foreground">Email</span>
            <Input
              type="email"
              autoComplete="email"
              value={email}
              disabled={pending}
              onChange={(event) => setEmail(event.target.value)}
            />
          </label>
          <label className="block space-y-1.5">
            <span className="text-xs font-medium text-foreground">Password</span>
            <Input
              type="password"
              autoComplete={mode === "sign-in" ? "current-password" : "new-password"}
              value={password}
              disabled={pending}
              onChange={(event) => setPassword(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") void submit();
              }}
            />
          </label>
          {error ? (
            <p role="alert" className="text-xs text-destructive">
              {error}
            </p>
          ) : null}
        </DialogPanel>
        <DialogFooter>
          <DialogClose render={<Button variant="outline" disabled={pending} />}>Cancel</DialogClose>
          <Button disabled={pending} onClick={() => void submit()}>
            {pending ? (
              <>
                <Spinner className="size-3.5" />
                {mode === "sign-in" ? "Signing in…" : "Creating…"}
              </>
            ) : mode === "sign-in" ? (
              "Sign in"
            ) : (
              "Create account"
            )}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

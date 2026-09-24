import { useId, useRef, useState, type FormEvent, type ReactNode } from "react";

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
import { getDispatchConnectAuthClient, type DispatchConnectAuthClient } from "./authClient";

export type DispatchConnectAuthMode = "sign-in" | "sign-up";

export function describeDispatchConnectAuthError(cause: unknown, fallback: string): string {
  const message =
    cause instanceof Error ? cause.message.trim() : typeof cause === "string" ? cause.trim() : "";
  if (/failed to fetch|load failed|networkerror|network request failed/iu.test(message)) {
    return "Could not reach Dispatch Connect. Check your connection and try again.";
  }
  return message || fallback;
}

function validateCredentials(email: string, password: string): string | null {
  if (!email || !password) return "Enter your email and password.";
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(email)) return "Enter a valid email address.";
  return null;
}

interface DispatchConnectAuthDialogControls {
  readonly openSignIn: () => void;
  readonly openSignUp: () => void;
}

export function DispatchConnectAuthDialog({
  children,
  disabled = false,
  onAuthenticated,
}: {
  readonly children: (controls: DispatchConnectAuthDialogControls) => ReactNode;
  readonly disabled?: boolean;
  readonly onAuthenticated?: (() => void | Promise<void>) | undefined;
}) {
  const client = getDispatchConnectAuthClient();
  if (!client) return null;
  return (
    <ConfiguredDispatchConnectAuthDialog
      client={client}
      disabled={disabled}
      onAuthenticated={onAuthenticated}
    >
      {children}
    </ConfiguredDispatchConnectAuthDialog>
  );
}

function ConfiguredDispatchConnectAuthDialog({
  children,
  client,
  disabled,
  onAuthenticated,
}: {
  readonly children: (controls: DispatchConnectAuthDialogControls) => ReactNode;
  readonly client: DispatchConnectAuthClient;
  readonly disabled: boolean;
  readonly onAuthenticated: (() => void | Promise<void>) | undefined;
}) {
  const emailId = useId();
  const passwordId = useId();
  const submitInFlight = useRef(false);
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<DispatchConnectAuthMode>("sign-in");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function openMode(nextMode: DispatchConnectAuthMode) {
    if (disabled) return;
    setMode(nextMode);
    setError(null);
    setOpen(true);
  }

  function handleOpenChange(nextOpen: boolean) {
    if (!nextOpen && submitInFlight.current) return;
    if (!nextOpen) {
      setPassword("");
      setError(null);
    }
    setOpen(nextOpen);
  }

  function switchMode(nextMode: DispatchConnectAuthMode) {
    setMode(nextMode);
    setError(null);
  }

  async function submit(event?: FormEvent<HTMLFormElement>) {
    event?.preventDefault();
    if (submitInFlight.current) return;
    const normalizedEmail = email.trim();
    const validationError = validateCredentials(normalizedEmail, password);
    if (validationError) {
      setError(validationError);
      return;
    }

    submitInFlight.current = true;
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
          describeDispatchConnectAuthError(
            result.error.message,
            mode === "sign-in"
              ? "Could not sign in to Dispatch Connect."
              : "Could not create the Dispatch Connect account.",
          ),
        );
        return;
      }

      setPassword("");
      setOpen(false);
      await onAuthenticated?.();
    } catch (cause) {
      setError(
        describeDispatchConnectAuthError(
          cause,
          mode === "sign-in"
            ? "Could not sign in to Dispatch Connect."
            : "Could not create the Dispatch Connect account.",
        ),
      );
    } finally {
      submitInFlight.current = false;
      setPending(false);
    }
  }

  const controls: DispatchConnectAuthDialogControls = {
    openSignIn: () => openMode("sign-in"),
    openSignUp: () => openMode("sign-up"),
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      {children(controls)}
      <DialogPopup className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>
            {mode === "sign-in" ? "Sign in to Dispatch Connect" : "Create Dispatch Connect account"}
          </DialogTitle>
          <DialogDescription>
            An account enables environment discovery and pairing plus Flow Auto. Standard and direct
            pairing work without an account.
          </DialogDescription>
        </DialogHeader>
        <form className="flex min-h-0 flex-col" onSubmit={(event) => void submit(event)}>
          <DialogPanel className="space-y-3">
            <label className="block space-y-1.5" htmlFor={emailId}>
              <span className="text-xs font-medium text-foreground">Email</span>
              <Input
                id={emailId}
                name="email"
                type="email"
                autoComplete="email"
                value={email}
                disabled={pending}
                required
                onChange={(event) => setEmail(event.target.value)}
              />
            </label>
            <label className="block space-y-1.5" htmlFor={passwordId}>
              <span className="text-xs font-medium text-foreground">Password</span>
              <Input
                id={passwordId}
                name="password"
                type="password"
                autoComplete={mode === "sign-in" ? "current-password" : "new-password"}
                value={password}
                disabled={pending}
                required
                onChange={(event) => setPassword(event.target.value)}
              />
            </label>
            <p className="text-xs text-muted-foreground">
              {mode === "sign-in" ? "New to Dispatch Connect?" : "Already have an account?"}{" "}
              <Button
                type="button"
                size="micro"
                variant="link"
                className="h-auto px-0 align-baseline"
                disabled={pending}
                onClick={() => switchMode(mode === "sign-in" ? "sign-up" : "sign-in")}
              >
                {mode === "sign-in" ? "Create account" : "Sign in"}
              </Button>
            </p>
            {error ? (
              <p role="alert" className="text-xs text-destructive">
                {error}
              </p>
            ) : null}
          </DialogPanel>
          <DialogFooter>
            <DialogClose render={<Button variant="outline" disabled={pending} />}>
              Cancel
            </DialogClose>
            <Button type="submit" disabled={pending}>
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
        </form>
      </DialogPopup>
    </Dialog>
  );
}

export function DispatchConnectAuthActions({
  onAuthenticated,
  disabled = false,
}: {
  readonly onAuthenticated?: () => void | Promise<void>;
  readonly disabled?: boolean;
}) {
  return (
    <DispatchConnectAuthDialog disabled={disabled} onAuthenticated={onAuthenticated}>
      {({ openSignIn, openSignUp }) => (
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" variant="outline" disabled={disabled} onClick={openSignIn}>
            Sign in
          </Button>
          <Button size="sm" variant="ghost" disabled={disabled} onClick={openSignUp}>
            Create account
          </Button>
        </div>
      )}
    </DispatchConnectAuthDialog>
  );
}

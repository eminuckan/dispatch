import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";

import {
  getDispatchConnectAuthClient,
  type DispatchConnectAuthClient,
} from "../connect/authClient";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Spinner } from "../components/ui/spinner";
import { StandalonePage, StandalonePageHeader } from "../components/ui/standalone-page";

type DeviceAuthorizationSearch = {
  readonly user_code?: string;
};

export const Route = createFileRoute("/device")({
  validateSearch: (search: Record<string, unknown>): DeviceAuthorizationSearch => ({
    ...(typeof search.user_code === "string" ? { user_code: search.user_code } : {}),
  }),
  component: DeviceAuthorizationRoute,
});

function formatDeviceUserCode(value: string): string {
  const raw = value
    .toUpperCase()
    .replace(/[^A-Z0-9]/gu, "")
    .slice(0, 32);
  return raw.match(/.{1,4}/gu)?.join("-") ?? "";
}

function DeviceAuthorizationRoute() {
  const client = getDispatchConnectAuthClient();
  if (!client) {
    return (
      <StandalonePage tone="brand">
        <StandalonePageHeader
          eyebrow="Dispatch Connect"
          title="Connect is not configured"
          description="This Dispatch build does not have a Dispatch Connect URL configured."
        />
      </StandalonePage>
    );
  }
  return <DeviceAuthorizationSurface client={client} />;
}

function DeviceAuthorizationSurface({ client }: { readonly client: DispatchConnectAuthClient }) {
  const search = Route.useSearch();
  const { data: session, isPending: sessionPending, refetch } = client.useSession();
  const [userCode, setUserCode] = useState(() => formatDeviceUserCode(search.user_code ?? ""));
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [request, setRequest] = useState<{
    readonly userCode: string;
    readonly clientId: string;
    readonly scope: string;
  } | null>(null);
  const [result, setResult] = useState<"approved" | "denied" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isActing, setIsActing] = useState(false);

  useEffect(() => {
    if (search.user_code) {
      setUserCode(formatDeviceUserCode(search.user_code));
      setRequest(null);
      setResult(null);
      setError(null);
    }
  }, [search.user_code]);

  const authenticate = async (mode: "sign-in" | "sign-up") => {
    const normalizedEmail = email.trim();
    if (!normalizedEmail || !password) {
      setError("Enter your email and password.");
      return;
    }
    setError(null);
    setIsActing(true);
    try {
      const authResult =
        mode === "sign-in"
          ? await client.signIn.email({ email: normalizedEmail, password })
          : await client.signUp.email({
              email: normalizedEmail,
              password,
              name: normalizedEmail,
            });
      if (authResult.error) {
        setError(
          authResult.error.message ??
            (mode === "sign-in"
              ? "Could not sign in to Dispatch Connect."
              : "Could not create the Dispatch Connect account."),
        );
        return;
      }
      setPassword("");
      await refetch();
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Could not authenticate with Dispatch Connect.",
      );
    } finally {
      setIsActing(false);
    }
  };

  const verifyRequest = async () => {
    const normalizedCode = formatDeviceUserCode(userCode);
    if (!normalizedCode) {
      setError("Enter the code shown by your Dispatch CLI.");
      return;
    }
    setError(null);
    setIsActing(true);
    try {
      const verification = await client.device({ query: { user_code: normalizedCode } });
      if (verification.error) {
        setError(
          verification.error.error_description ??
            "That device authorization request is not available.",
        );
        return;
      }
      setUserCode(formatDeviceUserCode(verification.data.user_code));
      setRequest({
        userCode: verification.data.user_code,
        clientId: verification.data.client_id ?? "Unknown client",
        scope: verification.data.scope ?? "Account session",
      });
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Could not verify the device authorization request.",
      );
    } finally {
      setIsActing(false);
    }
  };

  const resolveRequest = async (decision: "approve" | "deny") => {
    if (!request) return;
    setError(null);
    setIsActing(true);
    try {
      const response =
        decision === "approve"
          ? await client.device.approve({ userCode: request.userCode })
          : await client.device.deny({ userCode: request.userCode });
      if (response.error) {
        setError(response.error.error_description ?? `Could not ${decision} this device request.`);
        return;
      }
      setResult(decision === "approve" ? "approved" : "denied");
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : `Could not ${decision} this device request.`,
      );
    } finally {
      setIsActing(false);
    }
  };

  return (
    <StandalonePage tone="brand">
      <StandalonePageHeader
        eyebrow="Dispatch Connect"
        title="Authorize a Dispatch CLI"
        description="Only continue when this code matches the one shown by the CLI you started."
      />

      {sessionPending ? (
        <div className="mt-8 flex items-center gap-2 text-sm text-muted-foreground">
          <Spinner className="size-4" />
          Checking account…
        </div>
      ) : !session ? (
        <div className="mt-8 space-y-4">
          <div className="grid gap-3">
            <label className="grid gap-1.5">
              <span className="text-xs font-medium text-foreground">Email</span>
              <Input
                type="email"
                autoComplete="email"
                value={email}
                disabled={isActing}
                onChange={(event) => setEmail(event.target.value)}
              />
            </label>
            <label className="grid gap-1.5">
              <span className="text-xs font-medium text-foreground">Password</span>
              <Input
                type="password"
                autoComplete="current-password"
                value={password}
                disabled={isActing}
                onChange={(event) => setPassword(event.target.value)}
              />
            </label>
          </div>
          {error ? <p className="text-sm text-destructive">{error}</p> : null}
          <div className="flex flex-wrap gap-2">
            <Button disabled={isActing} onClick={() => void authenticate("sign-in")}>
              {isActing ? "Working…" : "Sign in"}
            </Button>
            <Button
              variant="outline"
              disabled={isActing}
              onClick={() => void authenticate("sign-up")}
            >
              Create account
            </Button>
          </div>
        </div>
      ) : result ? (
        <div className="mt-8 space-y-3">
          <h2 className="text-lg font-medium">
            {result === "approved" ? "CLI authorized" : "Request denied"}
          </h2>
          <p className="text-sm leading-relaxed text-muted-foreground">
            {result === "approved"
              ? "You can return to the terminal. The CLI will finish signing in there."
              : "The CLI request was denied. You can close this page."}
          </p>
        </div>
      ) : request ? (
        <div className="mt-8 space-y-5">
          <div className="rounded-xl border border-border/70 bg-muted/25 p-4">
            <p className="text-xs font-medium text-muted-foreground">Code</p>
            <p className="mt-1 font-mono text-lg font-semibold tracking-[0.12em]">
              {formatDeviceUserCode(request.userCode)}
            </p>
            <dl className="mt-4 grid gap-3 text-sm">
              <div>
                <dt className="text-xs text-muted-foreground">Client</dt>
                <dd className="mt-0.5 font-medium">
                  {request.clientId === "dispatch-cli" ? "Dispatch CLI" : request.clientId}
                </dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">Requested access</dt>
                <dd className="mt-0.5 break-words">{request.scope}</dd>
              </div>
            </dl>
          </div>
          <p className="text-sm leading-relaxed text-muted-foreground">
            Approving signs that CLI into your Dispatch Connect account. Do not approve a code you
            received from someone else or from an unexpected page.
          </p>
          {error ? <p className="text-sm text-destructive">{error}</p> : null}
          <div className="flex flex-wrap gap-2">
            <Button disabled={isActing} onClick={() => void resolveRequest("approve")}>
              {isActing ? "Working…" : "Approve"}
            </Button>
            <Button
              variant="outline"
              disabled={isActing}
              onClick={() => void resolveRequest("deny")}
            >
              Deny
            </Button>
          </div>
        </div>
      ) : (
        <div className="mt-8 space-y-4">
          <label className="grid gap-1.5">
            <span className="text-xs font-medium text-foreground">CLI code</span>
            <Input
              value={userCode}
              autoComplete="one-time-code"
              autoCapitalize="characters"
              spellCheck={false}
              disabled={isActing}
              placeholder="ABCD-EFGH"
              onChange={(event) => {
                setUserCode(formatDeviceUserCode(event.target.value));
                setError(null);
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter") void verifyRequest();
              }}
            />
          </label>
          <p className="text-sm leading-relaxed text-muted-foreground">
            This is the short authorization code printed by the CLI. It is separate from an
            environment pairing code.
          </p>
          {error ? <p className="text-sm text-destructive">{error}</p> : null}
          <Button disabled={isActing || userCode.length === 0} onClick={() => void verifyRequest()}>
            {isActing ? "Checking…" : "Continue"}
          </Button>
        </div>
      )}
    </StandalonePage>
  );
}

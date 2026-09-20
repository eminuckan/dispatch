# Dispatch Connect deployment

Dispatch Connect is the optional Dispatch-owned control plane. The reference deployment is intentionally
small: one Connect service and one PostgreSQL database. It is suitable for Dokploy or any Docker Compose
host that can terminate HTTPS and keep PostgreSQL on a private network.

The service does not replace environment authentication. It stores account/device/environment discovery,
one-time pairing rendezvous state, and advertised Tailscale or managed Cloudflare endpoints. Projects,
threads, files, provider credentials, and the environment session remain on the Dispatch host.

## Dokploy

Use [`deploy/dispatch-connect/compose.yaml`](../../deploy/dispatch-connect/compose.yaml) with the repository
root as the build context. Route one HTTPS hostname to the `connect` service on port `8787`. Do not expose
the `postgres` service publicly.

Start from [`deploy/dispatch-connect/.env.example`](../../deploy/dispatch-connect/.env.example) and set:

- `DISPATCH_CONNECT_PUBLIC_URL` to the exact public HTTPS origin, such as `https://connect.example.com`.
- `POSTGRES_PASSWORD` to a unique database password.
- `BETTER_AUTH_SECRET` to a high-entropy secret used only for account/session authentication.
- `CONNECT_CREDENTIAL_SECRET` to a different high-entropy secret used to HMAC environment credentials and
  pairing rendezvous codes at rest.
- `CONNECT_ALLOWED_ORIGINS` to the web/native origins that may call the service. Wildcards are supported
  for variable Dispatch web origins, such as `http://127.0.0.1:*`, Tailscale's `https://*.ts.net`, or
  the deployment-owned `https://*.remote.example.com`. Do not use a blanket wildcard in production.

Headless `dispatch connect` account authorization works with the same two-service deployment: Connect
serves a minimal approval UI at `${DISPATCH_CONNECT_PUBLIC_URL}/device`. Set
`CONNECT_DEVICE_VERIFICATION_URL` only when you intentionally want to send approvals to another hosted
Dispatch web surface.

Managed Cloudflare Tunnel is optional. To enable the zero-configuration internet fallback, set all four
variables together:

- `CLOUDFLARE_ACCOUNT_ID` for the operator-owned Cloudflare account.
- `CLOUDFLARE_API_TOKEN` with Cloudflare Tunnel Edit on that account and DNS Write on the selected zone.
- `CLOUDFLARE_ZONE_ID` for the existing DNS zone.
- `CONNECT_TUNNEL_DOMAIN` to an existing Cloudflare-managed base domain such as `remote.example.com`.

Connect does not create zones. If none of the four values are set, managed tunnels are disabled. Partial
configuration fails startup so the deployment cannot silently run with a half-configured remote path.

An environment's `dce_...` credential is sufficient to create, reconnect, and delete that environment's
managed tunnel. Account credentials are therefore never copied into the Dispatch environment just to
manage transport lifecycle.

Generate secrets independently, for example with `openssl rand -base64 48`. Never copy the example values
into production.

The process runs Better Auth migrations and the small Connect schema migration idempotently at startup.
`GET /health` verifies database reachability and is the container health check used by the Compose file.
Take regular PostgreSQL backups; the named volume is persistence, not a backup.

## Account and pairing boundaries

Better Auth owns optional human account sessions. Device and environment records are Dispatch records.
Creating or signing into an account does not mint an environment session.

For manual pairing, the environment creates the canonical 12-character one-time EnvironmentAuth
credential. The same credential is registered with Connect as a hashed, expiring rendezvous code and shown
as `XXXX-XXXX-XXXX`. A signed-in client redeems the code to discover the environment and its endpoints,
then exchanges that same credential with the environment for the normal scoped Dispatch session. The raw
pairing code is never persisted by Connect.

QR pairing can continue to encode the direct environment URL and credential in the URL fragment. That path
does not require Dispatch Connect when the receiving device can already reach the environment.

## Transport configuration

Connect records transport endpoints separately from authorization. Tailscale is preferred when a usable
tailnet endpoint is available. A Dispatch-managed Cloudflare Tunnel is the zero-configuration internet
fallback. Both routes still require the environment's Dispatch session checks.

Cloudflare credentials, when managed tunnel provisioning is enabled, belong to the Dispatch Connect
deployment rather than to individual end users. Keep those credentials server-side. A self-hosted operator
may choose to use only Tailscale and omit Cloudflare entirely.

## Legacy relay

[`infra/relay`](../../infra/relay) is the upstream T3 Connect compatibility service. It is not required for
Dispatch Connect. Its GitHub deployment workflow is manual and guarded by
`DISPATCH_RELEASE_ENABLE_T3_CONNECT`; do not configure Clerk/PlanetScale/Axiom merely to operate the new
Connect service.

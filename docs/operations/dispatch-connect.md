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

## Hosted Smart Routing

Flow Standard runs entirely through the environment's saved agent profiles. Auto uses this Connect
service for execution routing, profile selection, and explicitly requested profile recommendations.
The operator's `CONNECT_JEV_API_KEY` belongs only in the hosted service's secret environment. Do not add
it to a desktop build, a web build, or a distributed environment server. An unset key or
`CONNECT_SMART_ROUTING_ENABLED=false` leaves hosted routing unavailable while Standard remains usable.

Routing requests require both the environment's `dce_` credential and an existing Better Auth account
session belonging to that environment's owner. Connect verifies the session and rechecks its database
expiry, owner, and revocation when admitting a paid request. The account session is a write-only secret
on the environment; signing out clears it. This does not create an environment pairing grant or change
local RPC/tool permissions. Existing environment credentials used for transport continue to have their
separate lifecycle.

The hosted API accepts only execution, profile, and recommendation operations. It builds the JEV
questions itself, validates candidate IDs and responses, bounds the complete upstream UTF-8 request and
response to 24,000 bytes each, and makes at most one four-second upstream attempt per admitted request.
An ambiguous or unavailable result returns a visible Standard fallback. No semantic keyword classifier
or second routing model runs during fallback.

### Spending and traffic limits

The defaults in the Compose environment are a deliberately bounded starting point: $25 per UTC month,
$2 per UTC day, 10,000 requests per account per month, and 1,000 per day. Accounts younger than 24 hours
receive at most 100 requests per day. These are operator settings, not a paid-plan entitlement. Daily
headroom limits damage before an operator can review a new deployment; the monthly allowance is an
independent ceiling. All routing operations consume these limits, not just the initial execution choice.

PostgreSQL reserves cost before the upstream request. A short transaction locks a single control row,
checks account/global concurrency, and atomically updates every applicable budget and quota bucket.
The lock is released before inference. Multiple service instances and restarts therefore share the same
admission state. Request IDs retain their result or failure for 35 days; a replay does not create another
upstream attempt, and changing its payload or environment is a conflict.

The pinned `jev-1.13.0` price was checked against the [official model documentation](https://docs.typesafe.ai/models)
on September 22, 2026: $0.042 per million input tokens, with output tokens uncharged. Each request
initially reserves 65,536 input tokens at that price, conservatively covering either interpretation of
the documented 64k context ceiling. This is $0.002752512 per request, not an estimate derived from
24 KB of JSON. Successful calls settle valid provider-reported input usage exactly once; failures,
timeouts, interrupted requests, and missing usage retain the full allowance. Review the pinned price,
context ceiling, and account terms before changing the model or deploying after a pricing change.
This accounting caps calls through this service at the configured rate assumption; it is not a promise
about taxes, other API keys, a compromised operator key, or unrelated usage on the TypeSafe account.

The other configurable defaults are six requests per rolling ten seconds, 30 per minute, 300 per rolling
hour per account, 20 per minute per environment, and 20 active environments per account in the preceding
30 days. Account/global concurrency defaults to two/32. IP limits are auxiliary and deliberately broader:
120 per minute and 5,000 per day; IPv6 addresses share a /64 bucket. Signup/sign-in throttling uses Better
Auth's database-backed rate limiter. Device IDs are not a security boundary. The Compose file and
`.env.example` expose every routing limit; per-account restrictions below may only tighten the deployment
defaults.

Set `CONNECT_TRUSTED_PROXY_CIDRS` to the actual connecting proxy addresses or network after inspecting
the deployment. The service accepts forwarded hops only while walking through a trusted proxy chain;
direct clients cannot choose their own rate-limit address through `X-Forwarded-For` or
`x-dispatch-client-ip`. Do not publish the origin port around that proxy. An empty setting is safe from
header spoofing but groups proxied users under the socket address, so configure it before enabling public
signup at scale.

### Usage review and intervention

Run the operator CLI inside the hosted `connect` container, where database access is already controlled
by the deployment. In the supplied image, first run `cd /workspace/infra/connect`.
Set `CONNECT_ROUTING_OPERATOR` to an operator identifier for attribution. The CLI has
no public administrative endpoint and never prints API keys, credentials, or task objectives.

```sh
node src/routingAdmin.ts summary
node src/routingAdmin.ts account ACCOUNT_ID
node src/routingAdmin.ts block ACCOUNT_ID 'abuse investigation'
node src/routingAdmin.ts limits ACCOUNT_ID 50 500 'temporary reduced quota'
node src/routingAdmin.ts revoke-sessions ACCOUNT_ID 'compromised account session'
node src/routingAdmin.ts unblock ACCOUNT_ID 'review completed'
node src/routingAdmin.ts limits ACCOUNT_ID default default 'normal quota restored'
node src/routingAdmin.ts pause 'upstream maintenance'
node src/routingAdmin.ts resume 'maintenance complete'
node src/routingAdmin.ts audit
```

Use the container's working directory (`infra/connect` in a source checkout). `summary` reports global
accounting and high-usage accounts; `account` includes per-operation outcomes, recent request IDs,
environment IDs, consumption, duration, restrictions, and intervention history. The persistent pause
switch denies new paid admissions across instances. An account block or quota restriction affects
hosted routing; it does not erase data or disable Standard. Session revocation signs the account out of
Connect without deleting its environment records or local pairing grants.

Task objectives and provider credentials are not persisted in routing usage records. Records contain
account/request/environment IDs, operation, keyed payload digest, a bounded validated decision, outcome,
timing, and usage. IP buckets are keyed hashes. Usage and idempotency records expire after 35 days;
intervention audit entries after 180 days. Cleanup runs at startup and hourly and is also available through
`node src/routingAdmin.ts cleanup`. Deployment database backups need their own retention policy.
These operational records are required for cost/security controls and are separate from optional
product telemetry.

Auto forwards the objective and necessary model metadata to Dispatch Connect and TypeSafe. Dispatch's
35-day usage retention does not describe TypeSafe's retention: review its
[customer agreement](https://typesafe.ai/legal/mca) and [data processing addendum](https://typesafe.ai/legal/data-processing).
TypeSafe's standard service must not be described as zero-data-retention. Keep the Auto privacy notice
visible when enabling the feature, and do not send unrelated chat history, workspace files, or secrets.

Before rollout, run the focused routing tests and the PostgreSQL integration test using an explicitly
isolated loopback database whose name includes `test`. The integration harness creates and removes its
own schema. After deployment, check database health, unauthorized rejection without upstream traffic,
an authenticated routing decision, and session revocation/fallback. Starting a container alone is not
the acceptance check.

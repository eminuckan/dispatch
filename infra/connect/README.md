# Dispatch Connect control plane

Minimal self-hosted control plane for Dispatch account convenience and explicit device-to-environment grants. It is a single Node process backed by Postgres. Direct LAN/Tailscale pairing remains independent of this service; using Connect is optional.

## Run

Required environment variables:

- `DATABASE_URL`: Postgres connection string.
- `BETTER_AUTH_SECRET`: Better Auth secret. Use at least 32 random bytes in production.
- `BETTER_AUTH_URL`: public origin of this service, for example `https://connect.example.com`.
- `CONNECT_CREDENTIAL_SECRET`: independent HMAC secret for environment credentials and rendezvous codes. It is required when `NODE_ENV=production`; development falls back to `BETTER_AUTH_SECRET` to keep local setup small.

Optional variables:

- `HOST` defaults to `0.0.0.0`.
- `PORT` defaults to `8787`.
- `CONNECT_PAIRING_TTL_SECONDS` defaults to `600` and acts as a maximum rendezvous lifetime. Environments should send their actual local grant `expiresAt`, so Connect never outlives the EnvironmentAuth credential it is advertising.
- `CONNECT_ALLOWED_ORIGINS` is a comma-separated list of browser origins allowed to call Connect. Wildcards are supported for variable Dispatch web origins, for example `http://127.0.0.1:*` and `https://*.remote.example.com`. Keep this list scoped to origins you operate or intentionally trust; Connect never reflects an arbitrary Origin header.
- `CONNECT_DEVICE_VERIFICATION_URL` optionally overrides the headless CLI approval page. By default Connect serves its own same-origin approval UI at `${BETTER_AUTH_URL}/device`, so a separate hosted web deployment is not required for `dispatch connect`.

Managed Cloudflare Tunnel support is also optional. It is enabled only when all four variables are present: `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ZONE_ID`, and `CONNECT_TUNNEL_DOMAIN`. `CONNECT_TUNNEL_DOMAIN` is an existing Cloudflare-managed base domain such as `remote.example.com`; Connect does not create zones. The API token needs **Cloudflare Tunnel Edit** on the account and **DNS Write** on the selected zone. Partial configuration fails startup instead of falling back to an anonymous or unmanaged path.

From the monorepo root run `pnpm --filter @dispatch/connect start`. Startup runs Better Auth's noninteractive Kysely migration plan and then the idempotent Connect schema migration before listening. No separate migration CLI is required.

For Dokploy, the repository's deployment bundle lives under `deploy/dispatch-connect`; it builds this workspace package and runs the same start command on port `8787` by default.

## v1 HTTP contract

`GET /health` is unauthenticated and includes a Postgres readiness check.

Better Auth is mounted at `/api/auth/*`. Email/password sessions, Bearer sessions, Expo cookie handling, and device authorization for `client_id=dispatch-cli` are enabled. `GET /device` is the built-in same-origin approval page used by headless `dispatch connect`; a deployment can override the verification URL when it deliberately hosts that UI elsewhere. Device authorization creates only an account session. It does not create an environment grant.

`GET /v1/managed-tunnel/capability` is unauthenticated metadata that reports whether this Connect deployment has managed Cloudflare transport configured. It never exposes Cloudflare identifiers or credentials.

Connect account routes require a Better Auth session, supplied by the normal session cookie or Better Auth Bearer token:

- `POST /v1/devices` with `{ "label", "publicKey" }` registers an account-owned client device.
- `GET /v1/devices` lists the signed-in account's registered devices so another device can revoke a lost installation.
- `DELETE /v1/devices/:deviceId` removes an account-owned lost device; its environment grants are deleted by the database cascade.
- `GET /v1/environments` lists environments owned by the signed-in account for discovery. Ownership alone does not authorize that device to operate an environment.
- `POST /v1/environments` with `{ "label", "publicKey", "endpoints"? }` registers an account-owned environment and returns its `dce_...` environment credential exactly once.
- `POST /v1/environments/:environmentId/credentials/rotate` revokes existing environment credentials and returns one replacement credential once.
- `DELETE /v1/environments/:environmentId/credentials` revokes all environment credentials without changing device grants.
- `POST /v1/pairings/redeem` with `{ "deviceId", "code" }` consumes a pairing code and grants that device access to the environment. Account and per-device fixed-window limits bound repeated public redemption attempts.
- `GET /v1/devices/:deviceId/environments` returns only environments with an active grant for that account-owned device.
- `GET /v1/environments/:environmentId/grants` lets the environment owner inspect grants.
- `DELETE /v1/environments/:environmentId/grants/:deviceId` revokes a grant.
- `DELETE /v1/environments/:environmentId/managed-tunnel` accepts either the owning Better Auth account session or that environment's `dce_...` credential. This lets the environment clean up its own transport without exposing an account token. It attempts both Cloudflare DNS and tunnel deletion, then always removes the local allocation and `cloudflare_tunnel` endpoint. The response reports whether remote cleanup was complete or partial.

Environment-auth routes use `Authorization: Bearer dce_...`. Environment credentials are random 256-bit values and only their HMAC is stored:

- `PUT /v1/environments/:environmentId/endpoints/:kind` publishes or replaces an endpoint. `kind` is `tailscale` or `cloudflare_tunnel`; the body is `{ "httpBaseUrl", "wsBaseUrl" }`.
- `POST /v1/environments/:environmentId/pairings` registers the environment's existing 12-character EnvironmentAuth code from `{ "code": "XXXX-XXXX-XXXX", "expiresAt"?: "..." }`, returning the grouped code plus a `dispatch://connect/pair?...` URI for QR rendering. `code` is required: Connect never mints a second pairing credential. `expiresAt` lets the environment mirror its local grant expiry and is capped by `CONNECT_PAIRING_TTL_SECONDS`. Only an HMAC of the normalized code is stored. Consumption is serialized under a Postgres row lock so a code grants at most one device. The plaintext code is never persisted.
- `POST /v1/environments/:environmentId/managed-tunnel` with `{ "localOrigin": "http://127.0.0.1:PORT" }` idempotently ensures a remotely-managed Cloudflare Tunnel. `localhost` and `::1` inputs are accepted and normalized to `127.0.0.1`; non-loopback hosts, HTTPS, paths, query strings, and missing ports are rejected. Connect creates a stable environment hostname under `CONNECT_TUNNEL_DOMAIN`, writes remotely-managed ingress, ensures a proxied CNAME to `<tunnelId>.cfargotunnel.com`, stores only allocation metadata, and returns the `cloudflare_tunnel` endpoint plus the connector token. Connector tokens are never persisted.
- `GET /v1/environments/:environmentId/managed-tunnel/token` refetches the connector token for reconnect without changing the allocation.

Clients can continue preferring a reachable Tailscale endpoint and use the managed Cloudflare endpoint as the internet fallback. The Cloudflare REST integration is isolated in this package and does not depend on the legacy relay, Alchemy, Cloudflare SDKs, PlanetScale, or Hyperdrive.

## Legacy routing data

Hosted model routing has been removed. Existing request records expire after 35 days and audit records after 180 days; cleanup runs at startup and hourly. Fresh deployments create no routing tables. Remove any `CONNECT_JEV_API_KEY`, `CONNECT_SMART_ROUTING_ENABLED`, and `CONNECT_ROUTING_*` variables from hosted service settings.

For correct signup and account IP limits, set `CONNECT_TRUSTED_PROXY_CIDRS` to the actual directly connecting reverse proxy CIDR(s), restrict origin access to that proxy, and configure it to overwrite or append `X-Forwarded-For`. An unset setting ignores forwarded headers and groups requests by socket address.

Run `pnpm --filter @dispatch/connect test` for focused checks.

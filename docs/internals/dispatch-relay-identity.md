# Accountless relay identity

Dispatch does not require a product account, login, or logout. Direct environment access already
has its own authority model: a one-time pairing grant becomes a scoped bearer or DPoP-bound
environment session, and authenticated clients use short-lived WebSocket tickets. That model remains
the security boundary for LAN, Tailscale, SSH, and direct remote access.

The remaining account dependency is the legacy T3 Connect relay control plane. It currently uses a
Clerk subject to group environments, devices, managed tunnel allocations, and push registrations.
Clerk must not be removed by replacing those checks with anonymous relay access. The replacement is
an accountless, key-backed relay principal called a **trust space**.

## Trust space model

A trust space is an opaque stable identifier shared by a user's explicitly trusted Dispatch devices
and environments. It is not derived directly from a root public key, so administrative key rotation
does not change every relay database key or managed endpoint.

Each member has its own proof key. Relay access tokens stay DPoP-bound and use:

- `sub = trustSpaceId`
- `cnf.jkt = member proof-key thumbprint`
- scoped relay capabilities as today

The relay checks both the trust space and the member thumbprint on authenticated requests. Revoking
a member therefore invalidates that device independently. A trust-space epoch or `revokedAt` value
supports whole-space reset.

Suggested new records:

- `relay_trust_spaces`: stable id, creation/revocation state, recovery public key or hash, stable
  managed-endpoint namespace seed, and optional service entitlement/quota metadata.
- `relay_trust_members`: trust-space id, member public JWK/thumbprint, device metadata, role, and
  revocation state.
- A hashed rotating membership/bootstrap credential bound to the member key for relay token exchange.

Existing tables that physically use `user_id` can initially store `trustSpaceId` without a large
schema rewrite. Rename the columns only after the auth migration is stable. Environment credentials,
environment public keys, activity rows, and environment-signed relay proofs do not need a new
ownership model.

## Joining without an account

The initial authority comes from an environment the person already controls, not from a hosted
identity provider.

1. Pair to an environment through the normal EnvironmentAuth flow with an explicitly privileged
   grant. Ordinary standard pairing must not silently become trust-space administrator authority.
2. Create the first trust space and link that environment using the existing environment challenge,
   Ed25519 proof, and replay protection.
3. A new device pairs to any linked environment with its own DPoP key and asks that environment to
   authorize trust-space enrollment.
4. The relay records the new member key and returns a key-bound membership/bootstrap credential.
5. Additional environments use the existing signed link-challenge flow under the same trust space.

An already trusted device may alternatively mint a short-lived, single-use join invitation. This is
useful when the new device cannot directly reach an environment during onboarding.

## Recovery and revocation

There is intentionally no email recovery. Trust comes from possession of trusted keys and explicit
environment authority.

- Revoking one device marks its trust member revoked and relay auth rejects future requests for that
  `(trustSpaceId, cnf.jkt)` pair.
- Whole-space reset increments an epoch or revokes the space and requires re-enrollment.
- Optional catastrophic recovery uses a printable recovery seed/key generated when the trust space
  is created. The relay stores only the recovery public key or hash and verifies a signed challenge.
- If every linked environment, trusted member, and recovery key is lost, the trust space is lost.
  The user creates a new one and pairs again.

Current relay DPoP tokens are self-contained for a limited lifetime. Member revocation must therefore
be checked during RelayDpop authorization rather than accepting the full token lifetime as a
revocation delay.

## Managed endpoint stability

Managed endpoint naming currently depends on the cloud principal and environment id. Authentication
identity must not accidentally rename a user's tunnel during migration. Give each trust space a
stable `endpointNamespaceSeed` that is separate from the auth key:

- migrated legacy principals retain the old Clerk user id as a non-secret namespace seed;
- new trust spaces use a random seed or the stable trust-space id;
- key rotation never changes the namespace seed.

## Public relay abuse controls

Cryptographic identity proves continuity; it does not provide Sybil resistance. If arbitrary clients
can create unlimited trust spaces, a per-space tunnel limit is not an adequate hosted-service quota.

Separate **authorization** from **service entitlement**. A public Dispatch relay can require a
relay-issued service grant, invitation, license, or device/environment attestation for costly managed
tunnel capability without introducing a product login. Rate-limit trust-space creation, enrollment,
link challenges, and push traffic by network and cryptographic identifiers. Self-hosted relays may
choose an allow-all entitlement policy.

## Migration from legacy T3 Connect

Move in stages so direct remote access and existing relay installations remain secure throughout:

1. Introduce `trustSpaceId` / generic principal naming in contracts while existing `user_id` storage
   and Clerk behavior remain unchanged.
2. Add trust-space/member/grant records and accountless enrollment. Relay token exchange accepts the
   new key-bound subject credential and issues the existing DPoP token shape with
   `sub=trustSpaceId`. Clerk verification remains an explicit legacy fallback.
3. Move relay list/link/unlink/device APIs to trust-space DPoP scopes. Client runtime changes from
   `clerkToken` to a generic `subjectCredential` / relay bootstrap-session contract.
4. Replace `dispatch connect` OAuth login/logout with persistent device DPoP identity plus explicit
   EnvironmentAuth-backed enrollment/linking. No product account surface remains.
5. Migrate legacy Clerk-owned rows to a trust space on first legacy session or relink while retaining
   the old principal as `endpointNamespaceSeed`.
6. Disable the Clerk fallback by default, keep it only for a defined migration window, then remove
   Clerk packages, OAuth routes, configuration, and legacy account code.

Until those stages are implemented, the legacy Clerk verifier and token manager may remain dormant
compatibility code. They must not become dependencies of EnvironmentAuth or reappear as Dispatch
product account UI.

## Why not use one environment as the relay principal?

Making each environment its own relay account is simpler for one machine but loses the behavior the
relay exists to provide. Every device would have to pair to every environment, environment discovery
would no longer be unified, push/device registrations would duplicate per environment, recovery
would depend on whichever environment acted as root, and per-environment tunnel quotas would be easy
to bypass by creating new environments. A trust space preserves the current user-shaped relational
model without requiring a human identity provider.

# Dispatch Connect

Dispatch Connect is Dispatch's optional cloud control plane. Dispatch itself remains local-first and
usable without an account: LAN pairing, Tailscale, SSH, and manually configured endpoints keep working
when Connect is absent. Signing in adds discovery and managed remote-access convenience; it does not
replace an environment's own authorization boundary.

Three identities stay separate:

1. **Account identity** answers which human owns or can discover a device/environment. Better Auth owns
   this layer and persists it in Dispatch's PostgreSQL database.
2. **Device identity** identifies one installation with its own key material. Losing or signing out of
   an account must not silently turn another installation into an authorized environment client.
3. **Environment grant** is the authority to operate one Dispatch server. A one-time pairing grant is
   exchanged with that environment for the existing scoped bearer/DPoP session. The environment, not
   Connect, remains the final authority for terminals, files, agents, reviews, and other operations.

This separation means an account compromise alone does not grant a newly seen device access to every
machine. A device must still be paired or explicitly approved, and its environment session can be
revoked independently.

## Control plane, not execution plane

The hosted service is deliberately small. The production shape is one `dispatch-connect` service plus
PostgreSQL and ordinary reverse-proxy/TLS supplied by the deployment platform. The service owns account
sessions, device/environment registry, pairing rendezvous metadata, endpoint discovery, and optional
managed-tunnel metadata. It does not own projects, repositories, provider credentials, terminals, or
thread state; those stay on the environment.

Better Auth is an implementation detail of account identity. Dispatch-specific device keys,
environment ownership, grants, and pairing are Dispatch domain records and must not be modeled as
Better Auth sessions merely to reuse an authentication library.

## Pairing is transport-independent

A pairing QR or short code is a short-lived capability. The readable code is shown only to the user;
server-side rendezvous storage keeps a digest, expiry, and single-use state. Redeeming it associates a
device with an environment discovery record, but the client still exchanges the environment's pairing
credential through EnvironmentAuth to obtain the real scoped session.

A successful pairing therefore survives endpoint changes. Moving from LAN to Tailscale or to a managed
Cloudflare Tunnel must not mint a different trust relationship.

## Transport selection

Reachability is separate from authorization. Connect can advertise multiple endpoints for an
environment and clients choose the best route they can actually reach:

1. an already-known local/LAN route when appropriate;
2. Tailscale when both sides have a usable tailnet endpoint;
3. a Dispatch-managed Cloudflare Tunnel endpoint as the zero-configuration internet fallback;
4. an explicitly configured manual/SSH route where applicable.

Tailscale and Cloudflare solve network transport. They never replace Dispatch session checks. A
Cloudflare account is operated by the Dispatch deployment, not by each end user; users should not need
to create zones, API tokens, or tunnel configuration just to pair another device.

## Hosted metadata boundary

Connect may store display names, ownership/membership, device public keys, environment public keys,
online/last-seen state, endpoint metadata, and pairing state. Project and
thread content is environment-local by default. If a future product feature caches project metadata for
faster mobile discovery, that is a separate explicit data decision rather than an accidental
consequence of remote access.

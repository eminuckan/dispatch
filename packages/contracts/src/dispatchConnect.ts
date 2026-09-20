import * as Schema from "effect/Schema";

import { AuthEnvironmentScopes } from "./auth.ts";
import { EnvironmentId, TrimmedNonEmptyString } from "./baseSchemas.ts";

const PAIRING_SECRET_PATTERN = /^[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{12}$/u;
const PAIRING_CODE_PATTERN =
  /^[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{4}(?:-[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{4}){2}$/u;

export const DISPATCH_CONNECT_PAIRING_SUBJECT = "dispatch-connect-device-pairing" as const;

export const DispatchConnectAccountId = TrimmedNonEmptyString.pipe(
  Schema.brand("DispatchConnectAccountId"),
);
export type DispatchConnectAccountId = typeof DispatchConnectAccountId.Type;

export const DispatchConnectDeviceId = TrimmedNonEmptyString.pipe(
  Schema.brand("DispatchConnectDeviceId"),
);
export type DispatchConnectDeviceId = typeof DispatchConnectDeviceId.Type;

export const DispatchConnectPairingId = TrimmedNonEmptyString.pipe(
  Schema.brand("DispatchConnectPairingId"),
);
export type DispatchConnectPairingId = typeof DispatchConnectPairingId.Type;

export const DispatchConnectDeviceType = Schema.Literals([
  "desktop",
  "mobile",
  "tablet",
  "web",
  "bot",
  "unknown",
]);
export type DispatchConnectDeviceType = typeof DispatchConnectDeviceType.Type;

export const DispatchConnectAccountIdentity = Schema.Struct({
  accountId: DispatchConnectAccountId,
  displayName: Schema.optionalKey(TrimmedNonEmptyString),
  email: Schema.optionalKey(TrimmedNonEmptyString),
});
export type DispatchConnectAccountIdentity = typeof DispatchConnectAccountIdentity.Type;

export const DispatchConnectDeviceIdentity = Schema.Struct({
  deviceId: DispatchConnectDeviceId,
  label: TrimmedNonEmptyString,
  deviceType: DispatchConnectDeviceType,
  os: Schema.optionalKey(TrimmedNonEmptyString),
  appVersion: Schema.optionalKey(TrimmedNonEmptyString),
  accountId: Schema.optionalKey(DispatchConnectAccountId),
});
export type DispatchConnectDeviceIdentity = typeof DispatchConnectDeviceIdentity.Type;

export const DispatchConnectEnvironmentIdentity = Schema.Struct({
  environmentId: EnvironmentId,
  label: TrimmedNonEmptyString,
  publicKey: TrimmedNonEmptyString,
  accountId: Schema.optionalKey(DispatchConnectAccountId),
});
export type DispatchConnectEnvironmentIdentity = typeof DispatchConnectEnvironmentIdentity.Type;

export const DispatchConnectBaseUrl = TrimmedNonEmptyString.check(
  Schema.isPattern(/^https?:\/\/[^\s]+$/u),
);
export type DispatchConnectBaseUrl = typeof DispatchConnectBaseUrl.Type;

export const DispatchConnectControlPlaneEnvironmentId = TrimmedNonEmptyString.pipe(
  Schema.brand("DispatchConnectControlPlaneEnvironmentId"),
);
export type DispatchConnectControlPlaneEnvironmentId =
  typeof DispatchConnectControlPlaneEnvironmentId.Type;

export const DispatchConnectEnvironmentConnection = Schema.Struct({
  baseUrl: DispatchConnectBaseUrl,
  environmentId: DispatchConnectControlPlaneEnvironmentId,
});
export type DispatchConnectEnvironmentConnection = typeof DispatchConnectEnvironmentConnection.Type;

export const DispatchConnectEnvironmentConfigureInput = Schema.Struct({
  ...DispatchConnectEnvironmentConnection.fields,
  credential: TrimmedNonEmptyString.check(Schema.isPattern(/^dce_[A-Za-z0-9_-]{43}$/u)),
});
export type DispatchConnectEnvironmentConfigureInput =
  typeof DispatchConnectEnvironmentConfigureInput.Type;

export const DispatchConnectEnvironmentStatus = Schema.Struct({
  configured: Schema.Boolean,
  connection: Schema.optionalKey(DispatchConnectEnvironmentConnection),
});
export type DispatchConnectEnvironmentStatus = typeof DispatchConnectEnvironmentStatus.Type;

export const DispatchConnectManagedEndpointConfig = Schema.Struct({
  providerKind: Schema.Literal("cloudflare_tunnel"),
  connectorToken: TrimmedNonEmptyString,
  tunnelId: Schema.optionalKey(TrimmedNonEmptyString),
  tunnelName: Schema.optionalKey(TrimmedNonEmptyString),
});
export type DispatchConnectManagedEndpointConfig = typeof DispatchConnectManagedEndpointConfig.Type;

export const DispatchConnectManagedEndpointStatus = Schema.Union([
  Schema.Struct({ status: Schema.Literal("disabled") }),
  Schema.Struct({
    status: Schema.Literal("failed"),
    providerKind: Schema.Literal("cloudflare_tunnel"),
    reason: TrimmedNonEmptyString,
    tunnelId: Schema.optionalKey(TrimmedNonEmptyString),
    tunnelName: Schema.optionalKey(TrimmedNonEmptyString),
  }),
  Schema.Struct({
    status: Schema.Literal("running"),
    providerKind: Schema.Literal("cloudflare_tunnel"),
    tunnelId: Schema.optionalKey(TrimmedNonEmptyString),
    tunnelName: Schema.optionalKey(TrimmedNonEmptyString),
  }),
  Schema.Struct({
    status: Schema.Literal("unsupported"),
    providerKind: Schema.Literal("cloudflare_tunnel"),
  }),
]);
export type DispatchConnectManagedEndpointStatus = typeof DispatchConnectManagedEndpointStatus.Type;

/** Canonical one-time secret stored by EnvironmentAuth. */
export const DispatchConnectPairingSecret = TrimmedNonEmptyString.check(
  Schema.isPattern(PAIRING_SECRET_PATTERN),
);
export type DispatchConnectPairingSecret = typeof DispatchConnectPairingSecret.Type;

/** Human-entry form shown next to the QR code. */
export const DispatchConnectPairingCode = TrimmedNonEmptyString.check(
  Schema.isPattern(PAIRING_CODE_PATTERN),
);
export type DispatchConnectPairingCode = typeof DispatchConnectPairingCode.Type;

export const DispatchConnectPairingCreateInput = Schema.Struct({
  label: Schema.optionalKey(TrimmedNonEmptyString),
  scopes: Schema.optionalKey(AuthEnvironmentScopes),
});
export type DispatchConnectPairingCreateInput = typeof DispatchConnectPairingCreateInput.Type;

export const DispatchConnectPairingChallenge = Schema.Struct({
  pairingId: DispatchConnectPairingId,
  shortCode: DispatchConnectPairingCode,
  pairingUrl: TrimmedNonEmptyString,
  expiresAt: Schema.DateTimeUtc,
});
export type DispatchConnectPairingChallenge = typeof DispatchConnectPairingChallenge.Type;

export const DispatchConnectPairingRegistrationRequest = Schema.Struct({
  code: DispatchConnectPairingCode,
  expiresAt: TrimmedNonEmptyString,
});
export type DispatchConnectPairingRegistrationRequest =
  typeof DispatchConnectPairingRegistrationRequest.Type;

export const DispatchConnectPairingRegistrationResponse = Schema.Struct({
  pairing: Schema.Struct({
    code: DispatchConnectPairingCode,
    expiresAt: Schema.String,
    pairingUri: TrimmedNonEmptyString,
  }),
});
export type DispatchConnectPairingRegistrationResponse =
  typeof DispatchConnectPairingRegistrationResponse.Type;

export function formatDispatchConnectPairingCode(
  secret: DispatchConnectPairingSecret,
): DispatchConnectPairingCode {
  return DispatchConnectPairingCode.make(
    `${secret.slice(0, 4)}-${secret.slice(4, 8)}-${secret.slice(8, 12)}`,
  );
}

/**
 * Accept the grouped code users type while leaving every other credential
 * untouched. This keeps legacy/direct bootstrap credentials byte-for-byte
 * compatible and only normalizes the Dispatch pairing format.
 */
export function normalizeDispatchConnectPairingCredential(value: string): string {
  const trimmed = value.trim();
  if (!/[\s-]/u.test(trimmed)) {
    return trimmed;
  }
  const compact = trimmed.replace(/[\s-]+/gu, "").toUpperCase();
  return PAIRING_SECRET_PATTERN.test(compact) ? compact : trimmed;
}

export function buildDispatchConnectPairingUrl(
  baseUrl: string,
  secret: DispatchConnectPairingSecret,
): string {
  const url = new URL(baseUrl);
  url.pathname = "/pair";
  url.searchParams.delete("token");
  url.hash = new URLSearchParams([["token", secret]]).toString();
  return url.toString();
}

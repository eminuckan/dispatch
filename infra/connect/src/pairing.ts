import * as NodeCrypto from "node:crypto";

export const PAIRING_CODE_LENGTH = 12;
const PAIRING_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";

export type PairingValidationError = "invalid" | "expired" | "used" | "device_not_owned";

export interface PairingCandidate {
  readonly expiresAt: Date;
  readonly usedAt: Date | null;
  readonly usedByDeviceId: string | null;
  readonly deviceOwnerUserId: string | null;
  readonly hasActiveGrant: boolean;
}

export type PairingRedemptionDecision = "redeem" | "already_redeemed" | PairingValidationError;
export type PairingApiErrorCode =
  | "pairing_not_found"
  | "pairing_expired"
  | "pairing_used"
  | "device_not_owned";

export function pairingApiErrorCode(error: PairingValidationError): PairingApiErrorCode {
  switch (error) {
    case "invalid":
      return "pairing_not_found";
    case "expired":
      return "pairing_expired";
    case "used":
      return "pairing_used";
    case "device_not_owned":
      return "device_not_owned";
  }
}

export function normalizePairingCode(value: string): string {
  return value
    .trim()
    .toUpperCase()
    .replace(/[\s-]+/g, "");
}

export function formatPairingCode(value: string): string {
  const normalized = normalizePairingCode(value);
  return `${normalized.slice(0, 4)}-${normalized.slice(4, 8)}-${normalized.slice(8, 12)}`;
}

export function isValidPairingCode(value: string): boolean {
  const normalized = normalizePairingCode(value);
  return (
    normalized.length === PAIRING_CODE_LENGTH &&
    [...normalized].every((character) => PAIRING_ALPHABET.includes(character))
  );
}

export function hashPairingCode(code: string, secret: string): string {
  return NodeCrypto.createHmac("sha256", secret)
    .update(`pairing:${normalizePairingCode(code)}`)
    .digest("hex");
}

export function hashEnvironmentCredential(credential: string, secret: string): string {
  return NodeCrypto.createHmac("sha256", secret).update(`environment:${credential}`).digest("hex");
}

export function generateEnvironmentCredential(): string {
  return `dce_${NodeCrypto.randomBytes(32).toString("base64url")}`;
}

export function validatePairingCandidate(
  candidate: PairingCandidate | null,
  userId: string,
  deviceId: string,
  now: Date,
): PairingRedemptionDecision {
  if (!candidate) return "invalid";
  if (candidate.usedAt) {
    if (
      candidate.usedByDeviceId === deviceId &&
      candidate.deviceOwnerUserId === userId &&
      candidate.hasActiveGrant
    ) {
      return "already_redeemed";
    }
    return "used";
  }
  if (candidate.expiresAt.getTime() <= now.getTime()) return "expired";
  if (candidate.deviceOwnerUserId !== userId) return "device_not_owned";
  return "redeem";
}

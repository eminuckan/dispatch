// @effect-diagnostics globalDate:off - Tests exercise plain Date inputs used by the standalone service.
import assert from "node:assert/strict";
import test from "node:test";

import {
  PAIRING_CODE_LENGTH,
  generateEnvironmentCredential,
  formatPairingCode,
  hashEnvironmentCredential,
  hashPairingCode,
  isValidPairingCode,
  normalizePairingCode,
  pairingApiErrorCode,
  validatePairingCandidate,
} from "./pairing.ts";

test("pairing codes are short, human-readable, and normalization is separator-insensitive", () => {
  const code = formatPairingCode("2345ABCDJKLM");
  assert.match(
    code,
    /^[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{4}-[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{4}-[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{4}$/,
  );
  assert.equal(normalizePairingCode(code).length, PAIRING_CODE_LENGTH);
  assert.equal(normalizePairingCode("ab2c-def3-gh4j"), "AB2CDEF3GH4J");
  assert.equal(formatPairingCode("2345abcdjklm"), "2345-ABCD-JKLM");
  assert.equal(isValidPairingCode(code), true);
  assert.equal(isValidPairingCode("ABCD-EFGH"), false);
  assert.equal(isValidPairingCode("OOOO-OOOO-OOOO"), false);
});

test("pairing and environment secrets are domain-separated hashes", () => {
  const secret = "test-secret";
  const pairingHash = hashPairingCode("ABCD-EFGH", secret);
  assert.equal(pairingHash, hashPairingCode("abcdefgh", secret));
  assert.notEqual(pairingHash, "ABCDEFGH");
  assert.notEqual(pairingHash, hashEnvironmentCredential("ABCDEFGH", secret));

  const credential = generateEnvironmentCredential();
  assert.match(credential, /^dce_[A-Za-z0-9_-]{43}$/);
});

test("pairing validation enforces expiry, use-once, and device ownership", () => {
  const now = new Date("2026-09-20T20:00:00.000Z");
  const valid = {
    expiresAt: new Date("2026-09-20T20:10:00.000Z"),
    usedAt: null,
    usedByDeviceId: null,
    deviceOwnerUserId: "user-1",
    hasActiveGrant: false,
  };

  assert.equal(validatePairingCandidate(valid, "user-1", "device-1", now), "redeem");
  assert.equal(validatePairingCandidate(null, "user-1", "device-1", now), "invalid");
  assert.equal(
    validatePairingCandidate({ ...valid, expiresAt: now }, "user-1", "device-1", now),
    "expired",
  );
  assert.equal(
    validatePairingCandidate(
      { ...valid, usedAt: new Date("2026-09-20T19:59:00.000Z"), usedByDeviceId: "device-2" },
      "user-1",
      "device-1",
      now,
    ),
    "used",
  );
  assert.equal(validatePairingCandidate(valid, "user-2", "device-1", now), "device_not_owned");
});

test("pairing retry is idempotent only for the same owned device with an active grant", () => {
  const now = new Date("2026-09-20T20:20:00.000Z");
  const used = {
    expiresAt: new Date("2026-09-20T20:05:00.000Z"),
    usedAt: new Date("2026-09-20T20:01:00.000Z"),
    usedByDeviceId: "device-1",
    deviceOwnerUserId: "user-1",
    hasActiveGrant: true,
  };

  assert.equal(validatePairingCandidate(used, "user-1", "device-1", now), "already_redeemed");
  assert.equal(
    validatePairingCandidate({ ...used, hasActiveGrant: false }, "user-1", "device-1", now),
    "used",
  );
  assert.equal(validatePairingCandidate(used, "user-1", "device-2", now), "used");
  assert.equal(validatePairingCandidate(used, "user-2", "device-1", now), "used");
});

test("pairing database failures map to the stable client API codes", () => {
  assert.equal(pairingApiErrorCode("invalid"), "pairing_not_found");
  assert.equal(pairingApiErrorCode("expired"), "pairing_expired");
  assert.equal(pairingApiErrorCode("used"), "pairing_used");
  assert.equal(pairingApiErrorCode("device_not_owned"), "device_not_owned");
});

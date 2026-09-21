// @effect-diagnostics globalDate:off - Tests exercise plain Date inputs used by the standalone service.
import * as NodeAssert from "node:assert/strict";
import * as NodeTest from "node:test";

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

NodeTest.test(
  "pairing codes are short, human-readable, and normalization is separator-insensitive",
  () => {
    const code = formatPairingCode("2345ABCDJKLM");
    NodeAssert.match(
      code,
      /^[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{4}-[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{4}-[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{4}$/,
    );
    NodeAssert.equal(normalizePairingCode(code).length, PAIRING_CODE_LENGTH);
    NodeAssert.equal(normalizePairingCode("ab2c-def3-gh4j"), "AB2CDEF3GH4J");
    NodeAssert.equal(formatPairingCode("2345abcdjklm"), "2345-ABCD-JKLM");
    NodeAssert.equal(isValidPairingCode(code), true);
    NodeAssert.equal(isValidPairingCode("ABCD-EFGH"), false);
    NodeAssert.equal(isValidPairingCode("OOOO-OOOO-OOOO"), false);
  },
);

NodeTest.test("pairing and environment secrets are domain-separated hashes", () => {
  const secret = "test-secret";
  const pairingHash = hashPairingCode("ABCD-EFGH", secret);
  NodeAssert.equal(pairingHash, hashPairingCode("abcdefgh", secret));
  NodeAssert.notEqual(pairingHash, "ABCDEFGH");
  NodeAssert.notEqual(pairingHash, hashEnvironmentCredential("ABCDEFGH", secret));

  const credential = generateEnvironmentCredential();
  NodeAssert.match(credential, /^dce_[A-Za-z0-9_-]{43}$/);
});

NodeTest.test("pairing validation enforces expiry, use-once, and device ownership", () => {
  const now = new Date("2026-09-20T20:00:00.000Z");
  const valid = {
    expiresAt: new Date("2026-09-20T20:10:00.000Z"),
    usedAt: null,
    usedByDeviceId: null,
    deviceOwnerUserId: "user-1",
    hasActiveGrant: false,
  };

  NodeAssert.equal(validatePairingCandidate(valid, "user-1", "device-1", now), "redeem");
  NodeAssert.equal(validatePairingCandidate(null, "user-1", "device-1", now), "invalid");
  NodeAssert.equal(
    validatePairingCandidate({ ...valid, expiresAt: now }, "user-1", "device-1", now),
    "expired",
  );
  NodeAssert.equal(
    validatePairingCandidate(
      { ...valid, usedAt: new Date("2026-09-20T19:59:00.000Z"), usedByDeviceId: "device-2" },
      "user-1",
      "device-1",
      now,
    ),
    "used",
  );
  NodeAssert.equal(validatePairingCandidate(valid, "user-2", "device-1", now), "device_not_owned");
});

NodeTest.test(
  "pairing retry is idempotent only for the same owned device with an active grant",
  () => {
    const now = new Date("2026-09-20T20:20:00.000Z");
    const used = {
      expiresAt: new Date("2026-09-20T20:05:00.000Z"),
      usedAt: new Date("2026-09-20T20:01:00.000Z"),
      usedByDeviceId: "device-1",
      deviceOwnerUserId: "user-1",
      hasActiveGrant: true,
    };

    NodeAssert.equal(validatePairingCandidate(used, "user-1", "device-1", now), "already_redeemed");
    NodeAssert.equal(
      validatePairingCandidate({ ...used, hasActiveGrant: false }, "user-1", "device-1", now),
      "used",
    );
    NodeAssert.equal(validatePairingCandidate(used, "user-1", "device-2", now), "used");
    NodeAssert.equal(validatePairingCandidate(used, "user-2", "device-1", now), "used");
  },
);

NodeTest.test("pairing database failures map to the stable client API codes", () => {
  NodeAssert.equal(pairingApiErrorCode("invalid"), "pairing_not_found");
  NodeAssert.equal(pairingApiErrorCode("expired"), "pairing_expired");
  NodeAssert.equal(pairingApiErrorCode("used"), "pairing_used");
  NodeAssert.equal(pairingApiErrorCode("device_not_owned"), "device_not_owned");
});

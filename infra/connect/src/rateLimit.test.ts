import assert from "node:assert/strict";
import test from "node:test";

import { FixedWindowRateLimiter } from "./rateLimit.ts";

test("fixed-window limiter blocks excess attempts and resets after the window", () => {
  const limiter = new FixedWindowRateLimiter(2, 1_000);
  assert.equal(limiter.consume("account:device", 100), true);
  assert.equal(limiter.consume("account:device", 200), true);
  assert.equal(limiter.consume("account:device", 300), false);
  assert.equal(limiter.consume("account:device", 1_100), true);
});

test("fixed-window limiter isolates keys", () => {
  const limiter = new FixedWindowRateLimiter(1, 1_000);
  assert.equal(limiter.consume("a", 100), true);
  assert.equal(limiter.consume("a", 200), false);
  assert.equal(limiter.consume("b", 200), true);
});

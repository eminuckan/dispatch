import * as NodeAssert from "node:assert/strict";
import * as NodeTest from "node:test";

import { FixedWindowRateLimiter } from "./rateLimit.ts";

NodeTest.test("fixed-window limiter blocks excess attempts and resets after the window", () => {
  const limiter = new FixedWindowRateLimiter(2, 1_000);
  NodeAssert.equal(limiter.consume("account:device", 100), true);
  NodeAssert.equal(limiter.consume("account:device", 200), true);
  NodeAssert.equal(limiter.consume("account:device", 300), false);
  NodeAssert.equal(limiter.consume("account:device", 1_100), true);
});

NodeTest.test("fixed-window limiter isolates keys", () => {
  const limiter = new FixedWindowRateLimiter(1, 1_000);
  NodeAssert.equal(limiter.consume("a", 100), true);
  NodeAssert.equal(limiter.consume("a", 200), false);
  NodeAssert.equal(limiter.consume("b", 200), true);
});

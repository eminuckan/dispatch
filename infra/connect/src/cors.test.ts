import * as NodeAssert from "node:assert/strict";
import * as NodeTest from "node:test";

import { isAllowedCorsOrigin } from "./cors.ts";

NodeTest.test("CORS origin matching supports explicit origins and deployment wildcards", () => {
  const allowed = [
    "https://app.example.com",
    "http://127.0.0.1:*",
    "http://localhost:*",
    "https://*.remote.example.com",
  ];

  NodeAssert.equal(isAllowedCorsOrigin("https://app.example.com", allowed), true);
  NodeAssert.equal(isAllowedCorsOrigin("http://127.0.0.1:4317", allowed), true);
  NodeAssert.equal(isAllowedCorsOrigin("http://localhost:5173", allowed), true);
  NodeAssert.equal(isAllowedCorsOrigin("https://mac-mini.remote.example.com", allowed), true);
});

NodeTest.test("CORS origin matching does not reflect lookalike or unrelated origins", () => {
  const allowed = ["https://*.remote.example.com", "http://127.0.0.1:*"];

  NodeAssert.equal(isAllowedCorsOrigin("https://remote.example.com.evil.test", allowed), false);
  NodeAssert.equal(isAllowedCorsOrigin("https://evil.test", allowed), false);
  NodeAssert.equal(isAllowedCorsOrigin("http://127.0.0.2:4317", allowed), false);
});

NodeTest.test("desktop CORS requires the renderer origin, not just its callback scheme", () => {
  const callbackSchemes = ["dispatch://", "dispatch-dev://"];
  const allowed = [...callbackSchemes, "dispatch://app", "dispatch-dev://app"];

  NodeAssert.equal(isAllowedCorsOrigin("dispatch://app", callbackSchemes), false);
  NodeAssert.equal(isAllowedCorsOrigin("dispatch://app", allowed), true);
  NodeAssert.equal(isAllowedCorsOrigin("dispatch-dev://app", allowed), true);
  for (const origin of ["null", "dispatch://evil", "dispatch://app.evil.test", "https://app"]) {
    NodeAssert.equal(isAllowedCorsOrigin(origin, allowed), false);
  }
});

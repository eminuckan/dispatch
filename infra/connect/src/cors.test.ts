import assert from "node:assert/strict";
import test from "node:test";

import { isAllowedCorsOrigin } from "./cors.ts";

test("CORS origin matching supports explicit origins and deployment wildcards", () => {
  const allowed = [
    "https://app.example.com",
    "http://127.0.0.1:*",
    "http://localhost:*",
    "https://*.remote.example.com",
  ];

  assert.equal(isAllowedCorsOrigin("https://app.example.com", allowed), true);
  assert.equal(isAllowedCorsOrigin("http://127.0.0.1:4317", allowed), true);
  assert.equal(isAllowedCorsOrigin("http://localhost:5173", allowed), true);
  assert.equal(isAllowedCorsOrigin("https://mac-mini.remote.example.com", allowed), true);
});

test("CORS origin matching does not reflect lookalike or unrelated origins", () => {
  const allowed = ["https://*.remote.example.com", "http://127.0.0.1:*"];

  assert.equal(isAllowedCorsOrigin("https://remote.example.com.evil.test", allowed), false);
  assert.equal(isAllowedCorsOrigin("https://evil.test", allowed), false);
  assert.equal(isAllowedCorsOrigin("http://127.0.0.2:4317", allowed), false);
});

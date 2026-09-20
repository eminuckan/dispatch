import assert from "node:assert/strict";
import test from "node:test";

import { dispatchConnectDevicePageHtml } from "./devicePage.ts";

test("built-in device approval page is same-origin and includes the complete device flow", () => {
  const html = dispatchConnectDevicePageHtml();
  assert.match(html, /Dispatch Connect/);
  assert.match(html, /\/api\/auth\/sign-in\/email/);
  assert.match(html, /\/api\/auth\/sign-up\/email/);
  assert.match(html, /\/api\/auth\/device\?user_code=/);
  assert.match(html, /\/api\/auth\/device\/approve/);
  assert.match(html, /\/api\/auth\/device\/deny/);
  assert.doesNotMatch(html, /https:\/\//);
});

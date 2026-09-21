import * as NodeAssert from "node:assert/strict";
import * as NodeTest from "node:test";

import { dispatchConnectDevicePageHtml } from "./devicePage.ts";

NodeTest.test(
  "built-in device approval page is same-origin and includes the complete device flow",
  () => {
    const html = dispatchConnectDevicePageHtml();
    NodeAssert.match(html, /Dispatch Connect/);
    NodeAssert.match(html, /\/api\/auth\/sign-in\/email/);
    NodeAssert.match(html, /\/api\/auth\/sign-up\/email/);
    NodeAssert.match(html, /\/api\/auth\/device\?user_code=/);
    NodeAssert.match(html, /\/api\/auth\/device\/approve/);
    NodeAssert.match(html, /\/api\/auth\/device\/deny/);
    NodeAssert.doesNotMatch(html, /https:\/\//);
  },
);

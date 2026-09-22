import { describe, expect, it } from "vite-plus/test";

import { dispatchFlowSessionPayload } from "./flowSession";

describe("Flow Smart Routing session payload", () => {
  it("binds the account token to a normalized Connect origin", () => {
    expect(dispatchFlowSessionPayload("https://connect.dispatch.test/", " account-token ")).toEqual(
      {
        accountToken: "account-token",
        baseUrl: "https://connect.dispatch.test",
      },
    );
  });

  it("clears both token and origin when the session is unavailable", () => {
    expect(dispatchFlowSessionPayload("https://connect.dispatch.test", null)).toEqual({
      accountToken: null,
      baseUrl: null,
    });
    expect(dispatchFlowSessionPayload(null, "stale-token")).toEqual({
      accountToken: null,
      baseUrl: null,
    });
  });
});

import { describe, expect, it } from "vite-plus/test";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";

import { WsRpcGroup, WsSubscribeServerConfigRpc } from "./rpc.ts";

/**
 * The client always sends `environmentThemes`, including to servers built
 * before the field existed, whose payload schema was an empty struct. What
 * makes that safe is that such a schema accepts the request rather than
 * rejecting it -- an error here would take down the config subscription.
 */
describe("subscribeServerConfig payload compatibility", () => {
  it("is accepted by a server whose schema predates the field", () => {
    const oldServerPayload = Schema.Struct({});
    const decoded = Schema.decodeUnknownExit(oldServerPayload)({ environmentThemes: true });
    expect(Exit.isSuccess(decoded)).toBe(true);
  });

  it("is carried by a server that declares it", () => {
    const decoded = Schema.decodeUnknownSync(WsSubscribeServerConfigRpc.payloadSchema)({
      environmentThemes: true,
    });
    expect(decoded).toEqual({ environmentThemes: true });
  });

  it("stays optional, so a client that never sends it still subscribes", () => {
    const decoded = Schema.decodeUnknownSync(WsSubscribeServerConfigRpc.payloadSchema)({});
    expect(decoded).toEqual({});
  });
});

describe("team RPC contract", () => {
  it("exposes only the redesigned team transport methods", () => {
    const tags = Array.from(WsRpcGroup.requests.keys())
      .filter((tag) => tag.startsWith("team."))
      .sort();

    expect(tags).toEqual(
      [
        "team.control",
        "team.forThread",
        "team.get",
        "team.list",
        "team.providerDecision",
        "team.recommendModels",
        "team.route",
        "team.saveSettings",
        "team.setSmartRoutingSession",
        "team.settings",
        "team.start",
      ].sort(),
    );
  });

  it("binds start, Smart Routing session, and providerDecision to the new payload shapes", () => {
    const start = WsRpcGroup.requests.get("team.start");
    const smartRoutingSession = WsRpcGroup.requests.get("team.setSmartRoutingSession");
    const providerDecision = WsRpcGroup.requests.get("team.providerDecision");
    expect(start).toBeDefined();
    expect(smartRoutingSession).toBeDefined();
    expect(providerDecision).toBeDefined();
    if (!start || !smartRoutingSession || !providerDecision) throw new Error("Expected team RPCs");

    expect(
      Schema.decodeUnknownSync(start.payloadSchema)({
        commandId: "command-1",
        projectId: "project-1",
        prompt: "Implement the runtime boundary",
        attachments: [],
      }),
    ).toEqual({
      commandId: "command-1",
      projectId: "project-1",
      prompt: "Implement the runtime boundary",
      runtimeMode: "approval-required",
      attachments: [],
    });

    expect(
      Schema.decodeUnknownSync(smartRoutingSession.payloadSchema)({
        accountToken: "account-session",
        baseUrl: "https://connect.opendispatch.dev",
      }),
    ).toEqual({
      accountToken: "account-session",
      baseUrl: "https://connect.opendispatch.dev",
    });

    expect(
      Schema.decodeUnknownSync(providerDecision.payloadSchema)({
        id: "run-1",
        revision: 3,
        failoverId: "failover-1",
        action: "pause",
        profileId: null,
      }),
    ).toEqual({
      id: "run-1",
      revision: 3,
      failoverId: "failover-1",
      action: "pause",
      profileId: null,
    });
  });
});

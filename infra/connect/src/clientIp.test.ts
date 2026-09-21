import * as NodeAssert from "node:assert/strict";
import * as NodeTest from "node:test";

import { ConnectClientIp } from "./clientIp.ts";

const request = (remoteAddress: string, forwarded: string) => ({
  socket: { remoteAddress },
  headers: { "x-forwarded-for": forwarded },
});

NodeTest.test(
  "client-supplied forwarded headers never bypass rate limits without a trusted connecting proxy",
  () => {
    const resolver = new ConnectClientIp(["10.10.0.3/32"]);
    NodeAssert.equal(resolver.resolve(request("198.51.100.8", "192.0.2.1")), "198.51.100.8");
    NodeAssert.equal(
      resolver.resolve(request("10.10.0.3", "192.0.2.1, 198.51.100.8")),
      "198.51.100.8",
    );
    NodeAssert.equal(resolver.resolve(request("10.10.0.3", "bad-header")), "10.10.0.3");
  },
);

NodeTest.test("IP quotas merge IPv4-mapped addresses and each IPv6 subscriber subnet", () => {
  const resolver = new ConnectClientIp([]);
  NodeAssert.equal(resolver.bucket("::ffff:192.0.2.1"), resolver.bucket("192.0.2.1"));
  NodeAssert.equal(resolver.bucket("::ffff:c000:201"), resolver.bucket("192.0.2.1"));
  NodeAssert.equal(
    resolver.bucket("2001:db8:abcd:1::1"),
    resolver.bucket("2001:0db8:abcd:0001:1234::ffff"),
  );
  NodeAssert.notEqual(resolver.bucket("2001:db8:abcd:1::1"), resolver.bucket("2001:db8:abcd:2::1"));
});

NodeTest.test("invalid trusted proxy configuration prevents startup", () => {
  for (const proxy of ["not-an-ip", "10.0.0.1/33", "2001:db8::/129", "10.0.0.1/8/2"]) {
    NodeAssert.throws(() => new ConnectClientIp([proxy]), /CONNECT_TRUSTED_PROXY_CIDRS/);
  }
});

import * as NodeAssert from "node:assert/strict";
import * as NodeTest from "node:test";

import type { CloudflareManagedTunnelConfig } from "./config.ts";
import {
  CloudflareManagedTunnelClient,
  ManagedTunnelError,
  ManagedTunnelService,
  managedTunnelIdentity,
  normalizeLoopbackOrigin,
  type ManagedTunnelAllocation,
  type ManagedTunnelStore,
} from "./managedTunnel.ts";

const config: CloudflareManagedTunnelConfig = {
  accountId: "account-1",
  apiToken: "super-secret-token",
  zoneId: "zone-1",
  tunnelDomain: "remote.example.com",
};

NodeTest.test("loopback origin validation normalizes supported local hosts", () => {
  NodeAssert.equal(normalizeLoopbackOrigin("http://localhost:8787"), "http://127.0.0.1:8787");
  NodeAssert.equal(normalizeLoopbackOrigin("http://127.0.0.1:3000/"), "http://127.0.0.1:3000");
  NodeAssert.throws(() => normalizeLoopbackOrigin("https://127.0.0.1:8787"), ManagedTunnelError);
  NodeAssert.throws(() => normalizeLoopbackOrigin("http://192.168.1.10:8787"), ManagedTunnelError);
  NodeAssert.throws(
    () => normalizeLoopbackOrigin("http://127.0.0.1:8787/path"),
    ManagedTunnelError,
  );
});

NodeTest.test(
  "managed tunnel identity is stable and constrained to the configured base domain",
  () => {
    NodeAssert.deepEqual(
      managedTunnelIdentity(
        { id: "env-1234-ABCDE", label: "Emin's Mac mini" },
        "remote.example.com",
      ),
      {
        tunnelName: "dispatch-emin-s-mac-mini-v1234abcde",
        hostname: "emin-s-mac-mini-v1234abcde.remote.example.com",
      },
    );
  },
);

NodeTest.test(
  "Cloudflare client emits the documented tunnel, ingress, DNS, and token requests",
  async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetcher = async (input: string | URL | Request, init: RequestInit = {}) => {
      const url = String(input);
      calls.push({ url, init });
      if (url.endsWith("/cfd_tunnel") && init.method === "POST") {
        return Response.json({ success: true, result: { id: "tunnel-1", name: "dispatch-mac" } });
      }
      if (url.endsWith("/dns_records") && init.method === "POST") {
        return Response.json({ success: true, result: { id: "dns-1" } });
      }
      if (url.endsWith("/configurations") && init.method === "PUT") {
        return Response.json({ success: true, result: {} });
      }
      if (url.endsWith("/token") && init.method === "GET") {
        return Response.json({ success: true, result: "connector-token" });
      }
      return Response.json({ success: true, result: {} });
    };
    const client = new CloudflareManagedTunnelClient(config, fetcher);

    const tunnel = await client.createTunnel("dispatch-mac");
    const dns = await client.createDnsRecord("mac.remote.example.com", tunnel.id);
    await client.configureTunnel(tunnel.id, "mac.remote.example.com", "http://127.0.0.1:8787");
    NodeAssert.equal(await client.getTunnelToken(tunnel.id), "connector-token");
    NodeAssert.equal(dns.id, "dns-1");

    NodeAssert.deepEqual(JSON.parse(String(calls[0]?.init.body)), {
      name: "dispatch-mac",
      config_src: "cloudflare",
    });
    NodeAssert.deepEqual(JSON.parse(String(calls[1]?.init.body)), {
      type: "CNAME",
      name: "mac.remote.example.com",
      content: "tunnel-1.cfargotunnel.com",
      proxied: true,
      ttl: 1,
    });
    NodeAssert.deepEqual(JSON.parse(String(calls[2]?.init.body)), {
      config: {
        ingress: [
          {
            hostname: "mac.remote.example.com",
            service: "http://127.0.0.1:8787",
            originRequest: {},
          },
          { service: "http_status:404" },
        ],
      },
    });
    for (const call of calls) {
      NodeAssert.equal(
        (call.init.headers as Record<string, string>).authorization,
        "Bearer super-secret-token",
      );
    }
  },
);

NodeTest.test(
  "managed tunnel ensure reuses allocation and never persists connector tokens",
  async () => {
    let allocation: ManagedTunnelAllocation | null = null;
    const persisted: unknown[] = [];
    const store: ManagedTunnelStore = {
      getManagedTunnelEnvironment: async () => ({ id: "env-1", label: "Mac mini" }),
      getManagedTunnelAllocation: async () => allocation,
      saveManagedTunnelAllocation: async (input) => {
        persisted.push(input);
        allocation = {
          ...input,
          createdAt: "2026-09-20T20:00:00.000Z",
          updatedAt: "2026-09-20T20:00:00.000Z",
        };
        return allocation;
      },
      upsertManagedTunnelEndpoint: async (_environmentId, hostname) => ({
        kind: "cloudflare_tunnel",
        httpBaseUrl: `https://${hostname}`,
        wsBaseUrl: `wss://${hostname}`,
        updatedAt: "2026-09-20T20:00:00.000Z",
      }),
      deleteManagedTunnelState: async () => undefined,
    };
    let createCount = 0;
    let dnsCount = 0;
    const fetcher = async (input: string | URL | Request, init: RequestInit = {}) => {
      const url = String(input);
      if (url.endsWith("/cfd_tunnel") && init.method === "POST") {
        createCount += 1;
        return Response.json({
          success: true,
          result: { id: "tunnel-1", name: "dispatch-mac-mini-env1" },
        });
      }
      if (url.endsWith("/dns_records") && init.method === "POST") {
        dnsCount += 1;
        return Response.json({ success: true, result: { id: "dns-1" } });
      }
      if (url.endsWith("/token"))
        return Response.json({ success: true, result: "connector-token" });
      return Response.json({ success: true, result: {} });
    };
    const service = new ManagedTunnelService({
      store,
      cloudflare: new CloudflareManagedTunnelClient(config, fetcher),
      tunnelDomain: config.tunnelDomain,
    });

    const [first, second] = await Promise.all([
      service.ensure("env-1", "http://localhost:8787"),
      service.ensure("env-1", "http://127.0.0.1:8787"),
    ]);
    NodeAssert.equal(first.connectorToken, "connector-token");
    NodeAssert.equal(second.connectorToken, "connector-token");
    NodeAssert.equal(createCount, 1);
    NodeAssert.equal(dnsCount, 1);
    NodeAssert.equal(persisted.length, 1);
    NodeAssert.equal(JSON.stringify(persisted).includes("connector-token"), false);
  },
);

NodeTest.test("managed tunnel delete cleans local state after partial remote cleanup", async () => {
  let localDeleted = false;
  const allocation: ManagedTunnelAllocation = {
    environmentId: "env-1",
    tunnelId: "tunnel-1",
    tunnelName: "dispatch-env-1",
    hostname: "env-1.remote.example.com",
    dnsRecordId: "dns-1",
    createdAt: "2026-09-20T20:00:00.000Z",
    updatedAt: "2026-09-20T20:00:00.000Z",
  };
  const store: ManagedTunnelStore = {
    getManagedTunnelEnvironment: async () => ({ id: "env-1", label: "Environment" }),
    getManagedTunnelAllocation: async () => allocation,
    saveManagedTunnelAllocation: async () => allocation,
    upsertManagedTunnelEndpoint: async () => ({
      kind: "cloudflare_tunnel",
      httpBaseUrl: "https://env-1.remote.example.com",
      wsBaseUrl: "wss://env-1.remote.example.com",
      updatedAt: "2026-09-20T20:00:00.000Z",
    }),
    deleteManagedTunnelState: async () => {
      localDeleted = true;
    },
  };
  const deleted: string[] = [];
  const cloudflare = new CloudflareManagedTunnelClient(config, async (input, init = {}) => {
    const url = String(input);
    if (init.method === "DELETE") deleted.push(url);
    if (url.includes("/dns_records/") && init.method === "DELETE") {
      return Response.json({ success: false }, { status: 500 });
    }
    return Response.json({ success: true, result: {} });
  });
  const service = new ManagedTunnelService({
    store,
    cloudflare,
    tunnelDomain: config.tunnelDomain,
  });

  const result = await service.remove("env-1", allocation);
  NodeAssert.deepEqual(result, { remoteCleanup: "partial" });
  NodeAssert.equal(localDeleted, true);
  NodeAssert.equal(deleted.length, 2);
});

NodeTest.test(
  "Cloudflare API failures become stable upstream errors without response leakage",
  async () => {
    const client = new CloudflareManagedTunnelClient(config, async () =>
      Response.json(
        { success: false, errors: [{ message: "sensitive upstream text" }] },
        { status: 403 },
      ),
    );
    await NodeAssert.rejects(
      client.createTunnel("dispatch-test"),
      (error) =>
        error instanceof ManagedTunnelError && error.code === "managed_tunnel_upstream_error",
    );
  },
);

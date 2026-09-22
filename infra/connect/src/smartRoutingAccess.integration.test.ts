// @effect-diagnostics nodeBuiltinImport:off preferSchemaOverJson:off globalFetch:off - Real Node HTTP, Better Auth and isolated PostgreSQL integration.
import * as NodeAssert from "node:assert/strict";
import * as NodeCrypto from "node:crypto";
import * as NodeHttp from "node:http";
import * as NodeTest from "node:test";
import { Pool } from "pg";

import { createConnectAuth } from "./auth.ts";
import { ConnectClientIp } from "./clientIp.ts";
import { loadConfig } from "./config.ts";
import { createConnectDatabase } from "./database.ts";
import { SMART_ROUTING_INPUT_TOKEN_NANOS, SMART_ROUTING_MODEL } from "./smartRouting.ts";
import { createSmartRoutingHttpHandler } from "./smartRoutingHttp.ts";
import { SmartRoutingService } from "./smartRoutingService.ts";
import { SmartRoutingStore } from "./smartRoutingStore.ts";

const testUrl = process.env.DISPATCH_ROUTING_TEST_DATABASE_URL;

NodeTest.test(
  "hosted routing binds real HTTP requests to a live account session and its registered environment",
  { skip: !testUrl },
  async (t) => {
    const databaseUrl = new URL(testUrl!);
    NodeAssert.ok(
      ["127.0.0.1", "localhost"].includes(databaseUrl.hostname),
      "Use an isolated loopback test database",
    );
    NodeAssert.match(
      databaseUrl.pathname,
      /test/i,
      "Database name must explicitly identify a test database",
    );
    const admin = new Pool({ connectionString: databaseUrl.toString() });
    const schema = `routing_access_test_${NodeCrypto.randomUUID().replaceAll("-", "")}`;
    await admin.query(`CREATE SCHEMA ${schema}`);
    databaseUrl.searchParams.set("options", `-c search_path=${schema}`);
    const config = loadConfig({
      DATABASE_URL: databaseUrl.toString(),
      BETTER_AUTH_URL: "http://localhost:8787",
      BETTER_AUTH_SECRET: "isolated-routing-access-better-auth-secret",
      CONNECT_CREDENTIAL_SECRET: "isolated-routing-access-credential-secret",
      CONNECT_JEV_API_KEY: "dummy-operator-key-never-sent-to-a-live-provider",
      CONNECT_ROUTING_ACCOUNT_MONTHLY_REQUESTS: "2",
    });
    const database = createConnectDatabase(config);
    let server: NodeHttp.Server | undefined;
    t.after(async () => {
      if (server) {
        server.closeAllConnections();
        await new Promise<void>((resolve, reject) =>
          server!.close((error) => (error ? reject(error) : resolve())),
        );
      }
      await database.close();
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
    });

    const auth = createConnectAuth(config, database.pool);
    const store = new SmartRoutingStore(database.pool, config.credentialSecret);
    await auth.migrate();
    await database.migrate();
    await store.migrate();

    const makeUser = (name: string) =>
      auth.auth.api.signUpEmail({
        body: {
          name,
          email: `routing-access-${NodeCrypto.randomUUID()}@example.test`,
          password: "isolated-integration-test-password-1234",
        },
      });
    const owner = await makeUser("Account owner");
    const outsider = await makeUser("Other account");
    NodeAssert.ok(owner.token);
    NodeAssert.ok(outsider.token);
    const ownerToken = owner.token;
    const outsiderToken = outsider.token;
    const makeEnvironment = (accountId: string) =>
      database.createEnvironment(accountId, {
        label: "Routing test environment",
        publicKey: NodeCrypto.randomUUID(),
        endpoints: [],
      });
    const environment = await makeEnvironment(owner.user.id);
    const secondEnvironment = await makeEnvironment(owner.user.id);
    const unrelatedEnvironment = await makeEnvironment(outsider.user.id);

    let upstreamCalls = 0;
    const service = new SmartRoutingService({
      store,
      config: config.smartRouting!,
      digestSecret: config.credentialSecret,
      fetch: async (url, init) => {
        upstreamCalls++;
        NodeAssert.equal(url, "https://api.typesafe.ai/v1/systemone");
        NodeAssert.equal(
          new Headers(init?.headers).get("authorization"),
          `Bearer ${config.smartRouting!.apiKey}`,
        );
        NodeAssert.equal(init?.redirect, "error");
        return Response.json({
          model: SMART_ROUTING_MODEL,
          answers: {
            mode: {
              type: "choice",
              choice: "direct",
              confidence: 0.99,
              probabilities: { direct: 1, orchestrated: 0 },
            },
          },
          usage: { input_tokens: 500 },
        });
      },
    });
    const clientIp = new ConnectClientIp([]);
    const handler = createSmartRoutingHttpHandler({
      store,
      service,
      clientIp,
      credentialSecret: config.credentialSecret,
      getSession: async (token) => {
        const result = await auth.getSession({ authorization: `Bearer ${token}` });
        return result ? { accountId: result.user.id, sessionId: result.session.id } : null;
      },
    });
    server = NodeHttp.createServer(async (request, response) => {
      const pathname = new URL(request.url!, "http://localhost").pathname;
      if (!(await handler(request, response, pathname, clientIp.resolve(request))))
        response.writeHead(404).end();
    });
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    NodeAssert.ok(address && typeof address !== "string");
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const input = () => ({
      requestId: NodeCrypto.randomUUID(),
      objective: "Rename the OAuth button label in AuthButton.tsx",
      candidates: [
        {
          id: "chosen-worker",
          label: "Worker selected by user",
          providerInstanceId: "custom-provider",
          model: "custom-model",
          capability: "general",
          options: [],
        },
      ],
    });
    const send = (
      target = environment,
      session: string | null = ownerToken,
      body = input(),
      action: "execution" | "capability" = "execution",
    ) =>
      fetch(`${baseUrl}/v1/environments/${target.environment.id}/smart-routing/${action}`, {
        method: action === "capability" ? "GET" : "POST",
        headers: {
          authorization: `Bearer ${target.credential}`,
          "content-type": "application/json",
          ...(session ? { "x-dispatch-connect-session": session } : {}),
        },
        ...(action === "capability" ? {} : { body: JSON.stringify(body) }),
      });
    const reset = async () => {
      upstreamCalls = 0;
      await database.pool.query(
        "TRUNCATE connect_routing_requests, connect_routing_buckets, connect_routing_accounts",
      );
    };

    await t.test(
      "environment credentials alone and sessions belonging to another account cannot sponsor work",
      async () => {
        for (const session of [null, "forged-token", outsiderToken]) {
          const result = await send(environment, session);
          NodeAssert.equal(result.status, 401);
          NodeAssert.equal(result.headers.get("cache-control"), "no-store");
        }
        NodeAssert.equal((await send(unrelatedEnvironment, ownerToken)).status, 401);
        NodeAssert.equal(upstreamCalls, 0);
        NodeAssert.equal(
          (await database.pool.query("SELECT 1 FROM connect_routing_requests")).rowCount,
          0,
        );
      },
    );

    await t.test(
      "a genuine session receives a decision, and retries reuse the same charged result",
      async () => {
        await reset();
        const objective = input();
        const first = await send(environment, ownerToken, objective);
        NodeAssert.equal(first.status, 200);
        const result = await first.json();
        NodeAssert.equal((result as { mode: string }).mode, "direct");
        const replay = await send(environment, ownerToken, objective);
        NodeAssert.equal(replay.status, 200);
        NodeAssert.deepEqual(await replay.json(), result);
        NodeAssert.equal(upstreamCalls, 1);
        const requests = await database.pool.query(
          "SELECT account_id, environment_id, input_tokens, billed_nanos FROM connect_routing_requests",
        );
        NodeAssert.equal(requests.rowCount, 1);
        NodeAssert.equal(requests.rows[0].account_id, owner.user.id);
        NodeAssert.equal(requests.rows[0].environment_id, environment.environment.id);
        NodeAssert.equal(Number(requests.rows[0].input_tokens), 500);
        NodeAssert.equal(
          Number(requests.rows[0].billed_nanos),
          500 * SMART_ROUTING_INPUT_TOKEN_NANOS,
        );
        NodeAssert.equal(JSON.stringify(result).includes(config.smartRouting!.apiKey), false);
        NodeAssert.equal(JSON.stringify(result).includes(ownerToken), false);
      },
    );

    await t.test(
      "monthly account quota is shared by environments and reflected by the HTTP capability endpoint",
      async () => {
        await reset();
        NodeAssert.equal((await send()).status, 200);
        NodeAssert.equal((await send(secondEnvironment)).status, 200);
        const denied = await send();
        NodeAssert.equal(denied.status, 429);
        NodeAssert.deepEqual(await denied.json(), { error: "smart_routing_quota_exhausted" });
        NodeAssert.ok(denied.headers.get("retry-after"));
        const capability = await send(secondEnvironment, ownerToken, input(), "capability");
        NodeAssert.deepEqual(await capability.json(), {
          available: false,
          reason: "smart_routing_quota_exhausted",
        });
        NodeAssert.equal(upstreamCalls, 2);
        NodeAssert.equal(
          (await database.pool.query("SELECT 1 FROM connect_routing_requests")).rowCount,
          2,
        );
      },
    );

    await t.test(
      "an account suspension applies to both environments and blocks replay of cached paid decisions",
      async () => {
        await reset();
        const request = input();
        NodeAssert.equal((await send(environment, ownerToken, request)).status, 200);
        await store.setAccountBlocked(owner.user.id, true, "Integration test abuse suspension");
        const cached = await send(environment, ownerToken, request);
        NodeAssert.equal(cached.status, 403);
        NodeAssert.deepEqual(await cached.json(), { error: "smart_routing_account_blocked" });
        NodeAssert.equal((await send(secondEnvironment)).status, 403);
        NodeAssert.equal(upstreamCalls, 1);
        await store.setAccountBlocked(owner.user.id, false, "Integration test restored");
        NodeAssert.equal((await send(environment, ownerToken, request)).status, 200);
        NodeAssert.equal(upstreamCalls, 1);
      },
    );

    await t.test(
      "signing out revokes access and cached decisions immediately without deleting environment records",
      async () => {
        await reset();
        const request = input();
        NodeAssert.equal((await send(environment, ownerToken, request)).status, 200);
        await auth.auth.api.signOut({
          headers: new Headers({ authorization: `Bearer ${ownerToken}` }),
        });
        NodeAssert.equal((await send(environment, ownerToken, request)).status, 401);
        NodeAssert.equal(
          (await send(secondEnvironment, ownerToken, input(), "capability")).status,
          401,
        );
        NodeAssert.equal(upstreamCalls, 1);
        const environments = await database.pool.query(
          "SELECT id FROM connect_environments WHERE owner_user_id = $1",
          [owner.user.id],
        );
        NodeAssert.equal(environments.rowCount, 2);
        // The unrelated account's session and its own budget remain usable.
        NodeAssert.equal((await send(unrelatedEnvironment, outsiderToken)).status, 200);
        NodeAssert.equal(upstreamCalls, 2);
      },
    );
  },
);

// @effect-diagnostics nodeBuiltinImport:off preferSchemaOverJson:off - These tests exercise the standalone Node/PostgreSQL control plane.
import * as NodeAssert from "node:assert/strict";
import * as NodeTest from "node:test";
import * as NodeCrypto from "node:crypto";
import { Pool } from "pg";

import { createConnectAuth } from "./auth.ts";
import { loadConfig, type SmartRoutingConfig } from "./config.ts";
import { createConnectDatabase } from "./database.ts";
import { SmartRoutingError, SMART_ROUTING_INPUT_TOKEN_NANOS } from "./smartRouting.ts";
import { SmartRoutingStore, type SmartRoutingPrincipal } from "./smartRoutingStore.ts";
import { routingAdmin } from "./routingAdmin.ts";

const testUrl = process.env.DISPATCH_ROUTING_TEST_DATABASE_URL;

NodeTest.test(
  "Smart Routing atomic accounting against a real isolated PostgreSQL database",
  { skip: !testUrl },
  async (t) => {
    const sourceUrl = new URL(testUrl!);
    NodeAssert.ok(
      ["127.0.0.1", "localhost"].includes(sourceUrl.hostname),
      "Only an explicitly isolated loopback database may be used",
    );
    NodeAssert.match(sourceUrl.pathname, /test/i, "The test database name must include test");
    const admin = new Pool({ connectionString: sourceUrl.toString() });
    const schema = `routing_test_${NodeCrypto.randomUUID().replaceAll("-", "")}`;
    await admin.query(`CREATE SCHEMA ${schema}`);
    sourceUrl.searchParams.set("options", `-c search_path=${schema}`);
    const config = loadConfig({
      DATABASE_URL: sourceUrl.toString(),
      BETTER_AUTH_URL: "http://localhost:8787",
      BETTER_AUTH_SECRET: "a-secure-dummy-secret-for-isolated-test",
      CONNECT_CREDENTIAL_SECRET: "another-dummy-test-credential-secret",
      CONNECT_JEV_API_KEY: "dummy-not-a-live-key",
    });
    const database = createConnectDatabase(config);
    const auth = createConnectAuth(config, database.pool);
    const store = new SmartRoutingStore(database.pool, config.credentialSecret);
    t.after(async () => {
      await database.close();
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
    });
    await auth.migrate();
    await database.migrate();
    await store.migrate();
    const user = await auth.auth.api.signUpEmail({
      body: {
        name: "Routing test",
        email: `routing-${NodeCrypto.randomUUID()}@example.test`,
        password: "isolated-test-password-123456",
      },
    });
    const user2 = await auth.auth.api.signUpEmail({
      body: {
        name: "Routing test two",
        email: `routing-${NodeCrypto.randomUUID()}@example.test`,
        password: "isolated-test-password-123456",
      },
    });
    const env = await database.createEnvironment(user.user.id, {
      label: "Routing test one",
      publicKey: NodeCrypto.randomUUID(),
      endpoints: [],
    });
    const env2 = await database.createEnvironment(user.user.id, {
      label: "Routing test two",
      publicKey: NodeCrypto.randomUUID(),
      endpoints: [],
    });
    const otherEnv = await database.createEnvironment(user2.user.id, {
      label: "Other account",
      publicKey: NodeCrypto.randomUUID(),
      endpoints: [],
    });
    const accountSession = await auth.getSession({ authorization: `Bearer ${user.token}` });
    const otherAccountSession = await auth.getSession({ authorization: `Bearer ${user2.token}` });
    NodeAssert.ok(accountSession);
    NodeAssert.ok(otherAccountSession);
    const session = { accountId: user.user.id, sessionId: accountSession.session.id };
    const otherSession = { accountId: user2.user.id, sessionId: otherAccountSession.session.id };
    const principal = await store.authenticate(env.environment.id, env.credential, session);
    const principal2 = await store.authenticate(env2.environment.id, env2.credential, session);
    const otherPrincipal = await store.authenticate(
      otherEnv.environment.id,
      otherEnv.credential,
      otherSession,
    );
    const base = config.smartRouting!;
    const decision = {
      mode: "direct" as const,
      difficulty: "routine" as const,
      workload: "short" as const,
      source: "jev" as const,
      confidence: 0.95,
      reason: "One worker",
    };
    const request = (
      owner: SmartRoutingPrincipal = principal,
      overrides: Partial<SmartRoutingConfig> = {},
    ) => ({
      principal: owner,
      requestId: NodeCrypto.randomUUID(),
      operation: "execution" as const,
      digest: NodeCrypto.createHash("sha256").update(NodeCrypto.randomUUID()).digest("hex"),
      ipHash: "hashed-test-ip",
      config: { ...base, ...overrides },
    });
    const reset = async () => {
      await database.pool.query(
        "TRUNCATE connect_routing_requests, connect_routing_buckets, connect_routing_accounts",
      );
      await database.pool.query("UPDATE connect_routing_control SET disabled = false");
    };

    await t.test(
      "account identity is derived from credentials; forged environment and account revocation are rejected",
      async () => {
        NodeAssert.equal(principal.accountId, user.user.id);
        NodeAssert.equal(principal.newAccount, true);
        await NodeAssert.rejects(
          store.authenticate(otherEnv.environment.id, env.credential, session),
          (error) => error instanceof SmartRoutingError && error.status === 401,
        );
        await store.setAccountBlocked(principal.accountId, true, "test abuse suspension");
        await NodeAssert.rejects(
          store.authenticate(env2.environment.id, env2.credential, session),
          (error) => error instanceof SmartRoutingError && error.status === 403,
        );
        await NodeAssert.rejects(
          store.reserve(request()),
          (error) => error instanceof SmartRoutingError && error.status === 403,
        );
        await store.setAccountBlocked(principal.accountId, false, "restored");
        NodeAssert.equal(
          (await store.authenticate(env.environment.id, env.credential, session)).accountId,
          user.user.id,
        );
      },
    );

    await t.test(
      "concurrent environments share an account concurrency limit across store instances",
      async () => {
        await reset();
        const secondStore = new SmartRoutingStore(database.pool, config.credentialSecret);
        const attempts = Array.from({ length: 12 }, (_, index) =>
          request(index % 2 ? principal : principal2, { maxConcurrentPerAccount: 2 }),
        );
        const results = await Promise.allSettled(
          attempts.map((input, index) => (index % 2 ? store : secondStore).reserve(input)),
        );
        NodeAssert.equal(results.filter((result) => result.status === "fulfilled").length, 2);
        for (const result of results) {
          if (result.status === "rejected")
            NodeAssert.equal((result.reason as SmartRoutingError).code, "smart_routing_busy");
        }
        const bucket = await database.pool.query(
          "SELECT requests, reserved_nanos FROM connect_routing_buckets WHERE scope = 'global' AND length(bucket) = 7",
        );
        NodeAssert.equal(Number(bucket.rows[0].requests), 2);
        NodeAssert.equal(Number(bucket.rows[0].reserved_nanos), 2 * base.requestCostNanos);
      },
    );

    await t.test(
      "global monthly budget cannot be overspent by different accounts racing to reserve",
      async () => {
        await reset();
        const attempts = Array.from({ length: 10 }, (_, index) =>
          request(index % 2 ? principal : otherPrincipal, {
            maxConcurrentPerAccount: 20,
            maxConcurrentGlobal: 20,
            monthlyBudgetNanos: base.requestCostNanos * 3,
          }),
        );
        const results = await Promise.allSettled(attempts.map((input) => store.reserve(input)));
        NodeAssert.equal(results.filter((result) => result.status === "fulfilled").length, 3);
        for (const result of results)
          if (result.status === "rejected")
            NodeAssert.equal(
              (result.reason as SmartRoutingError).code,
              "smart_routing_budget_exhausted",
            );
        const bucket = await database.pool.query(
          "SELECT reserved_nanos FROM connect_routing_buckets WHERE scope = 'global' AND length(bucket) = 7",
        );
        NodeAssert.equal(Number(bucket.rows[0].reserved_nanos), 3 * base.requestCostNanos);
      },
    );

    await t.test(
      "daily account quota follows the account across environments and survives restarts",
      async () => {
        await reset();
        const first = request(principal, { accountDailyRequests: 1 });
        await store.reserve(first);
        await store.complete(principal, first.requestId, decision, 200);
        const restarted = new SmartRoutingStore(database.pool, config.credentialSecret);
        await NodeAssert.rejects(
          restarted.reserve(request(principal2, { accountDailyRequests: 1 })),
          (error) =>
            error instanceof SmartRoutingError && error.code === "smart_routing_quota_exhausted",
        );
        const count = await database.pool.query(
          "SELECT requests FROM connect_routing_buckets WHERE scope = 'global' AND length(bucket) = 7",
        );
        NodeAssert.equal(
          Number(count.rows[0].requests),
          1,
          "failed admission must rollback earlier global increments",
        );
      },
    );

    await t.test(
      "idempotency is persistent and rebinding a request to another environment or payload conflicts",
      async () => {
        await reset();
        const first = request();
        await store.reserve(first);
        await NodeAssert.rejects(
          store.reserve(first),
          (error) =>
            error instanceof SmartRoutingError && error.code === "smart_routing_request_pending",
        );
        await store.complete(principal, first.requestId, decision, 500);
        const restarted = new SmartRoutingStore(database.pool, config.credentialSecret);
        NodeAssert.deepEqual(await restarted.reserve(first), {
          kind: "cached",
          response: decision,
        });
        await NodeAssert.rejects(
          store.reserve({ ...first, digest: "different-payload" }),
          (error) =>
            error instanceof SmartRoutingError && error.code === "smart_routing_request_conflict",
        );
        await NodeAssert.rejects(
          store.reserve({ ...first, principal: principal2 }),
          (error) =>
            error instanceof SmartRoutingError && error.code === "smart_routing_request_conflict",
        );
      },
    );

    await t.test(
      "settlement returns unused token allowance exactly once without refunding request quotas",
      async () => {
        await reset();
        const first = request();
        await store.reserve(first);
        await store.complete(principal, first.requestId, decision, 500);
        await store.complete(principal, first.requestId, decision, 100);
        const buckets = await database.pool.query(
          "SELECT requests, reserved_nanos FROM connect_routing_buckets",
        );
        for (const bucket of buckets.rows) {
          NodeAssert.equal(Number(bucket.requests), 1);
          NodeAssert.equal(Number(bucket.reserved_nanos), 500 * SMART_ROUTING_INPUT_TOKEN_NANOS);
        }
        const usage = await database.pool.query(
          "SELECT input_tokens, billed_nanos FROM connect_routing_requests",
        );
        NodeAssert.equal(Number(usage.rows[0].input_tokens), 500);
        NodeAssert.equal(Number(usage.rows[0].billed_nanos), 500 * SMART_ROUTING_INPUT_TOKEN_NANOS);
      },
    );

    await t.test(
      "timeout reservations are retained and the kill switch denies every account",
      async () => {
        await reset();
        const first = request();
        await store.reserve(first);
        await store.complete(principal, first.requestId, null);
        const usage = await database.pool.query(
          "SELECT billed_nanos FROM connect_routing_requests",
        );
        NodeAssert.equal(Number(usage.rows[0].billed_nanos), base.requestCostNanos);
        await NodeAssert.rejects(
          store.reserve(first),
          (error) =>
            error instanceof SmartRoutingError &&
            error.code === "smart_routing_upstream_unavailable",
        );
        await database.pool.query("UPDATE connect_routing_control SET disabled = true");
        NodeAssert.equal((await store.capability(principal, base)).available, false);
        await NodeAssert.rejects(
          store.reserve(request(otherPrincipal)),
          (error) =>
            error instanceof SmartRoutingError && error.code === "smart_routing_unavailable",
        );
      },
    );

    await t.test(
      "a session must belong to the environment owner and remain unexpired at admission",
      async () => {
        await reset();
        await NodeAssert.rejects(
          store.authenticate(env.environment.id, env.credential, otherSession),
          SmartRoutingError,
        );
        await database.pool.query(
          'UPDATE "session" SET "expiresAt" = now() - interval \'1 second\' WHERE id = $1',
          [session.sessionId],
        );
        await NodeAssert.rejects(
          store.authenticate(env.environment.id, env.credential, session),
          SmartRoutingError,
        );
        await NodeAssert.rejects(store.reserve(request()), SmartRoutingError);
        NodeAssert.equal((await store.capability(principal, base)).available, false);
        NodeAssert.equal(
          (await database.pool.query("SELECT 1 FROM connect_routing_requests")).rowCount,
          0,
        );
        await database.pool.query(
          'UPDATE "session" SET "expiresAt" = now() + interval \'1 day\' WHERE id = $1',
          [session.sessionId],
        );
        NodeAssert.equal((await store.capability(principal, base)).available, true);
      },
    );

    await t.test(
      "daily global budget and rolling burst limits remain atomic across independent connection pools",
      async () => {
        await reset();
        const independentPool = new Pool({ connectionString: sourceUrl.toString() });
        const independent = new SmartRoutingStore(independentPool, config.credentialSecret);
        try {
          const attempts = Array.from({ length: 10 }, (_, index) =>
            request(index % 2 ? principal : otherPrincipal, {
              dailyBudgetNanos: base.requestCostNanos * 2,
              maxConcurrentPerAccount: 20,
              maxConcurrentGlobal: 20,
            }),
          );
          const results = await Promise.allSettled(
            attempts.map((input, index) => (index % 2 ? independent : store).reserve(input)),
          );
          NodeAssert.equal(results.filter((result) => result.status === "fulfilled").length, 2);
          NodeAssert.equal(
            (
              await store.capability(principal, {
                ...base,
                dailyBudgetNanos: base.requestCostNanos * 2,
              })
            ).reason,
            "smart_routing_budget_exhausted",
          );
          await reset();
          const bursts = await Promise.allSettled(
            Array.from({ length: 8 }, (_, index) =>
              (index % 2 ? independent : store).reserve(
                request(principal, {
                  accountBurstRequests: 2,
                  maxConcurrentPerAccount: 20,
                  maxConcurrentGlobal: 20,
                }),
              ),
            ),
          );
          NodeAssert.equal(bursts.filter((result) => result.status === "fulfilled").length, 2);
          for (const result of bursts)
            if (result.status === "rejected")
              NodeAssert.equal(
                (result.reason as SmartRoutingError).code,
                "smart_routing_rate_limited",
              );
        } finally {
          await independentPool.end();
        }
      },
    );

    await t.test(
      "sustained usage and the environment cap apply across credentials without new inference",
      async () => {
        await reset();
        const first = request(principal, { maxEnvironmentsPerAccount: 1 });
        await store.reserve(first);
        await store.complete(principal, first.requestId, decision, 200);
        await NodeAssert.rejects(
          store.reserve(request(principal2, { maxEnvironmentsPerAccount: 1 })),
          (error) =>
            error instanceof SmartRoutingError && error.code === "smart_routing_environment_limit",
        );
        await NodeAssert.rejects(
          store.reserve(request(principal, { accountHourlyRequests: 1 })),
          (error) =>
            error instanceof SmartRoutingError && error.code === "smart_routing_rate_limited",
        );
        const second = request();
        await store.reserve(second);
        await database.pool.query(
          "UPDATE connect_routing_requests SET lease_expires_at = now() - interval '1 second' WHERE request_id = $1",
          [second.requestId],
        );
        await store.cleanup();
        await NodeAssert.rejects(
          store.reserve(second),
          (error) =>
            error instanceof SmartRoutingError &&
            error.code === "smart_routing_upstream_unavailable",
        );
        const interrupted = await database.pool.query(
          "SELECT billed_nanos, outcome FROM connect_routing_requests WHERE request_id = $1",
          [second.requestId],
        );
        NodeAssert.equal(interrupted.rows[0].outcome, "interrupted");
        NodeAssert.equal(Number(interrupted.rows[0].billed_nanos), base.requestCostNanos);
      },
    );

    await t.test(
      "operator restrictions are reversible and retain a reasoned audit without storing task text",
      async () => {
        await reset();
        await routingAdmin(
          ["limits", principal.accountId, "0", "default", "temporary review"],
          database.pool,
          store,
          "test-operator",
        );
        NodeAssert.equal(
          (await store.capability(principal, base)).reason,
          "smart_routing_quota_exhausted",
        );
        await NodeAssert.rejects(
          store.reserve(request()),
          (error) =>
            error instanceof SmartRoutingError && error.code === "smart_routing_quota_exhausted",
        );
        await routingAdmin(
          ["limits", principal.accountId, "default", "default", "review completed"],
          database.pool,
          store,
          "test-operator",
        );
        await routingAdmin(
          ["block", principal.accountId, "test suspension"],
          database.pool,
          store,
          "test-operator",
        );
        await NodeAssert.rejects(
          store.reserve(request()),
          (error) => error instanceof SmartRoutingError && error.status === 403,
        );
        await routingAdmin(
          ["unblock", principal.accountId, "appeal accepted"],
          database.pool,
          store,
          "test-operator",
        );
        await routingAdmin(
          ["pause", "upstream maintenance"],
          database.pool,
          store,
          "test-operator",
        );
        NodeAssert.equal((await store.capability(principal, base)).available, false);
        await routingAdmin(
          ["resume", "maintenance complete"],
          database.pool,
          store,
          "test-operator",
        );
        NodeAssert.equal((await store.capability(principal, base)).available, true);
        const admitted = request();
        await store.reserve(admitted);
        await store.complete(principal, admitted.requestId, decision, 500);
        const report = (await routingAdmin(
          ["account", principal.accountId],
          database.pool,
          store,
          "test-operator",
        )) as { requests: unknown[]; audit: { action: string; actor: string; reason: string }[] };
        NodeAssert.equal(report.requests.length, 1);
        NodeAssert.ok(
          report.audit.some(
            (entry) =>
              entry.action === "unblock" &&
              entry.reason === "appeal accepted" &&
              entry.actor === "test-operator",
          ),
        );
        const columns = await database.pool.query(
          "SELECT column_name FROM information_schema.columns WHERE table_schema = $1 AND table_name = 'connect_routing_requests'",
          [schema],
        );
        for (const forbidden of [
          "objective",
          "prompt",
          "api_key",
          "credential",
          "session_token",
          "ip_address",
        ])
          NodeAssert.equal(
            columns.rows.some((row) => row.column_name === forbidden),
            false,
          );
      },
    );

    await t.test(
      "revoking Connect sessions invalidates cached capability and future admissions while retaining environment records",
      async () => {
        await reset();
        NodeAssert.ok(
          await store.revokeAccountSessions(
            otherPrincipal.accountId,
            "compromised session",
            "test-operator",
          ),
        );
        await NodeAssert.rejects(
          store.authenticate(otherEnv.environment.id, otherEnv.credential, otherSession),
          SmartRoutingError,
        );
        await NodeAssert.rejects(store.reserve(request(otherPrincipal)), SmartRoutingError);
        NodeAssert.equal((await store.capability(otherPrincipal, base)).available, false);
        const environment = await database.pool.query(
          "SELECT id FROM connect_environments WHERE id = $1",
          [otherEnv.environment.id],
        );
        NodeAssert.equal(environment.rowCount, 1);
      },
    );

    await t.test(
      "zero budget rejects the first request and revocation is rechecked at admission",
      async () => {
        await reset();
        await NodeAssert.rejects(
          store.reserve(request(principal, { monthlyBudgetNanos: 0 })),
          (error) =>
            error instanceof SmartRoutingError && error.code === "smart_routing_budget_exhausted",
        );
        NodeAssert.equal(
          (await database.pool.query("SELECT 1 FROM connect_routing_requests")).rowCount,
          0,
        );
        await database.revokeEnvironmentCredentials(user.user.id, env.environment.id);
        await NodeAssert.rejects(
          store.reserve(request()),
          (error) => error instanceof SmartRoutingError && error.status === 401,
        );
        await NodeAssert.rejects(
          store.authenticate(env.environment.id, env.credential, session),
          (error) => error instanceof SmartRoutingError && error.status === 401,
        );
      },
    );
  },
);

import { expect, it } from "@effect/vitest";
import * as NodeSqliteClient from "@dispatch/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { migrationManifest, runMigrations } from "../Migrations.ts";

it.effect("creates isolated orchestration v2 tables without changing legacy team storage", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations({ toMigrationInclusive: 55 });

    yield* sql`INSERT INTO team_policy (id, revision, payload) VALUES (1, 7, '{}')`;
    yield* sql`INSERT INTO team_runs (id, command_id, revision, payload) VALUES ('legacy-run', 'legacy-command', 3, '{}')`;
    yield* sql`INSERT INTO team_events (run_id, revision, payload) VALUES ('legacy-run', 3, '{}')`;
    yield* sql`INSERT INTO team_effects (id, run_id, task_id, generation, status, payload) VALUES ('legacy-effect', 'legacy-run', 'task', 1, 'settled', '{}')`;

    const legacyBefore = yield* sql<{ name: string; sql: string }>`
      SELECT name, sql
      FROM sqlite_master
      WHERE type = 'table' AND name LIKE 'team_%'
      ORDER BY name
    `;

    yield* runMigrations({ toMigrationInclusive: 56 });

    const legacyAfter = yield* sql<{ name: string; sql: string }>`
      SELECT name, sql
      FROM sqlite_master
      WHERE type = 'table' AND name LIKE 'team_%'
      ORDER BY name
    `;
    expect(legacyAfter).toEqual(legacyBefore);

    const legacyCounts = yield* sql<{
      policies: number;
      runs: number;
      events: number;
      effects: number;
    }>`
      SELECT
        (SELECT COUNT(*) FROM team_policy) AS policies,
        (SELECT COUNT(*) FROM team_runs) AS runs,
        (SELECT COUNT(*) FROM team_events) AS events,
        (SELECT COUNT(*) FROM team_effects) AS effects
    `;
    expect(legacyCounts[0]).toEqual({ policies: 1, runs: 1, events: 1, effects: 1 });

    const v2Tables = yield* sql<{ name: string }>`
      SELECT name
      FROM sqlite_master
      WHERE type = 'table' AND name LIKE 'orchestration_v2_%'
      ORDER BY name
    `;
    expect(v2Tables.map(({ name }) => name)).toEqual([
      "orchestration_v2_events",
      "orchestration_v2_runs",
      "orchestration_v2_settings",
    ]);
    expect(migrationManifest.at(-1)).toEqual([56, "OrchestrationV2"]);
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);

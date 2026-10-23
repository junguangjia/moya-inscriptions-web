import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import {
  assertCatalogPrepareReaderReady,
  assertCatalogPublicationScopeReady,
  createPostgresPool,
  parsePostgresConfig,
  PostgresStartupError,
} from "@moya/catalog-postgres";
import {
  CommunityMigrationStateError,
  CommunitySchemaNotReadyError,
  runCommunityMigrations,
  verifyCommunityMigrationLedger,
} from "@moya/community-postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  catalogScaleCounts,
  catalogScaleIndexedStatements as statements,
  catalogScaleShape,
  createCatalogScaleDatabase,
  explainCatalogScaleOn as plan,
  rolledBackCatalogScale as rolledBack,
  seedCatalogScale,
  type CatalogScaleDatabase,
} from "./catalog-scale-fixture.js";
import { requireSyntheticTestDatabaseUrl } from "./synthetic-test-database.js";

/*
 * catalog-scale-v1 (Issue #323) 1B, W6: App migration A1
 * (20261024010000_catalog_publication_scope), its runtime grants, the worker
 * and Backend startup checks of those grants and of the prepare reader's
 * grant on the private views, and the plans of the indexes A1 and CMS
 * migration M2 add:
 * - A1 applies to a seeded database without rewriting a row and to an empty
 *   one with the same result; behind a publication writer it fails after
 *   its 5 s lock_timeout (55P03) and leaves nothing behind, then applies
 *   once the writer has ended, and a re-run applies nothing; the App role
 *   holds exactly the privileges the scoped reconcile uses (no DELETE, no
 *   re-keying, no second state row);
 * - startup refuses, naming the missing relation, column and privilege,
 *   before the migration, before its grants and after any one is revoked,
 *   and without the state row; the prepare reader's check names the private
 *   view it cannot read;
 * - over a long intent history the snapshot's cursor reads the live
 *   projection through M2's index instead of every intent ever prepared,
 *   the sync's mirror statements read the observed-live rows through A1's
 *   partial index rather than the tombstones, the reconcile's in-flight
 *   and pending reads use theirs, and a job's inspection reads a pinned
 *   rendition's publications, history included, through A1's rendition
 *   index rather than every publication. The planner picks each index
 *   itself here, on a small Catalog with the ended history of a large one;
 *   the same plans at the 25k fixture, with their costs and JIT, are
 *   measured outside CI by catalog-scale-indexes.ts
 *   (docs/development/catalog-scale-bench.md).
 * Each database is a dedicated synthetic one; content is synthetic.
 */

const SLOW = 300_000;
const A1 = "20261024010000";
const BEFORE_A1 = "20261020160000";
const root = fileURLToPath(new URL("../../../", import.meta.url));
const migrations = `${root}/database/community-migrations`;
const target = requireSyntheticTestDatabaseUrl();
const openPool = (url: string) =>
  createPostgresPool(parsePostgresConfig({ DATABASE_URL: url }));

type Pool = CatalogScaleDatabase["setup"];

const roleOf = async (pool: Pool) =>
  (await pool.query<{ role: string }>("SELECT current_user AS role")).rows[0]!
    .role;

/** Re-applies the App role's runtime grants, as the Owner's step does. */
const grantRuntime = async (fixture: CatalogScaleDatabase) => {
  const role = await roleOf(fixture.app);
  const sql = (
    await readFile(
      `${root}/infra/development/work-publishing/grant-runtime.sql`,
      "utf8",
    )
  ).replaceAll(':"app_role"', `"${role}"`);
  await fixture.setup.query(sql);
};

/** The two new relations' columns, constraints, indexes and row, and the
 * App role's privileges on them with its name replaced, for comparison. */
const scopeSchema = async (fixture: CatalogScaleDatabase) => {
  const role = await roleOf(fixture.app);
  const relations = [
    "community.catalog_publication_dirty",
    "community.catalog_reconcile_state",
  ];
  const rows = async (sql: string) =>
    (await fixture.setup.query(sql, [relations])).rows;
  return {
    columns: await rows(
      `SELECT attrelid::regclass::text AS relation, attname, format_type(atttypid, atttypmod) AS type,
         attnotnull, pg_get_expr(d.adbin, d.adrelid) AS "default"
       FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
       WHERE attrelid = ANY($1::regclass[]) AND attnum > 0 AND NOT attisdropped
       ORDER BY 1, attnum`,
    ),
    constraints: await rows(
      `SELECT conrelid::regclass::text AS relation, contype, pg_get_constraintdef(oid) AS definition
       FROM pg_constraint WHERE conrelid = ANY($1::regclass[]) ORDER BY 1, 3`,
    ),
    indexes: (
      await fixture.setup.query(
        `SELECT indexname, indexdef FROM pg_indexes
         WHERE schemaname = 'community' AND indexname = ANY($1::text[]) ORDER BY 1`,
        [
          [
            "catalog_publication_dirty_pkey",
            "catalog_publication_dirty_pending",
            "catalog_reconcile_state_pkey",
            "catalog_delivery_prepares_observed_live",
            "media_publications_in_flight",
            "media_publications_rendition",
          ],
        ],
      )
    ).rows,
    state: (
      await fixture.setup.query(
        "SELECT to_jsonb(s) - 'updated_at' AS row FROM community.catalog_reconcile_state s",
      )
    ).rows,
    privileges: (await privileges(fixture.setup, role)).map((entry) =>
      entry.replaceAll(role, "<app>"),
    ),
  };
};

/** The App role's relation and column ACL entries on the two new tables. */
const privileges = async (pool: Pool, role: string) =>
  (
    await pool.query<{ entry: string }>(
      `WITH r AS (SELECT oid FROM pg_roles WHERE rolname = $1)
       SELECT c.relname || '|' || a.privilege_type AS entry
         FROM pg_class c, aclexplode(c.relacl) a, r
        WHERE c.oid = ANY($2::regclass[]) AND a.grantee = r.oid
       UNION ALL
       SELECT c.relname || '.' || att.attname || '|' || a.privilege_type
         FROM pg_attribute att JOIN pg_class c ON c.oid = att.attrelid,
           aclexplode(att.attacl) a, r
        WHERE c.oid = ANY($2::regclass[]) AND a.grantee = r.oid AND NOT att.attisdropped
       ORDER BY 1`,
      [
        role,
        [
          "community.catalog_publication_dirty",
          "community.catalog_reconcile_state",
        ],
      ],
    )
  ).rows.map(({ entry }) => `${entry} (${role})`);

const scopeRefusal = (missing: string) =>
  `Catalog publication scope is not ready for the App role (missing ${missing}): apply App migration ${A1}, then infra/development/work-publishing/grant-runtime.sql`;
const prepareRefusal = (view: string) =>
  `Catalog prepare reader cannot read ${view}: apply CMS migration 20261024_000000, then re-run infra/development/catalog-media/grant-prepare-read.sql`;
const startupRefusal = async (check: Promise<unknown>) => {
  const error = await check.then(
    () => {
      throw new Error("expected a startup refusal");
    },
    (reason: unknown) => reason,
  );
  expect(error).toBeInstanceOf(PostgresStartupError);
  return (error as Error).message;
};

const ASSET = (n: number) =>
  `catalog-asset-${n.toString(16).padStart(32, "0")}`;

describe("App migration A1, its grants and the startup checks", () => {
  // Seeded through the migration before A1, then upgraded by the test.
  let upgraded: CatalogScaleDatabase;
  // Every migration applied to an empty database.
  let fresh: CatalogScaleDatabase;
  const shape = catalogScaleShape(140);

  beforeAll(async () => {
    upgraded = await createCatalogScaleDatabase({
      target,
      openPool,
      label: "csscope_up",
      communityThrough: BEFORE_A1,
    });
    fresh = await createCatalogScaleDatabase({
      target,
      openPool,
      label: "csscope_new",
    });
  }, SLOW);

  afterAll(async () => {
    await Promise.all([upgraded?.close(), fresh?.close()]);
  }, SLOW);

  it(
    "applies to a seeded database without rewriting a row, and startup refuses until the migration and its grants are in",
    async () => {
      await seedCatalogScale(upgraded, shape);
      // Two publications in flight (withdrawing, purge failed) besides the
      // published generations.
      await upgraded.setup.query(
        `UPDATE community.media_publications SET state = 'withdrawing', withdraw_requested_at = now()
         WHERE id IN (SELECT id FROM community.media_publications ORDER BY id LIMIT 2)`,
      );
      await upgraded.setup.query(
        `UPDATE community.media_publications SET state = 'purge_failed'
         WHERE id = (SELECT id FROM community.media_publications ORDER BY id LIMIT 1)`,
      );
      const snapshot = async () =>
        (
          await upgraded.setup.query<{ rows: unknown }>(
            `SELECT (SELECT jsonb_agg(to_jsonb(p) ORDER BY p.intent_id) FROM community.catalog_delivery_prepares p)
               || (SELECT jsonb_agg(to_jsonb(m) ORDER BY m.id) FROM community.media_publications m) AS rows`,
          )
        ).rows[0]!.rows;
      const before = await snapshot();

      // Before A1: the App role's check names the missing relations, and the
      // ledger check of this release refuses too.
      const missingBefore = await startupRefusal(
        assertCatalogPublicationScopeReady(upgraded.app),
      );
      expect(missingBefore).toContain(
        "missing SELECT on community.catalog_publication_dirty, INSERT on community.catalog_publication_dirty, UPDATE (mark_seq) on community.catalog_publication_dirty",
      );
      expect(missingBefore).toContain(
        "UPDATE (updated_at) on community.catalog_reconcile_state)",
      );
      await expect(
        verifyCommunityMigrationLedger(upgraded.app),
      ).rejects.toBeInstanceOf(CommunitySchemaNotReadyError);

      // A publication writer still running holds A1 off: the run waits at
      // most five seconds (its lock_timeout) for its first index on
      // media_publications, after the two tables and the mirror's index,
      // then fails with 55P03 and leaves none of them behind.
      const leftBehind = async () =>
        (
          await upgraded.setup.query(
            `SELECT (SELECT count(*)::integer FROM community.schema_migrations WHERE migration_id = $1) AS applied,
               array_remove(ARRAY[
                 to_regclass('community.catalog_publication_dirty')::text,
                 to_regclass('community.catalog_publication_dirty_pending')::text,
                 to_regclass('community.catalog_reconcile_state')::text,
                 to_regclass('community.catalog_delivery_prepares_observed_live')::text,
                 to_regclass('community.media_publications_in_flight')::text,
                 to_regclass('community.media_publications_rendition')::text
               ], NULL) AS relations`,
            [A1],
          )
        ).rows;
      const writer = await upgraded.setup.connect();
      try {
        await writer.query("BEGIN");
        await writer.query(
          "LOCK TABLE community.media_publications IN ROW EXCLUSIVE MODE",
        );
        const started = Date.now();
        const failure = await runCommunityMigrations(
          upgraded.setup,
          migrations,
        ).catch((error: unknown) => error);
        const waited = Date.now() - started;
        expect(failure).toBeInstanceOf(CommunityMigrationStateError);
        expect((failure as { cause?: { code?: string } }).cause?.code).toBe(
          "55P03",
        );
        expect(waited).toBeGreaterThanOrEqual(4_500);
        expect(waited).toBeLessThan(15_000);
      } finally {
        await writer.query("ROLLBACK");
        writer.release();
      }
      expect(await leftBehind()).toEqual([{ applied: 0, relations: [] }]);
      expect(await snapshot()).toEqual(before);

      // Once the writer has ended, A1 applies, once.
      expect(await runCommunityMigrations(upgraded.setup, migrations)).toEqual([
        A1,
      ]);
      expect(await runCommunityMigrations(upgraded.setup, migrations)).toEqual(
        [],
      );
      expect(await snapshot()).toEqual(before);
      expect(
        (
          await upgraded.setup.query(
            `SELECT (SELECT count(*)::integer FROM community.catalog_publication_dirty) AS dirty,
               (SELECT jsonb_agg(to_jsonb(s) - 'updated_at') FROM community.catalog_reconcile_state s) AS state`,
          )
        ).rows,
      ).toEqual([
        {
          dirty: 0,
          state: [
            {
              id: true,
              sweep_cursor: null,
              policy_digest: null,
              public_count: null,
              public_sum: null,
              public_observed_at: null,
              private_count: null,
              private_sum: null,
              private_observed_at: null,
              render_backlog: null,
              render_backlog_at: null,
            },
          ],
        },
      ]);
      // The indexes were built over the existing rows: each is valid and,
      // read alone, lists exactly the rows its predicate or key names.
      const counts = catalogScaleCounts(shape);
      await rolledBack(upgraded.setup, async (client) => {
        await client.query("SET LOCAL enable_seqscan = off");
        expect(
          (
            await client.query(
              `SELECT c.relname, i.indisvalid FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
               WHERE c.relname IN ('catalog_delivery_prepares_observed_live', 'media_publications_in_flight',
                 'catalog_publication_dirty_pending', 'media_publications_rendition') ORDER BY 1`,
            )
          ).rows,
        ).toEqual([
          {
            relname: "catalog_delivery_prepares_observed_live",
            indisvalid: true,
          },
          { relname: "catalog_publication_dirty_pending", indisvalid: true },
          { relname: "media_publications_in_flight", indisvalid: true },
          { relname: "media_publications_rendition", indisvalid: true },
        ]);
        // The purge-failed publication is history the live index left out;
        // the rendition index still lists it under its rendition.
        const { rendition } = (
          await client.query<{ rendition: string }>(
            "SELECT rendition_id AS rendition FROM community.media_publications WHERE state = 'purge_failed'",
          )
        ).rows[0]!;
        const byRendition =
          "SELECT state FROM community.media_publications WHERE rendition_id = $1";
        expect(
          (await plan(client, byRendition, [rendition])).nodes,
        ).toContainEqual(
          expect.stringContaining("using media_publications_rendition"),
        );
        expect((await client.query(byRendition, [rendition])).rows).toEqual([
          { state: "purge_failed" },
        ]);
        const live =
          "SELECT count(*)::integer AS n FROM community.catalog_delivery_prepares WHERE observed_live";
        expect((await plan(client, live)).nodes).toContainEqual(
          expect.stringContaining(
            "using catalog_delivery_prepares_observed_live",
          ),
        );
        expect((await client.query(live)).rows).toEqual([
          { n: counts.liveIntents },
        ]);
        const inFlight =
          "SELECT state, count(*)::integer AS n FROM community.media_publications WHERE state IN ('publishing', 'withdrawing', 'purge_failed') GROUP BY state ORDER BY state";
        expect((await plan(client, inFlight)).nodes).toContainEqual(
          expect.stringContaining("using media_publications_in_flight"),
        );
        expect((await client.query(inFlight)).rows).toEqual([
          { state: "purge_failed", n: 1 },
          { state: "withdrawing", n: 1 },
        ]);
      });

      // The tables exist, but the App role holds nothing on them until the
      // grants are re-applied: startup still refuses, naming each privilege.
      expect(
        await startupRefusal(assertCatalogPublicationScopeReady(upgraded.app)),
      ).toBe(missingBefore);
      await verifyCommunityMigrationLedger(upgraded.app);
      await grantRuntime(upgraded);
      await assertCatalogPublicationScopeReady(upgraded.app);
      expect(await snapshot()).toEqual(before);
    },
    SLOW,
  );

  it("leaves an empty database with the same relations, constraints, indexes, row and grants", async () => {
    const upgradedSchema = await scopeSchema(upgraded);
    expect(await scopeSchema(fresh)).toEqual(upgradedSchema);
    expect(upgradedSchema.indexes).toEqual([
      {
        indexname: "catalog_delivery_prepares_observed_live",
        indexdef:
          "CREATE INDEX catalog_delivery_prepares_observed_live ON community.catalog_delivery_prepares USING btree (intent_id) WHERE observed_live",
      },
      {
        indexname: "catalog_publication_dirty_pending",
        indexdef:
          "CREATE INDEX catalog_publication_dirty_pending ON community.catalog_publication_dirty USING btree (urgent DESC, marked_at, asset_id) WHERE (mark_seq > cleared_seq)",
      },
      {
        indexname: "catalog_publication_dirty_pkey",
        indexdef:
          "CREATE UNIQUE INDEX catalog_publication_dirty_pkey ON community.catalog_publication_dirty USING btree (asset_id)",
      },
      {
        indexname: "catalog_reconcile_state_pkey",
        indexdef:
          "CREATE UNIQUE INDEX catalog_reconcile_state_pkey ON community.catalog_reconcile_state USING btree (id)",
      },
      {
        indexname: "media_publications_in_flight",
        indexdef:
          "CREATE INDEX media_publications_in_flight ON community.media_publications USING btree (public_asset_id) WHERE (state = ANY (ARRAY['publishing'::text, 'withdrawing'::text, 'purge_failed'::text]))",
      },
      {
        indexname: "media_publications_rendition",
        indexdef:
          "CREATE INDEX media_publications_rendition ON community.media_publications USING btree (rendition_id)",
      },
    ]);
    // No foreign key: a mark never locks the asset row the sync locks.
    expect(
      upgradedSchema.constraints.filter(
        ({ contype }: { contype: string }) => contype === "f",
      ),
    ).toEqual([]);
  });

  it("grants the App role exactly what the scoped reconcile uses on the two tables", async () => {
    const role = await roleOf(fresh.app);
    expect(await privileges(fresh.setup, role)).toEqual(
      [
        "catalog_publication_dirty.cleared_seq|UPDATE",
        "catalog_publication_dirty.mark_seq|UPDATE",
        "catalog_publication_dirty.marked_at|UPDATE",
        "catalog_publication_dirty.reason|UPDATE",
        "catalog_publication_dirty.urgent|UPDATE",
        "catalog_publication_dirty|INSERT",
        "catalog_publication_dirty|SELECT",
        "catalog_reconcile_state.policy_digest|UPDATE",
        "catalog_reconcile_state.private_count|UPDATE",
        "catalog_reconcile_state.private_observed_at|UPDATE",
        "catalog_reconcile_state.private_sum|UPDATE",
        "catalog_reconcile_state.public_count|UPDATE",
        "catalog_reconcile_state.public_observed_at|UPDATE",
        "catalog_reconcile_state.public_sum|UPDATE",
        "catalog_reconcile_state.render_backlog_at|UPDATE",
        "catalog_reconcile_state.render_backlog|UPDATE",
        "catalog_reconcile_state.sweep_cursor|UPDATE",
        "catalog_reconcile_state.updated_at|UPDATE",
        "catalog_reconcile_state|SELECT",
      ]
        .map((entry) => `${entry} (${role})`)
        .sort(),
    );

    // What the reconcile does, as the App role: mark (insert, then raise the
    // same row, keeping its place in the queue and its class), read the
    // queue in order, urgent marks first, clear exactly the mark it read, and
    // advance the state row.
    await rolledBack(fresh.app, async (client) => {
      const mark = (asset: string, reason: string, urgent: boolean) =>
        client.query<{ mark_seq: string; marked_at: Date; urgent: boolean }>(
          `INSERT INTO community.catalog_publication_dirty AS d (asset_id, mark_seq, reason, urgent, marked_at)
           VALUES ($1, 1, $2, $3, clock_timestamp())
           ON CONFLICT (asset_id) DO UPDATE SET mark_seq = d.mark_seq + 1, reason = EXCLUDED.reason,
             urgent = EXCLUDED.urgent OR (d.mark_seq > d.cleared_seq AND d.urgent),
             marked_at = CASE WHEN d.mark_seq > d.cleared_seq THEN d.marked_at ELSE EXCLUDED.marked_at END
           RETURNING mark_seq, marked_at, urgent`,
          [asset, reason, urgent],
        );
      const first = (await mark(ASSET(1), "reference", false)).rows[0]!;
      await mark(ASSET(2), "intent", false);
      await mark(ASSET(4), "public_membership", true);
      const again = (await mark(ASSET(1), "rendition", false)).rows[0]!;
      expect(again).toEqual({
        mark_seq: "2",
        marked_at: first.marked_at,
        urgent: false,
      });
      const queue =
        "SELECT asset_id, mark_seq FROM community.catalog_publication_dirty WHERE mark_seq > cleared_seq ORDER BY urgent DESC, marked_at, asset_id LIMIT 10";
      expect((await client.query(queue)).rows).toEqual([
        { asset_id: ASSET(4), mark_seq: "1" },
        { asset_id: ASSET(1), mark_seq: "2" },
        { asset_id: ASSET(2), mark_seq: "1" },
      ]);
      expect(
        (
          await client.query(
            "UPDATE community.catalog_publication_dirty SET cleared_seq = $2 WHERE asset_id = $1 AND mark_seq = $2",
            [ASSET(4), 1],
          )
        ).rowCount,
      ).toBe(1);
      expect(
        (
          await client.query(
            "UPDATE community.catalog_publication_dirty SET cleared_seq = $2 WHERE asset_id = $1 AND mark_seq = $2",
            [ASSET(1), 2],
          )
        ).rowCount,
      ).toBe(1);
      expect((await client.query(queue)).rows).toEqual([
        { asset_id: ASSET(2), mark_seq: "1" },
      ]);
      expect(
        (
          await client.query(
            `UPDATE community.catalog_reconcile_state SET sweep_cursor = $1, policy_digest = repeat('a', 64),
               public_count = 2, public_sum = -12345678901234567890, public_observed_at = now(),
               private_count = 0, private_sum = 0, private_observed_at = now(),
               render_backlog = '{"t0": 1}', render_backlog_at = now(), updated_at = now()
             WHERE id RETURNING sweep_cursor`,
            [ASSET(1)],
          )
        ).rows,
      ).toEqual([{ sweep_cursor: ASSET(1) }]);
    });

    // Never a delete, a re-key, a second state row or a truncation.
    for (const sql of [
      "DELETE FROM community.catalog_publication_dirty",
      "TRUNCATE community.catalog_publication_dirty",
      "UPDATE community.catalog_publication_dirty SET asset_id = asset_id",
      "INSERT INTO community.catalog_reconcile_state (id, updated_at) VALUES (true, now())",
      "DELETE FROM community.catalog_reconcile_state",
      "UPDATE community.catalog_reconcile_state SET id = id",
      "TRUNCATE community.catalog_reconcile_state",
    ])
      await expect(fresh.app.query(sql), sql).rejects.toMatchObject({
        code: "42501",
      });
    // The checks hold for the App role's own writes.
    for (const [sql, values] of [
      [
        "INSERT INTO community.catalog_publication_dirty (asset_id, mark_seq, reason, marked_at) VALUES ($1, 1, 'reference', now())",
        ["catalog-asset-not-an-id"],
      ],
      [
        "INSERT INTO community.catalog_publication_dirty (asset_id, mark_seq, reason, marked_at) VALUES ($1, 1, 'whim', now())",
        [ASSET(3)],
      ],
      [
        "INSERT INTO community.catalog_publication_dirty (asset_id, mark_seq, reason, marked_at) VALUES ($1, 0, 'reference', now())",
        [ASSET(3)],
      ],
      [
        "INSERT INTO community.catalog_publication_dirty (asset_id, mark_seq, cleared_seq, reason, marked_at) VALUES ($1, 1, 2, 'reference', now())",
        [ASSET(3)],
      ],
      [
        "UPDATE community.catalog_reconcile_state SET sweep_cursor = $1 WHERE id",
        ["not-an-asset"],
      ],
      [
        "UPDATE community.catalog_reconcile_state SET public_count = 1 WHERE id",
        [],
      ],
      [
        "UPDATE community.catalog_reconcile_state SET render_backlog = $1::jsonb, render_backlog_at = now() WHERE id",
        ["[]"],
      ],
    ] as const)
      await expect(
        fresh.app.query(sql, [...values]),
        sql,
      ).rejects.toMatchObject({ code: "23514" });
    // One state row: even the owner cannot add a second.
    await expect(
      fresh.setup.query(
        "INSERT INTO community.catalog_reconcile_state (id, updated_at) VALUES (false, now())",
      ),
    ).rejects.toMatchObject({ code: "23514" });
  });

  it("refuses startup, naming what is missing, when a grant is revoked from the App role or the prepare reader", async () => {
    const appRole = await roleOf(fresh.app);
    const prepareRole = await roleOf(fresh.prepare);
    await assertCatalogPublicationScopeReady(fresh.app);
    await assertCatalogPrepareReaderReady(fresh.prepare);
    try {
      for (const [revoke, missing] of [
        [
          `REVOKE UPDATE (cleared_seq) ON community.catalog_publication_dirty FROM "${appRole}"`,
          "UPDATE (cleared_seq) on community.catalog_publication_dirty",
        ],
        [
          `REVOKE UPDATE (urgent) ON community.catalog_publication_dirty FROM "${appRole}"`,
          "UPDATE (urgent) on community.catalog_publication_dirty",
        ],
        [
          `REVOKE INSERT ON community.catalog_publication_dirty FROM "${appRole}"`,
          "INSERT on community.catalog_publication_dirty",
        ],
        [
          `REVOKE SELECT ON community.catalog_reconcile_state FROM "${appRole}"`,
          "SELECT on community.catalog_reconcile_state",
        ],
        [
          `REVOKE UPDATE (render_backlog) ON community.catalog_reconcile_state FROM "${appRole}"`,
          "UPDATE (render_backlog) on community.catalog_reconcile_state",
        ],
      ] as const) {
        await fresh.setup.query(revoke);
        expect(
          await startupRefusal(assertCatalogPublicationScopeReady(fresh.app)),
          revoke,
        ).toBe(scopeRefusal(missing));
        await grantRuntime(fresh);
        await assertCatalogPublicationScopeReady(fresh.app);
      }

      // The prepare reader: each private view by name; another role (the
      // public reader, never granted either view) is refused at the first.
      for (const view of [
        "public.catalog_delivery_live_prepare_media",
        "public.catalog_delivery_prepare_media",
      ]) {
        await fresh.setup.query(
          `REVOKE SELECT ON ${view} FROM "${prepareRole}"`,
        );
        expect(
          await startupRefusal(assertCatalogPrepareReaderReady(fresh.prepare)),
        ).toBe(prepareRefusal(view));
        await fresh.setup.query(`GRANT SELECT ON ${view} TO "${prepareRole}"`);
        await assertCatalogPrepareReaderReady(fresh.prepare);
      }
      expect(
        await startupRefusal(assertCatalogPrepareReaderReady(fresh.publicRead)),
      ).toBe(prepareRefusal("public.catalog_delivery_prepare_media"));
    } finally {
      await grantRuntime(fresh);
    }
  });

  it("refuses startup without the single state row, which the App role cannot re-create", async () => {
    await assertCatalogPublicationScopeReady(fresh.app);
    try {
      // An owner-side truncate, or a restore without data, removes it.
      await fresh.setup.query("TRUNCATE community.catalog_reconcile_state");
      expect(
        await startupRefusal(assertCatalogPublicationScopeReady(fresh.app)),
      ).toBe(
        "Catalog publication scope is not ready for the App role (missing the community.catalog_reconcile_state row): re-create it with the migration role as App migration 20261024010000 does",
      );
      // Otherwise the reconcile's every state update would change nothing.
      expect(
        (
          await fresh.app.query(
            "UPDATE community.catalog_reconcile_state SET updated_at = now() WHERE id",
          )
        ).rowCount,
      ).toBe(0);
    } finally {
      await fresh.setup.query(
        "INSERT INTO community.catalog_reconcile_state (id, updated_at) VALUES (true, now()) ON CONFLICT (id) DO NOTHING",
      );
    }
    await assertCatalogPublicationScopeReady(fresh.app);
  });
});

describe("A1 and M2 indexes over a long intent history", () => {
  // 700 published images (100 records) with the ended history of a Catalog
  // larger than the 25k fixture: 20,000 ended intents, all but the 6 recent
  // ones outside the live projection and mirror tombstones. The live set is
  // small beside them, so the planner picks each index itself, as it does
  // at 25k once history outgrows the live set; this shape seeds in seconds.
  const shape = catalogScaleShape(700, { endedIntents: 20_000 });
  const counts = catalogScaleCounts(shape);
  let fixture: CatalogScaleDatabase;

  beforeAll(async () => {
    fixture = await createCatalogScaleDatabase({
      target,
      openPool,
      label: "csscope_hist",
    });
    await seedCatalogScale(fixture, shape);
  }, SLOW);

  afterAll(async () => {
    await fixture?.close();
  }, SLOW);

  it("reads the live prepare projection through M2's index, not every intent ever prepared", async () => {
    const read = await rolledBack(fixture.prepare, (client) =>
      plan(client, statements.privateCursor, [], { analyze: true }),
    );
    expect(read.rows).toBe(counts.livePrivateRows);
    expect(read.nodes).toContainEqual(
      "Bitmap Index Scan using catalog_delivery_intents_state_ended",
    );
    expect(read.nodes).not.toContainEqual(
      "Seq Scan on catalog_delivery_intents",
    );
    expect(read.jit).toBe(false);
    // Without the index the same read scans the whole history.
    const unindexed = await rolledBack(fixture.setup, async (client) => {
      await client.query("DROP INDEX catalog_delivery_intents_state_ended");
      return plan(client, statements.privateCursor);
    });
    expect(unindexed.nodes).toContainEqual(
      "Seq Scan on catalog_delivery_intents",
    );
  });

  it("reads and tombstones the mirror's live rows through A1's partial index, leaving the tombstones alone", async () => {
    const snapshotIds = (
      await fixture.setup.query<{ ids: string[] }>(
        "SELECT array_agg(DISTINCT intent_id)::text[] AS ids FROM public.catalog_delivery_live_prepare_media",
      )
    ).rows[0]!.ids;
    expect(snapshotIds).toHaveLength(counts.liveIntents);
    const at = new Date();
    // The sync's two mirror statements, as the App role plans them.
    for (const [sql, values, rows] of [
      [statements.mirrorRead, [snapshotIds], counts.liveIntents],
      [statements.tombstone, [snapshotIds, at], 0],
    ] as const) {
      const read = await rolledBack(fixture.app, (client) =>
        plan(client, sql, values, { analyze: true }),
      );
      expect(read.rows, sql).toBe(rows);
      // A bitmap or a plain index scan of the live rows (the mirror read is
      // two disjoint reads, the other by primary key).
      expect(read.nodes, sql).toContainEqual(
        expect.stringMatching(
          /Index Scan using catalog_delivery_prepares_observed_live/u,
        ),
      );
      expect(read.nodes, sql).not.toContainEqual(
        "Seq Scan on catalog_delivery_prepares",
      );
      expect(read.jit, sql).toBe(false);
      const unindexed = await rolledBack(fixture.setup, async (client) => {
        await client.query(
          "DROP INDEX community.catalog_delivery_prepares_observed_live",
        );
        return plan(client, sql, values);
      });
      expect(unindexed.nodes, sql).toContainEqual(
        "Seq Scan on catalog_delivery_prepares",
      );
    }
  });

  it("lists in-flight publications and pending marks through A1's partial indexes", async () => {
    // Three of the published generations are being withdrawn; the reconcile
    // scope's first part lists their assets.
    const inFlight = await rolledBack(fixture.setup, async (client) => {
      await client.query(
        `UPDATE community.media_publications SET state = 'withdrawing', withdraw_requested_at = now()
         WHERE id IN (SELECT id FROM community.media_publications ORDER BY id LIMIT 3)`,
      );
      return plan(client, statements.inFlight, [1_000, true], {
        analyze: true,
      });
    });
    expect(inFlight.rows).toBe(3);
    expect(inFlight.nodes).toContainEqual(
      expect.stringMatching(/using media_publications_in_flight/u),
    );
    expect(inFlight.nodes).not.toContainEqual("Seq Scan on media_publications");
    expect(inFlight.jit).toBe(false);

    // 20,000 marks, 1,000 of them pending and a tenth of those urgent: the
    // read walks the pending rows in order, urgent ones first, without a
    // sort or the cleared ones.
    try {
      const queue = await rolledBack(fixture.setup, async (client) => {
        await client.query(
          `INSERT INTO community.catalog_publication_dirty (asset_id, mark_seq, cleared_seq, reason, urgent, marked_at)
           SELECT 'catalog-asset-' || lpad(to_hex(g), 32, '0'), 1, CASE WHEN g <= 1000 THEN 0 ELSE 1 END,
             'reference', g % 10 = 0, now() - make_interval(secs => g)
           FROM generate_series(1, 20000) AS g`,
        );
        await client.query("ANALYZE community.catalog_publication_dirty");
        return plan(client, statements.pending, [1_000], { analyze: true });
      });
      expect(queue.rows).toBe(1000);
      expect(queue.nodes).toContainEqual(
        expect.stringMatching(
          /^Index (Only )?Scan using catalog_publication_dirty_pending on catalog_publication_dirty$/u,
        ),
      );
      expect(queue.nodes).not.toContainEqual(expect.stringMatching(/Sort/u));
      expect(queue.jit).toBe(false);
    } finally {
      // ANALYZE's page and row counts are not rolled back.
      await fixture.setup.query("ANALYZE community.catalog_publication_dirty");
    }
  });

  it("reads a pinned rendition's publications, history included, through A1's rendition index", async () => {
    // A job's inspection reads every publication of each pinned rendition
    // and keeps the published one. The partial live index holds only the
    // publishing and published rows, so without A1's index the read scans
    // every publication ever made.
    const { rendition } = (
      await fixture.setup.query<{ rendition: string }>(
        "SELECT rendition_id AS rendition FROM community.media_publications WHERE state = 'published' ORDER BY id LIMIT 1",
      )
    ).rows[0]!;
    const published = await rolledBack(fixture.app, (client) =>
      plan(client, statements.renditionPublications, [rendition], {
        analyze: true,
      }),
    );
    // The same generation once withdrawn, which the live index leaves out.
    const withdrawn = await rolledBack(fixture.setup, async (client) => {
      await client.query(
        `UPDATE community.media_publications SET state = 'withdrawing', withdraw_requested_at = now()
         WHERE rendition_id = $1`,
        [rendition],
      );
      return plan(client, statements.renditionPublications, [rendition], {
        analyze: true,
      });
    });
    for (const read of [published, withdrawn]) {
      expect(read.rows).toBe(1);
      expect(read.nodes).toContainEqual(
        expect.stringMatching(/using media_publications_rendition/u),
      );
      expect(read.nodes).not.toContainEqual("Seq Scan on media_publications");
      expect(read.jit).toBe(false);
    }
    const unindexed = await rolledBack(fixture.setup, async (client) => {
      await client.query("DROP INDEX community.media_publications_rendition");
      return plan(client, statements.renditionPublications, [rendition]);
    });
    expect(unindexed.nodes).toContainEqual("Seq Scan on media_publications");
  });
});

import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";

import {
  closePostgresPool,
  createPostgresPool,
  parsePostgresConfig,
} from "@moya/catalog-postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  CATALOG_PREPARE_RETENTION_HOURS,
  downgradeCatalogDeliveryPrepareViewsSql,
  upgradeCatalogDeliveryPrepareViewsSql,
} from "admin/published";

/*
 * catalog-scale-v1 (Issue #323) 1B, W2: CMS migration M2. The private
 * prepare projection becomes a security_barrier view without the OFFSET 0
 * fence (same rows and columns), so one intent is read by its primary key, and
 * a live projection holds only what the worker's complete snapshot needs:
 * every released intent and every other one that ended or expired within
 * R = 96 hours. A clone of the real migrated intent table starts at the view
 * text migration 20261020_160000 created (read from that file), and the
 * exported upgrade and downgrade SQL is applied to it the way Payload applies
 * a migration: in one transaction. Shared CMS content is never read.
 */

const testDatabaseUrl = process.env.CMS_TEST_DATABASE_URL;
if (!testDatabaseUrl) {
  throw new Error("CMS_TEST_DATABASE_URL is required for CMS view tests");
}
const baseConfig = parsePostgresConfig({ DATABASE_URL: testDatabaseUrl });
const schema = `cms_live_prepare_${randomUUID().replaceAll("-", "")}`;
const schemaConnection = new URL(baseConfig.connectionString);
schemaConnection.searchParams.set("options", `-csearch_path=${schema},public`);
const adminPool = createPostgresPool(baseConfig);
const pool = createPostgresPool({
  ...baseConfig,
  connectionString: schemaConnection.toString(),
});
const connect = () => pool.connect();
type Client = Awaited<ReturnType<typeof connect>>;

const views = [
  "catalog_delivery_prepare_media",
  "catalog_delivery_live_prepare_media",
] as const;
const byText = (a: unknown, b: unknown) =>
  JSON.stringify(a) < JSON.stringify(b) ? -1 : 1;
const hex = (n: number) => n.toString(16).padStart(12, "0");
const intentId = (n: number) => `00000000-0000-4000-8000-${hex(n)}`;

/** The text of migration 20261020_160000, which created the intents. */
const intentsMigration = () =>
  readFile(
    new URL(
      "../../apps/admin/src/migrations/20261020_160000_catalog_delivery_intents.ts",
      import.meta.url,
    ),
    "utf8",
  );

/** The view text migration 20261020_160000 created, from that file. */
const originalViewSql = async () => {
  const view =
    /CREATE VIEW catalog_delivery_prepare_media AS[\s\S]*?OFFSET 0;/u.exec(
      await intentsMigration(),
    );
  if (!view) throw new Error("Original prepare view text not found");
  return view[0];
};

/** The intent table's indexes migration 20261020_160000 created (M2 adds
 * one), from that file; the clone takes its primary key separately. */
const originalIndexSql = async () => {
  const indexes = [
    ...(await intentsMigration()).matchAll(
      /CREATE (?:UNIQUE )?INDEX catalog_delivery_intents_\w+\s+ON catalog_delivery_intents[^;]*;/gu,
    ),
  ].map(([statement]) => statement);
  if (indexes.length !== 2)
    throw new Error("Original intent indexes not found");
  return indexes.join("\n");
};

interface Intent {
  readonly n: number;
  readonly state: string;
  /** Hours from now to expires_at (negative: already expired). */
  readonly expires: number;
  /** Hours since ended_at, for an ended intent. */
  readonly ended?: number;
  readonly recipe?: boolean;
  readonly members?: number;
  /** A manifest width that is not an integer. */
  readonly malformed?: boolean;
}

/** Synthetic intents around the retention boundary, in every state. */
const fixture: readonly (Intent & { readonly live: boolean })[] = [
  // Released: always live, whatever its old lease.
  { n: 1, state: "released", expires: -500, live: true },
  { n: 2, state: "prepared", expires: 20, live: true },
  { n: 3, state: "release_requested", expires: 2, live: true },
  // An expired lease (state still prepared or requested in the CMS).
  { n: 4, state: "release_requested", expires: -10, live: true },
  { n: 5, state: "prepared", expires: -95, live: true },
  { n: 6, state: "prepared", expires: -97, live: false },
  { n: 7, state: "release_requested", expires: -200, live: false },
  // Ended intents, by their end.
  { n: 8, state: "cancelled", expires: -60, ended: 50, live: true },
  { n: 9, state: "superseded", expires: -100, ended: 95, live: true },
  { n: 10, state: "expired", expires: -30, ended: 1, live: true },
  { n: 11, state: "withdrawn", expires: -500, ended: 97, live: false },
  { n: 12, state: "cancelled", expires: -300, ended: 120, live: false },
  // No recipe: in neither view. Its manifest width is not an integer.
  {
    n: 13,
    state: "prepared",
    expires: 20,
    recipe: false,
    malformed: true,
    live: false,
  },
];

const insertIntent = (client: Pick<Client, "query">, intent: Intent) => {
  const members = Array.from({ length: intent.members ?? 3 }, (_, i) => ({
    mediaId: `synthetic-live-media-${intent.n}-${i}`,
    objectKey: `editorial/${"a".repeat(64)}/${"b".repeat(64)}-${hex(intent.n)}${hex(i)}${"c".repeat(40)}.jpg`,
    sourceSha256: "c".repeat(64),
    width: intent.malformed ? "wide" : 3000 + i,
    height: 2000 + i,
  }));
  const requested = ["release_requested", "released"].includes(intent.state);
  return client.query(
    `INSERT INTO catalog_delivery_intents (id, catalog_document_id, catalog_id,
       actor_id, draft_revision, draft_fingerprint, draft_snapshot, base_revision,
       base_status, base_fingerprint, media_manifest, media_manifest_sha256,
       recipe_manifest, recipe_manifest_sha256, state, state_version,
       release_requested_by, release_requested_at, ended_at, end_reason, expires_at)
     VALUES ($1, $2::integer, 'synthetic-live-' || $2::integer, 1, 1, repeat('a', 64), '{}'::jsonb, 0,
       'draft', repeat('b', 64), $3::jsonb, repeat('c', 64),
       CASE WHEN $4::boolean THEN '{}'::jsonb END,
       CASE WHEN $4::boolean THEN repeat('d', 64) END, $5, 2,
       CASE WHEN $6::boolean THEN 1 END, CASE WHEN $6::boolean THEN now() END,
       now() - $7::double precision * interval '1 hour',
       CASE WHEN $7::double precision IS NOT NULL THEN 'synthetic' END,
       now() + $8::double precision * interval '1 hour')`,
    [
      intentId(intent.n),
      intent.n,
      JSON.stringify(members),
      intent.recipe ?? true,
      intent.state,
      requested,
      intent.ended ?? null,
      intent.expires,
    ],
  );
};

/** Runs `check` in a transaction that is always rolled back. */
const rolledBack = async (check: (client: Client) => Promise<void>) => {
  const client = await connect();
  try {
    await client.query("BEGIN");
    await check(client);
  } finally {
    await client.query("ROLLBACK").catch(() => undefined);
    client.release();
  }
};

const viewState = async (client: Client, view: string) => {
  const found = (
    await client.query<{
      oid: number;
      owner: number;
      acl: string[] | null;
      options: string[] | null;
      definition: string;
    }>(
      `SELECT c.oid::integer AS oid, c.relowner::integer AS owner,
         c.relacl::text[] AS acl, c.reloptions AS options,
         pg_get_viewdef(c.oid) AS definition
       FROM pg_class c WHERE c.oid = to_regclass(format('%I.%I', $1::text, $2::text))`,
      [schema, view],
    )
  ).rows[0];
  if (!found) return null;
  const columns = (
    await client.query(
      `SELECT attname, format_type(atttypid, atttypmod) AS type
       FROM pg_attribute WHERE attrelid = $1::oid AND attnum > 0
       ORDER BY attnum`,
      [found.oid],
    )
  ).rows;
  const updatable = (
    await client.query(
      `SELECT is_updatable, is_insertable_into FROM information_schema.views
       WHERE table_schema = $1 AND table_name = $2`,
      [schema, view],
    )
  ).rows;
  return { ...found, columns, updatable };
};

const rowsOf = async (client: Client, view: string) =>
  (await client.query(`SELECT * FROM ${view}`)).rows.sort(byText);

/** The intent table's indexes in this schema, schema name left out. */
const intentIndexes = async (client: Client) =>
  (
    await client.query<{ name: string; definition: string }>(
      `SELECT indexname AS name, replace(indexdef, $1 || '.', '') AS definition
       FROM pg_indexes WHERE schemaname = $1 AND tablename = 'catalog_delivery_intents'
       ORDER BY 1`,
      [schema],
    )
  ).rows;
/** The index M2 adds for the live projection's released and ended rows. */
const liveIndex = {
  name: "catalog_delivery_intents_state_ended",
  definition:
    "CREATE INDEX catalog_delivery_intents_state_ended ON catalog_delivery_intents USING btree (state, ended_at)",
};

interface PlanNode {
  readonly "Node Type": string;
  readonly "Relation Name"?: string;
  readonly "Index Name"?: string;
  readonly Plans?: readonly PlanNode[];
}
const planNodes = (node: PlanNode): PlanNode[] => [
  node,
  ...(node.Plans ?? []).flatMap(planNodes),
];
/** The scans of catalog_delivery_intents when reading one intent of `view`. */
const intentScans = async (client: Client, view: string) =>
  planNodes(
    (
      await client.query<{ "QUERY PLAN": [{ Plan: PlanNode }] }>(
        `EXPLAIN (FORMAT JSON) SELECT * FROM ${view} WHERE intent_id = $1`,
        [intentId(2)],
      )
    ).rows[0]!["QUERY PLAN"][0].Plan,
  )
    .filter((node) => node["Relation Name"] === "catalog_delivery_intents")
    .map((node) => `${node["Node Type"]}:${node["Index Name"] ?? ""}`);

beforeAll(async () => {
  await adminPool.query(`CREATE SCHEMA "${schema}"`);
  // The intent table as 20261020_160000 left it: columns, defaults and
  // checks of the migrated table, but only that migration's indexes (the
  // migrated public table also carries the index M2 adds).
  await pool.query(
    `CREATE TABLE "${schema}".catalog_delivery_intents
       (LIKE public.catalog_delivery_intents INCLUDING ALL EXCLUDING INDEXES)`,
  );
  await pool.query("ALTER TABLE catalog_delivery_intents ADD PRIMARY KEY (id)");
  await pool.query(await originalIndexSql());
  await pool.query(await originalViewSql());
  for (const intent of fixture) await insertIntent(pool, intent);
  // 3,000 intents withdrawn long ago, so a whole-view read is the costly plan.
  await pool.query(
    `INSERT INTO catalog_delivery_intents (id, catalog_document_id, catalog_id,
       actor_id, draft_revision, draft_fingerprint, draft_snapshot, base_revision,
       base_status, base_fingerprint, media_manifest, media_manifest_sha256,
       recipe_manifest, recipe_manifest_sha256, state, state_version,
       release_requested_by, release_requested_at, ended_at, end_reason, expires_at)
     SELECT ('00000000-0000-4000-9000-' || lpad(to_hex(g), 12, '0'))::uuid, 1000 + g,
       'synthetic-old-' || g, 1, 1, repeat('a', 64), '{}'::jsonb, 0, 'draft',
       repeat('b', 64), '[]'::jsonb, repeat('c', 64), '{}'::jsonb, repeat('d', 64),
       'withdrawn', 3, 1, now() - interval '400 hours', now() - interval '300 hours',
       'synthetic', now() - interval '380 hours'
     FROM generate_series(1, 3000) AS g`,
  );
  await pool.query("ANALYZE catalog_delivery_intents");
}, 30_000);

afterAll(async () => {
  await closePostgresPool(pool);
  try {
    await adminPool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
  } finally {
    await closePostgresPool(adminPool);
  }
});

describe("catalog delivery live prepare migration (M2)", () => {
  it("is registered after M1 and applied by the real Payload run", async () => {
    const registry = await readFile(
      new URL("../../apps/admin/src/migrations/index.ts", import.meta.url),
      "utf8",
    );
    const names = [...registry.matchAll(/name: "([^"]+)"/gu)].map(
      ([, name]) => name,
    );
    expect(names.indexOf("20261024_000000_catalog_delivery_live_prepare")).toBe(
      names.indexOf("20261023_000000_catalog_media_keyed_reads") + 1,
    );
    // tests/cms runs after `payload migrate`; this is that database's state.
    expect(
      (
        await adminPool.query(
          "SELECT count(*)::integer AS count FROM public.payload_migrations WHERE name = $1",
          ["20261024_000000_catalog_delivery_live_prepare"],
        )
      ).rows,
    ).toEqual([{ count: 1 }]);
    const applied = (
      await adminPool.query<{
        name: string;
        options: string[] | null;
        definition: string;
        public: boolean;
      }>(
        `SELECT c.relname AS name, c.reloptions AS options,
           pg_get_viewdef(c.oid) AS definition,
           has_table_privilege('public', c.oid, 'SELECT') AS public
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = 'public' AND c.relname = ANY($1::text[])
         ORDER BY c.relname`,
        [[...views]],
      )
    ).rows;
    expect(applied.map(({ name }) => name)).toEqual([...views].sort());
    expect(
      (
        await adminPool.query(
          "SELECT indexdef FROM pg_indexes WHERE schemaname = 'public' AND indexname = $1",
          [liveIndex.name],
        )
      ).rows,
    ).toEqual([
      {
        indexdef: liveIndex.definition.replace(
          " ON catalog_delivery_intents ",
          " ON public.catalog_delivery_intents ",
        ),
      },
    ]);
    for (const view of applied) {
      expect(view.options).toEqual(["security_barrier=true"]);
      expect(view.definition).not.toMatch(/OFFSET/u);
      // Never readable by PUBLIC; only the grant script grants a reader.
      expect(view.public).toBe(false);
    }
  });

  it("starts each statement set with a transaction-scoped lock_timeout and keeps R in the view", () => {
    for (const sql of [
      upgradeCatalogDeliveryPrepareViewsSql,
      downgradeCatalogDeliveryPrepareViewsSql,
    ])
      expect(sql.trimStart()).toMatch(/^SET LOCAL lock_timeout = '5s';\n/u);
    expect(CATALOG_PREPARE_RETENTION_HOURS).toBe(96);
    expect(
      upgradeCatalogDeliveryPrepareViewsSql.match(/interval '96 hours'/gu),
    ).toHaveLength(2);
  });

  it("keeps the old view's rows, columns, OID, owner and grant, and the intent table's indexes, across up, down and up", async () => {
    await rolledBack(async (client) => {
      const role = `cms_live_reader_${randomUUID().replaceAll("-", "")}`;
      await client.query(`CREATE ROLE "${role}" NOLOGIN`);
      await client.query(
        `GRANT SELECT ON catalog_delivery_prepare_media TO "${role}"`,
      );
      const today = (await viewState(client, views[0]))!;
      const rows = await rowsOf(client, views[0]);
      expect(today.options).toBeNull();
      expect(today.definition).toMatch(/\n\s*OFFSET 0;$/u);
      expect(await viewState(client, views[1])).toBeNull();
      const indexes = await intentIndexes(client);
      expect(indexes.map(({ name }) => name)).toEqual([
        "catalog_delivery_intents_expiry",
        "catalog_delivery_intents_one_active",
        "catalog_delivery_intents_pkey",
      ]);
      // 3 members for each of intents 1-3, one header for each other intent
      // with a recipe (9 of the fixture's and the 3,000 withdrawn ones).
      expect(rows).toHaveLength(9 + 9 + 3_000);

      const expectUpgraded = async () => {
        const state = (await viewState(client, views[0]))!;
        expect(state.options).toEqual(["security_barrier=true"]);
        expect(state.definition).not.toMatch(/OFFSET/u);
        expect(state.columns).toEqual(today.columns);
        expect(state.updatable).toEqual([
          { is_updatable: "NO", is_insertable_into: "NO" },
        ]);
        expect({ oid: state.oid, owner: state.owner, acl: state.acl }).toEqual({
          oid: today.oid,
          owner: today.owner,
          acl: today.acl,
        });
        expect(await rowsOf(client, views[0])).toEqual(rows);
        expect(await intentIndexes(client)).toEqual([...indexes, liveIndex]);
        const live = (await viewState(client, views[1]))!;
        expect(live.options).toEqual(["security_barrier=true"]);
        expect(live.columns).toEqual(today.columns);
        expect(live.updatable).toEqual([
          { is_updatable: "NO", is_insertable_into: "NO" },
        ]);
        // Owner only: the grant script grants its reader.
        expect(live.acl).toBeNull();
        expect(
          (
            await client.query(
              `SELECT p FROM unnest(ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE']) AS p
               WHERE has_table_privilege($1, 'catalog_delivery_live_prepare_media', p)`,
              [role],
            )
          ).rows,
        ).toEqual([]);
      };

      await client.query(upgradeCatalogDeliveryPrepareViewsSql);
      await expectUpgraded();
      await client.query(downgradeCatalogDeliveryPrepareViewsSql);
      expect(await viewState(client, views[0])).toEqual(today);
      expect(await viewState(client, views[1])).toBeNull();
      expect(await rowsOf(client, views[0])).toEqual(rows);
      expect(await intentIndexes(client)).toEqual(indexes);
      await client.query(upgradeCatalogDeliveryPrepareViewsSql);
      await expectUpgraded();

      // A task or dev database that ran M2 before M2 built the index (never
      // released): the down still restores the old state, and the next up
      // adds the index. Only the clone is on the path here, so the migrated
      // public table's index cannot stand in for the missing one.
      await client.query(`SET LOCAL search_path = "${schema}"`);
      await client.query(`DROP INDEX ${liveIndex.name}`);
      await client.query(downgradeCatalogDeliveryPrepareViewsSql);
      expect(await viewState(client, views[0])).toEqual(today);
      expect(await viewState(client, views[1])).toBeNull();
      expect(await intentIndexes(client)).toEqual(indexes);
      await client.query(upgradeCatalogDeliveryPrepareViewsSql);
      await expectUpgraded();
    });
  });

  it("lists every released intent and every other intent only within R", async () => {
    await rolledBack(async (client) => {
      await client.query(upgradeCatalogDeliveryPrepareViewsSql);
      const all = await rowsOf(client, views[0]);
      const live = await rowsOf(client, views[1]);
      const keep = new Set(
        fixture.filter(({ live }) => live).map(({ n }) => intentId(n)),
      );
      // Exactly the old view's rows of the kept intents: members of live
      // intents, headers of the others, never one of the 3,000 old ones.
      expect(live).toEqual(
        all.filter((row) => keep.has(row.intent_id as string)),
      );
      expect(new Set(live.map((row) => row.intent_id))).toEqual(keep);
      expect(
        live
          .filter((row) => row.media_ordinal !== null)
          .map((row) => row.intent_id),
      ).toEqual([1, 1, 1, 2, 2, 2, 3, 3, 3].map(intentId).sort(byText));
      expect(
        Object.fromEntries(
          live
            .filter((row) => row.media_ordinal === null)
            .map((row) => [row.intent_id, row.state]),
        ),
      ).toEqual({
        [intentId(4)]: "expired",
        [intentId(5)]: "expired",
        [intentId(8)]: "cancelled",
        [intentId(9)]: "superseded",
        [intentId(10)]: "expired",
      });
    });
  });

  it("lists the live projection through its index, not by reading every intent", async () => {
    await rolledBack(async (client) => {
      await client.query(upgradeCatalogDeliveryPrepareViewsSql);
      await client.query("ANALYZE catalog_delivery_intents");
      const scans = planNodes(
        (
          await client.query<{ "QUERY PLAN": [{ Plan: PlanNode }] }>(
            `EXPLAIN (FORMAT JSON) SELECT * FROM ${views[1]}`,
          )
        ).rows[0]!["QUERY PLAN"][0].Plan,
      ).map((node) => `${node["Node Type"]}:${node["Index Name"] ?? ""}`);
      expect(scans).not.toContain("Seq Scan:");
      expect(scans).toContain(`Bitmap Index Scan:${liveIndex.name}`);
    });
  });

  it("reads one intent of either view by the primary key, where the fence read the whole projection", async () => {
    await rolledBack(async (client) => {
      const fenced = await intentScans(client, views[0]);
      expect(fenced).toContain("Seq Scan:");
      await client.query(upgradeCatalogDeliveryPrepareViewsSql);
      for (const view of views) {
        const scans = await intentScans(client, view);
        expect(scans, view).toHaveLength(1);
        expect(scans[0], view).toMatch(
          /^Index (Only )?Scan:catalog_delivery_intents_pkey$/u,
        );
        expect(
          (
            await client.query(`SELECT * FROM ${view} WHERE intent_id = $1`, [
              intentId(2),
            ])
          ).rows,
        ).toHaveLength(3);
      }
    });
  });

  it("never lets a leaky predicate see an intent outside either view", async () => {
    await rolledBack(async (client) => {
      await client.query(upgradeCatalogDeliveryPrepareViewsSql);
      const visible = {
        [views[0]]: new Set(
          (await rowsOf(client, views[0])).map((row) => row.intent_id),
        ),
        [views[1]]: new Set(
          (await rowsOf(client, views[1])).map((row) => row.intent_id),
        ),
      };
      // A reader credential with TEMP can define such a function itself.
      const role = `cms_live_leak_${randomUUID().replaceAll("-", "")}`;
      await client.query(`CREATE ROLE "${role}" NOLOGIN`);
      await client.query(`GRANT USAGE ON SCHEMA "${schema}" TO "${role}"`);
      for (const view of views)
        await client.query(`GRANT SELECT ON ${view} TO "${role}"`);
      await client.query(
        `DO $$ BEGIN EXECUTE format('GRANT TEMPORARY ON DATABASE %I TO %I', current_database(), '${role}'); END $$`,
      );
      await client.query(`SET LOCAL ROLE "${role}"`);
      await client.query(
        `CREATE FUNCTION pg_temp.leak(value text) RETURNS boolean
         LANGUAGE plpgsql COST 0.0000001 AS $$
         BEGIN RAISE NOTICE 'leak:%', value; RETURN true; END $$`,
      );
      const seen: string[] = [];
      const listener = (notice: { message?: string | undefined }) => {
        if (notice.message?.startsWith("leak:"))
          seen.push(notice.message.slice(5));
      };
      client.on("notice", listener);
      try {
        for (const view of views) {
          seen.length = 0;
          await client.query(
            `SELECT 1 FROM ${view} WHERE pg_temp.leak(intent_id::text)`,
          );
          expect(new Set(seen), view).toEqual(visible[view]);
          // A leakproof key restriction may reach the primary key first; either
          // way a leaky predicate only ever sees rows the view keeps.
          for (const n of [2, 6, 12, 13]) {
            seen.length = 0;
            await client.query(
              `SELECT 1 FROM ${view} WHERE intent_id = $1 AND pg_temp.leak(intent_id::text)`,
              [intentId(n)],
            );
            expect(
              seen.every((id) => visible[view].has(id)),
              `${view} ${n}`,
            ).toBe(true);
            expect(seen.includes(intentId(n)), `${view} ${n}`).toBe(
              visible[view].has(intentId(n)),
            );
          }
        }
      } finally {
        client.off("notice", listener);
      }
    });
  });

  it("never casts a member outside the views, whatever the read filters on", async () => {
    // Intent 13 has no recipe and a manifest width that is not an integer;
    // the views never list it, and no filter on width or height casts it.
    const answers = async (client: Client) => {
      const counts: number[] = [];
      for (const view of views.slice(0, 1))
        for (const filter of [
          "width > 0",
          "height > 0",
          "width = 3001 AND height > 0",
          "media_count > 0",
        ])
          counts.push(
            (
              await client.query<{ count: number }>(
                `SELECT count(*)::integer AS count FROM ${view} WHERE ${filter}`,
              )
            ).rows[0]!.count,
          );
      return counts;
    };
    await rolledBack(async (client) => {
      const today = await answers(client);
      // media_count counts the manifest, also on a header row.
      expect(today).toEqual([9, 9, 3, 18]);
      await client.query(upgradeCatalogDeliveryPrepareViewsSql);
      expect(await answers(client)).toEqual(today);
      for (const filter of ["width > 0", "height > 0"])
        expect(
          (
            await client.query<{ count: number }>(
              `SELECT count(*)::integer AS count FROM ${views[1]} WHERE ${filter}`,
            )
          ).rows[0]!.count,
        ).toBe(9);
    });
  });

  it("fails fast behind a long reader instead of queueing private reads", async () => {
    const reader = await connect();
    const migrator = await connect();
    try {
      const session = (await migrator.query("SHOW lock_timeout")).rows;
      await reader.query("BEGIN");
      await reader.query("SELECT count(*) FROM catalog_delivery_prepare_media");
      await migrator.query("BEGIN");
      const started = Date.now();
      await expect(
        migrator.query(upgradeCatalogDeliveryPrepareViewsSql),
      ).rejects.toMatchObject({ code: "55P03" });
      const waited = Date.now() - started;
      await migrator.query("ROLLBACK");
      expect(waited).toBeGreaterThanOrEqual(4_500);
      expect(waited).toBeLessThan(15_000);
      expect((await migrator.query("SHOW lock_timeout")).rows).toEqual(session);
    } finally {
      await migrator.query("ROLLBACK").catch(() => undefined);
      await reader.query("ROLLBACK").catch(() => undefined);
      reader.release();
      migrator.release();
    }
    await rolledBack(async (client) => {
      const state = (await viewState(client, views[0]))!;
      expect(state.options).toBeNull();
      expect(state.definition).toMatch(/\n\s*OFFSET 0;$/u);
      expect(await viewState(client, views[1])).toBeNull();
      expect(
        (await intentIndexes(client)).map(({ name }) => name),
      ).not.toContain(liveIndex.name);
    });
  }, 30_000);
});

import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";

import {
  closePostgresPool,
  createPostgresPool,
  parsePostgresConfig,
  PostgresCatalogQueryAdapter,
} from "@moya/catalog-postgres";
import { catalogIdSchema, mediaIdSchema } from "@moya/contracts/schemas";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  createPublishedCatalogViewsSql,
  downgradePublishedCatalogMediaViewSql,
  upgradePublishedCatalogMediaViewSql,
} from "admin/published";
import { upgradePublishedCatalogSearchViewSql } from "admin/published-search";

/*
 * catalog-scale-v1 (M1): the keyed-read catalog_media view. A clone of the
 * real migrated Payload tables starts at today's definition (OFFSET 0, no
 * lookup index), and the exported upgrade and downgrade SQL is applied to it
 * the way Payload applies a migration: in one transaction. Shared CMS content
 * is never read.
 */

const testDatabaseUrl = process.env.CMS_TEST_DATABASE_URL;
if (!testDatabaseUrl) {
  throw new Error("CMS_TEST_DATABASE_URL is required for CMS view tests");
}
const baseConfig = parsePostgresConfig({ DATABASE_URL: testDatabaseUrl });
const schema = `cms_keyed_${randomUUID().replaceAll("-", "")}`;
const schemaConnection = new URL(baseConfig.connectionString);
schemaConnection.searchParams.set("options", `-csearch_path=${schema},public`);
const adminPool = createPostgresPool(baseConfig);
const pool = createPostgresPool({
  ...baseConfig,
  connectionString: schemaConnection.toString(),
});
type Pool = typeof pool;
const connect = () => pool.connect();
type Client = Awaited<ReturnType<typeof connect>>;

const lookupIndex = "catalogs_media_media_id_lookup_idx";
const sourceTables = [
  "catalogs",
  "catalogs_aliases",
  "catalogs_contributors",
  "catalogs_source_citations",
  "catalogs_source_citations_applies_to",
  "catalogs_media",
] as const;

// The pair check of the read path (catalog-scale-v1 1A, S1): a restriction on
// the view, followed in JS by an exact-pair filter. Kept literal here; the
// Backend owns the exported text.
const pairCheckSql = `SELECT DISTINCT media_id, object_key FROM catalog_media
  WHERE media_id = ANY($1::text[]) AND object_key = ANY($2::text[])`;
// The per-pair form (the planner fallback and the worker's single-asset check):
// each pair enters the view as a LATERAL parameter.
const lateralPairSql = `SELECT p.media_id, p.object_key
  FROM unnest($1::text[], $2::text[]) AS p(media_id, object_key)
  CROSS JOIN LATERAL (
    SELECT 1 FROM catalog_media cm
    WHERE cm.media_id = p.media_id AND cm.object_key = p.object_key
    LIMIT 1
  ) hit`;
// A status-guarded cast as pg_get_viewdef prints it; group 1 is the bare cast.
const guardedCast =
  /\n\s*CASE\s+WHEN \(c\._status = 'published'::enum_catalogs_status\) THEN (\(m\.\S+\)::integer)\s+ELSE NULL::integer\s+END/gu;
// Every index of the session's catalogs_media on media_id alone.
const lookupIndexesSql = `
  SELECT i.indexrelid::regclass::text AS name,
    pg_get_indexdef(i.indexrelid) AS definition
  FROM pg_index i
  WHERE i.indrelid = 'catalogs_media'::regclass
    AND (SELECT array_agg(a.attname::text ORDER BY k.ordinality)
         FROM unnest(i.indkey) WITH ORDINALITY AS k(attnum, ordinality)
         JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k.attnum)
      = ARRAY['media_id']`;

const catalogId = (n: number) => `synthetic-keyed-${n}`;
const mediaId = (n: number, image: number) =>
  `synthetic-keyed-media-${n}-${image}`;
const byText = (a: unknown, b: unknown) =>
  JSON.stringify(a) < JSON.stringify(b) ? -1 : 1;
// The length of a real editorial key: editorial/<sha>/<sha>-<sha>.jpg.
const objectKeySql = `'editorial/' || md5('catalog' || c) || md5('catalog2' || c) || '/' ||
  md5('media' || c || '-' || i) || md5('media2' || c || '-' || i) || '-' ||
  md5('bytes' || c || '-' || i) || md5('bytes2' || c || '-' || i) || '.jpg'`;

/**
 * Records `first`..`last`, every tenth one a draft; records up to `sevenUpTo`
 * carry 7 images and later ones 6.
 */
const insertRecords = async (
  first: number,
  last: number,
  sevenUpTo: number,
) => {
  await pool.query(
    `INSERT INTO catalogs (id, catalog_id, source_id, kind, title, _status)
     SELECT c, 'synthetic-keyed-' || c, 'synthetic-keyed-source-' || c,
       'inscription', '合成资料' || c,
       (CASE WHEN c % 10 = 0 THEN 'draft' ELSE 'published' END)::enum_catalogs_status
     FROM generate_series($1::integer, $2::integer) AS c`,
    [first, last],
  );
  await pool.query(
    `INSERT INTO catalogs_media
       (id, _parent_id, _order, media_id, object_key, width, height, alt,
        position, is_representative, rights, order_confidence)
     SELECT 'synthetic-keyed-row-' || c || '-' || i, c, i,
       'synthetic-keyed-media-' || c || '-' || i, ${objectKeySql},
       6000 + i, 9000 - i, '合成图片' || i, i - 1, i = 1, '合成权利说明', 'HIGH'
     FROM generate_series($1::integer, $2::integer) AS c
     CROSS JOIN LATERAL generate_series(1, CASE WHEN c <= $3 THEN 7 ELSE 6 END) AS i`,
    [first, last, sevenUpTo],
  );
};

/** The stored pairs of the named images, in the order given. */
const pairsOf = async (images: readonly (readonly [number, number])[]) => {
  const ids = images.map(([n, image]) => mediaId(n, image));
  const rows = (
    await pool.query<{ media_id: string; object_key: string }>(
      "SELECT media_id, object_key FROM catalogs_media WHERE media_id = ANY($1::text[])",
      [ids],
    )
  ).rows;
  const keys = new Map(rows.map((row) => [row.media_id, row.object_key]));
  return ids.map((id) => [id, keys.get(id) ?? `${id}-absent`] as const);
};
const pairParams = (pairs: readonly (readonly [string, string])[]) => [
  pairs.map(([id]) => id),
  pairs.map(([, key]) => key),
];

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

const viewState = async (client: Client) => {
  const view = (
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
       FROM pg_class c WHERE c.oid = 'catalog_media'::regclass`,
    )
  ).rows[0]!;
  const columns = (
    await client.query(
      `SELECT attname, format_type(atttypid, atttypmod) AS type
       FROM pg_attribute
       WHERE attrelid = 'catalog_media'::regclass AND attnum > 0
       ORDER BY attnum`,
    )
  ).rows;
  const updatable = (
    await client.query(
      `SELECT is_updatable, is_insertable_into FROM information_schema.views
       WHERE table_schema = $1 AND table_name = 'catalog_media'`,
      [schema],
    )
  ).rows;
  const lookup = (await client.query(lookupIndexesSql)).rows;
  return { ...view, columns, updatable, lookup };
};

const publishedRows = async (client: Client) =>
  (await client.query("SELECT * FROM catalog_media")).rows.sort(byText);

beforeAll(async () => {
  await adminPool.query(`CREATE SCHEMA "${schema}"`);
  for (const table of sourceTables) {
    await pool.query(
      `CREATE TABLE "${schema}"."${table}" (LIKE public."${table}" INCLUDING ALL)`,
    );
  }
  // A migrated database already carries the lookup index, which LIKE copies
  // under a generated name. Remove it so the clone starts at today's state.
  for (const { name } of (await pool.query(lookupIndexesSql)).rows)
    await pool.query(`DROP INDEX ${name}`);
  await pool.query(createPublishedCatalogViewsSql);
  await pool.query(upgradePublishedCatalogSearchViewSql);
  // Eleven published records of 7 images and one draft (record 10), whose
  // second, third and fourth images carry a position, width and height
  // beyond int4.
  await insertRecords(1, 12, 12);
  await pool.query(
    `UPDATE catalogs_media SET
       position = CASE _order WHEN 2 THEN 1e12 ELSE position END,
       width = CASE _order WHEN 3 THEN 1e12 ELSE width END,
       height = CASE _order WHEN 4 THEN 1e12 ELSE height END
     WHERE _parent_id = 10 AND _order IN (2, 3, 4)`,
  );
}, 30_000);

afterAll(async () => {
  await closePostgresPool(pool);
  try {
    await adminPool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
  } finally {
    await closePostgresPool(adminPool);
  }
});

describe("catalog_media keyed-read migration (M1)", () => {
  it("is registered after the delivery intents and applied by the real Payload run", async () => {
    const registry = await readFile(
      new URL("../../apps/admin/src/migrations/index.ts", import.meta.url),
      "utf8",
    );
    // Directly after the delivery intents; later migrations may follow.
    const names = [...registry.matchAll(/name: "([^"]+)"/gu)].map(
      ([, name]) => name,
    );
    expect(names.indexOf("20261023_000000_catalog_media_keyed_reads")).toBe(
      names.indexOf("20261020_160000_catalog_delivery_intents") + 1,
    );
    // tests/cms runs after `payload migrate`; this is that database's state.
    expect(
      (
        await adminPool.query(
          "SELECT count(*)::integer AS count FROM public.payload_migrations WHERE name = $1",
          ["20261023_000000_catalog_media_keyed_reads"],
        )
      ).rows,
    ).toEqual([{ count: 1 }]);
    const [applied] = (
      await adminPool.query<{
        options: string[] | null;
        lookup: number;
        definition: string;
      }>(
        `SELECT c.reloptions AS options,
           (SELECT count(*)::integer FROM pg_indexes
            WHERE schemaname = 'public' AND indexname = $1
              AND indexdef LIKE '%USING btree (media_id)') AS lookup,
           pg_get_viewdef(c.oid) AS definition
         FROM pg_class c WHERE c.oid = 'public.catalog_media'::regclass`,
        [lookupIndex],
      )
    ).rows;
    expect(applied).toMatchObject({
      options: ["security_barrier=true"],
      lookup: 1,
    });
    expect(applied!.definition).not.toMatch(/OFFSET/u);
    expect([...applied!.definition.matchAll(guardedCast)]).toHaveLength(3);
  });

  it("starts each statement set with a transaction-scoped lock_timeout", () => {
    for (const sql of [
      upgradePublishedCatalogMediaViewSql,
      downgradePublishedCatalogMediaViewSql,
    ])
      expect(sql.trimStart()).toMatch(/^SET LOCAL lock_timeout = '5s';\n/u);
    // The index is built before the view swap takes its ACCESS EXCLUSIVE lock.
    expect(
      upgradePublishedCatalogMediaViewSql.indexOf("CREATE INDEX"),
    ).toBeLessThan(
      upgradePublishedCatalogMediaViewSql.indexOf("CREATE OR REPLACE VIEW"),
    );
  });

  it("keeps rows, columns, OID, owner and grants across up, down and up", async () => {
    await rolledBack(async (client) => {
      const role = `cms_keyed_reader_${randomUUID().replaceAll("-", "")}`;
      await client.query(`CREATE ROLE "${role}" NOLOGIN`);
      await client.query(`GRANT SELECT ON catalog_media TO "${role}"`);
      const today = await viewState(client);
      const rows = await publishedRows(client);
      expect(today.options).toBeNull();
      expect(today.definition).toMatch(/\n\s*OFFSET 0;$/u);
      expect(today.lookup).toEqual([]);
      expect(rows).toHaveLength(77);
      expect(rows.some((row) => row.catalog_id === catalogId(10))).toBe(false);

      const expectUpgraded = async () => {
        const state = await viewState(client);
        expect(state.options).toEqual(["security_barrier=true"]);
        // The fence is gone and each integer cast is guarded by the record's
        // status; otherwise the same select list, join and filter.
        expect(
          [...state.definition.matchAll(guardedCast)].map(([, cast]) => cast),
        ).toEqual([
          '(m."position")::integer',
          "(m.width)::integer",
          "(m.height)::integer",
        ]);
        expect(state.definition.replace(guardedCast, "\n    $1")).toBe(
          today.definition.replace(/\n\s*OFFSET 0;$/u, ";"),
        );
        expect(state.columns).toEqual(today.columns);
        expect(state.updatable).toEqual([
          { is_updatable: "NO", is_insertable_into: "NO" },
        ]);
        expect({ oid: state.oid, owner: state.owner, acl: state.acl }).toEqual({
          oid: today.oid,
          owner: today.owner,
          acl: today.acl,
        });
        expect(state.lookup).toEqual([
          {
            name: lookupIndex,
            definition: `CREATE INDEX ${lookupIndex} ON ${schema}.catalogs_media USING btree (media_id)`,
          },
        ]);
        expect(await publishedRows(client)).toEqual(rows);
        const granted = (
          await client.query(
            `SELECT p FROM unnest(ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE',
               'TRUNCATE', 'REFERENCES', 'TRIGGER']) AS p
             WHERE has_table_privilege($1, 'catalog_media', p)`,
            [role],
          )
        ).rows;
        expect(granted).toEqual([{ p: "SELECT" }]);
        for (const write of [
          "UPDATE catalog_media SET alt_text = '不能写入'",
          "DELETE FROM catalog_media",
        ]) {
          await client.query("SAVEPOINT write_probe");
          await expect(client.query(write)).rejects.toMatchObject({
            code: "55000",
          });
          await client.query("ROLLBACK TO SAVEPOINT write_probe");
        }
      };

      await client.query(upgradePublishedCatalogMediaViewSql);
      await expectUpgraded();
      await client.query(downgradePublishedCatalogMediaViewSql);
      expect(await viewState(client)).toEqual(today);
      expect(await publishedRows(client)).toEqual(rows);
      await client.query(upgradePublishedCatalogMediaViewSql);
      await expectUpgraded();
    });
  });

  it("returns the same pair-check rows before and after the upgrade", async () => {
    // Published pairs, a draft pair, an absent pair and a cross-product decoy
    // (a published id with another published image's key).
    const pairs = await pairsOf([
      [1, 1],
      [1, 7],
      [11, 3],
      [10, 1],
      [10, 2],
      [13, 1],
    ]);
    const decoy = [mediaId(2, 1), pairs[0]![1]] as const;
    const params = pairParams([...pairs, decoy]);
    await rolledBack(async (client) => {
      const answers = async () => ({
        pairs: (await client.query(pairCheckSql, params)).rows.sort(byText),
        lateral: (await client.query(lateralPairSql, params)).rows.sort(byText),
      });
      const today = await answers();
      expect(today.pairs).toEqual(
        pairs
          .slice(0, 3)
          .map(([media_id, object_key]) => ({ media_id, object_key }))
          .sort(byText),
      );
      expect(today.lateral).toEqual(today.pairs);
      await client.query(upgradePublishedCatalogMediaViewSql);
      expect(await answers()).toEqual(today);
    });
  });

  it("never lets a leaky predicate see a draft row", async () => {
    const keyedPairs = await pairsOf([
      [10, 1],
      [1, 1],
    ]);
    await rolledBack(async (client) => {
      await client.query(upgradePublishedCatalogMediaViewSql);
      // A public read credential with TEMP can define such a function itself.
      const role = `cms_keyed_leak_${randomUUID().replaceAll("-", "")}`;
      await client.query(`CREATE ROLE "${role}" NOLOGIN`);
      await client.query(`GRANT USAGE ON SCHEMA "${schema}" TO "${role}"`);
      await client.query(`GRANT SELECT ON catalog_media TO "${role}"`);
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
        const whole = await client.query(
          "SELECT media_id FROM catalog_media WHERE pg_temp.leak(media_id)",
        );
        expect(whole.rows).toHaveLength(77);
        expect(seen.sort()).toEqual(
          whole.rows.map((row) => row.media_id as string).sort(),
        );
        expect(seen).not.toContain(mediaId(10, 1));
        // A leakproof key restriction may reach the index; the leaky one
        // still runs only on rows the view has already filtered.
        seen.length = 0;
        const keyed = await client.query(
          "SELECT media_id FROM catalog_media WHERE media_id = ANY($1::text[]) AND pg_temp.leak(object_key)",
          [keyedPairs.map(([id]) => id)],
        );
        expect(keyed.rows).toEqual([{ media_id: mediaId(1, 1) }]);
        expect(seen).toEqual([keyedPairs[1]![1]]);
      } finally {
        client.off("notice", listener);
      }
    });
  });

  it("never casts a draft row's columns, whatever the read filters on", async () => {
    // Record 10 is a draft whose images 2-4 hold a position, width and height
    // of 1e12. Leakproof comparisons now enter the view and may reach its
    // rows, but each integer cast runs only for a published record.
    const draft = await pairsOf([
      [10, 2],
      [1, 2],
    ]);
    await rolledBack(async (client) => {
      const ids = async (sql: string, values: unknown[] = []) =>
        (await client.query(sql, values)).rows
          .map(({ media_id }) => media_id as string)
          .sort();
      const answers = async () => {
        // Filters on a cast column itself.
        const counts: number[] = [];
        for (const filter of [
          "position = 1",
          "position BETWEEN 0 AND 3",
          "width > 0",
          "height > 0",
        ]) {
          const { rows } = await client.query<{ count: number }>(
            `SELECT count(*)::integer AS count FROM catalog_media WHERE ${filter}`,
          );
          counts.push(rows[0]!.count);
        }
        // A key read with such filters never tells a draft value apart.
        const keyed: string[][] = [];
        for (const [n, image] of [
          [10, 2],
          [10, 3],
          [10, 4],
          [1, 2],
        ] as const)
          keyed.push(
            await ids(
              "SELECT media_id FROM catalog_media WHERE media_id = $1 AND position = 1 AND width > 0 AND height > 0",
              [mediaId(n, image)],
            ),
          );
        return {
          counts,
          keyed,
          pairs: await ids(pairCheckSql, pairParams(draft)),
          lateral: await ids(lateralPairSql, pairParams(draft)),
          detail: await ids(
            "SELECT media_id FROM catalog_media WHERE catalog_id = $1",
            [catalogId(10)],
          ),
          representative: await ids(
            "SELECT media_id FROM catalog_media WHERE catalog_id = ANY($1::text[]) AND is_representative",
            [[catalogId(1), catalogId(10)]],
          ),
        };
      };
      const today = await answers();
      expect(today).toEqual({
        counts: [11, 44, 77, 77],
        keyed: [[], [], [], [mediaId(1, 2)]],
        pairs: [mediaId(1, 2)],
        lateral: [mediaId(1, 2)],
        detail: [],
        representative: [mediaId(1, 1)],
      });
      await client.query(upgradePublishedCatalogMediaViewSql);
      expect(await answers()).toEqual(today);
    });
  });

  it("fails fast behind a long reader instead of queueing public reads", async () => {
    const reader = await connect();
    const migrator = await connect();
    try {
      const session = (await migrator.query("SHOW lock_timeout")).rows;
      await reader.query("BEGIN");
      await reader.query("SELECT count(*) FROM catalog_media");
      await migrator.query("BEGIN");
      const started = Date.now();
      await expect(
        migrator.query(upgradePublishedCatalogMediaViewSql),
      ).rejects.toMatchObject({ code: "55P03" });
      const waited = Date.now() - started;
      await migrator.query("ROLLBACK");
      expect(waited).toBeGreaterThanOrEqual(4_500);
      expect(waited).toBeLessThan(15_000);
      // SET LOCAL ended with the transaction.
      expect((await migrator.query("SHOW lock_timeout")).rows).toEqual(session);
    } finally {
      await migrator.query("ROLLBACK").catch(() => undefined);
      await reader.query("ROLLBACK").catch(() => undefined);
      reader.release();
      migrator.release();
    }
    await rolledBack(async (client) => {
      const state = await viewState(client);
      expect(state.options).toBeNull();
      expect(state.definition).toMatch(/\n\s*OFFSET 0;$/u);
      expect(state.lookup).toEqual([]);
    });
  }, 30_000);
});

interface PlanNode {
  readonly "Node Type": string;
  readonly "Relation Name"?: string;
  readonly "Index Name"?: string;
  readonly "Actual Rows"?: number;
  readonly "Actual Loops"?: number;
  readonly "Rows Removed by Filter"?: number;
  readonly "Rows Removed by Index Recheck"?: number;
  readonly Plans?: readonly PlanNode[];
}
interface Explained {
  readonly Plan: PlanNode;
  readonly "Execution Time": number;
}

const planNodes = (node: PlanNode): PlanNode[] => [
  node,
  ...(node.Plans ?? []).flatMap(planNodes),
];
const explain = async (
  client: Client,
  sql: string,
  values: readonly unknown[],
): Promise<Explained> =>
  (
    await client.query<{ "QUERY PLAN": [Explained] }>(
      `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${sql}`,
      [...values],
    )
  ).rows[0]!["QUERY PLAN"][0];
/** Rows a plan read from catalogs_media, rows it filtered out included. */
const mediaRowsRead = (plan: Explained) =>
  Math.round(
    planNodes(plan.Plan)
      .filter((node) => node["Relation Name"] === "catalogs_media")
      .reduce(
        (sum, node) =>
          sum +
          ((node["Actual Rows"] ?? 0) +
            (node["Rows Removed by Filter"] ?? 0) +
            (node["Rows Removed by Index Recheck"] ?? 0)) *
            (node["Actual Loops"] ?? 1),
        0,
      ),
  );

describe("catalog_media keyed reads at 20,000 published rows", () => {
  interface Read {
    readonly name: string;
    readonly sql: string;
    readonly values: readonly unknown[];
    readonly rows: number;
    /** catalogs_media rows the read may touch at any Catalog size. */
    readonly bound: number;
    readonly pairs: boolean;
  }
  interface Cost {
    readonly time: number;
    readonly mediaRows: number;
  }
  const reads: Read[] = [];
  const small = new Map<string, Cost>();
  let client: Client | undefined;
  const session = () => {
    if (client === undefined) throw new Error("Planner session missing");
    return client;
  };

  const cost = async (read: Read): Promise<Cost> => {
    let time = Number.POSITIVE_INFINITY;
    let mediaRows = 0;
    for (let run = 0; run < 5; run += 1) {
      const plan = await explain(session(), read.sql, read.values);
      expect(Math.round(plan.Plan["Actual Rows"] ?? 0), read.name).toBe(
        read.rows,
      );
      time = Math.min(time, plan["Execution Time"]);
      mediaRows = mediaRowsRead(plan);
    }
    return { time, mediaRows };
  };

  beforeAll(async () => {
    client = await connect();
    // The CMS-side SQL of the Catalog detail, the list representative image
    // and zoom, recorded from the real reader on the small committed fixture.
    const captured = new Map<string, Set<string>>();
    let label = "";
    const recording = {
      connect: async () => {
        const inner = await connect();
        return {
          query: (sql: string, values?: unknown[]) => {
            if (/\bcatalog_media\b/u.test(sql))
              captured.set(label, (captured.get(label) ?? new Set()).add(sql));
            return inner.query(sql, values);
          },
          release: (error?: Error | boolean) => inner.release(error),
        };
      },
    } as unknown as Pool;
    const noZoomRows = {
      connect: async () => ({
        query: async () => ({ rows: [] }),
        release: () => undefined,
      }),
    } as unknown as Pool;
    const reader = new PostgresCatalogQueryAdapter(recording, {
      zoom: { isOpen: async () => true },
      zoomPool: noZoomRows,
    });
    const record = catalogIdSchema.parse(catalogId(1));
    label = "detail";
    expect(await reader.getById(record)).not.toBeNull();
    label = "list";
    expect((await reader.list({ page: 1, pageSize: 24 })).total).toBe(11);
    label = "zoom";
    await reader.getZoomFrames(record);
    await reader.getZoomBlocks(record, mediaIdSchema.parse(mediaId(1, 1)));
    const sqlOf = (name: string) => {
      const texts = [...(captured.get(name) ?? [])];
      expect(texts, name).toHaveLength(1);
      return texts[0]!;
    };

    // N = 2,000: 300 records (30 drafts) of 6 or 7 images.
    await pool.query("DELETE FROM catalogs_media");
    await pool.query("DELETE FROM catalogs");
    await insertRecords(1, 300, 200);
    await pool.query(upgradePublishedCatalogMediaViewSql);
    await pool.query("ANALYZE catalogs, catalogs_media");

    const seven = await pairsOf([1, 2, 3, 4, 5, 6, 7].map((i) => [1, i]));
    // 100 pairs over records 1-15: 93 published images and the 7 of draft
    // record 10.
    const hundred = await pairsOf(
      Array.from(
        { length: 100 },
        (_, n) => [Math.floor(n / 7) + 1, (n % 7) + 1] as const,
      ),
    );
    const listed = Array.from({ length: 30 }, (_, n) => n + 1)
      .filter((n) => n % 10 !== 0)
      .slice(0, 24)
      .map(catalogId);
    reads.push(
      {
        name: "pair check k=7",
        sql: pairCheckSql,
        values: pairParams(seven),
        rows: 7,
        bound: 7,
        pairs: true,
      },
      {
        name: "pair check k=100",
        sql: pairCheckSql,
        values: pairParams(hundred),
        rows: 93,
        bound: 100,
        pairs: true,
      },
      {
        name: "lateral pair k=1",
        sql: lateralPairSql,
        values: pairParams(seven.slice(0, 1)),
        rows: 1,
        bound: 1,
        pairs: true,
      },
      {
        name: "lateral pair k=7",
        sql: lateralPairSql,
        values: pairParams(seven),
        rows: 7,
        bound: 7,
        pairs: true,
      },
      {
        name: "detail",
        sql: sqlOf("detail"),
        values: [catalogId(1)],
        rows: 7,
        bound: 7,
        pairs: false,
      },
      {
        name: "list representative",
        sql: sqlOf("list"),
        values: [listed],
        rows: 24,
        bound: 168,
        pairs: false,
      },
      {
        name: "zoom frames",
        sql: sqlOf("zoom"),
        values: [catalogId(1), null],
        rows: 7,
        bound: 7,
        pairs: false,
      },
      {
        name: "zoom blocks",
        sql: sqlOf("zoom"),
        values: [catalogId(1), mediaId(1, 3)],
        rows: 1,
        bound: 7,
        pairs: false,
      },
    );
    for (const read of reads) small.set(read.name, await cost(read));

    // N = 20,000: 3,000 records (300 drafts).
    await insertRecords(301, 3000, 2100);
    await pool.query("ANALYZE catalogs, catalogs_media");
    expect(
      (
        await pool.query(
          `SELECT (SELECT count(*)::integer FROM catalogs) AS records,
             (SELECT count(*)::integer FROM catalogs_media) AS images`,
        )
      ).rows,
    ).toEqual([{ records: 3000, images: 20_000 }]);
  }, 60_000);

  afterAll(() => {
    client?.release();
  });

  it("reaches catalogs_media through an index, never a Seq Scan", async () => {
    for (const read of reads) {
      const plan = await explain(session(), read.sql, read.values);
      const nodes = planNodes(plan.Plan);
      const scans = nodes
        .filter((node) => node["Relation Name"] === "catalogs_media")
        .map((node) => node["Node Type"]);
      expect(scans, read.name).not.toContain("Seq Scan");
      expect(scans.length, read.name).toBeGreaterThan(0);
      expect(
        scans.every((scan) =>
          ["Index Scan", "Index Only Scan", "Bitmap Heap Scan"].includes(scan),
        ),
        `${read.name}: ${scans.join(", ")}`,
      ).toBe(true);
      if (read.pairs)
        expect(
          nodes.some((node) => node["Index Name"] === lookupIndex),
          read.name,
        ).toBe(true);
    }
  });

  it("keeps each read's cost flat from 2,000 to 20,000 rows", async () => {
    for (const read of reads) {
      const before = small.get(read.name)!;
      const after = await cost(read);
      console.info(
        `[catalog-media-keyed-reads] ${read.name}: catalogs_media rows read ${before.mediaRows} -> ${after.mediaRows}; best of 5 ${before.time.toFixed(3)}ms -> ${after.time.toFixed(3)}ms`,
      );
      // Rows read from catalogs_media follow the request, not the Catalog.
      expect(after.mediaRows, read.name).toBeLessThanOrEqual(read.bound);
      expect(after.time, read.name).toBeLessThanOrEqual(2 * before.time + 0.5);
    }
  });

  it("answers every read identically under today's fence, which reads the whole published list", async () => {
    const answers = async () => {
      const result: unknown[] = [];
      for (const read of reads)
        result.push(
          (await session().query(read.sql, [...read.values])).rows.sort(byText),
        );
      return result;
    };
    const keyed = await answers();
    await session().query("BEGIN");
    try {
      await session().query(downgradePublishedCatalogMediaViewSql);
      expect(await answers()).toEqual(keyed);
      // With the lookup index back, only the fence differs from M1, and every
      // read still evaluates the whole view.
      await session().query(
        `CREATE INDEX ${lookupIndex} ON catalogs_media USING btree (media_id)`,
      );
      const published = (
        await session().query<{ count: number }>(
          "SELECT count(*)::integer AS count FROM catalog_media",
        )
      ).rows[0]!.count;
      expect(published).toBe(18_000);
      // A LATERAL read stops at its first hit, so it shows no such floor.
      for (const read of reads.filter(({ sql }) => sql !== lateralPairSql))
        expect(
          mediaRowsRead(await explain(session(), read.sql, read.values)),
          read.name,
        ).toBeGreaterThanOrEqual(published);
    } finally {
      await session().query("ROLLBACK");
    }
  });
});

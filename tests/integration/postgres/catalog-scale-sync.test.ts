import { createHash, randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import {
  currentCatalogRecipePolicy,
  readCatalogSourceSnapshot,
} from "@moya/backend-production/internal/catalog-delivery";
import { createCatalogSync } from "@moya/backend-production/internal/publishing-catalog";
import {
  createPostgresPool,
  parsePostgresConfig,
} from "@moya/catalog-postgres";
import {
  CATALOG_SNAPSHOT_MAX_SOURCES,
  PostgresWorkPublishingAdapter,
  runCommunityMigrations,
} from "@moya/community-postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  assertSyntheticTestDatabaseUrl,
  requireSyntheticTestDatabaseUrl,
} from "./synthetic-test-database.js";

/*
 * catalog-scale-v1 (Issue #323) 1B, W3 and W4, on a dedicated synthetic
 * database. The Catalog sync runs end to end at scale: the complete snapshot
 * is read through cursors under one exported REPEATABLE READ snapshot, by a
 * public read role (the published projection) and a prepare reader (a stub of
 * the live private projection CMS migration M2 adds), and is applied by the
 * restricted App role, which has neither TEMPORARY nor DELETE. 25,000
 * published images, 3,000 released intents (21,000 member rows), 500 live
 * prepared intents (3,500 private images) and 15,000 ended intents (1,000
 * still within retention, 14,000 long tombstoned in the App mirror):
 * - exactly the assets missing from the complete published list are marked
 *   unreferenced, and the sync binds typed arrays only;
 * - a pass that changes nothing rewrites no mirror row, and the rows a pass
 *   reads do not grow with ended intents, which leave the snapshot once past
 *   retention and are tombstoned once, never revived;
 * - a failed cursor, or one row past the snapshot ceiling, writes nothing;
 * - the asset rows a pass changes are locked in id order, the order a
 *   readiness inspection takes, so the two never deadlock.
 * Content is synthetic; no object store, real CMS or network.
 */

type Pool = ReturnType<typeof createPostgresPool>;

const root = fileURLToPath(new URL("../../../", import.meta.url));
const targetUrl = requireSyntheticTestDatabaseUrl();
const endpoint = new URL(targetUrl);
if (
  !["127.0.0.1", "localhost", "[::1]"].includes(endpoint.hostname) ||
  endpoint.search ||
  endpoint.hash
)
  throw new Error("Catalog scale tests require a loopback disposable target");
const guard = (await import(
  new URL("../../../scripts/disposable-test-target.mjs", import.meta.url).href
)) as {
  disposableTestTargetProbeSql: string;
  assertDisposableTestTarget(rows: unknown, database: string): string;
};

const poolFor = (url: string) =>
  createPostgresPool(parsePostgresConfig({ DATABASE_URL: url }));
const administration = poolFor(targetUrl);
const SLOW = 300_000;
const hex = (bytes = 16) => randomBytes(bytes).toString("hex");

const PUBLISHED = 25_000;
const RELEASED = 3_000;
const LIVE = 500;
const MEMBERS = 7;
const ENDED_WITHIN_R = 1_000;
const HISTORY = 14_000;
/** Published images without an App asset yet; as many private ones. */
const MISSING = 50;
const REREFERENCED = 200;
const STALE = 500;

const suffix = hex(6);
const database = `cs_sync_${suffix}_synthetic_test`;
const appRole = `cs_sync_app_${suffix}`;
const publicRole = `cs_sync_public_${suffix}`;
const prepareRole = `cs_sync_prepare_${suffix}`;
const roles = [appRole, publicRole, prepareRole];
let setup: Pool;
let app: Pool;
let publicRead: Pool;
let prepareRead: Pool;
const created = { database: false, roles: [] as string[] };

const policy = currentCatalogRecipePolicy().recipeManifestSha256;
// SQL for image `g` of the published Catalog and `p` of the private set; each
// key embeds a 64-hex digest, as an approved key must.
const publishedImageSql = (g: string) => ({
  mediaId: `'synthetic-scale-' || ${g}`,
  objectKey: `'display/v1/media_' || md5('k' || ${g}) || '/' || encode(sha256(convert_to('b' || ${g}, 'UTF8')), 'hex') || '.webp'`,
  sha: `encode(sha256(convert_to('b' || ${g}, 'UTF8')), 'hex')`,
});
const privateImageSql = (p: string) => ({
  mediaId: `'synthetic-private-' || ${p}`,
  objectKey: `'display/v1/media_' || md5('p' || ${p}) || '/' || encode(sha256(convert_to('q' || ${p}, 'UTF8')), 'hex') || '.webp'`,
  sha: `encode(sha256(convert_to('q' || ${p}, 'UTF8')), 'hex')`,
});
const staleImageSql = (s: string) => ({
  mediaId: `'synthetic-stale-' || ${s}`,
  objectKey: `'display/v1/media_' || md5('s' || ${s}) || '/' || encode(sha256(convert_to('t' || ${s}, 'UTF8')), 'hex') || '.webp'`,
  sha: `encode(sha256(convert_to('t' || ${s}, 'UTF8')), 'hex')`,
});
const intentIdSql = (k: string) =>
  `('00000000-0000-4000-8000-' || lpad(to_hex(${k}), 12, '0'))::uuid`;
const assetIdSql = (image: { mediaId: string; objectKey: string }) =>
  `'catalog-asset-' || md5(${image.mediaId} || ':' || ${image.objectKey})`;

/** One pending App asset row of `image`, for INSERT ... SELECT. */
const asset = (
  image: { mediaId: string; objectKey: string; sha: string },
  unreferenced: string,
) =>
  `${assetIdSql(image)}, ${image.mediaId}, ${image.objectKey}, ${image.sha}, 6000, 4000,
   'image/webp', 'pending', ${unreferenced}, now() - interval '30 days', now() - interval '30 days'`;
const assetColumns = `(id, media_id, source_object_key, source_sha256, source_width,
   source_height, source_content_type, state, unreferenced_since, created_at, updated_at)`;
/** The live projection's columns of intent `k`, before its member columns. */
const liveHeaderSql = (state: string, expires: string, k: string) =>
  `${intentIdSql(k)}, ${k}, 'catalog-scale-' || ${k}, 1, repeat('a', 64), repeat('b', 64),
   '${policy}', 2, '${state}', ${MEMBERS}, ${expires}`;

/** Statements the App role ran, with the rows each returned or changed. */
const appStatements: { sql: string; rows: number }[] = [];
const recordingApp = () =>
  ({
    connect: async () => {
      const client = await app.connect();
      return new Proxy(client, {
        get(target, property) {
          if (property === "query")
            return async (sql: string, values?: unknown[]) => {
              const result = await target.query(sql, values);
              appStatements.push({
                sql,
                rows: Math.max(result.rows.length, result.rowCount ?? 0),
              });
              return result;
            };
          const value = Reflect.get(target, property) as unknown;
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    },
  }) as unknown as ConstructorParameters<
    typeof PostgresWorkPublishingAdapter
  >[0];

const logs: string[] = [];
const logger = {
  info: (line: string) => logs.push(line),
  error: (line: string) => logs.push(line),
};
/** One sync pass, as the worker runs it (timed). */
const pass = async (published: Pool = publicRead) => {
  appStatements.length = 0;
  logs.length = 0;
  const started = Date.now();
  await createCatalogSync({
    listSources: async () => [],
    readSnapshot: () => readCatalogSourceSnapshot(published, prepareRead),
    port: new PostgresWorkPublishingAdapter(recordingApp()),
    logger,
  }).run(new Date());
  return Date.now() - started;
};

/** Everything a pass may write, as the setup role reads it. */
const state = async () =>
  (
    await setup.query(
      `SELECT
         (SELECT md5(string_agg(id || ':' || coalesce(unreferenced_since::text, '-') || ':' || state || ':' || updated_at::text || ':' || xmin::text, ',' ORDER BY id))
          FROM community.catalog_media_assets) AS assets,
         (SELECT md5(string_agg(intent_id::text || ':' || source_state || ':' || source_state_version || ':' || observed_live || ':' || observed_at::text || ':' || coalesce(ended_at::text, '-') || ':' || xmin::text, ',' ORDER BY intent_id))
          FROM community.catalog_delivery_prepares) AS mirror,
         (SELECT count(*)::integer FROM community.catalog_delivery_media_refs) AS refs,
         (SELECT md5(string_agg(id || ':' || state || ':' || updated_at::text, ',' ORDER BY id))
          FROM community.publishing_jobs) AS jobs,
         (SELECT observed_at::text FROM community.catalog_delivery_snapshot_watermark) AS watermark`,
    )
  ).rows[0] as Record<string, unknown>;
const mirrorRowsRead = () =>
  appStatements.filter(({ sql }) =>
    sql.startsWith("SELECT * FROM community.catalog_delivery_prepares"),
  );
const xminOf = async (where: string) =>
  (
    await setup.query<{ xmins: string }>(
      `SELECT md5(string_agg(intent_id::text || ':' || xmin::text, ',' ORDER BY intent_id)) AS xmins
       FROM community.catalog_delivery_prepares WHERE ${where}`,
    )
  ).rows[0]!.xmins;

beforeAll(async () => {
  const probe = await administration.query(guard.disposableTestTargetProbeSql);
  guard.assertDisposableTestTarget(
    probe.rows,
    assertSyntheticTestDatabaseUrl(targetUrl),
  );
  const passwords = Object.fromEntries(roles.map((role) => [role, hex(32)]));
  for (const role of roles) {
    await administration.query(
      `CREATE ROLE ${role} LOGIN PASSWORD '${passwords[role]}' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION NOINHERIT`,
    );
    created.roles.push(role);
  }
  await administration.query(`CREATE DATABASE ${database}`);
  created.database = true;
  const url = (role?: string) => {
    const value = new URL(targetUrl);
    value.pathname = `/${database}`;
    if (role !== undefined) {
      value.username = role;
      value.password = passwords[role]!;
    }
    return value.toString();
  };
  setup = poolFor(url());
  // The App role is DML-only: no TEMPORARY (a new database grants it to
  // PUBLIC), so no temporary table either.
  await setup.query(`REVOKE TEMPORARY ON DATABASE ${database} FROM PUBLIC`);
  await runCommunityMigrations(setup, `${root}/database/community-migrations`);
  // The CMS stubs the grant scripts name. catalog_media is a fenced view of
  // the published rows of a media table that also holds drafts, as the
  // Payload projection is. The live private projection is a stub table of
  // exactly the rows CMS migration M2's view lists (its rules are the CMS
  // suite's), read by the prepare reader only.
  await setup.query(
    `CREATE TABLE public.catalog_entries(catalog_id text PRIMARY KEY,province text,province_state text);
     CREATE TABLE public.catalog_discovery(catalog_id text PRIMARY KEY,kind text,title text,aliases varchar[],first_published_at timestamptz,filter_metadata jsonb);
     CREATE TABLE public.article_entries(article_id text PRIMARY KEY,title text);
     CREATE TABLE public.cms_catalog_media(catalog_id text NOT NULL,media_id varchar NOT NULL,object_key varchar NOT NULL,width numeric,height numeric,is_representative boolean,position numeric NOT NULL DEFAULT 0,status text NOT NULL);
     CREATE VIEW public.catalog_media AS
       SELECT catalog_id, media_id, position::integer AS position, is_representative, width::integer AS width, height::integer AS height, object_key
       FROM public.cms_catalog_media WHERE status = 'published' OFFSET 0;
     CREATE TABLE public.catalog_delivery_live_prepare_media(intent_id uuid NOT NULL,catalog_document_id integer NOT NULL,catalog_id varchar NOT NULL,draft_revision integer NOT NULL,draft_fingerprint char(64) NOT NULL,media_manifest_sha256 char(64) NOT NULL,recipe_manifest_sha256 char(64),state_version integer NOT NULL,state varchar NOT NULL,media_count integer NOT NULL,expires_at timestamptz NOT NULL,media_ordinal integer,media_id text,object_key text,source_sha256 text,width integer,height integer)`,
  );
  await setup.query(
    (
      await readFile(
        `${root}/infra/development/work-publishing/grant-runtime.sql`,
        "utf8",
      )
    ).replaceAll(':"app_role"', `"${appRole}"`),
  );
  await setup.query(`GRANT SELECT ON public.catalog_media TO "${publicRole}"`);
  await setup.query(
    `GRANT SELECT ON public.catalog_delivery_live_prepare_media TO "${prepareRole}"`,
  );

  // 25,000 published images in 3,572 records, and draft rows beside them.
  const image = publishedImageSql("g");
  await setup.query(
    `INSERT INTO public.cms_catalog_media(catalog_id,media_id,object_key,width,height,is_representative,position,status)
     SELECT 'catalog-scale-' || (g / ${MEMBERS}), ${image.mediaId}, ${image.objectKey},
       6000, 4000, g % ${MEMBERS} = 0, g % ${MEMBERS},
       CASE WHEN g <= ${PUBLISHED} THEN 'published' ELSE 'draft' END
     FROM generate_series(1, ${PUBLISHED + 700}) AS g`,
  );
  // 3,000 released intents, each naming 7 published images.
  const member = publishedImageSql(`((k - 1) * ${MEMBERS} + o)`);
  await setup.query(
    `INSERT INTO public.catalog_delivery_live_prepare_media
     SELECT ${liveHeaderSql("released", "now() - interval '300 hours'", "k")}, o,
       ${member.mediaId}, ${member.objectKey}, ${member.sha}, 6000, 4000
     FROM generate_series(1, ${RELEASED}) AS k CROSS JOIN generate_series(1, ${MEMBERS}) AS o`,
  );
  // 500 live prepared intents of 7 private images each.
  const privateMember = privateImageSql(
    `((k - ${RELEASED + 1}) * ${MEMBERS} + o)`,
  );
  await setup.query(
    `INSERT INTO public.catalog_delivery_live_prepare_media
     SELECT ${liveHeaderSql("prepared", "now() + interval '1000 hours'", "k")}, o,
       ${privateMember.mediaId}, ${privateMember.objectKey}, ${privateMember.sha}, 3000, 2000
     FROM generate_series(${RELEASED + 1}, ${RELEASED + LIVE}) AS k
     CROSS JOIN generate_series(1, ${MEMBERS}) AS o`,
  );
  // 1,000 intents that ended within retention: one header each.
  await setup.query(
    `INSERT INTO public.catalog_delivery_live_prepare_media
     SELECT ${liveHeaderSql("cancelled", "now() - interval '40 hours'", "k")}, NULL, NULL, NULL, NULL, NULL, NULL
     FROM generate_series(${RELEASED + LIVE + 1}, ${RELEASED + LIVE + ENDED_WITHIN_R}) AS k`,
  );
  // 14,000 intents that ended long ago: tombstoned in the App mirror by
  // earlier passes, absent from the live projection.
  await setup.query(
    `INSERT INTO community.catalog_delivery_prepares(intent_id,cms_document_id,catalog_id,
       draft_revision,draft_fingerprint,manifest_sha256,recipe_manifest_sha256,media_count,
       source_state,source_state_version,expires_at,observed_at,observed_live,ended_at,created_at,updated_at)
     SELECT ('00000000-0000-4000-9000-' || lpad(to_hex(h), 12, '0'))::uuid, 100000 + h,
       'catalog-old-' || h, 1, repeat('a', 64), repeat('b', 64), '${policy}', 7, 'withdrawn', 3,
       now() - interval '900 hours', now() - interval '700 hours', false,
       now() - interval '800 hours', now() - interval '900 hours', now() - interval '700 hours'
     FROM generate_series(1, ${HISTORY}) AS h`,
  );
  // The App assets an earlier pass left: every published image but the last
  // 50 (200 of them unreferenced since), every private image but the first
  // 50 (unreferenced: not published), and 500 stale assets nothing names.
  await setup.query(
    `INSERT INTO community.catalog_media_assets ${assetColumns}
     SELECT ${asset(image, `CASE WHEN g <= ${REREFERENCED} THEN now() - interval '1 day' END`)}
     FROM generate_series(1, ${PUBLISHED - MISSING}) AS g`,
  );
  const privateImage = privateImageSql("p");
  await setup.query(
    `INSERT INTO community.catalog_media_assets ${assetColumns}
     SELECT ${asset(privateImage, "now() - interval '1 day'")}
     FROM generate_series(${MISSING + 1}, ${LIVE * MEMBERS}) AS p`,
  );
  await setup.query(
    `INSERT INTO community.catalog_media_assets ${assetColumns}
     SELECT ${asset(staleImageSql("s"), "NULL")} FROM generate_series(1, ${STALE}) AS s`,
  );
  await setup.query("ANALYZE");
  app = poolFor(url(appRole));
  publicRead = poolFor(url(publicRole));
  prepareRead = poolFor(url(prepareRole));
}, SLOW);

afterAll(async () => {
  await app?.end();
  await publicRead?.end();
  await prepareRead?.end();
  await setup?.end();
  if (created.database)
    await administration.query(
      `DROP DATABASE IF EXISTS ${database} WITH (FORCE)`,
    );
  for (const role of created.roles)
    await administration.query(`DROP ROLE IF EXISTS ${role}`);
  await administration.end();
}, SLOW);

describe.sequential("Catalog sync at 25,000 published images", () => {
  it(
    "runs under the restricted App role, which may neither create a temporary table nor delete",
    async () => {
      expect(
        (
          await setup.query(
            `SELECT has_database_privilege($1, current_database(), 'TEMPORARY') AS temporary,
             has_table_privilege($1, 'community.catalog_media_assets', 'DELETE') AS delete_assets,
             has_table_privilege($1, 'community.catalog_delivery_prepares', 'DELETE') AS delete_mirror,
             has_table_privilege($1, 'community.catalog_delivery_media_refs', 'DELETE') AS delete_members`,
            [appRole],
          )
        ).rows,
      ).toEqual([
        {
          temporary: false,
          delete_assets: false,
          delete_mirror: false,
          delete_members: false,
        },
      ]);
      await expect(
        app.query("CREATE TEMPORARY TABLE synthetic_probe(id text)"),
      ).rejects.toMatchObject({ code: "42501" });
    },
    SLOW,
  );

  it(
    "marks exactly the assets missing from the complete published list unreferenced",
    async () => {
      const before = await setup.query<{ jobs: number }>(
        "SELECT count(*)::integer AS jobs FROM community.publishing_jobs",
      );
      const ms = await pass();
      console.info(
        `[catalog-scale-sync] first pass ${ms}ms: ${appStatements.length} App statements`,
      );
      expect(logs).toEqual([
        `[media-worker] catalog sync referenced=${PUBLISHED + LIVE * MEMBERS} skipped=0 created=${2 * MISSING} unreferenced=${STALE + MISSING} enqueued=100`,
      ]);
      // Referenced: exactly the 25,000 published images, re-referenced ones
      // included; every other asset (private, stale, just created private) is
      // unreferenced. Nothing was deleted.
      const assets = (
        await setup.query<{
          published: number;
          referenced: number;
          exact: number;
          total: number;
        }>(
          `WITH published AS (
           SELECT 'catalog-asset-' || md5(media_id || ':' || object_key) AS id FROM public.catalog_media)
         SELECT (SELECT count(*)::integer FROM published) AS published,
           (SELECT count(*)::integer FROM community.catalog_media_assets WHERE unreferenced_since IS NULL) AS referenced,
           (SELECT count(*)::integer FROM community.catalog_media_assets a JOIN published p ON p.id = a.id
            WHERE a.unreferenced_since IS NULL) AS exact,
           (SELECT count(*)::integer FROM community.catalog_media_assets) AS total`,
        )
      ).rows[0]!;
      expect(assets).toEqual({
        published: PUBLISHED,
        referenced: PUBLISHED,
        exact: PUBLISHED,
        total: PUBLISHED + LIVE * MEMBERS + STALE,
      });
      expect(
        (
          await setup.query<{ jobs: number }>(
            "SELECT count(*)::integer AS jobs FROM community.publishing_jobs",
          )
        ).rows[0]!.jobs,
      ).toBe(before.rows[0]!.jobs + 100);
      // The mirror holds every intent of the snapshot beside the history, with
      // the members of the live ones, written in one statement per kind.
      expect(
        (
          await setup.query(
            `SELECT observed_live, count(*)::integer AS count
           FROM community.catalog_delivery_prepares GROUP BY observed_live ORDER BY observed_live`,
          )
        ).rows,
      ).toEqual([
        { observed_live: false, count: HISTORY },
        { observed_live: true, count: RELEASED + LIVE + ENDED_WITHIN_R },
      ]);
      expect((await state()).refs).toBe((RELEASED + LIVE) * MEMBERS);
      const writes = appStatements.filter(({ sql }) =>
        /^\s*(INSERT INTO|UPDATE) community\.catalog_delivery_(prepares|media_refs)\b/u.test(
          sql,
        ),
      );
      expect(writes.map(({ rows }) => rows)).toEqual([
        RELEASED + LIVE + ENDED_WITHIN_R,
        (RELEASED + LIVE) * MEMBERS,
        0,
      ]);
      // Typed array binds only: no statement sends the list as JSON, creates a
      // table or deletes a row.
      expect(
        appStatements.filter(({ sql }) =>
          /jsonb_to_recordset\(\$1|^\s*(DELETE|CREATE)\b/iu.test(sql),
        ),
      ).toEqual([]);
    },
    SLOW,
  );

  it(
    "rewrites no mirror row in a pass that changes nothing, and reads no ended history",
    async () => {
      const mirror = await xminOf("true");
      await pass();
      expect(await xminOf("true")).toBe(mirror);
      // Only the rows a pass can change were read: the live mirror rows and
      // the snapshot's intents, never the 14,000 tombstoned ones.
      expect(mirrorRowsRead().map(({ rows }) => rows)).toEqual([
        RELEASED + LIVE + ENDED_WITHIN_R,
      ]);
      expect(
        appStatements.filter(({ sql }) =>
          /^\s*(INSERT INTO|UPDATE) community\.catalog_delivery_(prepares|media_refs)\b/u.test(
            sql,
          ),
        ),
      ).toEqual([
        // The absence tombstone runs and changes nothing.
        expect.objectContaining({ rows: 0 }),
      ]);
    },
    SLOW,
  );

  it(
    "tombstones intents once they pass retention, once, and never reads them again",
    async () => {
      const leaving = `(SELECT intent_id FROM public.catalog_delivery_live_prepare_media
      WHERE state = 'cancelled' ORDER BY intent_id LIMIT 900)`;
      const ids = (
        await setup.query<{ id: string }>(
          `SELECT intent_id::text AS id FROM ${leaving} AS leaving`,
        )
      ).rows.map(({ id }) => id);
      await setup.query(
        `DELETE FROM public.catalog_delivery_live_prepare_media WHERE intent_id IN ${leaving}`,
      );
      await pass();
      const tombstoned = (
        await setup.query(
          `SELECT observed_live, count(*)::integer AS count FROM community.catalog_delivery_prepares
         WHERE intent_id = ANY($1::uuid[]) GROUP BY observed_live`,
          [ids],
        )
      ).rows;
      expect(tombstoned).toEqual([{ observed_live: false, count: 900 }]);
      const after = await xminOf(
        `intent_id = ANY('{${ids.join(",")}}'::uuid[])`,
      );
      await pass();
      expect(mirrorRowsRead().map(({ rows }) => rows)).toEqual([
        RELEASED + LIVE + ENDED_WITHIN_R - 900,
      ]);
      expect(
        await xminOf(`intent_id = ANY('{${ids.join(",")}}'::uuid[])`),
      ).toBe(after);
    },
    SLOW,
  );
});

describe.sequential("a sync that cannot read the complete snapshot", () => {
  // Changes a complete pass would apply: 10 published images marked
  // unreferenced, 5 new stale assets still referenced, one more prepared
  // intent of 7 new private images.
  beforeAll(async () => {
    await setup.query(
      `UPDATE community.catalog_media_assets SET unreferenced_since = now() - interval '2 days'
       WHERE id IN (SELECT 'catalog-asset-' || md5(media_id || ':' || object_key)
         FROM public.catalog_media ORDER BY media_id LIMIT 10)`,
    );
    await setup.query(
      `INSERT INTO community.catalog_media_assets ${assetColumns}
       SELECT ${asset(staleImageSql("s"), "NULL")}
       FROM generate_series(${STALE + 1}, ${STALE + 5}) AS s`,
    );
    const member = privateImageSql(`(100000 + o)`);
    await setup.query(
      `INSERT INTO public.catalog_delivery_live_prepare_media
       SELECT ${liveHeaderSql("prepared", "now() + interval '1000 hours'", "9001")}, o,
         ${member.mediaId}, ${member.objectKey}, ${member.sha}, 3000, 2000
       FROM generate_series(1, ${MEMBERS}) AS o`,
    );
  }, SLOW);

  it(
    "writes nothing when a FETCH fails midway or a row cannot be read",
    async () => {
      const before = await state();
      // The public connection drops at its third batch.
      let fetches = 0;
      const dropping = {
        connect: async () => {
          const client = await publicRead.connect();
          return new Proxy(client, {
            get(target, property) {
              if (property === "query")
                return async (sql: string, values?: unknown[]) => {
                  if (sql.startsWith("FETCH") && ++fetches === 3)
                    throw Object.assign(
                      new Error("synthetic terminated connection"),
                      { code: "57P01" },
                    );
                  return target.query(sql, values);
                };
              const value = Reflect.get(target, property) as unknown;
              return typeof value === "function" ? value.bind(target) : value;
            },
          });
        },
      } as unknown as Pool;
      await expect(pass(dropping)).rejects.toMatchObject({ code: "57P01" });
      expect(fetches).toBe(3);
      expect(await state()).toEqual(before);
      // A published row the projection cannot cast fails the read itself.
      await setup.query(
        `INSERT INTO public.cms_catalog_media(catalog_id,media_id,object_key,width,height,status)
       VALUES ('catalog-unreadable', 'synthetic-unreadable', 'display/v1/media_x', 1e12, 1, 'published')`,
      );
      try {
        await expect(pass()).rejects.toMatchObject({ code: "22003" });
        expect(await state()).toEqual(before);
      } finally {
        await setup.query(
          "DELETE FROM public.cms_catalog_media WHERE media_id = 'synthetic-unreadable'",
        );
      }
    },
    SLOW,
  );

  it(
    "writes nothing one row past the ceiling",
    async () => {
      const before = await state();
      const extra = CATALOG_SNAPSHOT_MAX_SOURCES + 1 - PUBLISHED;
      await setup.query(
        `INSERT INTO public.cms_catalog_media(catalog_id,media_id,object_key,width,height,status)
       SELECT 'catalog-ceiling', 'synthetic-ceiling-' || c, 'display/v1/media_' || md5('c' || c),
         10, 10, 'published'
       FROM generate_series(1, ${extra}) AS c`,
      );
      try {
        const ms = await pass();
        console.info(
          `[catalog-scale-sync] ceiling + 1 (${CATALOG_SNAPSHOT_MAX_SOURCES + 1} rows) refused in ${ms}ms`,
        );
        expect(logs).toEqual([
          "[media-worker] catalog sync skipped: incomplete snapshot",
        ]);
        expect(appStatements).toEqual([]);
        expect(await state()).toEqual(before);
      } finally {
        await setup.query(
          "DELETE FROM public.cms_catalog_media WHERE catalog_id = 'catalog-ceiling'",
        );
      }
    },
    SLOW,
  );

  it(
    "applies what was pending once the complete snapshot is read again",
    async () => {
      await pass();
      expect(
        (
          await setup.query(
            `SELECT
             (SELECT count(*)::integer FROM community.catalog_media_assets a
              JOIN public.catalog_media m ON a.id = 'catalog-asset-' || md5(m.media_id || ':' || m.object_key)
              WHERE a.unreferenced_since IS NOT NULL) AS unreferenced_published,
             (SELECT count(*)::integer FROM community.catalog_media_assets
              WHERE media_id LIKE 'synthetic-stale-%' AND unreferenced_since IS NULL) AS referenced_stale,
             (SELECT count(*)::integer FROM community.catalog_delivery_media_refs
              WHERE intent_id = ${intentIdSql("9001")}) AS new_members`,
          )
        ).rows,
      ).toEqual([
        {
          unreferenced_published: 0,
          referenced_stale: 0,
          new_members: MEMBERS,
        },
      ]);
    },
    SLOW,
  );
});

describe.sequential("a sync beside a readiness inspection", () => {
  const digest = (algorithm: "md5" | "sha256", value: string) =>
    createHash(algorithm).update(value).digest("hex");
  /** Polls `ready` every 20 ms, for at most 60 s. */
  const until = async (ready: () => Promise<boolean>) => {
    for (const started = Date.now(); !(await ready());) {
      if (Date.now() - started > 60_000)
        throw new Error("synthetic wait timed out");
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  };

  it(
    "locks the asset rows it changes in id order, as an inspection does, so neither waits for the other in turn",
    async () => {
      // Two member assets of one intent, ordered by id: the lower is about
      // to be unreferenced, the higher re-referenced (published again).
      const [leaving, returning] = [1, 2]
        .map((n) => {
          const sha = digest("sha256", `synthetic-lock-${n}`);
          const mediaId = `synthetic-lock-${n}`;
          const objectKey = `display/v1/media_${digest("md5", `lock-${n}`)}/${sha}.webp`;
          return {
            mediaId,
            objectKey,
            sha,
            id: `catalog-asset-${digest("md5", `${mediaId}:${objectKey}`)}`,
          };
        })
        .sort((a, b) => (a.id < b.id ? -1 : 1)) as [
        { mediaId: string; objectKey: string; sha: string; id: string },
        { mediaId: string; objectKey: string; sha: string; id: string },
      ];
      const literal = (image: typeof leaving) => ({
        mediaId: `'${image.mediaId}'`,
        objectKey: `'${image.objectKey}'`,
        sha: `'${image.sha}'`,
      });
      await setup.query(
        `INSERT INTO community.catalog_media_assets ${assetColumns}
         VALUES (${asset(literal(leaving), "NULL")}),
           (${asset(literal(returning), "now() - interval '1 day'")})`,
      );
      await setup.query(
        `INSERT INTO public.cms_catalog_media(catalog_id,media_id,object_key,width,height,status)
         VALUES ('catalog-lock', $1, $2, 6000, 4000, 'published')`,
        [returning.mediaId, returning.objectKey],
      );
      const inspection = await setup.connect();
      let syncing: Promise<string> | undefined;
      let inspected: string | undefined;
      try {
        // The inspection holds the lower row, as its sorted lock takes it.
        await inspection.query("BEGIN");
        await inspection.query("SET LOCAL lock_timeout = '20s'");
        await inspection.query(
          "SELECT id FROM community.catalog_media_assets WHERE id = $1 FOR SHARE",
          [leaving.id],
        );
        syncing = pass().then(
          () => "applied",
          (error: { code?: string }) => error.code ?? "failed",
        );
        // The pass waits for that row...
        await until(
          async () =>
            (
              await setup.query<{ waiting: number }>(
                `SELECT count(*)::integer AS waiting FROM pg_locks l
                 JOIN pg_stat_activity s ON s.pid = l.pid
                 WHERE NOT l.granted AND s.usename = $1`,
                [appRole],
              )
            ).rows[0]!.waiting > 0,
        );
        // ...holding none above it, so the inspection takes the higher row
        // and finishes, and then the pass goes on.
        inspected = await inspection
          .query(
            "SELECT id FROM community.catalog_media_assets WHERE id = $1 FOR SHARE",
            [returning.id],
          )
          .then(
            () => "locked",
            (error: { code?: string }) => error.code ?? "failed",
          );
        await inspection.query(inspected === "locked" ? "COMMIT" : "ROLLBACK");
      } finally {
        await inspection.query("ROLLBACK").catch(() => undefined);
        inspection.release();
      }
      expect(inspected).toBe("locked");
      expect(await syncing).toBe("applied");
      expect(
        (
          await setup.query(
            `SELECT id, unreferenced_since IS NOT NULL AS unreferenced
             FROM community.catalog_media_assets WHERE id = ANY($1::text[]) ORDER BY id`,
            [[leaving.id, returning.id]],
          )
        ).rows,
      ).toEqual([
        { id: leaving.id, unreferenced: true },
        { id: returning.id, unreferenced: false },
      ]);
    },
    SLOW,
  );
});

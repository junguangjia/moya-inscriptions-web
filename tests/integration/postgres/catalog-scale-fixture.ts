import { createHash, randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import {
  catalogExpectedRenditions,
  currentCatalogRecipePolicy,
} from "@moya/backend-production/internal/catalog-delivery";
import { runCommunityMigrations } from "@moya/community-postgres";

import {
  CATALOG_PREPARE_RETENTION_HOURS,
  createPublishedCatalogViewsSql,
  downgradePublishedCatalogMediaViewSql,
  upgradeCatalogDeliveryPrepareViewsSql,
  upgradePublishedCatalogMediaViewSql,
} from "admin/published";

import { assertSyntheticTestDatabaseUrl } from "./synthetic-test-database.js";

import type { createPostgresPool } from "@moya/catalog-postgres";

/*
 * catalog-scale-v1 (Issue #323) 1B, slice W0: a deterministic Catalog of any
 * size for the PostgreSQL suites and the scale bench, built with set-based
 * SQL in seconds. One dedicated synthetic database holds both sides, each
 * read through its own role as in Production:
 * - the CMS: Payload-shaped `catalogs` and `catalogs_media` tables under the
 *   real `catalog_media` view text (admin/published; fenced as before CMS
 *   migration M1, or keyed after it, by M1's own exported SQL), the real
 *   delivery intent tables and private view of CMS migration
 *   20261020_160000, run from that migration file's own SQL, and the two
 *   private prepare views of CMS migration M2 (20261024_000000) from its
 *   exported SQL: the full `catalog_delivery_prepare_media` and the live
 *   projection `catalog_delivery_live_prepare_media`, which the worker's
 *   complete snapshot reads (every released intent, and every other intent
 *   that ended or expired within R, CATALOG_PREPARE_RETENTION_HOURS);
 * - the App: every community migration, with the assets, renditions, blobs
 *   and published generations of the published images and, optionally, the
 *   intent mirror the worker sync would have written.
 * The roles: the App role holds the runtime grants only
 * (infra/development/work-publishing/grant-runtime.sql), the public read role
 * reads `catalog_media` only, and the prepare reader reads the two private
 * views only (infra/development/catalog-media/grant-prepare-read.sql).
 *
 * Every name derives from its record and image number, so two seeds of one
 * shape hold the same rows. Only three times follow the database clock,
 * because the private views evaluate them with now(): the live intents'
 * expiry, the end of the recently ended intents (which keeps them inside R),
 * and the mirror's observation time, which a real-time sync must follow.
 * Content is synthetic; no object store, real CMS or network.
 */

type Pool = ReturnType<typeof createPostgresPool>;
const connect = (pool: Pool) => pool.connect();
type Client = Awaited<ReturnType<typeof connect>>;

const root = fileURLToPath(new URL("../../../", import.meta.url));
const guard = (await import(
  new URL("../../../scripts/disposable-test-target.mjs", import.meta.url).href
)) as {
  disposableTestTargetProbeSql: string;
  assertDisposableTestTarget(rows: unknown, database: string): string;
};

const hex = (bytes = 16) => randomBytes(bytes).toString("hex");
const sha256 = (value: string) =>
  createHash("sha256").update(value, "utf8").digest("hex");
const md5 = (value: string) =>
  createHash("md5").update(value, "utf8").digest("hex");
/** SQL: the hex SHA-256 of a text expression, as `sha256` above. */
const shaSql = (text: string) =>
  `encode(sha256(convert_to(${text}, 'UTF8')), 'hex')`;
/** SQL: the version-4 UUID `catalogScaleIntentId` derives from a seed text. */
const uuidSql = (text: string) =>
  `overlay(overlay(md5(${text}) placing '4' from 13 for 1) placing '8' from 17 for 1)::uuid`;

/** Creation and update time of every seeded CMS and App row but the mirror's,
 * and the end of every ended intent, except the recent ended intents' times,
 * which follow the database clock. The intents ended at the epoch were also
 * created there, with the 24-hour lease from the epoch (so an expired one
 * ended before its lease did): a compressed history no reader compares, as
 * the live projection tests their end only and the sync never reads them. */
export const CATALOG_SCALE_EPOCH = new Date("2026-01-01T00:00:00.000Z");

/** The recent ended intents end 1..48 hours before the seed: inside R (the
 * live projection lists them) by a margin no bench run reaches, and before
 * the mirror's observation time (ten minutes before the seed). */
const RECENT_END_HOURS = 48;
/** Revision of the recent ended intents: a later draft than the revision 2
 * every record is published at, based on it, so no release of a later
 * revision of the record precedes their end. */
const RECENT_ENDED_REVISION = 3;
if (RECENT_END_HOURS * 2 > CATALOG_PREPARE_RETENTION_HOURS)
  throw new Error("Recent ended intents must end well within R");

/**
 * The size of a synthetic Catalog. Published records come first (document
 * ids 1..records), then the draft records. The 25k fixture of the issue
 * (W-AC*) is `CATALOG_SCALE_25K`.
 */
export interface CatalogScaleShape {
  /** catalog_media rows: records of `imagesPerRecord` images, the last one
   * holding the remainder. */
  readonly publishedImages: number;
  readonly imagesPerRecord: number;
  /** Records only in draft, each with `imagesPerRecord` images that no
   * published view names; the live intents prepare them. */
  readonly draftRecords: number;
  /** Released intents of published records 1..n, naming all their images. */
  readonly releasedIntents: number;
  /** Ended intents (cancelled, superseded, expired and withdrawn in turn),
   * cycling over the published records: one header row each in the full
   * private view, never deleted, as the CMS keeps them. All but the last
   * `recentEndedIntents` ended at the epoch, long before R: the live
   * projection no longer lists them, and the mirror holds them as the
   * tombstones the sync leaves by absence. */
  readonly endedIntents: number;
  /** Of the ended intents, the last n ended 1..48 hours before the seed,
   * within R: the live projection lists them as header rows, and the mirror
   * still observes them live. Each is a later draft of its record (revision
   * 3, based on the published revision 2, which any released intent of the
   * record carries), and its lease follows from its end, as the CMS writes
   * one: created an hour before a cancel, supersession or withdrawal, or a
   * whole lease (24 hours) before it expired, and expiring 24 hours after its
   * creation. A withdrawn one does not replay its record's withdrawal (the
   * record stays published and its released intent released); no reader
   * compares the two. */
  readonly recentEndedIntents: number;
  /** Live intents of draft records 1..n (one each, as the CMS allows). */
  readonly livePrepares: number;
  /** Every n-th live intent is release_requested, the others prepared. */
  readonly requestedEvery: number;
}

/** 3,600 published records x 7 images, 3,000 released intents (21,000 media
 * rows), 15,000 ended intents and 500 live prepares (W-AC1..W-AC12). 200 of
 * the ended intents are recent: 15,000 intents ending at an even rate over
 * the ten months since the epoch put about 200 inside R (96 hours). */
export const CATALOG_SCALE_25K: CatalogScaleShape = Object.freeze({
  publishedImages: 25_200,
  imagesPerRecord: 7,
  draftRecords: 500,
  releasedIntents: 3_000,
  endedIntents: 15_000,
  recentEndedIntents: 200,
  livePrepares: 500,
  requestedEvery: 5,
});

/** A shape of `publishedImages` images in the proportions of the 25k
 * fixture (released intents per record, ended, recent ended (never more than
 * the ended) and live prepares per image), with any field overridden. */
export const catalogScaleShape = (
  publishedImages: number,
  overrides: Partial<CatalogScaleShape> = {},
): CatalogScaleShape => {
  const base = CATALOG_SCALE_25K;
  const records = Math.ceil(publishedImages / base.imagesPerRecord);
  const scale = publishedImages / base.publishedImages;
  const live = Math.round(base.livePrepares * scale);
  const ended = overrides.endedIntents ?? Math.round(base.endedIntents * scale);
  return validShape({
    publishedImages,
    imagesPerRecord: base.imagesPerRecord,
    draftRecords: live,
    releasedIntents: Math.round(
      (records * base.releasedIntents) /
        Math.ceil(base.publishedImages / base.imagesPerRecord),
    ),
    endedIntents: ended,
    recentEndedIntents: Math.min(
      Math.round(base.recentEndedIntents * scale),
      ended,
    ),
    livePrepares: live,
    requestedEvery: base.requestedEvery,
    ...overrides,
  });
};

const validShape = (shape: CatalogScaleShape): CatalogScaleShape => {
  const whole = (value: number, min: number) =>
    Number.isSafeInteger(value) && value >= min;
  const records = Math.ceil(shape.publishedImages / shape.imagesPerRecord);
  if (
    !whole(shape.publishedImages, 1) ||
    !whole(shape.imagesPerRecord, 1) ||
    shape.imagesPerRecord > 2_000 ||
    !whole(shape.draftRecords, 0) ||
    !whole(shape.releasedIntents, 0) ||
    !whole(shape.endedIntents, 0) ||
    !whole(shape.recentEndedIntents, 0) ||
    shape.recentEndedIntents > shape.endedIntents ||
    !whole(shape.livePrepares, 0) ||
    !whole(shape.requestedEvery, 1) ||
    shape.releasedIntents > records ||
    shape.livePrepares > shape.draftRecords
  )
    throw new TypeError("Catalog scale shape invalid");
  return Object.freeze({ ...shape });
};

/** The rows a shape puts on the CMS side, and the worker's view of them,
 * while the live intents are unexpired (the seed's default) and the recent
 * ended intents are within R (for 48 hours after the seed): once a lease
 * expires, the private views show that intent as one header row and the
 * sync drops its pairs, so the row counts and `unionSources` no longer hold. */
export const catalogScaleCounts = (input: CatalogScaleShape) => {
  const shape = validShape(input);
  const records = Math.ceil(shape.publishedImages / shape.imagesPerRecord);
  const lastRecordImages =
    shape.publishedImages - (records - 1) * shape.imagesPerRecord;
  const imagesOf = (n: number) =>
    n === records ? lastRecordImages : shape.imagesPerRecord;
  let releasedMedia = 0;
  for (let n = 1; n <= shape.releasedIntents; n += 1)
    releasedMedia += imagesOf(n);
  const liveMedia = shape.livePrepares * shape.imagesPerRecord;
  const requested = Math.floor(shape.livePrepares / shape.requestedEvery);
  return {
    records,
    lastRecordImages,
    publishedImages: shape.publishedImages,
    draftImages: shape.draftRecords * shape.imagesPerRecord,
    /** Every intent: the full private view's and the App mirror's. */
    intents: shape.releasedIntents + shape.endedIntents + shape.livePrepares,
    /** The intents the live projection lists, so the worker's snapshot
     * decodes and the mirror observes live: released, recent ended and live
     * ones. The others (ended at the epoch) are mirror tombstones. */
    liveIntents:
      shape.releasedIntents + shape.recentEndedIntents + shape.livePrepares,
    releasedMedia,
    liveMedia,
    requested,
    /** Rows of the full private view: media rows of released and live
     * intents, one header row per ended intent. */
    privateRows: releasedMedia + shape.endedIntents + liveMedia,
    /** Rows of the live projection, which the snapshot reads: the same media
     * rows, and a header row per recent ended intent only. */
    livePrivateRows: releasedMedia + shape.recentEndedIntents + liveMedia,
    /** The worker's sync sources: published pairs plus live current-recipe
     * pairs (the live ones are never published). */
    unionSources: shape.publishedImages + liveMedia,
  };
};

/** The CMS record `n` (its Payload document id is `n`). */
export const catalogScaleRecord = (n: number) => ({
  documentId: n,
  catalogId: `scale-catalog-${n}`,
});

/** Image `i` (1-based) of record `n`: odd images are landscape, even ones
 * portrait, each with its own approved editorial key. */
export const catalogScaleImage = (n: number, i: number) => {
  const mediaId = `scale-media-${n}-${i}`;
  const sourceSha256 = sha256(`scale-bytes-${n}-${i}`);
  const objectKey = `editorial/${sha256(`scale-catalog-${n}`)}/${sha256(mediaId)}-${sourceSha256}.jpg`;
  return {
    mediaId,
    objectKey,
    sourceSha256,
    width: i % 2 === 1 ? 6000 : 4000,
    height: i % 2 === 1 ? 4000 : 6000,
    assetId: `catalog-asset-${md5(`${mediaId}:${objectKey}`)}`,
  };
};

export type CatalogScaleIntentKind = "released" | "ended" | "live";

/** The intent id of the k-th (1-based) released, ended or live intent. */
export const catalogScaleIntentId = (
  kind: CatalogScaleIntentKind,
  k: number,
) => {
  const h = md5(`scale-intent:${kind}:${k}`);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
};

/** The rendition id of a seeded role of an asset (generation 2 is the set a
 * recipe bump records). */
export const catalogScaleRenditionId = (
  assetId: string,
  role: string,
  generation: 1 | 2 = 1,
) =>
  `media-rendition-${md5(`scale-rendition:${generation}:${assetId}:${role}`)}`;

export type CatalogMediaView = "fenced" | "keyed";

/**
 * One synthetic CMS + App database with its three identities. `setup` owns
 * every relation (fixture writes, DDL, EXPLAIN as owner); the others connect
 * as their role. `close` ends the pools and drops the database and roles.
 */
export interface CatalogScaleDatabase {
  readonly database: string;
  readonly setup: Pool;
  readonly app: Pool;
  readonly publicRead: Pool;
  readonly prepare: Pool;
  close(): Promise<void>;
}

/**
 * The SQL a raw-SQL CMS migration runs in `up`, read from its file (the
 * migration modules are not among the Admin package's exports): exactly one
 * `sql` template without interpolation or escapes, else it throws.
 */
export const cmsMigrationUpSql = async (name: string): Promise<string> => {
  const source = await readFile(
    `${root}/apps/admin/src/migrations/${name}.ts`,
    "utf8",
  );
  const up = source.slice(
    source.indexOf("export async function up("),
    source.indexOf("export async function down("),
  );
  const templates = [...up.matchAll(/await db\.execute\(sql`([^`]*)`\);/gu)];
  const text = templates[0]?.[1];
  if (
    templates.length !== 1 ||
    text === undefined ||
    text.includes("${") ||
    text.includes("\\")
  )
    throw new Error(`CMS migration ${name} is not one raw sql template`);
  return text;
};

/** Runs SQL in one transaction, as Payload runs a migration. */
const inTransaction = async (pool: Pool, sql: string) => {
  const client = await connect(pool);
  try {
    await client.query("BEGIN");
    await client.query(sql);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
};

/** The published media view exactly as the CMS creates it before M1. */
const fencedCatalogMediaViewSql = (() => {
  const start = createPublishedCatalogViewsSql.indexOf(
    "CREATE VIEW catalog_media AS",
  );
  if (start < 0) throw new Error("catalog_media view text not found");
  return createPublishedCatalogViewsSql.slice(start);
})();

/** Payload-shaped stand-ins for the tables the CMS views and the delivery
 * intent migration read: the columns those read, with the types, keys and
 * every index 20260908_030835_p2_04_initial creates on them (M1 adds its own).
 * The real tables carry more columns, so a plan measured here is evidence for
 * these columns only; the R7 plans are gated on Payload clones in tests/cms.
 * The other public relations are the stubs the runtime grant script names. */
const cmsTablesSql = `
CREATE TYPE public.enum_catalogs_status AS ENUM ('draft', 'published');
CREATE TABLE public.users (id serial PRIMARY KEY NOT NULL);
CREATE TABLE public.catalogs (
  id serial PRIMARY KEY NOT NULL,
  revision numeric DEFAULT 0,
  catalog_id varchar,
  title varchar,
  updated_at timestamp(3) with time zone DEFAULT now() NOT NULL,
  created_at timestamp(3) with time zone DEFAULT now() NOT NULL,
  _status public.enum_catalogs_status DEFAULT 'draft'
);
CREATE UNIQUE INDEX catalogs_catalog_id_idx ON public.catalogs USING btree (catalog_id);
CREATE INDEX catalogs_updated_at_idx ON public.catalogs USING btree (updated_at);
CREATE INDEX catalogs_created_at_idx ON public.catalogs USING btree (created_at);
CREATE INDEX catalogs__status_idx ON public.catalogs USING btree (_status);
CREATE TABLE public.catalogs_media (
  _order integer NOT NULL,
  _parent_id integer NOT NULL,
  id varchar PRIMARY KEY NOT NULL,
  media_id varchar,
  object_key varchar,
  width numeric,
  height numeric,
  alt varchar,
  position numeric,
  is_representative boolean DEFAULT false,
  rights varchar
);
ALTER TABLE public.catalogs_media ADD CONSTRAINT catalogs_media_parent_id_fk
  FOREIGN KEY (_parent_id) REFERENCES public.catalogs(id) ON DELETE cascade ON UPDATE no action;
CREATE INDEX catalogs_media_order_idx ON public.catalogs_media USING btree (_order);
CREATE INDEX catalogs_media_parent_id_idx ON public.catalogs_media USING btree (_parent_id);
CREATE TABLE public.catalog_entries(catalog_id text PRIMARY KEY, province text, province_state text);
CREATE TABLE public.catalog_discovery(catalog_id text PRIMARY KEY, kind text, title text, aliases varchar[], first_published_at timestamptz, filter_metadata jsonb);
CREATE TABLE public.article_entries(article_id text PRIMARY KEY, title text);
`;

/** psql variables (`:'name'` literals, `:"name"` identifiers) of a grant
 * script, replaced with fixture role names. */
const grantScript = async (path: string, roles: Record<string, string>) => {
  let sql = await readFile(`${root}/${path}`, "utf8");
  for (const [name, value] of Object.entries(roles))
    sql = sql
      .replaceAll(`:"${name}"`, `"${value}"`)
      .replaceAll(`:'${name}'`, `'${value}'`);
  return sql;
};

const LABEL = /^[a-z][a-z0-9_]{0,15}$/u;

/**
 * Creates the database (`<label>_<hex>_synthetic_test` on `target`, the
 * suite's guarded TEST_DATABASE_URL, which must also be loopback and carry
 * the disposable marker), its roles and both schemas, empty. Every pool is
 * opened by the caller's `openPool`, so a suite's guard visibly precedes its
 * connections (tests/unit/architecture/postgres-test-database-guard.test.ts).
 * The published view starts `keyed` (CMS migration M1 applied, as this head
 * ships it) unless `view` says `fenced`.
 */
export const createCatalogScaleDatabase = async (options: {
  readonly target: string;
  readonly openPool: (url: string) => Pool;
  readonly label?: string;
  readonly view?: CatalogMediaView;
}): Promise<CatalogScaleDatabase> => {
  const label = options.label ?? "catscale";
  if (!LABEL.test(label)) throw new TypeError("Catalog scale label invalid");
  const targetUrl = options.target;
  const targetDatabase = assertSyntheticTestDatabaseUrl(targetUrl);
  const endpoint = new URL(targetUrl);
  if (
    !["127.0.0.1", "localhost", "[::1]"].includes(endpoint.hostname) ||
    endpoint.search ||
    endpoint.hash
  )
    throw new Error(
      "Catalog scale fixtures require a loopback disposable target",
    );
  const poolFor = options.openPool;
  const administration = poolFor(targetUrl);
  const suffix = hex(6);
  const database = `${label}_${suffix}_synthetic_test`;
  const roles = {
    app: `${label}_app_${suffix}`,
    publicRead: `${label}_public_${suffix}`,
    prepare: `${label}_prepare_${suffix}`,
  };
  const created = new Set<string>();
  const pools: Pool[] = [];
  const close = async () => {
    await Promise.all(pools.map((pool) => pool.end()));
    if (created.has(database))
      await administration.query(
        `DROP DATABASE IF EXISTS ${database} WITH (FORCE)`,
      );
    for (const role of Object.values(roles))
      if (created.has(role))
        await administration.query(`DROP ROLE IF EXISTS ${role}`);
    await administration.end();
  };
  try {
    const probe = await administration.query(
      guard.disposableTestTargetProbeSql,
    );
    guard.assertDisposableTestTarget(probe.rows, targetDatabase);
    const passwords = new Map<string, string>();
    for (const role of Object.values(roles)) {
      const password = hex(32);
      passwords.set(role, password);
      await administration.query(
        `CREATE ROLE ${role} LOGIN PASSWORD '${password}' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION NOINHERIT`,
      );
      created.add(role);
    }
    await administration.query(`CREATE DATABASE ${database}`);
    created.add(database);
    const url = (role?: string) => {
      const value = new URL(targetUrl);
      value.pathname = `/${database}`;
      if (role !== undefined) {
        value.username = role;
        value.password = passwords.get(role)!;
      }
      return value.toString();
    };
    const setup = poolFor(url());
    pools.push(setup);
    // As infra/development/init-roles.sql: CONNECT only (no TEMPORARY), no
    // CREATE on public, and a read-only public reader.
    await setup.query(
      `REVOKE ALL ON DATABASE ${database} FROM PUBLIC;
       REVOKE CREATE ON SCHEMA public FROM PUBLIC;
       GRANT CONNECT ON DATABASE ${database} TO ${Object.values(roles).join(", ")};
       ALTER ROLE ${roles.publicRead} SET default_transaction_read_only = on`,
    );
    await runCommunityMigrations(
      setup,
      `${root}/database/community-migrations`,
    );
    await setup.query(cmsTablesSql);
    await setup.query(fencedCatalogMediaViewSql);
    await inTransaction(
      setup,
      await cmsMigrationUpSql("20261020_160000_catalog_delivery_intents"),
    );
    // CMS migration M1 (20261023_000000) runs exactly this export.
    if ((options.view ?? "keyed") === "keyed")
      await inTransaction(setup, upgradePublishedCatalogMediaViewSql);
    // CMS migration M2 (20261024_000000) runs exactly this export: the live
    // prepare view the worker's snapshot reads, which the prepare grant
    // script names.
    await inTransaction(setup, upgradeCatalogDeliveryPrepareViewsSql);
    await setup.query(
      await grantScript("infra/development/work-publishing/grant-runtime.sql", {
        app_role: roles.app,
      }),
    );
    // The App reads the intent ids and the stored asset id of its own media
    // references, as the other Catalog delivery suites grant it.
    await setup.query(
      `GRANT SELECT (intent_id, asset_id) ON TABLE community.catalog_delivery_media_refs TO "${roles.app}"`,
    );
    await setup.query(
      `GRANT SELECT ON public.catalog_media TO "${roles.publicRead}"`,
    );
    await inTransaction(
      setup,
      await grantScript(
        "infra/development/catalog-media/grant-prepare-read.sql",
        {
          prepare_reader: roles.prepare,
          approved_prepare_reader: roles.prepare,
          public_read_role: roles.publicRead,
          backend_read_role: roles.publicRead,
        },
      ),
    );
    const app = poolFor(url(roles.app));
    const publicRead = poolFor(url(roles.publicRead));
    const prepare = poolFor(url(roles.prepare));
    pools.push(app, publicRead, prepare);
    return { database, setup, app, publicRead, prepare, close };
  } catch (error) {
    await close().catch(() => undefined);
    throw error;
  }
};

/** Whether catalog_media is the fenced (pre-M1) or keyed view. */
export const catalogMediaView = async (
  fixture: Pick<CatalogScaleDatabase, "setup">,
): Promise<CatalogMediaView> =>
  (
    await fixture.setup.query<{ keyed: boolean }>(
      "SELECT coalesce('security_barrier=true' = ANY(reloptions), false) AS keyed FROM pg_class WHERE oid = 'public.catalog_media'::regclass",
    )
  ).rows[0]!.keyed
    ? "keyed"
    : "fenced";

/** Applies (keyed) or undoes (fenced) CMS migration M1, whose up and down
 * run exactly these exports. */
export const setCatalogMediaView = async (
  fixture: Pick<CatalogScaleDatabase, "setup">,
  view: CatalogMediaView,
): Promise<void> => {
  if ((await catalogMediaView(fixture)) === view) return;
  await inTransaction(
    fixture.setup,
    view === "keyed"
      ? upgradePublishedCatalogMediaViewSql
      : downgradePublishedCatalogMediaViewSql,
  );
};

const cmsRelations = [
  "public.catalog_delivery_receipts",
  "public.catalog_delivery_intents",
  "public.catalogs_media",
  "public.catalogs",
  "public.users",
];
const appRelations = [
  "community.catalog_delivery_rendition_pins",
  "community.catalog_delivery_media_refs",
  "community.catalog_delivery_prepares",
  "community.catalog_delivery_snapshot_watermark",
  "community.media_publications",
  "community.media_public_assets",
  "community.media_renditions",
  "community.catalog_media_assets",
  "community.media_blobs",
  "community.publishing_jobs",
];

/** Empties the CMS side, the App side, or both (default), keeping schemas,
 * views, grants and roles. The App relations reference one another only
 * among themselves in this database, so nothing else is cleared. */
export const clearCatalogScale = async (
  fixture: Pick<CatalogScaleDatabase, "setup">,
  scope: { readonly cms?: boolean; readonly app?: boolean } = {},
): Promise<void> => {
  const relations = [
    ...((scope.cms ?? true) ? cmsRelations : []),
    ...((scope.app ?? true) ? appRelations : []),
  ];
  if (relations.length)
    await fixture.setup.query(
      `TRUNCATE ${relations.join(", ")} RESTART IDENTITY CASCADE`,
    );
};

/** Planner statistics for every relation the fixture fills. */
export const analyzeCatalogScale = async (
  fixture: Pick<CatalogScaleDatabase, "setup">,
): Promise<void> => {
  for (const relation of [...cmsRelations, ...appRelations])
    await fixture.setup.query(`ANALYZE ${relation}`);
};

export interface CatalogScaleSeedOptions {
  /** App rows (default true); false leaves the App empty, as before the
   * first sync. */
  readonly app?: boolean;
  /** The App assets of live-prepare images: pending with a queued render job
   * (default, a render backlog), ready with unpublished renditions, or
   * absent (not synced yet). Either way they are unreferenced, as the sync
   * leaves private-only assets. */
  readonly liveAssets?: "pending" | "ready" | "absent";
  /** The App intent mirror (default true): every intent's header and media
   * references, the released intents' approved pins on their published
   * generations, and the snapshot watermark, as a sync and inspection left
   * them ten minutes before the seed. An intent is observed live while the
   * live projection lists it; one it no longer lists (ended or expired more
   * than R ago) is the tombstone a sync leaves by absence. */
  readonly mirror?: boolean;
  /** How long after the seed the live intents expire, as a PostgreSQL
   * interval (default '24 hours', the CMS lease); a negative interval seeds
   * them expired, and one past -R also out of the live projection. */
  readonly liveExpiresIn?: string;
  /** Planner statistics after the seed (default true). */
  readonly analyze?: boolean;
}

export interface CatalogScaleSeed {
  readonly shape: CatalogScaleShape;
  readonly counts: ReturnType<typeof catalogScaleCounts>;
  /** Wall time of each part, in milliseconds. */
  readonly ms: {
    readonly cms: number;
    readonly app: number;
    readonly analyze: number;
  };
}

/** JSON `[{width, height, roles}]`: the current recipe's plan of every
 * image size the fixture uses. */
const plansJson = () =>
  JSON.stringify(
    [
      [6000, 4000],
      [4000, 6000],
    ].map(([width, height]) => ({
      width,
      height,
      roles: catalogExpectedRenditions(width!, height!),
    })),
  );

/** SQL: the plan rows `p` of asset `a`'s master size. */
const planJoinSql = (asset: string, plans: string) => `
  JOIN jsonb_to_recordset(${plans}::jsonb) AS plan(width integer, height integer, roles jsonb)
    ON plan.width = ${asset}.master_width AND plan.height = ${asset}.master_height
  CROSS JOIN LATERAL jsonb_to_recordset(plan.roles)
    AS p(role text, version integer, digest text, width integer, height integer)`;

/** The two statements that record committed owner-less WebP blobs and ready
 * base renditions of the current recipe for the ready assets `where` selects
 * (alias `a`), of generation `generation`, created at `$1`; `$2` is the plans
 * JSON. */
const renditionsSql = (where: string, generation: 1 | 2) => {
  const seed = (kind: string) =>
    `md5('${kind}:${generation}:' || a.id || ':' || p.role)`;
  return [
    `
INSERT INTO community.media_blobs (id, owner_id, purpose, storage_key, byte_size, sha256, content_type, state, created_at)
SELECT 'media-blob-' || ${seed("scale-blob")}, NULL, 'catalog_derivative',
  'blobs/' || substr(${seed("scale-storage")}, 1, 2) || '/' || substr(${seed("scale-storage")}, 3, 2) || '/' || ${seed("scale-storage")},
  1000 + p.width + p.height, ${shaSql(`'media-blob-' || ${seed("scale-blob")}`)}, 'image/webp', 'committed', $1::timestamptz
FROM community.catalog_media_assets a ${planJoinSql("a", "$2")}
WHERE ${where}`,
    `
INSERT INTO community.media_renditions (id, catalog_asset_id, edit_key, role, recipe_version, recipe_digest, blob_id, width, height, content_type, state, created_at)
SELECT 'media-rendition-' || ${seed("scale-rendition")}, a.id, 'base', p.role, p.version, p.digest,
  'media-blob-' || ${seed("scale-blob")}, p.width, p.height, 'image/webp', 'ready', $1::timestamptz
FROM community.catalog_media_assets a ${planJoinSql("a", "$2")}
WHERE ${where}`,
  ];
};

/**
 * Seeds an empty fixture with `shape` (both sides by default). CMS: users 1,
 * the published then draft records and their media, and the intents with
 * their manifests. App: a ready asset with the current recipe's renditions,
 * all published, per published image; the live images' assets; the intent
 * mirror. The App rows are read from the CMS rows, so both sides always agree.
 */
export const seedCatalogScale = async (
  fixture: Pick<CatalogScaleDatabase, "setup">,
  input: CatalogScaleShape,
  options: CatalogScaleSeedOptions = {},
): Promise<CatalogScaleSeed> => {
  const shape = validShape(input);
  const counts = catalogScaleCounts(shape);
  const policy = currentCatalogRecipePolicy();
  const client = await connect(fixture.setup);
  const ms = { cms: 0, app: 0, analyze: 0 };
  try {
    const existing = (
      await client.query<{ n: number }>(
        "SELECT (SELECT count(*) FROM public.catalogs) + (SELECT count(*) FROM community.catalog_media_assets) AS n",
      )
    ).rows[0]!;
    if (Number(existing.n) !== 0)
      throw new Error("Clear the Catalog scale fixture before seeding it");
    await client.query("BEGIN");
    let started = performance.now();
    await client.query("INSERT INTO public.users (id) VALUES (1)");
    await client.query(
      `INSERT INTO public.catalogs (id, revision, catalog_id, title, updated_at, created_at, _status)
       SELECT n, 2, 'scale-catalog-' || n, 'Synthetic record ' || n, $3::timestamptz, $3::timestamptz,
         (CASE WHEN n <= $1 THEN 'published' ELSE 'draft' END)::public.enum_catalogs_status
       FROM generate_series(1, $1::integer + $2::integer) AS n`,
      [counts.records, shape.draftRecords, CATALOG_SCALE_EPOCH],
    );
    await client.query(
      `SELECT setval(pg_get_serial_sequence('public.catalogs', 'id'), $1::integer + $2::integer)`,
      [counts.records, shape.draftRecords],
    );
    await client.query(
      `INSERT INTO public.catalogs_media (_order, _parent_id, id, media_id, object_key, width, height, alt, position, is_representative, rights)
       SELECT i, n, substr(md5('scale-row:' || n || ':' || i), 1, 24), 'scale-media-' || n || '-' || i,
         'editorial/' || ${shaSql("'scale-catalog-' || n")} || '/' || ${shaSql("'scale-media-' || n || '-' || i")}
           || '-' || ${shaSql("'scale-bytes-' || n || '-' || i")} || '.jpg',
         CASE WHEN i % 2 = 1 THEN 6000 ELSE 4000 END, CASE WHEN i % 2 = 1 THEN 4000 ELSE 6000 END,
         'Synthetic image ' || i, i - 1, i = 1, 'Synthetic rights'
       FROM generate_series(1, $1::integer + $2::integer) AS n
       CROSS JOIN LATERAL generate_series(1, CASE WHEN n = $1 THEN $4::integer ELSE $3::integer END) AS i`,
      [
        counts.records,
        shape.draftRecords,
        shape.imagesPerRecord,
        counts.lastRecordImages,
      ],
    );
    await client.query(
      `WITH manifests AS (
         SELECT m._parent_id AS n, jsonb_agg(jsonb_build_object(
           'mediaId', m.media_id, 'objectKey', m.object_key,
           'width', m.width::integer, 'height', m.height::integer, 'alt', m.alt,
           'position', m.position::integer, 'isRepresentative', m.is_representative,
           'rights', m.rights,
           'sourceSha256', substring(m.object_key FROM '-([a-f0-9]{64})\\.jpg$')) ORDER BY m._order) AS media
         FROM public.catalogs_media m GROUP BY m._parent_id
       ), planned (kind, k, n, state, state_version, revision, ended_at, created_at) AS (
         SELECT 'released', k, k, 'released', 3, 2, NULL::timestamptz, $8::timestamptz
         FROM generate_series(1, $1::integer) AS k
         UNION ALL
         -- The recent ended intents (the last ones) are a later draft, revision
         -- ${RECENT_ENDED_REVISION}, that ended 1..${RECENT_END_HOURS} hours ago (the newest last), an hour
         -- after its prepare, or its whole lease after it when it expired.
         SELECT 'ended', e.k, ((e.k - 1) % $4::integer) + 1, e.state, 2,
           CASE WHEN e.recent THEN ${RECENT_ENDED_REVISION} ELSE 1 END, e.ended_at,
           CASE WHEN NOT e.recent THEN $8::timestamptz
             WHEN e.state = 'expired' THEN e.ended_at - interval '24 hours'
             ELSE e.ended_at - interval '1 hour' END
         FROM (
           SELECT k, k > $2::integer - $10::integer AS recent,
             (ARRAY['cancelled', 'superseded', 'expired', 'withdrawn'])[((k - 1) % 4) + 1] AS state,
             CASE WHEN k > $2::integer - $10::integer
               THEN now() - make_interval(hours => 1 + ($2::integer - k) % ${RECENT_END_HOURS})
               ELSE $8::timestamptz END AS ended_at
           FROM generate_series(1, $2::integer) AS k
         ) e
         UNION ALL
         SELECT 'live', k, $4::integer + k,
           CASE WHEN k % $5::integer = 0 THEN 'release_requested' ELSE 'prepared' END,
           CASE WHEN k % $5::integer = 0 THEN 2 ELSE 1 END, 1, NULL::timestamptz, $8::timestamptz
         FROM generate_series(1, $3::integer) AS k
       )
       INSERT INTO public.catalog_delivery_intents (id, catalog_document_id, catalog_id, actor_id,
         draft_revision, draft_fingerprint, draft_snapshot, base_revision, base_status, base_fingerprint,
         media_manifest, media_manifest_sha256, recipe_manifest, recipe_manifest_sha256, state,
         state_version, release_requested_by, release_requested_at, release_proof_sha256, ended_at,
         end_reason, expires_at, created_at, updated_at)
       SELECT ${uuidSql("'scale-intent:' || p.kind || ':' || p.k")}, p.n, 'scale-catalog-' || p.n, 1,
         p.revision, ${shaSql("'scale-fingerprint:' || p.kind || ':' || p.k")}, '{}'::jsonb,
         p.revision - 1, CASE WHEN p.kind = 'live' THEN 'draft' ELSE 'published' END,
         ${shaSql("'scale-base:' || p.kind || ':' || p.k")},
         m.media, ${shaSql("m.media::text")}, $6::jsonb, $7, p.state, p.state_version,
         CASE WHEN p.state IN ('release_requested', 'released') THEN 1 END,
         CASE WHEN p.state IN ('release_requested', 'released') THEN $8::timestamptz END,
         CASE WHEN p.state = 'released' THEN ${shaSql("'scale-proof:' || p.k")} END,
         p.ended_at,
         CASE WHEN p.kind = 'ended' THEN 'synthetic' END,
         CASE WHEN p.kind = 'live' THEN now() + $9::interval ELSE p.created_at + interval '24 hours' END,
         p.created_at, COALESCE(p.ended_at, p.created_at)
       FROM planned p JOIN manifests m ON m.n = p.n`,
      [
        shape.releasedIntents,
        shape.endedIntents,
        shape.livePrepares,
        counts.records,
        shape.requestedEvery,
        policy.canonicalManifest,
        policy.recipeManifestSha256,
        CATALOG_SCALE_EPOCH,
        options.liveExpiresIn ?? "24 hours",
        shape.recentEndedIntents,
      ],
    );
    ms.cms = performance.now() - started;
    started = performance.now();
    if (options.app ?? true) await seedApp(client, options);
    ms.app = performance.now() - started;
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
  if (options.analyze ?? true) {
    const started = performance.now();
    await analyzeCatalogScale(fixture);
    ms.analyze = performance.now() - started;
  }
  return { shape, counts, ms };
};

const seedApp = async (client: Client, options: CatalogScaleSeedOptions) => {
  const plans = plansJson();
  // Each step joins rows this transaction just wrote: without statistics a
  // planner can loop over whole tables (PG16 spent minutes on the publication
  // insert trigger at 20k images), so each step's inputs are analyzed first.
  const analyze = (relations: readonly string[]) =>
    client.query(`ANALYZE ${relations.join(", ")}`);
  await analyze([
    "public.catalogs",
    "public.catalogs_media",
    "public.catalog_delivery_intents",
  ]);
  const observed = (
    await client.query<{ at: Date }>(
      "SELECT now() - interval '10 minutes' AS at",
    )
  ).rows[0]!.at;
  const assetSql = (where: string, state: "ready" | "pending") => `
    INSERT INTO community.catalog_media_assets (id, media_id, source_object_key, source_sha256,
      source_width, source_height, source_content_type, master_sha256, master_width, master_height,
      state, unreferenced_since, created_at, updated_at)
    SELECT 'catalog-asset-' || md5(m.media_id || ':' || m.object_key), m.media_id, m.object_key, s.sha,
      m.width, m.height, 'image/jpeg', ${state === "ready" ? "s.sha, m.width, m.height" : "NULL, NULL, NULL"},
      '${state}', CASE WHEN c._status = 'published' THEN NULL ELSE $2::timestamptz END, $1::timestamptz, $1::timestamptz
    FROM public.catalogs_media m JOIN public.catalogs c ON c.id = m._parent_id
    CROSS JOIN LATERAL (SELECT substring(m.object_key FROM '-([a-f0-9]{64})\\.jpg$') AS sha) s
    WHERE ${where}`;
  const live = `c._status = 'draft' AND EXISTS (SELECT 1 FROM public.catalog_delivery_intents i
    WHERE i.catalog_document_id = c.id AND i.state IN ('prepared', 'release_requested'))`;
  await client.query(assetSql("c._status = 'published'", "ready"), [
    CATALOG_SCALE_EPOCH,
    observed,
  ]);
  const liveAssets = options.liveAssets ?? "pending";
  if (liveAssets !== "absent")
    await client.query(assetSql(live, liveAssets), [
      CATALOG_SCALE_EPOCH,
      observed,
    ]);
  if (liveAssets === "pending")
    await client.query(
      `INSERT INTO community.publishing_jobs (id, kind, subject_id, state, attempts, run_after, created_at, updated_at)
       SELECT 'publishing-job-' || md5('scale-render:' || a.id), 'catalog_render', a.id, 'queued', 0,
         $1::timestamptz, $1::timestamptz, $1::timestamptz
       FROM community.catalog_media_assets a WHERE a.state = 'pending'`,
      [CATALOG_SCALE_EPOCH],
    );
  for (const sql of renditionsSql("a.state = 'ready'", 1))
    await client.query(sql, [CATALOG_SCALE_EPOCH, plans]);
  await client.query(
    `INSERT INTO community.media_public_assets (id, catalog_asset_id, next_generation, desired_seq, synced_seq, desired_at, created_at, updated_at)
     SELECT md5('scale-public:' || a.id), a.id, 2, 1, 1, $1::timestamptz, $1::timestamptz, $1::timestamptz
     FROM community.catalog_media_assets a WHERE a.state = 'ready' AND a.unreferenced_since IS NULL`,
    [CATALOG_SCALE_EPOCH],
  );
  await analyze([
    "community.catalog_media_assets",
    "community.media_blobs",
    "community.media_renditions",
    "community.media_public_assets",
  ]);
  await client.query(
    `INSERT INTO community.media_publications (id, public_asset_id, rendition_id, generation_token, object_key,
       storage_key, content_type, purpose, byte_size, sha256, role, edit_key, state, version, created_at, published_at)
     SELECT 'media-publication-' || md5('scale-publication:' || r.id), pa.id, r.id, md5('scale-generation:' || r.id),
       'v1/' || pa.id || '/' || md5('scale-generation:' || r.id) || '/base/' || r.role || '.r' || r.recipe_version || '.webp',
       b.storage_key, 'image/webp', 'catalog_derivative', b.byte_size, b.sha256, r.role, 'base', 'published', 1,
       $1::timestamptz, $1::timestamptz
     FROM community.media_public_assets pa
     JOIN community.media_renditions r ON r.catalog_asset_id = pa.catalog_asset_id AND r.state = 'ready'
     JOIN community.media_blobs b ON b.id = r.blob_id`,
    [CATALOG_SCALE_EPOCH],
  );
  if (!(options.mirror ?? true)) return;
  // The mirror as a sync left it at `observed`: each intent's view state then
  // (a live lease past its expiry reads as expired), its stored media, and the
  // released intents' approved pins, which name the published generations.
  // The sync reads only the live projection (M2), and an intent absent from
  // it is tombstoned (observed_live false, ended), never read or written
  // again: so an intent is observed live exactly while the projection itself
  // lists it, here at the seed's now(), as the next sync will read it.
  await client.query(
    `INSERT INTO community.catalog_delivery_prepares (intent_id, cms_document_id, catalog_id, draft_revision,
       draft_fingerprint, manifest_sha256, recipe_manifest_sha256, media_count, source_state, source_state_version,
       expires_at, observed_at, observed_live, ended_at, created_at, updated_at)
     SELECT i.id, i.catalog_document_id, i.catalog_id, i.draft_revision, i.draft_fingerprint,
       i.media_manifest_sha256, i.recipe_manifest_sha256, jsonb_array_length(i.media_manifest),
       v.state, i.state_version, i.expires_at, $1::timestamptz,
       i.id IN (SELECT intent_id FROM public.catalog_delivery_live_prepare_media),
       CASE WHEN v.state IN ('cancelled', 'superseded', 'expired', 'withdrawn') THEN COALESCE(i.ended_at, $1::timestamptz) END,
       $1::timestamptz, $1::timestamptz
     FROM public.catalog_delivery_intents i
     CROSS JOIN LATERAL (SELECT CASE WHEN i.state IN ('prepared', 'release_requested') AND i.expires_at <= $1::timestamptz
       THEN 'expired' ELSE i.state END AS state) v
     WHERE i.recipe_manifest_sha256 IS NOT NULL`,
    [observed],
  );
  await client.query(
    `INSERT INTO community.catalog_delivery_media_refs (intent_id, ordinal, media_id, object_key, source_sha256, width, height)
     SELECT i.id, e.ordinal, e.value->>'mediaId', e.value->>'objectKey', e.value->>'sourceSha256',
       (e.value->>'width')::integer, (e.value->>'height')::integer
     FROM public.catalog_delivery_intents i
     CROSS JOIN LATERAL jsonb_array_elements(i.media_manifest) WITH ORDINALITY AS e(value, ordinal)
     WHERE i.recipe_manifest_sha256 IS NOT NULL`,
  );
  await analyze([
    "community.media_publications",
    "community.catalog_delivery_prepares",
    "community.catalog_delivery_media_refs",
  ]);
  await client.query(
    `INSERT INTO community.catalog_delivery_rendition_pins (intent_id, ordinal, role, rendition_id, recipe_version,
       recipe_digest, public_generation_id, public_generation_version, created_at)
     SELECT f.intent_id, f.ordinal, r.role, r.id, r.recipe_version, r.recipe_digest, p.id, p.version, $1::timestamptz
     FROM community.catalog_delivery_media_refs f
     JOIN community.catalog_delivery_prepares pi ON pi.intent_id = f.intent_id AND pi.source_state = 'released'
     JOIN community.media_renditions r ON r.catalog_asset_id = f.asset_id AND r.state = 'ready'
       AND r.role IN ('thumb', 'cover', 'display', 'viewer')
     JOIN community.media_publications p ON p.rendition_id = r.id AND p.state = 'published'`,
    [observed],
  );
  await client.query(
    "INSERT INTO community.catalog_delivery_snapshot_watermark (id, observed_at) VALUES (true, $1::timestamptz)",
    [observed],
  );
};

/**
 * The N3 mid-state of a recipe bump for the published images of records
 * `first`..`last`: as in the robustness suite, the stored renditions take an
 * older recipe digest and are released when the re-render records the
 * current recipe's set (generation 2, ready, not yet copied), while their
 * published generations keep serving. The registry itself is unchanged.
 * Returns the number of assets bumped.
 */
export const bumpCatalogScaleRecipe = async (
  fixture: Pick<CatalogScaleDatabase, "setup">,
  records: { readonly first: number; readonly last: number },
): Promise<number> => {
  const at = new Date(CATALOG_SCALE_EPOCH.getTime() + 60 * 60 * 1000);
  const client = await connect(fixture.setup);
  try {
    await client.query("BEGIN");
    // Published records only: with `liveAssets: 'ready'` a range reaching
    // the drafts would otherwise bump their private-only assets too.
    const bumped = await client.query<{ id: string }>(
      `UPDATE community.catalog_media_assets a SET updated_at = $3::timestamptz
       FROM public.catalogs_media m JOIN public.catalogs c ON c.id = m._parent_id AND c._status = 'published'
       WHERE m._parent_id BETWEEN $1 AND $2 AND a.media_id = m.media_id AND a.source_object_key = m.object_key
         AND a.state = 'ready'
       RETURNING a.id`,
      [records.first, records.last, at],
    );
    const ids = bumped.rows.map((row) => row.id);
    await client.query(
      `UPDATE community.media_renditions SET recipe_digest = '0000000000000000', state = 'released', released_at = $2::timestamptz
       WHERE catalog_asset_id = ANY($1::text[]) AND state = 'ready'`,
      [ids, at],
    );
    for (const sql of renditionsSql("a.id = ANY($3::text[])", 2))
      await client.query(sql, [at, plansJson(), ids]);
    await client.query("COMMIT");
    return ids.length;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
};

/** One statement a recorded pool or one of its clients ran. */
export interface RecordedQuery {
  readonly pool: string;
  readonly sql: string;
  readonly values: readonly unknown[] | undefined;
  /** Wall time to the result (NaN for a submittable such as a cursor). */
  readonly ms: number;
  readonly rows: number | null;
  readonly failed: boolean;
}

/**
 * Records every statement run through the pools it wraps (pool.query and the
 * queries of clients from pool.connect), with its wall time and row count,
 * for per-operation query counts and statement profiles. Values are kept by
 * reference, for EXPLAIN replays.
 */
export const createQueryRecorder = () => {
  const queries: RecordedQuery[] = [];
  const connects = new Map<string, number>();
  const run = (
    pool: string,
    query: (...args: unknown[]) => unknown,
    args: unknown[],
  ) => {
    const [text, values] = args;
    const sql =
      typeof text === "string"
        ? text
        : String((text as { text?: unknown } | null)?.text ?? "<submittable>");
    const started = performance.now();
    const record = (ms: number, rows: number | null, failed: boolean) =>
      queries.push({
        pool,
        sql,
        values: Array.isArray(values) ? values : undefined,
        ms,
        rows,
        failed,
      });
    const result = query(...args);
    if (!(result instanceof Promise)) {
      record(Number.NaN, null, false);
      return result;
    }
    return result.then(
      (value: { rowCount?: number | null } | undefined) => {
        record(performance.now() - started, value?.rowCount ?? null, false);
        return value;
      },
      (error: unknown) => {
        record(performance.now() - started, null, true);
        throw error;
      },
    );
  };
  const bound = <T extends object>(
    target: T,
    intercept: Partial<Record<string | symbol, unknown>>,
  ): T =>
    new Proxy(target, {
      get(object, key) {
        if (key in intercept) return intercept[key];
        const value = Reflect.get(object, key, object) as unknown;
        return typeof value === "function" ? value.bind(object) : value;
      },
    });
  return {
    queries,
    /** The pool, recording under `name`. */
    wrap(name: string, pool: Pool): Pool {
      return bound(pool, {
        query: (...args: unknown[]) =>
          run(name, pool.query.bind(pool) as never, args),
        connect: async () => {
          connects.set(name, (connects.get(name) ?? 0) + 1);
          const client = await connect(pool);
          return bound(client, {
            query: (...args: unknown[]) =>
              run(name, client.query.bind(client) as never, args),
          });
        },
      });
    },
    /** Statements and connects per pool name. */
    counts() {
      const statements: Record<string, number> = {};
      for (const query of queries)
        statements[query.pool] = (statements[query.pool] ?? 0) + 1;
      return { statements, connects: Object.fromEntries(connects) };
    },
    reset() {
      queries.length = 0;
      connects.clear();
    },
  };
};
export type QueryRecorder = ReturnType<typeof createQueryRecorder>;

/** The shape of a plan: node labels ("Index Scan using … on …"), the
 * relations read by a Seq Scan, the indexes used and, with ANALYZE, the
 * execution time. */
export interface CatalogScalePlan {
  readonly nodes: readonly string[];
  readonly seqScans: readonly string[];
  readonly indexes: readonly string[];
  readonly executionMs: number | null;
  readonly planRows: number | null;
}

/** EXPLAIN (FORMAT JSON) of one statement, with ANALYZE when asked, in a
 * transaction that is always rolled back (so a write is never kept). */
export const explainCatalogScale = async (
  pool: Pool,
  sql: string,
  values: readonly unknown[] = [],
  options: { readonly analyze?: boolean } = {},
): Promise<CatalogScalePlan> => {
  const client = await connect(pool);
  try {
    await client.query("BEGIN");
    const result = await client.query<{ "QUERY PLAN": unknown }>(
      `EXPLAIN (FORMAT JSON${options.analyze ? ", ANALYZE, BUFFERS" : ""}) ${sql}`,
      [...values],
    );
    const [explained] = result.rows[0]!["QUERY PLAN"] as {
      Plan: Record<string, unknown>;
      "Execution Time"?: number;
    }[];
    const nodes: string[] = [];
    const seqScans = new Set<string>();
    const indexes = new Set<string>();
    const walk = (node: Record<string, unknown>) => {
      const type = String(node["Node Type"]);
      const relation = node["Relation Name"] as string | undefined;
      const index = node["Index Name"] as string | undefined;
      nodes.push(
        `${type}${index ? ` using ${index}` : ""}${relation ? ` on ${relation}` : ""}`,
      );
      if (type === "Seq Scan" && relation) seqScans.add(relation);
      if (index) indexes.add(index);
      for (const child of (node.Plans as Record<string, unknown>[]) ?? [])
        walk(child);
    };
    walk(explained!.Plan);
    return {
      nodes,
      seqScans: [...seqScans].sort(),
      indexes: [...indexes].sort(),
      executionMs: explained!["Execution Time"] ?? null,
      planRows: (explained!.Plan["Plan Rows"] as number | undefined) ?? null,
    };
  } finally {
    await client.query("ROLLBACK").catch(() => undefined);
    client.release();
  }
};

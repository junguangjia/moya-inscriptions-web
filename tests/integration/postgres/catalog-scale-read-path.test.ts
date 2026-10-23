import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import {
  catalogExpectedRenditions,
  createCatalogDeliveryFacts,
  createCatalogPublicationAuthority,
} from "@moya/backend-production/internal/catalog-delivery";
import {
  CATALOG_SYNC_MAX_SOURCES,
  listPublishedCatalogSources,
  publishedCatalogPairs,
  publishedCatalogPairsSql,
} from "@moya/backend-production/internal/publishing-catalog";
import {
  createBackendApplication,
  startBackendProcess,
} from "@moya/backend-runtime";
import {
  createPostgresPool,
  parsePostgresConfig,
} from "@moya/catalog-postgres";
import {
  PostgresMediaPublicationAdapter,
  runCommunityMigrations,
} from "@moya/community-postgres";
import {
  articleDetailSchema,
  articlePageSchema,
  catalogDetailSchema,
  catalogPageSchema,
  discoveryPageSchema,
} from "@moya/contracts/schemas";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { InMemoryCommunityIdentityPort } from "../../unit/backend/community-identity-fixture.js";

import {
  assertSyntheticTestDatabaseUrl,
  requireSyntheticTestDatabaseUrl,
} from "./synthetic-test-database.js";

import type {
  ArticleDetailRecord,
  AuthorCommunityPort,
  CatalogMediaProjection,
  CatalogQueryPort,
  CommunityDiscoveryPort,
  DiscoveryCardRecord,
  EditorialContentReadPort,
  EditorialMediaRecord,
  PublishingJobLease,
  StorageUrlResolver,
} from "@moya/api";
import type { ArticleId, CatalogId, MediaId } from "@moya/contracts";

/*
 * catalog-scale-v1 (Issue #323) 1A, the public read path at Catalog scale, on
 * a dedicated synthetic database with its own App role and a public read
 * role that may read only the published projection. The projection is a view
 * over a stub CMS media table holding published and draft rows, fenced like
 * the Payload view; 2,900 published records x 7 images (20,300 rows) put it
 * well beyond the old 10,000-image listing ceiling. Rendition facts and URLs
 * are read through the exact pair check: only live published pairs are
 * served, never a pair deleted or moved to draft, one only a prepared intent
 * names, an old object key, or an incomplete editorial set; the read path
 * never touches the prepare pool. The facts are composition's own lookup
 * (createCatalogDeliveryFacts), and the public Catalog, feed and Article
 * routes are read over it at this size. Content is synthetic; no object
 * store, real CMS or network.
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
const SLOW = 180_000;
const t0 = new Date("2126-10-22T04:00:00.000Z");
const at = (minutes: number) => new Date(t0.getTime() + minutes * 60_000);
const hex = (bytes = 16) => randomBytes(bytes).toString("hex");
const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const md5 = (value: string) => createHash("md5").update(value).digest("hex");

const RECORDS = 2_900;
const IMAGES_PER_RECORD = 7;

const suffix = hex(6);
const database = `cs_read_${suffix}_synthetic_test`;
const appRole = `cs_app_${suffix}`;
const publicRole = `cs_public_${suffix}`;
let setup: Pool;
let app: Pool;
let publicRead: Pool;
let created = { database: false, app: false, public: false };

beforeAll(async () => {
  const probe = await administration.query(guard.disposableTestTargetProbeSql);
  guard.assertDisposableTestTarget(
    probe.rows,
    assertSyntheticTestDatabaseUrl(targetUrl),
  );
  const appPassword = hex(32);
  const publicPassword = hex(32);
  await administration.query(
    `CREATE ROLE ${appRole} LOGIN PASSWORD '${appPassword}' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION NOINHERIT`,
  );
  created = { ...created, app: true };
  await administration.query(
    `CREATE ROLE ${publicRole} LOGIN PASSWORD '${publicPassword}' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION NOINHERIT`,
  );
  created = { ...created, public: true };
  await administration.query(`CREATE DATABASE ${database}`);
  created = { ...created, database: true };
  const url = (login?: {
    readonly role: string;
    readonly password: string;
  }) => {
    const value = new URL(targetUrl);
    value.pathname = `/${database}`;
    if (login !== undefined) {
      value.username = login.role;
      value.password = login.password;
    }
    return value.toString();
  };
  setup = poolFor(url());
  await runCommunityMigrations(setup, `${root}/database/community-migrations`);
  // The CMS stubs the grant scripts name. catalog_media is a fenced view of
  // the published rows of a media table that also holds drafts, as the
  // Payload projection is; the private prepare projection is a stub only the
  // prepare identity would read.
  await setup.query(
    `CREATE TABLE public.catalog_entries(catalog_id text PRIMARY KEY,province text,province_state text);
     CREATE TABLE public.catalog_discovery(catalog_id text PRIMARY KEY,kind text,title text,aliases varchar[],first_published_at timestamptz,filter_metadata jsonb);
     CREATE TABLE public.article_entries(article_id text PRIMARY KEY,title text);
     CREATE TABLE public.cms_catalog_media(catalog_id text NOT NULL,media_id varchar NOT NULL,object_key varchar NOT NULL,width numeric,height numeric,is_representative boolean,position numeric NOT NULL DEFAULT 0,status text NOT NULL);
     CREATE VIEW public.catalog_media AS
       SELECT catalog_id, media_id, position::integer AS position, is_representative, width::integer AS width, height::integer AS height, object_key
       FROM public.cms_catalog_media WHERE status = 'published' OFFSET 0;
     CREATE TABLE public.catalog_delivery_prepare_media(intent_id uuid NOT NULL,state text NOT NULL,expires_at timestamptz NOT NULL,media_ordinal integer,media_id text,object_key text)`,
  );
  await setup.query(
    (
      await readFile(
        `${root}/infra/development/work-publishing/grant-runtime.sql`,
        "utf8",
      )
    ).replaceAll(':"app_role"', `"${appRole}"`),
  );
  await setup.query(
    `GRANT SELECT (intent_id, asset_id) ON TABLE community.catalog_delivery_media_refs TO "${appRole}"`,
  );
  // The public read identity reads the published projection only.
  await setup.query(`GRANT SELECT ON public.catalog_media TO "${publicRole}"`);
  app = poolFor(url({ role: appRole, password: appPassword }));
  publicRead = poolFor(url({ role: publicRole, password: publicPassword }));
}, SLOW);

afterAll(async () => {
  await app?.end();
  await publicRead?.end();
  await setup?.end();
  if (created.database)
    await administration.query(
      `DROP DATABASE IF EXISTS ${database} WITH (FORCE)`,
    );
  if (created.app) await administration.query(`DROP ROLE IF EXISTS ${appRole}`);
  if (created.public)
    await administration.query(`DROP ROLE IF EXISTS ${publicRole}`);
  await administration.end();
}, SLOW);

const blobKey = () => {
  const key = hex();
  return `blobs/${key.slice(0, 2)}/${key.slice(2, 4)}/${key}`;
};

interface Image {
  readonly mediaId: string;
  readonly objectKey: string;
  readonly assetId: string;
  readonly width: number;
  readonly height: number;
}

/** The SHA-256 of an image's bytes, which its object key embeds. */
const bytesOf = (mediaId: string, version: string) =>
  sha(`${mediaId}:${version}`);
const editorialKey = (mediaId: string, version = "v1") =>
  `editorial/${sha(`catalog-${mediaId}`)}/${sha(`${mediaId}:orig`)}-${bytesOf(mediaId, version)}.jpg`;

const editorialImage = (width = 4096, height = 2731): Image => {
  const mediaId = `media-${hex(8)}`;
  const objectKey = editorialKey(mediaId);
  return {
    mediaId,
    objectKey,
    assetId: `catalog-asset-${md5(`${mediaId}:${objectKey}`)}`,
    width,
    height,
  };
};
const pairOf = (image: { mediaId: string; objectKey: string }) => ({
  mediaId: image.mediaId,
  objectKey: image.objectKey,
});
const keyOf = (image: { mediaId: string; objectKey: string }) =>
  JSON.stringify([image.mediaId, image.objectKey]);

/** Ready renditions of the current recipe on committed blobs (of the listed
 * roles, else every planned role); returns their IDs. */
const readyRenditions = async (
  image: Image,
  when: Date,
  roles?: readonly string[],
) => {
  const ids: string[] = [];
  for (const want of catalogExpectedRenditions(image.width, image.height)) {
    if (roles && !roles.includes(want.role)) continue;
    const blob = `media-blob-${hex()}`;
    await setup.query(
      "INSERT INTO community.media_blobs(id,owner_id,purpose,storage_key,byte_size,sha256,content_type,created_at) VALUES($1,NULL,'catalog_derivative',$2,1000,$3,'image/webp',$4)",
      [blob, blobKey(), sha(blob), when],
    );
    const id = `media-rendition-${hex()}`;
    await setup.query(
      "INSERT INTO community.media_renditions(id,catalog_asset_id,edit_key,role,recipe_version,recipe_digest,blob_id,width,height,content_type,created_at) VALUES($1,$2,'base',$3,$4,$5,$6,$7,$8,'image/webp',$9)",
      [
        id,
        image.assetId,
        want.role,
        want.version,
        want.digest,
        blob,
        want.width,
        want.height,
        when,
      ],
    );
    ids.push(id);
  }
  return ids.sort();
};

/** A published editorial image with a ready App asset and renditions (every
 * planned role, or the listed ones), rendered long enough ago that the blob
 * purge delay no longer protects its bytes. */
const publishedImage = async (roles?: readonly string[]) => {
  const image = editorialImage();
  await setup.query(
    "INSERT INTO public.cms_catalog_media(catalog_id,media_id,object_key,width,height,is_representative,position,status) VALUES($1,$2,$3,$4,$5,true,0,'published')",
    [
      `catalog-${hex(8)}`,
      image.mediaId,
      image.objectKey,
      image.width,
      image.height,
    ],
  );
  const master = bytesOf(image.mediaId, "v1");
  await setup.query(
    `INSERT INTO community.catalog_media_assets(id,media_id,source_object_key,source_sha256,source_width,source_height,source_content_type,master_sha256,master_width,master_height,state,created_at,updated_at)
     VALUES($1,$2,$3,$4,$5,$6,'image/jpeg',$4,$5,$6,'ready',$7,$7)`,
    [
      image.assetId,
      image.mediaId,
      image.objectKey,
      master,
      image.width,
      image.height,
      t0,
    ],
  );
  return { image, renditions: await readyRenditions(image, at(-180), roles) };
};

/** A pool that records what it is asked, for the read path's query counts. */
const recorded = (pool: Pool) => {
  const statements: string[] = [];
  let connects = 0;
  return {
    statements,
    connects: () => connects,
    pool: {
      query: (sql: string, values?: unknown[]) => {
        statements.push(sql);
        return pool.query(sql, values);
      },
      connect: async () => {
        connects += 1;
        return pool.connect();
      },
    } as unknown as Pool,
  };
};

const publishingAdapter = () =>
  new PostgresMediaPublicationAdapter(app, {
    isPublic: () => true,
    allowPublish: () => true,
    catalogAuthority: createCatalogPublicationAuthority(publicRead, null, app),
  });

/** Runs the queued publish job of a subject to completion. */
const publishQueued = async (subject: string, when: Date) => {
  const owner = hex(8);
  const job = (
    await setup.query<{ id: string }>(
      "UPDATE community.publishing_jobs SET state='running',attempts=attempts+1,lease_owner=$2,lease_expires_at=$3::timestamptz + interval '1 hour' WHERE subject_id=$1 AND kind='publish_media' AND state='queued' RETURNING id",
      [subject, owner, when],
    )
  ).rows[0]!;
  const lease: PublishingJobLease = { id: job.id, leaseOwner: owner };
  const publication = publishingAdapter();
  const plan = await publication.planPublish(subject, lease, when);
  if (plan.status !== "ready") throw new Error(plan.status);
  try {
    expect(await publication.finishPublish(plan.fence, when)).toBe(true);
  } finally {
    await publication.release(plan.fence, when);
    await setup.query(
      "UPDATE community.publishing_jobs SET state='succeeded',finished_at=$2,lease_owner=NULL,lease_expires_at=NULL WHERE id=$1",
      [job.id, when],
    );
  }
  return plan.units.map((unit) => unit.renditionId!).sort();
};

const publishedGenerations = async (assetId: string) =>
  (
    await setup.query<{ rendition_id: string }>(
      "SELECT p.rendition_id FROM community.media_publications p JOIN community.media_public_assets a ON a.id=p.public_asset_id WHERE a.catalog_asset_id=$1 AND p.state='published' ORDER BY p.rendition_id",
      [assetId],
    )
  ).rows.map((r) => r.rendition_id);

describe("catalog-scale-v1 1A: public reads at 20,300 published images", () => {
  type Published = Awaited<ReturnType<typeof publishedImage>>;
  const images = {} as Record<
    "a" | "b" | "partial" | "gone" | "draft" | "prepared" | "swap",
    Published
  >;
  /** The read path as composed: the authority holds the prepare pool, the
   * public read pool answers the exact checks; both are recorded. */
  const reader = () => {
    const cms = recorded(publicRead);
    const prepare = recorded(setup);
    const adapter = new PostgresMediaPublicationAdapter(app, {
      isPublic: () => true,
      allowPublish: () => true,
      catalogAuthority: createCatalogPublicationAuthority(
        cms.pool,
        prepare.pool,
        app,
      ),
    });
    const authority = createCatalogPublicationAuthority(
      cms.pool,
      prepare.pool,
      app,
    );
    return { cms, prepare, adapter, authority };
  };
  const untouched = (prepare: ReturnType<typeof recorded>) => {
    expect(prepare.statements).toEqual([]);
    expect(prepare.connects()).toBe(0);
  };
  /** Composition's catalogFacts itself over the given public read pool: the
   * exact check, then the App projection of only the live pairs. */
  const facts = (
    cms: Pool,
    pairs: readonly { mediaId: string; objectKey: string }[],
  ) =>
    createCatalogDeliveryFacts(
      cms,
      app,
    )(
      pairs.map(({ mediaId, objectKey }) => ({
        mediaId: mediaId as MediaId,
        objectKey,
      })),
    );
  /** The fact keys of `pair` asked beside the live image a, so the App
   * projection is read and only the check decides what it is handed. */
  const besideLive = async (
    cms: Pool,
    pair: { mediaId: string; objectKey: string },
  ) => [...(await facts(cms, [pairOf(images.a.image), pair])).keys()];

  beforeAll(async () => {
    images.a = await publishedImage();
    images.b = await publishedImage();
    // Only the thumb is rendered: an incomplete editorial set.
    images.partial = await publishedImage(["thumb"]);
    images.gone = await publishedImage();
    images.draft = await publishedImage();
    images.prepared = await publishedImage();
    images.swap = await publishedImage();
    // Every image's renditions are published while the Catalog is small
    // (the worker's listing still has its ceiling; 1B lifts it).
    expect(await publishingAdapter().reconcile(at(1), true, 500)).toMatchObject(
      { publish: 7 },
    );
    for (const { image } of Object.values(images))
      await publishQueued(image.assetId, at(2));
    for (const { image, renditions } of Object.values(images))
      expect(await publishedGenerations(image.assetId)).toEqual(renditions);
    // 2,900 published records x 7 images, and draft rows beside them.
    await setup.query(
      `INSERT INTO public.cms_catalog_media(catalog_id,media_id,object_key,width,height,is_representative,position,status)
       SELECT 'catalog-fill-' || r, 'media-fill-' || r || '-' || p,
         'editorial/' || encode(sha256(convert_to('c' || r, 'UTF8')), 'hex') || '/' || encode(sha256(convert_to('m' || r || '-' || p, 'UTF8')), 'hex') || '-' || encode(sha256(convert_to('b' || r || '-' || p, 'UTF8')), 'hex') || '.jpg',
         6000, 4000, p = 0, p, CASE WHEN r <= $1 THEN 'published' ELSE 'draft' END
       FROM generate_series(1, $1 + 100) AS r CROSS JOIN generate_series(0, $2 - 1) AS p`,
      [RECORDS, IMAGES_PER_RECORD],
    );
  }, SLOW);

  it("holds more published images than the old listing ceiling, which reads it as incomplete", async () => {
    const count = (
      await publicRead.query<{ n: number }>(
        "SELECT count(*)::integer AS n FROM catalog_media",
      )
    ).rows[0]!.n;
    expect(count).toBe(RECORDS * IMAGES_PER_RECORD + 7);
    expect(count).toBeGreaterThan(20_000);
    expect(count).toBeGreaterThan(CATALOG_SYNC_MAX_SOURCES);
    // The listing the read path used to take: null here, which every public
    // read answered as 503.
    expect(await listPublishedCatalogSources(publicRead)).toBeNull();
  });

  it("serves complete editorial renditions of exact published pairs with one CMS check per read", async () => {
    const { a, b, partial } = images;
    const { cms, prepare, adapter, authority } = reader();
    const live = await publishedCatalogPairs(cms.pool, [
      pairOf(a.image),
      pairOf(b.image),
      pairOf(partial.image),
      pairOf(a.image),
    ]);
    expect([...live].sort()).toEqual(
      [keyOf(a.image), keyOf(b.image), keyOf(partial.image)].sort(),
    );
    expect(cms.statements).toEqual([publishedCatalogPairsSql]);

    // Facts: each complete set, every planned role; the incomplete set is
    // omitted, so the editorial image is left out rather than its original.
    const projection = await facts(cms.pool, [
      pairOf(a.image),
      pairOf(b.image),
      pairOf(partial.image),
    ]);
    for (const { image, renditions } of [a, b])
      expect(
        projection
          .get(keyOf(image))
          ?.renditions?.map(({ key }) => key)
          .sort(),
      ).toEqual(renditions);
    expect(projection.has(keyOf(partial.image))).toBe(false);
    expect(a.renditions).toHaveLength(
      catalogExpectedRenditions(a.image.width, a.image.height).length,
    );

    // URLs: one App lookup of the assets, one exact CMS check of their pairs.
    cms.statements.length = 0;
    const urls = await adapter.lookupPublishedCatalog(
      [...a.renditions, ...b.renditions],
      at(3),
    );
    expect([...urls.keys()].sort()).toEqual(
      [...a.renditions, ...b.renditions].sort(),
    );
    for (const key of urls.values()) expect(key).toMatch(/^v1\//);
    expect(cms.statements).toEqual([publishedCatalogPairsSql]);

    const unknown = `catalog-asset-${md5(`media-fill-1-0:${hex()}`)}`;
    expect(
      await authority.publishedAssetIds([
        b.image.assetId,
        unknown,
        a.image.assetId,
      ]),
    ).toEqual([b.image.assetId, a.image.assetId]);
    // No asset, no read.
    cms.statements.length = 0;
    expect(await authority.publishedAssetIds([])).toEqual([]);
    expect(await adapter.lookupPublishedCatalog([], at(3))).toEqual(new Map());
    expect(cms.statements).toEqual([]);
    untouched(prepare);
  });

  it("drops a pair deleted from the projection while its App publication is still published", async () => {
    const { gone } = images;
    const { cms, prepare, adapter, authority } = reader();
    expect(
      (await adapter.lookupPublishedCatalog(gone.renditions, at(4))).size,
    ).toBe(gone.renditions.length);
    expect(
      (await facts(cms.pool, [pairOf(gone.image)])).has(keyOf(gone.image)),
    ).toBe(true);
    await setup.query(
      "DELETE FROM public.cms_catalog_media WHERE media_id=$1",
      [gone.image.mediaId],
    );
    // The App still holds its published generations; no sync has run.
    expect(await publishedGenerations(gone.image.assetId)).toEqual(
      gone.renditions,
    );
    expect(await publishedCatalogPairs(cms.pool, [pairOf(gone.image)])).toEqual(
      new Set(),
    );
    expect(await besideLive(cms.pool, pairOf(gone.image))).toEqual([
      keyOf(images.a.image),
    ]);
    expect(
      await adapter.lookupPublishedCatalog(gone.renditions, at(5)),
    ).toEqual(new Map());
    expect(await authority.publishedAssetIds([gone.image.assetId])).toEqual([]);
    untouched(prepare);
  });

  it("never serves a draft-only pair, nor one only a prepared intent names", async () => {
    const { draft, prepared } = images;
    const { cms, prepare, adapter, authority } = reader();
    // Both resolve until the change, as the deleted pair did.
    for (const { image, renditions } of [draft, prepared]) {
      expect(
        (await adapter.lookupPublishedCatalog(renditions, at(6))).size,
      ).toBe(renditions.length);
      expect((await facts(cms.pool, [pairOf(image)])).has(keyOf(image))).toBe(
        true,
      );
    }
    // The record went back to draft: its media row is still in the CMS.
    await setup.query(
      "UPDATE public.cms_catalog_media SET status='draft' WHERE media_id=$1",
      [draft.image.mediaId],
    );
    // Only a live private intent names this pair now.
    await setup.query(
      "DELETE FROM public.cms_catalog_media WHERE media_id=$1",
      [prepared.image.mediaId],
    );
    for (const state of ["prepared", "release_requested"])
      await setup.query(
        "INSERT INTO public.catalog_delivery_prepare_media(intent_id,state,expires_at,media_ordinal,media_id,object_key) VALUES($1,$2,$3,1,$4,$5)",
        [
          randomUUID(),
          state,
          new Date(Date.now() + 24 * 60 * 60 * 1000),
          prepared.image.mediaId,
          prepared.image.objectKey,
        ],
      );
    for (const { image, renditions } of [draft, prepared]) {
      expect(await publishedGenerations(image.assetId)).toEqual(renditions);
      expect(await publishedCatalogPairs(cms.pool, [pairOf(image)])).toEqual(
        new Set(),
      );
      expect(await besideLive(cms.pool, pairOf(image))).toEqual([
        keyOf(images.a.image),
      ]);
      expect(await adapter.lookupPublishedCatalog(renditions, at(6))).toEqual(
        new Map(),
      );
      expect(await authority.publishedAssetIds([image.assetId])).toEqual([]);
    }
    untouched(prepare);
  });

  it("never serves the old object key after the media's key changed", async () => {
    const { a, swap } = images;
    const { cms, prepare, adapter, authority } = reader();
    // It resolves until the key changes.
    expect(
      (await adapter.lookupPublishedCatalog(swap.renditions, at(7))).size,
    ).toBe(swap.renditions.length);
    expect(
      (await facts(cms.pool, [pairOf(swap.image)])).has(keyOf(swap.image)),
    ).toBe(true);
    const replacement = editorialKey(swap.image.mediaId, "v2");
    await setup.query(
      "UPDATE public.cms_catalog_media SET object_key=$2 WHERE media_id=$1",
      [swap.image.mediaId, replacement],
    );
    // (swap media id, new key) is published and matches both bound arrays,
    // but nobody asked for it: the old pair and a crossed pair stay dark.
    expect(
      await publishedCatalogPairs(cms.pool, [
        pairOf(swap.image),
        { mediaId: a.image.mediaId, objectKey: replacement },
      ]),
    ).toEqual(new Set());
    expect(await besideLive(cms.pool, pairOf(swap.image))).toEqual([
      keyOf(a.image),
    ]);
    expect(
      await adapter.lookupPublishedCatalog(swap.renditions, at(7)),
    ).toEqual(new Map());
    expect(await authority.publishedAssetIds([swap.image.assetId])).toEqual([]);
    // The new pair is live, but no App asset has rendered it yet: no facts,
    // so its editorial image stays omitted until its set is complete.
    const current = { mediaId: swap.image.mediaId, objectKey: replacement };
    expect([...(await publishedCatalogPairs(cms.pool, [current]))]).toEqual([
      keyOf(current),
    ]);
    expect((await facts(cms.pool, [current])).size).toBe(0);
    // Everything else still resolves.
    expect(
      (await adapter.lookupPublishedCatalog(a.renditions, at(7))).size,
    ).toBe(a.renditions.length);
    untouched(prepare);
  });

  // The public routes over the composed lookups at this size (R1, R5): the
  // runtime, read services and contract mappers are the real ones; only the
  // CMS record reads (Catalog, feed and Article records, which this stub CMS
  // does not hold) are fixtures. They name every image above with the pair it
  // had before its withdrawal, as a record read that raced the change would,
  // plus published images no App asset has rendered.
  it("answers composed Catalog, feed and Article reads with complete renditions of live pairs only", async () => {
    const { a, b, partial, gone, draft, prepared, swap } = images;
    const { cms, prepare, adapter } = reader();
    const origin = "https://published.synthetic.test";
    const now = at(8);
    const signed: unknown[] = [];
    const resolver: StorageUrlResolver = {
      resolveMany: async (locators) => {
        signed.push(...locators);
        return new Map();
      },
      catalogFacts: createCatalogDeliveryFacts(cms.pool, app),
      resolveKeys: async (keys) =>
        new Map(
          [...(await adapter.lookupPublishedCatalog(keys, now))].map(
            ([key, objectKey]) => [key, `${origin}/${objectKey}`],
          ),
        ),
    };
    const unrendered = (
      await setup.query<Omit<Image, "assetId">>(
        `SELECT media_id AS "mediaId", object_key AS "objectKey", width::integer AS width, height::integer AS height
         FROM public.cms_catalog_media WHERE catalog_id='catalog-fill-1' ORDER BY position`,
      )
    ).rows;
    expect(unrendered).toHaveLength(IMAGES_PER_RECORD);
    const shown = [
      ...[a, b, partial, gone, draft, prepared, swap].map(({ image }) => image),
      ...unrendered,
    ];
    // Only a and b are live with a complete set: their own published
    // objects (read from the App tables, not through the read path) are the
    // only URLs any read may carry.
    const served = new Map<string, Set<string>>();
    for (const { image, renditions } of [a, b]) {
      const objects = (
        await setup.query<{ object_key: string }>(
          "SELECT object_key FROM community.media_publications WHERE state='published' AND rendition_id=ANY($1::text[])",
          [renditions],
        )
      ).rows.map(({ object_key }) => `${origin}/${object_key}`);
      expect(objects).toHaveLength(renditions.length);
      served.set(image.mediaId, new Set(objects));
    }
    const expectServed = (
      media:
        | {
            readonly id: string;
            readonly src: string;
            readonly renditions?:
              readonly { readonly src: string }[] | undefined;
          }
        | null
        | undefined,
    ) => {
      if (!media) return null;
      const urls = served.get(media.id);
      expect(urls, media.id).toBeDefined();
      expect(media.renditions?.length, media.id).toBeGreaterThan(0);
      for (const src of [media.src, ...media.renditions!.map((r) => r.src)])
        expect(urls!.has(src), src).toBe(true);
      return media.id;
    };

    const mediaOf = (
      image: Omit<Image, "assetId">,
      position: number,
    ): CatalogMediaProjection => ({
      id: image.mediaId as MediaId,
      position,
      isRepresentative: position === 0,
      kind: "image",
      alt: "Synthetic image",
      width: image.width,
      height: image.height,
      objectKey: image.objectKey,
    });
    const recordId = (n: number) => `catalog-scale-${n}` as CatalogId;
    const media = shown.map(mediaOf);
    const catalogQueryPort: CatalogQueryPort = {
      getById: async (id) =>
        id === recordId(0)
          ? {
              id,
              kind: "inscription",
              title: "Synthetic scale record",
              aliases: [],
              sourceCitations: [],
              representativeMedia: media[0]!,
              media,
            }
          : null,
      list: async ({ page, pageSize }) => ({
        items: shown.map((image, n) => ({
          id: recordId(n),
          kind: "inscription",
          title: `Synthetic record ${n}`,
          aliases: [],
          representativeMedia: mediaOf(image, 0),
        })),
        total: shown.length,
        page,
        pageSize,
        totalPages: 1,
      }),
    };
    const cards: DiscoveryCardRecord[] = shown.map((image, n) => ({
      target: { type: "catalog", id: recordId(n) },
      title: `Synthetic record ${n}`,
      aliases: [],
      kind: "inscription",
      authorId: null,
      firstPublishedAt: t0.toISOString(),
      media: {
        type: "catalog",
        id: image.mediaId as MediaId,
        objectKey: image.objectKey,
        width: image.width,
        height: image.height,
      },
    }));
    const discoveryPort: Pick<CommunityDiscoveryPort, "browse"> = {
      browse: async () => ({
        items: cards,
        sequence: randomUUID(),
        nextAfter: cards.length,
        hasMore: false,
      }),
    };
    const editorialMedia = (
      image: Omit<Image, "assetId">,
    ): EditorialMediaRecord => ({
      id: image.mediaId as MediaId,
      objectKey: image.objectKey,
      alt: "Synthetic image",
      width: image.width,
      height: image.height,
    });
    const article = (
      id: ArticleId,
      cover: Omit<Image, "assetId">,
    ): ArticleDetailRecord => ({
      id,
      presentation: "academic",
      title: "Synthetic Article",
      subtitle: null,
      summary: null,
      section: null,
      issue: null,
      byline: "Synthetic desk",
      cover: editorialMedia(cover),
      firstPublishedAt: t0.toISOString(),
      publishedAt: t0.toISOString(),
      updatedAt: t0.toISOString(),
      intro: null,
      sections: shown.map((image) => ({
        heading: null,
        body: "Synthetic paragraph.",
        image: editorialMedia(image),
        imageCaption: null,
      })),
      citations: [],
    });
    const articles = [
      article(`article-${"a".repeat(32)}` as ArticleId, a.image),
      article(`article-${"b".repeat(32)}` as ArticleId, gone.image),
    ];
    const editorialContentPort: EditorialContentReadPort = {
      listArticles: async (query) => ({
        items: articles,
        total: articles.length,
        page: query.page,
        pageSize: query.pageSize,
      }),
      findArticle: async (id) =>
        articles.find((record) => record.id === id) ?? null,
      isArticlePublished: async (id) =>
        articles.some((record) => record.id === id),
      listCollections: async (query) => ({
        items: [],
        total: 0,
        page: query.page,
        pageSize: query.pageSize,
      }),
      findCollection: async () => null,
    };
    const handle = await startBackendProcess({
      listen: { host: "127.0.0.1", port: 0 },
      requestListener: createBackendApplication({
        nodeEnv: "production",
        catalogQueryPort,
        storageUrlResolver: resolver,
        communityIdentityPort: new InMemoryCommunityIdentityPort(),
        // Card and editorial reads never touch the author port.
        authorCommunityPort: {} as unknown as AuthorCommunityPort,
        discoveryPort: discoveryPort as CommunityDiscoveryPort,
        editorialContentPort,
      }),
    });
    try {
      const base = `http://${handle.address.address}:${handle.address.port}`;
      const read = async (path: string) => {
        const response = await fetch(`${base}${path}`);
        const text = await response.text();
        expect(response.status, `${path}: ${text}`).toBe(200);
        expect(text, path).not.toContain("editorial/");
        return JSON.parse(text) as unknown;
      };
      const live = [a.image.mediaId, b.image.mediaId];

      const list = catalogPageSchema.parse(await read("/v1/catalog"));
      expect(
        list.items.flatMap(
          ({ representativeMedia }) => expectServed(representativeMedia) ?? [],
        ),
      ).toEqual(live);
      const detail = catalogDetailSchema.parse(
        await read(`/v1/catalog/${recordId(0)}`),
      );
      expect(expectServed(detail.representativeMedia)).toBe(a.image.mediaId);
      expect(detail.media.map(expectServed)).toEqual(live);

      const feed = discoveryPageSchema.parse(
        await read("/v1/community/discover"),
      );
      expect(feed.items).toHaveLength(cards.length);
      expect(
        feed.items.flatMap(({ media }) => expectServed(media) ?? []),
      ).toEqual(live);

      const editorial = "/v1/community/editorial/articles";
      const page = articlePageSchema.parse(await read(editorial));
      expect(page.items.map(({ cover }) => expectServed(cover))).toEqual([
        a.image.mediaId,
        null,
      ]);
      const body = articleDetailSchema.parse(
        await read(`${editorial}/${articles[0]!.id}`),
      );
      expect(expectServed(body.cover)).toBe(a.image.mediaId);
      expect(
        body.sections.flatMap(({ image }) => expectServed(image) ?? []),
      ).toEqual(live);
    } finally {
      await handle.shutdown();
    }

    // No editorial original reached a signer; every CMS read was the exact
    // check, and none touched the prepare pool.
    expect(signed).toEqual([]);
    expect(cms.statements.length).toBeGreaterThan(0);
    for (const sql of cms.statements)
      expect(sql).toBe(publishedCatalogPairsSql);
    untouched(prepare);
  });
});

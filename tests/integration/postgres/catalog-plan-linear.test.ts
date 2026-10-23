import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import {
  catalogExpectedRenditions,
  catalogPlanReads,
  createCatalogPublicationAuthority,
  currentCatalogRecipePolicy,
  planCatalogPermissions,
  readCatalogSourceSnapshot,
} from "@moya/backend-production/internal/catalog-delivery";
import {
  createPostgresPool,
  parsePostgresConfig,
} from "@moya/catalog-postgres";
import {
  PostgresMediaPublicationAdapter,
  runCommunityMigrations,
} from "@moya/community-postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  previousCatalogPlan,
  previousCatalogPlanReads,
} from "../../unit/backend/catalog-plan-oracle.js";

import {
  assertSyntheticTestDatabaseUrl,
  requireSyntheticTestDatabaseUrl,
} from "./synthetic-test-database.js";

import type { CatalogAssetPermission } from "@moya/backend-production/internal/catalog-delivery";

/*
 * catalog-scale-v1 (Issue #323) 1B W1, on a dedicated synthetic database with
 * its own App role, so every App read and inspect runs with exactly the App
 * grants. Generated Catalogs, three rounds that each add images and intents
 * and change earlier ones: previous-recipe sets ready, released or superseded
 * by a re-render, published, withdrawn or never published; replacements
 * missing, ready or published; pairs published once, twice or taken down;
 * prepared, requested (live and expired), released and ended intents of the
 * current and an earlier recipe policy, mirrored by App or not, with pins.
 * After each round the grouped plan (planCatalogPermissions, through the
 * authority's own reads) gives every asset exactly the permissions the #320
 * plan gives it, and the authority's copy selector and each asset's captured
 * lease agree with it. The publication adapter then reconciles with a
 * selector beyond 40,000 IDs, bound as one parameter, and schedules exactly
 * what that selector implies. Content is synthetic; no object store, CMS or
 * network.
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
  throw new Error("Catalog plan tests require a loopback disposable target");
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
const HOUR = 3_600_000;
const hex = (bytes = 16) => randomBytes(bytes).toString("hex");
const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const md5 = (value: string) => createHash("md5").update(value).digest("hex");
const policy = currentCatalogRecipePolicy().recipeManifestSha256;
const EARLIER_POLICY = "e".repeat(64);
const PREVIOUS_DIGEST = "0".repeat(16);
const SIZES = [
  [4096, 2731],
  [1000, 800],
  [3000, 2000],
] as const;

const suffix = hex(6);
const database = `cs_plan_${suffix}_synthetic_test`;
const appRole = `cs_plan_app_${suffix}`;
let setup: Pool;
let app: Pool;
let created = { database: false, app: false };

beforeAll(async () => {
  const probe = await administration.query(guard.disposableTestTargetProbeSql);
  guard.assertDisposableTestTarget(
    probe.rows,
    assertSyntheticTestDatabaseUrl(targetUrl),
  );
  const appPassword = hex(32);
  await administration.query(
    `CREATE ROLE ${appRole} LOGIN PASSWORD '${appPassword}' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION NOINHERIT`,
  );
  created = { ...created, app: true };
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
  // The CMS stubs the grant scripts name, and the private prepare projection
  // with the columns the view has; the setup (owner) pool reads both CMS
  // projections, as the public and the prepare identities would.
  await setup.query(
    `CREATE TABLE public.catalog_entries(catalog_id text PRIMARY KEY,province text,province_state text);
     CREATE TABLE public.catalog_discovery(catalog_id text PRIMARY KEY,kind text,title text,aliases varchar[],first_published_at timestamptz,filter_metadata jsonb);
     CREATE TABLE public.article_entries(article_id text PRIMARY KEY,title text);
     CREATE TABLE public.catalog_media(catalog_id text,media_id text,object_key text,width integer,height integer,is_representative boolean,position integer NOT NULL DEFAULT 0);
     CREATE TABLE public.catalog_delivery_prepare_media(intent_id uuid NOT NULL,catalog_document_id integer NOT NULL,catalog_id text NOT NULL,draft_revision integer NOT NULL,draft_fingerprint text NOT NULL,media_manifest_sha256 text NOT NULL,recipe_manifest_sha256 text NOT NULL,state text NOT NULL,state_version integer NOT NULL,media_count integer NOT NULL,expires_at timestamptz NOT NULL,media_ordinal integer,media_id text,object_key text,source_sha256 text,width integer,height integer);
     -- The live projection the snapshot reads (W2); every stub intent is recent.
     CREATE VIEW public.catalog_delivery_live_prepare_media AS SELECT * FROM public.catalog_delivery_prepare_media`,
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
  app = poolFor(url({ role: appRole, password: appPassword }));
}, SLOW);

afterAll(async () => {
  await app?.end();
  await setup?.end();
  if (created.database)
    await administration.query(
      `DROP DATABASE IF EXISTS ${database} WITH (FORCE)`,
    );
  if (created.app) await administration.query(`DROP ROLE IF EXISTS ${appRole}`);
  await administration.end();
}, SLOW);

/** A small deterministic PRNG (mulberry32) for the shape of each round. */
const random = (seed: number) => {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
};

interface Image {
  readonly mediaId: string;
  readonly objectKey: string;
  readonly assetId: string;
  readonly bytes: string;
  readonly width: number;
  readonly height: number;
}
interface Rendition {
  readonly id: string;
  readonly role: string;
  readonly version: number;
  readonly digest: string;
  readonly storageKey: string;
  readonly sha256: string;
}

const images: Image[] = [];
/** Published generations by asset: role, rendition and publication. */
const generations = new Map<
  string,
  { role: string; rendition: Rendition; publication: string }[]
>();
const publicAssets = new Map<string, string>();
const catalogRows = new Map<string, string[]>();
const requested: string[] = [];
/** Images whose current recipe's set is wholly rendered (an intent naming
 * only these can be private-ready). */
const complete = new Set<Image>();

const insertImage = async (r: () => number, when: Date): Promise<Image> => {
  const mediaId = `media-${suffix}-${images.length + 1}`;
  const bytes = sha(`${mediaId}:bytes`);
  const objectKey =
    r() < 0.8
      ? `editorial/${sha(`catalog-${mediaId}`)}/${sha(`${mediaId}:orig`)}-${bytes}.jpg`
      : `display/v1/media_${md5(mediaId)}/${bytes}.webp`;
  const [width, height] = SIZES[Math.floor(r() * SIZES.length)]!;
  const image = {
    mediaId,
    objectKey,
    assetId: `catalog-asset-${md5(`${mediaId}:${objectKey}`)}`,
    bytes,
    width,
    height,
  };
  await setup.query(
    `INSERT INTO community.catalog_media_assets(id,media_id,source_object_key,source_sha256,source_width,source_height,source_content_type,master_sha256,master_width,master_height,state,created_at,updated_at)
     VALUES($1,$2,$3,$4,$5,$6,'image/jpeg',$4,$5,$6,'ready',$7,$7)`,
    [image.assetId, mediaId, objectKey, bytes, width, height, when],
  );
  images.push(image);
  return image;
};

const render = async (
  image: Image,
  want: ReturnType<typeof catalogExpectedRenditions>[number],
  digest: string,
  when: Date,
): Promise<Rendition> => {
  const blob = `media-blob-${hex()}`;
  const key = hex();
  const storageKey = `blobs/${key.slice(0, 2)}/${key.slice(2, 4)}/${key}`;
  await setup.query(
    "INSERT INTO community.media_blobs(id,owner_id,purpose,storage_key,byte_size,sha256,content_type,created_at) VALUES($1,NULL,'catalog_derivative',$2,1000,$3,'image/webp',$4)",
    [blob, storageKey, sha(blob), when],
  );
  const id = `media-rendition-${hex()}`;
  await setup.query(
    "INSERT INTO community.media_renditions(id,catalog_asset_id,edit_key,role,recipe_version,recipe_digest,blob_id,width,height,content_type,created_at) VALUES($1,$2,'base',$3,$4,$5,$6,$7,$8,'image/webp',$9)",
    [
      id,
      image.assetId,
      want.role,
      want.version,
      digest,
      blob,
      want.width,
      want.height,
      when,
    ],
  );
  return {
    id,
    role: want.role,
    version: want.version,
    digest,
    storageKey,
    sha256: sha(blob),
  };
};

/** Publishes a ready rendition (a committed generation); a withdrawn one is
 * then withdrawn and verified gone. */
const publish = async (
  image: Image,
  rendition: Rendition,
  when: Date,
  withdrawn = false,
) => {
  let publicId = publicAssets.get(image.assetId);
  if (!publicId) {
    publicId = hex();
    await setup.query(
      "INSERT INTO community.media_public_assets(id,catalog_asset_id,desired_at,created_at,updated_at) VALUES($1,$2,$3,$3,$3)",
      [publicId, image.assetId, when],
    );
    publicAssets.set(image.assetId, publicId);
  }
  const id = `media-publication-${hex()}`;
  const token = hex();
  await setup.query(
    `INSERT INTO community.media_publications(id,public_asset_id,rendition_id,generation_token,object_key,storage_key,content_type,purpose,byte_size,sha256,role,edit_key,state,published_at,created_at)
     VALUES($1,$2,$3,$4,$5,$6,'image/webp','catalog_derivative',1000,$7,$8,'base','published',$9,$9)`,
    [
      id,
      publicId,
      rendition.id,
      token,
      `v1/${publicId}/${token}/base/${rendition.role}.r${rendition.version}.webp`,
      rendition.storageKey,
      rendition.sha256,
      rendition.role,
      when,
    ],
  );
  if (withdrawn) {
    await setup.query(
      "UPDATE community.media_publications SET state='withdrawing',withdraw_requested_at=$2,version=version+1 WHERE id=$1",
      [id, when],
    );
    await setup.query(
      "UPDATE community.media_publications SET state='withdrawn',origin_deleted_at=$2,verified_at=$2,version=version+1 WHERE id=$1",
      [id, when],
    );
    return;
  }
  const list = generations.get(image.assetId) ?? [];
  list.push({ role: rendition.role, rendition, publication: id });
  generations.set(image.assetId, list);
};

/** A re-render recorded its replacement: the slot's rendition leaves it. */
const retire = async (rendition: Rendition, released: boolean, when: Date) =>
  setup.query(
    released
      ? "UPDATE community.media_renditions SET state='released',superseded_at=$2,released_at=$2 WHERE id=$1"
      : "UPDATE community.media_renditions SET state='superseded',superseded_at=$2 WHERE id=$1",
    [rendition.id, when],
  );

const list = async (image: Image) => {
  const catalogId = `catalog-${hex(8)}`;
  await setup.query(
    "INSERT INTO public.catalog_media(catalog_id,media_id,object_key,width,height,is_representative,position) VALUES($1,$2,$3,$4,$5,true,0)",
    [catalogId, image.mediaId, image.objectKey, image.width, image.height],
  );
  catalogRows.set(image.assetId, [
    ...(catalogRows.get(image.assetId) ?? []),
    catalogId,
  ]);
};

/** One image through one shape of a recipe bump, listed or not. */
const generateImage = async (r: () => number, when: Date) => {
  const image = await insertImage(r, when);
  const shape = ["previous", "bumping", "finished", "current", "unrendered"][
    Math.floor(r() * 5)
  ]!;
  let whole = shape !== "previous" && shape !== "unrendered";
  for (const want of catalogExpectedRenditions(image.width, image.height)) {
    if (shape === "unrendered" || r() < 0.1) {
      whole = false;
      continue;
    }
    if (shape !== "current") {
      const previous = await render(image, want, PREVIOUS_DIGEST, when);
      const fate = shape === "finished" ? 0 : r();
      if (fate < 0.6) await publish(image, previous, when);
      else if (fate < 0.75) await publish(image, previous, when, true);
      if (shape === "previous") continue;
      await retire(previous, r() < 0.7, when);
    }
    const replacement = await render(image, want, want.digest, when);
    if (shape === "finished" || r() < 0.5)
      await publish(image, replacement, when);
  }
  if (r() < 0.65) {
    await list(image);
    if (r() < 0.15) await list(image);
  }
  if (whole) complete.add(image);
  return image;
};

/** One intent in the CMS projection (a header row alone when it has ended or
 * names nothing), and (unless App has not seen it yet) its App mirror; a
 * released intent of the earlier policy pins one published generation per
 * role of its members. */
const generateIntent = async (
  r: () => number,
  members: readonly Image[],
  when: Date,
  fixed?: { readonly state: "released"; readonly recipe: string },
) => {
  const intentId = randomUUID();
  const documentId = 1 + Math.floor(r() * 5);
  const state =
    fixed?.state ??
    (
      [
        "prepared",
        "release_requested",
        "release_requested",
        "released",
        "released",
        "cancelled",
        "withdrawn",
      ] as const
    )[Math.floor(r() * 7)]!;
  const live = ["prepared", "release_requested", "released"].includes(state);
  const recipe = fixed?.recipe ?? (r() < 0.75 ? policy : EARLIER_POLICY);
  const expiresAt = new Date(Date.now() + (r() < 0.75 ? 6 : -6) * HOUR);
  const manifest = sha(`${intentId}:manifest`);
  const header = [
    intentId,
    documentId,
    `catalog-document-${documentId}`,
    1,
    "a".repeat(64),
    manifest,
    recipe,
    state,
    1 + Math.floor(r() * 3),
    live ? members.length : 0,
    expiresAt,
  ];
  if (live && members.length)
    for (const [i, m] of members.entries())
      await setup.query(
        "INSERT INTO public.catalog_delivery_prepare_media VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)",
        [...header, i + 1, m.mediaId, m.objectKey, m.bytes, m.width, m.height],
      );
  else
    await setup.query(
      "INSERT INTO public.catalog_delivery_prepare_media VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,NULL,NULL,NULL,NULL,NULL,NULL)",
      header,
    );
  if (state === "release_requested") requested.push(intentId);
  if (r() < 0.2) return;
  await setup.query(
    `INSERT INTO community.catalog_delivery_prepares(intent_id,cms_document_id,catalog_id,draft_revision,draft_fingerprint,manifest_sha256,recipe_manifest_sha256,media_count,source_state,source_state_version,expires_at,observed_at,observed_live,ended_at,created_at,updated_at)
     VALUES($1,$2,$3,1,$4,$5,$6,$7,$8,$9,$10,$11,true,$12,$11,$11)`,
    [
      intentId,
      documentId,
      `catalog-document-${documentId}`,
      "a".repeat(64),
      manifest,
      recipe,
      header[9],
      state,
      header[8],
      expiresAt,
      when,
      live ? null : when,
    ],
  );
  if (!live) return;
  for (const [i, m] of members.entries())
    await setup.query(
      "INSERT INTO community.catalog_delivery_media_refs(intent_id,ordinal,media_id,object_key,source_sha256,width,height) VALUES($1,$2,$3,$4,$5,$6,$7)",
      [intentId, i + 1, m.mediaId, m.objectKey, m.bytes, m.width, m.height],
    );
  if (recipe === policy || state !== "released") return;
  for (const [i, m] of members.entries()) {
    const pinned = new Set<string>();
    for (const g of generations.get(m.assetId) ?? []) {
      if (pinned.has(g.role)) continue;
      pinned.add(g.role);
      await setup.query(
        "INSERT INTO community.catalog_delivery_rendition_pins(intent_id,ordinal,role,rendition_id,recipe_version,recipe_digest,public_generation_id,public_generation_version,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,1,$8)",
        [
          intentId,
          i + 1,
          g.role,
          g.rendition.id,
          g.rendition.version,
          g.rendition.digest,
          g.publication,
          when,
        ],
      );
    }
  }
};

/** Permissions by asset, renditions sorted (the selector rows come in the
 * database's order), each asset's in order and an exact repeat dropped. */
const byAsset = (permissions: readonly CatalogAssetPermission[]) => {
  const assets = new Map<string, string[]>();
  for (const permission of permissions) {
    const list = assets.get(permission.assetId) ?? [];
    const json = JSON.stringify({
      ...permission,
      renditionIds: [...permission.renditionIds].sort(),
    });
    if (!list.includes(json)) list.push(json);
    assets.set(permission.assetId, list);
  }
  return new Map(
    [...assets].map(([id, list]) => [
      id,
      list.map((json) => JSON.parse(json) as CatalogAssetPermission),
    ]),
  );
};
const copySet = (permissions: readonly CatalogAssetPermission[]) =>
  [...new Set(permissions.flatMap((p) => p.renditionIds))].sort();

describe("W1: the grouped plan equals the #320 plan on a real Catalog", () => {
  it(
    "plans every asset as before, round after round, through the authority",
    { timeout: SLOW },
    async () => {
      const r = random(323);
      const reached = { privateB: 0, intentPublic: 0, earlier: 0, gated: 0 };
      for (let round = 0; round < 3; round += 1) {
        const when = new Date();
        const added: Image[] = [];
        for (let n = 0; n < 24; n += 1)
          added.push(await generateImage(r, when));
        for (let n = 0; n < 8; n += 1) {
          // Mostly wholly rendered members, so that intents are ready.
          const whole = added.filter((image) => complete.has(image));
          const members = new Set<Image>();
          for (let k = Math.floor(r() * 4); k > 0; k -= 1) {
            const from = whole.length && r() < 0.8 ? whole : added;
            members.add(from[Math.floor(r() * from.length)]!);
          }
          await generateIntent(r, [...members], when);
        }
        // A record released under the earlier recipe policy, still listed
        // with its pinned generations published.
        await generateIntent(
          r,
          added
            .filter(
              (i) => catalogRows.has(i.assetId) && generations.has(i.assetId),
            )
            .slice(0, 2),
          when,
          { state: "released", recipe: EARLIER_POLICY },
        );
        if (round > 0) {
          // Earlier rounds move on: some records are taken down and some
          // requests expire.
          for (const [assetId, ids] of catalogRows)
            if (r() < 0.2) {
              await setup.query(
                "DELETE FROM public.catalog_media WHERE catalog_id=ANY($1::text[])",
                [ids],
              );
              catalogRows.delete(assetId);
            }
          for (const intentId of requested.splice(0))
            if (r() < 0.3)
              await setup.query(
                "UPDATE public.catalog_delivery_prepare_media SET expires_at=$2 WHERE intent_id=$1",
                [intentId, new Date(Date.now() - HOUR)],
              );
        }

        const snapshot = await readCatalogSourceSnapshot(setup, setup);
        if (!snapshot) throw new Error("snapshot unavailable");
        const now = Date.now();
        const expected = await previousCatalogPlan(
          snapshot,
          previousCatalogPlanReads(app, policy),
          policy,
          now,
        );
        const actual = await planCatalogPermissions(
          snapshot,
          catalogPlanReads(app, policy),
          policy,
          now,
        );
        expect(byAsset(actual), `round ${round}`).toEqual(byAsset(expected));

        const authority = createCatalogPublicationAuthority(setup, setup, app);
        expect(await authority.copyRenditionIds()).toHaveLength(
          copySet(expected).length,
        );
        expect([...(await authority.copyRenditionIds())].sort()).toEqual(
          copySet(expected),
        );
        const planned = byAsset(expected);
        for (const image of images) {
          const lease = await authority.acquire(image.assetId);
          try {
            expect([...lease.renditionIds].sort(), image.assetId).toEqual(
              copySet(planned.get(image.assetId) ?? []),
            );
          } finally {
            await lease.release();
          }
          // A pair that is not listed has no live public permission.
          if (!catalogRows.has(image.assetId)) {
            expect(
              (planned.get(image.assetId) ?? []).filter(
                (p) => p.documentId === null || p.published,
              ),
            ).toEqual([]);
            reached.gated += (generations.get(image.assetId) ?? []).length
              ? 1
              : 0;
          }
        }
        reached.privateB += actual.filter((p) => p.intentId !== null).length;
        reached.intentPublic += actual.filter(
          (p) => p.intentId === null && p.policy === policy,
        ).length;
        reached.earlier += actual.filter(
          (p) => p.policy === EARLIER_POLICY && p.renditionIds.length > 0,
        ).length;
      }
      // The rounds reach private B, released intents of both policies (the
      // earlier one with its pinned generations) and published images that
      // are no longer listed.
      for (const [kind, count] of Object.entries(reached))
        expect(count, kind).toBeGreaterThan(0);
    },
  );

  it(
    "reconciles with a selector beyond 40,000 IDs, bound as one parameter",
    { timeout: SLOW },
    async () => {
      const authority = createCatalogPublicationAuthority(setup, setup, app);
      const selected = await authority.copyRenditionIds();
      // Well-formed IDs of no rendition: they select nothing, but the inline
      // literal selector refused more than 40,000 IDs. They go first, so a
      // bind that kept only the first 40,000 IDs would lose the whole real
      // selection and change both counts.
      const padding = Array.from(
        { length: 40_001 },
        (_, i) => `media-rendition-${i.toString(16).padStart(32, "f")}`,
      );
      const want = async (sql: string) =>
        (await setup.query<{ subject: string }>(sql, [selected])).rows
          .map((row) => row.subject)
          .sort();
      const publish = await want(
        "SELECT DISTINCT r.catalog_asset_id AS subject FROM community.media_renditions r WHERE r.id=ANY($1::text[]) AND NOT EXISTS (SELECT 1 FROM community.media_publications p WHERE p.rendition_id=r.id AND p.state IN ('publishing','published'))",
      );
      const withdraw = await want(
        "SELECT DISTINCT a.catalog_asset_id AS subject FROM community.media_public_assets a JOIN community.media_publications p ON p.public_asset_id=a.id WHERE a.catalog_asset_id IS NOT NULL AND p.state IN ('publishing','published') AND NOT (p.rendition_id=ANY($1::text[]))",
      );
      expect(publish.length).toBeGreaterThan(0);
      expect(withdraw.length).toBeGreaterThan(0);
      const adapter = new PostgresMediaPublicationAdapter(app, {
        isPublic: () => true,
        allowPublish: () => true,
        catalogAuthority: {
          ...authority,
          copyRenditionIds: async () => [...padding, ...selected],
        },
      });
      expect(await adapter.reconcile(new Date(), true, 500)).toEqual({
        publish: publish.length,
        withdraw: withdraw.length,
      });
      expect(
        (
          await setup.query<{ subject_id: string }>(
            "SELECT DISTINCT subject_id FROM community.publishing_jobs WHERE kind='publish_media' AND state='queued' ORDER BY subject_id",
          )
        ).rows.map((row) => row.subject_id),
      ).toEqual(publish);
      // The item lookup binds its empty Catalog selection the same way.
      expect(
        await adapter.lookupPublishedItems([`media-item-${hex()}`], new Date()),
      ).toEqual(new Map());
    },
  );
});

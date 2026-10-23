import {
  captureCatalogAssets,
  catalogLiveIntentRowsSql,
  catalogPlanReads,
  createCatalogPublicationAuthority,
  currentCatalogRecipePolicy,
  planCatalogPermissions,
  readCatalogSourceSnapshot,
} from "@moya/backend-production/internal/catalog-delivery";
import {
  listPublishedCatalogSourcesSql,
  publishedCatalogPairsSql,
} from "@moya/backend-production/internal/publishing-catalog";
import {
  createPostgresPool,
  parsePostgresConfig,
} from "@moya/catalog-postgres";
import { PostgresMediaPublicationAdapter } from "@moya/community-postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  catalogAuthorityWithCopySet,
  wholeCatalogCopySet,
} from "../../unit/backend/catalog-copy-set.js";
import {
  CATALOG_SCALE_25K,
  catalogScaleCounts,
  catalogScaleImage,
  catalogScaleShape,
  clearCatalogScale,
  createCatalogScaleDatabase,
  createQueryRecorder,
  explainCatalogScale,
  seedCatalogScale,
  type CatalogScaleDatabase,
  type CatalogScaleShape,
  type RecordedQuery,
} from "./catalog-scale-fixture.js";
import { requireSyntheticTestDatabaseUrl } from "./synthetic-test-database.js";

import type { CatalogAssetPermission } from "@moya/backend-production/internal/catalog-delivery";

/*
 * catalog-scale-v1 (Issue #323) 1B W5 on the scale fixture: a Catalog job's
 * authority reads only its own asset, through the real roles and views.
 * - acquire, current() and authorized() issue the same statements, per role,
 *   at a small and a larger Catalog (1k and 5k images here; set
 *   MOYA_CATALOG_SCALE_AUTHORITY_IMAGES=25200 for the issue's 25k fixture),
 *   for a released record's image, a published image without an intent and
 *   a requested draft image; none lists the published Catalog or reads a
 *   private view beyond the asset's App-known intents, by primary key;
 * - their statements, inspectCatalogDelivery's included, use the indexes
 *   (no Seq Scan on the relations they key, but inspect's bounded media
 *   lock; its publications read uses A1's media_publications_rendition) at
 *   plan costs far below JIT's threshold;
 * - the batched capture of every asset equals the whole-Catalog plan, asset
 *   by asset, when App knows every intent (as the seeded mirror does);
 * - reconcile completes past the 40,000 selector rows #320 refused, and is a
 *   fixed point there.
 * Content is synthetic; no object store, real CMS or network.
 */

const SLOW = 600_000;
// The suite's disposable target, refused before any connection.
const target = requireSyntheticTestDatabaseUrl();
let fixture: CatalogScaleDatabase;

const SMALL = catalogScaleShape(1_001);
const LARGE: CatalogScaleShape =
  process.env.MOYA_CATALOG_SCALE_AUTHORITY_IMAGES === "25200"
    ? CATALOG_SCALE_25K
    : catalogScaleShape(
        Number(process.env.MOYA_CATALOG_SCALE_AUTHORITY_IMAGES ?? 5_005),
      );
const policy = currentCatalogRecipePolicy().recipeManifestSha256;
/** The Seq Scan a job's acquire may plan, inspectCatalogDelivery's, by
 * statement (whitespace collapsed): its sorted media lock joins the intent's
 * media as a recordset the planner sizes at 100 rows: on a small Catalog a
 * scan of the assets costs less than 100 identity probes (about 450 at 5k
 * images), from about 10k the probes win (about 820 at 25k,
 * catalog_media_assets_identity_unique), so its cost stays bounded at any
 * size. Its read of a pinned rendition's publications by rendition_id, once
 * per pinned role, scanned every publication ever made (about 8,000 and 7 ms
 * at 25k) until App migration A1 indexed rendition_id
 * (media_publications_rendition, keyed below): the partial live index holds
 * only the publishing and published rows. */
const INSPECT_SEQ_SCANS: readonly (readonly [string, string])[] = [
  [
    "SELECT a.id FROM community.catalog_media_assets a JOIN jsonb_to_recordset(",
    "catalog_media_assets",
  ],
];
/** Relations whose rows grow with the Catalog or its history. */
const LARGE_RELATIONS = new Set([
  "catalogs",
  "catalogs_media",
  "catalog_delivery_intents",
  "catalog_media_assets",
  "catalog_delivery_prepares",
  "catalog_delivery_media_refs",
  "catalog_delivery_rendition_pins",
  "media_renditions",
  "media_blobs",
  "media_public_assets",
  "media_publications",
]);

beforeAll(async () => {
  fixture = await createCatalogScaleDatabase({
    target,
    openPool: (url) =>
      createPostgresPool(parsePostgresConfig({ DATABASE_URL: url })),
    label: "csauth",
  });
}, SLOW);

afterAll(async () => {
  await fixture?.close();
}, SLOW);

const reseed = async (shape: CatalogScaleShape) => {
  await clearCatalogScale(fixture);
  return seedCatalogScale(fixture, shape);
};

/** The three job subjects of a seeded shape: a released record's image, a
 * published image no intent names, and a requested draft image. */
const subjects = (shape: CatalogScaleShape) => {
  const counts = catalogScaleCounts(shape);
  return {
    released: catalogScaleImage(1, 1).assetId,
    plain: catalogScaleImage(counts.records, 1).assetId,
    requested: catalogScaleImage(counts.records + shape.requestedEvery, 1)
      .assetId,
  };
};

interface Measured {
  readonly statements: Record<string, number>;
  readonly connects: Record<string, number>;
  readonly queries: readonly RecordedQuery[];
}

/** One job's acquire, a fence check and an authorization, each counted. */
const job = async (assetId: string) => {
  const recorder = createQueryRecorder();
  const authority = createCatalogPublicationAuthority(
    recorder.wrap("cms", fixture.publicRead),
    recorder.wrap("prepare", fixture.prepare),
    recorder.wrap("app", fixture.app),
  );
  const take = (): Measured => {
    const { statements, connects } = recorder.counts();
    const queries = [...recorder.queries];
    recorder.reset();
    return { statements, connects, queries };
  };
  const lease = await authority.acquire(assetId);
  try {
    const acquire = take();
    const current = await lease.current();
    const fence = take();
    const authorized = await lease.authorized();
    const authorization = take();
    return {
      renditionIds: lease.renditionIds.length,
      current,
      authorized,
      ops: { acquire, current: fence, authorized: authorization },
    };
  } finally {
    await lease.release();
  }
};

const counted = (measured: Measured) => ({
  statements: measured.statements,
  connects: measured.connects,
});

describe(
  "catalog-scale-v1 W5: a job's authority at any Catalog size",
  { concurrent: false, shuffle: false },
  () => {
    const measured: Record<
      "small" | "large",
      Record<string, Awaited<ReturnType<typeof job>>>
    > = { small: {}, large: {} };

    it(
      "issues the same statements per role for one asset at a small and a larger Catalog",
      { timeout: SLOW },
      async () => {
        for (const [size, shape] of [
          ["small", SMALL],
          ["large", LARGE],
        ] as const) {
          await reseed(shape);
          for (const [name, assetId] of Object.entries(subjects(shape)))
            measured[size][name] = await job(assetId);
        }
        for (const name of ["released", "plain", "requested"]) {
          const small = measured.small[name]!;
          const large = measured.large[name]!;
          for (const op of ["acquire", "current", "authorized"] as const)
            expect(counted(large.ops[op]), `${name} ${op}`).toEqual(
              counted(small.ops[op]),
            );
          expect(large.renditionIds, name).toBe(small.renditionIds);
          expect(large.current, name).toBe(true);
          expect(large.authorized, name).toBe(small.authorized);
        }
        // A published image copies its current set (6000 x 4000: thumb,
        // cover, display and viewer); a requested draft whose asset is not
        // rendered yet is granted nothing.
        expect(measured.large.released!.renditionIds).toBe(4);
        expect(measured.large.plain!.renditionIds).toBe(4);
        expect(measured.large.requested!.renditionIds).toBe(0);
        expect(measured.large.released!.authorized).toBe(true);
        expect(measured.large.requested!.authorized).toBe(false);
        // The fence check is one private read by primary key, and the
        // authorization that read plus the exact pair check.
        expect(counted(measured.large.released!.ops.current)).toEqual({
          statements: { prepare: 1 },
          connects: {},
        });
        expect(counted(measured.large.released!.ops.authorized)).toEqual({
          statements: { prepare: 1, cms: 1 },
          connects: {},
        });
        // A published image whose App-known intents all ended reads no live
        // private row (their header rows are not read).
        expect(
          measured.large
            .plain!.ops.acquire.queries.filter(
              (q) => q.sql === catalogLiveIntentRowsSql,
            )
            .map((q) => q.rows),
        ).toEqual([0]);
        for (const size of ["small", "large"] as const)
          for (const [name, result] of Object.entries(measured[size]))
            for (const [op, ops] of Object.entries(result.ops))
              for (const query of ops.queries) {
                const label = `${size} ${name} ${op}: ${query.sql.slice(0, 80)}`;
                // Never the published listing, a cursor, or a private view
                // beyond the asset's App-known intents.
                expect(query.sql, label).not.toContain(
                  listPublishedCatalogSourcesSql,
                );
                expect(query.sql, label).not.toMatch(/^(DECLARE|FETCH)/u);
                if (
                  query.pool === "prepare" &&
                  query.sql.includes("catalog_delivery_live_prepare_media")
                )
                  expect(query.sql, label).toBe(catalogLiveIntentRowsSql);
                if (query.pool === "cms" && query.sql.includes("catalog_media"))
                  expect(query.sql, label).toBe(publishedCatalogPairsSql);
                expect(query.failed, label).toBe(false);
              }
      },
    );

    it(
      "keys every statement of a job's acquire (inspect's included), fence and authorization at the larger Catalog, far below JIT's cost",
      { timeout: SLOW },
      async () => {
        // The larger shape is the seed in place.
        const result = measured.large.released!;
        const statements = [
          ...result.ops.acquire.queries,
          ...result.ops.current.queries,
          ...result.ops.authorized.queries,
        ].filter(
          (q) =>
            /^SELECT /u.test(q.sql.trimStart()) &&
            !q.sql.startsWith("SELECT pg_"),
        );
        const pools = {
          app: fixture.app,
          cms: fixture.publicRead,
          prepare: fixture.prepare,
        } as const;
        const keyed: Record<string, readonly string[]> = {
          "SELECT id,media_id,source_object_key FROM community.catalog_media_assets":
            ["catalog_media_assets_pkey"],
          "SELECT DISTINCT asset_id,intent_id FROM community.catalog_delivery_media_refs":
            ["catalog_delivery_media_refs_asset"],
          [publishedCatalogPairsSql]: ["catalogs_media_media_id_lookup_idx"],
          [catalogLiveIntentRowsSql]: ["catalog_delivery_intents_pkey"],
          // inspect's, so the gate is seen to hold the released intent's.
          "SELECT r.id,r.role": ["media_renditions_catalog_asset_idx"],
          "SELECT * FROM community.catalog_delivery_rendition_pins WHERE intent_id=$1":
            ["catalog_delivery_rendition_pins_pkey"],
          // Every publication of a pinned rendition, history included.
          "SELECT p.* FROM community.media_publications p WHERE p.rendition_id=$1":
            ["media_publications_rendition"],
        };
        const seen = new Set<string>();
        const exempted = new Set<string>();
        for (const query of statements) {
          const plan = await explainCatalogScale(
            pools[query.pool as keyof typeof pools],
            query.sql,
            query.values ?? [],
            { analyze: true },
          );
          const label = `${query.pool}: ${query.sql.slice(0, 90)}`;
          // No relation that grows with the Catalog is scanned whole, but
          // inspect's bounded scan listed above; the bounds below hold every
          // statement, that one included.
          const sql = query.sql.replace(/\s+/gu, " ");
          const exempt = INSPECT_SEQ_SCANS.find(([prefix]) =>
            sql.startsWith(prefix),
          )?.[1];
          if (exempt) exempted.add(exempt);
          expect(
            plan.seqScans.filter(
              (relation) =>
                LARGE_RELATIONS.has(relation) && relation !== exempt,
            ),
            label,
          ).toEqual([]);
          expect(plan.totalCost!, label).toBeLessThan(10_000);
          expect(plan.jitMs, label).toBeNull();
          for (const [prefix, indexes] of Object.entries(keyed))
            if (query.sql.startsWith(prefix)) {
              seen.add(prefix);
              for (const index of indexes)
                expect(plan.indexes, label).toContain(index);
            }
        }
        expect(seen.size).toBe(Object.keys(keyed).length);
        // Each exemption names a statement the acquire issues: once inspect's
        // SQL changes, the exemption is revisited, not left behind.
        expect([...exempted].sort()).toEqual(
          INSPECT_SEQ_SCANS.map(([, relation]) => relation).sort(),
        );
      },
    );

    it(
      "captures every asset in one call exactly as the whole-Catalog plan plans it, when App knows every intent",
      { timeout: SLOW },
      async () => {
        await reseed(SMALL);
        const ids = (
          await fixture.setup.query<{ id: string }>(
            "SELECT id FROM community.catalog_media_assets ORDER BY id",
          )
        ).rows.map((row) => row.id);
        const reads = catalogPlanReads(fixture.app, policy);
        const now = Date.now();
        const snapshot = await readCatalogSourceSnapshot(
          fixture.publicRead,
          fixture.prepare,
        );
        if (!snapshot) throw new Error("snapshot unavailable");
        const whole = new Map<string, CatalogAssetPermission[]>();
        for (const permission of await planCatalogPermissions(
          snapshot,
          reads,
          policy,
          now,
        ))
          whole.set(permission.assetId, [
            ...(whole.get(permission.assetId) ?? []),
            permission,
          ]);
        const captured = await captureCatalogAssets(
          {
            published: fixture.publicRead,
            prepare: fixture.prepare,
            app: fixture.app,
          },
          ids,
          reads,
          policy,
          now,
        );
        let intentPermissions = 0;
        for (const id of ids) {
          expect(captured.get(id)!.permissions, id).toEqual(
            whole.get(id) ?? [],
          );
          intentPermissions += captured
            .get(id)!
            .permissions.filter((p) => p.documentId !== null).length;
        }
        // Every released record's image holds its intent's permission.
        expect(intentPermissions).toBe(catalogScaleCounts(SMALL).releasedMedia);
        expect(
          [
            ...new Set(
              [...captured.values()].flatMap((c) =>
                c.permissions.flatMap((p) => p.renditionIds),
              ),
            ),
          ].sort(),
        ).toEqual(
          [
            ...(await wholeCatalogCopySet(
              fixture.publicRead,
              fixture.prepare,
              fixture.app,
            )),
          ].sort(),
        );
      },
    );

    it(
      "reconciles past the 40,000 selector rows #320 refused, as a fixed point",
      { timeout: SLOW },
      async () => {
        // 10,003 published images and no intent: 40,012 selector rows, one
        // statement per batch of 250 assets.
        await reseed(
          catalogScaleShape(10_003, {
            draftRecords: 0,
            releasedIntents: 0,
            endedIntents: 0,
            recentEndedIntents: 0,
            livePrepares: 0,
          }),
        );
        const recorder = createQueryRecorder();
        const authority = catalogAuthorityWithCopySet(
          fixture.publicRead,
          fixture.prepare,
          recorder.wrap("app", fixture.app),
        );
        const ids = await authority.copyRenditionIds();
        expect(ids).toHaveLength(40_012);
        const selector = recorder.queries.filter((q) =>
          q.sql.startsWith("SELECT DISTINCT r.id"),
        );
        expect(selector).toHaveLength(Math.ceil(10_003 / 250));
        for (const q of selector) expect(q.sql).not.toContain("LIMIT");
        expect(
          await new PostgresMediaPublicationAdapter(fixture.app, {
            isPublic: () => true,
            allowPublish: () => true,
            catalogAuthority: authority,
          }).reconcile(new Date(), true, 500),
        ).toEqual({ publish: 0, withdraw: 0 });
        // A job beyond the old bound captures its own asset as anywhere.
        const lease = await authority.acquire(
          catalogScaleImage(1_429, 1).assetId,
        );
        try {
          expect(lease.renditionIds).toHaveLength(4);
          expect(await lease.authorized()).toBe(true);
        } finally {
          await lease.release();
        }
      },
    );
  },
);

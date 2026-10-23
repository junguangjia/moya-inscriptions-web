import { createHash } from "node:crypto";

import { createCatalogPublicationAuthority } from "@moya/backend-production/internal/catalog-delivery";
import {
  CATALOG_PUBLISHED_PAIRS_MAX,
  publishedCatalogPairs,
  publishedCatalogPairsSql,
} from "@moya/backend-production/internal/publishing-catalog";
import { PostgresMediaPublicationAdapter } from "@moya/community-postgres";
import { describe, expect, it, vi } from "vitest";

/*
 * catalog-scale-v1 (Issue #323) 1A: a public read checks only the exact
 * (media id, object key) pairs it shows against the live published Catalog
 * projection, on the public read pool. Nothing lists the whole Catalog, so a
 * read costs what its page shows, and the 10,000-image ceiling is gone; the
 * prepare pool is never touched. Synthetic metadata only; no database.
 */

type Row = Record<string, unknown>;
type Query = (sql: string, values?: readonly unknown[]) => Promise<Row[]>;

const md5 = (value: string) => createHash("md5").update(value).digest("hex");
const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const assetOf = (mediaId: string, objectKey: string) =>
  `catalog-asset-${md5(`${mediaId}:${objectKey}`)}`;
const keyOf = (pair: { mediaId: string; objectKey: string }) =>
  JSON.stringify([pair.mediaId, pair.objectKey]);
const editorial = (name: string) => ({
  mediaId: `media-${name}`,
  objectKey: `editorial/${sha(`catalog-${name}`)}/${sha(name)}-${sha(`bytes-${name}`)}.jpg`,
});

/** A pool double whose statements are recorded; `answer` gives the rows. */
const poolOf = (answer: Query) => {
  const query = vi.fn(async (sql: string, values?: readonly unknown[]) => ({
    rows: await answer(sql, values),
  }));
  const connect = vi.fn(async () => {
    throw new Error("UNEXPECTED_CONNECT");
  });
  return { query, connect };
};
type Pools = Parameters<typeof createCatalogPublicationAuthority>;

/**
 * The published projection as the CMS answers the restriction form: every
 * published row whose media id and object key are each in the bound arrays
 * (a cross product of them, as SQL would return it). An unbounded listing is
 * answered whole, as a Catalog larger than the old ceiling would be.
 */
const cmsOf = (published: readonly { mediaId: string; objectKey: string }[]) =>
  poolOf(async (sql, values) => {
    if (sql.includes("community.")) throw new Error("CMS_CROSS_DATABASE_READ");
    if (!sql.includes("FROM catalog_media")) throw new Error("UNEXPECTED_SQL");
    const [mediaIds, objectKeys] = (values ?? []) as unknown[];
    if (!Array.isArray(mediaIds) || !Array.isArray(objectKeys))
      return published.map((p) => ({
        media_id: p.mediaId,
        object_key: p.objectKey,
        width: 100,
        height: 100,
      }));
    return published
      .filter(
        (p) => mediaIds.includes(p.mediaId) && objectKeys.includes(p.objectKey),
      )
      .map((p) => ({ media_id: p.mediaId, object_key: p.objectKey }));
  });

/** The exact check over a pool double. */
const check = (
  pool: ReturnType<typeof poolOf>,
  pairs: Parameters<typeof publishedCatalogPairs>[1],
) =>
  publishedCatalogPairs(
    pool as unknown as Parameters<typeof publishedCatalogPairs>[0],
    pairs,
  );

describe("publishedCatalogPairs: the exact live pair check", () => {
  const a = editorial("a");
  const b = editorial("b");
  const c = editorial("c");

  it("binds the de-duplicated media ids and object keys in a restriction-only statement", async () => {
    const cms = cmsOf([a, b]);
    const live = await check(cms, [a, b, a, { ...b }]);
    expect([...live].sort()).toEqual([keyOf(a), keyOf(b)].sort());
    expect(cms.query).toHaveBeenCalledTimes(1);
    expect(cms.query).toHaveBeenCalledWith(publishedCatalogPairsSql, [
      [a.mediaId, b.mediaId],
      [a.objectKey, b.objectKey],
    ]);
    // No full listing, ordering, bound, digest or cross-database relation;
    // both conditions are restrictions, never a join of the view.
    for (const forbidden of [
      /ORDER BY/i,
      /LIMIT/i,
      /community\./,
      /md5/i,
      /jsonb_to_recordset/i,
      /\bJOIN\b/i,
      /unnest/i,
    ])
      expect(publishedCatalogPairsSql).not.toMatch(forbidden);
    expect(publishedCatalogPairsSql).toMatch(
      /FROM catalog_media\s+WHERE media_id = ANY\(\$1::text\[\]\) AND object_key = ANY\(\$2::text\[\]\)/,
    );
  });

  it("keys its answers exactly as the delivery facts map does", async () => {
    const live = await check(cmsOf([a]), [a]);
    expect([...live]).toEqual([JSON.stringify([a.mediaId, a.objectKey])]);
  });

  it("drops a published cross-product pair nobody asked for and every unrequested row", async () => {
    // (a.mediaId, b.objectKey) is published and matches both arrays, but the
    // read asked for (a, a-key) and (b, b-key) only; b itself is withdrawn.
    const crossed = { mediaId: a.mediaId, objectKey: b.objectKey };
    const cms = cmsOf([a, crossed, c]);
    const live = await check(cms, [a, b]);
    expect([...live]).toEqual([keyOf(a)]);
    // A CMS answer outside the request is ignored too.
    const loose = poolOf(async () => [
      { media_id: c.mediaId, object_key: c.objectKey },
      { media_id: a.mediaId, object_key: a.objectKey },
    ]);
    expect([...(await check(loose, [a]))]).toEqual([keyOf(a)]);
  });

  it("reads nothing for no pair", async () => {
    const cms = cmsOf([a]);
    expect(await check(cms, [])).toEqual(new Set());
    expect(cms.query).not.toHaveBeenCalled();
    expect(cms.connect).not.toHaveBeenCalled();
  });

  it.each([
    { mediaId: "", objectKey: a.objectKey },
    { mediaId: a.mediaId, objectKey: "" },
    { mediaId: null, objectKey: a.objectKey },
    { mediaId: a.mediaId, objectKey: 7 },
  ])("refuses an invalid pair before any query %#", async (pair) => {
    const cms = cmsOf([a]);
    await expect(
      check(cms, [
        a,
        pair as unknown as { mediaId: string; objectKey: string },
      ]),
    ).rejects.toThrow(TypeError);
    expect(cms.query).not.toHaveBeenCalled();
  });

  it("checks up to 10,000 distinct pairs in one statement and refuses more", async () => {
    expect(CATALOG_PUBLISHED_PAIRS_MAX).toBe(10_000);
    const many = (count: number) =>
      Array.from({ length: count }, (_, n) => ({
        mediaId: `media-${n}`,
        objectKey: a.objectKey,
      }));
    const cms = cmsOf(many(CATALOG_PUBLISHED_PAIRS_MAX + 5));
    // Duplicates do not count against the bound.
    const bounded = await check(cms, [
      ...many(CATALOG_PUBLISHED_PAIRS_MAX),
      ...many(50),
    ]);
    expect(bounded.size).toBe(CATALOG_PUBLISHED_PAIRS_MAX);
    expect(cms.query).toHaveBeenCalledTimes(1);
    await expect(
      check(cms, many(CATALOG_PUBLISHED_PAIRS_MAX + 1)),
    ).rejects.toThrow(TypeError);
    expect(cms.query).toHaveBeenCalledTimes(1);
  });

  it("propagates a refused or failed check (fail closed)", async () => {
    const refused = Object.assign(new Error("synthetic denied"), {
      code: "42501",
    });
    const cms = poolOf(async () => {
      throw refused;
    });
    await expect(check(cms, [a])).rejects.toBe(refused);
  });
});

describe("the authority's publishedAssetIds (the resolveKeys gate)", () => {
  const a = editorial("a");
  const b = editorial("b");
  const draft = editorial("draft");
  const assetsOf = (pairs: readonly { mediaId: string; objectKey: string }[]) =>
    new Map(
      pairs.map((p) => [
        assetOf(p.mediaId, p.objectKey),
        {
          id: assetOf(p.mediaId, p.objectKey),
          media_id: p.mediaId,
          source_object_key: p.objectKey,
        },
      ]),
    );
  /** App: the asset rows by primary key only; nothing else may be read. */
  const appOf = (assets: ReturnType<typeof assetsOf>) =>
    poolOf(async (sql, values) => {
      if (
        sql !==
        "SELECT id,media_id,source_object_key FROM community.catalog_media_assets WHERE id=ANY($1::text[])"
      )
        throw new Error("UNEXPECTED_APP_SQL");
      return ((values?.[0] ?? []) as string[]).flatMap((id) => {
        const row = assets.get(id);
        return row ? [row] : [];
      });
    });
  const prepareSpy = () =>
    poolOf(async () => {
      throw new Error("PREPARE_POOL_READ");
    });
  const authorityOf = (
    published: ReturnType<typeof poolOf>,
    prepare: ReturnType<typeof poolOf>,
    app: ReturnType<typeof poolOf>,
  ) =>
    createCatalogPublicationAuthority(
      published as unknown as Pools[0],
      prepare as unknown as Pools[1],
      app as unknown as Pools[2],
    );

  it("answers the live requested assets in request order, from one App and one CMS read", async () => {
    // A Catalog far beyond the old ceiling: an unbounded listing would be
    // incomplete, while the exact check reads only the requested pairs.
    const filler = Array.from(
      // One more than the old 10,000-image listing ceiling.
      { length: 10_001 },
      (_, n) => editorial(`filler-${n}`),
    );
    const cms = cmsOf([...filler, a, b]);
    const prepare = prepareSpy();
    // `draft` has an App asset (rendered for a prepared intent) but is not
    // published; `unknown` has no App asset at all.
    const app = appOf(assetsOf([a, b, draft]));
    const unknown = assetOf("media-unknown", a.objectKey);
    const ids = [
      assetOf(b.mediaId, b.objectKey),
      unknown,
      assetOf(draft.mediaId, draft.objectKey),
      assetOf(a.mediaId, a.objectKey),
      assetOf(b.mediaId, b.objectKey),
    ];
    expect(await authorityOf(cms, prepare, app).publishedAssetIds(ids)).toEqual(
      [
        assetOf(b.mediaId, b.objectKey),
        assetOf(a.mediaId, a.objectKey),
        assetOf(b.mediaId, b.objectKey),
      ],
    );
    expect(app.query).toHaveBeenCalledTimes(1);
    expect(app.query.mock.calls[0]![1]).toEqual([
      [
        assetOf(b.mediaId, b.objectKey),
        unknown,
        assetOf(draft.mediaId, draft.objectKey),
        assetOf(a.mediaId, a.objectKey),
      ],
    ]);
    expect(cms.query).toHaveBeenCalledTimes(1);
    expect(cms.query.mock.calls[0]![0]).toBe(publishedCatalogPairsSql);
    expect(cms.query.mock.calls[0]![1]).toEqual([
      [b.mediaId, draft.mediaId, a.mediaId],
      [b.objectKey, draft.objectKey, a.objectKey],
    ]);
    expect(cms.connect).not.toHaveBeenCalled();
    expect(prepare.query).not.toHaveBeenCalled();
    expect(prepare.connect).not.toHaveBeenCalled();
  });

  it("never serves an old object key after the media's key changed", async () => {
    const swapped = { mediaId: a.mediaId, objectKey: b.objectKey };
    // The CMS now publishes a.mediaId under a new key (and b, so the arrays
    // cross); the App still holds the asset of the old pair.
    const cms = cmsOf([swapped, b]);
    const app = appOf(assetsOf([a, b]));
    const authority = authorityOf(cms, prepareSpy(), app);
    expect(
      await authority.publishedAssetIds([
        assetOf(a.mediaId, a.objectKey),
        assetOf(b.mediaId, b.objectKey),
      ]),
    ).toEqual([assetOf(b.mediaId, b.objectKey)]);
  });

  it("reads nothing for no id, and no CMS row for ids the App does not hold", async () => {
    const cms = cmsOf([a]);
    const prepare = prepareSpy();
    const app = appOf(assetsOf([]));
    const authority = authorityOf(cms, prepare, app);
    expect(await authority.publishedAssetIds([])).toEqual([]);
    expect(app.query).not.toHaveBeenCalled();
    expect(
      await authority.publishedAssetIds([assetOf(a.mediaId, a.objectKey)]),
    ).toEqual([]);
    expect(app.query).toHaveBeenCalledTimes(1);
    expect(cms.query).not.toHaveBeenCalled();
    expect(prepare.query).not.toHaveBeenCalled();
    expect(prepare.connect).not.toHaveBeenCalled();
  });

  it.each([
    "catalog-asset-not-a-digest",
    `catalog-asset-${"A".repeat(32)}`,
    `media-rendition-${"a".repeat(32)}`,
    "",
  ])("refuses an invalid id %j before any read", async (id) => {
    const cms = cmsOf([a]);
    const app = appOf(assetsOf([a]));
    await expect(
      authorityOf(cms, prepareSpy(), app).publishedAssetIds([
        assetOf(a.mediaId, a.objectKey),
        id,
      ]),
    ).rejects.toThrow(TypeError);
    expect(app.query).not.toHaveBeenCalled();
    expect(cms.query).not.toHaveBeenCalled();
  });

  it("checks up to 10,000 distinct ids and refuses more before any read", async () => {
    const id = (n: number) =>
      `catalog-asset-${n.toString(16).padStart(32, "0")}`;
    const cms = cmsOf([]);
    const app = appOf(assetsOf([]));
    const authority = authorityOf(cms, prepareSpy(), app);
    const bounded = Array.from(
      { length: CATALOG_PUBLISHED_PAIRS_MAX },
      (_, n) => id(n),
    );
    expect(await authority.publishedAssetIds([...bounded, id(0)])).toEqual([]);
    expect(app.query).toHaveBeenCalledTimes(1);
    await expect(
      authority.publishedAssetIds([
        ...bounded,
        id(CATALOG_PUBLISHED_PAIRS_MAX),
      ]),
    ).rejects.toThrow(TypeError);
    expect(app.query).toHaveBeenCalledTimes(1);
    expect(cms.query).not.toHaveBeenCalled();
  });

  it("fails closed when either read fails", async () => {
    const terminated = Object.assign(new Error("synthetic terminated"), {
      code: "57P01",
    });
    const ids = [assetOf(a.mediaId, a.objectKey)];
    const failingCms = poolOf(async () => {
      throw terminated;
    });
    await expect(
      authorityOf(
        failingCms,
        prepareSpy(),
        appOf(assetsOf([a])),
      ).publishedAssetIds(ids),
    ).rejects.toBe(terminated);
    const failingApp = poolOf(async () => {
      throw terminated;
    });
    await expect(
      authorityOf(cmsOf([a]), prepareSpy(), failingApp).publishedAssetIds(ids),
    ).rejects.toBe(terminated);
  });
});

describe("lookupPublishedCatalog with an authority", () => {
  it("does not read publications again when no requested Catalog asset is live", async () => {
    const assetId = assetOf("media-a", editorial("a").objectKey);
    const query = vi.fn(async () => ({
      rows: [{ catalog_asset_id: assetId }],
    }));
    const connect = vi.fn(async () => {
      throw new Error("UNEXPECTED_PUBLICATION_READ");
    });
    const publishedAssetIds = vi.fn(async () => []);
    const adapter = new PostgresMediaPublicationAdapter(
      { query, connect } as unknown as ConstructorParameters<
        typeof PostgresMediaPublicationAdapter
      >[0],
      {
        isPublic: () => true,
        allowPublish: () => true,
        catalogAuthority: {
          publishedAssetIds,
          copyRenditionIds: async () => [],
          acquire: async () => {
            throw new Error("UNEXPECTED_ACQUIRE");
          },
        },
      },
    );
    expect(
      await adapter.lookupPublishedCatalog(
        [`media-rendition-${"1".repeat(32)}`],
        new Date("2126-10-22T00:00:00.000Z"),
      ),
    ).toEqual(new Map());
    expect(publishedAssetIds).toHaveBeenCalledWith([assetId]);
    expect(query).toHaveBeenCalledTimes(1);
    expect(connect).not.toHaveBeenCalled();
  });
});

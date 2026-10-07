import {
  AuthorCommunityService,
  CatalogMediaResolutionError,
  CatalogReadService,
  EditorialContentReadService,
  mapCatalogDetail,
  mapCatalogPublicMedia,
} from "@moya/api";
import {
  assertPostgresStartupReady,
  mapCatalogMediaRow,
  PostgresAuthoredArticleCatalogMediaResolver,
  PostgresCatalogQueryAdapter,
  PostgresCompositeEditorialAdapter,
  PostgresEditorialContentAdapter,
} from "@moya/catalog-postgres";
import {
  articleDetailSchema,
  articlePageSchema,
  catalogDetailSchema,
  catalogIdSchema,
  catalogPageSchema,
  contentCardSchema,
  mediaIdSchema,
  publicMediaSchema,
} from "@moya/contracts/schemas";
import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  ArticleDetailRecord,
  AuthorCommunityPort,
  CatalogMediaProjection,
  CatalogMediaRenditionProjection,
  CatalogPublicationPort,
  CatalogQueryPort,
  CommunityDiscoveryPort,
  DiscoveryCardRecord,
  EditorialContentReadPort,
  EditorialMediaRecord,
  StorageUrlResolver,
} from "@moya/api";
import type { ArticleId } from "@moya/contracts";

type Pool = ConstructorParameters<typeof PostgresCatalogQueryAdapter>[0];

/*
 * Catalog rendition delivery (unified media pipeline, PR 1b, CW4/CW12): card
 * contexts list candidates up to the display anchor, detail contexts add the
 * zoom levels, `src` and the size switch to the anchor only when every
 * candidate resolved, the approved image stays otherwise, and the placeholder
 * colour is emitted whatever the delivery. Readers join the delivery view
 * only when composed with renditions.
 */

const hex = (n: number) => n.toString(16).padStart(32, "0");
const deliveryKey = (n: number) => `media-rendition-${hex(n)}`;
const entry = (
  n: number,
  level: CatalogMediaRenditionProjection["level"],
  width: number,
  height: number,
): CatalogMediaRenditionProjection => ({
  key: deliveryKey(n),
  width,
  height,
  contentType: "image/webp",
  level,
});
// A 4096×2731 approved image: thumb, cover, display (the anchor) and viewer.
const renditions = [
  entry(1, "card", 480, 320),
  entry(2, "card", 1080, 720),
  entry(3, "display", 2048, 1365),
  entry(4, "zoom", 4096, 2731),
];
const mediaId = mediaIdSchema.parse("media-delivery-1");
const catalogId = catalogIdSchema.parse("catalog-delivery-1");
// The approved image alone, as a reader without delivery facts projects it.
const approvedMedia: CatalogMediaProjection = {
  id: mediaId,
  position: 0,
  isRepresentative: true,
  kind: "image",
  alt: "合成拓片",
  width: 4096,
  height: 2731,
  objectKey: "private/approved.webp",
};
const media = (
  extra: Partial<CatalogMediaProjection> = {},
): CatalogMediaProjection => ({
  ...approvedMedia,
  renditions,
  placeholderColor: "#3a2f28",
  ...extra,
});
const approvedUrl =
  "https://media.example.invalid/approved.webp?sign=synthetic-signature";
const deliveryUrl = (key: string) =>
  `http://127.0.0.1:3001/v1/development/catalog-renditions/${key}`;
const allUrls = new Map(
  renditions.map(({ key }) => [key, deliveryUrl(key)] as const),
);
const approved = new Map([[mediaId, approvedUrl]]);
const card = (n: number, width: number, height: number) => ({
  src: deliveryUrl(deliveryKey(n)),
  width,
  height,
  contentType: "image/webp",
});
const cardList = [card(1, 480, 320), card(2, 1080, 720), card(3, 2048, 1365)];
const detailList = [...cardList, card(4, 4096, 2731)];

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Catalog image mapping by context", () => {
  it("lists card candidates up to the display anchor and switches src and size to it", () => {
    const mapped = mapCatalogPublicMedia(media(), approved, allUrls, "card");
    expect(mapped).toEqual({
      id: mediaId,
      kind: "image",
      src: deliveryUrl(deliveryKey(3)),
      alt: "合成拓片",
      width: 2048,
      height: 1365,
      renditions: cardList,
      placeholderColor: "#3a2f28",
    });
    expect(publicMediaSchema.parse(mapped)).toEqual(mapped);
  });

  it("adds the zoom levels in the detail context and keeps the same anchor", () => {
    const mapped = mapCatalogPublicMedia(media(), approved, allUrls, "detail");
    expect(mapped).toMatchObject({
      src: deliveryUrl(deliveryKey(3)),
      width: 2048,
      height: 1365,
      renditions: detailList,
    });
  });

  it("keeps the approved image and its colour when delivery is off, without a log line", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    for (const context of ["card", "detail"] as const)
      expect(
        mapCatalogPublicMedia(media(), approved, new Map(), context),
      ).toEqual({
        id: mediaId,
        kind: "image",
        src: approvedUrl,
        alt: "合成拓片",
        width: 4096,
        height: 2731,
        placeholderColor: "#3a2f28",
      });
    expect(warn).not.toHaveBeenCalled();
  });

  it("falls back to the approved image with one content-free log line when a needed key did not resolve", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const withoutViewer = new Map(allUrls);
    withoutViewer.delete(deliveryKey(4));
    const detail = mapCatalogPublicMedia(
      media(),
      approved,
      withoutViewer,
      "detail",
    );
    expect(detail).toMatchObject({ src: approvedUrl, width: 4096 });
    expect(detail).not.toHaveProperty("renditions");
    expect(detail.placeholderColor).toBe("#3a2f28");
    expect(warn).toHaveBeenCalledTimes(1);
    const line = String(warn.mock.calls[0]?.[0]);
    expect(line).toBe("[catalog-media] rendition_fallback");
    // A card does not need the zoom level, so its list is complete.
    expect(
      mapCatalogPublicMedia(media(), approved, withoutViewer, "card")
        .renditions,
    ).toEqual(cardList);
  });

  it("keeps one entry per size, preferring the anchor, and needs exactly one anchor", () => {
    // A small image: every card role has the display size.
    const small = media({
      width: 400,
      height: 300,
      renditions: [
        entry(1, "card", 400, 300),
        entry(2, "card", 400, 300),
        entry(3, "display", 400, 300),
      ],
    });
    expect(
      mapCatalogPublicMedia(small, approved, allUrls, "detail").renditions,
    ).toEqual([card(3, 400, 300)]);
    for (const list of [
      renditions.filter(({ level }) => level !== "display"),
      [...renditions, entry(9, "display", 2048, 1365)],
    ]) {
      const mapped = mapCatalogPublicMedia(
        media({ renditions: list }),
        approved,
        new Map([...allUrls, [deliveryKey(9), deliveryUrl(deliveryKey(9))]]),
        "card",
      );
      expect(mapped.src).toBe(approvedUrl);
      expect(mapped).not.toHaveProperty("renditions");
    }
  });

  it("refuses a list of mixed framing with one content-free log line and drops a malformed colour", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const mixed = media({
      placeholderColor: "#ABCDEF",
      renditions: [entry(1, "card", 480, 480), entry(3, "display", 2048, 1365)],
    });
    const mapped = mapCatalogPublicMedia(mixed, approved, allUrls, "card");
    expect(mapped).toEqual({
      id: mediaId,
      kind: "image",
      src: approvedUrl,
      alt: "合成拓片",
      width: 4096,
      height: 2731,
    });
    // A list the contract refuses is a defect worth seeing, like a partial
    // resolution; the line names nothing of the image.
    expect(warn.mock.calls).toEqual([["[catalog-media] rendition_fallback"]]);
  });

  it("still fails the read when the approved image has no URL", () => {
    expect(() =>
      mapCatalogPublicMedia(media(), new Map(), allUrls, "card"),
    ).toThrow(CatalogMediaResolutionError);
  });

  it("maps a detail projection with a card representative image and a detail gallery", () => {
    const detail = mapCatalogDetail(
      {
        id: catalogId,
        kind: "inscription",
        title: "合成资料",
        aliases: [],
        representativeMedia: media(),
        sourceCitations: [],
        media: [media()],
      },
      approved,
      allUrls,
    );
    expect(detail.representativeMedia?.renditions).toEqual(cardList);
    expect(detail.media[0]?.renditions).toEqual(detailList);
    expect(catalogDetailSchema.parse(detail)).toEqual(detail);
    // The Admin preview keeps its two-argument call and the approved image.
    expect(
      mapCatalogDetail(
        {
          id: catalogId,
          kind: "inscription",
          title: "合成资料",
          aliases: [],
          sourceCitations: [],
          media: [approvedMedia],
        },
        approved,
      ).media[0]?.src,
    ).toBe(approvedUrl);
  });
});

/** A resolver that records each call and answers from fixed maps. */
const recordingResolver = (
  options: {
    readonly keys?: ReadonlyMap<string, string>;
    readonly failKeys?: boolean;
    readonly failMany?: boolean;
  } = {},
) => {
  const many: string[][] = [];
  const keys: string[][] = [];
  const resolver: Required<StorageUrlResolver> = {
    async resolveMany(locators) {
      many.push(locators.map(({ mediaId: id }) => id));
      if (options.failMany) throw new Error("synthetic batch failure");
      return new Map(locators.map(({ mediaId: id }) => [id, approvedUrl]));
    },
    async resolveKeys(requested) {
      keys.push([...requested]);
      if (options.failKeys) throw new Error("synthetic batch failure");
      return options.keys ?? allUrls;
    },
  };
  return { many, keys, resolver };
};

const listProjection = {
  items: [
    {
      id: catalogId,
      kind: "inscription" as const,
      title: "合成资料",
      aliases: [],
      representativeMedia: media(),
    },
  ],
  total: 1,
  page: 1,
  pageSize: 20,
  totalPages: 1,
};
const catalogPort: CatalogQueryPort = {
  list: async () => listProjection,
  getById: async (id) =>
    id === catalogId
      ? {
          ...listProjection.items[0]!,
          sourceCitations: [],
          media: [media()],
        }
      : null,
};

describe("CatalogReadService rendition delivery", () => {
  it("resolves only card keys for list and search, in one batch", async () => {
    const { keys, resolver } = recordingResolver();
    const service = new CatalogReadService(catalogPort, resolver, {
      search: async (query) => ({
        ...listProjection,
        items: listProjection.items.map((item) => ({
          ...item,
          matchKind: "title-exact" as const,
        })),
        page: query.page,
      }),
    });
    const page = catalogPageSchema.parse(
      await service.list({ page: 1, pageSize: 20 }),
    );
    expect(page.items[0]?.representativeMedia).toMatchObject({
      src: deliveryUrl(deliveryKey(3)),
      renditions: cardList,
      placeholderColor: "#3a2f28",
    });
    const search = await service.search({ q: "合成", page: 1, pageSize: 20 });
    expect(search.items[0]?.representativeMedia?.renditions).toEqual(cardList);
    expect(keys).toEqual([
      [deliveryKey(1), deliveryKey(2), deliveryKey(3)],
      [deliveryKey(1), deliveryKey(2), deliveryKey(3)],
    ]);
  });

  it("resolves the card keys of the representative image and the detail keys of the gallery", async () => {
    const { keys, many, resolver } = recordingResolver();
    const detail = await new CatalogReadService(catalogPort, resolver).getById(
      catalogId,
    );
    expect(keys).toEqual([
      [deliveryKey(1), deliveryKey(2), deliveryKey(3), deliveryKey(4)],
    ]);
    expect(many).toEqual([[mediaId]]);
    expect(detail?.representativeMedia?.renditions).toEqual(cardList);
    expect(detail?.media[0]?.renditions).toEqual(detailList);
  });

  it("maps a failed rendition or approved batch to the media resolution failure (503)", async () => {
    for (const failure of [{ failKeys: true }, { failMany: true }]) {
      const { resolver } = recordingResolver(failure);
      const service = new CatalogReadService(catalogPort, resolver);
      await expect(service.list({ page: 1, pageSize: 20 })).rejects.toThrow(
        CatalogMediaResolutionError,
      );
      await expect(service.getById(catalogId)).rejects.toThrow(
        CatalogMediaResolutionError,
      );
    }
  });

  it("keeps the approved image for a resolver without rendition delivery", async () => {
    const page = await new CatalogReadService(catalogPort, {
      resolveMany: async () => approved,
    }).list({ page: 1, pageSize: 20 });
    expect(page.items[0]?.representativeMedia).toEqual({
      id: mediaId,
      kind: "image",
      src: approvedUrl,
      alt: "合成拓片",
      width: 4096,
      height: 2731,
      placeholderColor: "#3a2f28",
    });
  });
});

describe("Editorial and card readers", () => {
  const record = (): EditorialMediaRecord => ({
    id: mediaId,
    objectKey: "private/approved.webp",
    alt: "合成拓片",
    width: 4096,
    height: 2731,
    renditions,
    placeholderColor: "#3a2f28",
  });
  const articleId = `article-${"a".repeat(32)}` as ArticleId;
  const article: ArticleDetailRecord = {
    id: articleId,
    presentation: "academic",
    title: "石与纸之间",
    subtitle: null,
    summary: null,
    section: null,
    issue: null,
    byline: "合成编辑室",
    cover: record(),
    firstPublishedAt: "2026-09-20T10:00:00.000Z",
    publishedAt: "2026-09-21T10:00:00.000Z",
    updatedAt: "2026-09-21T10:00:00.000Z",
    intro: null,
    sections: [
      { heading: null, body: "正文。", image: record(), imageCaption: null },
    ],
    citations: [],
  };
  const port = {
    listArticles: async () => ({
      items: [article],
      total: 1,
      page: 1,
      pageSize: 20,
    }),
    findArticle: async () => article,
  } as unknown as EditorialContentReadPort;

  it("shows Article list covers as cards and Article pages in the detail context", async () => {
    const { keys, resolver } = recordingResolver();
    const service = new EditorialContentReadService(port, resolver);
    const page = articlePageSchema.parse(
      await service.listArticles({ page: 1, pageSize: 20 }),
    );
    expect(page.items[0]?.cover?.renditions).toEqual(cardList);
    const detail = articleDetailSchema.parse(
      await service.readArticle(articleId),
    );
    expect(detail.cover?.renditions).toEqual(detailList);
    expect(detail.sections[0]?.image?.renditions).toEqual(detailList);
    expect(keys).toEqual([
      [deliveryKey(1), deliveryKey(2), deliveryKey(3)],
      [deliveryKey(1), deliveryKey(2), deliveryKey(3), deliveryKey(4)],
    ]);
  });

  it("builds Catalog content cards with card candidates and the colour", async () => {
    const catalogCard: DiscoveryCardRecord = {
      target: { type: "catalog", id: catalogId },
      title: "合成资料",
      aliases: [],
      kind: "inscription",
      authorId: null,
      firstPublishedAt: null,
      media: {
        type: "catalog",
        id: mediaId,
        objectKey: "private/approved.webp",
        width: 4096,
        height: 2731,
        renditions,
        placeholderColor: "#3a2f28",
      },
    };
    const discovery = {
      card: async () => catalogCard,
    } as unknown as CommunityDiscoveryPort;
    const serviceWith = (resolver: StorageUrlResolver) =>
      new AuthorCommunityService(
        {} as AuthorCommunityPort,
        {} as CatalogPublicationPort,
        undefined,
        discovery,
        resolver,
      );
    const { keys, resolver } = recordingResolver();
    const delivered = await serviceWith(resolver).card(
      { type: "catalog", id: catalogId },
      null,
    );
    expect(contentCardSchema.parse(delivered).media).toEqual({
      id: mediaId,
      width: 2048,
      height: 1365,
      src: deliveryUrl(deliveryKey(3)),
      renditions: cardList,
      placeholderColor: "#3a2f28",
    });
    expect(keys).toEqual([[deliveryKey(1), deliveryKey(2), deliveryKey(3)]]);
    // Production in increment 1: nothing resolves; the approved image stays.
    const off = await serviceWith({
      resolveMany: async () => approved,
      resolveKeys: async () => new Map(),
    }).card({ type: "catalog", id: catalogId }, null);
    expect(off.media).toEqual({
      id: mediaId,
      width: 4096,
      height: 2731,
      src: approvedUrl,
      placeholderColor: "#3a2f28",
    });
  });
});

describe("Catalog rows and reader composition", () => {
  const row = {
    media_id: "media-row-1",
    catalog_id: "catalog-row-1",
    position: 0,
    is_representative: true,
    kind: "image",
    alt_text: "合成",
    width: 4096,
    height: 2731,
    object_key: "private/approved.webp",
  };

  it("maps well-formed delivery facts and drops everything else", () => {
    const valid = {
      key: deliveryKey(1),
      width: 480,
      height: 320,
      contentType: "image/webp",
      level: "card",
    };
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    expect(
      mapCatalogMediaRow({
        ...row,
        renditions: [
          valid,
          { ...valid, key: `blobs/aa/bb/${hex(2)}` },
          { ...valid, key: deliveryKey(3), level: "master" },
          { ...valid, key: deliveryKey(4), width: 0 },
          { ...valid, key: deliveryKey(5), contentType: "image/png" },
          "media-rendition-not-an-object",
        ],
        placeholder_color: "#3a2f28",
      }),
    ).toMatchObject({ renditions: [valid], placeholderColor: "#3a2f28" });
    expect(warn.mock.calls).toEqual([["[catalog-media] rendition_fallback"]]);
    warn.mockClear();
    // No joined facts (a reader without renditions): unchanged projection.
    expect(mapCatalogMediaRow(row)).toEqual({
      id: "media-row-1",
      position: 0,
      isRepresentative: true,
      kind: "image",
      alt: "合成",
      width: 4096,
      height: 2731,
      objectKey: "private/approved.webp",
    });
    const absent = mapCatalogMediaRow({
      ...row,
      renditions: null,
      placeholder_color: "#ABC",
    });
    expect(absent).not.toHaveProperty("renditions");
    expect(absent).not.toHaveProperty("placeholderColor");
    expect(warn).not.toHaveBeenCalled();
  });

  /** A pool whose single client answers by statement and records the SQL. */
  const fakePool = (answer: (sql: string) => readonly object[]) => {
    const statements: string[] = [];
    const client = {
      query: async (sql: string) => {
        statements.push(sql);
        return { rows: answer(sql), rowCount: answer(sql).length };
      },
      release: () => undefined,
    };
    const pool = {
      connect: async () => client,
      query: client.query,
    } as unknown as Pool;
    return { pool, statements };
  };
  const entryRow = {
    catalog_id: "catalog-row-1",
    kind: "inscription",
    title: "合成资料",
    summary: null,
    period_label: null,
    dynasty: null,
    dynasty_state: "UNSUPPLIED",
    date_text: null,
    date_text_state: "UNSUPPLIED",
    province: null,
    province_state: "UNSUPPLIED",
  };
  const joined = (sql: string) =>
    sql.includes("community.catalog_media_delivery");

  it("joins the delivery view only when composed with renditions", async () => {
    for (const renditionsEnabled of [false, true]) {
      const { pool, statements } = fakePool((sql) =>
        /COUNT\(\*\)/u.test(sql)
          ? [{ total: "1" }]
          : /FROM catalog_entries/u.test(sql)
            ? [entryRow]
            : /catalog_media/u.test(sql)
              ? [
                  {
                    ...row,
                    ...(renditionsEnabled
                      ? {
                          renditions: renditions.map((value) => ({
                            ...value,
                          })),
                          placeholder_color: "#3a2f28",
                        }
                      : {}),
                  },
                ]
              : [],
      );
      const adapter = renditionsEnabled
        ? new PostgresCatalogQueryAdapter(pool, { renditions: true })
        : new PostgresCatalogQueryAdapter(pool);
      const page = await adapter.list({ page: 1, pageSize: 20 });
      expect(statements.some(joined)).toBe(renditionsEnabled);
      expect(page.items[0]?.representativeMedia?.renditions).toEqual(
        renditionsEnabled ? renditions : undefined,
      );
    }
  });

  it("composes the editorial readers and the Article Catalog resolver the same way", async () => {
    const delivered = {
      renditions: renditions.map((value) => ({ ...value })),
      placeholder_color: "#3a2f28",
    };
    const articleRow = {
      article_id: `article-${"b".repeat(32)}`,
      presentation: "academic",
      title: "合成文章",
      subtitle: null,
      summary: null,
      section: null,
      issue: null,
      byline: "合成编辑室",
      intro: null,
      cover_alt: null,
      cover_catalog_id: "catalog-row-1",
      first_published_at: new Date("2026-09-20T10:00:00.000Z"),
      published_at: new Date("2026-09-21T10:00:00.000Z"),
      updated_at: new Date("2026-09-21T10:00:00.000Z"),
    };
    for (const renditionsEnabled of [false, true]) {
      const options = renditionsEnabled ? { renditions: true } : {};
      const editorial = fakePool((sql) =>
        /COUNT\(\*\)/u.test(sql)
          ? [{ total: "1" }]
          : /FROM article_entries/u.test(sql)
            ? [articleRow]
            : /catalog_media/u.test(sql)
              ? [{ ...row, ...(renditionsEnabled ? delivered : {}) }]
              : [],
      );
      const articles = await new PostgresEditorialContentAdapter(
        editorial.pool,
        options,
      ).listArticles({ page: 1, pageSize: 20 });
      expect(editorial.statements.some(joined)).toBe(renditionsEnabled);
      expect(articles.items[0]?.cover?.renditions).toEqual(
        renditionsEnabled ? renditions : undefined,
      );
      const composite = fakePool((sql) =>
        /COUNT\(\*\)/u.test(sql) ? [{ total: "0" }] : [],
      );
      await new PostgresCompositeEditorialAdapter(
        composite.pool,
        {} as EditorialContentReadPort,
        { summary: vi.fn(), detail: vi.fn() },
        options,
      ).listArticles({ page: 1, pageSize: 20 });
      expect(composite.statements.some(joined)).toBe(renditionsEnabled);

      const resolver = fakePool((sql) =>
        /jsonb_to_recordset/u.test(sql)
          ? [{ ...row, ...(renditionsEnabled ? delivered : {}) }]
          : [],
      );
      const { keys, resolver: storage } = recordingResolver();
      const resolved = await new PostgresAuthoredArticleCatalogMediaResolver(
        resolver.pool,
        storage,
        options,
      ).resolveCatalog([
        { catalogId: "catalog-row-1", mediaId: "media-row-1" },
      ] as never);
      expect(resolver.statements.some(joined)).toBe(renditionsEnabled);
      const reference = [...resolved.values()][0]!;
      // An Article reference answers in the detail context.
      expect(reference.renditions).toEqual(
        renditionsEnabled ? detailList : undefined,
      );
      expect(keys).toEqual(
        renditionsEnabled
          ? [[deliveryKey(1), deliveryKey(2), deliveryKey(3), deliveryKey(4)]]
          : [],
      );
    }
  });
});

describe("startup check of the delivery view grant", () => {
  /** A Payload-ready read connection whose delivery view probe fails with `code`. */
  const payloadPool = (probe: string | null) => {
    const statements: string[] = [];
    const query = async (sql: string) => {
      statements.push(sql);
      if (sql.includes("community.catalog_media_delivery")) {
        if (probe !== null)
          throw Object.assign(new Error("synthetic probe failure"), {
            code: probe,
          });
        return { rows: [] };
      }
      if (sql.includes("SHOW server_version_num"))
        return { rows: [{ server_version_num: "180004" }] };
      if (sql.includes("view_count"))
        return {
          rows: [
            { view_count: "6", view_migration: true, search_migration: true },
          ],
        };
      return { rows: [{ incomplete: false }] };
    };
    const pool = {
      connect: async () => ({ query, release: () => undefined }),
      query,
    } as unknown as Pool;
    return { pool, statements };
  };

  it("probes the view only for readers composed with renditions", async () => {
    const without = payloadPool(null);
    await assertPostgresStartupReady(without.pool, "payload");
    expect(
      without.statements.some((sql) =>
        sql.includes("community.catalog_media_delivery"),
      ),
    ).toBe(false);
    const enabled = payloadPool(null);
    await assertPostgresStartupReady(enabled.pool, "payload", {
      renditions: true,
    });
    expect(enabled.statements.at(-1)).toBe(
      "SELECT 1 FROM community.catalog_media_delivery LIMIT 0",
    );
  });

  it.each(["42501", "42P01", "3F000"])(
    "stops startup when the view is not readable (%s)",
    async (code) => {
      await expect(
        assertPostgresStartupReady(payloadPool(code).pool, "payload", {
          renditions: true,
        }),
      ).rejects.toThrow(/^Catalog rendition delivery view is not readable$/);
    },
  );

  it("keeps other failures as the generic startup failure", async () => {
    await expect(
      assertPostgresStartupReady(payloadPool("08006").pool, "payload", {
        renditions: true,
      }),
    ).rejects.toThrow(/^PostgreSQL startup validation failed$/);
  });
});

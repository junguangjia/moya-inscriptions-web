import { afterEach, describe, expect, it, vi } from "vitest";
import type { createPostgresPool } from "@moya/catalog-postgres";
import type { PostgresArticleAuthoringOptions } from "@moya/community-postgres";
type Pool = ReturnType<typeof createPostgresPool>;
type PoolClient = Parameters<
  NonNullable<PostgresArticleAuthoringOptions["assertDelegatedActor"]>
>[0];
import type { PublicUserId, MediaId } from "@moya/contracts";
import {
  articleOwnMediaListQuerySchema,
  articleOwnMediaPageSchema,
  publishingMediaItemSchema,
} from "@moya/contracts/schemas";
import {
  decodeArticleOwnMediaCursor,
  encodeArticleOwnMediaCursor,
  listArticleOwnMedia,
  resolvePublishedArticleManagedMedia,
} from "@moya/community-postgres";
import {
  PostgresAuthoredArticleCatalogMediaResolver,
  authoredArticleCatalogPairKey,
} from "@moya/catalog-postgres";
const owner = `user-${"1".repeat(32)}` as PublicUserId;
const id = (digit: string) => `media-item-${digit.repeat(32)}`;
const legacy = `user-media-${"9".repeat(32)}`;
const ready = (digit = "1") =>
  publishingMediaItemSchema.parse({
    id: id(digit),
    kind: "static",
    qualityMode: "legacy",
    state: "ready",
    failureCode: null,
    components: [],
    presentation: { width: 4, height: 3 },
    media: {
      thumbSrc: `/api/community/media/${legacy}`,
      displaySrc: `/api/community/media/${legacy}`,
    },
  });
const itemRow = (digit: string) => ({
  id: id(digit),
  kind: "static",
  quality_mode: "legacy",
  state: "ready",
  failure_code: null,
  presentation: { width: 4, height: 3, privateFact: "excluded" },
  legacy_media_id: legacy,
  components: [],
  has_full: false,
});
const database = (rows: unknown[]) => {
  const query = vi.fn(async (sql: string, values: unknown[] = []) => {
    void values;
    return {
      rows:
        sql.startsWith("BEGIN") || sql === "COMMIT" || sql === "ROLLBACK"
          ? []
          : rows,
    };
  });
  const release = vi.fn();
  const db = { query, release } as unknown as PoolClient;
  return {
    db,
    query,
    release,
    pool: { connect: async () => db } as unknown as Pool,
  };
};
afterEach(() => vi.restoreAllMocks());
describe("canonical Article own-media boundary", () => {
  it("shares strict owner-free query and finite page limits", () => {
    expect(articleOwnMediaListQuerySchema.parse({ pageSize: "50" })).toEqual({
      pageSize: 50,
    });
    for (const value of [
      { ownerId: owner },
      { pageSize: 51 },
      { pageSize: 0 },
      { cursor: "=" },
    ])
      expect(articleOwnMediaListQuerySchema.safeParse(value).success).toBe(
        false,
      );
  });
  it("returns only canonical ready unique items and no extra private DTO fields", () => {
    const item = ready();
    expect(
      articleOwnMediaPageSchema.parse({ items: [item], nextCursor: null })
        .items[0],
    ).toEqual(item);
    for (const value of [
      { items: [item, item], nextCursor: null },
      { items: [{ ...item, state: "queued", media: null }], nextCursor: null },
      { items: [{ ...item, privateMetadata: {} }], nextCursor: null },
    ])
      expect(articleOwnMediaPageSchema.safeParse(value).success).toBe(false);
  });
  it("round trips all six microsecond digits without Date truncation", () => {
    const first = { at: "2026-09-30T00:00:00.123456Z", id: id("1") };
    const second = { ...first, at: "2026-09-30T00:00:00.123455Z" };
    expect(
      decodeArticleOwnMediaCursor(encodeArticleOwnMediaCursor(first)),
    ).toEqual(first);
    expect(encodeArticleOwnMediaCursor(first)).not.toEqual(
      encodeArticleOwnMediaCursor(second),
    );
    expect(decodeArticleOwnMediaCursor(undefined)).toBe(null);
  });
  it.each([
    "2026-02-30T00:00:00.123456Z",
    "2026-09-30T25:00:00.123456Z",
    "0000-09-30T00:00:00.123456Z",
    "2026-09-30T00:00:00.123Z",
  ])("refuses invalid/non-lossless cursor timestamp %s", (at) => {
    const cursor = Buffer.from(JSON.stringify([at, id("1")])).toString(
      "base64url",
    );
    expect(() => decodeArticleOwnMediaCursor(cursor)).toThrow(
      "article_media_cursor_invalid",
    );
  });
  it("refuses noncanonical/oversized cursor encodings and extra fields", () => {
    for (const value of [
      "=".repeat(5),
      "a".repeat(513),
      Buffer.from(
        JSON.stringify(["2026-09-30T00:00:00.123456Z", id("1"), owner]),
      ).toString("base64url"),
    ])
      expect(() => decodeArticleOwnMediaCursor(value)).toThrow(
        "article_media_cursor_invalid",
      );
  });
  it("preserves query order after one canonical batch lookup and seeks from last visible row", async () => {
    const cursorRows = [
      { id: id("3"), cursor_at: "2026-09-30T00:00:00.123457Z" },
      { id: id("2"), cursor_at: "2026-09-30T00:00:00.123456Z" },
      { id: id("1"), cursor_at: "2026-09-30T00:00:00.123455Z" },
    ];
    const query = vi
      .fn()
      .mockResolvedValueOnce({ rows: cursorRows })
      .mockResolvedValueOnce({ rows: [itemRow("2"), itemRow("3")] });
    const page = await listArticleOwnMedia(
      { query } as unknown as PoolClient,
      owner,
      { pageSize: 2 },
    );
    expect(page.items.map((item) => item.id)).toEqual([id("3"), id("2")]);
    expect(decodeArticleOwnMediaCursor(page.nextCursor ?? undefined)).toEqual({
      at: cursorRows[1]!.cursor_at,
      id: id("2"),
    });
    expect(query.mock.calls[1]?.[1]).toEqual([owner, [id("3"), id("2")]]);
    expect(JSON.stringify(page)).not.toContain("privateFact");
  });
  it("projects only safe current published managed derivatives and leaves missing refs absent", async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ id: id("1") }] })
      .mockResolvedValueOnce({ rows: [itemRow("1")] })
      .mockResolvedValueOnce({ rows: [] });
    const release = vi.fn();
    const db = { query, release } as unknown as PoolClient;
    const result = await resolvePublishedArticleManagedMedia(
      { connect: async () => db } as unknown as Pool,
      owner,
      [id("1"), id("2")],
    );
    expect(result.get(id("1"))).toEqual({
      id: id("1"),
      kind: "static",
      src: `/api/community/media/${legacy}`,
      width: 4,
      height: 3,
    });
    expect(result.has(id("2"))).toBe(false);
    expect(JSON.stringify([...result.values()])).not.toContain("privateFact");
    expect(release).toHaveBeenCalledOnce();
  });
});
const catalogRow = (catalog: string, media: string, key: string) => ({
  catalog_id: catalog,
  media_id: media,
  position: 0,
  is_representative: true,
  kind: "image",
  alt_text: "合成",
  width: 4,
  height: 3,
  object_key: key,
});
describe("published Catalog exact-pair media composition", () => {
  it("uses collision-free Catalog/media keys and never conflates colon IDs", () => {
    expect(authoredArticleCatalogPairKey("catalog-a:b", "media-c")).not.toBe(
      authoredArticleCatalogPairKey("catalog-a", "b:media-c"),
    );
  });
  it("resolves ordinary distinct media in one existing storage batch and strips object keys", async () => {
    const { pool, query, release } = database([
      catalogRow("catalog-a", "media-a", "synthetic/a.webp"),
      catalogRow("catalog-b", "media-b", "synthetic/b.webp"),
    ]);
    const resolveMany = vi.fn(
      async (locators: readonly { mediaId: MediaId; objectKey: string }[]) =>
        new Map(
          locators.map((item) => [
            item.mediaId,
            `https://media.example.invalid/${item.objectKey}`,
          ]),
        ),
    );
    const resolver = new PostgresAuthoredArticleCatalogMediaResolver(pool, {
      resolveMany,
    });
    const pairs = [
      { catalogId: "catalog-a", mediaId: "media-a" },
      { catalogId: "catalog-b", mediaId: "media-b" },
    ];
    const result = await resolver.resolveCatalog(pairs as never);
    expect(resolveMany).toHaveBeenCalledOnce();
    expect(query.mock.calls[1]?.[1]).toEqual([JSON.stringify(pairs)]);
    expect(result.size).toBe(2);
    expect(JSON.stringify([...result.values()])).not.toContain("objectKey");
    expect(release).toHaveBeenCalledOnce();
  });
  it("keeps the same legacy MediaId with different Catalog object keys in distinct batches", async () => {
    const { pool } = database([
      catalogRow("catalog-a", "media-same", "synthetic/a.webp"),
      catalogRow("catalog-b", "media-same", "synthetic/b.webp"),
    ]);
    const resolveMany = vi.fn(
      async (locators: readonly { mediaId: MediaId; objectKey: string }[]) =>
        new Map(
          locators.map((item) => [
            item.mediaId,
            `https://media.example.invalid/${item.objectKey}`,
          ]),
        ),
    );
    const result = await new PostgresAuthoredArticleCatalogMediaResolver(pool, {
      resolveMany,
    }).resolveCatalog([
      { catalogId: "catalog-a", mediaId: "media-same" },
      { catalogId: "catalog-b", mediaId: "media-same" },
    ] as never);
    expect(resolveMany).toHaveBeenCalledTimes(2);
    expect(
      result.get(authoredArticleCatalogPairKey("catalog-a", "media-same"))?.src,
    ).toMatch(/\/a\.webp$/u);
    expect(
      result.get(authoredArticleCatalogPairKey("catalog-b", "media-same"))?.src,
    ).toMatch(/\/b\.webp$/u);
  });
  it("leaves unpublished/missing pairs unavailable and does no I/O for empty references", async () => {
    const { pool, query } = database([]);
    const resolveMany = vi.fn(async () => new Map());
    const resolver = new PostgresAuthoredArticleCatalogMediaResolver(pool, {
      resolveMany,
    });
    expect((await resolver.resolveCatalog([])).size).toBe(0);
    expect(query).not.toHaveBeenCalled();
    expect(
      (
        await resolver.resolveCatalog([
          { catalogId: "catalog-missing", mediaId: "media-missing" },
        ] as never)
      ).size,
    ).toBe(0);
    expect(resolveMany).not.toHaveBeenCalled();
  });
  it("rejects URL failures through the existing Catalog media failure boundary", async () => {
    const { pool } = database([
      catalogRow("catalog-a", "media-a", "synthetic/a.webp"),
    ]);
    await expect(
      new PostgresAuthoredArticleCatalogMediaResolver(pool, {
        resolveMany: async () => new Map(),
      }).resolveCatalog([
        { catalogId: "catalog-a", mediaId: "media-a" },
      ] as never),
    ).rejects.toThrow();
  });
});

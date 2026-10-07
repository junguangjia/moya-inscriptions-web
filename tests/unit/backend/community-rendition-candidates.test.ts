import { readFile } from "node:fs/promises";

import { describe, expect, it, vi } from "vitest";
import {
  articleMediaReferenceSchema,
  articleSummarySchema,
  publicMediaSchema,
  workMediaSchema,
} from "@moya/contracts/schemas";
import {
  CanonicalAuthoredArticleProjector,
  articleCatalogMediaKey,
} from "@moya/catalog-postgres";
import type { PublishedAuthoredArticleSummary } from "@moya/api";
import type { MediaRendition, PublicMedia, WorkMedia } from "@moya/contracts";

/*
 * Pure parts of the community rendition candidates (unified media pipeline,
 * increment 1, PR 1b): the list mapper of the read fragment, the D3 bound and
 * the card context of Article summaries. The SQL itself (framing keys, the
 * relay's authorization, D3 on real rows) is covered on real PostgreSQL in
 * integration/postgres/media-delivery-cases.ts.
 */

type Context = "card" | "detail";
interface RenditionRead {
  readonly toMediaRenditions: (
    rows: unknown,
    anchor: {
      readonly src: string;
      readonly width?: number;
      readonly height?: number;
    },
    context: Context,
    src: (role: string) => string,
  ) => MediaRendition[] | undefined;
  readonly PUBLIC_FULL_BOUNDS: Readonly<Record<string, number>>;
  readonly withinPublicPolicySql: (rendition: string) => string;
}
const { toMediaRenditions, PUBLIC_FULL_BOUNDS, withinPublicPolicySql } =
  (await import(
    new URL(
      "../../../services/community-postgres/src/publishing/rendition-read.ts",
      import.meta.url,
    ).href
  )) as RenditionRead;

const item = `media-item-${"a".repeat(32)}`;
const path = (role: string, editKey = "base") =>
  `/api/community/publishing/media/${item}/${role}/${editKey}`;
const row = (
  role: string,
  width: number,
  height: number,
  byteSize = 1000,
  contentType = "image/webp",
) => ({ role, width, height, contentType, byteSize });
const candidate = (role: string, width: number, height: number) => ({
  src: path(role),
  width,
  height,
  contentType: "image/webp",
});
const display = { src: path("display"), width: 2048, height: 1365 };
const frame = [
  row("thumb", 480, 320),
  row("cover", 1080, 720),
  row("display", 2048, 1365),
  row("viewer", 4096, 2731),
  row("full", 6000, 4000),
];

describe("community rendition candidates", () => {
  it("keeps the Owner's D3 bound for a public full in one place", async () => {
    expect(PUBLIC_FULL_BOUNDS).toEqual({
      maxLongEdge: 8192,
      longScrollAspectRatio: 2.5,
      longScrollMaxLongEdge: 16_000,
      longScrollMaxPixels: 40_000_000,
    });
    const sql = withinPublicPolicySql("r");
    for (const bound of ["<=8192", ">2.5*", "<=16000", "<=40000000"])
      expect(sql).toContain(bound);
    expect(sql).toContain("r.role<>'full'");
    // The long-scroll aspect and the pixel cap allow the half pixel by which
    // the recipe rounds each side of the scaled frame.
    expect(sql).toContain("+0.5>2.5*(LEAST(r.width,r.height)-0.5)");
    expect(sql).toContain("(r.width-0.5)*(r.height-0.5)<=40000000");
    // The Catalog delivery view spells exactly the same predicate.
    const view = await readFile(
      new URL(
        "../../../database/community-migrations/20261004020000_catalog_media_delivery.sql",
        import.meta.url,
      ),
      "utf8",
    );
    const compact = (text: string) => text.replace(/\s+/gu, "");
    expect(compact(view)).toContain(compact(sql));
  });

  it("lists every candidate ascending in a detail context and stops at the anchor in a card context", () => {
    const detail = toMediaRenditions(
      [...frame].reverse(),
      display,
      "detail",
      path,
    );
    expect(detail).toEqual([
      candidate("thumb", 480, 320),
      candidate("cover", 1080, 720),
      candidate("display", 2048, 1365),
      candidate("viewer", 4096, 2731),
      candidate("full", 6000, 4000),
    ]);
    expect(
      workMediaSchema.safeParse({
        id: item,
        kind: "static",
        ...display,
        renditions: detail,
      }).success,
    ).toBe(true);
    expect(toMediaRenditions(frame, display, "card", path)).toEqual([
      candidate("thumb", 480, 320),
      candidate("cover", 1080, 720),
      candidate("display", 2048, 1365),
    ]);
    expect(
      toMediaRenditions(
        frame,
        { src: path("cover"), width: 1080, height: 720 },
        "card",
        path,
      ),
    ).toEqual([candidate("thumb", 480, 320), candidate("cover", 1080, 720)]);
  });

  it("keeps one entry per size: the anchor, else the smaller blob, else the smaller recipe", () => {
    const small = { src: path("display"), width: 400, height: 300 };
    expect(
      toMediaRenditions(
        [
          row("thumb", 400, 300, 10),
          row("cover", 400, 300, 5),
          row("display", 400, 300, 50),
          row("full", 400, 300, 1),
        ],
        small,
        "detail",
        path,
      ),
    ).toEqual([candidate("display", 400, 300)]);
    expect(
      toMediaRenditions(
        [
          row("thumb", 300, 225, 40),
          row("cover", 300, 225, 30),
          row("display", 400, 300),
          row("viewer", 800, 600, 70),
          row("full", 800, 600, 70),
        ],
        small,
        "detail",
        path,
      ),
    ).toEqual([
      candidate("cover", 300, 225),
      candidate("display", 400, 300),
      candidate("viewer", 800, 600),
    ]);
  });

  it("omits the list without its anchor, of another framing or with nothing a client may receive", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    expect(
      toMediaRenditions(
        frame.filter((entry) => entry.role !== "display"),
        display,
        "detail",
        path,
      ),
    ).toBeUndefined();
    expect(
      toMediaRenditions(frame, display, "detail", (role) =>
        path(role, "f".repeat(32)),
      ),
    ).toBeUndefined();
    // Nonempty sets missing their anchor are defects, logged without content.
    expect(warn.mock.calls).toEqual([
      ["[community-media] rendition_fallback"],
      ["[community-media] rendition_fallback"],
    ]);
    warn.mockClear();
    // A square crop cannot join a 3:2 list, nor a 3:2 list a square parent:
    // a defect around a present anchor, logged without content.
    expect(
      toMediaRenditions(
        [row("thumb", 480, 480), ...frame.slice(2)],
        display,
        "detail",
        path,
      ),
    ).toBeUndefined();
    expect(
      toMediaRenditions(
        frame,
        { ...display, width: 1000, height: 1000 },
        "detail",
        path,
      ),
    ).toBeUndefined();
    expect(warn.mock.calls).toEqual([
      ["[community-media] rendition_fallback"],
      ["[community-media] rendition_fallback"],
    ]);
    warn.mockClear();
    expect(toMediaRenditions(null, display, "detail", path)).toBeUndefined();
    expect(toMediaRenditions("[]", display, "detail", path)).toBeUndefined();
    expect(warn).not.toHaveBeenCalled();
    // Rows a client never receives are ignored, never fatal.
    expect(
      toMediaRenditions(
        [
          ...frame.slice(2, 3),
          row("motion", 1920, 1280, 1000, "video/mp4"),
          row("tiles", 4096, 2731),
          row("full", 6000, 4000, 1000, "image/png"),
          row("viewer", 0, 2731),
          null,
          "full",
        ],
        display,
        "detail",
        path,
      ),
    ).toEqual([candidate("display", 2048, 1365)]);
    expect(warn.mock.calls).toEqual([["[community-media] rendition_fallback"]]);
    warn.mockRestore();
  });
});

describe("Article summaries are a card context", () => {
  const owner =
    `user-${"6".repeat(32)}` as PublishedAuthoredArticleSummary["ownerId"];
  const summary: PublishedAuthoredArticleSummary = {
    id: `article-${"5".repeat(32)}` as PublishedAuthoredArticleSummary["id"],
    ownerId: owner,
    version: 2,
    title: "合成文章",
    coverRefId: "cover",
    coverReference: { type: "managed", itemId: item },
    fingerprint: "a".repeat(64),
    byline: "合成作者",
    firstPublishedAt: "2026-10-04T00:00:00.000Z",
    publishedAt: "2026-10-04T00:00:00.000Z",
    updatedAt: "2026-10-04T00:00:00.000Z",
  };
  const managed: WorkMedia = {
    id: item,
    kind: "static",
    src: path("display"),
    width: 6000,
    height: 4000,
    renditions: toMediaRenditions(frame, display, "detail", path),
    placeholderColor: "#102030",
  };
  const catalogSrc = (width: number) =>
    `https://media.example.invalid/rendition-${width}.webp`;
  const catalog: PublicMedia = {
    id: `media-${"4".repeat(32)}` as PublicMedia["id"],
    kind: "image",
    src: catalogSrc(2048),
    alt: "合成图像",
    width: 2048,
    height: 1365,
    renditions: [
      [480, 320],
      [2048, 1365],
      [4096, 2731],
    ].map(([width, height]) => ({
      src: catalogSrc(width!),
      width: width!,
      height: height!,
      contentType: "image/webp" as const,
    })),
  };

  it("narrows a managed or Catalog summary cover to the candidates up to its anchor", async () => {
    const managedSummary = await new CanonicalAuthoredArticleProjector({
      resolveManaged: async () => new Map([[item, managed]]),
      resolveCatalog: async () => new Map(),
    }).summary(summary);
    expect(managedSummary.managedCover).toEqual({
      ...managed,
      renditions: [
        candidate("thumb", 480, 320),
        candidate("cover", 1080, 720),
        candidate("display", 2048, 1365),
      ],
    });
    expect(workMediaSchema.parse(managedSummary.managedCover)).toEqual(
      managedSummary.managedCover,
    );
    const { resolvedCover, ...rest } = managedSummary;
    expect(
      articleSummarySchema.safeParse({ ...rest, cover: resolvedCover ?? null })
        .success,
    ).toBe(true);

    const coverReference = articleMediaReferenceSchema.parse({
      type: "catalog",
      catalogId: "catalog-qa",
      mediaId: catalog.id,
    });
    if (coverReference.type !== "catalog") throw new Error("unexpected");
    const catalogSummary = await new CanonicalAuthoredArticleProjector({
      resolveManaged: async () => new Map(),
      resolveCatalog: async () =>
        new Map([
          [
            articleCatalogMediaKey(
              coverReference.catalogId,
              coverReference.mediaId,
            ),
            catalog,
          ],
        ]),
    }).summary({ ...summary, coverReference });
    expect(catalogSummary.resolvedCover).toEqual({
      ...catalog,
      renditions: catalog.renditions!.slice(0, 2),
    });
    expect(publicMediaSchema.parse(catalogSummary.resolvedCover)).toEqual(
      catalogSummary.resolvedCover,
    );
  });

  it("keeps a cover without candidates or anchor unchanged", async () => {
    const plain: WorkMedia = {
      id: item,
      kind: "static",
      src: path("display"),
      width: 6000,
      height: 4000,
    };
    const record = await new CanonicalAuthoredArticleProjector({
      resolveManaged: async () => new Map([[item, plain]]),
      resolveCatalog: async () => new Map(),
    }).summary(summary);
    expect(record.managedCover).toBe(plain);
  });
});

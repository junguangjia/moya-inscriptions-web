import { describe, expect, expectTypeOf, it } from "vitest";

import type {
  CatalogDetail,
  CatalogDetailMedia,
  CatalogZoomBlocks,
  CatalogZoomFrame,
} from "@moya/contracts";
import { catalogZoomBlocksJsonSchema } from "@moya/contracts/json-schema";
import {
  catalogDetailMediaSchema,
  catalogDetailSchema,
  catalogSummarySchema,
  catalogZoomBlockCount,
  catalogZoomBlocksSchema,
  publicMediaSchema,
} from "@moya/contracts/schemas";

/*
 * catalog-deep-zoom-v1 (Issue #295), criterion 11: Catalog Detail images gain
 * only the optional strict frame `zoom`, showing the image's framing in 2 to
 * 100 blocks; the per-image block list carries the frame, the fixed edge and
 * overlap and one resolved URL per row-major cell. Summary, card and public
 * media shapes are unchanged.
 */

const media = {
  id: "media-zoom-1",
  kind: "image",
  src: "https://media.example.invalid/display.webp",
  alt: "Rubbing",
  width: 2048,
  height: 1365,
  renditions: [
    {
      src: "https://media.example.invalid/display.webp",
      width: 2048,
      height: 1365,
      contentType: "image/webp",
    },
  ],
} as const;

const url = (cell: number) =>
  `https://images.example.invalid/v1/p/g/base/block-${String(cell).padStart(2, "0")}.r1.jpg`;

describe("Catalog Detail image zoom frame", () => {
  it("accepts a frame showing the image's framing in 2 to 100 blocks", () => {
    const parsed = catalogDetailMediaSchema.parse({
      ...media,
      zoom: { width: 8192, height: 5461 },
    });
    expect(parsed.zoom).toEqual({ width: 8192, height: 5461 });
    expect(catalogZoomBlockCount({ width: 8192, height: 5461 })).toBe(48);
    // Without a frame the image is exactly today's public media.
    expect(catalogDetailMediaSchema.parse(media)).toEqual(
      publicMediaSchema.parse(media),
    );
  });

  it("refuses another framing, a single block, more than 8192 px or extra keys", () => {
    for (const zoom of [
      { width: 8192, height: 5300 },
      { width: 1024, height: 683 },
      { width: 8193, height: 5462 },
      { width: 8192, height: 5461, cells: 48 },
      { width: 8192.5, height: 5461 },
    ])
      expect(
        catalogDetailMediaSchema.safeParse({ ...media, zoom }).success,
        JSON.stringify(zoom),
      ).toBe(false);
  });

  it("changes only Detail media: summaries, cards and public media refuse the key", () => {
    const zoomed = { ...media, zoom: { width: 8192, height: 5461 } };
    expect(publicMediaSchema.safeParse(zoomed).success).toBe(false);
    expect(
      catalogSummarySchema.safeParse({
        id: "catalog-1",
        kind: "inscription",
        title: "t",
        aliases: [],
        representativeMedia: zoomed,
      }).success,
    ).toBe(false);
    const detail = catalogDetailSchema.parse({
      id: "catalog-1",
      kind: "inscription",
      title: "t",
      aliases: [],
      sourceCitations: [],
      media: [zoomed],
    });
    expect(detail.media[0]?.zoom).toEqual({ width: 8192, height: 5461 });
    expectTypeOf<
      CatalogDetail["media"][number]
    >().toEqualTypeOf<CatalogDetailMedia>();
    expectTypeOf<
      NonNullable<CatalogDetailMedia["zoom"]>
    >().toEqualTypeOf<CatalogZoomFrame>();
  });
});

describe("Catalog image block list", () => {
  const blocks = (width: number, height: number, count: number) => ({
    width,
    height,
    edge: 1024,
    overlap: 2,
    srcs: Array.from({ length: count }, (_, cell) => url(cell)),
  });

  it("accepts one resolved URL per row-major cell of the frame", () => {
    const parsed: CatalogZoomBlocks = catalogZoomBlocksSchema.parse(
      blocks(8192, 5461, 48),
    );
    expect(parsed.srcs).toHaveLength(48);
    expect(
      catalogZoomBlocksSchema.parse(blocks(2048, 1365, 4)).srcs,
    ).toHaveLength(4);
  });

  it("refuses a wrong count, another edge or overlap, a relative URL or extra keys", () => {
    for (const candidate of [
      blocks(8192, 5461, 47),
      { ...blocks(8192, 5461, 48), edge: 512 },
      { ...blocks(8192, 5461, 48), overlap: 0 },
      {
        ...blocks(2048, 1365, 4),
        srcs: ["/block-00.jpg", url(1), url(2), url(3)],
      },
      { ...blocks(2048, 1365, 4), cells: 4 },
      blocks(1024, 683, 1),
      blocks(10240, 10240, 100),
    ])
      expect(catalogZoomBlocksSchema.safeParse(candidate).success).toBe(false);
  });

  it("exports a strict JSON Schema", () => {
    expect(catalogZoomBlocksJsonSchema).toMatchObject({
      type: "object",
      additionalProperties: false,
      required: ["width", "height", "edge", "overlap", "srcs"],
    });
  });
});

import { describe, expect, expectTypeOf, it } from "vitest";

import type {
  ContentCard,
  MediaRendition,
  PublicMedia,
  UserWork,
  WorkMedia,
} from "@moya/contracts";
import {
  authorCommunityJsonSchemas,
  publicMediaJsonSchema,
} from "@moya/contracts/json-schema";
import {
  MEDIA_RENDITIONS_MAXIMUM,
  addMediaRenditionAnchorIssues,
  cardMediaRenditionListSchema,
  mediaRenditionContentTypeSchema,
  mediaRenditionListOf,
  mediaRenditionListSchema,
  mediaRenditionPathParts,
  mediaRenditionPathSchema,
  mediaRenditionSchema,
  placeholderColorSchema,
  publicMediaRenditionListSchema,
  publicMediaRenditionSchema,
  publishedMediaUrlSchema,
  renditionDimensionSchema,
  resolvedMediaUrlSchema,
  sameMediaFraming,
} from "@moya/contracts/schemas";

const hex = (character: string) => character.repeat(32);
const itemId = `media-item-${hex("a")}`;
const editKey = hex("7");
const path = (role: string, key = "base", id = itemId) =>
  `/api/community/publishing/media/${id}/${role}/${key}`;
const published = (name: string) =>
  `https://img.example.invalid/v1/${hex("1")}/${hex("2")}/base/${name}.r1.webp`;
const signed = (name: string) =>
  `https://media.example.invalid/${name}.webp?sign=${hex("3")}&expires=300`;
const candidate = (
  src: string,
  width: number,
  height: number,
  contentType = "image/webp",
) => ({ src, width, height, contentType });

/** Recipe geometry: round to nearest, at least one pixel, never upscaled. */
const scaled = (width: number, height: number, scale: number) => ({
  width: Math.max(1, Math.round(width * Math.min(1, scale))),
  height: Math.max(1, Math.round(height * Math.min(1, scale))),
});
const longEdge = (width: number, height: number, edge: number) =>
  scaled(width, height, edge / Math.max(width, height));
const longScroll = (
  width: number,
  height: number,
  maxShortEdge: number,
  maxLongEdge: number,
  maxPixels: number,
) =>
  scaled(
    width,
    height,
    Math.min(
      maxShortEdge / Math.min(width, height),
      maxLongEdge / Math.max(width, height),
      Math.sqrt(maxPixels / (width * height)),
    ),
  );
/** Ascending candidates with one entry per size, as the builders emit them. */
const sizesOf = (width: number, height: number) => {
  const scroll = Math.max(width, height) > 2.5 * Math.min(width, height);
  const sizes = scroll
    ? [
        longEdge(width, height, 480),
        longEdge(width, height, 1_080),
        longScroll(width, height, 1_280, 16_000, 20_000_000),
        longScroll(width, height, Infinity, 16_000, 40_000_000),
      ]
    : [480, 1_080, 2_048, 4_096, 8_192].map((edge) =>
        longEdge(width, height, edge),
      );
  return sizes
    .sort((a, b) => a.width - b.width || a.height - b.height)
    .filter(
      (size, index, all) =>
        index === 0 ||
        size.width !== all[index - 1]!.width ||
        size.height !== all[index - 1]!.height,
    );
};

describe("media delivery URL forms", () => {
  it("allows a signed query only in Backend-resolved URLs", () => {
    for (const url of [
      signed("display"),
      "https://media.example.invalid/display.webp",
      "http://127.0.0.1:4100/v1/development/catalog-renditions/media-rendition-0123",
    ])
      expect(resolvedMediaUrlSchema.safeParse(url).success, url).toBe(true);
    // Published URLs require https, including on loopback hosts.
    for (const url of [
      published("display"),
      "https://img.example.invalid:8443/v1/display.webp",
      "https://img.example.invalid/",
    ])
      expect(publishedMediaUrlSchema.safeParse(url).success, url).toBe(true);
    for (const url of [
      signed("display"),
      "http://127.0.0.1:4100/v1/published/display.webp",
      "http://localhost:4100/v1/published/display.webp",
      "http://[::1]:4100/v1/published/display.webp",
      "http://127.0.0.1/display.webp",
      "http://img.example.invalid/display.webp",
      "http://192.0.2.10/display.webp",
      "http://127.0.0.2/display.webp",
      "http://127.0.0.1.example.invalid/display.webp",
      "http://localhost.example.invalid/display.webp",
      "http://user@127.0.0.1/display.webp",
      "http://127.0.0.1:4100?/display.webp",
      "https://img.example.invalid/display.webp?",
      "https://img.example.invalid/display.webp#frame",
      "https://user:example@img.example.invalid/display.webp",
      "https://user@img.example.invalid/display.webp",
      "https://img.example.invalid",
      "https://img.example.invalid/a b.webp",
      "https://img.example.invalid\\v1/display.webp",
      path("display"),
      "//img.example.invalid/display.webp",
      "ftp://img.example.invalid/display.webp",
      "data:image/webp;base64,UklGRg==",
    ])
      expect(publishedMediaUrlSchema.safeParse(url).success, url).toBe(false);
    for (const url of [
      path("display"),
      "ftp://media.example.invalid/display.webp",
      "javascript:alert('media')",
    ])
      expect(resolvedMediaUrlSchema.safeParse(url).success, url).toBe(false);
  });

  it("addresses only still renditions of a media item on the authorized path", () => {
    for (const role of ["thumb", "cover", "display", "viewer", "full"])
      for (const key of ["base", editKey])
        expect(
          mediaRenditionPathSchema.safeParse(path(role, key)).success,
        ).toBe(true);
    for (const src of [
      path("motion"),
      path("original"),
      path("display", hex("A")),
      path("display", "base", `media-item-${hex("A")}`),
      path("display", "base", `user-media-${hex("a")}`),
      `/api/community/media/user-media-${hex("a")}`,
      `${path("display")}?v=1`,
      `https://app.example.invalid${path("display")}`,
    ])
      expect(mediaRenditionPathSchema.safeParse(src).success, src).toBe(false);
    expect(mediaRenditionPathParts(path("viewer", editKey))).toEqual({
      itemId,
      editKey,
    });
    for (const src of [
      path("motion"),
      published("display"),
      `/api/community/media/user-media-${hex("a")}`,
    ])
      expect(mediaRenditionPathParts(src)).toBeNull();
  });
});

describe("rendition candidates", () => {
  it("are strict real-dimension images with a WebP or JPEG content type", () => {
    const valid = candidate(signed("display"), 2_048, 1_365);
    expect(publicMediaRenditionSchema.parse(valid)).toEqual(valid);
    expect(
      mediaRenditionSchema.safeParse(
        candidate(path("viewer"), 4_096, 2_731, "image/jpeg"),
      ).success,
    ).toBe(true);
    expect(mediaRenditionContentTypeSchema.options).toEqual([
      "image/webp",
      "image/jpeg",
    ]);
    for (const invalid of [
      { ...valid, contentType: "image/png" },
      { ...valid, contentType: "image/avif" },
      { ...valid, contentType: "IMAGE/WEBP" },
      { ...valid, width: 0 },
      { ...valid, height: 1.5 },
      { ...valid, width: 65_536 },
      { ...valid, src: path("display") },
      { ...valid, objectKey: "display/v1/example.webp" },
      { ...valid, bucket: "private" },
      { ...valid, storageKey: "blobs/aa/bb/example" },
      { ...valid, role: "display" },
    ])
      expect(publicMediaRenditionSchema.safeParse(invalid).success).toBe(false);
    for (const src of [signed("display"), path("motion")])
      expect(
        mediaRenditionSchema.safeParse({ ...valid, src }).success,
        src,
      ).toBe(false);
    expect(renditionDimensionSchema.safeParse(65_535).success).toBe(true);
    expectTypeOf<MediaRendition>().toEqualTypeOf<{
      src: string;
      width: number;
      height: number;
      contentType: "image/webp" | "image/jpeg";
    }>();
    // Every attach point carries the same optional candidate list.
    expectTypeOf<PublicMedia["renditions"]>().toEqualTypeOf<
      MediaRendition[] | undefined
    >();
    expectTypeOf<WorkMedia["renditions"]>().toEqualTypeOf<
      MediaRendition[] | undefined
    >();
    expectTypeOf<
      NonNullable<ContentCard["media"]>["renditions"]
    >().toEqualTypeOf<MediaRendition[] | undefined>();
    expectTypeOf<UserWork["coverRenditions"]>().toEqualTypeOf<
      MediaRendition[] | undefined
    >();
    expectTypeOf<PublicMedia["placeholderColor"]>().toEqualTypeOf<
      string | undefined
    >();
  });

  it("paints only a lowercase six-digit placeholder colour", () => {
    expect(placeholderColorSchema.safeParse("#5f6f58").success).toBe(true);
    for (const color of [
      "#5F6F58",
      "#abc",
      "5f6f58",
      "#5f6f5880",
      "#5f6f5g",
      "rgb(95,111,88)",
      "",
    ])
      expect(placeholderColorSchema.safeParse(color).success, color).toBe(
        false,
      );
  });
});

describe("one framing per rendition list", () => {
  it.each([
    [9_504, 6_336],
    [6_024, 4_024],
    [4_096, 2_731],
    [3_001, 1_999],
    [2_731, 4_096],
    [1_500, 20_000],
    [20_000, 1_500],
    [37, 23],
    [60, 60_000],
  ])("keeps every recipe size of %i×%i in one framing", (width, height) => {
    const sizes = sizesOf(width, height);
    for (const size of sizes) {
      expect(sameMediaFraming(sizes[0]!, size)).toBe(true);
      expect(sameMediaFraming({ width, height }, size)).toBe(true);
    }
    const list = sizes.map((size, index) =>
      candidate(published(`r${index}`), size.width, size.height),
    );
    expect(publicMediaRenditionListSchema.safeParse(list).success).toBe(true);
    expect(mediaRenditionListSchema.safeParse(list).success).toBe(true);
  });

  it("tells a cover crop, a transposed frame or another aspect apart", () => {
    const frame = { width: 2_048, height: 1_365 };
    for (const other of [
      { width: 1_080, height: 1_080 },
      { width: 480, height: 480 },
      { width: 1_365, height: 2_048 },
      { width: 480, height: 330 },
    ])
      expect(sameMediaFraming(frame, other), JSON.stringify(other)).toBe(false);
    expect(
      publicMediaRenditionListSchema.safeParse([
        candidate(signed("cover"), 1_080, 1_080),
        candidate(signed("display"), 2_048, 1_365),
      ]).success,
    ).toBe(false);
  });
});

describe("rendition list rules", () => {
  const list = [
    candidate(path("thumb", editKey), 480, 320),
    candidate(path("cover", editKey), 1_080, 720),
    candidate(path("display", editKey), 2_048, 1_365),
    candidate(path("viewer", editKey), 4_096, 2_731),
    candidate(path("full", editKey), 8_192, 5_461),
  ];

  it("accepts one to eight ascending candidates of one size each", () => {
    expect(mediaRenditionListSchema.parse(list)).toEqual(list);
    expect(mediaRenditionListSchema.safeParse(list.slice(0, 1)).success).toBe(
      true,
    );
    expect(MEDIA_RENDITIONS_MAXIMUM).toBe(8);
    const eight = Array.from({ length: 8 }, (_, index) =>
      candidate(published(`r${index}`), 300 + index * 3, 200 + index * 2),
    );
    expect(publicMediaRenditionListSchema.safeParse(eight).success).toBe(true);
    for (const invalid of [
      [],
      [...eight, candidate(published("r8"), 300 + 8 * 3, 200 + 8 * 2)],
      [list[1], list[0]],
      [list[0], list[0]],
      [list[2], { ...list[2]!, src: path("viewer", editKey) }],
    ])
      expect(
        mediaRenditionListSchema.safeParse(invalid).success,
        JSON.stringify(invalid),
      ).toBe(false);
  });

  it("keeps one delivery form, one item and one edit per list", () => {
    for (const invalid of [
      [list[0], { ...list[1]!, src: published("cover") }],
      [{ ...list[0]!, src: published("thumb") }, list[1]],
      [list[0], { ...list[1]!, src: path("cover", "base") }],
      [list[0], { ...list[1]!, src: path("cover", hex("8")) }],
      [
        list[0],
        { ...list[1]!, src: path("cover", editKey, `media-item-${hex("b")}`) },
      ],
    ])
      expect(
        mediaRenditionListSchema.safeParse(invalid).success,
        JSON.stringify(invalid),
      ).toBe(false);
    expect(
      mediaRenditionListSchema.safeParse(
        list.map((entry, index) => ({ ...entry, src: published(`r${index}`) })),
      ).success,
    ).toBe(true);
  });

  it("gives a content card the Catalog form or the community form, never a mix", () => {
    const catalog = [
      candidate(signed("thumb"), 480, 270),
      candidate(signed("cover"), 1_080, 608),
      candidate(signed("display"), 1_600, 900),
    ];
    const work = [
      candidate(path("thumb", editKey), 480, 480),
      candidate(path("cover", editKey), 1_080, 1_080),
    ];
    for (const valid of [
      catalog,
      work,
      work.map((entry, index) => ({ ...entry, src: published(`r${index}`) })),
    ])
      expect(cardMediaRenditionListSchema.safeParse(valid).success).toBe(true);
    for (const invalid of [
      [catalog[0], { ...catalog[1]!, src: path("cover", editKey) }],
      [{ ...work[0]!, src: signed("thumb") }, work[1]],
      [{ ...catalog[0]!, objectKey: "display/v1/thumb.webp" }],
    ])
      expect(
        cardMediaRenditionListSchema.safeParse(invalid).success,
        JSON.stringify(invalid),
      ).toBe(false);
  });

  it("builds the same rules around another candidate schema", () => {
    const listOf = mediaRenditionListOf(publicMediaRenditionSchema);
    const catalog = [
      candidate(signed("thumb"), 480, 320),
      candidate(signed("display"), 2_048, 1_365),
    ];
    expect(listOf.parse(catalog)).toEqual(catalog);
    expect(listOf.safeParse([catalog[1], catalog[0]]).success).toBe(false);
    expect(listOf.safeParse([candidate(path("thumb"), 480, 320)]).success).toBe(
      false,
    );
  });
});

describe("rendition anchor", () => {
  type Context = Parameters<typeof addMediaRenditionAnchorIssues>[2];
  const issuesOf = (
    parent: Parameters<typeof addMediaRenditionAnchorIssues>[0],
    list: Parameters<typeof addMediaRenditionAnchorIssues>[1],
    path?: readonly PropertyKey[],
  ) => {
    const issues: unknown[] = [];
    const context = {
      value: parent,
      issues: [],
      addIssue: (issue: unknown) => issues.push(issue),
    } as unknown as Context;
    addMediaRenditionAnchorIssues(parent, list, context, path);
    return issues;
  };
  const list = [
    candidate(published("thumb"), 480, 320),
    candidate(published("display"), 2_048, 1_365),
  ];

  it("names the parent src among the candidates of the parent framing", () => {
    expect(
      issuesOf(
        { src: published("display"), width: 2_048, height: 1_365 },
        list,
      ),
    ).toEqual([]);
    // A parent without a size (a work cover) checks only the anchor.
    expect(issuesOf({ src: published("thumb") }, list)).toEqual([]);
    // Article media keep their presentation size, a larger frame of one aspect.
    expect(
      issuesOf(
        { src: published("display"), width: 6_144, height: 4_096 },
        list,
      ),
    ).toEqual([]);
    expect(
      issuesOf({ src: published("viewer"), width: 2_048, height: 1_365 }, list),
    ).toEqual([
      expect.objectContaining({
        path: ["renditions"],
        message: "src is one of its renditions",
      }),
    ]);
    expect(issuesOf({ src: null }, list, ["coverRenditions"])).toEqual([
      expect.objectContaining({ path: ["coverRenditions"] }),
    ]);
    expect(
      issuesOf(
        { src: published("display"), width: 1_080, height: 1_080 },
        list,
      ),
    ).toEqual([
      expect.objectContaining({
        path: ["renditions"],
        message: "renditions share the media framing",
      }),
    ]);
  });
});

describe("media delivery JSON Schemas", () => {
  const propertiesOf = (schema: unknown) =>
    (schema as { properties: Record<string, unknown> }).properties;

  it("serializes strict candidates with no description text", () => {
    const publicMedia = propertiesOf(publicMediaJsonSchema);
    const workMedia = propertiesOf(
      (
        propertiesOf(authorCommunityJsonSchemas.UserWork).media as {
          items: unknown;
        }
      ).items,
    );
    const cardMedia = propertiesOf(
      (
        propertiesOf(authorCommunityJsonSchemas.ContentCard).media as {
          anyOf: unknown[];
        }
      ).anyOf[0],
    );
    const renditions = publicMedia.renditions;
    expect(renditions).toMatchObject({
      type: "array",
      minItems: 1,
      maxItems: 8,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["src", "width", "height", "contentType"],
        properties: {
          contentType: { enum: ["image/webp", "image/jpeg"] },
          width: { maximum: 65_535 },
        },
      },
    });
    const delivery = JSON.stringify([
      renditions,
      publicMedia.placeholderColor,
      propertiesOf(authorCommunityJsonSchemas.UserWork).coverRenditions,
      workMedia.renditions,
      workMedia.placeholderColor,
      cardMedia.renditions,
      cardMedia.placeholderColor,
    ]).toLowerCase();
    for (const fragment of [
      publicMedia.placeholderColor,
      workMedia.renditions,
      cardMedia.renditions,
      propertiesOf(authorCommunityJsonSchemas.UserWork).coverRenditions,
    ])
      expect(fragment).toBeDefined();
    expect(delivery).toContain("^#[0-9a-f]{6}$");
    expect(delivery).not.toContain("description");
    for (const term of [
      "candidate",
      "review",
      "images",
      "city",
      "objectkey",
      "object_key",
      "bucket",
      "storage",
      "role",
    ])
      expect(delivery).not.toContain(term);
  });
});

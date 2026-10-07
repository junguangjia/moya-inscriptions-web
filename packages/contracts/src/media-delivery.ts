import { z } from "zod";

/**
 * Media delivery (unified-media-pipeline-v1): the URL forms a client may
 * receive for an image, the finite rendition candidates of one framing and
 * the placeholder colour of an opaque image. Every URL arrives fully formed
 * from the Backend; clients never compose, sign or rewrite one, and no
 * storage key, bucket or provider detail reaches them. This module depends
 * only on zod so the public, work publishing and Article shapes can share
 * it. Its schemas carry no description text: the OpenAPI term scan reads
 * serialized schemas.
 */

/**
 * An absolute http(s) URL resolved by the Backend: a short-lived private
 * read, an unsigned published URL or a Development loopback URL.
 */
export const resolvedMediaUrlSchema = z
  .url({ protocol: /^https?$/ })
  .and(z.string().regex(/^[Hh][Tt][Tt][Pp][Ss]?:\/\//));

/**
 * An unsigned published URL: absolute https, with a path and without
 * credentials, query or fragment, so no signature or token can travel in it.
 * Backslashes, which URL parsers read differently, are refused too.
 */
export const publishedMediaUrlSchema = z
  .url({ protocol: /^https$/ })
  .and(
    z.string().regex(/^[Hh][Tt][Tt][Pp][Ss]:\/\/[^\s/\\?#@]+\/[^\s\\?#]*$/u),
  );

const renditionPathPattern =
  /^\/api\/community\/publishing\/media\/(media-item-[0-9a-f]{32})\/(thumb|cover|display|viewer|full)\/(base|[0-9a-f]{32})$/u;

/** The same-origin authorized read of one still rendition of a media item. */
export const mediaRenditionPathSchema = z.string().regex(renditionPathPattern);

/** The item id and edit key a rendition path names, or null for any other value. */
export const mediaRenditionPathParts = (
  src: string,
): { readonly itemId: string; readonly editKey: string } | null => {
  const [, itemId, , editKey] = renditionPathPattern.exec(src) ?? [];
  return itemId === undefined || editKey === undefined
    ? null
    : { itemId, editKey };
};

/** At most this many candidates describe one image in one context. */
export const MEDIA_RENDITIONS_MAXIMUM = 8;
export const renditionDimensionSchema = z.number().int().positive().max(65_535);
export const mediaRenditionContentTypeSchema = z.enum([
  "image/webp",
  "image/jpeg",
]);
/** Painted while an opaque image loads; absent for an image with transparency. */
export const placeholderColorSchema = z.string().regex(/^#[0-9a-f]{6}$/u);

const renditionOf = <Src extends z.ZodType<string>>(src: Src) =>
  z.strictObject({
    src,
    width: renditionDimensionSchema,
    height: renditionDimensionSchema,
    contentType: mediaRenditionContentTypeSchema,
  });

/** A Catalog or editorial candidate: an absolute resolved URL, as `PublicMedia.src`. */
export const publicMediaRenditionSchema = renditionOf(resolvedMediaUrlSchema);

/** A community candidate: an unsigned published URL or the authorized same-origin path. */
export const mediaRenditionSchema = renditionOf(
  z.union([publishedMediaUrlSchema, mediaRenditionPathSchema]),
);

/** One candidate: a complete image of its list's framing, without a role. */
export type MediaRendition = z.infer<typeof mediaRenditionSchema>;

interface MediaSize {
  readonly width: number;
  readonly height: number;
}

interface MediaRenditionCandidate extends MediaSize {
  readonly src: string;
}

/**
 * The largest rounding error of one side of a scaled image: half a pixel, or
 * just under one pixel for a side rounded up to the one-pixel minimum.
 */
const sideError = (side: number): number => (side <= 1 ? 1 : 0.5);

/**
 * Whether two sizes show one framing: their aspect ratios agree within the
 * independent rounding of every side (round to nearest, at least one pixel).
 * A cover crop of another aspect is another framing; two crops of the same
 * aspect cannot be told apart by size, which the builders' framing key and
 * the same-origin edit key cover.
 */
export const sameMediaFraming = (a: MediaSize, b: MediaSize): boolean => {
  const aw = sideError(a.width);
  const ah = sideError(a.height);
  const bw = sideError(b.width);
  const bh = sideError(b.height);
  return (
    Math.abs(a.width * b.height - a.height * b.width) <=
    a.width * bh +
      b.height * aw +
      aw * bh +
      a.height * bw +
      b.width * ah +
      ah * bw
  );
};

const isAbsoluteMediaSrc = (src: string): boolean =>
  /^[Hh][Tt][Tt][Pp][Ss]?:\/\//u.test(src);

/**
 * One list is one framing of one image: strictly ascending sizes (one entry
 * per size), one delivery form (every `src` absolute or every `src` a
 * same-origin path) and, for paths, one item and one edit key.
 */
const addRenditionListIssues = (
  list: readonly MediaRenditionCandidate[],
  context: z.RefinementCtx,
): void => {
  const [first] = list;
  if (first === undefined) return;
  const firstPath = mediaRenditionPathParts(first.src);
  for (let index = 1; index < list.length; index++) {
    const entry = list[index]!;
    const previous = list[index - 1]!;
    if (!(
      entry.width > previous.width ||
      (entry.width === previous.width && entry.height > previous.height)
    ))
      context.addIssue({
        code: "custom",
        path: [index, "width"],
        message: "renditions ascend with distinct sizes",
      });
    if (!sameMediaFraming(first, entry))
      context.addIssue({
        code: "custom",
        path: [index],
        message: "one framing per rendition list",
      });
    if (isAbsoluteMediaSrc(entry.src) !== isAbsoluteMediaSrc(first.src))
      context.addIssue({
        code: "custom",
        path: [index, "src"],
        message: "one delivery form per rendition list",
      });
    const path = mediaRenditionPathParts(entry.src);
    if (
      firstPath !== null &&
      path !== null &&
      (path.itemId !== firstPath.itemId || path.editKey !== firstPath.editKey)
    )
      context.addIssue({
        code: "custom",
        path: [index, "src"],
        message: "one item and edit per rendition list",
      });
  }
};

/** A finite rendition list (1 to 8 candidates) of one framing and one delivery form. */
export const mediaRenditionListOf = <
  Entry extends z.ZodType<MediaRenditionCandidate>,
>(
  entry: Entry,
) =>
  z
    .array(entry)
    .min(1)
    .max(MEDIA_RENDITIONS_MAXIMUM)
    .superRefine(addRenditionListIssues);

/** Catalog and editorial lists: absolute resolved URLs only. */
export const publicMediaRenditionListSchema = mediaRenditionListOf(
  publicMediaRenditionSchema,
);
/** Community lists: every candidate published, or every candidate on the authorized path. */
export const mediaRenditionListSchema =
  mediaRenditionListOf(mediaRenditionSchema);
/**
 * A content card shows Catalog or work media: a whole list is either the
 * Catalog form or the community form, never a mix.
 */
export const cardMediaRenditionListSchema = z.union([
  publicMediaRenditionListSchema,
  mediaRenditionListSchema,
]);

/**
 * The parent rules of a rendition list: the parent `src` is one candidate
 * (the anchor, the display-level image of its context), and a parent with a
 * size shows the list's framing. Candidates wider than the anchor are zoom
 * levels; clients never need a role.
 */
export const addMediaRenditionAnchorIssues = (
  parent: {
    readonly src: string | null | undefined;
    readonly width?: number;
    readonly height?: number;
  },
  list: readonly MediaRenditionCandidate[],
  context: z.RefinementCtx,
  path: readonly PropertyKey[] = ["renditions"],
): void => {
  if (!list.some((entry) => entry.src === parent.src))
    context.addIssue({
      code: "custom",
      path: [...path],
      message: "src is one of its renditions",
    });
  const [first] = list;
  if (
    first !== undefined &&
    parent.width !== undefined &&
    parent.height !== undefined &&
    !sameMediaFraming({ width: parent.width, height: parent.height }, first)
  )
    context.addIssue({
      code: "custom",
      path: [...path],
      message: "renditions share the media framing",
    });
};

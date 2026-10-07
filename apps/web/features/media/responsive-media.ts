import type { CSSProperties } from "react";

import type { PresentationPlatform } from "../shell/device-platform";

/**
 * unified-media-pipeline-v1 (CW13): responsive images from the rendition
 * candidates a DTO carries. Every URL arrives fully formed from the Backend;
 * this module never composes, signs or rewrites one. `src` stays the anchor
 * (the candidate whose `src` equals the media's `src`), so it is also the
 * fallback for a browser without `srcset`. Card and inline surfaces offer
 * candidates up to the anchor; wider candidates are zoom levels for the
 * Viewer only. `sizes` values follow the CSS boxes each surface draws.
 */

/** One rendition candidate as Web reads it: Catalog, work and Article lists alike. */
export interface RenditionCandidate {
  readonly src: string;
  readonly width: number;
  readonly height: number;
}

/** The media fields a responsive image reads. */
export interface ResponsiveMediaSource {
  readonly src: string;
  readonly width: number;
  readonly height: number;
  readonly renditions?: readonly RenditionCandidate[] | undefined;
}

export interface ResponsiveImage {
  readonly src: string;
  readonly srcSet?: string;
  readonly sizes?: string;
}

interface MediaSize {
  readonly width: number;
  readonly height: number;
}

const isCandidate = (value: unknown): value is RenditionCandidate => {
  if (typeof value !== "object" || value === null) return false;
  const { src, width, height } = value as Record<string, unknown>;
  return (
    typeof src === "string" &&
    src !== "" &&
    Number.isInteger(width) &&
    (width as number) > 0 &&
    Number.isInteger(height) &&
    (height as number) > 0
  );
};

/**
 * Every usable candidate of a media list, ascending by width with one entry
 * per width, or none when the list is absent, malformed or does not contain
 * the anchor. Strict contract parsing already guarantees the shape; the
 * check also keeps tolerant sources (Topics) from emitting a broken list.
 */
const usableRenditions = (
  media: ResponsiveMediaSource,
): readonly RenditionCandidate[] => {
  const list: unknown = media.renditions;
  if (!Array.isArray(list) || !list.every(isCandidate)) return [];
  if (!list.some((entry) => entry.src === media.src)) return [];
  const widths = new Set<number>();
  return [...list]
    .sort((a, b) => a.width - b.width || a.height - b.height)
    .filter((entry) => {
      if (widths.has(entry.width)) return false;
      widths.add(entry.width);
      return true;
    });
};

/** The smallest candidate at least `demandPx` wide, else the widest. */
export const pickRendition = (
  list: readonly RenditionCandidate[],
  demandPx: number,
): RenditionCandidate | undefined =>
  list.find((entry) => entry.width >= demandPx) ?? list.at(-1);

/** Candidates up to and including the anchor: what cards and inline images may load. */
export const inlineRenditions = (
  media: ResponsiveMediaSource,
): readonly RenditionCandidate[] => {
  const list = usableRenditions(media);
  const anchor = list.find((entry) => entry.src === media.src);
  return anchor === undefined
    ? []
    : list.filter((entry) => entry.width <= anchor.width);
};

/**
 * A `srcset` with `w` descriptors, one per width. A URL containing
 * whitespace or a comma cannot be written into `srcset` unambiguously, so
 * such a list yields none and the image keeps its `src`.
 */
export const srcSetOf = (
  list: readonly RenditionCandidate[],
): string | undefined => {
  if (list.length === 0 || list.some((entry) => /[\s,]/u.test(entry.src)))
    return undefined;
  const widths = new Set<number>();
  const parts: string[] = [];
  for (const entry of [...list].sort((a, b) => a.width - b.width)) {
    if (widths.has(entry.width)) continue;
    widths.add(entry.width);
    parts.push(`${entry.src} ${entry.width}w`);
  }
  return parts.join(", ");
};

/**
 * `src` (the anchor, unchanged) plus `srcSet` and `sizes` when the media
 * offers at least two inline candidates. With `w` descriptors the browser
 * never adds `src` as a candidate, so it is a pure fallback.
 */
export const responsiveImage = (
  media: ResponsiveMediaSource,
  sizes: string,
): ResponsiveImage => {
  const inline = inlineRenditions(media);
  const srcSet = inline.length < 2 ? undefined : srcSetOf(inline);
  return srcSet === undefined
    ? { src: media.src }
    : { src: media.src, srcSet, sizes };
};

/**
 * The asset colour behind a box that is exactly covered by the image (cover
 * fit or the image's own aspect), shown until the image paints. Absent for an
 * image with transparency, and never used on contain surfaces, whose
 * letterbox would stay tinted.
 */
export const placeholderStyle = (
  color: string | undefined,
): CSSProperties | undefined =>
  color !== undefined && /^#[0-9a-f]{6}$/u.test(color)
    ? { backgroundColor: color }
    : undefined;

/** `high`: eager at high fetch priority; `eager`: eager at the default priority. */
export type MediaPriority = "high" | "eager";

/**
 * The first visible page's first card is its likely Largest Contentful Paint:
 * index 0 loads eagerly at high priority, index 1 eagerly, the rest lazily.
 */
export const listMediaPriority = (index: number): MediaPriority | undefined =>
  index === 0 ? "high" : index === 1 ? "eager" : undefined;

/** Loading attributes for a list image; without a priority the image stays lazy. */
export const mediaLoading = (
  priority: MediaPriority | undefined,
): {
  readonly loading: "eager" | "lazy";
  readonly fetchPriority?: "high";
} =>
  priority === undefined
    ? { loading: "lazy" }
    : priority === "high"
      ? { loading: "eager", fetchPriority: "high" }
      : { loading: "eager" };

// ---------------------------------------------------------------------------
// Viewer (CW14): progressive candidates without srcset.

/** The initial Viewer image stays a bounded single bitmap (4096² pixels). */
export const VIEWER_INITIAL_MAX_PIXELS = 16_777_216;
/** A wider candidate loads only when zoom demand exceeds the current width by this factor. */
export const VIEWER_UPGRADE_HEADROOM = 1.15;
/** The transform must rest this long before an upgrade is requested. */
export const VIEWER_UPGRADE_SETTLE_MS = 120;

/** Every candidate the Viewer may show, zoom levels included, ascending. */
export const viewerRenditions = (
  media: ResponsiveMediaSource,
): readonly RenditionCandidate[] => usableRenditions(media);

/**
 * The candidate the Viewer opens on: the smallest at least `demandPx` (the
 * fitted CSS width times the device pixel ratio) wide among candidates within
 * {@link VIEWER_INITIAL_MAX_PIXELS}, else the largest of them. A long-scroll
 * anchor above that bound is available through the decoded upgrade path.
 * Undefined without a usable list (the Viewer then keeps today's source).
 */
export const viewerInitialRendition = (
  media: ResponsiveMediaSource,
  demandPx: number,
): RenditionCandidate | undefined =>
  pickRendition(
    viewerRenditions(media).filter(
      (entry) => entry.width * entry.height <= VIEWER_INITIAL_MAX_PIXELS,
    ),
    demandPx,
  );

/**
 * The next candidate once zoom demand (`demandPx`: the fitted width times the
 * scale and the device pixel ratio) exceeds the current candidate by the
 * headroom: the smallest wider candidate covering the demand, else the
 * widest. Undefined when no upgrade is due. A candidate that failed earlier
 * (`refused`) is never offered again.
 */
export const viewerUpgradeRendition = (
  media: ResponsiveMediaSource,
  current: RenditionCandidate,
  demandPx: number,
  refused: ReadonlySet<string> = new Set(),
): RenditionCandidate | undefined =>
  demandPx > current.width * VIEWER_UPGRADE_HEADROOM
    ? pickRendition(
        viewerRenditions(media).filter(
          (entry) => entry.width > current.width && !refused.has(entry.src),
        ),
        demandPx,
      )
    : undefined;

// ---------------------------------------------------------------------------
// `sizes` per surface. Every value is an upper bound of the CSS width the
// image is drawn at (a larger candidate costs bytes; a smaller one blurs).
// Spacing: --yoyi-space-3 8px, -4 12px, -5 16px, -6 20px, -8 32px, -9 40px,
// -10 48px. Platforms (device-platform.ts): phone below 768px or any phone,
// tablet 768-895px or any tablet, pc from 896px on a desktop; a desktop
// pointer separates pc from a tablet of the same width.

/** A width of `vw` viewport per cent plus `px` pixels. */
interface Linear {
  readonly vw: number;
  readonly px: number;
}

const epsilon = 1e-9;
const roundUp = (value: number, places: number): number => {
  const scale = 10 ** places;
  return Math.ceil(value * scale - epsilon) / scale;
};
const px = (value: number): string => `${roundUp(value, 0)}px`;
const linear = ({ vw, px: offset }: Linear): string => {
  const v = roundUp(vw, 2);
  const p = roundUp(offset, 0);
  if (p === 0) return `${v}vw`;
  if (v === 0) return `${p}px`;
  return `calc(${v}vw ${p < 0 ? "-" : "+"} ${Math.abs(p)}px)`;
};
const scale = ({ vw, px: offset }: Linear, factor: number): Linear => ({
  vw: vw * factor,
  px: offset * factor,
});
const aspectOf = ({ width, height }: MediaSize): number =>
  Number.isFinite(width / height) && width > 0 && height > 0
    ? width / height
    : 1;

const desktop = "(hover: hover) and (pointer: fine)";
const minWidthOnly = /^\(min-width: \d+px\)$/u;

/**
 * Joins `(media) value` entries in order. A plain `(min-width)` entry whose
 * value repeats the next entry's is dropped when that entry is the fallback
 * or a smaller `(min-width)`, which then covers it.
 */
const sizesOf = (
  entries: readonly (readonly [condition: string, value: string])[],
  fallback: string,
): string => {
  const kept: string[] = [];
  entries.forEach(([condition, value], index) => {
    const next = entries[index + 1];
    const covered =
      minWidthOnly.test(condition) &&
      (next === undefined
        ? value === fallback
        : minWidthOnly.test(next[0]) && value === next[1]);
    if (!covered) kept.push(`${condition} ${value}`);
  });
  return [...kept, fallback].join(", ");
};

/**
 * `min(column, cap)` where the column is `wide` pixels from `wideFrom` and
 * `narrow` below it: the cap takes over from the viewport where the narrow
 * column reaches it. When that happens at or below `lowest` (the narrowest
 * viewport of the surface), the cap alone bounds every narrower viewport.
 */
const cappedColumn = (
  lowest: number,
  wideFrom: number,
  wide: number,
  narrow: Linear,
  cap: number,
): string => {
  const crossover = ((cap - narrow.px) * 100) / narrow.vw;
  const entries: [string, string][] = [
    [`(min-width: ${wideFrom}px)`, px(Math.min(wide, cap))],
  ];
  if (crossover <= lowest) return sizesOf(entries, px(cap));
  if (crossover < wideFrom)
    entries.push([`(min-width: ${roundUp(crossover, 0)}px)`, px(cap)]);
  return sizesOf(entries, linear(narrow));
};

/** Where a card sits in a masonry list (catalog-masonry.tsx). */
export interface MediaSlot {
  readonly platform: PresentationPlatform;
  /** 1 for the single layout, 2 for the double layout, 3 to 8 on pc. */
  readonly columns: number;
  /** A feature or panorama card covering every column. */
  readonly span: boolean;
}

/**
 * Card width of a masonry slot (home-screen.module.css .feedPanel padding,
 * catalog-masonry gaps): phone 8px padding and 12px gap, tablet 16px and
 * 20px; pc columns of 220-320px (catalog-masonry-layout.ts), wider only with
 * eight columns from a 2757px viewport (2 × 28px padding, 7 × 20px gaps).
 */
const masonrySizes = (slot: MediaSlot, factor: number): string => {
  if (slot.platform === "pc")
    return sizesOf(
      [["(min-width: 2757px)", linear(scale({ vw: 12.5, px: -24.5 }, factor))]],
      px(320 * factor),
    );
  const full = slot.columns < 2 || slot.span;
  const width: Linear =
    slot.platform === "tablet"
      ? full
        ? { vw: 100, px: -32 }
        : { vw: 50, px: -26 }
      : full
        ? { vw: 100, px: -16 }
        : { vw: 50, px: -14 };
  return linear(scale(width, factor));
};

/**
 * Card width outside a masonry: the `.feed` column layout (.screen padding
 * 8/16/20px, gaps 8/16px; pc 3, 4 from 1024px, 5 from 1440px columns), the
 * double layout assumed on touch screens.
 */
const columnFeedSizes = (factor: number): string =>
  sizesOf(
    [
      [
        `(min-width: 1440px) and ${desktop}`,
        linear(scale({ vw: 20, px: -20.8 }, factor)),
      ],
      [
        `(min-width: 1024px) and ${desktop}`,
        linear(scale({ vw: 25, px: -22 }, factor)),
      ],
      [
        `(min-width: 896px) and ${desktop}`,
        linear(scale({ vw: 100 / 3, px: -24 }, factor)),
      ],
    ],
    linear(scale({ vw: 50, px: -12 }, factor)),
  );

/**
 * The feed box keeps a ratio clamped to [3:4, 3:2] (catalog-card.tsx) and
 * covers it, so an image wider than 3:2 is drawn wider than its box; the
 * factor is bounded at 2 so a panorama does not pull the anchor for a thumb.
 */
export const coverFitFactor = (media: MediaSize): number =>
  Math.min(2, Math.max(1, aspectOf(media) / 1.5));

export const MEDIA_SIZES = {
  /** Catalog, work and nearby feed cards (home-screen.module.css .feedMedia). */
  feedCard: (media: MediaSize, slot?: MediaSlot | null): string => {
    const factor = coverFitFactor(media);
    return slot ? masonrySizes(slot, factor) : columnFeedSizes(factor);
  },
  /**
   * Inscription list thumbnail (.inscriptionMedia): a fixed box covered by
   * the image, 88×104 phone, 112×120 tablet, 128×128 pc.
   */
  inscriptionCard: (media: MediaSize): string => {
    const aspect = aspectOf(media);
    const box = (width: number, height: number) =>
      px(Math.max(width, height * aspect));
    return sizesOf(
      [
        [`(min-width: 896px) and ${desktop}`, box(128, 128)],
        ["(min-width: 768px)", box(112, 120)],
      ],
      box(88, 104),
    );
  },
  /** Topic cards draw their image at the card width in its own aspect. */
  topicCard: (slot?: MediaSlot | null): string =>
    slot ? masonrySizes(slot, 1) : columnFeedSizes(1),
  /**
   * Detail carousel (catalog-detail.module.css), contain fit: phone stage
   * edge to edge at 3:4; tablet stage `min(100vw, 1320px) - 56px` at most
   * 460px tall; pc media column `min(100vw, 1320px) - 552px` (48px padding,
   * 36px gap, 420px side column) at most 560px tall.
   */
  detailCarousel: (
    media: MediaSize,
    platform: PresentationPlatform,
  ): string => {
    const aspect = aspectOf(media);
    if (platform === "phone")
      return linear({ vw: 100 * Math.min(1, (4 / 3) * aspect), px: 0 });
    return platform === "tablet"
      ? cappedColumn(768, 1320, 1264, { vw: 100, px: -56 }, 460 * aspect)
      : cappedColumn(896, 1320, 768, { vw: 100, px: -552 }, 560 * aspect);
  },
  /**
   * Article body image (.bodyImage): the reading column is at most 692px
   * (academic .article: 760px less 48px + 20px padding) and below 760px at
   * most `100vw - 40px` (news .article padding); `share` is the block's
   * display width, and a crop draws the image `1 / cropWidth` wider.
   */
  articleBody: ({
    cropWidth = 1,
    share = 1,
  }: {
    readonly cropWidth?: number;
    readonly share?: number;
  } = {}): string => {
    const factor =
      Math.min(1, Math.max(share, 0.01)) /
      Math.min(1, Math.max(cropWidth, 0.01));
    return sizesOf(
      [["(min-width: 760px)", px(692 * factor)]],
      linear(scale({ vw: 100, px: -40 }, factor)),
    );
  },
  /**
   * Compact news card: a square box covered by the image, 180px from 768px,
   * 76px below 360px, else 100px (discussion-preview.module.css .newsCard).
   */
  editorialCompact: (media: MediaSize): string => {
    const factor = Math.max(1, aspectOf(media));
    return sizesOf(
      [
        ["(min-width: 768px)", px(180 * factor)],
        ["(max-width: 359px)", px(76 * factor)],
      ],
      px(100 * factor),
    );
  },
  /**
   * Large news card: the feed column (`min(100%, 760px)` less 2 × 16px from
   * 768px, unpadded below) in a 16:10 box covered by the image.
   */
  editorialLarge: (media: MediaSize): string => {
    const factor = Math.max(1, aspectOf(media) / 1.6);
    return sizesOf(
      [["(min-width: 768px)", px(728 * factor)]],
      linear({ vw: 100 * factor, px: 0 }),
    );
  },
  /**
   * Academic special card: the feed column covered by the image in a box at
   * least 410px tall (440px from 768px), so a wide image is drawn by height.
   */
  editorialSpecial: (media: MediaSize): string => {
    const aspect = aspectOf(media);
    const narrowHeight = 410 * aspect;
    const wide: [string, string] = [
      "(min-width: 768px)",
      px(Math.max(728, 440 * aspect)),
    ];
    return narrowHeight >= 768
      ? sizesOf([wide], px(narrowHeight))
      : sizesOf(
          [wide, [`(min-width: ${roundUp(narrowHeight, 0)}px)`, "100vw"]],
          px(narrowHeight),
        );
  },
  /**
   * News reader figure (.article figure img): the column, at most 350px tall,
   * contain fit; the column is 656px from 768px (720px less 2 × 32px) and at
   * most `100vw - 40px` below.
   */
  newsFigure: (media: MediaSize): string =>
    cappedColumn(320, 768, 656, { vw: 100, px: -40 }, 350 * aspectOf(media)),
  /**
   * Academic figure (.figure > img): a 4:3 box at most 360px tall in the
   * reading column (692px from 760px, `100vw - 68px` below), contain fit.
   */
  academicFigure: (media: MediaSize): string => {
    const aspect = aspectOf(media);
    const factor = Math.min(1, 0.75 * aspect);
    return cappedColumn(
      320,
      760,
      692 * factor,
      scale({ vw: 100, px: -68 }, factor),
      360 * aspect,
    );
  },
  /**
   * Thread post thumbnail (.postThumbnails img): a third of the post width
   * less two 8px gaps, square and contain fit; the post is
   * `min(100vw, 760px) - 32px` wide (.topicPage).
   */
  threadThumbnail: (media: MediaSize): string => {
    const factor = Math.min(1, aspectOf(media));
    return sizesOf(
      [["(min-width: 760px)", px(((728 - 16) / 3) * factor)]],
      linear(scale({ vw: 100 / 3, px: -16 }, factor)),
    );
  },
  /** Thread post gallery (.postGallery img): the news column, at most 600px tall, contain fit. */
  threadGallery: (media: MediaSize): string =>
    cappedColumn(320, 768, 656, { vw: 100, px: -40 }, 600 * aspectOf(media)),
  /** Topic image block (.imageBlock img): the reading column `min(100%, 760px)` less 2 × 16px. */
  topicBlock: (): string =>
    sizesOf([["(min-width: 760px)", "728px"]], "calc(100vw - 32px)"),
} as const;

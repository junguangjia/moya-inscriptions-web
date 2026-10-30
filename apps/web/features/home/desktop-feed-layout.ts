import { desktopLayout } from "@moya/design-tokens";
import { layoutHomeMasonry } from "./catalog-masonry-layout";

export interface DesktopFeedMedia {
  readonly ratio: number | null;
  readonly cropped: boolean;
  readonly preserveContain?: boolean;
}
export interface DesktopFeedPosition extends DesktopFeedMedia {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly mediaWidth: number;
}

/** Presentation geometry only; never invents content or changes list order. */
export const desktopFeedMedia = (item: unknown): DesktopFeedMedia => {
  const record = item as Record<string, unknown> | null;
  const media = (record?.media ?? record?.representativeMedia) as
    { width?: number; height?: number; feed?: { fit?: string } } | undefined;
  const target = record?.target as { type?: string } | undefined;
  // A missing-image placeholder is never an actionable cropped preview.
  const preserveContain = !media || media.feed?.fit === "contain";
  if (target?.type === "work" && !media) return { ratio: null, cropped: false };
  const raw = Number(media?.width) / Number(media?.height);
  if (
    !Number.isFinite(raw) ||
    Number(media?.width) <= 0 ||
    Number(media?.height) <= 0 ||
    raw <= 0
  )
    return {
      ratio: 1,
      cropped: false,
      ...(preserveContain ? { preserveContain: true } : {}),
    };
  const ratio = Math.max(
    desktopLayout.feed.minimumRatio,
    Math.min(desktopLayout.feed.maximumRatio, raw),
  );
  return {
    ratio,
    cropped: ratio !== raw && !preserveContain,
    ...(preserveContain ? { preserveContain: true } : {}),
  };
};

/** Keep the image itself readable after reserving its independent title rail. */
export const resolveDesktopFeedColumns = (width: number): number => {
  if (!Number.isFinite(width) || width <= 0) return 1;
  const s = desktopLayout.feed;
  return Math.max(
    1,
    Math.round((width + s.gap) / (s.mediaTargetWidth + s.labelWidth + s.gap)),
  );
};

/**
 * Reuse normal mode's shortest-column placement, mirrored right-to-left.
 * Source/DOM order stays unchanged and appending never repartitions old cards.
 * Each image keeps its own proportion, with the existing bounded extreme-preview
 * policy and saved contain priority. Sparse results retain ordinary card sizes;
 * their final column bottoms need not align or contain invented filler.
 */
export const layoutDesktopFeed = (
  items: readonly DesktopFeedMedia[],
  width: number,
): {
  readonly height: number;
  readonly positions: readonly DesktopFeedPosition[];
} => {
  if (!Number.isFinite(width) || width <= 0 || !items.length)
    return { height: 0, positions: [] };
  const s = desktopLayout.feed;
  const columns = resolveDesktopFeedColumns(width);
  const cardWidth = (width - s.gap * (columns - 1)) / columns;
  const labelWidth = Math.min(s.labelWidth, cardWidth / 2);
  const imageWidth = cardWidth - labelWidth;
  const naturalHeights = items.map((item) =>
    item.ratio === null ? s.rowHeight : imageWidth / item.ratio,
  );
  const layout = layoutHomeMasonry(
    naturalHeights.map((height) => ({
      height: Math.min(s.featureMax, height),
    })),
    width,
    columns,
    s.gap,
  );
  return {
    height: layout.height,
    positions: layout.positions.map((position, index) => {
      const item = items[index]!;
      return {
        ...item,
        ...position,
        x: Math.max(0, width - position.x - position.width),
        mediaWidth: item.ratio === null ? 0 : imageWidth,
        cropped: item.preserveContain
          ? false
          : item.cropped ||
            (item.ratio !== null && naturalHeights[index]! > s.featureMax),
      };
    }),
  };
};

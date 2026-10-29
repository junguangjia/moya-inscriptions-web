import { desktopLayout } from "@moya/design-tokens";

export interface DesktopFeedMedia {
  readonly ratio: number | null;
  readonly cropped: boolean;
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
  if (target?.type === "work" && !media) return { ratio: null, cropped: false };
  const raw = Number(media?.width) / Number(media?.height);
  if (
    !Number.isFinite(raw) ||
    Number(media?.width) <= 0 ||
    Number(media?.height) <= 0 ||
    raw <= 0
  )
    return { ratio: 1, cropped: false };
  const ratio = Math.max(
    desktopLayout.feed.minimumRatio,
    Math.min(desktopLayout.feed.maximumRatio, raw),
  );
  return { ratio, cropped: ratio !== raw && media?.feed?.fit !== "contain" };
};

/** Sequential justified rows, starting at the right; the final row never stretches. */
export const layoutDesktopFeed = (
  items: readonly DesktopFeedMedia[],
  width: number,
): {
  readonly height: number;
  readonly positions: readonly DesktopFeedPosition[];
} => {
  if (!Number.isFinite(width) || width <= 0)
    return { height: 0, positions: [] };
  const s = desktopLayout.feed;
  const positions: DesktopFeedPosition[] = [];
  const fixed = (item: DesktopFeedMedia) =>
    item.ratio === null ? Math.min(width, s.textWidth) : s.labelWidth;
  const natural = (item: DesktopFeedMedia, height: number) =>
    fixed(item) + (item.ratio ?? 0) * height;
  const rowWidth = (row: readonly DesktopFeedMedia[], height: number) =>
    row.reduce((sum, item) => sum + natural(item, height), 0) +
    s.gap * Math.max(0, row.length - 1);
  const fit = (row: readonly DesktopFeedMedia[]) => {
    const ratio = row.reduce((sum, item) => sum + (item.ratio ?? 0), 0);
    return ratio === 0
      ? s.rowHeight
      : (width -
          row.reduce((sum, item) => sum + fixed(item), 0) -
          s.gap * (row.length - 1)) /
          ratio;
  };
  let offset = 0;
  let y = 0;
  while (offset < items.length) {
    let count = 1;
    while (
      offset + count < items.length &&
      rowWidth(items.slice(offset, offset + count), s.rowHeight) < width
    )
      count += 1;
    const candidate = items.slice(offset, offset + count);
    const tail =
      offset + count === items.length &&
      rowWidth(candidate, s.rowHeight) <= width;
    if (!tail && count > 1) {
      const previous = items.slice(offset, offset + count - 1);
      const a = fit(previous),
        b = fit(candidate);
      // Prefer a readable row over squeezing the next item into a low strip.
      if (
        (candidate.every((item) => item.ratio === null) &&
          rowWidth(candidate, s.rowHeight) > width) ||
        b < s.rowMin ||
        (a <= s.rowMax && Math.abs(a - s.rowHeight) < Math.abs(b - s.rowHeight))
      )
        count -= 1;
    }
    const row = items.slice(offset, offset + count);
    let height = Math.min(s.rowMax, tail ? s.rowHeight : fit(row));
    // All-text rows are fixed-width. A very narrow host must still fit one card.
    if (row.every((item) => item.ratio === null)) height = s.rowHeight;
    height = Math.max(1, height);
    let right = width;
    for (const item of row) {
      const cardWidth = Math.min(width, natural(item, height));
      const mediaWidth = Math.max(0, cardWidth - s.labelWidth);
      right -= cardWidth;
      positions.push({
        ...item,
        x: Math.max(0, right),
        y,
        width: cardWidth,
        height,
        mediaWidth,
      });
      right -= s.gap;
    }
    y += height + s.rowGap;
    offset += count;
  }
  return { positions, height: Math.max(0, y - s.rowGap) };
};

/** Appending a page never refits an already displayed terminal row. */
export const layoutDesktopFeedBatches = (
  items: readonly DesktopFeedMedia[],
  width: number,
  batchEnds: readonly number[],
): ReturnType<typeof layoutDesktopFeed> => {
  const positions: DesktopFeedPosition[] = [];
  let start = 0,
    height = 0;
  for (const end of batchEnds) {
    const batch = layoutDesktopFeed(items.slice(start, end), width);
    if (batch.positions.length) {
      positions.push(
        ...batch.positions.map((position) => ({
          ...position,
          y: position.y + height,
        })),
      );
      height += batch.height + desktopLayout.feed.rowGap;
    }
    start = end;
  }
  return { positions, height: Math.max(0, height - desktopLayout.feed.rowGap) };
};

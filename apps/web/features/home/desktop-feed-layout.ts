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

/** A bounded two-row lookahead: only the open tail can change when more data arrives. */
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
  const softMin = s.rowMin * 0.8;
  const softMax = s.rowMax * 1.2;
  const ratios = [0],
    fixed = [0];
  for (const item of items) {
    ratios.push(ratios.at(-1)! + (item.ratio ?? 0));
    fixed.push(
      fixed.at(-1)! +
        (item.ratio === null ? Math.min(width, s.textWidth) : s.labelWidth),
    );
  }
  interface Row {
    count: number;
    height: number;
    textWidth: number;
    cost: number;
    justified: boolean;
    naturalTail: boolean;
  }
  const maximumCount = Math.max(
    1,
    Math.ceil(
      (width + s.gap) /
        (Math.min(s.textWidth * 0.85, s.labelWidth + s.minimumRatio * softMin) +
          s.gap),
    ) + 1,
  );
  const cache = new Map<number, readonly Row[]>();
  const candidates = (offset: number): readonly Row[] => {
    const known = cache.get(offset);
    if (known) return known;
    const result: Row[] = [];
    for (
      let count = 1;
      count <= Math.min(items.length - offset, maximumCount);
      count++
    ) {
      const end = offset + count;
      const ratio = ratios[end]! - ratios[offset]!;
      const base = fixed[end]! - fixed[offset]!;
      const gaps = s.gap * (count - 1);
      const naturalWidth = base + ratio * s.rowHeight + gaps;
      const naturalTail = end === items.length && naturalWidth <= width;
      let height: number = s.rowHeight,
        textWidth = Math.min(width, s.textWidth),
        used: number;
      if (ratio === 0) {
        if (!naturalTail) {
          const fit = (width - gaps) / count;
          if (fit < s.textWidth * 0.85) continue;
          textWidth = Math.min(s.textWidth * 1.35, fit);
        }
        used = textWidth * count + gaps;
      } else {
        const fit = (width - base - gaps) / ratio;
        if (!naturalTail) {
          if (fit < softMin && count > 1) continue;
          height = fit <= softMax ? Math.max(1, fit) : s.rowMax;
        }
        used = base + ratio * height + gaps;
      }
      if (used > width + 0.01 && count > 1) continue;
      const blank = Math.max(0, width - used) / width;
      const deviation = (height - s.rowHeight) / s.rowHeight;
      const outside =
        height < s.rowMin
          ? (s.rowMin - height) / s.rowMin
          : height > s.rowMax
            ? (height - s.rowMax) / s.rowMax
            : 0;
      const textDeviation =
        ratio === 0 ? (textWidth - s.textWidth) / s.textWidth : 0;
      result.push({
        count,
        height,
        textWidth,
        naturalTail,
        justified: blank < 0.00001,
        cost:
          0.35 +
          deviation * deviation +
          4 * outside * outside +
          textDeviation * textDeviation +
          (naturalTail ? 0.8 : 8) * blank * blank,
      });
    }
    // Respect the preferred height whenever a full-width readable row exists.
    // Soft bounds are for otherwise impossible mixed-ratio combinations only.
    const readableFull = result.some(
      (row) =>
        row.justified && row.height >= s.rowMin && row.height <= s.rowMax,
    );
    const usable = readableFull
      ? result.filter(
          (row) =>
            row.naturalTail ||
            (row.justified && row.height >= s.rowMin && row.height <= s.rowMax),
        )
      : result;
    cache.set(offset, usable);
    return usable;
  };
  const immediate = new Map<number, number>();
  const nextCost = (offset: number) => {
    if (offset === items.length) return 0;
    if (!immediate.has(offset))
      immediate.set(
        offset,
        Math.min(...candidates(offset).map((row) => row.cost)),
      );
    return immediate.get(offset)!;
  };
  const positions: DesktopFeedPosition[] = [];
  let offset = 0,
    y = 0;
  while (offset < items.length) {
    let best: Row | undefined,
      bestCost = Infinity;
    for (const row of candidates(offset)) {
      const cost = row.cost + nextCost(offset + row.count);
      if (
        cost < bestCost - 0.0000001 ||
        (Math.abs(cost - bestCost) < 0.0000001 &&
          row.count > (best?.count ?? 0))
      ) {
        best = row;
        bestCost = cost;
      }
    }
    // One item is always representable, even inside a temporarily narrow host.
    const row = best ?? {
      count: 1,
      height: s.rowHeight,
      textWidth: Math.min(width, s.textWidth),
    };
    let right = width;
    for (let index = offset; index < offset + row.count; index++) {
      const item = items[index]!;
      const cardWidth = Math.min(
        width,
        item.ratio === null
          ? row.textWidth
          : s.labelWidth + item.ratio * row.height,
      );
      right -= cardWidth;
      positions.push({
        ...item,
        x: Math.max(0, right),
        y,
        width: cardWidth,
        height: row.height,
        mediaWidth:
          item.ratio === null ? 0 : Math.max(0, cardWidth - s.labelWidth),
      });
      right -= s.gap;
    }
    y += row.height + s.rowGap;
    offset += row.count;
  }
  return { positions, height: Math.max(0, y - s.rowGap) };
};

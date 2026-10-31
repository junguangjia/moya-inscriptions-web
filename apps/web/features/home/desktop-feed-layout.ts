import { desktopLayout } from "@moya/design-tokens";

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

/** Whole-card size includes the independent right-hand vertical caption. */
export const desktopFeedTargetArea = (
  width: number = desktopLayout.feed.cardAreaReferenceWidth,
): number => {
  const s = desktopLayout.feed;
  const available =
    Number.isFinite(width) && width > 0 ? width : s.cardAreaReferenceWidth;
  return Math.max(
    s.compactCardArea,
    Math.min(
      s.cardArea,
      s.cardArea * (available / s.cardAreaReferenceWidth) ** 2,
    ),
  );
};

type CardSize = Pick<DesktopFeedPosition, "width" | "height" | "mediaWidth">;

const cardBounds = (item: DesktopFeedMedia, width: number) => {
  const s = desktopLayout.feed;
  const host =
    Number.isFinite(width) && width > 0 ? width : s.cardAreaReferenceWidth;
  const label = Math.min(desktopLayout.feed.labelWidth, host / 2);
  const ratio =
    item.ratio === null
      ? null
      : Number.isFinite(item.ratio) && item.ratio > 0
        ? item.ratio
        : 1;
  const area = desktopFeedTargetArea(host);
  const maximum =
    ratio === null
      ? Math.min(host, s.cardMaxWidth, s.cardMaxHeight)
      : Math.min(host, s.cardMaxWidth, label + ratio * s.cardMaxHeight);
  const minimumHeight =
    host < s.cardCompactWidth ? s.cardCompactMinHeight : s.cardMinHeight;
  const minimum = Math.min(
    maximum,
    ratio === null ? minimumHeight : label + ratio * minimumHeight,
  );
  const clampWidth = (value: number) =>
    Math.max(minimum, Math.min(maximum, value));
  const areaWidth = (value: number) => {
    if (ratio === null) return Math.sqrt(value);
    const height =
      (2 * value) / (Math.sqrt(label * label + 4 * ratio * value) + label);
    return label + ratio * height;
  };
  const size = (value: number): CardSize => {
    const cardWidth = clampWidth(value);
    const mediaWidth = ratio === null ? 0 : cardWidth - label;
    return {
      width: cardWidth,
      height: ratio === null ? cardWidth : mediaWidth / ratio,
      mediaWidth,
    };
  };
  return {
    area,
    low: clampWidth(areaWidth(area * (1 - s.cardAreaTolerance))),
    high: clampWidth(areaWidth(area * (1 + s.cardAreaTolerance))),
    ideal: clampWidth(areaWidth(area)),
    size,
  };
};

/** Also used before the host is measured, keeping the first card shape consistent. */
export const desktopFeedIdealSize = (
  item: DesktopFeedMedia,
  width: number = desktopLayout.feed.cardAreaReferenceWidth,
): CardSize => {
  const bounds = cardBounds(item, width);
  return bounds.size(bounds.ideal);
};

interface SkylineInterval {
  start: number;
  end: number;
  top: number;
}

/**
 * Sequential continuous-width masonry. Actual rectangles keep their media ratio
 * and comparable whole-card area; neither rows nor fixed image columns are imposed.
 * The virtual rectangle includes the following 12px gutter. Monotone top and
 * same-level RTL are hard constraints: density never reorders or backfills records.
 * Only geometric sliver feasibility is considered, so appends retain the prefix.
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
  const gap = desktopLayout.feed.gap;
  const extent = width + gap;
  const epsilon = 0.000001;
  const futureMinimum =
    cardBounds(
      { ratio: desktopLayout.feed.minimumRatio, cropped: false },
      width,
    ).low + gap;
  let skyline: SkylineInterval[] = [{ start: 0, end: extent, top: 0 }];
  let lastTop = 0,
    lastEnd = 0;
  const positions: DesktopFeedPosition[] = [];

  for (const item of items) {
    const bounds = cardBounds(item, width);
    const oldMaximum = Math.max(...skyline.map((part) => part.top));
    const nextLevel = Math.min(
      ...skyline
        .filter((part) => part.top > lastTop + 0.5)
        .map((part) => part.top),
    );
    const selection: {
      value?: { start: number; top: number; size: CardSize; score: number };
    } = {};
    const seen = new Set<string>();
    const consider = (rawStart: number, rawWidth: number) => {
      if (rawWidth < bounds.low - epsilon || rawWidth > bounds.high + epsilon)
        return;
      const size = bounds.size(rawWidth);
      const outerWidth = size.width + gap;
      if (rawStart < -epsilon || rawStart + outerWidth > extent + epsilon)
        return;
      const start = Math.max(0, Math.min(extent - outerWidth, rawStart));
      const end = start + outerWidth;
      const key = `${start.toFixed(6)}:${size.width.toFixed(6)}`;
      if (seen.has(key)) return;
      seen.add(key);
      let top = lastTop;
      for (const part of skyline)
        if (part.end > start + epsilon && part.start < end - epsilon)
          top = Math.max(top, part.top);
      // A fresh level can begin at an existing skyline edge, never by a tiny
      // artificial y shift that would visually reverse the same reading level.
      if (top <= lastTop + 0.5 && start < lastEnd - epsilon)
        top = Math.max(top, nextLevel);
      if (!Number.isFinite(top)) return;
      let sealed = 0,
        underneath = 0,
        runStart = 0,
        runEnd = extent;
      for (const part of skyline) {
        sealed += Math.max(0, top - part.top) * (part.end - part.start);
        const overlap = Math.max(
          0,
          Math.min(end, part.end) - Math.max(start, part.start),
        );
        underneath += Math.max(0, top - part.top) * overlap;
        if (part.end <= start + epsilon && part.top > top + epsilon)
          runStart = part.end;
        if (
          runEnd === extent &&
          part.start >= end - epsilon &&
          part.top > top + epsilon
        )
          runEnd = part.start;
      }
      const sliver = (length: number) =>
        length > epsilon && length < futureMinimum - epsilon
          ? length * Math.min(size.height, 240)
          : 0;
      const slivers = sliver(start - runStart) + sliver(runEnd - end);
      const error = (size.width * size.height - bounds.area) / bounds.area;
      const growth = Math.max(0, top + size.height + gap - oldMaximum);
      const score =
        (3 * (sealed + 0.25 * underneath + 0.5 * slivers)) / bounds.area +
        2 * error * error +
        (0.2 * growth) / desktopLayout.feed.cardMaxHeight +
        (0.02 * (top - lastTop)) / desktopLayout.feed.cardMaxHeight;
      const best = selection.value;
      if (
        best === undefined ||
        score < best.score - epsilon ||
        (Math.abs(score - best.score) <= epsilon &&
          (top < best.top - epsilon ||
            (Math.abs(top - best.top) <= epsilon && start < best.start)))
      )
        selection.value = { start, top, size, score };
    };
    const widths = [
      bounds.ideal,
      bounds.low,
      bounds.high,
      (bounds.ideal + bounds.low) / 2,
      (bounds.ideal + bounds.high) / 2,
    ];
    for (const cardWidth of widths) {
      const outerWidth = cardWidth + gap;
      consider(0, cardWidth);
      consider(extent - outerWidth, cardWidth);
      consider(lastEnd, cardWidth);
      for (const part of skyline) {
        consider(part.start, cardWidth);
        consider(part.end - outerWidth, cardWidth);
      }
    }
    // Fit exact available runs at the lowest few levels, avoiding quantization
    // or an unbounded rectangle-packing search. No future record is inspected.
    const levels = [...new Set([lastTop, ...skyline.map((part) => part.top)])]
      .sort((a, b) => a - b)
      .slice(0, 3);
    for (const level of levels) {
      let runStart: number | null = null,
        runEnd = 0;
      const flush = () => {
        if (runStart !== null) consider(runStart, runEnd - runStart - gap);
        runStart = null;
      };
      for (const part of skyline) {
        if (part.top <= level + epsilon) {
          if (runStart === null) runStart = part.start;
          runEnd = part.end;
        } else flush();
      }
      flush();
    }
    // The ideal box at the right edge is always finite, including narrow hosts.
    const chosen = selection.value ?? {
      start: 0,
      top: oldMaximum,
      size: bounds.size(bounds.ideal),
      score: Infinity,
    };
    const end = chosen.start + chosen.size.width + gap;
    const bottom = chosen.top + chosen.size.height + gap;
    const next: SkylineInterval[] = [];
    let inserted = false;
    for (const part of skyline) {
      const floored = Math.max(part.top, chosen.top);
      if (part.end <= chosen.start + epsilon || part.start >= end - epsilon)
        next.push({ ...part, top: floored });
      else {
        if (part.start < chosen.start - epsilon)
          next.push({ start: part.start, end: chosen.start, top: floored });
        if (!inserted) {
          next.push({ start: chosen.start, end, top: bottom });
          inserted = true;
        }
        if (part.end > end + epsilon)
          next.push({ start: end, end: part.end, top: floored });
      }
    }
    skyline = [];
    for (const part of next) {
      const previous = skyline.at(-1);
      if (
        previous &&
        Math.abs(previous.end - part.start) <= epsilon &&
        Math.abs(previous.top - part.top) <= epsilon
      )
        previous.end = part.end;
      else skyline.push(part);
    }
    positions.push({
      ...item,
      ...chosen.size,
      x: Math.max(0, width - chosen.start - chosen.size.width),
      y: chosen.top,
      cropped: item.preserveContain ? false : item.cropped,
    });
    lastTop = chosen.top;
    lastEnd = end;
  }
  return {
    positions,
    height: Math.max(0, ...positions.map((item) => item.y + item.height)),
  };
};

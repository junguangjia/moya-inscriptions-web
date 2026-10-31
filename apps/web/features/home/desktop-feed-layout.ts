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

/**
 * Balance consecutive source records into shared-height, right-to-left rows.
 * Prefer 200–320px around the existing 240px target; the band is soft when
 * ordered proportions cannot fill a row within it. Keep every row at most
 * 360px. A sparse/infeasible row whose full-width height exceeds that bound
 * keeps natural image widths at the target height and starts on the right,
 * instead of stretching, inventing filler or cropping an ordinary image.
 * Sparse text rows also retain their ordinary excerpt width.
 * Appends may rebalance rows; DesktopFeed restores the actual content anchor.
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
  const softMin = s.rowMin * 0.8;
  const preferredMax = s.rowMax;
  const hardMax = s.rowHardMax;
  const textMin = s.textWidth * 0.85;
  const textMax = s.textWidth * 1.35;
  const ratios = [0],
    fixed = [0];
  // A transient host narrower than the label still receives finite geometry;
  // the desktop shell normally provides much more than this minimum width.
  const labelWidth = Math.min(s.labelWidth, width / 2);
  for (const item of items) {
    ratios.push(ratios.at(-1)! + (item.ratio ?? 0));
    fixed.push(
      fixed.at(-1)! +
        (item.ratio === null ? Math.min(width, s.textWidth) : labelWidth),
    );
  }
  interface Choice {
    count: number;
    height: number;
    textWidth: number;
  }
  interface Cost {
    soft: number;
    preferred: number;
    balance: number;
  }
  // Use the hard positive-width boundary, not the soft image-height target:
  // otherwise a legal short complete row can be pruned while a taller split wins.
  const maximumCount = Math.max(
    1,
    Math.floor((width + s.gap) / (labelWidth + s.gap)),
  );
  const outside = (value: number, minimum: number, maximum: number) =>
    value < minimum
      ? ((minimum - value) / minimum) ** 2
      : value > maximum
        ? ((value - maximum) / maximum) ** 2
        : 0;
  const better = (candidate: Cost, current: Cost) => {
    for (const field of ["soft", "preferred", "balance"] as const) {
      const difference = candidate[field] - current[field];
      if (Math.abs(difference) > 0.000000001) return difference < 0;
    }
    return false;
  };
  const costs: Cost[] = Array(items.length + 1);
  const choices: Choice[] = Array(items.length);
  costs[items.length] = { soft: 0, preferred: 0, balance: 0 };
  for (let offset = items.length - 1; offset >= 0; offset--) {
    let best: Cost = { soft: Infinity, preferred: Infinity, balance: Infinity };
    for (
      let count = 1;
      count <= Math.min(items.length - offset, maximumCount);
      count++
    ) {
      const end = offset + count;
      const ratio = ratios[end]! - ratios[offset]!;
      const base = fixed[end]! - fixed[offset]!;
      const gaps = s.gap * (count - 1);
      const available = width - base - gaps;
      if (ratio > 0 && available <= 0) break;
      const height = ratio > 0 ? available / ratio : s.rowHeight;
      const textWidth =
        ratio > 0 ? Math.min(width, s.textWidth) : (width - gaps) / count;
      if (textWidth <= 0) break;
      const next = costs[end]!;
      const deviation = (height - s.rowHeight) / s.rowHeight;
      const textDeviation =
        ratio === 0 ? (textWidth - s.textWidth) / s.textWidth : 0;
      const cost: Cost = {
        soft:
          next.soft +
          outside(height, softMin, hardMax) +
          (ratio === 0 ? outside(textWidth, textMin, textMax) : 0),
        preferred: next.preferred + outside(height, s.rowMin, preferredMax),
        balance:
          next.balance +
          0.2 +
          deviation * deviation +
          textDeviation * textDeviation,
      };
      if (better(cost, best)) {
        best = cost;
        choices[offset] = { count, height, textWidth };
      }
    }
    costs[offset] = best;
  }
  const positions: DesktopFeedPosition[] = [];
  let offset = 0,
    y = 0;
  while (offset < items.length) {
    const row = choices[offset]!;
    const height = row.height > hardMax ? s.rowHeight : row.height;
    const textWidth =
      row.textWidth > textMax ? Math.min(width, s.textWidth) : row.textWidth;
    let right = width;
    for (let index = offset; index < offset + row.count; index++) {
      const item = items[index]!;
      const mediaWidth = item.ratio === null ? 0 : item.ratio * height;
      const cardWidth =
        item.ratio === null ? textWidth : labelWidth + mediaWidth;
      right -= cardWidth;
      positions.push({
        ...item,
        cropped: item.preserveContain ? false : item.cropped,
        x: Math.max(0, right),
        y,
        width: cardWidth,
        height,
        mediaWidth,
      });
      right -= s.gap;
    }
    y += height + s.rowGap;
    offset += row.count;
  }
  return { positions, height: Math.max(0, y - s.rowGap) };
};

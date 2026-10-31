import { desktopLayout } from "@moya/design-tokens";
import {
  FEED_STAGE_MAX_RATIO,
  slideFit,
} from "../authors/feed-post-strip-geometry";

export interface DesktopFeedMedia {
  /** Original source width / height, never the grouped preview-frame ratio. */
  readonly ratio: number | null;
  readonly cropped: boolean;
  readonly preserveContain?: boolean;
  readonly authorCover?: boolean;
  readonly missing?: boolean;
}
export interface DesktopFeedPosition extends DesktopFeedMedia {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly mediaWidth: number;
  readonly paired?: boolean;
}

type CardSize = Pick<
  DesktopFeedPosition,
  "width" | "height" | "mediaWidth" | "cropped"
>;
interface Photo {
  readonly index: number;
  readonly media: DesktopFeedMedia;
  readonly raw: number;
  readonly ratio: number;
  readonly landscape: boolean;
  readonly auxiliary: boolean;
  readonly authorCover: boolean;
}
interface Group {
  readonly top: number;
  readonly bottom: number | null;
  readonly coefficient: number;
  readonly intercept: number;
  width: number;
}
interface Band {
  readonly groups: readonly Group[];
  readonly consumed: number;
  readonly height: number;
  readonly score: number;
  readonly fallback?: boolean;
}
interface Plan {
  readonly score: number;
  readonly band: Band | null;
}
const clamp = (value: number, minimum: number, maximum: number) =>
  Math.max(minimum, Math.min(maximum, value));
const safeMedia = (value: unknown): DesktopFeedMedia => {
  if (value !== null && typeof value === "object" && "ratio" in value)
    return value as DesktopFeedMedia;
  return { ratio: 1, cropped: false, preserveContain: true, missing: true };
};
const sourceRatio = (value: number | null) =>
  value !== null &&
  Number.isFinite(value) &&
  value > 0 &&
  Number.isFinite(1 / value)
    ? value
    : 1;
const legacyCover = (ratio: number) =>
  slideFit({ width: 1, height: 1 / ratio }, FEED_STAGE_MAX_RATIO) === "cover";

/** Only an explicit, still-eligible authored region may crop. Otherwise show the complete source. */
export const desktopFeedMedia = (item: unknown): DesktopFeedMedia => {
  const record =
    item !== null && typeof item === "object"
      ? (item as Record<string, unknown>)
      : undefined;
  const candidate = record?.media ?? record?.representativeMedia;
  const media =
    candidate !== null && typeof candidate === "object"
      ? (candidate as {
          width?: number;
          height?: number;
          feed?: { fit?: string };
        })
      : undefined;
  const target = record?.target as { type?: string } | undefined;
  if (target?.type === "work" && !media) return { ratio: null, cropped: false };
  if (!media)
    return { ratio: 1, cropped: false, preserveContain: true, missing: true };
  const width = Number(media.width),
    height = Number(media.height);
  const raw = width / height;
  if (
    !Number.isFinite(raw) ||
    width <= 0 ||
    height <= 0 ||
    !Number.isFinite(1 / raw)
  )
    return { ratio: 1, cropped: false, preserveContain: true };
  const preserveContain = media.feed?.fit === "contain";
  const authorCover =
    !preserveContain &&
    media.feed?.fit === "cover" &&
    slideFit({ width, height }, FEED_STAGE_MAX_RATIO) === "cover";
  return {
    ratio: raw,
    cropped: false,
    ...(preserveContain ? { preserveContain: true } : {}),
    ...(authorCover ? { authorCover: true } : {}),
  };
};

const photo = (media: DesktopFeedMedia, index: number): Photo => {
  const s = desktopLayout.feed;
  const raw = sourceRatio(media.ratio);
  const auxiliary = media.ratio === null;
  const authorCover =
    !auxiliary &&
    !media.missing &&
    !media.preserveContain &&
    media.authorCover === true &&
    legacyCover(raw);
  return {
    index,
    media,
    raw,
    auxiliary,
    authorCover,
    ratio: authorCover
      ? Math.max(raw, 1 / FEED_STAGE_MAX_RATIO)
      : clamp(raw, s.minimumRatio, s.maximumRatio),
    landscape:
      !auxiliary &&
      !media.missing &&
      raw >= s.mosaicLandscapeMin &&
      raw <= s.mosaicLandscapeMax,
  };
};
const railFor = (width: number) =>
  Math.min(desktopLayout.feed.labelWidth, width / 3);
const hasAuthorCrop = (entry: Photo, height: number, mediaWidth: number) =>
  entry.authorCover &&
  mediaWidth > 0 &&
  slideFit({ width: 1, height: 1 / entry.raw }, height / mediaWidth) ===
    "cover";

/** Shared with the unmeasured card: the same bounded dimensions AND native fit policy. */
export const desktopFeedIdealSize = (
  media: DesktopFeedMedia,
  availableWidth: number = desktopLayout.feed.fallbackWidth,
): CardSize => {
  const s = desktopLayout.feed;
  const width =
    Number.isFinite(availableWidth) && availableWidth > 0
      ? availableWidth
      : s.fallbackWidth;
  const rail = railFor(width),
    entry = photo(safeMedia(media), 0);
  if (entry.auxiliary) {
    const cardWidth = Math.min(width, s.textWidth);
    return {
      width: cardWidth,
      height: s.rowHeight,
      mediaWidth:
        entry.media.ratio === null ? 0 : Math.max(0, cardWidth - rail),
      cropped: false,
    };
  }
  const areaHeight =
    (2 * s.mosaicTargetArea) /
    (Math.sqrt(rail * rail + 4 * entry.ratio * s.mosaicTargetArea) + rail);
  const maximum = Math.min(
    s.mosaicMaxBandHeight,
    (Math.min(width, s.mosaicSparseMaxWidth) - rail) / entry.ratio,
  );
  const height = clamp(areaHeight, Math.min(s.rowMin, maximum), maximum);
  const mediaWidth = entry.ratio * height;
  return {
    width: rail + mediaWidth,
    height,
    mediaWidth,
    cropped: hasAuthorCrop(entry, height, mediaWidth),
  };
};
export const desktopFeedTargetArea = (): number =>
  desktopLayout.feed.mosaicTargetArea;

const subsets = (
  indices: readonly number[],
  maximum: number,
  emit: (indices: readonly number[]) => void,
  start = 0,
  chosen: number[] = [],
): void => {
  emit([...chosen]);
  if (chosen.length >= maximum) return;
  for (let position = start; position < indices.length; position += 1) {
    const index = indices[position];
    if (index === undefined) continue;
    chosen.push(index);
    subsets(indices, maximum, emit, position + 1, chosen);
    chosen.pop();
  }
};

/** Accepted top-layer / bottom-layer mosaic; append rebalancing is restored by DesktopFeed's existing content anchor. */
export const layoutDesktopFeed = (
  items: readonly DesktopFeedMedia[],
  width: number,
): {
  readonly height: number;
  readonly positions: readonly DesktopFeedPosition[];
} => {
  if (!Number.isFinite(width) || width <= 0 || items.length === 0)
    return { height: 0, positions: [] };
  const s = desktopLayout.feed,
    rail = railFor(width),
    gap = s.gap;
  const photos = Array.from(items, (media, index) =>
    photo(safeMedia(media), index),
  );
  const maximumTop = Math.min(
    s.mosaicMaxTop,
    Math.max(1, Math.ceil(width / s.mosaicGroupWidth)),
  );
  const plans: (Plan | null)[] = Array.from(
    { length: photos.length + 1 },
    () => null,
  );
  plans[photos.length] = { score: 0, band: null };
  const fallback = (offset: number): Band => {
    const entry = photos[offset];
    const size = desktopFeedIdealSize(
      entry?.media ?? { ratio: 1, cropped: false, preserveContain: true },
      width,
    );
    return {
      consumed: 1,
      height: size.height,
      score: 8,
      fallback: true,
      groups: [
        {
          top: offset,
          bottom: null,
          coefficient: 0,
          intercept: size.width,
          width: size.width,
        },
      ],
    };
  };
  const candidates = (offset: number): Band[] => {
    const found: Band[] = [],
      first = photos[offset];
    if (!first) return found;
    if (first.auxiliary) {
      const cardWidth = Math.min(width, s.textWidth);
      let count = 0;
      const maximum = Math.max(
        1,
        Math.floor((width + gap) / (cardWidth + gap)),
      );
      while (count < maximum && photos[offset + count]?.auxiliary) count += 1;
      found.push({
        consumed: count,
        height: s.rowHeight,
        score: 0.1 * count,
        groups: Array.from({ length: count }, (_, index) => ({
          top: offset + index,
          bottom: null,
          coefficient: 0,
          intercept: cardWidth,
          width: cardWidth,
        })),
      });
      return found;
    }
    let remaining = 0;
    while (photos[offset + remaining] && !photos[offset + remaining]!.auxiliary)
      remaining += 1;
    if (remaining === 1) return [fallback(offset)];
    for (
      let topCount = 1;
      topCount <= Math.min(maximumTop, remaining);
      topCount += 1
    ) {
      const eligible: number[] = [];
      for (let index = 0; index < topCount; index += 1)
        if (
          photos[offset + index]?.landscape &&
          eligible.length < s.mosaicPairCandidates
        )
          eligible.push(index);
      subsets(
        eligible,
        Math.min(s.mosaicMaxPairs, remaining - topCount),
        (pairedIndices) => {
          const consumed = topCount + pairedIndices.length,
            groups: Group[] = [];
          let pairRank = 0;
          let cropCost = 0;
          for (let top = 0; top < topCount; top += 1) {
            const entry = photos[offset + top];
            if (!entry) return;
            if (!pairedIndices.includes(top)) {
              groups.push({
                top: entry.index,
                bottom: null,
                coefficient: entry.ratio,
                intercept: rail,
                width: 0,
              });
              continue;
            }
            const second = photos[offset + topCount + pairRank];
            pairRank += 1;
            if (!second?.landscape) return;
            const ratio = clamp(
              Math.sqrt(entry.raw * second.raw),
              s.minimumRatio,
              s.maximumRatio,
            );
            const firstLoss =
              entry.media.preserveContain || entry.ratio !== entry.raw
                ? 0
                : 1 - Math.min(entry.raw / ratio, ratio / entry.raw);
            const secondLoss =
              second.media.preserveContain || second.ratio !== second.raw
                ? 0
                : 1 - Math.min(second.raw / ratio, ratio / second.raw);
            if (Math.max(firstLoss, secondLoss) > s.mosaicMaxPairCrop) return;
            cropCost += 1.25 * (firstLoss ** 2 + secondLoss ** 2);
            groups.push({
              top: entry.index,
              bottom: second.index,
              coefficient: ratio / 2,
              intercept: rail - (ratio * gap) / 2,
              width: 0,
            });
          }
          const coefficient = groups.reduce(
            (sum, group) => sum + group.coefficient,
            0,
          );
          const intercept = groups.reduce(
            (sum, group) => sum + group.intercept,
            0,
          );
          const justified =
            (width - gap * (topCount - 1) - intercept) / coefficient;
          if (!Number.isFinite(justified) || justified < s.mosaicMinBandHeight)
            return;
          const height = Math.min(s.mosaicMaxBandHeight, justified),
            half = (height - gap) / 2;
          if (half <= 0) return;
          const areas: number[] = [];
          let usedWidth = gap * (topCount - 1);
          for (const group of groups) {
            group.width = group.coefficient * height + group.intercept;
            if (group.width <= rail || group.width > width) return;
            usedWidth += group.width;
            areas.push(group.width * (group.bottom === null ? height : half));
            if (group.bottom !== null) areas.push(group.width * half);
          }
          const spread = Math.max(...areas) / Math.min(...areas);
          const sizeCost = areas.reduce(
            (sum, area) =>
              sum +
              Math.log(area / s.mosaicTargetArea) ** 2 *
                (area > s.mosaicTargetArea * 1.4 ? 6 : 1),
            0,
          );
          const spreadCost =
            2 * Math.max(0, Math.log(spread / 1.8)) ** 2 * consumed;
          const heightCost =
            0.35 *
            ((height - s.mosaicTargetHeight) / s.mosaicTargetHeight) ** 2 *
            consumed;
          const marginCost =
            1.2 * (Math.max(0, width - usedWidth) / width) ** 2 * consumed;
          found.push({
            groups,
            consumed,
            height,
            score:
              sizeCost + spreadCost + heightCost + marginCost + cropCost + 0.3,
          });
        },
      );
    }
    return found;
  };
  for (let offset = photos.length - 1; offset >= 0; offset -= 1) {
    const choices = candidates(offset);
    if (choices.length === 0) choices.push(fallback(offset));
    for (const band of choices) {
      const tail = plans[offset + band.consumed];
      if (!tail) continue;
      const score = band.score + tail.score,
        best = plans[offset];
      if (
        !best ||
        score < best.score ||
        (Math.abs(score - best.score) < 0.000001 &&
          band.consumed > (best.band?.consumed ?? 0))
      )
        plans[offset] = { score, band };
    }
  }
  const positions: DesktopFeedPosition[] = [];
  let offset = 0,
    y = 0;
  while (offset < photos.length) {
    const band = plans[offset]?.band ?? fallback(offset);
    let right = width;
    const groups = band.groups.map((group) => {
      const x = Math.max(0, right - group.width);
      right = x - gap;
      return { ...group, x };
    });
    const half = (band.height - gap) / 2;
    for (let local = 0; local < band.consumed; local += 1) {
      const index = offset + local,
        entry = photos[index];
      const group = groups.find(
        (candidate) => candidate.top === index || candidate.bottom === index,
      );
      if (!entry || !group) return fallbackLayout(items, width);
      const paired = group.bottom !== null,
        height = paired ? half : band.height;
      const mediaWidth =
        entry.media.ratio === null ? 0 : Math.max(0, group.width - rail);
      positions.push({
        ...entry.media,
        x: group.x,
        y: y + (group.bottom === index ? half + gap : 0),
        width: group.width,
        height,
        mediaWidth,
        paired,
        cropped: !paired && hasAuthorCrop(entry, height, mediaWidth),
      });
    }
    y += band.height + gap;
    offset += band.consumed;
  }
  return { positions, height: Math.max(0, y - gap) };
};

/** Defensive source-order fallback never drops records or manufactures a photo. */
const fallbackLayout = (items: readonly DesktopFeedMedia[], width: number) => {
  let y = 0;
  const positions = Array.from(items, (input) => {
    const media = safeMedia(input);
    const size = desktopFeedIdealSize(media, width);
    const position = {
      ...media,
      ...size,
      x: Math.max(0, width - size.width),
      y,
      paired: false,
    };
    y += size.height + desktopLayout.feed.gap;
    return position;
  });
  return { positions, height: Math.max(0, y - desktopLayout.feed.gap) };
};

import sharp from "sharp";

// A synthetic high-detail image for the mechanism behind admin_view_media. It proves
// what survives each way of viewing an original; it says nothing about reading a real
// rubbing, whose strokes are worn, which needs real data and stays NOT TESTED.

export const CHART = {
  width: 6_000,
  height: 9_000,
  /** The width of one bar, in original pixels. */
  strokes: [2, 3, 4, 6, 8, 12, 16, 24, 32, 48],
  patch: 480,
  top: 200,
  left: 200,
  gap: 80,
} as const;

/** Modulation at or above this counts as a pattern still there. An assumption. */
export const SURVIVES_AT = 0.2;

const INK = 48;
const PAPER = 208;

const noiseAt = (x: number, y: number) => {
  let hash = Math.imul(x, 73856093) ^ Math.imul(y, 19349663);
  hash ^= hash >>> 13;
  hash = Math.imul(hash, 0x5bd1e995);
  return (hash >>> 24) % 41;
};

const patchLeft = (at: number) => CHART.left + at * (CHART.patch + CHART.gap);

/**
 * Bars of known width in a row across the top, over a dense field of stroke-like marks
 * with grain, so it compresses as badly as a rubbing and the bound is really tested.
 */
export const syntheticChart = async (): Promise<Buffer> => {
  const { width, height, strokes, patch, top } = CHART;
  const pixels = Buffer.alloc(width * height);
  for (let y = 0; y < height; y += 1) {
    const offset = y * width;
    for (let x = 0; x < width; x += 1) {
      const cellX = Math.floor(x / 120);
      const cellY = Math.floor(y / 120);
      const seed = Math.imul(cellX * 31 + cellY, 0x9e3779b1) >>> 0;
      const stroke = 4 + (seed % 9);
      const onBar =
        (x % 120 >= 20 + ((seed >>> 8) % 60) &&
          x % 120 < 20 + ((seed >>> 8) % 60) + stroke) ||
        (y % 120 >= 20 + ((seed >>> 16) % 60) &&
          y % 120 < 20 + ((seed >>> 16) % 60) + stroke);
      pixels[offset + x] = (onBar ? PAPER : INK) + noiseAt(x, y) - 20;
    }
  }
  strokes.forEach((stroke, at) => {
    const left = patchLeft(at);
    for (let y = top; y < top + patch; y += 1)
      for (let x = left; x < left + patch; x += 1)
        pixels[y * width + x] =
          (Math.floor((x - left) / stroke) % 2 === 0 ? PAPER : INK) +
          noiseAt(x, y) -
          20;
  });
  return sharp(pixels, { raw: { width, height, channels: 1 } })
    .toColourspace("srgb")
    .jpeg({ quality: 88 })
    .toBuffer();
};

/** Shaped like the thumb recipe's size and quality; the worker's renderer is not run. */
export const syntheticThumbnail = (chart: Buffer) =>
  sharp(chart, { limitInputPixels: false })
    .resize({ width: 480, height: 480, fit: "inside" })
    .webp({ quality: 80, effort: 4, smartSubsample: false })
    .toBuffer();

export interface StrokeReading {
  readonly stroke: number;
  /** What one bar measures in the picture a caller got. */
  readonly renderedStroke: number;
  readonly modulation: number;
}

/**
 * Bar contrast at each width in a rendered picture of the region [left, top, width,
 * height] of the original. Averaged down each column, so grain does not count as bars.
 */
export const readStrokes = async (
  webp: Buffer,
  region: {
    readonly left: number;
    readonly top: number;
    readonly width: number;
    readonly height: number;
  },
): Promise<readonly StrokeReading[]> => {
  const { data, info } = await sharp(webp)
    .greyscale()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const scale = info.width / region.width;
  const readings: StrokeReading[] = [];
  CHART.strokes.forEach((stroke, at) => {
    const left = patchLeft(at);
    if (
      left < region.left ||
      left + CHART.patch > region.left + region.width ||
      CHART.top < region.top ||
      CHART.top + CHART.patch > region.top + region.height
    )
      return;
    const fromX = Math.ceil((left - region.left) * scale);
    const toX = Math.floor((left + CHART.patch - region.left) * scale);
    const fromY = Math.ceil((CHART.top - region.top) * scale);
    const toY = Math.floor((CHART.top + CHART.patch - region.top) * scale);
    const profile: number[] = [];
    for (let x = fromX; x < toX; x += 1) {
      let sum = 0;
      for (let y = fromY; y < toY; y += 1)
        sum += data[y * info.width * info.channels + x * info.channels]!;
      profile.push(sum / Math.max(1, toY - fromY));
    }
    const sorted = [...profile].sort((a, b) => a - b);
    const low = sorted[Math.floor(sorted.length * 0.1)] ?? 0;
    const high = sorted[Math.floor(sorted.length * 0.9)] ?? 0;
    readings.push({
      stroke,
      renderedStroke: Number((stroke * scale).toFixed(2)),
      modulation: Number(((high - low) / Math.max(1, high + low)).toFixed(3)),
    });
  });
  return readings;
};

/** The finest bar still there, or null when none is. */
export const finestSurviving = (readings: readonly StrokeReading[]) =>
  readings.find(({ modulation }) => modulation >= SURVIVES_AT)?.stroke ?? null;

import sharp from "sharp";

import { MediaRejectedError } from "./errors.js";
import {
  STILL_INPUT_LIMITS,
  STILL_PIPELINE_V1,
  recipeQuality,
  renditionRegion,
  stillOutputSize,
} from "./recipes.js";

import type { Metadata, OutputInfo, Stats } from "sharp";
import type { MediaEdit, NormalizedCrop } from "./edits.js";
import type { StillRole } from "./recipes.js";

/*
 * Still decoding and rendering with sharp. Runs only inside the media
 * sandbox (the renderer), never in the coordinator or the Backend. Geometry
 * and encoder parameters come from the recipe registry (`recipes.ts`).
 */

export type StaticDecodedFormat = "jpeg" | "png" | "webp";

/**
 * A decodable still: a job file path or bytes. `autoOrient` applies EXIF
 * orientation (JPEG/PNG/WebP sources); it is false for libheif output, whose
 * `irot`/`imir` transforms are already applied.
 */
export interface StaticSource {
  readonly input: string | Buffer;
  readonly autoOrient: boolean;
  /** Format the container sniffer detected; must match the decoder. */
  readonly expectedFormat: StaticDecodedFormat;
}

export interface StaticInspection {
  /** Dimensions after source orientation. */
  readonly width: number;
  readonly height: number;
  readonly hasAlpha: boolean;
  /** EXIF Orientation 1..8 reported by the decoder, or null. */
  readonly orientation: number | null;
}

export interface StaticDerivative {
  readonly buffer: Buffer;
  readonly width: number;
  readonly height: number;
  readonly contentType: "image/webp";
}

export interface StaticInspectionLimits {
  /** Decoded pixel ceiling (at most the still pipeline's input limit). */
  readonly maxPixels?: number;
  /** width × height × channels × bytes per sample ceiling, when set. */
  readonly maxDecodedBytes?: number;
}

/** Bytes per decoded sample of a libvips band format; unknown counts as 8. */
const SAMPLE_BYTES: Readonly<Record<string, number>> = {
  uchar: 1,
  char: 1,
  ushort: 2,
  short: 2,
  uint: 4,
  int: 4,
  float: 4,
  complex: 8,
  double: 8,
  dpcomplex: 16,
};

/**
 * Opens a still with the recipe decode limits. The embedded ICC profile is
 * honoured (never ignored), so the conversion to sRGB is colour-managed.
 */
const open = (source: StaticSource) =>
  sharp(source.input, {
    limitInputPixels: STILL_INPUT_LIMITS.limitInputPixels,
    failOn: STILL_INPUT_LIMITS.failOn,
    pages: STILL_INPUT_LIMITS.pages,
    autoOrient: source.autoOrient,
    ignoreIcc: false,
  });

const decodeFailure = (error: unknown): MediaRejectedError => {
  if (error instanceof MediaRejectedError) return error;
  const message = error instanceof Error ? error.message : "";
  if (/^timeout/i.test(message)) {
    return new MediaRejectedError("processing_timeout");
  }
  return new MediaRejectedError(
    /pixel limit/i.test(message) ? "dimensions_exceeded" : "decode_failed",
  );
};

/**
 * Header-level validation before any pixel decode: format, single page,
 * pixel ceiling and, when set, the decoded-bytes ceiling.
 */
export async function inspectStaticSource(
  source: StaticSource,
  limits: StaticInspectionLimits = {},
): Promise<StaticInspection> {
  let metadata: Metadata;
  try {
    metadata = await open(source).metadata();
  } catch (error) {
    throw decodeFailure(error);
  }
  if (metadata.format !== source.expectedFormat) {
    throw new MediaRejectedError("unsupported_type");
  }
  if ((metadata.pages ?? 1) > 1) {
    throw new MediaRejectedError("animated_image_unsupported");
  }
  const width = source.autoOrient ? metadata.autoOrient.width : metadata.width;
  const height = source.autoOrient
    ? metadata.autoOrient.height
    : metadata.height;
  if (
    !Number.isSafeInteger(width) ||
    !Number.isSafeInteger(height) ||
    width < 1 ||
    height < 1
  ) {
    throw new MediaRejectedError("decode_failed");
  }
  const maxPixels = Math.min(
    limits.maxPixels ?? STILL_INPUT_LIMITS.limitInputPixels,
    STILL_INPUT_LIMITS.limitInputPixels,
  );
  if (width * height > maxPixels) {
    throw new MediaRejectedError("dimensions_exceeded");
  }
  if (limits.maxDecodedBytes !== undefined) {
    const channels =
      Number.isSafeInteger(metadata.channels) && metadata.channels > 0
        ? metadata.channels
        : 4;
    const sampleBytes = SAMPLE_BYTES[metadata.depth ?? ""] ?? 8;
    if (width * height * channels * sampleBytes > limits.maxDecodedBytes) {
      throw new MediaRejectedError("dimensions_exceeded");
    }
  }
  const reported = metadata.orientation;
  const orientation =
    reported !== undefined &&
    Number.isSafeInteger(reported) &&
    reported >= 1 &&
    reported <= 8
      ? reported
      : null;
  return { width, height, hasAlpha: metadata.hasAlpha, orientation };
}

/**
 * Renders one still role as WebP with its recipe: orientation → rotation →
 * crop (→ cover crop for the card roles `thumb` and `cover`) → downscale →
 * sRGB. The output never carries EXIF, XMP, IPTC, ICC or GPS metadata, and
 * every byte is re-encoded.
 */
export async function renderStaticDerivative(
  source: StaticSource,
  inspection: StaticInspection,
  role: StillRole,
  edit: MediaEdit,
  coverCrop: NormalizedCrop | null = null,
  options: { readonly timeoutSeconds?: number } = {},
): Promise<StaticDerivative> {
  const { frame, region } = renditionRegion(role, inspection, edit, coverCrop);
  const target = stillOutputSize(role, region);
  let pipeline = open(source);
  if (edit.rotation !== 0) pipeline = pipeline.rotate(edit.rotation);
  if (region.width !== frame.width || region.height !== frame.height) {
    pipeline = pipeline.extract(region);
  }
  if (target.width !== region.width || target.height !== region.height) {
    pipeline = pipeline.resize(target.width, target.height, { fit: "fill" });
  }
  const encoder = STILL_PIPELINE_V1.encoder;
  pipeline = pipeline.toColourspace("srgb").webp({
    quality: recipeQuality(role),
    effort: encoder.effort,
    smartSubsample: encoder.smartSubsample,
    alphaQuality: encoder.alphaQuality,
  });
  if (options.timeoutSeconds !== undefined) {
    pipeline = pipeline.timeout({ seconds: options.timeoutSeconds });
  }
  let rendered: { data: Buffer; info: OutputInfo };
  try {
    rendered = await pipeline.toBuffer({ resolveWithObject: true });
  } catch (error) {
    throw decodeFailure(error);
  }
  if (
    rendered.info.width !== target.width ||
    rendered.info.height !== target.height
  ) {
    throw new MediaRejectedError("processing_failed");
  }
  return {
    buffer: rendered.data,
    width: rendered.info.width,
    height: rendered.info.height,
    contentType: "image/webp",
  };
}

const hex2 = (value: number) =>
  Math.min(255, Math.max(0, Math.round(value)))
    .toString(16)
    .padStart(2, "0");

/**
 * Placeholder colour of a rendered still: the gamma-space sRGB channel mean
 * as `#rrggbb`, or `null` when any pixel is not fully opaque.
 */
export async function placeholderColour(
  input: string | Buffer,
): Promise<string | null> {
  let stats: Stats;
  try {
    stats = await sharp(input, { failOn: "error" }).stats();
  } catch (error) {
    throw decodeFailure(error);
  }
  if (!stats.isOpaque) return null;
  const [first, second, third] = stats.channels;
  if (first === undefined) throw new MediaRejectedError("processing_failed");
  const [red, green, blue] =
    second === undefined || third === undefined
      ? [first.mean, first.mean, first.mean]
      : [first.mean, second.mean, third.mean];
  return `#${hex2(red)}${hex2(green)}${hex2(blue)}`;
}

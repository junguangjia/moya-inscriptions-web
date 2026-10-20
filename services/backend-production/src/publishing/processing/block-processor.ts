import sharp from "sharp";

import { MediaRejectedError } from "./errors.js";
import {
  BLOCK_ALIGNMENT,
  BLOCK_RECIPE_V1,
  STILL_INPUT_LIMITS,
  blockCellRegion,
  blockGrid,
} from "./recipes.js";

/*
 * Catalog block rendering with sharp (catalog-deep-zoom-v1). Runs only
 * inside the media sandbox. One decode of the master: oriented once,
 * converted to untagged sRGB, resized with Lanczos3 to the frame L, checked
 * against the asset's `display` rendition, then cut into 1024 px cells with
 * a 2 px right and bottom overlap and encoded as baseline JPEG q85 4:4:4
 * without metadata. Parameters come from the recipe registry.
 */

export type BlockFailure =
  "master_unreadable" | "zoom_blocks_alpha" | "master_mismatch";

export class BlockRejectedError extends Error {
  constructor(readonly failureCode: BlockFailure) {
    super(`Catalog block render rejected: ${failureCode}`);
    this.name = "BlockRejectedError";
  }
}

export interface BlockRenderInput {
  readonly master: string;
  readonly masterFormat: "jpeg" | "png";
  readonly reference: string;
  /** Oriented master size the attach recorded; a different decode is a mismatch. */
  readonly masterWidth: number;
  readonly masterHeight: number;
  readonly frameWidth: number;
  readonly frameHeight: number;
  readonly referenceWidth: number;
  readonly referenceHeight: number;
  readonly cells: readonly [number, number];
  readonly timeoutSeconds?: number;
}

export interface RenderedBlock {
  readonly cell: number;
  readonly buffer: Buffer;
  readonly width: number;
  readonly height: number;
}

/** Luma PSNR (dB) and the largest per-channel mean difference (0..255). */
export const blockAlignment = (
  candidate: Buffer,
  reference: Buffer,
): { readonly psnr: number; readonly meanDelta: number } => {
  if (candidate.length !== reference.length || candidate.length % 3 !== 0)
    throw new MediaRejectedError("processing_failed");
  let squared = 0;
  const sums = [0, 0, 0, 0, 0, 0];
  const pixels = candidate.length / 3;
  for (let index = 0; index < candidate.length; index += 3) {
    const r = candidate[index]!,
      g = candidate[index + 1]!,
      b = candidate[index + 2]!;
    const rr = reference[index]!,
      rg = reference[index + 1]!,
      rb = reference[index + 2]!;
    const delta = 0.2126 * (r - rr) + 0.7152 * (g - rg) + 0.0722 * (b - rb);
    squared += delta * delta;
    sums[0]! += r;
    sums[1]! += g;
    sums[2]! += b;
    sums[3]! += rr;
    sums[4]! += rg;
    sums[5]! += rb;
  }
  const mse = squared / pixels;
  return {
    psnr: mse === 0 ? 99 : 10 * Math.log10((255 * 255) / mse),
    meanDelta: Math.max(
      Math.abs(sums[0]! - sums[3]!) / pixels,
      Math.abs(sums[1]! - sums[4]!) / pixels,
      Math.abs(sums[2]! - sums[5]!) / pixels,
    ),
  };
};

const reject = (failureCode: BlockFailure) =>
  new BlockRejectedError(failureCode);

const sharpFailure = (error: unknown): Error => {
  if (
    error instanceof BlockRejectedError ||
    error instanceof MediaRejectedError
  )
    return error;
  const message = error instanceof Error ? error.message : "";
  if (/^timeout/i.test(message))
    return new MediaRejectedError("processing_timeout");
  return reject("master_unreadable");
};

/**
 * Renders the cells `[from, to]` of a master's frame. Throws
 * `BlockRejectedError` for content (unreadable, alpha, misaligned master) and
 * `MediaRejectedError("processing_timeout")` on a timeout.
 */
export async function renderCatalogBlocks(
  input: BlockRenderInput,
): Promise<readonly RenderedBlock[]> {
  const recipe = BLOCK_RECIPE_V1;
  const open = () =>
    sharp(input.master, {
      limitInputPixels: STILL_INPUT_LIMITS.limitInputPixels,
      failOn: STILL_INPUT_LIMITS.failOn,
      pages: STILL_INPUT_LIMITS.pages,
      autoOrient: true,
      ignoreIcc: false,
    });
  let frame: Buffer;
  try {
    const metadata = await open().metadata();
    if (metadata.format !== input.masterFormat || (metadata.pages ?? 1) > 1)
      throw reject("master_unreadable");
    if (metadata.depth !== "uchar") throw reject("master_unreadable");
    if (metadata.hasAlpha) throw reject("zoom_blocks_alpha");
    if (
      metadata.autoOrient.width !== input.masterWidth ||
      metadata.autoOrient.height !== input.masterHeight
    )
      throw reject("master_mismatch");
    let pipeline = open()
      .toColourspace("srgb")
      .resize(input.frameWidth, input.frameHeight, {
        fit: "fill",
        kernel: recipe.kernel,
      })
      .removeAlpha()
      .raw();
    if (input.timeoutSeconds !== undefined)
      pipeline = pipeline.timeout({ seconds: input.timeoutSeconds });
    const rendered = await pipeline.toBuffer({ resolveWithObject: true });
    if (
      rendered.info.width !== input.frameWidth ||
      rendered.info.height !== input.frameHeight ||
      rendered.info.channels !== 3
    )
      throw new MediaRejectedError("processing_failed");
    frame = rendered.data;
  } catch (error) {
    throw sharpFailure(error);
  }
  const raw = {
    width: input.frameWidth,
    height: input.frameHeight,
    channels: 3 as const,
  };
  try {
    const candidate = await sharp(frame, { raw })
      .resize(input.referenceWidth, input.referenceHeight, {
        fit: "fill",
        kernel: recipe.kernel,
      })
      .raw()
      .toBuffer();
    const reference = await sharp(input.reference, { failOn: "error" })
      .toColourspace("srgb")
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    // A reference of another size than recorded is the reference's fault,
    // never a content failure of the master.
    if (
      reference.info.width !== input.referenceWidth ||
      reference.info.height !== input.referenceHeight
    )
      throw new MediaRejectedError("processing_failed");
    // Both sides at the coarse compare size (see BLOCK_ALIGNMENT).
    const scale = Math.min(
      1,
      BLOCK_ALIGNMENT.compareLongEdge /
        Math.max(input.referenceWidth, input.referenceHeight),
    );
    const coarse = (data: Buffer) =>
      sharp(data, {
        raw: {
          width: input.referenceWidth,
          height: input.referenceHeight,
          channels: 3,
        },
      })
        .resize(
          Math.max(1, Math.round(input.referenceWidth * scale)),
          Math.max(1, Math.round(input.referenceHeight * scale)),
          { fit: "fill", kernel: recipe.kernel },
        )
        .raw()
        .toBuffer();
    const alignment = blockAlignment(
      await coarse(candidate),
      await coarse(reference.data),
    );
    if (
      alignment.psnr < BLOCK_ALIGNMENT.minLumaPsnr ||
      alignment.meanDelta > BLOCK_ALIGNMENT.maxMeanDelta
    )
      throw reject("master_mismatch");
  } catch (error) {
    if (
      error instanceof BlockRejectedError ||
      error instanceof MediaRejectedError
    )
      throw error;
    throw new MediaRejectedError("processing_failed");
  }
  const { cells } = blockGrid(input.frameWidth, input.frameHeight);
  const blocks: RenderedBlock[] = [];
  for (let cell = input.cells[0]; cell <= input.cells[1]; cell += 1) {
    if (cell >= cells) throw new MediaRejectedError("processing_failed");
    const region = blockCellRegion(input.frameWidth, input.frameHeight, cell);
    const encoded = await sharp(frame, { raw })
      .extract(region)
      .jpeg({
        quality: recipe.encoder.quality,
        chromaSubsampling: recipe.encoder.chromaSubsampling,
        progressive: recipe.encoder.progressive,
        mozjpeg: false,
        optimiseCoding: recipe.encoder.optimiseCoding,
      })
      .toBuffer({ resolveWithObject: true });
    if (
      encoded.info.width !== region.width ||
      encoded.info.height !== region.height
    )
      throw new MediaRejectedError("processing_failed");
    blocks.push({
      cell,
      buffer: encoded.data,
      width: region.width,
      height: region.height,
    });
  }
  return blocks;
}

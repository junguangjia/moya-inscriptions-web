import { open } from "node:fs/promises";

import { asciiEquals, u16be, u32be } from "../publishing/processing/byte-reader.js";
import { JPEG_LIMITS, listJpegSegments } from "../publishing/processing/jpeg.js";
import { readExifSummary } from "../publishing/processing/tiff-exif.js";

/*
 * Header probe of a Catalog display master (catalog-deep-zoom-v1). It reads
 * only the leading header bytes of the Owner's file and decodes no pixel:
 * the format (8-bit baseline or progressive JPEG with 1 or 3 components, or
 * 8-bit grey or RGB PNG without transparency), the stored size and the EXIF
 * orientation, which together give the oriented size the frame is cut from.
 * The block job decodes the master inside the media sandbox and checks the
 * same facts again.
 */

export interface MasterHeader {
  readonly contentType: "image/jpeg" | "image/png";
  /** Oriented size (EXIF orientation 5..8 swaps the stored sides). */
  readonly width: number;
  readonly height: number;
}

export type MasterHeaderRefusal =
  | "master_format"
  | "master_bit_depth"
  | "master_has_alpha"
  | "master_unreadable";

export class MasterHeaderError extends Error {
  constructor(readonly code: MasterHeaderRefusal) {
    super(`Catalog master header refused: ${code}`);
    this.name = "MasterHeaderError";
  }
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
/** SOF0 baseline, SOF1 extended sequential, SOF2 progressive (Huffman). */
const SUPPORTED_SOF = new Set([0xc0, 0xc1, 0xc2]);
const OTHER_SOF = new Set([
  0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf,
]);
const PNG_HEADER_CHUNKS = 64;

const oriented = (
  width: number,
  height: number,
  orientation: number | null,
): { readonly width: number; readonly height: number } =>
  orientation !== null && orientation >= 5
    ? { width: height, height: width }
    : { width, height };

const orientationOf = (tiff: Uint8Array | null): number | null => {
  if (tiff === null) return null;
  try {
    return readExifSummary(tiff).orientation;
  } catch {
    throw new MasterHeaderError("master_unreadable");
  }
};

/** Parses the header facts of master bytes (the file's leading bytes). */
export function parseMasterHeader(bytes: Uint8Array): MasterHeader {
  if (bytes.byteLength >= 2 && bytes[0] === 0xff && bytes[1] === 0xd8)
    return parseJpeg(bytes);
  if (
    bytes.byteLength >= 8 &&
    PNG_SIGNATURE.every((value, index) => bytes[index] === value)
  )
    return parsePng(bytes);
  throw new MasterHeaderError("master_format");
}

function parseJpeg(bytes: Uint8Array): MasterHeader {
  let segments: ReturnType<typeof listJpegSegments>;
  try {
    segments = listJpegSegments(bytes);
  } catch {
    throw new MasterHeaderError("master_unreadable");
  }
  let exif: Uint8Array | null = null;
  let frame: { width: number; height: number } | null = null;
  for (const segment of segments) {
    const data = bytes.subarray(segment.dataStart, segment.dataEnd);
    if (
      exif === null &&
      segment.marker === 0xe1 &&
      asciiEquals(bytes, segment.dataStart, "Exif\0\0")
    )
      exif = data.subarray(6);
    if (OTHER_SOF.has(segment.marker)) throw new MasterHeaderError("master_format");
    if (!SUPPORTED_SOF.has(segment.marker)) continue;
    if (frame !== null || data.byteLength < 6)
      throw new MasterHeaderError("master_unreadable");
    if (data[0] !== 8) throw new MasterHeaderError("master_bit_depth");
    const components = data[5];
    if (components !== 1 && components !== 3)
      throw new MasterHeaderError("master_format");
    frame = { height: u16be(data, 1), width: u16be(data, 3) };
  }
  if (frame === null || frame.width < 1 || frame.height < 1)
    throw new MasterHeaderError("master_unreadable");
  return {
    contentType: "image/jpeg",
    ...oriented(frame.width, frame.height, orientationOf(exif)),
  };
}

function parsePng(bytes: Uint8Array): MasterHeader {
  let cursor = 8;
  let size: { width: number; height: number } | null = null;
  let exif: Uint8Array | null = null;
  for (let index = 0; index < PNG_HEADER_CHUNKS; index += 1) {
    if (cursor + 8 > bytes.byteLength)
      throw new MasterHeaderError("master_unreadable");
    const length = u32be(bytes, cursor);
    const type = String.fromCharCode(...bytes.subarray(cursor + 4, cursor + 8));
    const start = cursor + 8;
    const end = start + length;
    if (end + 4 > bytes.byteLength && type !== "IDAT")
      throw new MasterHeaderError("master_unreadable");
    if (index === 0) {
      if (type !== "IHDR" || length !== 13)
        throw new MasterHeaderError("master_unreadable");
      const bitDepth = bytes[start + 8];
      const colorType = bytes[start + 9];
      if (bitDepth !== 8) throw new MasterHeaderError("master_bit_depth");
      if (colorType === 4 || colorType === 6)
        throw new MasterHeaderError("master_has_alpha");
      if (colorType !== 0 && colorType !== 2)
        throw new MasterHeaderError("master_format");
      if (bytes[start + 12] !== 0) throw new MasterHeaderError("master_format");
      size = { width: u32be(bytes, start), height: u32be(bytes, start + 4) };
    } else if (type === "tRNS") {
      throw new MasterHeaderError("master_has_alpha");
    } else if (type === "eXIf") {
      exif = bytes.subarray(start, end);
    } else if (type === "IDAT" || type === "IEND") {
      break;
    }
    cursor = end + 4;
  }
  if (size === null || size.width < 1 || size.height < 1)
    throw new MasterHeaderError("master_unreadable");
  return {
    contentType: "image/png",
    ...oriented(size.width, size.height, orientationOf(exif)),
  };
}

/** Reads at most the JPEG header bound from the start of a file and parses it. */
export async function readMasterHeader(file: string): Promise<MasterHeader> {
  const handle = await open(file, "r");
  try {
    const buffer = Buffer.alloc(JPEG_LIMITS.maxHeaderBytes);
    const { bytesRead } = await handle.read(buffer, 0, buffer.byteLength, 0);
    return parseMasterHeader(buffer.subarray(0, bytesRead));
  } finally {
    await handle.close();
  }
}

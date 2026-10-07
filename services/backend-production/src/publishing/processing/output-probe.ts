import { fourCc, u32be } from "./byte-reader.js";

import type { ByteReader } from "./byte-reader.js";

/*
 * Header-only checks of sandbox outputs on the coordinator side. Nothing here
 * decodes pixels: a WebP rendition must be a single still image whose canvas
 * equals the expected size and that carries no metadata chunk (EXIF, XMP,
 * ICC) or animation; a motion rendition must be an ISO BMFF file starting
 * with `ftyp`. Every read is bounded by the file size.
 */

const u32le = (bytes: Uint8Array, offset: number): number =>
  (bytes[offset]! |
    (bytes[offset + 1]! << 8) |
    (bytes[offset + 2]! << 16) |
    (bytes[offset + 3]! << 24)) >>>
  0;
const u24le = (bytes: Uint8Array, offset: number): number =>
  bytes[offset]! | (bytes[offset + 1]! << 8) | (bytes[offset + 2]! << 16);
const u16le = (bytes: Uint8Array, offset: number): number =>
  bytes[offset]! | (bytes[offset + 1]! << 8);

/** Extended-format flags of a VP8X chunk. */
const VP8X_ICC = 0x20;
const VP8X_ALPHA = 0x10;
const VP8X_EXIF = 0x08;
const VP8X_XMP = 0x04;
const VP8X_ANIMATION = 0x02;
const MAX_CHUNKS = 16;

export interface WebpProbe {
  readonly width: number;
  readonly height: number;
  readonly hasAlpha: boolean;
}

/**
 * Parses the RIFF chunk headers of a WebP file. Returns `null` for anything
 * other than one still image (`VP8 ` or `VP8L`, optionally preceded by
 * `VP8X` and `ALPH`) without metadata chunks, or with a RIFF size that does
 * not match the file size.
 */
export async function probeWebp(reader: ByteReader): Promise<WebpProbe | null> {
  if (reader.size < 20 || reader.size % 2 !== 0) return null;
  const header = await reader.read(0, 12);
  if (
    fourCc(header, 0) !== "RIFF" ||
    fourCc(header, 8) !== "WEBP" ||
    u32le(header, 4) + 8 !== reader.size
  )
    return null;
  let offset = 12;
  let extended: WebpProbe | null = null;
  let image: { width: number; height: number; alpha: boolean } | null = null;
  let alphaChunk = false;
  for (let index = 0; offset < reader.size; index += 1) {
    if (index >= MAX_CHUNKS || offset + 8 > reader.size) return null;
    const chunk = await reader.read(offset, 8);
    const type = fourCc(chunk, 0);
    const size = u32le(chunk, 4);
    const end = offset + 8 + size + (size % 2);
    if (end > reader.size) return null;
    if (type === "VP8X") {
      if (index !== 0 || size !== 10) return null;
      const body = await reader.read(offset + 8, 10);
      const flags = body[0]!;
      if (flags & (VP8X_ICC | VP8X_EXIF | VP8X_XMP | VP8X_ANIMATION)) {
        return null;
      }
      extended = {
        width: u24le(body, 4) + 1,
        height: u24le(body, 7) + 1,
        hasAlpha: (flags & VP8X_ALPHA) !== 0,
      };
    } else if (type === "ALPH") {
      if (extended === null || alphaChunk || image !== null) return null;
      alphaChunk = true;
    } else if (type === "VP8 ") {
      if (image !== null || size < 10) return null;
      const body = await reader.read(offset + 8, 10);
      if (body[3] !== 0x9d || body[4] !== 0x01 || body[5] !== 0x2a) {
        return null;
      }
      image = {
        width: u16le(body, 6) & 0x3fff,
        height: u16le(body, 8) & 0x3fff,
        alpha: false,
      };
    } else if (type === "VP8L") {
      if (image !== null || size < 5) return null;
      const body = await reader.read(offset + 8, 5);
      if (body[0] !== 0x2f) return null;
      const bits = u32le(body, 1);
      image = {
        width: (bits & 0x3fff) + 1,
        height: ((bits >>> 14) & 0x3fff) + 1,
        alpha: ((bits >>> 28) & 1) === 1,
      };
    } else {
      // ICCP, EXIF, XMP, ANIM, ANMF and unknown chunks are never accepted.
      return null;
    }
    offset = end;
  }
  if (image === null || image.width < 1 || image.height < 1) return null;
  if (extended === null) {
    return { width: image.width, height: image.height, hasAlpha: image.alpha };
  }
  if (extended.width !== image.width || extended.height !== image.height) {
    return null;
  }
  return extended;
}

/** True for an ISO BMFF file whose first box is a bounded `ftyp`. */
export async function probeMp4(reader: ByteReader): Promise<boolean> {
  if (reader.size < 16) return false;
  const head = await reader.read(0, 8);
  const size = u32be(head, 0);
  return fourCc(head, 4) === "ftyp" && size >= 16 && size <= reader.size;
}

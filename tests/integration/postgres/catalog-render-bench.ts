import { execFile, spawn as nodeSpawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  appendFile,
  chmod,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import {
  LocalCatalogSourceReader,
  catalogKeySha256,
} from "@moya/backend-production/internal/catalog-source";
import { createCatalogRenderer } from "@moya/backend-production/internal/publishing-catalog";
import { FilesystemPublishingMediaStore } from "@moya/backend-production/internal/publishing-media-store";
import {
  CATALOG_SOURCE_MAX_BYTES,
  SANDBOX_INPUT_LIMITS,
  SANDBOX_LIMITS,
  SANDBOX_TIMEOUTS_MS,
} from "@moya/backend-production/internal/publishing-processing";
import {
  createSandboxRunner,
  defaultSandboxAppDist,
} from "@moya/backend-production/internal/publishing-sandbox";
import {
  CATALOG_ORIGINAL_MAX_BYTES,
  CATALOG_ORIGINAL_MAX_DECODED_BYTES,
  CATALOG_ORIGINAL_MAX_EDGE,
  CATALOG_ORIGINAL_MAX_PIXELS,
  CATALOG_ORIGINAL_MAX_ROW_BYTES,
} from "@moya/contracts/internal/editorial";
import sharp from "sharp";
import { describe, expect, it } from "vitest";

import { ImageProbeError, ImageStructureProbe } from "admin/media-image-header";

import type {
  SandboxRunner,
  SandboxSpawn,
  SandboxTimings,
} from "@moya/backend-production/internal/publishing-sandbox";

/*
 * catalog-scale-v1 (Issue #323) increment 2, slice S5b: Development render
 * timing of Catalog originals at the ingest limits (D6). Local only, never
 * part of CI: the file is not a *.test.ts file, and it is skipped unless
 * MOYA_CATALOG_RENDER_BENCH_OUTPUT names a private output directory outside
 * any Git working tree (docs/development/catalog-scale-bench.md has the
 * command). It needs Docker and the local media sandbox image
 * (`pnpm dev:media-sandbox`).
 *
 * Each case is a deterministic synthetic original (seeded texture, no Owner
 * material) written once into the output directory and rendered with the
 * worker's own Catalog renderer (`createCatalogRenderer`: the Development
 * source reader with its SHA-256 check, the real sandbox runner with
 * Production's container flags, the protocol checks and a filesystem store).
 * Every repeat records the renderer's per-role times from the manifest, the
 * container's wall time and the container's cgroup memory: `memory.peak`
 * (page cache included) and the largest anon + shmem (tmpfs) seen. A sidecar
 * container polls the cgroups every 100 ms; it reads only the cgroup files of
 * containers whose memory limit equals the sandbox's.
 *
 * MOYA_CATALOG_RENDER_BENCH_CPUS replaces the sandbox's `--cpus` value in the
 * bench only, to emulate a slower core (for example `0.25`, a quarter of a
 * core; throttling makes it slower still); every other flag stays Production's.
 * MOYA_CATALOG_RENDER_BENCH_EXTRA_CASES adds cases of the same shape as
 * CASES (a JSON array), for one-off explorations of a limit.
 */

const env = process.env;
const OUTPUT = env.MOYA_CATALOG_RENDER_BENCH_OUTPUT;
const IMAGE =
  env.MOYA_CATALOG_RENDER_BENCH_IMAGE ?? "yoyi-work-publishing-media-tools:v2";
const REPEAT = Number(env.MOYA_CATALOG_RENDER_BENCH_REPEAT ?? 3);
const CPUS = env.MOYA_CATALOG_RENDER_BENCH_CPUS;
const SELECTED = env.MOYA_CATALOG_RENDER_BENCH_CASES?.split(",")
  .map((name) => name.trim())
  .filter(Boolean);

const MiB = 1024 * 1024;
const run = promisify(execFile);

type Format = "jpeg" | "png" | "webp";

interface BenchCase {
  readonly name: string;
  readonly format: Format;
  readonly width: number;
  readonly height: number;
  readonly channels: 3 | 4;
  /** Amplitude of the seeded noise added to the texture (8-bit levels). */
  readonly noise: number;
  readonly orientation?: 6;
  /** PNG only: 16 bits per sample (the decoded-bytes rule counts 2). */
  readonly depth?: 16;
  /** JPEG only: CMYK samples (four channels) instead of YCbCr. */
  readonly cmyk?: true;
  /**
   * A progressive JPEG or an interlaced (Adam7) PNG: the decoder holds the
   * whole image (JPEG coefficients, PNG pixels) before it can shrink it.
   */
  readonly progressive?: true;
  /** JPEG only: chroma subsampling (default 4:2:0, or 4:4:4 with `bytes`). */
  readonly subsampling?: "4:2:0" | "4:4:4";
  /**
   * JPEG only (CMYK 4:4:4): a sequential file written one scan per
   * component, by the bench's own baseline encoder (sharp writes one
   * interleaved scan). libjpeg holds its coefficients whole, as for a
   * progressive file.
   */
  readonly scans?: "per-component";
  /** Encoded size bounds the generated file must meet. */
  readonly bytes?: readonly [number, number];
  /**
   * JPEG only: the width written into the frame header after encoding (the
   * encoder itself stops at 65,500), to see what the sandbox does with a
   * header a 65,535 px edge would admit.
   */
  readonly headerWidth?: number;
  /**
   * The ingest limit this case is over: the evidence that set it (S5b).
   * Every other case sits at or under every CATALOG_ORIGINAL_* limit, and
   * the Admin's ingest probe accepts exactly those.
   */
  readonly beyond?: "edge" | "row" | "coefficients" | "interlaced";
  readonly expect: "rendered" | "rejected";
  readonly note: string;
}

/**
 * The D6 limit cases and the worst shapes within the limits the measurement
 * left (EXIF-rotated variants, wide strips at the row bound, progressive
 * JPEG and interlaced PNG at their buffer bounds), then the cases over the
 * old limits that lowered the edge and added the row and buffer bounds.
 */
const CASES: readonly BenchCase[] = [
  {
    name: "jpeg-120mp",
    format: "jpeg",
    width: 13_416,
    height: 8_944,
    channels: 3,
    noise: 24,
    expect: "rendered",
    note: "120 MP JPEG, quality 90, 4:2:0",
  },
  {
    name: "jpeg-128mib",
    format: "jpeg",
    width: 13_416,
    height: 8_944,
    channels: 3,
    noise: 88,
    bytes: [120 * MiB, CATALOG_ORIGINAL_MAX_BYTES],
    expect: "rendered",
    note: "120 MP JPEG of 120-128 MiB, quality 98, 4:4:4",
  },
  {
    name: "png-120mp-rgba",
    format: "png",
    width: 13_416,
    height: 8_944,
    channels: 4,
    noise: 8,
    bytes: [96 * MiB, CATALOG_ORIGINAL_MAX_BYTES],
    expect: "rendered",
    note: "120 MP 8-bit RGBA PNG (458 MiB decoded)",
  },
  {
    name: "webp-16383",
    format: "webp",
    width: 16_383,
    height: 7_324,
    channels: 3,
    noise: 24,
    expect: "rendered",
    note: "16,383 x 7,324 lossy WebP, quality 90",
  },
  {
    name: "pano-jpeg-65500",
    format: "jpeg",
    width: 65_500,
    height: 1_832,
    channels: 3,
    noise: 24,
    expect: "rendered",
    note: "65,500 x 1,832 JPEG strip",
  },
  {
    name: "pano-jpeg-cmyk-65500",
    format: "jpeg",
    width: 65_500,
    height: 1_832,
    channels: 3,
    cmyk: true,
    noise: 4,
    expect: "rendered",
    note: "65,500 x 1,832 CMYK JPEG strip",
  },
  {
    name: "pano-png-rgba-65500",
    format: "png",
    width: 65_500,
    height: 1_832,
    channels: 4,
    noise: 2,
    expect: "rendered",
    note: "65,500 x 1,832 8-bit RGBA PNG strip (row 256,000 B)",
  },
  {
    name: "pano-png16-rgba-32768",
    format: "png",
    width: 32_768,
    height: 2_048,
    channels: 4,
    depth: 16,
    noise: 8,
    expect: "rendered",
    note: "32,768 x 2,048 16-bit RGBA PNG (row 256 KiB, 512 MiB decoded)",
  },
  {
    name: "pano-png16-rgb-43690",
    format: "png",
    width: 43_690,
    height: 2_048,
    channels: 3,
    depth: 16,
    noise: 1,
    expect: "rendered",
    note: "43,690 x 2,048 16-bit RGB PNG (row 256 KiB, 512 MiB decoded)",
  },
  {
    name: "png16-rgba-512mib",
    format: "png",
    width: 8_192,
    height: 8_192,
    channels: 4,
    depth: 16,
    noise: 8,
    expect: "rendered",
    note: "8,192 x 8,192 16-bit RGBA PNG (512 MiB decoded)",
  },
  {
    name: "jpeg-120mp-orient6",
    format: "jpeg",
    width: 13_416,
    height: 8_944,
    channels: 3,
    noise: 24,
    orientation: 6,
    expect: "rendered",
    note: "jpeg-120mp with EXIF Orientation 6",
  },
  {
    name: "png-120mp-rgba-orient6",
    format: "png",
    width: 13_416,
    height: 8_944,
    channels: 4,
    noise: 8,
    orientation: 6,
    bytes: [96 * MiB, CATALOG_ORIGINAL_MAX_BYTES],
    expect: "rendered",
    note: "png-120mp-rgba with EXIF Orientation 6",
  },
  {
    name: "tall-png16-rgba-o6",
    format: "png",
    width: 1_024,
    height: 65_500,
    channels: 4,
    depth: 16,
    noise: 8,
    orientation: 6,
    expect: "rendered",
    note: "1,024 x 65,500 16-bit RGBA PNG, EXIF Orientation 6 (wide once turned)",
  },
  {
    name: "jpeg-prog-444-512mib",
    format: "jpeg",
    width: 11_584,
    height: 7_720,
    channels: 3,
    noise: 24,
    progressive: true,
    subsampling: "4:4:4",
    expect: "rendered",
    note: "89 MP progressive JPEG, q90, 4:4:4 (coefficients 511.7 MiB)",
  },
  {
    name: "jpeg-prog-cmyk-444-512mib",
    format: "jpeg",
    width: 10_000,
    height: 6_700,
    channels: 3,
    cmyk: true,
    noise: 4,
    progressive: true,
    subsampling: "4:4:4",
    expect: "rendered",
    note: "67 MP progressive CMYK JPEG, q90, 4:4:4 (coefficients 511.5 MiB)",
  },
  {
    name: "jpeg-prog-cmyk-444-strip",
    format: "jpeg",
    width: 65_500,
    height: 1_000,
    channels: 3,
    cmyk: true,
    noise: 4,
    progressive: true,
    subsampling: "4:4:4",
    expect: "rendered",
    note: "65,500 x 1,000 progressive CMYK JPEG, 4:4:4 (coefficients 499.8 MiB)",
  },
  {
    name: "jpeg-prog-420-120mp",
    format: "jpeg",
    width: 13_416,
    height: 8_944,
    channels: 3,
    noise: 24,
    progressive: true,
    subsampling: "4:2:0",
    expect: "rendered",
    note: "120 MP progressive JPEG, q90, 4:2:0 (coefficients 343.5 MiB)",
  },
  {
    name: "jpeg-seq-scans-cmyk-444-512mib",
    format: "jpeg",
    width: 10_000,
    height: 6_700,
    channels: 3,
    cmyk: true,
    noise: 4,
    subsampling: "4:4:4",
    scans: "per-component",
    expect: "rendered",
    note: "67 MP sequential CMYK JPEG, 4:4:4, one scan per component (coefficients 511.5 MiB)",
  },
  {
    name: "png-adam7-rgba-strip",
    format: "png",
    width: 65_500,
    height: 1_024,
    channels: 4,
    noise: 2,
    progressive: true,
    expect: "rendered",
    note: "65,500 x 1,024 Adam7 RGBA PNG (255.9 MiB decoded)",
  },
  {
    name: "png-adam7-rgb-strip",
    format: "png",
    width: 65_500,
    height: 1_366,
    channels: 3,
    noise: 2,
    progressive: true,
    expect: "rendered",
    note: "65,500 x 1,366 Adam7 RGB PNG (256.0 MiB decoded)",
  },
  {
    name: "png16-adam7-rgba-strip",
    format: "png",
    width: 32_768,
    height: 1_024,
    channels: 4,
    depth: 16,
    noise: 8,
    progressive: true,
    expect: "rendered",
    note: "32,768 x 1,024 Adam7 16-bit RGBA PNG (256 MiB decoded)",
  },
  {
    name: "png-adam7-rgba-8192",
    format: "png",
    width: 8_192,
    height: 8_192,
    channels: 4,
    noise: 8,
    progressive: true,
    expect: "rendered",
    note: "8,192 x 8,192 Adam7 RGBA PNG (256 MiB decoded)",
  },
  {
    name: "jpeg-65535-header",
    format: "jpeg",
    width: 65_500,
    height: 1_831,
    channels: 3,
    noise: 24,
    headerWidth: 65_535,
    beyond: "edge",
    expect: "rejected",
    note: "JPEG whose frame header says 65,535 x 1,831",
  },
  {
    name: "pano-png16-rgba-65500",
    format: "png",
    width: 65_500,
    height: 1_024,
    channels: 4,
    depth: 16,
    noise: 8,
    beyond: "row",
    expect: "rendered",
    note: "65,500 x 1,024 16-bit RGBA PNG strip (row 512,000 B, 512 MiB decoded)",
  },
  {
    name: "jpeg-prog-cmyk-444-120mp",
    format: "jpeg",
    width: 13_416,
    height: 8_944,
    channels: 3,
    cmyk: true,
    noise: 4,
    progressive: true,
    subsampling: "4:4:4",
    beyond: "coefficients",
    expect: "rendered",
    note: "120 MP progressive CMYK JPEG, 4:4:4 (coefficients 915.4 MiB)",
  },
  {
    name: "png-adam7-rgba-65500",
    format: "png",
    width: 65_500,
    height: 1_832,
    channels: 4,
    noise: 2,
    progressive: true,
    beyond: "interlaced",
    expect: "rendered",
    note: "65,500 x 1,832 Adam7 RGBA PNG (457.8 MiB decoded)",
  },
];

/** Bumped whenever generation changes, so cached originals are rebuilt. */
const GENERATOR_VERSION = 1;

/**
 * Seeded texture: a dark ground with stroke-like bands (two separable sine
 * products) plus xorshift noise on the luma, so encoders see real entropy.
 * Deterministic for one (size, channels, noise).
 */
const texture = (
  width: number,
  height: number,
  channels: 3 | 4,
  noise: number,
): Buffer => {
  const data = Buffer.alloc(width * height * channels);
  const column = new Float64Array(width);
  const row = new Float64Array(height);
  for (let x = 0; x < width; x += 1)
    column[x] =
      60 * Math.sin(x / 37) * Math.sin(x / 211) + 30 * Math.sin(x / 5.3);
  for (let y = 0; y < height; y += 1)
    row[y] = 60 * Math.cos(y / 41) * Math.sin(y / 173) + 30 * Math.cos(y / 6.1);
  let state = 0x9e3779b9;
  let offset = 0;
  for (let y = 0; y < height; y += 1) {
    const band = row[y]!;
    for (let x = 0; x < width; x += 1) {
      state ^= state << 13;
      state ^= state >>> 17;
      state ^= state << 5;
      const base =
        110 +
        band +
        column[x]! +
        ((state >>> 0) / 4294967296 - 0.5) * 2 * noise;
      for (let channel = 0; channel < 3; channel += 1) {
        const value = base + (channel - 1) * 9;
        data[offset++] = value < 0 ? 0 : value > 255 ? 255 : value;
      }
      if (channels === 4) data[offset++] = 255;
    }
  }
  return data;
};

/** Rewrites the first SOF frame header's width (JPEG only). */
const patchJpegWidth = (bytes: Buffer, width: number): Buffer => {
  let offset = 2;
  while (offset + 9 < bytes.length && bytes[offset] === 0xff) {
    const marker = bytes[offset + 1]!;
    const length = bytes.readUInt16BE(offset + 2);
    if (
      marker >= 0xc0 &&
      marker <= 0xcf &&
      ![0xc4, 0xc8, 0xcc].includes(marker)
    ) {
      bytes.writeUInt16BE(width, offset + 7);
      return bytes;
    }
    offset += 2 + length;
  }
  throw new Error("No JPEG frame header found");
};

// The baseline encoder's tables: Annex K's luminance quantization and
// Huffman tables, the ones libjpeg writes without optimised coding.
const ZIGZAG = [
  0, 1, 8, 16, 9, 2, 3, 10, 17, 24, 32, 25, 18, 11, 4, 5, 12, 19, 26, 33, 40,
  48, 41, 34, 27, 20, 13, 6, 7, 14, 21, 28, 35, 42, 49, 56, 57, 50, 43, 36, 29,
  22, 15, 23, 30, 37, 44, 51, 58, 59, 52, 45, 38, 31, 39, 46, 53, 60, 61, 54,
  47, 55, 62, 63,
];
const LUMINANCE_QUANTIZATION = [
  16, 11, 10, 16, 24, 40, 51, 61, 12, 12, 14, 19, 26, 58, 60, 55, 14, 13, 16,
  24, 40, 57, 69, 56, 14, 17, 22, 29, 51, 87, 80, 62, 18, 22, 37, 56, 68, 109,
  103, 77, 24, 35, 55, 64, 81, 104, 113, 92, 49, 64, 78, 87, 103, 121, 120, 101,
  72, 92, 95, 98, 112, 100, 103, 99,
];
const DC_BITS = [0, 1, 5, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0];
const DC_VALUES = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];
const AC_BITS = [0, 2, 1, 3, 3, 2, 4, 3, 5, 5, 4, 4, 0, 0, 1, 0x7d];
const AC_VALUES = [
  0x01, 0x02, 0x03, 0x00, 0x04, 0x11, 0x05, 0x12, 0x21, 0x31, 0x41, 0x06, 0x13,
  0x51, 0x61, 0x07, 0x22, 0x71, 0x14, 0x32, 0x81, 0x91, 0xa1, 0x08, 0x23, 0x42,
  0xb1, 0xc1, 0x15, 0x52, 0xd1, 0xf0, 0x24, 0x33, 0x62, 0x72, 0x82, 0x09, 0x0a,
  0x16, 0x17, 0x18, 0x19, 0x1a, 0x25, 0x26, 0x27, 0x28, 0x29, 0x2a, 0x34, 0x35,
  0x36, 0x37, 0x38, 0x39, 0x3a, 0x43, 0x44, 0x45, 0x46, 0x47, 0x48, 0x49, 0x4a,
  0x53, 0x54, 0x55, 0x56, 0x57, 0x58, 0x59, 0x5a, 0x63, 0x64, 0x65, 0x66, 0x67,
  0x68, 0x69, 0x6a, 0x73, 0x74, 0x75, 0x76, 0x77, 0x78, 0x79, 0x7a, 0x83, 0x84,
  0x85, 0x86, 0x87, 0x88, 0x89, 0x8a, 0x92, 0x93, 0x94, 0x95, 0x96, 0x97, 0x98,
  0x99, 0x9a, 0xa2, 0xa3, 0xa4, 0xa5, 0xa6, 0xa7, 0xa8, 0xa9, 0xaa, 0xb2, 0xb3,
  0xb4, 0xb5, 0xb6, 0xb7, 0xb8, 0xb9, 0xba, 0xc2, 0xc3, 0xc4, 0xc5, 0xc6, 0xc7,
  0xc8, 0xc9, 0xca, 0xd2, 0xd3, 0xd4, 0xd5, 0xd6, 0xd7, 0xd8, 0xd9, 0xda, 0xe1,
  0xe2, 0xe3, 0xe4, 0xe5, 0xe6, 0xe7, 0xe8, 0xe9, 0xea, 0xf1, 0xf2, 0xf3, 0xf4,
  0xf5, 0xf6, 0xf7, 0xf8, 0xf9, 0xfa,
];

/** Canonical Huffman codes from a DHT's counts and values (Annex C). */
const huffmanCodes = (bits: readonly number[], values: readonly number[]) => {
  const code = new Uint16Array(256);
  const size = new Uint8Array(256);
  let next = 0;
  let index = 0;
  for (let length = 1; length <= 16; length += 1) {
    for (let count = 0; count < bits[length - 1]!; count += 1) {
      const value = values[index++]!;
      code[value] = next++;
      size[value] = length;
    }
    next <<= 1;
  }
  return { code, size };
};

/**
 * A baseline (SOF0) CMYK JPEG, 4:4:4, quality 90, written as one scan per
 * component with an Adobe marker, as libjpeg's own CMYK output carries.
 * sharp cannot write such a file: it always interleaves the components.
 */
const encodeScansPerComponent = (
  samples: Buffer,
  width: number,
  height: number,
): Buffer => {
  const components = 4;
  const table = LUMINANCE_QUANTIZATION.map((value) =>
    Math.min(255, Math.max(1, Math.floor((value * 20 + 50) / 100))),
  );
  const cosine = new Float64Array(64);
  for (let u = 0; u < 8; u += 1)
    for (let x = 0; x < 8; x += 1)
      cosine[u * 8 + x] =
        ((u === 0 ? Math.SQRT1_2 : 1) / 2) *
        Math.cos(((2 * x + 1) * u * Math.PI) / 16);
  const dc = huffmanCodes(DC_BITS, DC_VALUES);
  const ac = huffmanCodes(AC_BITS, AC_VALUES);
  let out = Buffer.alloc(64 * MiB);
  let length = 0;
  const ensure = (more: number) => {
    if (length + more <= out.length) return;
    const grown = Buffer.alloc(Math.max(out.length * 2, length + more));
    out.copy(grown, 0, 0, length);
    out = grown;
  };
  const marker = (code: number, payload: readonly number[]) => {
    ensure(payload.length + 4);
    out.writeUInt16BE(0xff00 | code, length);
    out.writeUInt16BE(payload.length + 2, length + 2);
    length += 4;
    for (const value of payload) out[length++] = value;
  };
  let accumulator = 0;
  let filled = 0;
  const put = (value: number, count: number) => {
    for (let bit = count - 1; bit >= 0; bit -= 1) {
      accumulator = (accumulator << 1) | ((value >> bit) & 1);
      if (++filled === 8) {
        ensure(2);
        out[length++] = accumulator;
        // A data FF is stuffed with a zero.
        if (accumulator === 0xff) out[length++] = 0;
        accumulator = 0;
        filled = 0;
      }
    }
  };
  const category = (value: number) => {
    let magnitude = Math.abs(value);
    let bits = 0;
    while (magnitude) {
      bits += 1;
      magnitude >>= 1;
    }
    return bits;
  };
  const amplitude = (value: number, bits: number) =>
    value >= 0 ? value : value + (1 << bits) - 1;

  ensure(2);
  out[length++] = 0xff;
  out[length++] = 0xd8;
  marker(0xee, [0x41, 0x64, 0x6f, 0x62, 0x65, 0, 0x64, 0, 0, 0, 0, 0]);
  marker(0xdb, [0, ...ZIGZAG.map((index) => table[index]!)]);
  marker(0xc0, [
    8,
    height >> 8,
    height & 0xff,
    width >> 8,
    width & 0xff,
    components,
    ...Array.from({ length: components }, (_, index) => [
      index + 1,
      0x11,
      0,
    ]).flat(),
  ]);
  marker(0xc4, [
    0x00,
    ...DC_BITS,
    ...DC_VALUES,
    0x10,
    ...AC_BITS,
    ...AC_VALUES,
  ]);
  const across = Math.ceil(width / 8);
  const down = Math.ceil(height / 8);
  const block = new Float64Array(64);
  const rows = new Float64Array(64);
  const quantized = new Int32Array(64);
  for (let component = 0; component < components; component += 1) {
    // Ns = 1: this component only, the whole spectrum, Huffman tables 0.
    marker(0xda, [1, component + 1, 0x00, 0, 63, 0]);
    let previous = 0;
    for (let by = 0; by < down; by += 1)
      for (let bx = 0; bx < across; bx += 1) {
        for (let y = 0; y < 8; y += 1) {
          const row = Math.min(height - 1, by * 8 + y) * width;
          for (let x = 0; x < 8; x += 1)
            block[y * 8 + x] =
              samples[
                (row + Math.min(width - 1, bx * 8 + x)) * components + component
              ]! - 128;
        }
        for (let y = 0; y < 8; y += 1)
          for (let u = 0; u < 8; u += 1) {
            let sum = 0;
            for (let x = 0; x < 8; x += 1)
              sum += block[y * 8 + x]! * cosine[u * 8 + x]!;
            rows[y * 8 + u] = sum;
          }
        for (let v = 0; v < 8; v += 1)
          for (let u = 0; u < 8; u += 1) {
            let sum = 0;
            for (let y = 0; y < 8; y += 1)
              sum += cosine[v * 8 + y]! * rows[y * 8 + u]!;
            quantized[v * 8 + u] = Math.round(sum / table[v * 8 + u]!);
          }
        const difference = quantized[0]! - previous;
        previous = quantized[0]!;
        const size = category(difference);
        put(dc.code[size]!, dc.size[size]!);
        if (size) put(amplitude(difference, size), size);
        let run = 0;
        for (let k = 1; k < 64; k += 1) {
          const value = quantized[ZIGZAG[k]!]!;
          if (value === 0) {
            run += 1;
            continue;
          }
          while (run > 15) {
            put(ac.code[0xf0]!, ac.size[0xf0]!);
            run -= 16;
          }
          const bits = category(value);
          const symbol = (run << 4) | bits;
          put(ac.code[symbol]!, ac.size[symbol]!);
          put(amplitude(value, bits), bits);
          run = 0;
        }
        if (run) put(ac.code[0]!, ac.size[0]!);
      }
    // Pad the scan's last byte with one bits.
    if (filled) put(0x7f, 8 - filled);
  }
  ensure(2);
  out[length++] = 0xff;
  out[length++] = 0xd9;
  return out.subarray(0, length);
};

/** Naive CMYK from the texture's RGB: K from the darkest, the rest over it. */
const cmykSamples = (rgb: Buffer): Buffer => {
  const pixels = rgb.length / 3;
  const cmyk = Buffer.alloc(pixels * 4);
  for (let pixel = 0; pixel < pixels; pixel += 1) {
    const c = 255 - rgb[pixel * 3]!;
    const m = 255 - rgb[pixel * 3 + 1]!;
    const y = 255 - rgb[pixel * 3 + 2]!;
    const k = Math.min(c, m, y);
    cmyk[pixel * 4] = c - k;
    cmyk[pixel * 4 + 1] = m - k;
    cmyk[pixel * 4 + 2] = y - k;
    cmyk[pixel * 4 + 3] = k;
  }
  return cmyk;
};

const encode = async (item: BenchCase): Promise<Buffer> => {
  if (item.scans === "per-component") {
    if (
      item.format !== "jpeg" ||
      !item.cmyk ||
      item.channels !== 3 ||
      item.subsampling !== "4:4:4" ||
      item.progressive ||
      item.orientation !== undefined ||
      item.headerWidth !== undefined
    )
      throw new Error(`${item.name}: scans per component need CMYK 4:4:4`);
    return encodeScansPerComponent(
      cmykSamples(texture(item.width, item.height, 3, item.noise)),
      item.width,
      item.height,
    );
  }
  let pipeline = sharp(
    texture(item.width, item.height, item.channels, item.noise),
    {
      raw: { width: item.width, height: item.height, channels: item.channels },
      limitInputPixels: false,
    },
  );
  if (item.orientation !== undefined)
    pipeline = pipeline.withMetadata({ orientation: item.orientation });
  if (item.cmyk) pipeline = pipeline.toColourspace("cmyk");
  if (item.format === "jpeg")
    pipeline = pipeline.jpeg({
      quality: item.bytes === undefined ? 90 : 98,
      chromaSubsampling:
        item.subsampling ?? (item.bytes === undefined ? "4:2:0" : "4:4:4"),
      progressive: item.progressive === true,
    });
  else if (item.format === "png")
    pipeline = (
      item.depth === 16 ? pipeline.toColourspace("rgb16") : pipeline
    ).png({ compressionLevel: 6, progressive: item.progressive === true });
  else pipeline = pipeline.webp({ quality: 90 });
  const bytes = await pipeline.toBuffer();
  return item.headerWidth === undefined
    ? bytes
    : patchJpegWidth(bytes, item.headerWidth);
};

const sha256 = (value: string | Buffer) =>
  createHash("sha256").update(value).digest("hex");

const EXTENSION: Readonly<Record<Format, string>> = {
  jpeg: "jpg",
  png: "png",
  webp: "webp",
};
const mimeOf = (objectKey: string) =>
  objectKey.endsWith(".jpg")
    ? ("image/jpeg" as const)
    : objectKey.endsWith(".png")
      ? ("image/png" as const)
      : ("image/webp" as const);

interface Original {
  readonly objectKey: string;
  readonly sha256: string;
  readonly bytes: number;
}

/**
 * Writes the case's original once under `media/` with the editorial file
 * name the Development source reader resolves, and reuses it afterwards.
 */
const original = async (media: string, item: BenchCase): Promise<Original> => {
  const recordPath = path.join(media, `${item.name}.json`);
  const identity = { version: GENERATOR_VERSION, ...item };
  const mediaHash = sha256(`catalog-render-bench:${item.name}`);
  const recorded = await readFile(recordPath, "utf8")
    .then((text) => JSON.parse(text) as Original & { identity: unknown })
    .catch(() => null);
  if (
    recorded !== null &&
    JSON.stringify(recorded.identity) === JSON.stringify(identity)
  ) {
    const file = path.join(media, recorded.objectKey.split("/").at(-1)!);
    if (
      sha256(await readFile(file).catch(() => Buffer.alloc(0))) ===
      recorded.sha256
    )
      return recorded;
  }
  const bytes = await encode(item);
  const digest = sha256(bytes);
  const name = `${mediaHash}-${digest}.${EXTENSION[item.format]}`;
  const temporary = path.join(media, `.${name}.tmp`);
  await writeFile(temporary, bytes, { mode: 0o644 });
  await rename(temporary, path.join(media, name));
  const result: Original = {
    objectKey: `editorial/${sha256("catalog-render-bench")}/${name}`,
    sha256: digest,
    bytes: bytes.length,
  };
  await writeFile(recordPath, JSON.stringify({ ...result, identity }));
  return result;
};

interface CgroupSample {
  peak: number;
  maxCurrent: number;
  maxAnon: number;
  maxShmem: number;
  maxFile: number;
  maxAnonShmem: number;
  usageUsec: number;
  throttledUsec: number;
  oomKills: number;
  samples: number;
}

/** The sandbox's cgroup memory limit, as memory.max reports it. */
const SANDBOX_MEMORY_BYTES =
  Number(/^(\d+)m$/u.exec(SANDBOX_LIMITS.memory)![1]) * MiB;

const WATCH_SCRIPT = `
limit="$1"
while :; do
  for d in /cg/docker/*/; do
    [ "$(cat "\${d}memory.max" 2>/dev/null)" = "$limit" ] || continue
    id=\${d%/}; id=\${id##*/}
    peak=$(cat "\${d}memory.peak" 2>/dev/null) || continue
    current=$(cat "\${d}memory.current" 2>/dev/null) || continue
    stat=$(awk '$1=="anon"||$1=="shmem"||$1=="file"{printf "%s=%s ",$1,$2}' "\${d}memory.stat" 2>/dev/null)
    cpu=$(awk '$1=="usage_usec"||$1=="throttled_usec"{printf "%s=%s ",$1,$2}' "\${d}cpu.stat" 2>/dev/null)
    oom=$(awk '$1=="oom_kill"{print $2}' "\${d}memory.events" 2>/dev/null)
    echo "$id peak=$peak current=$current $stat$cpu oom_kill=$oom"
  done
  sleep 0.1
done
`;

/**
 * One sidecar container that prints the cgroup memory and CPU counters of
 * every container limited like the sandbox, ten times a second.
 */
const startCgroupWatch = () => {
  const name = `catalog-render-bench-watch-${randomBytes(6).toString("hex")}`;
  const child = nodeSpawn(
    "docker",
    [
      "run",
      "--rm",
      "--pull",
      "never",
      "--name",
      name,
      "--network",
      "none",
      "--read-only",
      "--cap-drop",
      "ALL",
      "--security-opt",
      "no-new-privileges",
      "--user",
      SANDBOX_LIMITS.user,
      "--memory",
      "64m",
      "--cgroupns",
      "host",
      "--mount",
      "type=bind,source=/sys/fs/cgroup,target=/cg,readonly",
      "--entrypoint",
      "/bin/sh",
      IMAGE,
      "-c",
      WATCH_SCRIPT,
      "watch",
      String(SANDBOX_MEMORY_BYTES),
    ],
    { stdio: ["ignore", "pipe", "ignore"] },
  );
  const byId = new Map<string, CgroupSample>();
  let pending = "";
  child.stdout.on("data", (chunk: Buffer) => {
    pending += chunk.toString("utf8");
    const lines = pending.split("\n");
    pending = lines.pop() ?? "";
    for (const line of lines) {
      const [id, ...pairs] = line.trim().split(/\s+/u);
      if (id === undefined || !/^[0-9a-f]{64}$/u.test(id)) continue;
      const value = Object.fromEntries(
        pairs.map((pair) => {
          const [key, number] = pair.split("=");
          return [key, Number(number)];
        }),
      ) as Record<string, number>;
      const anon = value.anon ?? 0;
      const shmem = value.shmem ?? 0;
      const previous = byId.get(id);
      byId.set(id, {
        peak: Math.max(previous?.peak ?? 0, value.peak ?? 0),
        maxCurrent: Math.max(previous?.maxCurrent ?? 0, value.current ?? 0),
        maxAnon: Math.max(previous?.maxAnon ?? 0, anon),
        maxShmem: Math.max(previous?.maxShmem ?? 0, shmem),
        maxFile: Math.max(previous?.maxFile ?? 0, value.file ?? 0),
        maxAnonShmem: Math.max(previous?.maxAnonShmem ?? 0, anon + shmem),
        usageUsec: Math.max(previous?.usageUsec ?? 0, value.usage_usec ?? 0),
        throttledUsec: Math.max(
          previous?.throttledUsec ?? 0,
          value.throttled_usec ?? 0,
        ),
        oomKills: Math.max(previous?.oomKills ?? 0, value.oom_kill ?? 0),
        samples: (previous?.samples ?? 0) + 1,
      });
    }
  });
  return {
    byId,
    async stop() {
      child.kill("SIGTERM");
      await run("docker", ["rm", "--force", name]).catch(() => undefined);
    },
  };
};

/** The full id of a running container by exact name, polled until it ends. */
const containerId = async (
  name: string,
  done: () => boolean,
): Promise<string | null> => {
  while (!done()) {
    const { stdout } = await run("docker", [
      "ps",
      "--no-trunc",
      "--quiet",
      "--filter",
      `name=^/${name}$`,
    ]).catch(() => ({ stdout: "" }));
    const id = stdout.trim();
    if (/^[0-9a-f]{64}$/u.test(id)) return id;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return null;
};

interface RunRecord {
  readonly case: string;
  readonly repeat: number;
  readonly outcome: string;
  readonly totalMs: number;
  readonly stageMs: number | null;
  readonly containerMs: number | null;
  readonly prepareMs: number | null;
  readonly roles: Readonly<Record<string, number>>;
  readonly outputs: readonly {
    role: string;
    width: number;
    height: number;
    bytes: number;
  }[];
  readonly memory: CgroupSample | null;
}

const MiBText = (bytes: number | undefined) =>
  bytes === undefined ? "-" : (bytes / MiB).toFixed(0);
const seconds = (ms: number | null | undefined) =>
  ms === null || ms === undefined ? "-" : (ms / 1000).toFixed(1);
const range = (
  values: readonly number[],
  format: (value: number) => string,
) => {
  if (values.length === 0) return "-";
  const sorted = [...values].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)]!;
  return `${format(median)} (${format(sorted[0]!)}-${format(sorted.at(-1)!)})`;
};

describe.skipIf(!OUTPUT)(
  "Catalog render timing at the ingest limits (S5b)",
  () => {
    it(
      "renders every case in the sandbox and records time and memory",
      async () => {
        const output = path.resolve(OUTPUT!);
        // Vitest prints the console when the test ends; progress.log is live.
        const progress = (line: string) =>
          appendFile(path.join(output, "progress.log"), `${line}\n`);
        // A fresh work directory per run: Docker Desktop's file sharing can
        // keep a removed and recreated bind source invisible to the daemon.
        const directories = {
          media: path.join(output, "media"),
          work: path.join(output, `work-${randomBytes(6).toString("hex")}`),
          store: path.join(output, "store"),
        };
        for (const directory of Object.values(directories)) {
          await mkdir(directory, { recursive: true, mode: 0o700 });
          await chmod(directory, 0o700);
        }
        const extra = JSON.parse(
          env.MOYA_CATALOG_RENDER_BENCH_EXTRA_CASES ?? "[]",
        ) as BenchCase[];
        const cases = [...CASES, ...extra].filter(
          (item) => SELECTED === undefined || SELECTED.includes(item.name),
        );
        expect(cases.length).toBeGreaterThan(0);

        // Each case sits at or under every ingest limit, except the one limit
        // a `beyond` case is over.
        for (const item of cases) {
          const width = item.headerWidth ?? item.width;
          const sample = (item.depth ?? 8) / 8;
          const channels = item.cmyk ? 4 : item.channels;
          const over = {
            pixels: width * item.height > CATALOG_ORIGINAL_MAX_PIXELS,
            decoded:
              width * item.height * channels * sample >
              CATALOG_ORIGINAL_MAX_DECODED_BYTES,
            edge: Math.max(width, item.height) > CATALOG_ORIGINAL_MAX_EDGE,
            row: width * channels * sample > CATALOG_ORIGINAL_MAX_ROW_BYTES,
          };
          expect(over, item.name).toEqual({
            pixels: false,
            decoded: false,
            edge: item.beyond === "edge",
            row: item.beyond === "row",
          });
        }
        // The Admin's ingest probe, on the stored bytes.
        const probed = async (made: Original) => {
          const probe = new ImageStructureProbe(mimeOf(made.objectKey));
          try {
            probe.update(
              await readFile(
                path.join(directories.media, made.objectKey.split("/").at(-1)!),
              ),
            );
            probe.finish();
            return "accepted";
          } catch (error) {
            if (error instanceof ImageProbeError) return error.code;
            throw error;
          }
        };

        const originals = new Map<string, Original>();
        for (const item of cases) {
          const started = performance.now();
          const made = await original(directories.media, item);
          expect(made.bytes).toBeLessThanOrEqual(CATALOG_SOURCE_MAX_BYTES);
          if (item.bytes !== undefined) {
            expect(made.bytes).toBeGreaterThanOrEqual(item.bytes[0]);
            expect(made.bytes).toBeLessThanOrEqual(item.bytes[1]);
          }
          expect(catalogKeySha256(made.objectKey)).toBe(made.sha256);
          expect(await probed(made), item.name).toBe(
            item.beyond === undefined ? "accepted" : "bounds",
          );
          if (item.scans !== undefined) {
            // libjpeg itself reports the file as multi-scan (sharp's
            // isProgressive is jpeg_has_multiple_scans), though it is SOF0.
            const metadata = await sharp(
              path.join(directories.media, made.objectKey.split("/").at(-1)!),
            ).metadata();
            expect(metadata, item.name).toMatchObject({
              format: "jpeg",
              width: item.width,
              height: item.height,
              channels: 4,
              isProgressive: true,
            });
          }
          originals.set(item.name, made);
          await progress(
            `[render-bench] original ${item.name} ${MiBText(made.bytes)} MiB in ${seconds(performance.now() - started)} s`,
          );
        }

        const watch = startCgroupWatch();
        let current: { name: string | null; ended: boolean } = {
          name: null,
          ended: true,
        };
        const ids = new Map<string, Promise<string | null>>();
        const spawn: SandboxSpawn = (command, args, options) => {
          const runIndex = args.indexOf("--name");
          if (args[0] === "run" && runIndex >= 0) {
            const name = args[runIndex + 1]!;
            if (CPUS !== undefined) args[args.indexOf("--cpus") + 1] = CPUS;
            const state = { name, ended: false };
            current = state;
            const child = nodeSpawn(command, args, {
              stdio: ["ignore", "pipe", "pipe"],
              shell: false,
              windowsHide: true,
              env: { ...options.env } as NodeJS.ProcessEnv,
            });
            // The Docker CLI's own refusal (exit 125), for the progress log.
            let cliError = "";
            child.stderr.on("data", (chunk: Buffer) => {
              if (cliError.length < 512) cliError += chunk.toString("utf8");
            });
            child.on("close", (code) => {
              state.ended = true;
              if (code === 125)
                void progress(
                  `[render-bench] docker run 125: ${cliError.trim()}`,
                );
            });
            ids.set(
              name,
              containerId(name, () => state.ended),
            );
            return child;
          }
          return nodeSpawn(command, args, {
            stdio: ["ignore", "pipe", "pipe"],
            shell: false,
            windowsHide: true,
            env: { ...options.env } as NodeJS.ProcessEnv,
          });
        };
        const runner = await createSandboxRunner({
          image: IMAGE,
          workDirectory: directories.work,
          appDist: defaultSandboxAppDist().appDist,
          temporaryRoots: [],
          spawn,
        });
        let last: {
          stageStarted: number;
          runStarted: number | null;
          runEnded: number | null;
          timings: SandboxTimings | null;
        } = {
          stageStarted: 0,
          runStarted: null,
          runEnded: null,
          timings: null,
        };
        const measured: Pick<SandboxRunner, "createJob" | "run"> = {
          createJob: () => runner.createJob(),
          async run(job, request, options) {
            last.runStarted = performance.now();
            try {
              const result = await runner.run(job, request, options);
              last.timings = result.manifest.timings ?? null;
              return result;
            } finally {
              last.runEnded = performance.now();
            }
          },
        };
        const store = await FilesystemPublishingMediaStore.open(
          directories.store,
          {
            temporaryRoots: [],
          },
        );
        const renderer = createCatalogRenderer({
          store,
          sandbox: measured,
          source: new LocalCatalogSourceReader(directories.media),
          logger: { error: () => undefined },
        });

        const records: RunRecord[] = [];
        try {
          for (const item of cases) {
            const made = originals.get(item.name)!;
            for (let repeat = 1; repeat <= REPEAT; repeat += 1) {
              last = {
                stageStarted: performance.now(),
                runStarted: null,
                runEnded: null,
                timings: null,
              };
              let outcome: string;
              let outputs: RunRecord["outputs"] = [];
              try {
                const result = await renderer.render({
                  assetId: `bench-${item.name}`,
                  mediaId: `bench-${item.name}`,
                  sourceObjectKey: made.objectKey,
                  sourceSha256: made.sha256,
                  sourceContentType: `image/${item.format}`,
                  sourceWidth: item.width,
                  sourceHeight: item.height,
                  state: "pending",
                  referenced: true,
                  ready: [],
                });
                if (result.status === "rendered") {
                  outcome = "rendered";
                  outputs = result.outcome.renditions.map((rendition) => ({
                    role: rendition.role,
                    width: rendition.width,
                    height: rendition.height,
                    bytes: rendition.byteSize,
                  }));
                  await Promise.all(
                    result.outcome.renditions.map((rendition) =>
                      store.remove(rendition.storageKey),
                    ),
                  );
                } else outcome = `rejected:${result.failureCode}`;
              } catch (error) {
                outcome = `error:${(error as { code?: string }).code ?? (error as Error).name}`;
              }
              const totalMs = performance.now() - last.stageStarted;
              const id =
                current.name === null ? null : await ids.get(current.name);
              // The last samples of a container that just ended.
              await new Promise((resolve) => setTimeout(resolve, 250));
              const memory =
                id === null || id === undefined
                  ? null
                  : (watch.byId.get(id) ?? null);
              const record: RunRecord = {
                case: item.name,
                repeat,
                outcome,
                totalMs,
                stageMs:
                  last.runStarted === null
                    ? null
                    : last.runStarted - last.stageStarted,
                containerMs:
                  last.runStarted === null || last.runEnded === null
                    ? null
                    : last.runEnded - last.runStarted,
                prepareMs: last.timings?.prepareMs ?? null,
                roles: last.timings?.roles ?? {},
                outputs,
                memory: memory === null ? null : { ...memory },
              };
              records.push(record);
              current = { name: null, ended: true };
              await progress(
                `[render-bench] ${item.name} #${repeat} ${outcome} total=${seconds(totalMs)}s container=${seconds(record.containerMs)}s prepare=${seconds(record.prepareMs)}s roles=${Object.entries(
                  record.roles,
                )
                  .map(([role, ms]) => `${role}:${seconds(ms)}`)
                  .join(
                    ",",
                  )} peak=${MiBText(memory?.peak)}MiB anon+shmem=${MiBText(memory?.maxAnonShmem)}MiB oom=${memory?.oomKills ?? "-"}`,
              );
            }
          }
        } finally {
          await watch.stop();
          await rm(directories.work, { recursive: true, force: true });
        }

        const report = {
          generatedAt: new Date().toISOString(),
          image: IMAGE,
          cpus: CPUS ?? SANDBOX_LIMITS.cpus,
          sandbox: {
            memory: SANDBOX_LIMITS.memory,
            renditionTimeoutMs: SANDBOX_TIMEOUTS_MS.rendition,
            staticJobTimeoutMs: SANDBOX_TIMEOUTS_MS.static,
            maxPixels: SANDBOX_INPUT_LIMITS.maxPixels,
            maxDecodedBytes: SANDBOX_INPUT_LIMITS.maxDecodedBytes,
          },
          ingestLimits: {
            maxBytes: CATALOG_ORIGINAL_MAX_BYTES,
            maxPixels: CATALOG_ORIGINAL_MAX_PIXELS,
            maxDecodedBytes: CATALOG_ORIGINAL_MAX_DECODED_BYTES,
            maxEdge: CATALOG_ORIGINAL_MAX_EDGE,
            maxRowBytes: CATALOG_ORIGINAL_MAX_ROW_BYTES,
          },
          cases: cases.map((item) => ({
            ...item,
            bytes: originals.get(item.name)!.bytes,
          })),
          runs: records,
        };
        await writeFile(
          path.join(output, "render-bench.json"),
          `${JSON.stringify(report, null, 2)}\n`,
        );
        const lines = [
          `cpus=${report.cpus} memory=${SANDBOX_LIMITS.memory} repeats=${REPEAT}`,
          "case | MiB | outcome | job s | container s | prepare s | slowest role s | peak MiB | anon+shmem MiB",
        ];
        for (const item of cases) {
          const runs = records.filter((record) => record.case === item.name);
          const roleMax = runs.map((record) =>
            Math.max(0, ...Object.values(record.roles)),
          );
          lines.push(
            [
              item.beyond === undefined
                ? item.name
                : `${item.name} (over the ${item.beyond} limit)`,
              MiBText(originals.get(item.name)!.bytes),
              [...new Set(runs.map((record) => record.outcome))].join("/"),
              range(
                runs.map((record) => record.totalMs),
                (value) => seconds(value),
              ),
              range(
                runs.flatMap((record) =>
                  record.containerMs === null ? [] : [record.containerMs],
                ),
                (value) => seconds(value),
              ),
              range(
                runs.flatMap((record) =>
                  record.prepareMs === null ? [] : [record.prepareMs],
                ),
                (value) => seconds(value),
              ),
              range(roleMax, (value) => seconds(value)),
              range(
                runs.flatMap((record) =>
                  record.memory === null ? [] : [record.memory.peak],
                ),
                MiBText,
              ),
              range(
                runs.flatMap((record) =>
                  record.memory === null ? [] : [record.memory.maxAnonShmem],
                ),
                MiBText,
              ),
            ].join(" | "),
          );
        }
        // The cases within every limit, against the sandbox's own bounds.
        const within = records.filter(
          (record) =>
            cases.find((item) => item.name === record.case)!.beyond ===
            undefined,
        );
        const worst = (values: number[]) => Math.max(0, ...values);
        const peak = worst(within.map((record) => record.memory?.peak ?? 0));
        lines.push(
          `within the limits: peak ${MiBText(peak)} MiB (${((100 * peak) / SANDBOX_MEMORY_BYTES).toFixed(0)}% of ${SANDBOX_LIMITS.memory})` +
            `, slowest role ${seconds(worst(within.flatMap((record) => Object.values(record.roles))))} s of ${SANDBOX_TIMEOUTS_MS.rendition / 1000}` +
            `, slowest container ${seconds(worst(within.map((record) => record.containerMs ?? 0)))} s of ${SANDBOX_TIMEOUTS_MS.static / 1000}`,
        );
        await writeFile(
          path.join(output, "render-bench.txt"),
          `${lines.join("\n")}\n`,
        );
        console.log(lines.join("\n"));

        for (const item of cases)
          for (const record of records.filter(
            (entry) => entry.case === item.name,
          ))
            expect(
              record.outcome.startsWith(item.expect),
              `${item.name} #${record.repeat}: ${record.outcome}`,
            ).toBe(true);
      },
      6 * 60 * 60_000,
    );
  },
);

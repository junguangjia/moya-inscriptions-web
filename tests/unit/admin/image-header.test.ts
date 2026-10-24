import sharp from "sharp";
import { beforeAll, describe, expect, it } from "vitest";

import {
  CATALOG_ORIGINAL_MAX_DECODED_BYTES,
  CATALOG_ORIGINAL_MAX_EDGE,
  CATALOG_ORIGINAL_MAX_INTERLACED_DECODED_BYTES,
  CATALOG_ORIGINAL_MAX_JPEG_COEFFICIENT_BYTES,
  CATALOG_ORIGINAL_MAX_PIXELS,
  CATALOG_ORIGINAL_MAX_ROW_BYTES,
} from "@moya/contracts/internal/editorial";
import {
  ImageProbeError,
  ImageStructureProbe,
  imageTailComplete,
  type ImageMimeType,
  type ImageProbeOptions,
} from "admin/media-image-header";

/*
 * catalog-scale-v1 increment 2: the incremental header and structural
 * completeness probe a Catalog ingest runs while it hashes staged bytes.
 * Fixtures are synthetic: sharp-encoded images and hand-built headers (the
 * probe never decodes pixels, so a header with no real image data is enough
 * to exercise every bound).
 */

type Outcome = { width: number; height: number } | { refused: string };

const run = (
  mimeType: ImageMimeType,
  bytes: Uint8Array,
  chunks: number[] = [bytes.length],
  options: ImageProbeOptions = {},
): Outcome => {
  try {
    const probe = new ImageStructureProbe(mimeType, options);
    let offset = 0;
    for (const size of chunks) {
      if (offset >= bytes.length) break;
      probe.update(bytes.subarray(offset, offset + size));
      offset += size;
    }
    if (offset < bytes.length) probe.update(bytes.subarray(offset));
    const { width, height } = probe.finish();
    return { width, height };
  } catch (error) {
    if (error instanceof ImageProbeError) return { refused: error.code };
    throw error;
  }
};

// A seeded generator: the fuzz is reproducible.
const random = (seed: number) => () => {
  seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
  return seed / 2_147_483_648;
};
const splits = (length: number, seed: number) => {
  const next = random(seed);
  const sizes: number[] = [];
  for (let total = 0; total < length;) {
    const size =
      next() < 0.3
        ? 1
        : Math.max(1, Math.floor(next() * Math.min(length, 9000)));
    sizes.push(size);
    total += size;
  }
  return sizes;
};

const bytesOf = (...parts: (Uint8Array | number[])[]) =>
  Uint8Array.from(parts.flatMap((part) => [...part]));
const segment = (marker: number, payload: Uint8Array | number[]) => {
  const length = payload.length + 2;
  return bytesOf([0xff, marker, length >> 8, length & 0xff], payload);
};
const frame = (
  marker: number,
  width: number,
  height: number,
  components = 3,
  precision = 8,
  /** Each component's sampling factors (H << 4 | V); 1 × 1 by default. */
  sampling: readonly number[] = [],
) =>
  segment(marker, [
    precision,
    height >> 8,
    height & 0xff,
    width >> 8,
    width & 0xff,
    components,
    ...Array.from({ length: components }, (_, index) => [
      index + 1,
      sampling[index] ?? 0x11,
      0,
    ]).flat(),
  ]);
const scan = (components = 3) =>
  scanOf(...Array.from({ length: components }, (_, index) => index + 1));
/** A sequential scan of the given component selectors. */
const scanOf = (...selectors: number[]) =>
  segment(0xda, [
    selectors.length,
    ...selectors.flatMap((selector) => [selector, 0]),
    0,
    63,
    0,
  ]);
// Entropy data with a stuffed FF and a restart marker.
const entropy = [0x12, 0xff, 0x00, 0x34, 0xff, 0xd0, 0x56, 0x78];
const jpegOf = (
  sof: Uint8Array,
  { before = [] as Uint8Array[], components = 3 } = {},
) =>
  bytesOf(
    [0xff, 0xd8],
    ...before,
    segment(0xdb, new Array(65).fill(1)),
    sof,
    segment(0xc4, new Array(20).fill(0)),
    scan(components),
    entropy,
    [0xff, 0xd9],
  );
/** A JPEG with one scan per group of component selectors, in order. */
const scansOf = (sof: Uint8Array, groups: readonly (readonly number[])[]) =>
  bytesOf(
    [0xff, 0xd8],
    segment(0xdb, new Array(65).fill(1)),
    sof,
    segment(0xc4, new Array(20).fill(0)),
    ...groups.flatMap((group) => [scanOf(...group), Uint8Array.from(entropy)]),
    [0xff, 0xd9],
  );

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (bytes: Uint8Array) => {
  let c = 0xffffffff;
  for (const byte of bytes) c = crcTable[(c ^ byte) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const u32 = (value: number) => [
  (value >>> 24) & 0xff,
  (value >>> 16) & 0xff,
  (value >>> 8) & 0xff,
  value & 0xff,
];
const chunk = (type: string, data: Uint8Array | number[] = []) => {
  const body = bytesOf(
    [...type].map((c) => c.charCodeAt(0)),
    data,
  );
  return bytesOf(u32(data.length), body, u32(crc32(body)));
};
const ihdr = (
  width: number,
  height: number,
  depth = 8,
  colour = 6,
  interlace = 0,
) =>
  chunk("IHDR", [
    ...u32(width),
    ...u32(height),
    depth,
    colour,
    0,
    0,
    interlace,
  ]);
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const pngOf = (...chunks: Uint8Array[]) => bytesOf(PNG_SIGNATURE, ...chunks);

const le32 = (value: number) => [
  value & 0xff,
  (value >>> 8) & 0xff,
  (value >>> 16) & 0xff,
  (value >>> 24) & 0xff,
];
const le24 = (value: number) => le32(value).slice(0, 3);
const riffChunk = (fourcc: string, data: number[]) =>
  bytesOf(
    [...fourcc].map((c) => c.charCodeAt(0)),
    le32(data.length),
    data,
    data.length % 2 ? [0] : [],
  );
const webpOf = (...chunks: Uint8Array[]) => {
  const body = bytesOf([0x57, 0x45, 0x42, 0x50], ...chunks);
  return bytesOf([0x52, 0x49, 0x46, 0x46], le32(body.length), body);
};
const vp8 = (width: number, height: number) =>
  riffChunk("VP8 ", [
    0x10,
    0x02,
    0x00,
    0x9d,
    0x01,
    0x2a,
    width & 0xff,
    width >> 8,
    height & 0xff,
    height >> 8,
    1,
    2,
    3,
  ]);
const vp8x = (width: number, height: number, flags = 0) =>
  riffChunk("VP8X", [flags, 0, 0, 0, ...le24(width - 1), ...le24(height - 1)]);

let jpeg: Buffer;
let progressive: Buffer;
let png: Buffer;
let interlaced: Buffer;
let webpLossy: Buffer;
let webpLossless: Buffer;
let webpAlpha: Buffer;

beforeAll(async () => {
  const image = () =>
    sharp({
      create: {
        width: 64,
        height: 48,
        channels: 3,
        background: { r: 120, g: 30, b: 200 },
      },
    });
  jpeg = await image().jpeg().toBuffer();
  progressive = await image().jpeg({ progressive: true }).toBuffer();
  png = await image().png().toBuffer();
  interlaced = await image().png({ progressive: true }).toBuffer();
  webpLossy = await image().webp().toBuffer();
  webpLossless = await image().webp({ lossless: true }).toBuffer();
  webpAlpha = await sharp({
    create: {
      width: 64,
      height: 48,
      channels: 4,
      background: { r: 1, g: 2, b: 3, alpha: 0.5 },
    },
  })
    .webp()
    .toBuffer();
});

describe("JPEG", () => {
  it("reads the frame of baseline and progressive (SOF2) encoder output", () => {
    expect(run("image/jpeg", jpeg)).toEqual({ width: 64, height: 48 });
    expect(progressive.includes(Buffer.from([0xff, 0xc2]))).toBe(true);
    expect(run("image/jpeg", progressive)).toEqual({ width: 64, height: 48 });
  });

  it("finds the frame after multi-megabyte APPn, ICC and XMP segments without a window", () => {
    const app = (marker: number) =>
      segment(marker, new Uint8Array(65_533).fill(0xd8));
    const before = [
      ...Array.from({ length: 40 }, () => app(0xe1)),
      ...Array.from({ length: 30 }, () => app(0xe2)),
    ];
    const bytes = bytesOf([0xff, 0xd8], ...before, jpeg.subarray(2));
    expect(bytes.length).toBeGreaterThan(4 * 1024 * 1024);
    expect(run("image/jpeg", bytes)).toEqual({ width: 64, height: 48 });
  });

  it("never takes an EXIF thumbnail's own SOI and SOF for the main frame", () => {
    const thumbnail = bytesOf(
      [0x45, 0x78, 0x69, 0x66, 0, 0],
      [0xff, 0xd8],
      frame(0xc0, 9999, 7777),
      scan(),
      entropy,
      [0xff, 0xd9],
    );
    const bytes = bytesOf(
      [0xff, 0xd8],
      segment(0xe1, thumbnail),
      jpeg.subarray(2),
    );
    expect(run("image/jpeg", bytes)).toEqual({ width: 64, height: 48 });
  });

  it("bounds the decoded size by components (CMYK)", () => {
    const cmyk = jpegOf(frame(0xc0, 100, 100, 4), { components: 4 });
    expect(
      run("image/jpeg", cmyk, undefined, { maxDecodedBytes: 40_000 }),
    ).toEqual({ width: 100, height: 100 });
    expect(
      run("image/jpeg", cmyk, undefined, { maxDecodedBytes: 39_999 }),
    ).toEqual({ refused: "bounds" });
    // At the default bounds: 8-bit CMYK at 120 MP fits.
    expect(
      run(
        "image/jpeg",
        jpegOf(frame(0xc0, 12_000, 10_000, 4), { components: 4 }),
      ),
    ).toEqual({ width: 12_000, height: 10_000 });
    expect(run("image/jpeg", jpegOf(frame(0xc0, 12_001, 10_000)))).toEqual({
      refused: "bounds",
    });
  });

  it("refuses a side over 65,500 px, which the sandbox's JPEG decoder cannot read (S5b)", () => {
    expect(run("image/jpeg", jpegOf(frame(0xc0, 65_500, 1_832)))).toEqual({
      width: 65_500,
      height: 1_832,
    });
    expect(run("image/jpeg", jpegOf(frame(0xc0, 65_501, 1_831)))).toEqual({
      refused: "bounds",
    });
    expect(run("image/jpeg", jpegOf(frame(0xc0, 1_831, 65_535)))).toEqual({
      refused: "bounds",
    });
  });

  it("bounds one stored row at 256 KiB, which an 8-bit JPEG at the edge never reaches (S5b)", () => {
    // CMYK at the edge: 262,000 B a row.
    const cmyk = jpegOf(frame(0xc0, 65_500, 8, 4), { components: 4 });
    expect(run("image/jpeg", cmyk)).toEqual({ width: 65_500, height: 8 });
    expect(
      run("image/jpeg", cmyk, undefined, { maxRowBytes: 261_999 }),
    ).toEqual({ refused: "bounds" });
  });

  it("refuses 12-bit samples, which the sandbox's decoder cannot read", async () => {
    for (const marker of [0xc1, 0xc2])
      expect(run("image/jpeg", jpegOf(frame(marker, 8, 8, 3, 12)))).toEqual({
        refused: "format",
      });
    expect(run("image/jpeg", jpegOf(frame(0xc1, 8, 8, 3, 8)))).toEqual({
      width: 8,
      height: 8,
    });
    expect(run("image/jpeg", jpegOf(frame(0xc1, 8, 8, 3, 16)))).toEqual({
      refused: "invalid",
    });
    // The repository's sharp, as the worker sandbox installs it (mozjpeg),
    // refuses the encoder's own baseline frame once it says 12 bits.
    const at = jpeg.indexOf(Buffer.from([0xff, 0xc0]));
    const twelve = Buffer.from(jpeg);
    twelve[at + 1] = 0xc1;
    twelve[at + 4] = 12;
    expect(run("image/jpeg", twelve)).toEqual({ refused: "format" });
    expect((await sharp(jpeg).raw().toBuffer()).length).toBe(64 * 48 * 3);
    await expect(sharp(twelve).raw().toBuffer()).rejects.toThrow(
      /precision 12/,
    );
  });

  it("bounds a progressive frame's coefficient buffer, which the decoder holds whole", () => {
    expect(CATALOG_ORIGINAL_MAX_JPEG_COEFFICIENT_BYTES).toBe(512 * 1024 ** 2);
    // CMYK 4:4:4: 1,250 x 838 blocks of 128 B per component, 511.5 MiB.
    const cmyk = (marker: number, height: number) =>
      jpegOf(frame(marker, 10_000, height, 4), { components: 4 });
    expect(run("image/jpeg", cmyk(0xc2, 6_700))).toEqual({
      width: 10_000,
      height: 6_700,
    });
    // One more block row: 512.1 MiB.
    expect(run("image/jpeg", cmyk(0xc2, 6_712))).toEqual({
      refused: "bounds",
    });
    // Arithmetic progressive (SOF10) alike; a sequential frame whose one scan
    // holds every component is decoded a band at a time.
    expect(run("image/jpeg", cmyk(0xca, 6_712))).toEqual({
      refused: "bounds",
    });
    for (const marker of [0xc0, 0xc1, 0xc9])
      expect(run("image/jpeg", cmyk(marker, 6_712))).toEqual({
        width: 10_000,
        height: 6_712,
      });
    // 120 MP: 4:2:0 (Y 2 x 2, chroma 1 x 1) holds 343.5 MiB, 4:4:4 686 MiB.
    const subsampled = jpegOf(
      frame(0xc2, 13_416, 8_944, 3, 8, [0x22, 0x11, 0x11]),
    );
    expect(run("image/jpeg", subsampled)).toEqual({
      width: 13_416,
      height: 8_944,
    });
    expect(
      run("image/jpeg", subsampled, undefined, {
        maxCoefficientBytes: 360_192_767,
      }),
    ).toEqual({ refused: "bounds" });
    expect(run("image/jpeg", jpegOf(frame(0xc2, 13_416, 8_944, 3)))).toEqual({
      refused: "bounds",
    });
    // Sampling factors outside 1-4 are malformed.
    for (const factor of [0x01, 0x10, 0x51, 0x15])
      expect(
        run("image/jpeg", jpegOf(frame(0xc2, 8, 8, 3, 8, [factor]))),
      ).toEqual({ refused: "invalid" });
  });

  it("bounds a sequential JPEG written in several scans, whose coefficients the decoder also holds whole", () => {
    // libjpeg keeps every coefficient when the first scan holds fewer
    // components than the frame (baseline, extended or arithmetic alike).
    const perComponent = [[1], [2], [3], [4]] as const;
    for (const marker of [0xc0, 0xc1, 0xc9]) {
      const cmyk = (height: number, groups: readonly (readonly number[])[]) =>
        scansOf(frame(marker, 10_000, height, 4), groups);
      // 511.5 MiB of coefficients, then one more block row: 512.1 MiB.
      expect(run("image/jpeg", cmyk(6_700, perComponent))).toEqual({
        width: 10_000,
        height: 6_700,
      });
      expect(run("image/jpeg", cmyk(6_712, perComponent))).toEqual({
        refused: "bounds",
      });
      expect(
        run(
          "image/jpeg",
          cmyk(6_712, [
            [1, 2],
            [3, 4],
          ]),
        ),
      ).toEqual({ refused: "bounds" });
      // One scan of all four, even with more after it, is not multi-scan.
      expect(run("image/jpeg", cmyk(6_712, [[1, 2, 3, 4], [1]]))).toEqual({
        width: 10_000,
        height: 6_712,
      });
    }
    // The review's case: 120 MP CMYK 4:4:4 in four scans (915.5 MiB), and
    // RGB 4:4:4 in three (686.6 MiB); both fit every other bound.
    expect(
      run("image/jpeg", scansOf(frame(0xc0, 13_416, 8_944, 4), perComponent)),
    ).toEqual({ refused: "bounds" });
    expect(
      run("image/jpeg", scansOf(frame(0xc0, 13_416, 8_944, 4), [[1, 2, 3, 4]])),
    ).toEqual({ width: 13_416, height: 8_944 });
    expect(
      run("image/jpeg", scansOf(frame(0xc0, 13_416, 8_944), [[1], [2], [3]])),
    ).toEqual({ refused: "bounds" });
    // A greyscale frame has one component, so one scan holds all of it.
    expect(
      run("image/jpeg", scansOf(frame(0xc0, 13_416, 8_944, 1), [[1]])),
    ).toEqual({ width: 13_416, height: 8_944 });
    // A first scan with no component, more than the frame's or a length
    // that disagrees with its count is malformed, as libjpeg finds it.
    for (const bad of [
      scansOf(frame(0xc0, 8, 8), [[]]),
      scansOf(frame(0xc0, 8, 8), [[1, 2, 3, 4]]),
      bytesOf(
        [0xff, 0xd8],
        frame(0xc0, 8, 8),
        segment(0xda, [1, 1, 0, 0, 63, 0, 0]),
        entropy,
        [0xff, 0xd9],
      ),
    ])
      expect(run("image/jpeg", bad)).toEqual({ refused: "invalid" });
  });

  it("applies the multi-scan bound before the header is complete, so a header prefix holds it", () => {
    const over = scansOf(frame(0xc0, 10_000, 6_712, 4), [[1], [2], [3], [4]]);
    const within = scansOf(frame(0xc0, 10_000, 6_700, 4), [[1], [2], [3], [4]]);
    // The end of the first scan's header: its marker, length and 6 bytes.
    const firstScan = (bytes: Uint8Array) =>
      Buffer.from(bytes).indexOf(Buffer.from([0xff, 0xda])) + 10;
    const probe = new ImageStructureProbe("image/jpeg");
    probe.update(within.subarray(0, firstScan(within) - 1));
    expect(probe.header).toBeNull();
    probe.update(within.subarray(firstScan(within) - 1, firstScan(within)));
    expect(probe.header).toMatchObject({ width: 10_000, height: 6_700 });
    const refused = new ImageStructureProbe("image/jpeg");
    expect(() => refused.update(over.subarray(0, firstScan(over)))).toThrow(
      ImageProbeError,
    );
    expect(refused.header).toBeNull();
  });

  it("refuses a missing FFD9, a truncated scan, a frame after the scan and unsupported frames", () => {
    expect(run("image/jpeg", jpeg.subarray(0, jpeg.length - 2))).toEqual({
      refused: "incomplete",
    });
    expect(run("image/jpeg", jpeg.subarray(0, jpeg.length - 1))).toEqual({
      refused: "incomplete",
    });
    expect(run("image/jpeg", jpeg.subarray(0, jpeg.length >> 1))).toEqual({
      refused: "incomplete",
    });
    expect(
      run("image/jpeg", bytesOf([0xff, 0xd8], scan(), entropy, [0xff, 0xd9])),
    ).toEqual({ refused: "invalid" });
    expect(
      run("image/jpeg", bytesOf([0xff, 0xd8], frame(0xc0, 8, 8), [0xff, 0xd9])),
    ).toEqual({ refused: "incomplete" });
    expect(run("image/jpeg", jpegOf(frame(0xc3, 8, 8)))).toEqual({
      refused: "format",
    });
    expect(run("image/jpeg", jpegOf(frame(0xc0, 8, 0)))).toEqual({
      refused: "invalid",
    });
    // Bytes after the EOI must still end with FFD9.
    expect(run("image/jpeg", bytesOf(jpeg, [1, 2, 3]))).toEqual({
      refused: "incomplete",
    });
    expect(run("image/jpeg", bytesOf(jpeg, [1, 2, 0xff, 0xd9]))).toEqual({
      width: 64,
      height: 48,
    });
  });
});

describe("PNG", () => {
  it("reads IHDR and requires IDAT and a final zero-length IEND", () => {
    expect(run("image/png", png)).toEqual({ width: 64, height: 48 });
    expect(run("image/png", png.subarray(0, png.length - 12))).toEqual({
      refused: "incomplete",
    });
    expect(run("image/png", png.subarray(0, png.length - 1))).toEqual({
      refused: "incomplete",
    });
    expect(run("image/png", pngOf(ihdr(8, 8), chunk("IEND")))).toEqual({
      refused: "incomplete",
    });
    expect(
      run(
        "image/png",
        pngOf(ihdr(8, 8), chunk("IDAT", [1]), chunk("IEND", [0])),
      ),
    ).toEqual({ refused: "invalid" });
    expect(run("image/png", bytesOf(png, chunk("tEXt", [1])))).toEqual({
      refused: "invalid",
    });
    expect(run("image/png", pngOf(chunk("IDAT", [1]), ihdr(8, 8)))).toEqual({
      refused: "invalid",
    });
  });

  it("refuses animation (acTL) wherever it appears", () => {
    const actl = chunk("acTL", [...u32(2), ...u32(0)]);
    expect(
      run(
        "image/png",
        pngOf(ihdr(8, 8), actl, chunk("IDAT", [1]), chunk("IEND")),
      ),
    ).toEqual({ refused: "animated" });
    expect(
      run(
        "image/png",
        pngOf(
          ihdr(8, 8),
          chunk("IDAT", [1]),
          chunk("fdAT", [0, 0, 0, 1]),
          chunk("IEND"),
        ),
      ),
    ).toEqual({ refused: "animated" });
  });

  it("applies the side, pixel and 16-bit decoded-size bounds at IHDR", () => {
    const image = (width: number, height: number, depth = 8, colour = 6) =>
      pngOf(
        ihdr(width, height, depth, colour),
        chunk("IDAT", [1]),
        chunk("IEND"),
      );
    expect(run("image/png", image(CATALOG_ORIGINAL_MAX_EDGE, 1))).toEqual({
      width: CATALOG_ORIGINAL_MAX_EDGE,
      height: 1,
    });
    expect(run("image/png", image(CATALOG_ORIGINAL_MAX_EDGE + 1, 1))).toEqual({
      refused: "bounds",
    });
    expect(run("image/png", image(12_000, 10_000))).toEqual({
      width: 12_000,
      height: 10_000,
    });
    expect(run("image/png", image(12_000, 10_001))).toEqual({
      refused: "bounds",
    });
    // 16-bit RGBA at 70 MP decodes to 560 MB.
    expect(run("image/png", image(10_000, 7_000, 8))).toEqual({
      width: 10_000,
      height: 7_000,
    });
    expect(run("image/png", image(10_000, 7_000, 16))).toEqual({
      refused: "bounds",
    });
    expect(run("image/png", image(8, 8, 16, 3))).toEqual({
      refused: "invalid",
    });
    expect(run("image/png", image(0, 8))).toEqual({ refused: "invalid" });
  });

  it("bounds the stored row, not the height: a wide 16-bit strip is refused (S5b)", () => {
    const image = (width: number, height: number, depth: number, colour = 6) =>
      pngOf(
        ihdr(width, height, depth, colour),
        chunk("IDAT", [1]),
        chunk("IEND"),
      );
    // 16-bit RGBA, 8 bytes a pixel: 32,768 px rows at most.
    expect(run("image/png", image(32_768, 1_024, 16))).toEqual({
      width: 32_768,
      height: 1_024,
    });
    expect(run("image/png", image(32_769, 8, 16))).toEqual({
      refused: "bounds",
    });
    // The same samples as a tall strip: short rows, 512 MiB decoded.
    expect(run("image/png", image(1_024, 65_500, 16))).toEqual({
      width: 1_024,
      height: 65_500,
    });
    // 16-bit RGB, 6 bytes a pixel.
    expect(run("image/png", image(43_690, 8, 16, 2))).toEqual({
      width: 43_690,
      height: 8,
    });
    expect(run("image/png", image(43_691, 8, 16, 2))).toEqual({
      refused: "bounds",
    });
    // 8-bit RGBA keeps the whole edge.
    expect(run("image/png", image(65_500, 1_831, 8))).toEqual({
      width: 65_500,
      height: 1_831,
    });
  });

  it("bounds an interlaced (Adam7) image's decoded pixels, which the decoder holds whole", () => {
    expect(CATALOG_ORIGINAL_MAX_INTERLACED_DECODED_BYTES).toBe(256 * 1024 ** 2);
    const image = (width: number, height: number, depth = 8, interlace = 1) =>
      pngOf(
        ihdr(width, height, depth, 6, interlace),
        chunk("IDAT", [1]),
        chunk("IEND"),
      );
    // RGBA: 65,500 x 1,024 is 255.9 MiB, and one more row is over.
    expect(run("image/png", image(65_500, 1_024))).toEqual({
      width: 65_500,
      height: 1_024,
    });
    expect(run("image/png", image(65_500, 1_025))).toEqual({
      refused: "bounds",
    });
    expect(run("image/png", image(65_500, 1_025, 8, 0))).toEqual({
      width: 65_500,
      height: 1_025,
    });
    // 16-bit RGBA at the row bound: 32,768 x 1,024 is exactly 256 MiB.
    expect(run("image/png", image(32_768, 1_024, 16))).toEqual({
      width: 32_768,
      height: 1_024,
    });
    expect(run("image/png", image(32_768, 1_025, 16))).toEqual({
      refused: "bounds",
    });
    expect(run("image/png", image(32_768, 2_048, 16, 0))).toEqual({
      width: 32_768,
      height: 2_048,
    });
    // Encoder output: sharp's Adam7 PNG (RGB, 9,216 B decoded).
    expect(interlaced[28]).toBe(1);
    expect(run("image/png", interlaced)).toEqual({ width: 64, height: 48 });
    expect(
      run("image/png", interlaced, undefined, { maxInterlacedBytes: 9_215 }),
    ).toEqual({ refused: "bounds" });
    expect(
      run("image/png", png, undefined, { maxInterlacedBytes: 9_215 }),
    ).toEqual({ width: 64, height: 48 });
  });

  it("counts the alpha channel tRNS adds to grey or RGB, as libvips decodes them", () => {
    const image = (
      width: number,
      height: number,
      depth: number,
      colour: number,
      interlace: number,
      ...before: Uint8Array[]
    ) =>
      pngOf(
        ihdr(width, height, depth, colour, interlace),
        ...before,
        chunk("IDAT", [1]),
        chunk("IEND"),
      );
    const trns = (colour: number) =>
      chunk(
        "tRNS",
        colour === 0 ? [0, 0] : colour === 2 ? [0, 0, 0, 0, 0, 0] : [0],
      );
    const fits = (width: number, height: number) => ({ width, height });
    const bounds = { refused: "bounds" };
    // Adam7 16-bit grey: 229 MiB counted alone, 458 MiB as grey and alpha
    // (the decoded size and row of the over-budget png-adam7-rgba-65500).
    expect(run("image/png", image(65_500, 1_832, 16, 0, 1))).toEqual(
      fits(65_500, 1_832),
    );
    expect(run("image/png", image(65_500, 1_832, 16, 0, 1, trns(0)))).toEqual(
      bounds,
    );
    // Adam7 8-bit RGB at the interlaced bound: 341 MiB as RGBA.
    expect(run("image/png", image(65_500, 1_366, 8, 2, 1))).toEqual(
      fits(65_500, 1_366),
    );
    expect(run("image/png", image(65_500, 1_366, 8, 2, 1, trns(2)))).toEqual(
      bounds,
    );
    // The row: 16-bit RGB 43,690 px wide is 262,140 B, 349,520 B as RGBA;
    // 32,768 px is the widest 16-bit RGB with tRNS.
    expect(run("image/png", image(43_690, 8, 16, 2, 0))).toEqual(
      fits(43_690, 8),
    );
    expect(run("image/png", image(43_690, 8, 16, 2, 0, trns(2)))).toEqual(
      bounds,
    );
    expect(run("image/png", image(32_768, 8, 16, 2, 0, trns(2)))).toEqual(
      fits(32_768, 8),
    );
    // The decoded size: 16-bit RGB at 84 MP is 504 MB, 672 MB as RGBA.
    expect(run("image/png", image(12_000, 7_000, 16, 2, 0))).toEqual(
      fits(12_000, 7_000),
    );
    expect(run("image/png", image(12_000, 7_000, 16, 2, 0, trns(2)))).toEqual(
      bounds,
    );
    // A palette already counts 4 channels, and an image with alpha gains
    // none; a tRNS after the first IDAT is past the decoder's header read.
    expect(run("image/png", image(65_500, 1_024, 8, 3, 1, trns(3)))).toEqual(
      fits(65_500, 1_024),
    );
    expect(run("image/png", image(65_500, 1_024, 8, 6, 1, trns(6)))).toEqual(
      fits(65_500, 1_024),
    );
    expect(
      run(
        "image/png",
        pngOf(
          ihdr(65_500, 1_832, 16, 0, 1),
          chunk("IDAT", [1]),
          trns(0),
          chunk("IDAT", [2]),
          chunk("IEND"),
        ),
      ),
    ).toEqual(fits(65_500, 1_832));
    // The header facts carry the decoded channels.
    const probe = new ImageStructureProbe("image/png");
    probe.update(image(64, 48, 8, 2, 0, trns(2)));
    expect(probe.finish()).toMatchObject({ channels: 4 });
  });
});

describe("WebP", () => {
  it("reads VP8, VP8L and VP8X encoder output", () => {
    expect(webpLossy.subarray(12, 16).toString("latin1")).toBe("VP8 ");
    expect(webpLossless.subarray(12, 16).toString("latin1")).toBe("VP8L");
    expect(webpAlpha.subarray(12, 16).toString("latin1")).toBe("VP8X");
    for (const bytes of [webpLossy, webpLossless, webpAlpha])
      expect(run("image/webp", bytes)).toEqual({ width: 64, height: 48 });
  });

  it("refuses the ANIM flag and animation chunks", () => {
    expect(
      run(
        "image/webp",
        webpOf(
          vp8x(8, 8, 0x02),
          riffChunk("ANIM", [0, 0, 0, 0, 0, 0]),
          vp8(8, 8),
        ),
      ),
    ).toEqual({ refused: "animated" });
    expect(
      run(
        "image/webp",
        webpOf(vp8x(8, 8), riffChunk("ANMF", [1, 2]), vp8(8, 8)),
      ),
    ).toEqual({ refused: "animated" });
  });

  it("requires the RIFF size to equal the file size minus 8 and consistent chunks", () => {
    const sized = (bytes: Uint8Array, delta: number) => {
      const copy = Uint8Array.from(bytes);
      new DataView(copy.buffer).setUint32(4, copy.length - 8 + delta, true);
      return copy;
    };
    // A RIFF size past the end leaves its chunks short (simple format) or
    // waits for bytes that never come; one short of it leaves bytes over.
    expect(run("image/webp", sized(webpLossy, 2))).toEqual({
      refused: "invalid",
    });
    expect(run("image/webp", sized(webpAlpha, 16))).toEqual({
      refused: "incomplete",
    });
    expect(run("image/webp", sized(webpLossy, -2))).toEqual({
      refused: "invalid",
    });
    expect(
      run("image/webp", webpLossy.subarray(0, webpLossy.length - 2)),
    ).toEqual({ refused: "incomplete" });
    expect(run("image/webp", webpOf(vp8x(8, 8), vp8(9, 8)))).toEqual({
      refused: "invalid",
    });
    expect(run("image/webp", webpOf(vp8x(8, 8), vp8(8, 8), vp8(8, 8)))).toEqual(
      {
        refused: "invalid",
      },
    );
    expect(run("image/webp", webpOf(vp8x(8, 8)))).toEqual({
      refused: "incomplete",
    });
    expect(
      run("image/webp", webpOf(vp8(8, 8), riffChunk("EXIF", [1]))),
    ).toEqual({
      refused: "invalid",
    });
  });

  it("bounds a side at 16,383", () => {
    expect(run("image/webp", webpOf(vp8x(16_383, 8), vp8(16_383, 8)))).toEqual({
      width: 16_383,
      height: 8,
    });
    expect(
      run("image/webp", webpOf(vp8x(16_384, 8), vp8(16_384 & 0x3fff, 8))),
    ).toEqual({ refused: "bounds" });
  });
});

describe("any format", () => {
  it("refuses garbage and a format other than the declared one", async () => {
    const garbage = Uint8Array.from(
      { length: 4096 },
      (_, index) => (index * 37) % 251,
    );
    for (const mimeType of ["image/jpeg", "image/png", "image/webp"] as const)
      expect(run(mimeType, garbage)).toEqual({ refused: "format" });
    expect(run("image/jpeg", png)).toEqual({ refused: "format" });
    expect(run("image/png", webpLossy)).toEqual({ refused: "format" });
    expect(run("image/webp", jpeg)).toEqual({ refused: "format" });
    expect(run("image/png", new Uint8Array())).toEqual({
      refused: "incomplete",
    });
  });

  it("refuses a declared width or height that differs from the stored one", () => {
    for (const [mimeType, bytes] of [
      ["image/jpeg", () => jpeg],
      ["image/png", () => png],
      ["image/webp", () => webpLossless],
    ] as const) {
      expect(
        run(mimeType, bytes(), undefined, {
          declaredWidth: 64,
          declaredHeight: 48,
        }),
      ).toEqual({ width: 64, height: 48 });
      expect(run(mimeType, bytes(), undefined, { declaredWidth: 65 })).toEqual({
        refused: "declared",
      });
      expect(run(mimeType, bytes(), undefined, { declaredHeight: 47 })).toEqual(
        {
          refused: "declared",
        },
      );
    }
  });

  it("pins the default bounds to the Catalog original limits", () => {
    expect(CATALOG_ORIGINAL_MAX_PIXELS).toBe(120_000_000);
    expect(CATALOG_ORIGINAL_MAX_DECODED_BYTES).toBe(512 * 1024 * 1024);
    expect(CATALOG_ORIGINAL_MAX_EDGE).toBe(65_500);
    expect(CATALOG_ORIGINAL_MAX_ROW_BYTES).toBe(256 * 1024);
  });

  it("gives the same result for chunk boundaries split anywhere (fuzz)", () => {
    const fixtures: [ImageMimeType, Uint8Array][] = [
      ["image/jpeg", jpeg],
      ["image/jpeg", progressive],
      ["image/jpeg", jpeg.subarray(0, jpeg.length - 2)],
      ["image/jpeg", jpegOf(frame(0xc1, 10_000, 10_000, 3, 12))],
      ["image/jpeg", scansOf(frame(0xc0, 64, 48), [[1], [2], [3]])],
      ["image/jpeg", scansOf(frame(0xc0, 10_000, 6_712, 4), [[1], [2]])],
      ["image/png", png],
      ["image/png", png.subarray(0, png.length - 12)],
      [
        "image/png",
        pngOf(
          ihdr(65_500, 1_832, 16, 0, 1),
          chunk("tRNS", [0, 0]),
          chunk("IDAT", [1]),
          chunk("IEND"),
        ),
      ],
      [
        "image/png",
        pngOf(
          ihdr(8, 8),
          chunk("acTL", [0, 0, 0, 1, 0, 0, 0, 0]),
          chunk("IEND"),
        ),
      ],
      ["image/webp", webpLossy],
      ["image/webp", webpLossless],
      ["image/webp", webpAlpha],
      ["image/webp", webpOf(vp8x(8, 8, 0x02), vp8(8, 8))],
    ];
    for (const [index, [mimeType, bytes]] of fixtures.entries()) {
      const whole = run(mimeType, bytes);
      expect(run(mimeType, bytes, new Array(bytes.length).fill(1))).toEqual(
        whole,
      );
      for (let seed = 1; seed <= 25; seed++)
        expect(
          run(mimeType, bytes, splits(bytes.length, seed * 97 + index)),
        ).toEqual(whole);
    }
  });

  it("stops at the first refused chunk and stays refused", () => {
    const probe = new ImageStructureProbe("image/png");
    expect(() => probe.update(Uint8Array.from(webpLossy))).toThrow(
      ImageProbeError,
    );
    expect(() => probe.update(png)).toThrow(ImageProbeError);
    expect(() => probe.finish()).toThrow(ImageProbeError);
    expect(probe.header).toBeNull();
  });
});

describe("header facts and the MD5/ETag-only tail check", () => {
  it("knows the stored size once the header is complete and checks the tail", () => {
    for (const [mimeType, bytes] of [
      ["image/jpeg", () => jpeg],
      ["image/png", () => png],
      ["image/webp", () => webpLossy],
    ] as const) {
      const all = bytes();
      const probe = new ImageStructureProbe(mimeType);
      const prefix = all.subarray(0, Math.min(all.length - 20, 1024));
      probe.update(prefix);
      expect(probe.header).toMatchObject({ width: 64, height: 48 });
      const tail = all.subarray(all.length - 16);
      expect(imageTailComplete(mimeType, tail, all.length, probe)).toBe(true);
      expect(
        imageTailComplete(
          mimeType,
          all.subarray(all.length - 17, all.length - 1),
          all.length - 1,
          probe,
        ),
      ).toBe(false);
    }
  });

  it("has no header facts before the header is complete", () => {
    const probe = new ImageStructureProbe("image/jpeg");
    probe.update(jpeg.subarray(0, 4));
    expect(probe.header).toBeNull();
    expect(
      imageTailComplete("image/jpeg", jpeg.subarray(-2), jpeg.length, probe),
    ).toBe(false);
  });
});

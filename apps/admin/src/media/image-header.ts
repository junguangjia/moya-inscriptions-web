import {
  CATALOG_ORIGINAL_MAX_DECODED_BYTES,
  CATALOG_ORIGINAL_MAX_EDGE,
  CATALOG_ORIGINAL_MAX_INTERLACED_DECODED_BYTES,
  CATALOG_ORIGINAL_MAX_JPEG_COEFFICIENT_BYTES,
  CATALOG_ORIGINAL_MAX_JPEG_SCANS,
  CATALOG_ORIGINAL_MAX_LOSSLESS_WEBP_BYTES,
  CATALOG_ORIGINAL_MAX_PIXELS,
  CATALOG_ORIGINAL_MAX_ROW_BYTES,
} from "@moya/contracts/internal/editorial";

/*
 * Incremental header and structural-completeness probe for Catalog originals
 * ingested straight into private storage (catalog-scale-v1 increment 2). The
 * stored bytes stream through it once, in any chunking, while they are
 * hashed. It keeps O(1) state, skips JPEG segments and PNG/WebP chunks by
 * their declared lengths (so a JPEG frame after megabytes of APPn, ICC or XMP
 * is found without a fixed window), never decodes a pixel and refuses with a
 * content-free code.
 *
 * The native upload's full decode refuses truncated files. This cheap pass
 * stands in for it: an ingested original that can never render could also
 * never be deleted (media delete is disabled), so a JPEG must reach SOS and
 * end with FFD9, a PNG must hold IDAT and end with a zero-length IEND, and a
 * WebP's RIFF size must equal the file size minus 8 with consistent chunks.
 * A file that passes and still fails to decode is refused by the worker's
 * sandbox, and the readiness gate keeps its record unpublished.
 */

export type ImageMimeType = "image/jpeg" | "image/png" | "image/webp";

export type ImageProbeRefusal =
  /** The bytes are not the declared format, or an unsupported variant of it. */
  | "format"
  /** More than one frame (PNG acTL/fcTL/fdAT, WebP ANIM flag or chunks). */
  | "animated"
  /**
   * A side, the pixels, the decoded size, a decoded row, a whole-image
   * decoder buffer or the JPEG scans over the bound.
   */
  | "bounds"
  /** A declared width or height that differs from the stored one. */
  | "declared"
  /** The structure ends before it is complete (truncated). */
  | "incomplete"
  /** Malformed structure. */
  | "invalid";

export class ImageProbeError extends Error {
  constructor(readonly code: ImageProbeRefusal) {
    super(`Image probe refused: ${code}`);
    this.name = "ImageProbeError";
  }
}

export type ImageProbeFacts = Readonly<{
  width: number;
  height: number;
  /**
   * Decoded channels: a palette PNG counts 4 (the widest expansion), and a
   * grey or RGB PNG with tRNS one more for its alpha.
   */
  channels: number;
  bytesPerSample: number;
}>;

export type ImageProbeOptions = {
  maxPixels?: number;
  maxDecodedBytes?: number;
  maxEdge?: number;
  /** Stored width × channels × bytes per sample. */
  maxRowBytes?: number;
  /**
   * The coefficient buffer of a JPEG with more than one scan (progressive,
   * or sequential with a first scan of fewer components than the frame),
   * held whole by the decoder.
   */
  maxCoefficientBytes?: number;
  /** An interlaced PNG's decoded pixels (tRNS alpha included), held whole. */
  maxInterlacedBytes?: number;
  /**
   * A lossless WebP's ARGB buffer (VP8L, or a VP8L-compressed alpha),
   * width × height × 4 B, held whole.
   */
  maxLosslessWebpBytes?: number;
  /** The scans of one JPEG, every one of which the decoder reads in full. */
  maxJpegScans?: number;
  declaredWidth?: number | undefined;
  declaredHeight?: number | undefined;
};

/** WebP's own bound: 14-bit lossy dimensions. */
const WEBP_MAX_EDGE = 16_383;
/** The largest header the parsers read whole (a JPEG SOF: 6 + 3 × 255). */
const MAX_READ = 1_024;

type Need = { read: number } | { skip: number } | { entropy: true };
type Parser = Generator<Need, void, unknown>;

function refuse(code: ImageProbeRefusal): never {
  throw new ImageProbeError(code);
}
const read = (length: number): Need => ({ read: length });
const skip = (length: number): Need => ({ skip: length });
const u16be = (bytes: Uint8Array, at: number) =>
  (bytes[at]! << 8) | bytes[at + 1]!;
const u16le = (bytes: Uint8Array, at: number) =>
  bytes[at]! | (bytes[at + 1]! << 8);
const u24le = (bytes: Uint8Array, at: number) =>
  bytes[at]! | (bytes[at + 1]! << 8) | (bytes[at + 2]! << 16);
const u32be = (bytes: Uint8Array, at: number) =>
  bytes[at]! * 0x1000000 + ((bytes[at + 1]! << 16) | u16be(bytes, at + 2));
const u32le = (bytes: Uint8Array, at: number) =>
  u24le(bytes, at) + bytes[at + 3]! * 0x1000000;
const ascii = (bytes: Uint8Array, at: number, length: number) =>
  String.fromCharCode(...bytes.subarray(at, at + length));

type ParserState = {
  /** Validates the bounds once the stored size is known. */
  size(
    width: number,
    height: number,
    channels: number,
    bytesPerSample: number,
  ): ImageProbeFacts;
  /** Bounds a decoder buffer that holds the whole image. */
  buffered(
    kind: "coefficients" | "interlaced" | "lossless",
    bytes: number,
  ): void;
  /** Bounds the count of JPEG scans. */
  scans(count: number): void;
  /** Marks the header complete: the first scan, IDAT or image chunk. */
  header(facts: ImageProbeFacts): void;
  /** WebP: the exact byte length the RIFF header declares. */
  expect(total: number): void;
};

// DCT frames libjpeg decodes; lossless and hierarchical frames are refused.
const JPEG_SOF = new Set([
  0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf,
]);
const JPEG_SUPPORTED_SOF = new Set([0xc0, 0xc1, 0xc2, 0xc9, 0xca]);
const JPEG_PROGRESSIVE_SOF = new Set([0xc2, 0xca]);

/**
 * The coefficient buffer of a JPEG with more than one scan, as libjpeg
 * allocates it (jdcoefct.c, a whole-image virtual array per component): its
 * 8 × 8 blocks rounded up to whole sampling units, 64 two-byte coefficients
 * each.
 */
const coefficientBytes = (
  width: number,
  height: number,
  factors: readonly (readonly [number, number])[],
) => {
  const hMax = Math.max(...factors.map(([h]) => h));
  const vMax = Math.max(...factors.map(([, v]) => v));
  const roundUp = (value: number, unit: number) =>
    Math.ceil(value / unit) * unit;
  let blocks = 0;
  for (const [h, v] of factors)
    blocks +=
      roundUp(Math.ceil((width * h) / (8 * hMax)), h) *
      roundUp(Math.ceil((height * v) / (8 * vMax)), v);
  return blocks * 128;
};

function* jpeg(state: ParserState): Parser {
  const soi = (yield read(2)) as Uint8Array;
  if (soi[0] !== 0xff || soi[1] !== 0xd8) refuse("format");
  let frame: ImageProbeFacts | null = null;
  // The frame's coefficient buffer and whether it is already bounded.
  let coefficients = 0;
  let bounded = false;
  let scans = 0;
  // A marker the entropy scan already consumed.
  let pending: number | null = null;
  for (;;) {
    let code: number;
    if (pending === null) {
      if (((yield read(1)) as Uint8Array)[0] !== 0xff) refuse("invalid");
      // Any marker may be preceded by fill bytes.
      do code = ((yield read(1)) as Uint8Array)[0]!;
      while (code === 0xff);
    } else {
      code = pending;
      pending = null;
    }
    if (code === 0xd9) {
      if (!frame || scans === 0) refuse("incomplete");
      return;
    }
    if (code === 0x01) continue;
    // A second SOI, a stuffed zero or a restart outside a scan.
    if (code === 0xd8 || code === 0x00 || (code >= 0xd0 && code <= 0xd7))
      refuse("invalid");
    const length = u16be((yield read(2)) as Uint8Array, 0);
    if (length < 2) refuse("invalid");
    if (JPEG_SOF.has(code)) {
      if (!JPEG_SUPPORTED_SOF.has(code)) refuse("format");
      if (frame || length < 8 || length - 2 > MAX_READ) refuse("invalid");
      const segment = (yield read(length - 2)) as Uint8Array;
      const precision = segment[0]!;
      const components = segment[5]!;
      if (
        length !== 8 + 3 * components ||
        components < 1 ||
        components > 4 ||
        (precision !== 8 && precision !== 12)
      )
        refuse("invalid");
      // The sandbox's decoder (mozjpeg in sharp's libvips) reads 8-bit
      // samples only; a 12-bit original could never render.
      if (precision !== 8) refuse("format");
      const factors: (readonly [number, number])[] = [];
      for (let index = 0; index < components; index++) {
        const sampling = segment[7 + 3 * index]!;
        const factor = [sampling >> 4, sampling & 0x0f] as const;
        if (factor.some((value) => value < 1 || value > 4)) refuse("invalid");
        factors.push(factor);
      }
      // Height 0 defers it to a DNL marker, which is not supported here.
      const width = u16be(segment, 3);
      const height = u16be(segment, 1);
      frame = state.size(width, height, components, 1);
      coefficients = coefficientBytes(width, height, factors);
      // A progressive frame's coefficients are held whole until its last
      // scan.
      if (JPEG_PROGRESSIVE_SOF.has(code)) {
        state.buffered("coefficients", coefficients);
        bounded = true;
      }
      continue;
    }
    if (code === 0xda) {
      if (!frame) refuse("invalid");
      state.scans(++scans);
      if (scans > 1) yield skip(length - 2);
      else {
        // The first scan's header: Ns, a selector and table pair per
        // component, then Ss, Se and Ah/Al. It precedes the entropy data, so
        // the MD5/ETag mode's header prefix holds it.
        if (length < 8 || length - 2 > MAX_READ) refuse("invalid");
        const scan = (yield read(length - 2)) as Uint8Array;
        const inScan = scan[0]!;
        if (inScan < 1 || inScan > frame.channels || length !== 6 + 2 * inScan)
          refuse("invalid");
        // libjpeg (jdinput.c initial_setup) keeps every coefficient when the
        // first scan holds fewer components than the frame, exactly as for a
        // progressive one: a sequential file written one scan per component
        // is not decoded a band at a time. One scan of every component is.
        if (!bounded && inScan < frame.channels)
          state.buffered("coefficients", coefficients);
        state.header(frame);
      }
      pending = (yield { entropy: true }) as number;
      continue;
    }
    // APPn, COM, DQT, DHT, DRI and the rest: skipped by length, so an EXIF
    // thumbnail's own SOI and SOF are never mistaken for the main frame.
    yield skip(length - 2);
  }
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const PNG_DEPTHS: Record<number, readonly number[]> = {
  0: [1, 2, 4, 8, 16],
  2: [8, 16],
  3: [1, 2, 4, 8],
  4: [8, 16],
  6: [8, 16],
};
// Decoded channels per colour type; a palette expands to RGB or RGBA.
const PNG_CHANNELS: Record<number, number> = { 0: 1, 2: 3, 3: 4, 4: 2, 6: 4 };

function* png(state: ParserState): Parser {
  const signature = (yield read(8)) as Uint8Array;
  if (PNG_SIGNATURE.some((byte, index) => signature[index] !== byte))
    refuse("format");
  let facts: ImageProbeFacts | null = null;
  let interlaced = false;
  let alphaAdded = false;
  let data = false;
  // Adam7: the decoder holds every pixel before the first full row.
  const whole = (bounded: ImageProbeFacts) => {
    if (interlaced)
      state.buffered(
        "interlaced",
        bounded.width *
          bounded.height *
          bounded.channels *
          bounded.bytesPerSample,
      );
  };
  for (;;) {
    const head = (yield read(8)) as Uint8Array;
    const length = u32be(head, 0);
    const type = ascii(head, 4, 4);
    if (length > 0x7fffffff || !/^[A-Za-z]{4}$/.test(type)) refuse("invalid");
    if (!facts) {
      if (type !== "IHDR" || length !== 13) refuse("invalid");
      const ihdr = (yield read(13)) as Uint8Array;
      const depth = ihdr[8]!;
      const colour = ihdr[9]!;
      if (
        !PNG_DEPTHS[colour]?.includes(depth) ||
        ihdr[10] !== 0 ||
        ihdr[11] !== 0 ||
        ihdr[12]! > 1
      )
        refuse("invalid");
      facts = state.size(
        u32be(ihdr, 0),
        u32be(ihdr, 4),
        PNG_CHANNELS[colour]!,
        depth === 16 ? 2 : 1,
      );
      interlaced = ihdr[12] === 1;
      // A grey or RGB image may still gain an alpha channel from tRNS.
      alphaAdded = colour !== 0 && colour !== 2;
      whole(facts);
      yield skip(4);
      continue;
    }
    if (type === "IHDR") refuse("invalid");
    if (type === "acTL" || type === "fcTL" || type === "fdAT")
      refuse("animated");
    if (type === "IEND") {
      if (length !== 0) refuse("invalid");
      if (!data) refuse("incomplete");
      yield skip(4);
      return;
    }
    // tRNS precedes the first IDAT, where the decoder's header read stops:
    // libvips (libpng's png_set_tRNS_to_alpha) then decodes grey as grey
    // and alpha, RGB as RGBA, so every bound counts one more channel. A
    // palette already counts 4; an image with alpha has no tRNS to honour.
    if (type === "tRNS" && !data && !alphaAdded) {
      alphaAdded = true;
      facts = state.size(
        facts.width,
        facts.height,
        facts.channels + 1,
        facts.bytesPerSample,
      );
      whole(facts);
    }
    if (type === "IDAT" && !data) {
      data = true;
      state.header(facts);
    }
    yield skip(length + 4);
  }
}

function* webp(state: ParserState): Parser {
  const header = (yield read(12)) as Uint8Array;
  if (ascii(header, 0, 4) !== "RIFF" || ascii(header, 8, 4) !== "WEBP")
    refuse("format");
  const riffSize = u32le(header, 4);
  if (riffSize % 2 !== 0 || riffSize < 4 + 8) refuse("invalid");
  state.expect(riffSize + 8);
  let remaining = riffSize - 4;
  function* chunk(): Generator<
    Need,
    { fourcc: string; size: number; padded: number },
    unknown
  > {
    if (remaining < 8) refuse("invalid");
    const head = (yield read(8)) as Uint8Array;
    const size = u32le(head, 4);
    const padded = size + (size % 2);
    if (padded > remaining - 8) refuse("invalid");
    remaining -= 8 + padded;
    return { fourcc: ascii(head, 0, 4), size, padded };
  }
  function* image(
    found: { fourcc: string; size: number; padded: number },
    canvas: ImageProbeFacts | null,
  ): Parser {
    let width: number;
    let height: number;
    let alpha: boolean;
    let consumed: number;
    if (found.fourcc === "VP8 ") {
      if (found.size < 10) refuse("invalid");
      const frame = (yield read(10)) as Uint8Array;
      // A key frame with the VP8 start code.
      if (
        (frame[0]! & 1) !== 0 ||
        frame[3] !== 0x9d ||
        frame[4] !== 0x01 ||
        frame[5] !== 0x2a
      )
        refuse("invalid");
      width = u16le(frame, 6) & 0x3fff;
      height = u16le(frame, 8) & 0x3fff;
      alpha = canvas ? canvas.channels === 4 : false;
      consumed = 10;
    } else {
      if (found.size < 5) refuse("invalid");
      const frame = (yield read(5)) as Uint8Array;
      if (frame[0] !== 0x2f) refuse("invalid");
      const bits = u32le(frame, 1);
      width = (bits & 0x3fff) + 1;
      height = (Math.floor(bits / 0x4000) & 0x3fff) + 1;
      alpha = (Math.floor(bits / 0x10000000) & 1) === 1;
      if (Math.floor(bits / 0x20000000) !== 0) refuse("invalid");
      consumed = 5;
    }
    let facts: ImageProbeFacts;
    if (canvas) {
      if (width !== canvas.width || height !== canvas.height) refuse("invalid");
      facts = canvas;
    } else facts = state.size(width, height, alpha ? 4 : 3, 1);
    // libwebp's lossless decoder holds the whole image as 32-bit ARGB,
    // whatever the output size and whether or not alpha is used.
    if (found.fourcc === "VP8L")
      state.buffered("lossless", facts.width * facts.height * 4);
    state.header(facts);
    yield skip(found.padded - consumed);
  }
  const first = yield* chunk();
  if (first.fourcc === "VP8 " || first.fourcc === "VP8L") {
    yield* image(first, null);
    // The simple formats hold exactly one image chunk.
    if (remaining !== 0) refuse("invalid");
    return;
  }
  if (first.fourcc !== "VP8X" || first.size !== 10) refuse("invalid");
  const extended = (yield read(10)) as Uint8Array;
  const flags = extended[0]!;
  if ((flags & 0x02) !== 0) refuse("animated");
  const canvas = state.size(
    u24le(extended, 4) + 1,
    u24le(extended, 7) + 1,
    (flags & 0x10) !== 0 ? 4 : 3,
    1,
  );
  let found = false;
  while (remaining > 0) {
    const next = yield* chunk();
    if (next.fourcc === "ANIM" || next.fourcc === "ANMF") refuse("animated");
    if (next.fourcc === "VP8 " || next.fourcc === "VP8L") {
      if (found) refuse("invalid");
      found = true;
      yield* image(next, canvas);
      continue;
    }
    // A lossy image's alpha plane. Compression method 1 is a VP8L stream,
    // whose decoder can hold the whole plane as 32-bit ARGB too.
    if (next.fourcc === "ALPH" && next.size > 0) {
      const method = ((yield read(1)) as Uint8Array)[0]! & 0x03;
      if (method === 1)
        state.buffered("lossless", canvas.width * canvas.height * 4);
      yield skip(next.padded - 1);
      continue;
    }
    yield skip(next.padded);
  }
  if (!found) refuse("incomplete");
}

/**
 * Feed every stored byte, in order and in any chunking, then call finish().
 * update() throws as soon as the bytes are refused, so a caller stops reading;
 * `header` holds the stored size once the header is complete.
 */
export class ImageStructureProbe {
  readonly #mimeType: ImageMimeType;
  readonly #parser: Parser;
  readonly #limits: Required<
    Pick<
      ImageProbeOptions,
      | "maxPixels"
      | "maxDecodedBytes"
      | "maxEdge"
      | "maxRowBytes"
      | "maxCoefficientBytes"
      | "maxInterlacedBytes"
      | "maxLosslessWebpBytes"
      | "maxJpegScans"
    >
  >;
  readonly #declared: { width?: number; height?: number };
  readonly #buffer = new Uint8Array(MAX_READ);
  #need: Need | null = null;
  #filled = 0;
  #remaining = 0;
  #afterFF = false;
  #done = false;
  #failure: ImageProbeError | null = null;
  #header: ImageProbeFacts | null = null;
  #expected: number | null = null;
  #total = 0;
  #last = -1;
  #beforeLast = -1;

  constructor(mimeType: ImageMimeType, options: ImageProbeOptions = {}) {
    this.#mimeType = mimeType;
    this.#limits = {
      maxPixels: options.maxPixels ?? CATALOG_ORIGINAL_MAX_PIXELS,
      maxDecodedBytes:
        options.maxDecodedBytes ?? CATALOG_ORIGINAL_MAX_DECODED_BYTES,
      maxEdge: Math.min(
        options.maxEdge ?? CATALOG_ORIGINAL_MAX_EDGE,
        mimeType === "image/webp" ? WEBP_MAX_EDGE : Number.MAX_SAFE_INTEGER,
      ),
      maxRowBytes: options.maxRowBytes ?? CATALOG_ORIGINAL_MAX_ROW_BYTES,
      maxCoefficientBytes:
        options.maxCoefficientBytes ??
        CATALOG_ORIGINAL_MAX_JPEG_COEFFICIENT_BYTES,
      maxInterlacedBytes:
        options.maxInterlacedBytes ??
        CATALOG_ORIGINAL_MAX_INTERLACED_DECODED_BYTES,
      maxLosslessWebpBytes:
        options.maxLosslessWebpBytes ??
        CATALOG_ORIGINAL_MAX_LOSSLESS_WEBP_BYTES,
      maxJpegScans: options.maxJpegScans ?? CATALOG_ORIGINAL_MAX_JPEG_SCANS,
    };
    this.#declared = {
      ...(options.declaredWidth === undefined
        ? {}
        : { width: options.declaredWidth }),
      ...(options.declaredHeight === undefined
        ? {}
        : { height: options.declaredHeight }),
    };
    const state: ParserState = {
      size: (width, height, channels, bytesPerSample) => {
        if (
          !Number.isSafeInteger(width) ||
          !Number.isSafeInteger(height) ||
          width < 1 ||
          height < 1
        )
          refuse("invalid");
        if (
          width > this.#limits.maxEdge ||
          height > this.#limits.maxEdge ||
          width * height > this.#limits.maxPixels ||
          width * height * channels * bytesPerSample >
            this.#limits.maxDecodedBytes ||
          width * channels * bytesPerSample > this.#limits.maxRowBytes
        )
          refuse("bounds");
        if (
          (this.#declared.width !== undefined &&
            this.#declared.width !== width) ||
          (this.#declared.height !== undefined &&
            this.#declared.height !== height)
        )
          refuse("declared");
        return Object.freeze({ width, height, channels, bytesPerSample });
      },
      buffered: (kind, bytes) => {
        if (
          bytes >
          (kind === "coefficients"
            ? this.#limits.maxCoefficientBytes
            : kind === "interlaced"
              ? this.#limits.maxInterlacedBytes
              : this.#limits.maxLosslessWebpBytes)
        )
          refuse("bounds");
      },
      scans: (count) => {
        if (count > this.#limits.maxJpegScans) refuse("bounds");
      },
      header: (facts) => {
        this.#header ??= facts;
      },
      expect: (total) => {
        this.#expected = total;
      },
    };
    this.#parser =
      mimeType === "image/jpeg"
        ? jpeg(state)
        : mimeType === "image/png"
          ? png(state)
          : webp(state);
    this.#advance(undefined);
  }

  /** The stored size once the header is complete; structure may still fail. */
  get header(): ImageProbeFacts | null {
    return this.#failure ? null : this.#header;
  }

  /** WebP only: the byte length its RIFF header declares. */
  get declaredLength(): number | null {
    return this.#expected;
  }

  update(chunk: Uint8Array): void {
    if (this.#failure) throw this.#failure;
    try {
      this.#consume(chunk);
    } catch (error) {
      this.#failure =
        error instanceof ImageProbeError
          ? error
          : new ImageProbeError("invalid");
      throw this.#failure;
    }
  }

  /** The verified size of a complete structure, or the refusal. */
  finish(): ImageProbeFacts {
    if (this.#failure) throw this.#failure;
    if (!this.#done || !this.#header) refuse("incomplete");
    if (
      this.#mimeType === "image/jpeg" &&
      (this.#beforeLast !== 0xff || this.#last !== 0xd9)
    )
      refuse("incomplete");
    if (this.#expected !== null && this.#total !== this.#expected)
      refuse("incomplete");
    return this.#header!;
  }

  #advance(value: unknown): void {
    for (;;) {
      const next = this.#parser.next(value);
      if (next.done) {
        this.#done = true;
        this.#need = null;
        return;
      }
      const need = next.value;
      this.#need = need;
      if ("read" in need) {
        if (need.read < 1 || need.read > MAX_READ) refuse("invalid");
        this.#filled = 0;
        return;
      }
      if ("skip" in need) {
        if (!Number.isSafeInteger(need.skip) || need.skip < 0)
          refuse("invalid");
        this.#remaining = need.skip;
        if (need.skip > 0) return;
        value = undefined;
        continue;
      }
      this.#afterFF = false;
      return;
    }
  }

  #consume(chunk: Uint8Array): void {
    if (chunk.length >= 2) {
      this.#beforeLast = chunk[chunk.length - 2]!;
      this.#last = chunk[chunk.length - 1]!;
    } else if (chunk.length === 1) {
      this.#beforeLast = this.#last;
      this.#last = chunk[0]!;
    }
    this.#total += chunk.length;
    if (this.#expected !== null && this.#total > this.#expected)
      refuse("invalid");
    let position = 0;
    while (position < chunk.length) {
      const need = this.#need;
      if (this.#done || !need) {
        // A JPEG may carry bytes after its EOI as long as it ends with FFD9;
        // PNG and WebP end exactly where their structure ends.
        if (this.#mimeType !== "image/jpeg") refuse("invalid");
        return;
      }
      if ("read" in need) {
        const take = Math.min(
          need.read - this.#filled,
          chunk.length - position,
        );
        this.#buffer.set(
          chunk.subarray(position, position + take),
          this.#filled,
        );
        this.#filled += take;
        position += take;
        if (this.#filled === need.read)
          this.#advance(this.#buffer.slice(0, need.read));
        continue;
      }
      if ("skip" in need) {
        const take = Math.min(this.#remaining, chunk.length - position);
        this.#remaining -= take;
        position += take;
        if (this.#remaining === 0) this.#advance(undefined);
        continue;
      }
      // Entropy-coded data: FF 00 is a stuffed byte and FF D0-D7 a restart;
      // any other byte after FF (and its fill bytes) is the next marker.
      while (position < chunk.length) {
        if (this.#afterFF) {
          const byte = chunk[position++]!;
          if (byte === 0xff) continue;
          this.#afterFF = false;
          if (byte === 0x00 || (byte >= 0xd0 && byte <= 0xd7)) continue;
          this.#advance(byte);
          break;
        }
        const index = chunk.indexOf(0xff, position);
        if (index < 0) {
          position = chunk.length;
          break;
        }
        position = index + 1;
        this.#afterFF = true;
      }
    }
  }
}

const PNG_IEND = [
  0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
];

/**
 * The cheap tail check of the MD5/ETag-only mode, for a header probe fed
 * only a prefix: the last bytes close the structure (JPEG FFD9, PNG's final
 * zero-length IEND), and a WebP's RIFF size equals the stored length minus 8.
 */
export function imageTailComplete(
  mimeType: ImageMimeType,
  tail: Uint8Array,
  totalBytes: number,
  probe: ImageStructureProbe,
): boolean {
  if (!probe.header) return false;
  if (mimeType === "image/jpeg")
    return (
      tail.length >= 2 &&
      tail[tail.length - 2] === 0xff &&
      tail[tail.length - 1] === 0xd9
    );
  if (mimeType === "image/png")
    return (
      tail.length >= PNG_IEND.length &&
      PNG_IEND.every(
        (byte, index) => tail[tail.length - PNG_IEND.length + index] === byte,
      )
    );
  return probe.declaredLength === totalBytes;
}

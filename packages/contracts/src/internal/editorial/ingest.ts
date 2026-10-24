import { z } from "zod";
import { catalogIdSchema, mediaIdSchema } from "../../schemas.js";
import { editorialMediaSchema } from "./schemas.js";
import { editorialUploadedMediaSchema } from "./upload.js";

/**
 * Bounds of a Catalog original ingested straight into private storage
 * (catalog-scale-v1 increment 2): at or below the worker's source, pixel and
 * decoded-size bounds and the 65,535 px source edge of the processing
 * snapshot, so an ingested original is never one the worker refuses to read.
 * The native upload and the relay keep MAX_MEDIA_UPLOAD_BYTES.
 *
 * The Development render measurement (S5b,
 * docs/development/catalog-scale-bench.md) kept the byte, pixel and
 * decoded-size bounds, lowered the edge and added the row and buffer bounds:
 * the sandbox's JPEG decoder refuses a side over 65,500 px (and any 12-bit
 * sample, which the Admin's probe refuses too), a stored row over 256 KiB (a
 * 16-bit RGBA PNG wider than 32,768 px) took up to 1.4 GiB of the sandbox's
 * 1.5 GiB, and a decoder holding the whole image (the coefficients of a
 * JPEG with more than one scan, an interlaced PNG's pixels) took up to
 * 1.1 GiB at 120 MP. The PR review added the lossless WebP buffer bound (a
 * conservative one: a 120 MP lossless file peaked under 600 MiB) and the
 * JPEG scan count, which bounds a crafted file's time rather than its memory.
 */
export const CATALOG_ORIGINAL_MAX_BYTES = 128 * 1024 * 1024;
export const CATALOG_ORIGINAL_MAX_PIXELS = 120_000_000;
/**
 * width × height × decoded channels × bytes per sample, before any pixel
 * decode. A palette PNG counts 4 channels, and a grey or RGB PNG with tRNS
 * one more for the alpha the decoder adds.
 */
export const CATALOG_ORIGINAL_MAX_DECODED_BYTES = 512 * 1024 * 1024;
/** Each side: libjpeg-turbo's JPEG_MAX_DIMENSION, kept for every format. */
export const CATALOG_ORIGINAL_MAX_EDGE = 65_500;
/**
 * Stored width × decoded channels × bytes per sample: one decoded row, which
 * the renderer holds many times over while it shrinks a wide image.
 */
export const CATALOG_ORIGINAL_MAX_ROW_BYTES = 256 * 1024;
/**
 * The DCT coefficients of a JPEG with more than one scan, which the decoder
 * holds whole until its last scan: per component, its 8 × 8 blocks (rounded
 * up to whole sampling units) × 64 coefficients × 2 B. libjpeg keeps them for
 * a progressive frame and for a sequential one whose first scan holds fewer
 * components than the frame (written one scan per component, for example).
 * A sequential JPEG whose first scan holds every component (the usual
 * interleaved file) has no such buffer.
 */
export const CATALOG_ORIGINAL_MAX_JPEG_COEFFICIENT_BYTES = 512 * 1024 * 1024;
/**
 * An interlaced (Adam7) PNG's decoded pixels, which the decoder holds whole
 * before its first full row: width × height × decoded channels (tRNS alpha
 * included) × bytes per sample.
 */
export const CATALOG_ORIGINAL_MAX_INTERLACED_DECODED_BYTES = 256 * 1024 * 1024;
/**
 * A lossless (VP8L) WebP's ARGB buffer, which libwebp's decoder holds whole
 * whatever the output size: width × height × 4 B, with alpha or without. A
 * lossy WebP whose alpha is VP8L-compressed (ALPH, compression method 1)
 * counts the same, since its alpha decoder can hold the same buffer.
 */
export const CATALOG_ORIGINAL_MAX_LOSSLESS_WEBP_BYTES = 256 * 1024 * 1024;
/**
 * The scans of one JPEG. libjpeg reads every scan of a multi-scan file in
 * full whatever the output size, so a crafted file of thousands of tiny
 * scans passes every size bound and still never renders in time. Common
 * encoders write a few dozen at most (libjpeg's progressive script: 10 for
 * YCbCr, 18 for CMYK). Counted only when every byte is read: the MD5/ETag
 * mode's header prefix ends at the first scan.
 */
export const CATALOG_ORIGINAL_MAX_JPEG_SCANS = 150;
/** The only tag a staging PUT may carry (lifecycle L1); the copy strips it. */
export const CATALOG_INGEST_STAGING_TAGGING = "moya-ingest-staging=v1";

const digestSchema = z.string().regex(/^[a-f0-9]{64}$/);
/** Canonical base64 of a 16-byte MD5 digest, as Content-MD5 carries it. */
const md5Base64Schema = z.string().regex(/^[A-Za-z0-9+/]{21}[AQgw]==$/);
const edgeSchema = z.number().int().min(1).max(CATALOG_ORIGINAL_MAX_EDGE);
const bytesSchema = z.number().int().min(1).max(CATALOG_ORIGINAL_MAX_BYTES);
const mimeTypeSchema = editorialUploadedMediaSchema.shape.mimeType;

/**
 * Every read of a registered media doc: the relay's projection, with a
 * filesize up to CATALOG_ORIGINAL_MAX_BYTES so an ingested original over the
 * relay's 40 MiB still parses. No provider credentials, URLs or staging keys.
 */
export const editorialRegisteredMediaSchema =
  editorialUploadedMediaSchema.extend({ filesize: bytesSchema });
export type EditorialRegisteredMedia = z.infer<
  typeof editorialRegisteredMediaSchema
>;

/**
 * Immutable ingest intent: the body of start, and the `intent` of complete
 * and abandon. transferId distinguishes an explicit fresh run. The server
 * derives the ingest id and the staging key from the actor and this intent,
 * and at complete recomputes every fact from the stored bytes; the declared
 * width and height are only compared with what it reads.
 */
export const editorialMediaIngestStartSchema = z
  .strictObject({
    transferId: digestSchema,
    catalogId: catalogIdSchema,
    mediaId: mediaIdSchema,
    sha256: digestSchema,
    bytes: bytesSchema,
    mimeType: mimeTypeSchema,
    md5Base64: md5Base64Schema,
    width: edgeSchema.optional(),
    height: edgeSchema.optional(),
    alt: editorialMediaSchema.shape.alt,
    rights: editorialMediaSchema.shape.rights,
    orderConfidence: editorialMediaSchema.shape.orderConfidence,
  })
  .refine(
    ({ width, height }) =>
      width === undefined ||
      height === undefined ||
      width * height <= CATALOG_ORIGINAL_MAX_PIXELS,
    {
      path: ["width"],
      message: "A declared size must stay within the pixel bound.",
    },
  );
export type EditorialMediaIngestStart = z.infer<
  typeof editorialMediaIngestStartSchema
>;

/** The exact header set the staging PUT sends and its signature binds. */
const ingestUploadHeadersSchema = z.strictObject({
  "content-length": z
    .string()
    .regex(/^[1-9][0-9]*$/)
    .refine((value) => Number(value) <= CATALOG_ORIGINAL_MAX_BYTES),
  "content-type": mimeTypeSchema,
  "x-cos-forbid-overwrite": z.literal("true"),
  "content-md5": md5Base64Schema,
  "x-cos-tagging": z.literal(CATALOG_INGEST_STAGING_TAGGING).optional(),
});

/**
 * A media doc that already matches the intent is returned as registered;
 * otherwise one PUT to the staging key, valid until expiresAt.
 */
export const editorialMediaIngestStartResultSchema = z.discriminatedUnion(
  "state",
  [
    z.strictObject({
      state: z.literal("upload"),
      ingestId: digestSchema,
      upload: z.strictObject({
        method: z.literal("PUT"),
        url: z.url({ protocol: /^https?$/ }).max(8_192),
        headers: ingestUploadHeadersSchema,
        expiresAt: z.iso.datetime(),
      }),
    }),
    z.strictObject({
      state: z.literal("registered"),
      media: editorialRegisteredMediaSchema,
    }),
  ],
);
export type EditorialMediaIngestStartResult = z.infer<
  typeof editorialMediaIngestStartResultSchema
>;

/** The body of complete and abandon: the start intent, unchanged. */
export const editorialMediaIngestRequestSchema = z.strictObject({
  intent: editorialMediaIngestStartSchema,
});
export type EditorialMediaIngestRequest = z.infer<
  typeof editorialMediaIngestRequestSchema
>;

/**
 * The registered media and the facts the server derived. A reuse, which
 * reads no object, reports the doc's own registered facts and no MD5.
 */
export const editorialMediaIngestCompleteResultSchema = z
  .strictObject({
    media: editorialRegisteredMediaSchema,
    reused: z.boolean(),
    validatedBytes: bytesSchema,
    validatedSha256: digestSchema,
    validatedMd5: md5Base64Schema.nullable(),
    width: editorialMediaSchema.shape.width,
    height: editorialMediaSchema.shape.height,
  })
  .superRefine((value, context) => {
    if (
      value.validatedBytes !== value.media.filesize ||
      value.validatedSha256 !== value.media.sha256 ||
      value.width !== value.media.width ||
      value.height !== value.media.height
    )
      context.addIssue({
        code: "custom",
        path: ["media"],
        message: "The validated facts must be the registered media's.",
      });
    if (!value.reused && value.validatedMd5 === null)
      context.addIssue({
        code: "custom",
        path: ["validatedMd5"],
        message: "A new registration reports the MD5 it verified.",
      });
  });
export type EditorialMediaIngestCompleteResult = z.infer<
  typeof editorialMediaIngestCompleteResultSchema
>;

/**
 * Idempotent: the caller's derived staging key is gone. "abandoned": an
 * object was there and is removed; "absent": nothing was staged under the
 * caller's key (another actor's key, derived from that actor, is never
 * touched). ingestId is the caller's.
 */
export const editorialMediaIngestAbandonResultSchema = z.strictObject({
  ingestId: digestSchema,
  state: z.enum(["abandoned", "absent"]),
});
export type EditorialMediaIngestAbandonResult = z.infer<
  typeof editorialMediaIngestAbandonResultSchema
>;

export const editorialMediaIngestVerifyRequestSchema = z.strictObject({
  mediaId: mediaIdSchema,
});
export type EditorialMediaIngestVerifyRequest = z.infer<
  typeof editorialMediaIngestVerifyRequestSchema
>;

/**
 * A scoped re-hash of the registered object, in place of a client readback.
 * validatedBytes is what storage holds (0 when the object is missing) and
 * validatedSha256 is null when the bytes were not hashed; intact holds
 * exactly when both equal the registered facts.
 */
export const editorialMediaIngestVerifyResultSchema = z
  .strictObject({
    media: editorialRegisteredMediaSchema,
    intact: z.boolean(),
    validatedBytes: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
    validatedSha256: digestSchema.nullable(),
  })
  .refine(
    (value) =>
      value.intact ===
      (value.validatedBytes === value.media.filesize &&
        value.validatedSha256 === value.media.sha256),
    {
      path: ["intact"],
      message: "intact must state whether the stored bytes are registered.",
    },
  );
export type EditorialMediaIngestVerifyResult = z.infer<
  typeof editorialMediaIngestVerifyResultSchema
>;

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
 */
export const CATALOG_ORIGINAL_MAX_BYTES = 128 * 1024 * 1024;
export const CATALOG_ORIGINAL_MAX_PIXELS = 120_000_000;
/** width × height × channels × bytes per sample, before any pixel decode. */
export const CATALOG_ORIGINAL_MAX_DECODED_BYTES = 512 * 1024 * 1024;
export const CATALOG_ORIGINAL_MAX_EDGE = 65_535;
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
 * The registered media and the facts the server derived. A reuse without
 * storage I/O reports the doc's own registered facts and no MD5.
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

/** Idempotent: the caller's derived staging key is gone, whether or not it existed. */
export const editorialMediaIngestAbandonResultSchema = z.strictObject({
  ingestId: digestSchema,
  state: z.literal("abandoned"),
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

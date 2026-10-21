import { z } from "zod";
import { catalogIdSchema, mediaIdSchema } from "../../schemas.js";
import { editorialMediaSchema } from "./schemas.js";

export const MEDIA_UPLOAD_CHUNK_BYTES = 128 * 1024;
/** Additive response-header capability; legacy strict session JSON stays unchanged. */
export const MEDIA_UPLOAD_STREAM_VERSION = "1";
export const MAX_MEDIA_UPLOAD_BYTES = 40 * 1024 * 1024;
export const MAX_MEDIA_UPLOAD_CHUNKS = 320;
const digestSchema = z.string().regex(/^[a-f0-9]{64}$/);

/** Immutable intent. transferId distinguishes an explicit fresh verification run. */
export const editorialMediaUploadStartSchema = z.strictObject({
  transferId: digestSchema,
  existingOnly: z.boolean().default(false),
  catalogId: catalogIdSchema,
  mediaId: mediaIdSchema,
  sha256: digestSchema,
  bytes: z.number().int().min(1).max(MAX_MEDIA_UPLOAD_BYTES),
  mimeType: z.enum(["image/jpeg", "image/png", "image/webp"]),
  alt: editorialMediaSchema.shape.alt,
  rights: editorialMediaSchema.shape.rights,
  orderConfidence: editorialMediaSchema.shape.orderConfidence,
});
export type EditorialMediaUploadStart = z.infer<
  typeof editorialMediaUploadStartSchema
>;
export type EditorialMediaUploadStartInput = z.input<
  typeof editorialMediaUploadStartSchema
>;

export const editorialMediaUploadSessionRequestSchema = z.strictObject({
  uploadId: digestSchema,
});
export type EditorialMediaUploadSessionRequest = z.infer<
  typeof editorialMediaUploadSessionRequestSchema
>;

export const editorialMediaUploadSessionSchema = z
  .strictObject({
    uploadId: digestSchema,
    state: z.enum(["uploading", "ready", "complete"]),
    chunkBytes: z.literal(MEDIA_UPLOAD_CHUNK_BYTES),
    chunkCount: z.number().int().min(1).max(MAX_MEDIA_UPLOAD_CHUNKS),
    receivedIndices: z
      .array(
        z
          .number()
          .int()
          .min(0)
          .max(MAX_MEDIA_UPLOAD_CHUNKS - 1),
      )
      .max(MAX_MEDIA_UPLOAD_CHUNKS),
    expiresAt: z.string().datetime(),
  })
  .superRefine((value, context) => {
    if (
      new Set(value.receivedIndices).size !== value.receivedIndices.length ||
      value.receivedIndices.some((index) => index >= value.chunkCount)
    )
      context.addIssue({
        code: "custom",
        message: "Chunk indices must be distinct and in this session.",
      });
  });
export type EditorialMediaUploadSession = z.infer<
  typeof editorialMediaUploadSessionSchema
>;

export const editorialMediaUploadChunkResultSchema = z.strictObject({
  uploadId: digestSchema,
  index: z
    .number()
    .int()
    .min(0)
    .max(MAX_MEDIA_UPLOAD_CHUNKS - 1),
  bytes: z.number().int().min(1).max(MEDIA_UPLOAD_CHUNK_BYTES),
  sha256: digestSchema,
});
export type EditorialMediaUploadChunkResult = z.infer<
  typeof editorialMediaUploadChunkResultSchema
>;

/** Ordinary native media identity; no provider credentials, URLs or chunk paths. */
export const editorialUploadedMediaSchema = z.strictObject({
  id: z.number().int().positive(),
  mediaId: mediaIdSchema,
  catalogId: catalogIdSchema,
  objectKey: editorialMediaSchema.shape.objectKey,
  sha256: digestSchema,
  mimeType: z.enum(["image/jpeg", "image/png", "image/webp"]),
  filesize: z.number().int().min(1).max(MAX_MEDIA_UPLOAD_BYTES),
  filename: z.string().min(1).max(256),
  width: editorialMediaSchema.shape.width,
  height: editorialMediaSchema.shape.height,
  alt: editorialMediaSchema.shape.alt,
  rights: editorialMediaSchema.shape.rights,
  orderConfidence: editorialMediaSchema.shape.orderConfidence,
});
export type EditorialUploadedMedia = z.infer<
  typeof editorialUploadedMediaSchema
>;

export const editorialMediaUploadCompleteResultSchema = z.strictObject({
  media: editorialUploadedMediaSchema,
  reused: z.boolean(),
  validatedBytes: z.number().int().min(1).max(MAX_MEDIA_UPLOAD_BYTES),
  validatedSha256: digestSchema,
});
export type EditorialMediaUploadCompleteResult = z.infer<
  typeof editorialMediaUploadCompleteResultSchema
>;

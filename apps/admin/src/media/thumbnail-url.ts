import { catalogThumbnailRequestSchema } from "@moya/contracts/internal/editorial";

/** A private locator; it grants no access and never points at the original. */
export const catalogThumbnailURL = (
  doc: Record<string, unknown>,
  apiBase = "/api",
): string => {
  const parsed = catalogThumbnailRequestSchema.safeParse({
    mediaId: doc.mediaId,
    objectKey: doc.objectKey,
    sourceSha256: doc.sha256,
  });
  if (!parsed.success) return `${apiBase}/catalog-media-thumbnail`;
  return `${apiBase}/catalog-media-thumbnail?${new URLSearchParams(parsed.data)}`;
};

import { z } from "zod";
import { normalizeMentionText } from "./mention-references.ts";

/** #358: static, managed images; offsets address normalized UTF-16 text. */
export const COMMENT_IMAGE_LIMITS = Object.freeze({
  maxImages: 6,
  maxBytes: 10 * 1024 * 1024,
});
export const commentImageInputSchema = z.strictObject({
  itemId: z.string().regex(/^media-item-[0-9a-f]{32}$/u),
  offset: z.number().int().min(0).max(1000),
});
const imageUrl = (variant: string) =>
  z
    .string()
    .regex(
      new RegExp(
        `^/api/community/discussion/images/comment-[0-9a-f]{32}/media-item-[0-9a-f]{32}/${variant}$`,
        "u",
      ),
    );
export const commentImageSchema = z.strictObject({
  id: z.string().regex(/^media-item-[0-9a-f]{32}$/u),
  offset: z.number().int().min(0).max(1000),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  thumbSrc: imageUrl("thumb"),
  src: imageUrl("display"),
  fullSrc: imageUrl("full").optional(),
});
export const commentImageInputsSchema = z
  .array(commentImageInputSchema)
  .max(COMMENT_IMAGE_LIMITS.maxImages);
export const commentImagesSchema = z
  .array(commentImageSchema)
  .max(COMMENT_IMAGE_LIMITS.maxImages);
export type CommentImageInput = z.infer<typeof commentImageInputSchema>;
export type CommentImage = z.infer<typeof commentImageSchema>;

export function validCommentImageOffsets(
  text: string,
  images: readonly CommentImageInput[],
): boolean {
  const body = normalizeMentionText(text);
  const ids = new Set<string>();
  let previous = 0;
  for (const image of images) {
    const at = image.offset;
    if (
      !Number.isSafeInteger(at) ||
      at < previous ||
      at > body.length ||
      ids.has(image.itemId) ||
      (at > 0 &&
        at < body.length &&
        /[\uD800-\uDBFF]/u.test(body[at - 1]!) &&
        /[\uDC00-\uDFFF]/u.test(body[at]!))
    )
      return false;
    ids.add(image.itemId);
    previous = at;
  }
  return images.length <= COMMENT_IMAGE_LIMITS.maxImages;
}

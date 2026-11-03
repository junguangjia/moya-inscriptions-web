/** Representation negotiation only; this capability never grants access. */
export const COMMENT_IMAGE_CAPABILITY_HEADER = "x-yoyi-comment-images";
export const COMMENT_IMAGE_CAPABILITY_VERSION = "1";

const imageOnlyDisplayHint = "【此条含附图，请刷新页面查看】";
const deletedDisplayText = "This comment has been deleted";
const containers = new Set([
  "items",
  "hot",
  "replies",
  "item",
  "root",
  "comment",
  "comments",
  "result",
  "reply",
  "replyTo",
  "data",
]);

/**
 * Adapt authorized comment JSON for clients predating inline images. The
 * canonical body is never mutated and the display hint is never stored text.
 * Unknown properties (including media/auth/report snapshots) are not traversed.
 */
export function commentImagePayloadFor(
  version: unknown,
  payload: unknown,
): unknown {
  if (version === COMMENT_IMAGE_CAPABILITY_VERSION) return payload;
  const visit = (value: unknown): unknown => {
    if (Array.isArray(value)) {
      const projected = value.map(visit);
      return projected.some((item, index) => item !== value[index])
        ? projected
        : value;
    }
    if (value === null || typeof value !== "object") return value;
    const row = value as Record<string, unknown>;
    let projected: Record<string, unknown> | undefined;
    const isComment =
      typeof row.id === "string" &&
      /^comment-[0-9a-f]{32}$/u.test(row.id) &&
      typeof row.text === "string";
    if (isComment) {
      if (Object.hasOwn(row, "images")) {
        projected = { ...row };
        delete projected.images;
      }
      if (row.text === "") {
        const text =
          row.deleted === true || row.bodyDeleted === true
            ? deletedDisplayText
            : Array.isArray(row.images) && row.images.length > 0
              ? imageOnlyDisplayHint
              : undefined;
        if (text !== undefined) {
          projected ??= { ...row };
          projected.text = text;
        }
      }
    }
    for (const key of Object.keys(row)) {
      if (!containers.has(key)) continue;
      const child = visit(row[key]);
      if (child !== row[key]) {
        projected ??= { ...row };
        projected[key] = child;
      }
    }
    return projected ?? value;
  };
  return visit(payload);
}

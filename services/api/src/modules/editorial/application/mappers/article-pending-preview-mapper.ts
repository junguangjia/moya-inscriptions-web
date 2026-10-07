import { articleReferences, workMediaSchema } from "@moya/contracts/schemas";
import { articlePendingPreviewSchema } from "@moya/contracts/internal/community-operator";
import type { PublishingMediaItem, WorkMedia } from "@moya/contracts";
import type {
  ArticlePendingCandidate,
  ArticlePendingPreview,
} from "@moya/contracts/internal/community-operator";

/** Uses the canonical body/gallery/cover collector; unused dictionaries are not authority. */
export const pendingArticleReferences = (candidate: ArticlePendingCandidate) =>
  articleReferences(candidate.document, candidate.coverRefId);

/** Same-origin paths only: a pending draft is never published. */
const sameOriginPath = (src: string | undefined): boolean =>
  src !== undefined && src.startsWith("/") && !src.startsWith("//");

/**
 * The item's public display overlay only; component and private facts stay
 * server-side. `workMediaSchema` also admits published URLs (unified media
 * pipeline, CW6), which a pending draft never has, so a source that is not a
 * same-origin path is refused here, never treated as media authority.
 */
export const pendingArticleManagedMedia = (
  item: PublishingMediaItem,
): WorkMedia | null => {
  if (item.state !== "ready" || !item.media || !item.presentation) return null;
  if (
    !sameOriginPath(item.media.displaySrc) ||
    (item.kind === "live" && !sameOriginPath(item.media.motionSrc))
  )
    return null;
  const parsed = workMediaSchema.safeParse({
    id: item.id,
    kind: item.kind,
    src: item.media.displaySrc,
    width: item.presentation.width,
    height: item.presentation.height,
    ...(item.kind === "live"
      ? {
          motionSrc: item.media.motionSrc,
          ...(item.presentation.hasAudio === undefined
            ? {}
            : { hasAudio: item.presentation.hasAudio }),
        }
      : {}),
  });
  return parsed.success ? parsed.data : null;
};
export const parseArticlePendingPreview = (
  value: unknown,
): ArticlePendingPreview => articlePendingPreviewSchema.parse(value);

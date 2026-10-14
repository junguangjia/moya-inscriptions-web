import type { AuthorMedia } from "@moya/contracts";

import { srcSetOf } from "./responsive-media";
import type { RenditionCandidate, ResponsiveImage } from "./responsive-media";

/**
 * profile-media-renditions-v1: the image each profile surface loads. An
 * avatar or background lists its renditions (one family, ascending) only once
 * they are ready; until then, and on any older Backend, every surface keeps
 * the original `src`. URLs arrive fully formed from the Backend; this module
 * only picks among them. The owner's editors keep the original on purpose.
 */

type ProfileImage = Pick<AuthorMedia, "src" | "renditions">;

const candidates = (media: ProfileImage): readonly RenditionCandidate[] =>
  [...(media.renditions ?? [])].sort(
    (a, b) => a.width - b.width || a.height - b.height,
  );

/** An avatar drawn at 48 CSS px or less: the smallest rendition (`avatar-128`). */
export function avatarThumbSrc(media: ProfileImage): string;
export function avatarThumbSrc(
  media: ProfileImage | null | undefined,
): string | null;
export function avatarThumbSrc(
  media: ProfileImage | null | undefined,
): string | null {
  return media ? (candidates(media)[0]?.src ?? media.src) : null;
}

/**
 * The profile header (80 px) and registration (96 px) avatars: `avatar-128`
 * at 1x and `avatar-512` from 2x. One rendition alone (the source was no
 * larger) needs no `srcset`.
 */
export const avatarImage = (
  media: ProfileImage,
  box: 80 | 96,
): ResponsiveImage => {
  const list = candidates(media);
  const [smallest] = list;
  if (smallest === undefined) return { src: media.src };
  const srcSet = list.length < 2 ? undefined : srcSetOf(list);
  return srcSet === undefined
    ? { src: smallest.src }
    : { src: smallest.src, srcSet, sizes: `${box}px` };
};

/**
 * The cover's photo, compact strip and frost: one URL for all three, so one
 * download, and the key its tint is sampled under. The cover is drawn wider
 * than its box as the header grows, which no fixed `sizes` can describe, so
 * it is the largest rendition (`background-1600`, else `background-960`).
 */
export function coverSrc(media: ProfileImage): string;
export function coverSrc(media: ProfileImage | null | undefined): string | null;
export function coverSrc(
  media: ProfileImage | null | undefined,
): string | null {
  return media ? (candidates(media).at(-1)?.src ?? media.src) : null;
}

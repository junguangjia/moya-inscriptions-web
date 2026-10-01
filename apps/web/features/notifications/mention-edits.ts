import type { MentionReference } from "@moya/contracts";
import { normalizeMentionText, validMentionReferences } from "./mention-data";

/** Keep identities only for spans untouched by a single editor replacement. Pasted text never gains identity. */
export function remapMentions(
  before: string,
  after: string,
  refs: readonly MentionReference[],
): MentionReference[] {
  const old = normalizeMentionText(before),
    next = normalizeMentionText(after);
  let start = 0;
  while (
    start < old.length &&
    start < next.length &&
    old[start] === next[start]
  )
    start++;
  let oldEnd = old.length,
    newEnd = next.length;
  while (
    oldEnd > start &&
    newEnd > start &&
    old[oldEnd - 1] === next[newEnd - 1]
  ) {
    oldEnd--;
    newEnd--;
  }
  const moved = refs.flatMap((ref) =>
    ref.end <= start
      ? [ref]
      : ref.start >= oldEnd
        ? [
            {
              ...ref,
              start: ref.start + newEnd - oldEnd,
              end: ref.end + newEnd - oldEnd,
            },
          ]
        : [],
  );
  return validMentionReferences(next, moved) ? moved : [];
}

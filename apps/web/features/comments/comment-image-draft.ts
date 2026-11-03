import type { CommentImageInput } from "@moya/contracts";

/** Local editor anchors, before CRLF normalization and trimming at submission. */
export interface CommentImageDraftAnchor {
  readonly key: string;
  readonly offset: number;
}

const splitsSurrogate = (text: string, at: number): boolean =>
  at > 0 &&
  at < text.length &&
  /[\uD800-\uDBFF]/u.test(text[at - 1]!) &&
  /[\uDC00-\uDFFF]/u.test(text[at]!);

/** Native selections normally respect pairs; programmatic/restored ones may not. */
export const commentImageBoundary = (text: string, offset: number): number => {
  const bounded = Math.max(
    0,
    Math.min(text.length, Number.isFinite(offset) ? Math.trunc(offset) : 0),
  );
  return splitsSurrogate(text, bounded) ? bounded - 1 : bounded;
};

/**
 * One textarea replacement rebases images without putting markers in the text.
 * At an insertion point an image stays before newly typed text, so typing after
 * adding an image does not silently move it to the end. Deleted ranges collapse
 * their anchors to the replacement's start. Same-position image order is stable.
 */
export function rebaseCommentImageAnchors<
  Anchor extends { readonly offset: number },
>(before: string, after: string, anchors: readonly Anchor[]): Anchor[] {
  if (before === after) return [...anchors];
  let start = 0;
  while (
    start < before.length &&
    start < after.length &&
    before[start] === after[start]
  )
    start++;
  while (
    start > 0 &&
    (splitsSurrogate(before, start) || splitsSurrogate(after, start))
  )
    start--;
  let suffix = 0;
  while (
    before.length - suffix > start &&
    after.length - suffix > start &&
    before[before.length - suffix - 1] === after[after.length - suffix - 1]
  )
    suffix++;
  while (
    suffix > 0 &&
    (splitsSurrogate(before, before.length - suffix) ||
      splitsSurrogate(after, after.length - suffix))
  )
    suffix--;
  const oldEnd = before.length - suffix;
  const newEnd = after.length - suffix;
  return anchors
    .map((anchor) => {
      const old = commentImageBoundary(before, anchor.offset);
      const offset =
        old <= start ? old : old >= oldEnd ? old + newEnd - oldEnd : start;
      return { ...anchor, offset: commentImageBoundary(after, offset) };
    })
    .sort((left, right) => left.offset - right.offset);
}

/** The same canonical body basis as mentions; no NFC or code-point conversion. */
export function normalizeCommentImageDraft<
  Anchor extends { readonly offset: number },
>(
  text: string,
  anchors: readonly Anchor[],
): { text: string; images: Anchor[] } {
  const newlines = text.replace(/\r\n?/gu, "\n");
  const body = newlines.trim();
  const leading = newlines.length - newlines.trimStart().length;
  return {
    text: body,
    images: anchors
      .map((anchor) => {
        const raw = commentImageBoundary(text, anchor.offset);
        const prefix = text.slice(0, raw).replace(/\r\n?/gu, "\n").length;
        return {
          ...anchor,
          offset: commentImageBoundary(body, prefix - leading),
        };
      })
      .sort((left, right) => left.offset - right.offset),
  };
}

/** Move after existing images at this exact caret, without changing the body. */
export function moveCommentImageToCaret<Anchor extends CommentImageDraftAnchor>(
  text: string,
  anchors: readonly Anchor[],
  key: string,
  caret: number,
): Anchor[] {
  const found = anchors.find((anchor) => anchor.key === key);
  if (found === undefined) return [...anchors];
  return [
    ...anchors.filter((anchor) => anchor.key !== key),
    { ...found, offset: commentImageBoundary(text, caret) },
  ].sort((left, right) => left.offset - right.offset);
}

/** Reordering adjacent images at one anchor never relocates surrounding text. */
export function reorderCommentImageAnchors<
  Anchor extends CommentImageDraftAnchor,
>(anchors: readonly Anchor[], key: string, direction: -1 | 1): Anchor[] {
  const result = [...anchors];
  const at = result.findIndex((anchor) => anchor.key === key);
  const other = at + direction;
  if (
    at < 0 ||
    other < 0 ||
    other >= result.length ||
    result[at]!.offset !== result[other]!.offset
  )
    return result;
  [result[at], result[other]] = [result[other]!, result[at]!];
  return result;
}

export const commentImagePositionLabel = (
  text: string,
  offset: number,
): string => {
  const at = commentImageBoundary(text, offset);
  if (at === 0) return "正文开头";
  if (at === text.length) return "正文末尾";
  return `正文第 ${[...text.slice(0, at)].length} 个字符后`;
};

/** Convert ready local editor rows to the shared request shape, not a new DTO. */
export const commentImageInputs = (
  text: string,
  rows: readonly { readonly itemId: string; readonly offset: number }[],
): { text: string; images: CommentImageInput[] } =>
  normalizeCommentImageDraft(text, rows);

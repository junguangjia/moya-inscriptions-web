import { z } from "zod";

export const MENTION_LIMIT = 20;
export const mentionReferenceSchema = z.strictObject({
  userId: z.string().regex(/^user-[0-9a-f]{32}$/u),
  handle: z.string().regex(/^[a-z][a-z0-9-]{2,31}$/u),
  start: z.number().int().nonnegative().max(100_000),
  end: z.number().int().positive().max(100_000),
});
export const mentionReferencesSchema = z
  .array(mentionReferenceSchema)
  .max(MENTION_LIMIT);
export type MentionReference = z.infer<typeof mentionReferenceSchema>;
export const normalizeMentionText = (text: string): string =>
  text.replace(/\r\n?/gu, "\n").trim();
const splitsSurrogate = (text: string, at: number): boolean =>
  at > 0 &&
  at < text.length &&
  /[\uD800-\uDBFF]/u.test(text[at - 1]!) &&
  /[\uDC00-\uDFFF]/u.test(text[at]!);
/** Offsets refer to normalized text, in UTF-16 code units, never code points. */
export function validMentionReferences(
  text: string,
  refs: readonly MentionReference[],
): boolean {
  const value = normalizeMentionText(text);
  let end = 0;
  const people = new Set<string>();
  for (const ref of refs) {
    if (
      ref.start < end ||
      ref.end <= ref.start ||
      ref.end > value.length ||
      splitsSurrogate(value, ref.start) ||
      splitsSurrogate(value, ref.end) ||
      value.slice(ref.start, ref.end) !== `@${ref.handle}` ||
      people.has(ref.userId)
    )
      return false;
    people.add(ref.userId);
    end = ref.end;
  }
  return refs.length <= MENTION_LIMIT;
}

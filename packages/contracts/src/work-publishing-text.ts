/**
 * The one Unicode counting rule for work publishing text (requirement C02),
 * shared by the contracts, Web counters and the Backend. Pure and free of Zod
 * so client bundles can use it.
 *
 * - Line breaks: CRLF and lone CR become LF.
 * - NUL and lone surrogates are rejected, never repaired.
 * - Outer whitespace is trimmed; a title is a single line; a body keeps its
 *   internal line breaks.
 * - Length is the number of Unicode code points after normalization
 *   (`[...value].length` in JavaScript, `char_length` in PostgreSQL). Content
 *   that was valid under the earlier UTF-16 bound always stays valid.
 * - Empty means empty after normalization, so whitespace-only text is empty.
 */

export const WORK_TITLE_MAXIMUM = 200;
export const WORK_BODY_MAXIMUM = 10_000;
export const AUTHORSHIP_REFERENCE_TITLE_MAXIMUM = 200;
export const AUTHORSHIP_ORIGINAL_AUTHOR_MAXIMUM = 100;
export const AUTHORSHIP_SOURCE_NOTE_MAXIMUM = 500;
/** Drafts may hold un-normalized input up to the limit plus this many code points. */
export const DRAFT_TEXT_RAW_ALLOWANCE = 2_000;
/** The hard schema bound on items in one work; the configured maximum is enforced by the Backend. */
export const WORK_ITEMS_HARD_MAXIMUM = 500;
/**
 * The largest configurable item maximum (`maxItemsPerWork`). A draft save
 * with this many items, every optional item field and full-length realistic
 * text (up to 3 UTF-8 bytes per code point, with the raw draft allowance as
 * trimmable whitespace) stays within the 100 KB JSON command limit of the Web
 * relay and the Backend. It is not a bound on every schema-valid save: 4-byte
 * characters at every limit, or the allowance spent on characters JSON
 * escapes, can serialize past 100 KB, and the command size limit refuses such
 * a save.
 */
export const WORK_ITEMS_CONFIGURABLE_MAXIMUM = 100;
/** Card and draft excerpts: the opening of the body. */
export const WORK_EXCERPT_MAXIMUM = 160;

/** Counts Unicode code points; a lone surrogate counts as one. */
export const codePointLength = (value: string): number => [...value].length;

/** NUL or an unpaired surrogate anywhere in the value. */
export const hasInvalidPublishingCharacters = (value: string): boolean =>
  value.includes("\u0000") || /[\uD800-\uDFFF]/u.test(value);

/** CRLF and lone CR become LF. */
export const normalizePublishingLineBreaks = (value: string): string =>
  value.replace(/\r\n?/gu, "\n");

/** Normalized title text; validity is checked separately. */
export const normalizePublishingTitle = (value: string): string =>
  normalizePublishingLineBreaks(value).trim();

/** Normalized body text with internal line breaks preserved. */
export const normalizePublishingBody = (value: string): string =>
  normalizePublishingLineBreaks(value).trim();

export type PublishingTextIssue =
  "invalid_characters" | "line_break" | "too_long";

export interface PublishingTextCheck {
  /** The normalized value, the only form that is stored or published. */
  readonly value: string;
  /** Code points of the normalized value. */
  readonly length: number;
  readonly issue: PublishingTextIssue | null;
}

export interface PublishingTextRule {
  readonly maximum: number;
  readonly singleLine: boolean;
  /** Extra raw code points a draft may carry before normalization. */
  readonly rawAllowance?: number;
}

/** Applies the counting rule to one text field. */
export const checkPublishingText = (
  raw: string,
  rule: PublishingTextRule,
): PublishingTextCheck => {
  const value = normalizePublishingLineBreaks(raw).trim();
  const length = codePointLength(value);
  const issue: PublishingTextIssue | null = hasInvalidPublishingCharacters(raw)
    ? "invalid_characters"
    : length > rule.maximum ||
        codePointLength(raw) > rule.maximum + (rule.rawAllowance ?? 0)
      ? "too_long"
      : rule.singleLine && value.includes("\n")
        ? "line_break"
        : null;
  return { value, length, issue };
};

export const publishingTitleRule: PublishingTextRule = {
  maximum: WORK_TITLE_MAXIMUM,
  singleLine: true,
  rawAllowance: DRAFT_TEXT_RAW_ALLOWANCE,
};

export const publishingBodyRule: PublishingTextRule = {
  maximum: WORK_BODY_MAXIMUM,
  singleLine: false,
  rawAllowance: DRAFT_TEXT_RAW_ALLOWANCE,
};

export const checkPublishingTitle = (raw: string): PublishingTextCheck =>
  checkPublishingText(raw, publishingTitleRule);

export const checkPublishingBody = (raw: string): PublishingTextCheck =>
  checkPublishingText(raw, publishingBodyRule);

/**
 * The content-level failure codes the shared rule can decide without server
 * state. Readiness, capacity and daily limits are decided by the Backend.
 */
export type PublishingContentIssue =
  | "empty_work"
  | "title_required"
  | "image_required"
  | "title_too_long"
  | "title_line_break"
  | "body_too_long"
  | "items_limit";

export interface PublishingContentInput {
  readonly title: string;
  readonly body: string;
  readonly itemCount: number;
}

/**
 * Validates content for submission against the counting rule and a configured
 * item maximum. A submission needs a nonblank title and at least one retained
 * photo; wholly empty content keeps the `empty_work` code. Drafts keep a title
 * line break; a submission refuses it with `title_line_break`.
 */
export const publishingContentIssues = (
  content: PublishingContentInput,
  limits: { readonly maxItems: number },
): PublishingContentIssue[] => {
  const title = checkPublishingTitle(content.title);
  const body = checkPublishingBody(content.body);
  const issues: PublishingContentIssue[] = [];
  if (title.length === 0 && body.length === 0 && content.itemCount === 0)
    issues.push("empty_work");
  else {
    if (title.length === 0) issues.push("title_required");
    if (content.itemCount === 0) issues.push("image_required");
  }
  if (title.issue === "too_long") issues.push("title_too_long");
  if (title.issue === "line_break") issues.push("title_line_break");
  if (body.issue === "too_long") issues.push("body_too_long");
  if (
    content.itemCount > limits.maxItems ||
    content.itemCount > WORK_ITEMS_HARD_MAXIMUM
  )
    issues.push("items_limit");
  return issues;
};

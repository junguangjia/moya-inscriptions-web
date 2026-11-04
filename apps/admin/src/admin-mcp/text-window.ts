import { createHash } from "node:crypto";

import OpenCC from "opencc";

/**
 * Long text in bounded pieces (admin-mcp-completion-v1 section 6). Every offset and
 * length is in code points, because the write contract refuses a split surrogate:
 * a window cut here can always be submitted again as it stands.
 */

/** Serialized, under the 9,000-byte cap with room for the envelope around it. */
export const WINDOW_BYTES = 6_000;

export const textHash = (text: string): string =>
  createHash("sha256").update(text).digest("hex");

export const codePointLength = (text: string): number => {
  let length = 0;
  for (let index = 0; index < text.length; index += 1) {
    const unit = text.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = text.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) index += 1;
    }
    length += 1;
  }
  return length;
};

/** What one code point costs inside a JSON string, escapes included. */
const serializedBytes = (point: string) =>
  Buffer.byteLength(JSON.stringify(point)) - 2;

export const textWindow = (
  text: string,
  offset = 0,
  maxChars?: number,
): {
  readonly text: string;
  readonly totalLength: number;
  readonly nextOffset?: number;
} => {
  const points = Array.from(text);
  const kept: string[] = [];
  let bytes = 0;
  for (let index = offset; index < points.length; index += 1) {
    if (maxChars !== undefined && kept.length >= maxChars) break;
    const size = serializedBytes(points[index]!);
    if (bytes + size > WINDOW_BYTES) break;
    bytes += size;
    kept.push(points[index]!);
  }
  const next = offset + kept.length;
  return {
    text: kept.join(""),
    totalLength: points.length,
    ...(next < points.length && kept.length > 0 ? { nextOffset: next } : {}),
  };
};

const converter = new OpenCC("t2s.json");

/** The conversion Catalog search documents are built with (packages/search). */
export const normalizeSearchQuery = (text: string): string =>
  converter.convertSync(text);

let toTraditional: InstanceType<typeof OpenCC> | undefined;

/**
 * Built by the first text it can change, never at startup: on opencc 1.4.1 its
 * dictionaries take about 25 ms to load and hold about 25 MB. One simplified character
 * can have several traditional forms, and this gives only the commonest one.
 */
export const traditionalSearchQuery = (text: string): string => {
  if (/^\p{ASCII}*$/u.test(text)) return text;
  toTraditional ??= new OpenCC("s2t.json");
  return toTraditional.convertSync(text);
};

const convertedPoints = new Map<string, string>();

/**
 * One code point at a time, so offsets in the normalized text are offsets in the raw
 * text too, and a fragment normalizes the same way wherever it appears; a whole-text
 * conversion also applies phrases, which change with their surroundings. A point that
 * would become more than one keeps its own form.
 */
const normalizedPoint = (point: string): string => {
  if (point < "\u0080") return point;
  const known = convertedPoints.get(point);
  if (known !== undefined) return known;
  const converted = converter.convertSync(point);
  const kept = codePointLength(converted) === 1 ? converted : point;
  convertedPoints.set(point, kept);
  return kept;
};

const pointOffsetsOf = (haystack: string, needle: string): number[] => {
  const offsets: number[] = [];
  let unit = 0;
  let point = 0;
  let at = haystack.indexOf(needle);
  while (at !== -1) {
    while (unit < at) {
      unit += haystack.codePointAt(unit)! > 0xffff ? 2 : 1;
      point += 1;
    }
    // A needle starting inside a character is not a match of that character.
    if (unit === at) offsets.push(point);
    at = haystack.indexOf(needle, at + 1);
  }
  return offsets;
};

export const FIND_MATCHES_PER_CALL = 50;
export const FIND_DEFAULT_CONTEXT = 20;

export interface TextMatch {
  readonly offset: number;
  readonly length: number;
  readonly before: string;
  readonly match: string;
  readonly after: string;
}

/**
 * Overlapping occurrences count, so a count of one really means one place. Normalized
 * search merges distinct traditional forms, so it locates and never decides an edit.
 */
export const findInText = (
  text: string,
  needle: string,
  mode: "raw" | "normalized",
  context: number,
  fromOffset = 0,
): {
  readonly count: number;
  readonly matches: readonly TextMatch[];
  readonly more: boolean;
} => {
  const points = Array.from(text);
  const offsets =
    mode === "raw"
      ? pointOffsetsOf(text, needle)
      : pointOffsetsOf(
          points.map(normalizedPoint).join(""),
          Array.from(needle, normalizedPoint).join(""),
        );
  const length = codePointLength(needle);
  const ahead = offsets.filter((offset) => offset >= fromOffset);
  return {
    count: offsets.length,
    more: ahead.length > FIND_MATCHES_PER_CALL,
    matches: ahead.slice(0, FIND_MATCHES_PER_CALL).map((offset) => ({
      offset,
      length,
      before: points.slice(Math.max(0, offset - context), offset).join(""),
      match: points.slice(offset, offset + length).join(""),
      after: points.slice(offset + length, offset + length + context).join(""),
    })),
  };
};

/** A short piece of text around a match, bounded in code points. */
export const snippetAround = (
  text: string,
  needle: string,
): { readonly offset: number; readonly snippet: string } | undefined => {
  const at = text.toLowerCase().indexOf(needle.toLowerCase());
  if (at === -1) return undefined;
  const points = Array.from(text);
  const offset = codePointLength(text.slice(0, at));
  return {
    offset,
    snippet: points
      .slice(
        Math.max(0, offset - FIND_DEFAULT_CONTEXT),
        offset + codePointLength(needle) + FIND_DEFAULT_CONTEXT,
      )
      .join(""),
  };
};

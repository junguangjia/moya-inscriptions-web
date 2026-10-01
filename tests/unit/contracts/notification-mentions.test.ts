import { describe, expect, it } from "vitest";
import {
  createCatalogCommentRequestSchema,
  normalizeMentionText,
  validMentionReferences,
} from "@moya/contracts/schemas";
import { remapMentions } from "../../../apps/web/features/notifications/mention-edits.js";
const id = `user-${"a".repeat(32)}`;
const ref = { userId: id, handle: "reader", start: 6, end: 13 };
describe("resolved mentions", () => {
  it("uses LF/trim-normalized UTF-16 with CJK, emoji and combining characters unchanged", () => {
    const raw = "  碑😀é\r\n@reader  ";
    expect(normalizeMentionText(raw)).toBe("碑😀é\n@reader");
    expect(validMentionReferences(raw, [ref])).toBe(true);
    expect(
      createCatalogCommentRequestSchema.safeParse({
        text: normalizeMentionText(raw),
        mentions: [ref],
      }).success,
    ).toBe(true);
    expect(validMentionReferences(raw, [{ ...ref, start: 2 }])).toBe(false);
  });
  it("rejects overlapping, forged, out-of-range, duplicate and excessive selections", () => {
    expect(
      validMentionReferences("@reader", [{ ...ref, start: 0, end: 8 }]),
    ).toBe(false);
    expect(
      validMentionReferences("@reader @reader", [
        { ...ref, start: 0, end: 7 },
        { ...ref, start: 8, end: 15 },
      ]),
    ).toBe(false);
    expect(
      createCatalogCommentRequestSchema.safeParse({
        text: "@reader",
        mentions: [{ ...ref, start: 0, end: 7, userId: "display-name" }],
      }).success,
    ).toBe(false);
    expect(
      createCatalogCommentRequestSchema.safeParse({
        text: "@reader",
        mentions: Array(21).fill({ ...ref, start: 0, end: 7 }),
      }).success,
    ).toBe(false);
  });
  it("preserves unchanged spans across prefix/suffix edits but not replacing a mention or pasted lookalikes", () => {
    const refs = [{ ...ref, start: 0, end: 7 }];
    expect(remapMentions("@reader", "碑😀 @reader", refs)).toEqual([
      { ...ref, start: 4, end: 11 },
    ]);
    expect(remapMentions("@reader", "@other", refs)).toEqual([]);
    expect(remapMentions("", "@reader", [])).toEqual([]);
  });
});

import { describe, expect, it } from "vitest";
import {
  WORK_BODY_MAXIMUM,
  WORK_TITLE_MAXIMUM,
  checkPublishingBody,
  checkPublishingText,
  checkPublishingTitle,
  codePointLength,
  hasInvalidPublishingCharacters,
  normalizePublishingBody,
  normalizePublishingTitle,
  publishingContentIssues,
  workDraftContentSchema,
  workSubmissionContentSchema,
} from "@moya/contracts/schemas";

const astral = "𠀀"; // U+20000: one code point, two UTF-16 units
const emptyContent = {
  title: "",
  body: "",
  authorship: { kind: "original" },
  visibility: "public",
  items: [],
  coverKey: null,
  coverCrop: null,
};
const image = {
  key: "photo-1",
  itemId: `media-item-${"a".repeat(32)}`,
  kind: "static",
  qualityMode: "standard",
  edit: { rotation: 0, crop: null },
};

describe("work publishing Unicode counting rule", () => {
  it("counts code points, not UTF-16 units", () => {
    expect(codePointLength(astral)).toBe(1);
    expect(astral.length).toBe(2);
    expect(codePointLength("合成😀a")).toBe(4);
    expect(codePointLength("")).toBe(0);
  });

  it("accepts 200 astral title code points and refuses 201", () => {
    const atLimit = checkPublishingTitle(astral.repeat(WORK_TITLE_MAXIMUM));
    expect(atLimit).toMatchObject({ length: 200, issue: null });
    expect(
      checkPublishingTitle(astral.repeat(WORK_TITLE_MAXIMUM + 1)).issue,
    ).toBe("too_long");
    // Earlier valid content bounded in UTF-16 units stays valid.
    expect(checkPublishingTitle("字".repeat(200)).issue).toBeNull();
  });

  it("accepts 10000 astral body code points and refuses 10001", () => {
    expect(
      checkPublishingBody(astral.repeat(WORK_BODY_MAXIMUM)).issue,
    ).toBeNull();
    expect(
      checkPublishingBody(astral.repeat(WORK_BODY_MAXIMUM + 1)).issue,
    ).toBe("too_long");
  });

  it("surfaces field codes from the draft content schema at the same boundaries", () => {
    const messages = (content: Record<string, unknown>) => {
      const result = workDraftContentSchema.safeParse({
        ...emptyContent,
        ...content,
      });
      return result.success
        ? []
        : result.error.issues.map((issue) => issue.message);
    };
    expect(messages({ title: astral.repeat(200) })).toEqual([]);
    expect(messages({ title: astral.repeat(201) })).toEqual(["title_too_long"]);
    expect(messages({ body: astral.repeat(10_000) })).toEqual([]);
    expect(messages({ body: astral.repeat(10_001) })).toEqual([
      "body_too_long",
    ]);
    expect(messages({ body: "a\u0000b" })).toEqual(["invalid_characters"]);
  });

  it("keeps a title line break in drafts and refuses it at submission with its field code", () => {
    const draft = workDraftContentSchema.safeParse({
      ...emptyContent,
      title: "上\r\n下",
    });
    expect(draft.success).toBe(true);
    const submitted = workSubmissionContentSchema.safeParse({
      ...emptyContent,
      title: "上\r\n下",
      items: [image],
    });
    expect(
      submitted.success
        ? []
        : submitted.error.issues.map((issue) => issue.message),
    ).toEqual(["title_line_break"]);
    expect(
      workSubmissionContentSchema
        .safeParse({
          ...emptyContent,
          title: astral.repeat(201),
          items: [image],
        })
        .error?.issues.map((issue) => issue.message),
    ).toEqual(["title_too_long"]);
  });

  it("normalizes CRLF and lone CR to LF, trims outer whitespace and keeps body line breaks", () => {
    expect(normalizePublishingBody(" \r\n第一行\r\n\r第二行\r ")).toBe(
      "第一行\n\n第二行",
    );
    expect(normalizePublishingTitle("\t 标题 \r\n")).toBe("标题");
    expect(checkPublishingTitle("标题\r\n").issue).toBeNull();
    expect(checkPublishingTitle("上\r\n下").issue).toBe("line_break");
    expect(checkPublishingTitle("上\r下").issue).toBe("line_break");
    // CRLF counts once after normalization.
    expect(checkPublishingBody("a\r\nb").length).toBe(3);
  });

  it("lets drafts carry raw input within the allowance while the normalized value is bounded", () => {
    const title = "题".repeat(200);
    expect(checkPublishingTitle(title + " ".repeat(2_000)).issue).toBeNull();
    expect(checkPublishingTitle(title + " ".repeat(2_001)).issue).toBe(
      "too_long",
    );
    expect(
      checkPublishingText(title + " ", { maximum: 200, singleLine: true })
        .issue,
    ).toBe("too_long");
  });

  it("treats whitespace-only text as empty", () => {
    expect(normalizePublishingTitle(" 　\t")).toBe("");
    expect(
      publishingContentIssues(
        { title: "  ", body: "\r\n \n", itemCount: 0 },
        { maxItems: 50 },
      ),
    ).toEqual(["empty_work"]);
    expect(
      publishingContentIssues(
        { title: "", body: " 正文 ", itemCount: 0 },
        { maxItems: 50 },
      ),
    ).toEqual(["title_required", "image_required"]);
    expect(
      publishingContentIssues(
        { title: " \t　", body: "正文", itemCount: 1 },
        { maxItems: 50 },
      ),
    ).toEqual(["title_required"]);
    expect(
      publishingContentIssues(
        { title: " 标题 ", body: "", itemCount: 1 },
        { maxItems: 50 },
      ),
    ).toEqual([]);
  });

  it("rejects NUL and lone surrogates but accepts paired surrogates", () => {
    expect(hasInvalidPublishingCharacters("a\u0000b")).toBe(true);
    expect(hasInvalidPublishingCharacters("\uD800")).toBe(true);
    expect(hasInvalidPublishingCharacters("x\uDC00")).toBe(true);
    expect(hasInvalidPublishingCharacters("\uDE00\uD83D")).toBe(true);
    expect(hasInvalidPublishingCharacters("😀")).toBe(false);
    expect(checkPublishingBody("正文\u0000").issue).toBe("invalid_characters");
    expect(checkPublishingTitle("\uD800").issue).toBe("invalid_characters");
  });

  it("decides the item limit at 0, 1, 50 and 51 items", () => {
    const issues = (itemCount: number, title = "标题") =>
      publishingContentIssues({ title, body: "", itemCount }, { maxItems: 50 });
    expect(issues(0)).toEqual(["image_required"]);
    expect(issues(1, "")).toEqual(["title_required"]);
    expect(issues(1)).toEqual([]);
    expect(issues(50)).toEqual([]);
    expect(issues(51)).toEqual(["items_limit"]);
    expect(
      publishingContentIssues(
        { title: "标题", body: "", itemCount: 501 },
        { maxItems: 1_000 },
      ),
    ).toEqual(["items_limit"]);
    expect(
      publishingContentIssues(
        {
          title: astral.repeat(201),
          body: astral.repeat(10_001),
          itemCount: 51,
        },
        { maxItems: 50 },
      ),
    ).toEqual(["title_too_long", "body_too_long", "items_limit"]);
    expect(
      publishingContentIssues(
        { title: "上\n下", body: "", itemCount: 1 },
        { maxItems: 50 },
      ),
    ).toEqual(["title_line_break"]);
  });
});

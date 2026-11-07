import { describe, expect, it } from "vitest";
import {
  TIMELINE_ENTRIES_MAXIMUM,
  contentTimelineEntrySchema,
  timelineEntryIdSchema,
  timelineEntrySchema,
  timelinePostCountsSchema,
  workDraftContentSchema,
  workPublishingFailureCodeSchema,
  workSubmissionCommandSchema,
  workSubmissionContentSchema,
  workTimelineEntryCommandSchema,
  workTimelineEntryResultSchema,
} from "@moya/contracts/schemas";
import { authorCommunityJsonSchemas } from "@moya/contracts/json-schema";

// timeline-posts-v1: the contracts of posts attached to Home timeline rows.
// Content is fictional.

const requestId = "8f6f2b0e-3c1d-4f7a-9b2e-5d4c3b2a1f00";
const workId = "work-0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0a";
const itemId = "media-item-0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0b";
const content = {
  title: "虚构访碑",
  body: "虚构正文",
  authorship: { kind: "original" },
  visibility: "public",
  items: [
    {
      key: itemId,
      itemId,
      kind: "static",
      qualityMode: "standard",
      edit: { rotation: 0, crop: null },
    },
  ],
  coverKey: null,
  coverCrop: null,
};

describe("timeline entry ids", () => {
  it("are the timeline row's own ids, and the row is built on them", () => {
    for (const id of ["a", "row-1", "z".repeat(64)])
      expect(timelineEntryIdSchema.safeParse(id).success).toBe(true);
    for (const id of ["", "Row", "row_1", "row 1", "z".repeat(65), "行"])
      expect(timelineEntryIdSchema.safeParse(id).success).toBe(false);
    expect(timelineEntrySchema.shape.id).toBe(timelineEntryIdSchema);
  });
});

describe("the author's timeline entry command", () => {
  it("names an entry or null, strictly, and answers the entry and the association's version", () => {
    expect(
      workTimelineEntryCommandSchema.parse({ requestId, entryId: "row-1" }),
    ).toEqual({ requestId, entryId: "row-1" });
    expect(
      workTimelineEntryCommandSchema.parse({ requestId, entryId: null }),
    ).toEqual({ requestId, entryId: null });
    for (const command of [
      { requestId },
      { requestId: "not-a-uuid", entryId: "row-1" },
      { requestId, entryId: "Row 1" },
      { requestId, entryId: "row-1", workId },
    ])
      expect(workTimelineEntryCommandSchema.safeParse(command).success).toBe(
        false,
      );
    expect(
      workTimelineEntryResultSchema.parse({
        workId,
        entryId: null,
        version: 0,
      }),
    ).toEqual({ workId, entryId: null, version: 0 });
    expect(
      workTimelineEntryResultSchema.safeParse({
        workId,
        entryId: "row-1",
        version: -1,
      }).success,
    ).toBe(false);
  });

  it("names its refusals in the closed failure list", () => {
    for (const code of [
      "timeline_entry_unavailable",
      "timeline_entry_conflict",
      "timeline_entry_withheld",
    ])
      expect(workPublishingFailureCodeSchema.options).toContain(code);
  });
});

describe("the entry on drafts and submissions", () => {
  it("rides on a draft and on the submission command, never in submitted content", () => {
    expect(
      workDraftContentSchema.parse({ ...content, timelineEntryId: "row-1" })
        .timelineEntryId,
    ).toBe("row-1");
    expect(workDraftContentSchema.parse(content)).not.toHaveProperty(
      "timelineEntryId",
    );
    expect(
      workDraftContentSchema.safeParse({ ...content, timelineEntryId: "Row" })
        .success,
    ).toBe(false);
    expect(
      workSubmissionContentSchema.safeParse({
        ...content,
        timelineEntryId: "row-1",
      }).success,
    ).toBe(false);
    const command = {
      requestId,
      holder: {
        sessionId: "publishing-session-0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0c",
      },
      content,
      baseRevisionId: null,
    };
    expect(workSubmissionCommandSchema.parse(command)).not.toHaveProperty(
      "timelineEntryId",
    );
    expect(
      workSubmissionCommandSchema.parse({
        ...command,
        timelineEntryId: "row-1",
      }).timelineEntryId,
    ).toBe("row-1");
    expect(
      workSubmissionCommandSchema.safeParse({
        ...command,
        timelineEntryId: "Row",
      }).success,
    ).toBe(false);
  });
});

describe("timeline post reads", () => {
  it("count only rows with posts, by row id, at most one count per row", () => {
    expect(
      timelinePostCountsSchema.parse({ counts: { "row-1": 3, "row-2": 1 } }),
    ).toEqual({ counts: { "row-1": 3, "row-2": 1 } });
    expect(timelinePostCountsSchema.parse({ counts: {} })).toEqual({
      counts: {},
    });
    for (const counts of [
      { "row-1": 0 },
      { "row-1": 1.5 },
      { "Row 1": 1 },
      { "row-1": -1 },
    ])
      expect(timelinePostCountsSchema.safeParse({ counts }).success).toBe(
        false,
      );
    expect(
      timelinePostCountsSchema.safeParse({ counts: {}, total: 0 }).success,
    ).toBe(false);
    const full = Object.fromEntries(
      Array.from({ length: TIMELINE_ENTRIES_MAXIMUM + 1 }, (_, index) => [
        `row-${index}`,
        1,
      ]),
    );
    expect(timelinePostCountsSchema.safeParse({ counts: full }).success).toBe(
      false,
    );
  });

  it("name a content item's row by id and titles, or null", () => {
    const entry = { id: "row-1", title: "虚构碑", fullTitle: "虚构朝虚构碑" };
    expect(contentTimelineEntrySchema.parse({ entry })).toEqual({ entry });
    expect(contentTimelineEntrySchema.parse({ entry: null })).toEqual({
      entry: null,
    });
    for (const value of [
      {},
      { entry: { ...entry, catalogId: null } },
      { entry: { ...entry, title: "" } },
      { entry: { ...entry, id: "Row" } },
    ])
      expect(contentTimelineEntrySchema.safeParse(value).success).toBe(false);
  });

  it("are public JSON schema components", () => {
    expect(Object.keys(authorCommunityJsonSchemas)).toEqual(
      expect.arrayContaining(["TimelinePostCounts", "ContentTimelineEntry"]),
    );
  });
});

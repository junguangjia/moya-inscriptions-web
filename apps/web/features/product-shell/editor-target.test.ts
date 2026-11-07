import { describe, expect, it } from "vitest";

import {
  editorHistoryState,
  editorLocation,
  parseEditorTarget,
  parseProductHistoryState,
} from "./product-history";

describe("a new work's 关联词条 in the editor target (timeline-posts-v1)", () => {
  it("keeps a timeline entry id on a new target, alone or with a Thread", () => {
    const entry = { type: "new" as const, timelineEntryId: "row-yongping" };
    expect(parseEditorTarget(entry)).toEqual(entry);
    const both = {
      type: "new" as const,
      threadId: `thread-${"3".repeat(32)}`,
      timelineEntryId: "row-1",
    };
    expect(parseEditorTarget(both)).toEqual(both);
  });

  it("drops a value that is not an entry id, never the target", () => {
    for (const timelineEntryId of [
      "Row-Upper",
      "row 1",
      "",
      "x".repeat(65),
      "row_1",
      7,
      null,
    ])
      expect(parseEditorTarget({ type: "new", timelineEntryId })).toEqual({
        type: "new",
      });
    // A draft or a work never carries one.
    expect(
      parseEditorTarget({
        type: "draft",
        id: `work-draft-${"1".repeat(32)}`,
        timelineEntryId: "row-1",
      }),
    ).toEqual({ type: "draft", id: `work-draft-${"1".repeat(32)}` });
  });

  it("travels in private history only: the link stays the plain #editor", () => {
    const target = { type: "new" as const, timelineEntryId: "row-yongping" };
    const state = editorHistoryState(target, "home", 120);
    expect(parseProductHistoryState(state)).toEqual(state);
    expect(
      editorLocation(
        new URL("http://127.0.0.1:47391/?feed=timeline") as unknown as Location,
        target,
      ),
    ).toBe("/?feed=timeline#editor");
  });
});

import { describe, expect, it } from "vitest";
import {
  directEditorTargetFromLocation,
  editorHistoryState,
  editorLocation,
  parseEditorTarget,
  parseProductHistoryState,
  sameEditorLink,
} from "./product-history";

describe("Article authoring history and retained Work targets", () => {
  it("resumes an owned Article draft through private history, with no draft identifier in its link", () => {
    const id = `article-${"1".repeat(32)}`;
    const state = editorHistoryState(
      { type: "article-draft", id },
      "user",
      420,
    );
    expect(parseProductHistoryState(state)).toEqual(state);
    expect(
      editorLocation(
        new URL("http://127.0.0.1:47391/?feed=topics") as unknown as Location,
        state.editorTarget,
      ),
    ).toBe("/?feed=topics#article-editor");
    expect(
      directEditorTargetFromLocation({
        search: "?feed=topics",
        hash: "#article-editor",
      }),
    ).toEqual({ type: "article-list" });
  });
  it("does not treat Article history as a Work draft or combine its link with the Work editor", () => {
    const id = `article-${"1".repeat(32)}`;
    expect(parseEditorTarget({ type: "article-draft", id })).toBeNull();
    expect(sameEditorLink({ type: "article-draft", id }, { type: "new" })).toBe(
      false,
    );
    expect(
      directEditorTargetFromLocation({
        search: `?workId=work-${"2".repeat(32)}`,
        hash: "#article-editor",
      }),
    ).toBeNull();
    expect(
      directEditorTargetFromLocation({
        search: `?articleId=${id}`,
        hash: "#article-editor",
      }),
    ).toBeNull();
  });
  it("retains ordinary Work and Thread publishing links", () => {
    const work = { type: "work" as const, id: `work-${"2".repeat(32)}` };
    const thread = {
      type: "new" as const,
      threadId: `thread-${"3".repeat(32)}`,
    };
    expect(parseEditorTarget(thread)).toEqual(thread);
    expect(
      directEditorTargetFromLocation({
        search: `?workId=${work.id}`,
        hash: "#editor",
      }),
    ).toEqual(work);
    expect(
      parseProductHistoryState(editorHistoryState(work, "home", 0))?.kind,
    ).toBe("editor");
  });
});

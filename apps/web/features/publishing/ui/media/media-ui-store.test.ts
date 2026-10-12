import { describe, expect, it, vi } from "vitest";

import { createMediaUiStore, mediaUiFor } from "./media-ui-store";

import type { CoverDraft, EditDraft } from "./media-ui-store";
import type { EditorSessionStore } from "../editor/editor-session-state";

const editDraft: EditDraft = {
  basis: { rotation: 0, crop: null },
  rotation: 90,
  stored: null,
};

describe("media UI store", () => {
  it("belongs to one editor session", () => {
    const first = {} as EditorSessionStore;
    const second = {} as EditorSessionStore;
    expect(mediaUiFor(first)).toBe(mediaUiFor(first));
    expect(mediaUiFor(first)).not.toBe(mediaUiFor(second));
  });

  it("keeps dialog work for the open dialog only, without notifying", () => {
    const ui = createMediaUiStore();
    const listener = vi.fn();
    ui.subscribe(listener);
    const dialog = { type: "edit", key: "a" } as const;
    // No dialog open: nothing is kept.
    ui.saveDraft(dialog, editDraft);
    expect(ui.draftFor(dialog)).toBe(null);

    ui.openDialog(dialog);
    expect(listener).toHaveBeenCalledTimes(1);
    ui.saveDraft(dialog, editDraft);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(ui.draftFor(dialog)).toBe(editDraft);
    expect(ui.draftFor({ type: "edit", key: "b" })).toBe(null);
    expect(ui.draftFor({ type: "cover", key: "a" })).toBe(null);

    // Reopening the same dialog keeps the work; another dialog or closing drops it.
    ui.openDialog({ type: "edit", key: "a" });
    expect(ui.draftFor(dialog)).toBe(editDraft);
    const cover = { type: "cover", key: "a" } as const;
    ui.openDialog(cover);
    expect(ui.draftFor(dialog)).toBe(null);
    const coverDraft: CoverDraft = {
      basisEdit: { rotation: 0, crop: null },
      basisCrop: null,
      session: null,
    };
    ui.saveDraft(cover, coverDraft);
    ui.closeDialog();
    expect(ui.get().dialog).toBe(null);
    expect(ui.draftFor(cover)).toBe(null);
  });

  it("tracks a re-selection until it is staged and keeps the notice", () => {
    const ui = createMediaUiStore();
    const files = new Set([new File(["x"], "a.jpg")]);
    ui.setReplacement({
      target: "gone",
      files,
      staged: false,
      previous: {
        kind: "static",
        qualityMode: "original",
        edit: { rotation: 0, crop: null },
      },
    });
    ui.markReplacementStaged();
    expect(ui.get().replacement).toMatchObject({
      target: "gone",
      staged: true,
    });
    ui.setNotice("封面已移除，现在以第 1 项作为封面");
    ui.setReplacement(null);
    expect(ui.get()).toEqual({
      dialog: null,
      selecting: false,
      selectedKeys: [],
      replacement: null,
      notice: "封面已移除，现在以第 1 项作为封面",
      phone: {
        currentKey: null,
        references: null,
        attentionKey: null,
        heldRemoval: null,
        backAsk: false,
      },
    });
  });

  it("keeps the phone flow's place and drops a current item that left", () => {
    const ui = createMediaUiStore();
    const listener = vi.fn();
    ui.subscribe(listener);
    // No screen is kept: the flow derives it from the album (r4 D4).
    expect(ui.get().phone).toEqual({
      currentKey: null,
      references: null,
      attentionKey: null,
      heldRemoval: null,
      backAsk: false,
    });

    ui.setCurrentKey("b");
    ui.setCurrentKey("b");
    expect(listener).toHaveBeenCalledTimes(1);
    ui.setReferences("originalAuthor");
    ui.setReferences("originalAuthor");
    ui.setAttentionKey("a");
    ui.setAttentionKey("a");
    expect(listener).toHaveBeenCalledTimes(3);
    expect(ui.get().phone).toEqual({
      currentKey: "b",
      references: "originalAuthor",
      attentionKey: "a",
      heldRemoval: null,
      backAsk: false,
    });
    ui.setReferences(null);
    ui.setAttentionKey(null);
    expect(ui.get().phone.references).toBe(null);
    expect(ui.get().phone.attentionKey).toBe(null);
    ui.setReferences("sourceNote");

    // A current item still in the album stays, without a change.
    const before = ui.get();
    ui.retainPhoneKeys(["a", "b"]);
    expect(ui.get()).toBe(before);
    ui.retainPhoneKeys(["a"]);
    expect(ui.get().phone).toEqual({
      currentKey: null,
      references: "sourceNote",
      attentionKey: null,
      heldRemoval: null,
      backAsk: false,
    });
    // The other slices are not touched.
    expect(ui.get()).toMatchObject({
      dialog: null,
      notice: null,
      selecting: false,
      selectedKeys: [],
    });

    // An empty album has nothing to show.
    ui.setCurrentKey("a");
    ui.retainPhoneKeys([]);
    expect(ui.get().phone).toEqual({
      currentKey: null,
      references: "sourceNote",
      attentionKey: null,
      heldRemoval: null,
      backAsk: false,
    });
    const empty = ui.get();
    ui.retainPhoneKeys([]);
    expect(ui.get()).toBe(empty);
    // A photo 前往处理 named that left the album is dropped too.
    ui.setAttentionKey("gone");
    ui.retainPhoneKeys(["a"]);
    expect(ui.get().phone.attentionKey).toBe(null);
  });

  it("holds removals for 撤销 as keys and the photo to return to, notifying on a change only", () => {
    const ui = createMediaUiStore();
    const listener = vi.fn();
    ui.subscribe(listener);
    expect(ui.get().phone.heldRemoval).toBe(null);
    ui.setHeldRemoval(null);
    expect(listener).not.toHaveBeenCalled();

    // 重新选择照片: every visible key, and the photo 编辑 showed.
    const keys = ["a", "b", "c"];
    ui.setHeldRemoval({ keys, current: "b" });
    expect(listener).toHaveBeenCalledOnce();
    expect(ui.get().phone.heldRemoval).toEqual({
      keys: ["a", "b", "c"],
      current: "b",
    });
    // The record is the store's own: a caller's later change does not leak.
    keys.push("d");
    expect(ui.get().phone.heldRemoval!.keys).toEqual(["a", "b", "c"]);
    // The same keys and current again: no change, no notification.
    ui.setHeldRemoval({ keys: ["a", "b", "c"], current: "b" });
    expect(listener).toHaveBeenCalledOnce();

    // Another record replaces it (编辑's last photo: one key).
    ui.setHeldRemoval({ keys: ["c"], current: "c" });
    expect(listener).toHaveBeenCalledTimes(2);
    expect(ui.get().phone.heldRemoval).toEqual({ keys: ["c"], current: "c" });

    // 撤销 or the commit ends it.
    ui.setHeldRemoval(null);
    expect(listener).toHaveBeenCalledTimes(3);
    expect(ui.get().phone.heldRemoval).toBe(null);
  });

  it("drops held keys that left the album, and the record once none is left", () => {
    const ui = createMediaUiStore();
    ui.setHeldRemoval({ keys: ["a", "b", "c"], current: "b" });

    // Album keys that are not held change nothing.
    const before = ui.get();
    ui.retainPhoneKeys(["a", "b", "c", "d"]);
    expect(ui.get()).toBe(before);

    // A held key leaves (START's commit removes them one by one).
    ui.retainPhoneKeys(["b", "c", "d"]);
    expect(ui.get().phone.heldRemoval).toEqual({
      keys: ["b", "c"],
      current: "b",
    });
    // The photo 撤销 returns to leaves: 撤销 then shows photo 1.
    ui.retainPhoneKeys(["c", "d"]);
    expect(ui.get().phone.heldRemoval).toEqual({ keys: ["c"], current: null });
    // No held key is left: the record ends, the album still has photos.
    ui.retainPhoneKeys(["d"]);
    expect(ui.get().phone.heldRemoval).toBe(null);

    // An emptied album ends it too.
    ui.setHeldRemoval({ keys: ["d"], current: "d" });
    ui.retainPhoneKeys([]);
    expect(ui.get().phone.heldRemoval).toBe(null);
  });

  it("opens and closes 编辑's back sheet, notifying on a change only, and closes it with an emptied album", () => {
    const ui = createMediaUiStore();
    const listener = vi.fn();
    ui.subscribe(listener);
    expect(ui.get().phone.backAsk).toBe(false);
    ui.setBackAsk(false);
    expect(listener).not.toHaveBeenCalled();
    ui.setBackAsk(true);
    ui.setBackAsk(true);
    expect(listener).toHaveBeenCalledOnce();
    expect(ui.get().phone.backAsk).toBe(true);
    ui.setBackAsk(false);
    expect(ui.get().phone.backAsk).toBe(false);

    // Photos still in the album keep it open.
    ui.setCurrentKey("a");
    ui.setBackAsk(true);
    ui.retainPhoneKeys(["a", "b"]);
    expect(ui.get().phone.backAsk).toBe(true);
    ui.retainPhoneKeys(["b"]);
    expect(ui.get().phone).toMatchObject({ currentKey: null, backAsk: true });
    // An emptied album has nothing to go back from.
    ui.retainPhoneKeys([]);
    expect(ui.get().phone).toMatchObject({ currentKey: null, backAsk: false });
  });

  it("keeps the phone edit screen's crop work per item, without notifying", () => {
    const ui = createMediaUiStore();
    const listener = vi.fn();
    ui.subscribe(listener);
    const other: EditDraft = { ...editDraft, rotation: 180 };
    ui.saveCropDraft("a", editDraft);
    ui.saveCropDraft("b", other);
    expect(listener).not.toHaveBeenCalled();
    expect(ui.cropDraftFor("a")).toBe(editDraft);
    expect(ui.cropDraftFor("b")).toBe(other);
    expect(ui.cropDraftFor("c")).toBe(null);

    // Dialog work is separate: a dialog closing keeps the screen's work.
    ui.openDialog({ type: "edit", key: "a" });
    ui.closeDialog();
    expect(ui.cropDraftFor("a")).toBe(editDraft);

    // Work for an item that left the album ends with it.
    ui.retainPhoneKeys(["b"]);
    expect(ui.cropDraftFor("a")).toBe(null);
    expect(ui.cropDraftFor("b")).toBe(other);
  });
});

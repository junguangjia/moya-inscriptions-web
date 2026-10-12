// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";

import { createEditorSessionStore } from "../editor/editor-session-state";
import { startCrop } from "../media/crop-workspace";
import { createMediaUiStore } from "../media/media-ui-store";
import {
  PHONE_MEDIA_TARGET,
  adoptDesktopDialog,
  cancelPhoneLayer,
  draftChanged,
  phoneFocusTarget,
  publishSlideStatus,
  resolvePhoneMedia,
  resumePhone,
  showPhoneField,
  shownPhoneScreen,
  stepBackPhone,
} from "./phone-flow";
import { START_FOCUS } from "./select-screen";

import type { EditorTarget } from "../../../product-shell/product-history";
import type { EditorSessionStore } from "../editor/editor-session-state";
import type { EditDraft, MediaUiStore } from "../media/media-ui-store";
import type { WorkDraftItem } from "@moya/contracts";

const item = (key: string): WorkDraftItem => ({
  key,
  itemId: null,
  kind: "static",
  qualityMode: "standard",
  edit: { rotation: 0, crop: null },
});

/** An editor session with `count` photos, on `step`, and its media UI. */
const session = (
  count: number,
  step: "media" | "text" | "confirm",
  target: EditorTarget = { type: "new" },
) => {
  const store = createEditorSessionStore("account-1", target);
  store.setMedia({
    items: Array.from({ length: count }, (_, index) => item(`p${index + 1}`)),
    coverKey: null,
    coverCrop: null,
  });
  store.setStep(step);
  return { store, ui: createMediaUiStore() };
};

/** The screen the phone shows now, from the store and the media UI. */
const shown = (store: EditorSessionStore, ui: MediaUiStore) =>
  shownPhoneScreen(
    store.get().step,
    store.get().items,
    ui.get().phone.heldRemoval,
  );

describe("shownPhoneScreen", () => {
  const album = [item("a"), item("b")];

  it("shows 发布 off the media step, else 编辑 while a photo is visible, else the start screen", () => {
    expect(shownPhoneScreen("text", album, null)).toBe("publish");
    expect(shownPhoneScreen("confirm", [], null)).toBe("publish");
    expect(shownPhoneScreen("media", album, null)).toBe("edit");
    // An emptied album never shows an empty 编辑.
    expect(shownPhoneScreen("media", [], null)).toBe("select");
  });

  it("counts photos held for 撤销 as not visible", () => {
    // One held, one left: 编辑 shows the other.
    expect(
      shownPhoneScreen("media", album, { keys: ["a"], current: "a" }),
    ).toBe("edit");
    // Every photo held (重新选择照片, or 编辑's last one): the start screen.
    expect(
      shownPhoneScreen("media", album, { keys: ["a", "b"], current: "b" }),
    ).toBe("select");
    expect(
      shownPhoneScreen("text", album, { keys: ["a", "b"], current: "b" }),
    ).toBe("publish");
  });
});

describe("stepBackPhone", () => {
  it("returns from 发布 to 编辑 when the work has photos", () => {
    const { store, ui } = session(2, "text");
    const commit = vi.fn();
    expect(stepBackPhone(store, ui, commit)).toBe(true);
    expect(store.get().step).toBe("media");
    expect(shown(store, ui)).toBe("edit");
    expect(ui.get().phone.backAsk).toBe(false);
    expect(commit).not.toHaveBeenCalled();
  });

  it("returns from 发布 to the start screen without photos", () => {
    const { store, ui } = session(0, "confirm");
    expect(stepBackPhone(store, ui, () => undefined)).toBe(true);
    expect(store.get().step).toBe("media");
    expect(shown(store, ui)).toBe("select");
  });

  it("asks on 编辑 of a work started here, keeping everything as it is", () => {
    const { store, ui } = session(2, "media");
    const commit = vi.fn();
    expect(stepBackPhone(store, ui, commit)).toBe(true);
    expect(ui.get().phone.backAsk).toBe(true);
    // The sheet decides: nothing is committed or left yet.
    expect(commit).not.toHaveBeenCalled();
    expect(shown(store, ui)).toBe("edit");

    // Still the work started here once it gained a draft (r4 ASK-1).
    const drafted = session(1, "media");
    drafted.store.setTarget({ type: "draft", id: "draft-1" });
    expect(stepBackPhone(drafted.store, drafted.ui, commit)).toBe(true);
    expect(drafted.ui.get().phone.backAsk).toBe(true);

    // 参与话题 is a new work too.
    const thread = session(1, "media", { type: "new", threadId: "thread-1" });
    expect(stepBackPhone(thread.store, thread.ui, commit)).toBe(true);
    expect(thread.ui.get().phone.backAsk).toBe(true);
    expect(commit).not.toHaveBeenCalled();
  });

  it("leaves 编辑 of a draft or a work, its crop and removal kept first", () => {
    for (const target of [
      { type: "draft", id: "draft-1" },
      { type: "work", id: "work-1" },
    ] as const) {
      const { store, ui } = session(2, "media", target);
      const commit = vi.fn(() => {
        // Kept while 编辑 is still the screen.
        expect(shown(store, ui)).toBe("edit");
      });
      expect(stepBackPhone(store, ui, commit)).toBe(false);
      expect(commit).toHaveBeenCalledOnce();
      expect(ui.get().phone.backAsk).toBe(false);
      expect(store.get().step).toBe("media");
    }
  });

  it("closes 封面构图 first, on any screen", () => {
    const { store, ui } = session(2, "media");
    ui.openDialog({ type: "cover", key: "p1" });
    const commit = vi.fn();
    expect(stepBackPhone(store, ui, commit)).toBe(true);
    expect(ui.get().dialog).toBe(null);
    expect(ui.get().phone.backAsk).toBe(false);
    expect(commit).not.toHaveBeenCalled();
    // The next Back on 编辑 asks as usual.
    expect(stepBackPhone(store, ui, commit)).toBe(true);
    expect(ui.get().phone.backAsk).toBe(true);
  });

  it("leaves the start screen to the editor's own leave, its held removals committed first", () => {
    const { store, ui } = session(2, "media");
    ui.setHeldRemoval({ keys: ["p1", "p2"], current: "p2" });
    expect(shown(store, ui)).toBe("select");
    // The start screen's commit: the held photos go into the album the
    // leave guard then reads.
    const commit = vi.fn(() => {
      store.setMedia({ ...store.media(), items: [] });
      ui.setHeldRemoval(null);
    });
    expect(stepBackPhone(store, ui, commit)).toBe(false);
    expect(commit).toHaveBeenCalledOnce();
    expect(store.get().items).toEqual([]);
    expect(ui.get().phone.backAsk).toBe(false);
    expect(store.get().step).toBe("media");

    // An empty album leaves at once.
    const empty = session(0, "media");
    expect(stepBackPhone(empty.store, empty.ui, () => undefined)).toBe(false);
  });
});

describe("cancelPhoneLayer", () => {
  it("gives the topmost open phone layer the close request, and says whether one was open", () => {
    const root = document.createElement("div");
    document.body.append(root);
    const cover = document.createElement("dialog");
    cover.setAttribute("open", "");
    const sheet = document.createElement("dialog");
    sheet.setAttribute("open", "");
    // The discard sheet inside 封面构图 comes later: it is on top.
    cover.append(sheet);
    const closed = document.createElement("dialog");
    root.append(closed, cover);
    const requests: string[] = [];
    for (const [name, dialog] of [
      ["closed", closed],
      ["cover", cover],
      ["sheet", sheet],
    ] as const)
      dialog.addEventListener("cancel", (event) => {
        // Not bubbling: each layer hears its own request only.
        if (event.target === dialog) requests.push(name);
        expect(event.cancelable).toBe(true);
      });
    expect(cancelPhoneLayer(root)).toBe(true);
    expect(requests).toEqual(["sheet"]);
    sheet.removeAttribute("open");
    expect(cancelPhoneLayer(root)).toBe(true);
    expect(requests).toEqual(["sheet", "cover"]);
    cover.removeAttribute("open");
    expect(cancelPhoneLayer(root)).toBe(false);
    expect(cancelPhoneLayer(null)).toBe(false);
    root.remove();
  });
});

describe("showPhoneField", () => {
  it("shows media problems on the media step, where the album picks the screen", () => {
    const { store, ui } = session(2, "confirm");
    showPhoneField(store, ui, "media");
    expect(store.get().step).toBe("media");
    expect(shown(store, ui)).toBe("edit");
    expect(ui.get().phone.currentKey).toBe(null);

    const empty = session(0, "text");
    showPhoneField(empty.store, empty.ui, "media");
    expect(shown(empty.store, empty.ui)).toBe("select");
  });

  it("opens the reference sheet at a reference field and shows 发布", () => {
    const { store, ui } = session(0, "media");
    store.setAuthorshipKind("copy_practice");
    showPhoneField(store, ui, "sourceNote");
    expect(store.get().step).toBe("text");
    expect(ui.get().phone.references).toBe("sourceNote");

    // Without references to fill, there is no sheet to open.
    const original = session(0, "media");
    original.store.setAuthorshipKind("original");
    showPhoneField(original.store, original.ui, "referenceTitle");
    expect(original.store.get().step).toBe("text");
    expect(original.ui.get().phone.references).toBe(null);
  });

  it("shows the text fields and general failures on 发布 without the sheet", () => {
    const { store, ui } = session(1, "media");
    showPhoneField(store, ui, "title");
    expect(store.get().step).toBe("text");
    showPhoneField(store, ui, "general");
    expect(store.get().step).toBe("confirm");
    expect(ui.get().phone.references).toBe(null);
  });

  it("names the heading of whichever media screen shows as the focus target", () => {
    for (const name of ["edit", "select"]) {
      document.body.innerHTML = `<div data-editor-screen="${name}"><h2 data-editor-step-heading></h2></div><div data-editor-screen="publish"><h2 data-editor-step-heading></h2></div>`;
      const found = document.querySelectorAll(PHONE_MEDIA_TARGET);
      expect(found).toHaveLength(1);
      expect(found[0]!.parentElement!.getAttribute("data-editor-screen")).toBe(
        name,
      );
    }
    document.body.innerHTML = "";
  });
});

describe("resolvePhoneMedia", () => {
  it("goes to 编辑 at the first photo that needs the author, named for its fix sheet", () => {
    const { store, ui } = session(3, "text");
    ui.setReferences("referenceTitle");
    const failed = (entry: WorkDraftItem) =>
      entry.key === "p2" || entry.key === "p3";
    expect(resolvePhoneMedia(store, ui, failed)).toBe(true);
    expect(store.get().step).toBe("media");
    expect(ui.get().phone).toMatchObject({
      currentKey: "p2",
      attentionKey: "p2",
      references: null,
    });
    expect(shown(store, ui)).toBe("edit");
  });

  it("moves nothing once no photo needs the author", () => {
    const { store, ui } = session(2, "text");
    expect(resolvePhoneMedia(store, ui, () => false)).toBe(false);
    expect(store.get().step).toBe("text");
    expect(ui.get().phone.attentionKey).toBe(null);
    expect(ui.get().phone.currentKey).toBe(null);
  });
});

describe("phoneFocusTarget", () => {
  it("names the neighbour's thumbnail on 编辑, else the start screen's 选择照片", () => {
    expect(phoneFocusTarget({ type: "item", key: "p2" })).toBe(
      '[data-edit-thumb="p2"]',
    );
    expect(phoneFocusTarget({ type: "empty" })).toBe(START_FOCUS);
    expect(START_FOCUS).toBe("[data-media-picker] button");
  });

  it("names a re-selected photo's replacement by its thumbnail", () => {
    const replaced = phoneFocusTarget({ type: "replaced", key: "p3" });
    expect(replaced).toBe('[data-edit-thumb="p3"]');
    document.body.innerHTML = '<button data-edit-thumb="p3"></button>';
    expect(document.querySelector(replaced)).not.toBe(null);
    document.body.innerHTML = "";
  });
});

describe("publishSlideStatus", () => {
  it("draws no chip on a ready photo", () => {
    expect(
      publishSlideStatus({ kind: "ready", label: "已就绪" }, null),
    ).toEqual({ chip: null, statusText: null });
  });

  it("carries 编辑's thumbnail chip to 发布's card and names the status in full", () => {
    expect(
      publishSlideStatus(
        { kind: "uploading", label: "上传中 42%", percent: 42 },
        null,
      ),
    ).toEqual({
      chip: {
        label: "上传中 42%",
        attention: false,
        glyph: { kind: "progress", percent: 42 },
      },
      statusText: "上传中 42%",
    });
    expect(
      publishSlideStatus(
        {
          kind: "failed",
          label: "失败",
          message: "图片处理失败，请移除后重新选择",
          retry: null,
        },
        "processing",
      ),
    ).toEqual({
      chip: { label: "处理失败", attention: true, glyph: { kind: "error" } },
      statusText: "处理失败：图片处理失败，请移除后重新选择",
    });
    expect(
      publishSlideStatus({ kind: "processing", label: "处理中" }, null).chip,
    ).toEqual({
      label: "处理中",
      attention: false,
      glyph: { kind: "loading" },
    });
    // A message that only repeats the chip is said once.
    expect(
      publishSlideStatus(
        { kind: "failed", label: "失败", message: "上传失败", retry: null },
        "upload",
      ).statusText,
    ).toBe("上传失败");
  });
});

describe("resumePhone", () => {
  const none = () => false;
  const failed = (key: string) => (entry: WorkDraftItem) => entry.key === key;

  it("opens a work whose photos are all fine on 发布", () => {
    // A draft, a work or a recovered session: it opens on the media step.
    const { store, ui } = session(2, "media");
    expect(resumePhone(store, ui, none, false)).toBe("publish");
    expect(store.get().step).toBe("text");
    expect(shown(store, ui)).toBe("publish");

    // A kept session left on 编辑 at photo 1 resumes on 发布 as well.
    const kept = session(1, "media");
    kept.ui.setCurrentKey("p1");
    expect(resumePhone(kept.store, kept.ui, none, false)).toBe("publish");
    expect(kept.store.get().step).toBe("text");

    // Text alone is a work to describe too.
    const text = session(0, "media");
    text.store.setTitle("拓片");
    expect(resumePhone(text.store, text.ui, none, false)).toBe("publish");
  });

  it("opens 编辑 at the first photo that needs the author, from any step, with no sheet", () => {
    for (const step of ["media", "text", "confirm"] as const) {
      const { store, ui } = session(3, step);
      expect(resumePhone(store, ui, failed("p2"), false)).toBe("edit");
      expect(store.get().step).toBe("media");
      expect(ui.get().phone.currentKey).toBe("p2");
      // Its stage says what it needs; 前往处理's fix sheet is not opened.
      expect(ui.get().phone.attentionKey).toBe(null);
      expect(shown(store, ui)).toBe("edit");
    }
    // Already there: nothing moved.
    const { store, ui } = session(3, "media");
    ui.setCurrentKey("p2");
    expect(resumePhone(store, ui, failed("p2"), false)).toBe(null);
    expect(ui.get().phone.currentKey).toBe("p2");
  });

  it("leaves an empty work, one still being staged, and 发布 where they are", () => {
    const empty = session(0, "media");
    expect(resumePhone(empty.store, empty.ui, none, false)).toBe(null);
    expect(empty.store.get().step).toBe("media");

    // Photos are still being staged: they go on to 编辑, not 发布.
    const adding = session(2, "media");
    expect(resumePhone(adding.store, adding.ui, none, true)).toBe(null);
    expect(adding.store.get().step).toBe("media");

    const writing = session(2, "text");
    expect(resumePhone(writing.store, writing.ui, none, false)).toBe(null);
    expect(writing.store.get().step).toBe("text");
  });
});

describe("adoptDesktopDialog", () => {
  it("opens the desktop 编辑 dialog's photo on 编辑 with its unfinished crop", () => {
    const { store, ui } = session(3, "text");
    const dialog = { type: "edit", key: "p2" } as const;
    ui.openDialog(dialog);
    const draft = {
      basis: { rotation: 0, crop: null },
      rotation: 0,
      stored: { previewable: true, session: startCrop("1:1", null) },
    } as const;
    ui.saveDraft(dialog, draft);
    adoptDesktopDialog(store, ui);
    expect(ui.get().dialog).toBe(null);
    // The dialog's crop as it opened: 编辑 resumes it, nothing to keep.
    expect(ui.cropDraftFor("p2")).toEqual({ ...draft, explicit: false });
    expect(ui.get().phone.currentKey).toBe("p2");
    expect(store.get().step).toBe("media");
    expect(shown(store, ui)).toBe("edit");
  });

  it("marks a turn or a chosen ratio as the author's change, never the cropper's report", () => {
    const adopt = (draft: EditDraft) => {
      const { store, ui: media } = session(2, "media");
      const dialog = { type: "edit", key: "p1" } as const;
      media.openDialog(dialog);
      media.saveDraft(dialog, draft);
      adoptDesktopDialog(store, media);
      return media.cropDraftFor("p1")?.explicit;
    };
    const basis = { rotation: 0, crop: null } as const;
    // Opened and left alone, whatever the cropper reported.
    expect(
      adopt({
        basis,
        rotation: 0,
        stored: {
          previewable: true,
          session: {
            ...startCrop("original", null),
            area: { x: 0.1, y: 0, width: 0.8, height: 1 },
          },
        },
      }),
    ).toBe(false);
    // Turned in the dialog.
    expect(adopt({ basis, rotation: 90, stored: null })).toBe(true);
    // A ratio chosen (the crop restarted).
    expect(
      adopt({
        basis,
        rotation: 0,
        stored: {
          previewable: true,
          session: { ...startCrop("3:4", null), generation: 1 },
        },
      }),
    ).toBe(true);
    // A drag or zoom of the author's that moved the crop.
    expect(
      adopt({
        basis,
        rotation: 0,
        stored: {
          previewable: true,
          session: {
            ...startCrop("original", null),
            area: { x: 0.1, y: 0, width: 0.8, height: 1 },
            touched: true,
          },
        },
      }),
    ).toBe(true);
  });

  it("counts a touch only when it moved the crop off the photo's own", () => {
    const stored = { x: 0.2, y: 0.1, width: 0.5, height: 0.5 };
    const basis = { rotation: 0, crop: stored } as const;
    const touched = (area: typeof stored | null) =>
      draftChanged({
        basis,
        rotation: 0,
        stored: {
          previewable: true,
          session: { ...startCrop("custom", stored), area, touched: true },
        },
      });
    // The seeded crop re-reported through the cropper's rounding.
    expect(touched({ x: 0.2002, y: 0.1, width: 0.4999, height: 0.5 })).toBe(
      false,
    );
    expect(touched({ x: 0.3, y: 0.1, width: 0.5, height: 0.5 })).toBe(true);
    // Zoomed all the way out: the whole frame.
    expect(touched(null)).toBe(true);
    // Moved but never touched: the cropper's own report.
    expect(
      draftChanged({
        basis,
        rotation: 0,
        stored: {
          previewable: true,
          session: {
            ...startCrop("custom", stored),
            area: { x: 0.3, y: 0.1, width: 0.5, height: 0.5 },
          },
        },
      }),
    ).toBe(false);
  });

  it("keeps the 首图's 封面构图 and ends one for another photo", () => {
    const first = session(2, "media");
    first.ui.openDialog({ type: "cover", key: "p1" });
    adoptDesktopDialog(first.store, first.ui);
    expect(first.ui.get().dialog).toEqual({ type: "cover", key: "p1" });

    const other = session(2, "media");
    other.ui.openDialog({ type: "cover", key: "p2" });
    adoptDesktopDialog(other.store, other.ui);
    expect(other.ui.get().dialog).toBe(null);
    // The album picks the screen: 编辑 at photo 1.
    expect(shown(other.store, other.ui)).toBe("edit");
    expect(other.ui.get().phone.currentKey).toBe(null);
  });

  it("leaves the screens alone without a dialog", () => {
    const { store, ui } = session(2, "text");
    adoptDesktopDialog(store, ui);
    expect(store.get().step).toBe("text");
    expect(ui.get().phone.currentKey).toBe(null);

    // Back on the media step with photos, the album shows 编辑 at photo 1.
    const media = session(2, "media");
    adoptDesktopDialog(media.store, media.ui);
    expect(shown(media.store, media.ui)).toBe("edit");
  });
});

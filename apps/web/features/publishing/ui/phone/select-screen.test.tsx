// @vitest-environment jsdom
import { StrictMode, act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  contentOf,
  createEditorSessionStore,
} from "../editor/editor-session-state";
import { removeItem } from "../media/media-order";
import { SELECTION_UNAVAILABLE } from "../media/use-media-actions";
import {
  chipLabel,
  failureSource,
  needsAttention,
  tileChip,
} from "./photo-tile";
import {
  ORIGINAL_QUALITY_STORAGE_KEY,
  START_FOCUS,
  SelectScreen,
  TOAST_MS,
  TOAST_UNDO_MS,
  readOriginalQuality,
} from "./select-screen";
// @ts-expect-error -- Vite serves the stylesheet's own text for a ?raw import.
import selectCss from "./select-screen.module.css?raw";

import type { StartOptions } from "./add-tiles";
import type { SelectScreenProps } from "./select-screen";
import type { UploadItemView } from "../../upload-manager";
import type { EditorSessionStore } from "../editor/editor-session-state";
import type { HeldRemoval } from "../media/media-ui-store";
import type { ItemStatus } from "../media/media-status";
import type { MediaActions } from "../media/use-media-actions";
import type { PublishingMediaItem, WorkDraftItem } from "@moya/contracts";
import type { Root } from "react-dom/client";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const ACCOUNT = `user-${"a".repeat(32)}`;

/** CSS module class names without the test build's `_name_hash` wrapping. */
const names = (element: Element) =>
  [...element.classList].map((name) =>
    name.replace(/^_(.+)_[0-9a-f]+$/u, "$1"),
  );

const item = (
  key: string,
  overrides: Partial<WorkDraftItem> = {},
): WorkDraftItem => ({
  key,
  itemId: `media-item-${key.padStart(32, "0")}`,
  kind: "static",
  qualityMode: "standard",
  edit: { rotation: 0, crop: null },
  ...overrides,
});

/** Every call the screen makes, in order, across the fakes. */
let calls: string[] = [];

/** The flow's media actions, over a real editor session store. */
const fakeMedia = (store: EditorSessionStore) => {
  const fields = {
    maxItems: 50,
    canSelect: true,
    staging: null as MediaActions["staging"],
    notice: null as string | null,
  };
  const actions = {
    ui: { setNotice: vi.fn() },
    announce: vi.fn((text: string) => calls.push(`announce:${text}`)),
    // One album edit for the batch, as the flow's media actions make it.
    removeMany: vi.fn((keys: readonly string[]) => {
      calls.push(`remove:${keys.join(",")}`);
      let value = store.media();
      for (const key of keys) value = removeItem(value, key).value;
      store.setMedia(value);
    }),
  };
  return {
    fields,
    actions,
    current: () =>
      ({
        ...actions,
        ...fields,
        value: store.media(),
      }) as unknown as MediaActions,
  };
};

let container: HTMLDivElement;
let root: Root;
let store: EditorSessionStore;
let media: ReturnType<typeof fakeMedia>;
let props: Omit<SelectScreenProps, "editor" | "media">;

const album = (...keys: string[]) =>
  store.setMedia({
    items: keys.map((key) => item(key)),
    coverKey: null,
    coverCrop: null,
  });
const order = () => store.media().items.map((entry) => entry.key);

/** Renders with the store's current state, as the flow would. */
const render = async (overrides: Partial<SelectScreenProps> = {}) => {
  props = { ...props, ...overrides };
  const state = store.get();
  await act(async () =>
    root.render(
      <SelectScreen
        {...props}
        editor={{ state, content: contentOf(state), actions: store }}
        media={media.current()}
      />,
    ),
  );
};

/** Clicks, then shows the store's new state like the flow's next render. */
const click = async (element: Element | null) => {
  expect(element).not.toBe(null);
  await act(async () => (element as HTMLElement).click());
  await render();
};

/** Lets time pass for the toasts (fake timers), then renders the store. */
const wait = async (ms: number) => {
  await act(async () => vi.advanceTimersByTime(ms));
  await render();
};

const button = (text: string, scope: ParentNode = container) =>
  [...scope.querySelectorAll("button")].find(
    (entry) => entry.textContent === text,
  ) ?? null;
const option = (name: "photos" | "camera" | "topic") =>
  container.querySelector<HTMLButtonElement>(`[data-start-option="${name}"]`);
const drafts = () =>
  container.querySelector<HTMLButtonElement>("[data-start-drafts]");
const skip = () =>
  container.querySelector<HTMLButtonElement>("[data-media-skip]");
const back = () =>
  container.querySelector<HTMLButtonElement>(
    '[data-editor-bar] [aria-label="返回"]',
  )!;
const toast = () => container.querySelector("[data-select-toast]");
const caption = () => container.querySelector("[data-select-count]");
const pickInput = () =>
  container.querySelector<HTMLInputElement>(
    '[data-media-picker] input[type="file"][multiple]',
  )!;

/** Hands `files` to `input` as a finished pick. */
const pick = async (input: HTMLInputElement, files: File[]) => {
  Object.defineProperty(input, "files", { configurable: true, value: files });
  await act(async () =>
    input.dispatchEvent(new Event("change", { bubbles: true })),
  );
};

/** A pointer that is (or is not) coarse: 拍照 is drawn only on phones. */
const coarsePointer = () =>
  vi.stubGlobal(
    "matchMedia",
    vi.fn(() => ({
      matches: true,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    })) as unknown as typeof window.matchMedia,
  );

/** 专题 and 草稿箱 as the overlay gives them on an untouched new work. */
const startOptions = (
  topic: Partial<StartOptions["topic"]> = {},
): StartOptions => ({
  topic: {
    busy: false,
    disabled: false,
    retry: false,
    notice: null,
    onCreate: vi.fn(),
    ...topic,
  },
  onOpenDrafts: vi.fn(),
});

beforeEach(() => {
  calls = [];
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  store = createEditorSessionStore(ACCOUNT, { type: "new" });
  media = fakeMedia(store);
  props = {
    title: "发布作品",
    onClose: vi.fn(() => calls.push("close")),
    onSkipToText: vi.fn(() => calls.push("skip")),
    onAddFiles: vi.fn(() => calls.push("add")),
    onHeldUndo: vi.fn(() => calls.push("undo")),
    onHeldCommitted: vi.fn(() => calls.push("committed")),
  };
  Object.defineProperty(HTMLDialogElement.prototype, "showModal", {
    configurable: true,
    value(this: HTMLDialogElement) {
      this.open = true;
    },
  });
  Object.defineProperty(HTMLDialogElement.prototype, "close", {
    configurable: true,
    value(this: HTMLDialogElement) {
      this.open = false;
    },
  });
  window.localStorage.clear();
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  document.body.replaceChildren();
  window.localStorage.clear();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("SelectScreen (the start screen)", () => {
  it("draws the bar with its caption, the tiles and the skip, and only 原图画质 below", async () => {
    await render();
    const screen = container.querySelector("[data-editor-screen]")!;
    expect(screen.getAttribute("data-editor-screen")).toBe("select");
    expect(screen.querySelector("h2")!.textContent).toBe("发布作品");
    const bar = screen.querySelector("[data-editor-bar]")!;
    expect(caption()!.textContent).toBe("选择照片 · 最多 50 项");
    expect(names(caption()!)).toEqual(["caption"]);
    expect(bar.contains(caption())).toBe(true);
    await click(back());
    expect(props.onClose).toHaveBeenCalledOnce();
    expect(back().hasAttribute("aria-disabled")).toBe(false);
    // No 草稿箱 without the start options: the bar keeps its spacer.
    expect(drafts()).toBe(null);
    // Only 原图画质 below (D18): no 下一步, no +, no bar camera.
    const footer = container.querySelector("[data-editor-footer]")!;
    expect(footer.children).toHaveLength(1);
    expect(footer.firstElementChild!.getAttribute("data-editor-switch")).toBe(
      "original",
    );
    expect(footer.querySelectorAll("button")).toHaveLength(1);

    const picker = container.querySelector("[data-media-picker]")!;
    expect(names(picker)).toEqual(["empty"]);
    const choose = option("photos")!;
    expect(choose.textContent).toBe("选择照片");
    expect(names(choose)).toEqual(["pickBtn"]);
    expect(choose.hasAttribute("data-editor-autofocus")).toBe(true);
    expect(choose.querySelector('[data-icon="image"]')).not.toBe(null);
    expect(option("topic")).toBe(null);
    // 拍照 only where the pointer is coarse (jsdom has no matchMedia).
    expect(option("camera")).toBe(null);
    expect(picker.textContent).toContain("可一次选择多张，本次上传静态照片。");
    expect(container.querySelector(START_FOCUS)).toBe(choose);
    expect(START_FOCUS).toBe("[data-media-picker] button");

    expect(skip()!.textContent).toBe("跳过，只发布文字");
    expect(names(skip()!)).toEqual(["skipBtn"]);
    await click(skip());
    expect(props.onSkipToText).toHaveBeenCalledOnce();
  });

  it("says 参与话题's own limit", async () => {
    media.fields.maxItems = 3;
    await render({ title: "参与话题" });
    expect(caption()!.textContent).toBe("选择照片 · 最多 3 项");
  });

  it("puts the save status in place of the caption", async () => {
    await render({
      saveStatus: <span data-save-status="error">保存失败</span>,
    });
    const bar = container.querySelector("[data-editor-bar]")!;
    expect(caption()).toBe(null);
    expect(bar.querySelector("[data-save-status]")!.textContent).toBe(
      "保存失败",
    );
  });

  it("opens the album from 选择照片 inside its own tap, and hands the pick on", async () => {
    await render();
    const input = pickInput();
    expect(input.multiple).toBe(true);
    expect(input.accept).toContain("image/heic");
    const clicked: HTMLInputElement[] = [];
    vi.spyOn(HTMLInputElement.prototype, "click").mockImplementation(function (
      this: HTMLInputElement,
    ) {
      clicked.push(this);
    });
    act(() => {
      option("photos")!.click();
      // Synchronously, inside the tap: iOS opens the album only then.
      expect(clicked).toEqual([input]);
    });
    const file = new File(["x"], "a.jpg", { type: "image/jpeg" });
    await pick(input, [file]);
    expect(props.onAddFiles).toHaveBeenCalledWith([file], "picker");
  });

  it("offers 拍照 on a phone, its capture input clicked inside its tap too", async () => {
    coarsePointer();
    await render();
    const picker = container.querySelector("[data-media-picker]")!;
    expect(
      [...picker.querySelectorAll("button")].map((entry) => entry.textContent),
    ).toEqual(["选择照片", "拍照", "跳过，只发布文字"]);
    const camera = option("camera")!;
    expect(camera.querySelector('svg[data-glyph="camera"]')).not.toBe(null);
    const input = picker.querySelector<HTMLInputElement>(
      'input[capture="environment"]',
    )!;
    expect(input.multiple).toBe(false);
    const clicked: HTMLInputElement[] = [];
    vi.spyOn(HTMLInputElement.prototype, "click").mockImplementation(function (
      this: HTMLInputElement,
    ) {
      clicked.push(this);
    });
    act(() => {
      camera.click();
      expect(clicked).toEqual([input]);
    });
    const file = new File(["x"], "c.jpg", { type: "image/jpeg" });
    await pick(input, [file]);
    expect(props.onAddFiles).toHaveBeenCalledWith([file], "picker");
  });

  describe("专题 and 草稿箱", () => {
    it("draws 专题 with the 专题 tab's icon only with the start options", async () => {
      coarsePointer();
      const start = startOptions();
      await render({ start });
      const topic = option("topic")!;
      expect(topic.textContent).toBe("专题");
      expect(names(topic)).toEqual(["pickBtn"]);
      expect(topic.querySelector('[data-icon="academic-cap"]')).not.toBe(null);
      expect(
        document.getElementById(topic.getAttribute("aria-describedby")!)!
          .textContent,
      ).toBe("新建一篇专题文章草稿，并打开文章编辑");
      expect(topic.hasAttribute("aria-busy")).toBe(false);
      // One row of three equal tiles.
      const row = topic.parentElement!;
      expect(names(row)).toEqual(["pickRow"]);
      expect(
        [...row.children].map((tile) => tile.getAttribute("data-start-option")),
      ).toEqual(["photos", "camera", "topic"]);
      await click(topic);
      expect(start.topic.onCreate).toHaveBeenCalledOnce();

      await render({ start: null });
      expect(option("topic")).toBe(null);
      expect(drafts()).toBe(null);
    });

    it("holds everything while 专题 creates: 正在创建…, the other controls wait, ‹ is held", async () => {
      coarsePointer();
      const start = startOptions();
      await render({ start });
      // The tap that starts it leaves focus on 专题, which keeps it as it
      // turns busy (r4 review: never a native disabled under focus).
      await act(async () => option("topic")!.focus());
      await render({
        start: { ...start, topic: { ...start.topic, busy: true } },
      });
      const topic = option("topic")!;
      expect(document.activeElement).toBe(topic);
      expect(topic.textContent).toBe("正在创建…");
      expect(topic.getAttribute("aria-disabled")).toBe("true");
      expect(topic.disabled).toBe(false);
      expect(topic.getAttribute("aria-busy")).toBe("true");
      for (const tile of [option("photos")!, option("camera")!, drafts()!]) {
        expect(tile.getAttribute("aria-disabled")).toBe("true");
        expect(tile.disabled).toBe(false);
      }
      // A waiting tile ignores a tap: no second create, no picker, no 草稿箱.
      const opened = vi
        .spyOn(HTMLInputElement.prototype, "click")
        .mockImplementation(() => undefined);
      await click(topic);
      await click(option("photos"));
      await click(option("camera"));
      await click(drafts());
      expect(start.topic.onCreate).not.toHaveBeenCalled();
      expect(opened).not.toHaveBeenCalled();
      expect(start.onOpenDrafts).not.toHaveBeenCalled();
      expect(skip()!.disabled).toBe(true);
      // ‹ stays focusable and named, but does nothing.
      expect(back().getAttribute("aria-disabled")).toBe("true");
      expect(back().disabled).toBe(false);
      await click(back());
      expect(props.onClose).not.toHaveBeenCalled();
    });

    it("offers the same create again after an unknown outcome, and says why as an alert", async () => {
      await render({
        start: startOptions({
          retry: true,
          notice: "创建结果尚未确认，重试会确认同一次创建。",
        }),
      });
      expect(option("topic")!.textContent).toBe("重试确认创建");
      const notice = container.querySelector("[data-start-topic-notice]")!;
      expect(notice.getAttribute("role")).toBe("alert");
      expect(notice.textContent).toBe(
        "创建结果尚未确认，重试会确认同一次创建。",
      );
      expect(names(notice)).toEqual(["pickHint"]);
    });

    it("keeps 专题 apart from the photo session, and waits for the account check", async () => {
      media.fields.canSelect = false;
      await render({ start: startOptions() });
      expect(option("photos")!.disabled).toBe(true);
      expect(
        container.querySelector("[data-media-picker]")!.textContent,
      ).toContain(SELECTION_UNAVAILABLE);
      // An article, not a photo: no upload session needed.
      expect(option("topic")!.disabled).toBe(false);
      expect(option("topic")!.hasAttribute("aria-disabled")).toBe(false);
      expect(drafts()!.hasAttribute("aria-disabled")).toBe(false);

      // The account is being checked (the dialog's 专题文章 rule).
      await render({ start: startOptions({ disabled: true }) });
      expect(option("topic")!.disabled).toBe(true);
    });

    it("draws 草稿箱 at the bar's end only with its route, and opens it", async () => {
      const start = startOptions();
      await render({ start });
      const open = drafts()!;
      expect(open.textContent).toBe("草稿箱");
      expect(names(open)).toEqual(["textButton", "waitingButton"]);
      expect(open.hasAttribute("aria-disabled")).toBe(false);
      expect(container.querySelector("[data-editor-bar]")!.contains(open)).toBe(
        true,
      );
      await click(open);
      expect(start.onOpenDrafts).toHaveBeenCalledOnce();

      await render({ start: { ...startOptions(), onOpenDrafts: undefined } });
      expect(drafts()).toBe(null);
      expect(option("topic")).not.toBe(null);
    });
  });

  it("keeps the row's tiles in place while photos are read, all waiting, and hides 跳过", async () => {
    coarsePointer();
    await render({ start: startOptions() });
    const status = container.querySelector(
      '[data-select-body] > p[role="status"]',
    )!;
    expect(status.textContent).toBe("");
    // The pick that starts the reading leaves focus on 选择照片.
    await act(async () => option("photos")!.focus());
    media.fields.staging = { identifying: 2 } as MediaActions["staging"];
    await render();
    // One live region: only its words change.
    expect(
      container.querySelector('[data-select-body] > p[role="status"]'),
    ).toBe(status);
    expect(status.textContent).toBe("正在读取照片…");
    const row = container.querySelector("[data-media-picker] > div")!;
    expect(row.getAttribute("aria-busy")).toBe("true");
    // Each waits with `aria-disabled`, so 选择照片 keeps focus.
    expect(
      [...row.querySelectorAll("button")].map((tile) => [
        tile.getAttribute("data-start-option"),
        tile.getAttribute("aria-disabled"),
        tile.disabled,
      ]),
    ).toEqual([
      ["photos", "true", false],
      ["camera", "true", false],
      ["topic", "true", false],
    ]);
    expect(document.activeElement).toBe(option("photos"));
    const opened = vi
      .spyOn(HTMLInputElement.prototype, "click")
      .mockImplementation(() => undefined);
    await click(option("photos"));
    expect(opened).not.toHaveBeenCalled();
    expect(drafts()!.getAttribute("aria-disabled")).toBe("true");
    expect(skip()).toBe(null);
  });

  it("shows the editor's notices and the media notice until it is dismissed", async () => {
    media.fields.notice = "封面构图已恢复为完整画面";
    await render({
      notices: <p data-editor-notice="">已恢复本机未完成的编辑</p>,
    });
    expect(container.querySelector("[data-editor-notice]")!.textContent).toBe(
      "已恢复本机未完成的编辑",
    );
    const notice = container.querySelector("[data-media-notice]")!;
    expect(notice.textContent).toContain("封面构图已恢复为完整画面");
    await click(button("知道了", notice));
    expect(media.actions.ui.setNotice).toHaveBeenCalledWith(null);
  });

  describe("held removals", () => {
    beforeEach(() => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    });

    const hold = (keys: string[], current: string | null = keys[0]!) => {
      const held: HeldRemoval = { keys, current };
      return held;
    };

    it("offers 撤销 for 编辑's last photo from the first render, focused on 选择照片", async () => {
      album("a");
      await render({ heldRemoval: hold(["a"]), start: startOptions() });
      expect(toast()!.textContent).toBe("已移除第 1 项撤销");
      expect(toast()!.hasAttribute("data-action")).toBe(true);
      expect(toast()!.parentElement!.getAttribute("role")).toBe("status");
      expect(document.activeElement).toBe(option("photos"));
      // Nothing is cleared or removed at mount (H3).
      expect(props.onHeldCommitted).not.toHaveBeenCalled();
      expect(media.actions.removeMany).not.toHaveBeenCalled();
      expect(order()).toEqual(["a"]);

      await click(button("撤销", toast()!));
      expect(props.onHeldUndo).toHaveBeenCalledOnce();
      expect(toast()).toBe(null);
      // The flow then shows 编辑; nothing is ever removed.
      await render({ heldRemoval: null });
      await wait(TOAST_UNDO_MS + 220);
      expect(media.actions.removeMany).not.toHaveBeenCalled();
      expect(props.onHeldCommitted).not.toHaveBeenCalled();
    });

    it("says how many 重新选择照片 took away", async () => {
      album("a", "b", "c");
      await render({ heldRemoval: hold(["a", "b", "c"], "b") });
      expect(toast()!.textContent).toBe("已移除 3 项撤销");
    });

    it("removes every held photo once 撤销 is no longer offered, then lets the record go", async () => {
      album("a", "b", "c");
      await render({ heldRemoval: hold(["a", "b", "c"], "b") });
      await wait(TOAST_UNDO_MS - 1);
      expect(media.actions.removeMany).not.toHaveBeenCalled();
      await wait(1);
      expect(calls).toEqual(["remove:a,b,c", "committed"]);
      expect(order()).toEqual([]);
      await wait(220);
      expect(toast()).toBe(null);
    });

    it("commits 重新选择照片's photos in one album edit, a chosen cover among them", async () => {
      store.setMedia({
        items: ["a", "b", "c"].map((key) => item(key)),
        coverKey: "a",
        coverCrop: { x: 0, y: 0, width: 0.5, height: 0.5 },
      });
      await render({ heldRemoval: hold(["a", "b", "c"], "b") });
      await wait(TOAST_UNDO_MS);
      // One removal for the batch: what it says (the cover gone) is worked
      // out once on the emptied album, never photo by photo.
      expect(media.actions.removeMany).toHaveBeenCalledExactlyOnceWith([
        "a",
        "b",
        "c",
      ]);
      expect(calls).toEqual(["remove:a,b,c", "committed"]);
      expect(store.media()).toEqual({
        items: [],
        coverKey: null,
        coverCrop: null,
      });
    });

    it("keeps the held photos and their 撤销 when 原图画质 changes, and says the switch", async () => {
      album("a", "b", "c");
      await render({ heldRemoval: hold(["a", "b", "c"], "b") });
      await click(
        container.querySelector<HTMLButtonElement>('[role="switch"]'),
      );
      expect(store.get().originalNext).toBe(true);
      // Not a commit: nothing removed, the record kept, the toast unchanged.
      expect(media.actions.removeMany).not.toHaveBeenCalled();
      expect(props.onHeldCommitted).not.toHaveBeenCalled();
      expect(toast()!.textContent).toBe("已移除 3 项撤销");
      // Said through the flow's announcer instead of a toast.
      expect(calls).toEqual(["announce:原图画质已打开"]);
      await click(button("撤销", toast()!));
      expect(props.onHeldUndo).toHaveBeenCalledOnce();
      expect(order()).toEqual(["a", "b", "c"]);
      // With nothing held, the switch has its toast again.
      await render({ heldRemoval: null });
      await click(
        container.querySelector<HTMLButtonElement>('[role="switch"]'),
      );
      expect(toast()!.textContent).toBe("原图画质已关闭");
      expect(media.actions.removeMany).not.toHaveBeenCalled();
    });

    it("commits them first on a pick, on ‹ and on 跳过", async () => {
      album("a");
      await render({ heldRemoval: hold(["a"]) });
      await pick(pickInput(), [
        new File(["x"], "b.jpg", { type: "image/jpeg" }),
      ]);
      expect(calls).toEqual(["remove:a", "committed", "add"]);
      // Its 撤销 went with it.
      await render({ heldRemoval: null });
      expect(toast()).toBe(null);

      for (const leave of [back, skip] as const) {
        calls = [];
        album("b");
        await act(async () => root.unmount());
        root = createRoot(container);
        await render({ heldRemoval: hold(["b"]) });
        await click(leave());
        expect(calls).toEqual([
          "remove:b",
          "committed",
          leave === back ? "close" : "skip",
        ]);
      }
    });

    it("commits them when photos start to be staged some other way (a paste, a drop)", async () => {
      album("a", "b");
      await render({ heldRemoval: hold(["a", "b"]) });
      expect(media.actions.removeMany).not.toHaveBeenCalled();
      media.fields.staging = { identifying: 1 } as MediaActions["staging"];
      await render();
      // Before the batch is added: 编辑 never shows a held photo beside it.
      expect(calls).toEqual(["remove:a,b", "committed"]);
      expect(order()).toEqual([]);
    });

    it("lets 专题 and 草稿箱 wait while photos are held", async () => {
      album("a");
      await render({ heldRemoval: hold(["a"]), start: startOptions() });
      expect(option("topic")!.getAttribute("aria-disabled")).toBe("true");
      expect(drafts()!.getAttribute("aria-disabled")).toBe("true");
      // The photo tiles stay: a pick commits the held ones first.
      expect(option("photos")!.hasAttribute("aria-disabled")).toBe(false);
      expect(option("photos")!.disabled).toBe(false);
      expect(skip()!.disabled).toBe(false);
      await wait(TOAST_UNDO_MS);
      expect(props.onHeldCommitted).toHaveBeenCalledOnce();
      await render({ heldRemoval: null });
      expect(option("topic")!.hasAttribute("aria-disabled")).toBe(false);
      expect(drafts()!.hasAttribute("aria-disabled")).toBe(false);
    });

    it("hands the commit to the editor's Back", async () => {
      const commitRef: { current: (() => void) | null } = { current: null };
      album("a");
      await render({ commitRef });
      expect(commitRef.current).toBeTypeOf("function");
      // Nothing held: the commit does nothing.
      await act(async () => commitRef.current!());
      expect(calls).toEqual([]);

      await act(async () => root.unmount());
      root = createRoot(container);
      await render({ commitRef, heldRemoval: hold(["a"]) });
      await act(async () => commitRef.current!());
      expect(calls).toEqual(["remove:a", "committed"]);
      await render({ heldRemoval: null });
      expect(toast()).toBe(null);

      await act(async () => root.unmount());
      expect(commitRef.current).toBe(null);
      root = createRoot(container);
    });

    it("commits them when the screen goes, the development double mount included", async () => {
      album("a");
      await act(async () =>
        root.render(
          <StrictMode>
            <SelectScreen
              {...props}
              editor={{
                state: store.get(),
                content: contentOf(store.get()),
                actions: store,
              }}
              heldRemoval={hold(["a"])}
              media={media.current()}
            />
          </StrictMode>,
        ),
      );
      // The double mount's cleanup ends nothing, and 撤销 is offered once.
      expect(media.actions.removeMany).not.toHaveBeenCalled();
      expect(toast()!.textContent).toBe("已移除第 1 项撤销");
      await act(async () => root.unmount());
      expect(calls).toEqual(["remove:a", "committed"]);
      root = createRoot(container);
    });

    it("holds 撤销 while focus is on it, then lets the rest of its time run", async () => {
      album("a");
      await render({ heldRemoval: hold(["a"]) });
      await act(async () => button("撤销", toast()!)!.focus());
      await wait(TOAST_UNDO_MS * 3);
      expect(media.actions.removeMany).not.toHaveBeenCalled();
      expect(button("撤销", toast()!)).not.toBe(null);
      await act(async () => option("photos")!.focus());
      await wait(TOAST_UNDO_MS);
      expect(media.actions.removeMany).toHaveBeenCalledExactlyOnceWith(["a"]);
      // Its fade lets taps through, and focus never stays on it as it goes.
      expect(toast()!.hasAttribute("data-out")).toBe(true);
      await wait(220);
      expect(toast()).toBe(null);
    });

    it("moves focus to the heading when 撤销 leaves while focused", async () => {
      album("a");
      await render({ heldRemoval: hold(["a"]) });
      await wait(TOAST_UNDO_MS);
      // Focus arrives during the fade: the heading takes it as the toast goes.
      await act(async () => button("撤销", toast()!)!.focus());
      await wait(220);
      expect(toast()).toBe(null);
      expect(document.activeElement).toBe(
        container.querySelector("[data-editor-step-heading]"),
      );
    });
  });

  describe("原图画质", () => {
    const toggle = () =>
      container.querySelector<HTMLButtonElement>('[role="switch"]')!;

    it("is the editor's switch with a visible scope and the full description", async () => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      await render();
      const control = toggle();
      expect(names(control)).toEqual(["switch"]);
      expect(control.getAttribute("aria-checked")).toBe("false");
      const label = document.getElementById(
        control.getAttribute("aria-labelledby")!,
      )!;
      expect(label.textContent).toBe("原图画质");
      expect(label.nextElementSibling!.textContent).toBe(
        "仅对之后选择的照片生效",
      );
      expect(label.nextElementSibling!.getAttribute("aria-hidden")).toBe(
        "true",
      );
      const description = document.getElementById(
        control.getAttribute("aria-describedby")!,
      )!;
      expect(names(description)).toEqual(["visuallyHidden"]);
      expect(description.textContent).toBe(
        "下一批选择的图片先优化为标准画质再上传",
      );

      // One toggle per tap on the switch (its click reaches the block once).
      await click(control);
      expect(store.get().originalNext).toBe(true);
      expect(toggle().getAttribute("aria-checked")).toBe("true");
      expect(toast()!.textContent).toBe("原图画质已打开");
      expect(window.localStorage.getItem(ORIGINAL_QUALITY_STORAGE_KEY)).toBe(
        "original",
      );
      expect(readOriginalQuality()).toBe(true);
      expect(
        document.getElementById(toggle().getAttribute("aria-describedby")!)!
          .textContent,
      ).toBe("下一批选择的图片按原文件上传，不压缩");

      // A tap on its words toggles too.
      await click(label);
      expect(store.get().originalNext).toBe(false);
      expect(toast()!.textContent).toBe("原图画质已关闭");
      await wait(TOAST_MS);
      expect(toast()!.hasAttribute("data-out")).toBe(true);
      await wait(220);
      expect(toast()).toBe(null);
    });

    it("starts from the device's last choice, also after a batch reset it", async () => {
      window.localStorage.setItem(ORIGINAL_QUALITY_STORAGE_KEY, "original");
      await render();
      expect(store.get().originalNext).toBe(true);
      await render();
      // Staging a batch turns it off; the remembered choice comes back.
      await act(async () => store.setOriginalNext(false));
      await render();
      expect(store.get().originalNext).toBe(true);
    });

    it("works without storage", async () => {
      vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
        throw new Error("blocked");
      });
      vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
        throw new Error("blocked");
      });
      expect(readOriginalQuality()).toBe(null);
      await render();
      await click(toggle());
      expect(store.get().originalNext).toBe(true);
    });
  });
});

describe("photo status helpers", () => {
  const READY: ItemStatus = { kind: "ready", label: "已就绪" };
  const failed: ItemStatus = {
    kind: "failed",
    label: "失败",
    message: "上传失败",
    retry: null,
  };

  it("tells the three failures apart", () => {
    const view = (phase: UploadItemView["phase"]) =>
      ({ phase }) as UploadItemView;
    const server = (state: PublishingMediaItem["state"]) =>
      ({ state }) as PublishingMediaItem;
    expect(failureSource(READY, undefined, undefined)).toBe(null);
    expect(failureSource(failed, view("failed"), undefined)).toBe("upload");
    expect(failureSource(failed, view("ready"), undefined)).toBe("edit");
    expect(failureSource(failed, undefined, server("failed"))).toBe(
      "processing",
    );
    expect(failureSource(failed, undefined, server("ready"))).toBe("edit");
    expect(chipLabel(failed, "upload")).toBe("上传失败");
    expect(chipLabel(failed, "processing")).toBe("处理失败");
    expect(chipLabel(failed, "edit")).toBe("处理失败");
  });

  it("shortens only the labels the spec shortens, and drops the ready one", () => {
    const label = (status: ItemStatus) => chipLabel(status, null);
    expect(label({ kind: "uploaded", label: "已上传，等待处理" })).toBe(
      "等待处理",
    );
    expect(
      label({ kind: "missing_local", label: "缺少本地文件", message: "" }),
    ).toBe("缺少文件");
    for (const status of [
      { kind: "loading", label: "正在读取" },
      { kind: "preparing", label: "准备中" },
      { kind: "queued", label: "等待上传" },
      { kind: "processing", label: "处理中" },
      { kind: "ready", label: "已就绪" },
      { kind: "paused", label: "已暂停", message: null },
      { kind: "needs_choice", label: "需要选择", message: "" },
      { kind: "unavailable", label: "无法读取", message: "" },
      { kind: "removing", label: "已不可用" },
    ] as const)
      expect(label(status)).toBe(status.label);
    expect(tileChip(READY, null)).toBe(null);
    expect(tileChip({ kind: "queued", label: "等待上传" }, null)).toBe(
      "等待上传",
    );
  });

  it("asks the author only in the attention states", () => {
    expect(needsAttention(READY)).toBe(false);
    expect(needsAttention({ kind: "removing", label: "正在移除" })).toBe(false);
    expect(needsAttention(failed)).toBe(true);
    expect(
      needsAttention({ kind: "paused", label: "已暂停", message: null }),
    ).toBe(true);
  });
});

describe("select-screen.module.css", () => {
  const css = (selectCss as string).replace(/\/\*[\s\S]*?\*\//g, "");
  const rule = (selector: string) => {
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`(?:^|\\n|\\})\\s*${escaped}\\s*\\{([^}]*)\\}`).exec(
      css,
    )?.[1];
  };

  it("declares tokens, and literals only for sizes, line heights and the toast's layer", () => {
    expect(css).not.toMatch(/#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(/i);
    const values = [...css.matchAll(/:\s*([^;{}]+);/g)].map((match) =>
      match[1]!
        .replace(/var\(--yoyi-[a-z0-9-]+\)/g, "T")
        .replace(
          /var\(--editor-bottom-safe-area, env\(safe-area-inset-bottom\)\)/g,
          "S",
        )
        .replace(/var\(--editor-viewport-(?:top, 0|height, 100%)\)/g, "V")
        .replace(/env\(safe-area-inset-[a-z]+\)/g, "E")
        .replace(/\s+/g, " ")
        .replace(/\( /g, "(")
        .replace(/ \)/g, ")")
        .trim(),
    );
    for (const value of values)
      expect(value).toMatch(
        /^(T|S|V|0|1|60|1\.4|1\.45|1\.7|-2px|2px|3px|4px|5px|16px|28px|36px|44px|52px|132px|50%|100%|600|650|none|auto|grid|flex|block|inline-flex|column|relative|absolute|fixed|center|left|transparent|inherit|pointer|not-allowed|nowrap|hidden|ellipsis|underline|border-box|tabular-nums|contain|cover|"",?|content|0 T|T T|T 0|T T T|0 T T|T T 0|T T T T|T T 0 0|1 1 auto|1 0 auto|0 0 auto|translate\(-50%, -50%\)|translateY\(4px\)|minmax\(0, 1fr\)|calc\(100% - E - T\)|calc\(S \+ 2 \* T \+ 44px \+ T\)|T 0 calc\(S \+ T\)|T max\(T, E\) T max\(T, E\)|0 max\(T, E\)|0 max\(T, E\) T max\(T, E\)|0 max\(T, E\) 0 max\(T, E\)|T max\(T, E\) 0 max\(T, E\)|0 auto T|2px solid T|1px solid T|opacity T T|(rise|fade) T T)$/,
      );
  });

  it("keeps no rule of the removed photo grid", () => {
    for (const gone of [
      ".grid",
      ".cell",
      ".tile",
      ".badges",
      ".ord",
      ".chipSt",
      ".prog",
      ".addTile",
      ".gridHint",
      ".circleBtn",
      ".barIcon",
    ])
      expect(css).not.toMatch(
        new RegExp(`${gone.replace(".", "\\.")}(?![A-Za-z-])`),
      );
  });

  it("draws no boxed, dashed controls", () => {
    expect(css).not.toMatch(/dashed/);
    expect(rule(".pickBtn")).toMatch(/border:\s*0/);
  });

  it("keeps every chip over photos opaque, and the remedy in ink", () => {
    expect(rule(".tileChip")).toMatch(
      /background:\s*var\(--yoyi-color-background-inverse\)/,
    );
    expect(rule(".inkBtn")).not.toMatch(/seal-red/);
  });

  it("stands every bottom sheet in the visual viewport, its rows clear of the side safe areas", () => {
    // The editor host's frame (useVisualViewportFrame): the keyboard
    // shortens the dialog, so the sheet sits on it, not under it.
    const host = rule(".sheetHost")!;
    expect(host).toMatch(/top:\s*var\(--editor-viewport-top, 0\);/);
    expect(host).toMatch(/bottom:\s*auto;/);
    expect(host).toMatch(/height:\s*var\(--editor-viewport-height, 100%\);/);
    expect(host).not.toMatch(/inset:/);
    expect(rule(".sheet")).toMatch(/bottom:\s*0;/);
    // Each row's side inset is its own or the safe area, whichever is wider.
    for (const selector of [".shHead", ".shDesc", ".shRow", ".shActions"]) {
      const padding = /padding:\s*([^;]+);/.exec(rule(selector)!)![1]!;
      expect(padding).toMatch(
        /max\(var\(--yoyi-space-\d\), env\(safe-area-inset-right\)\)[\s\S]*max\(var\(--yoyi-space-\d\), env\(safe-area-inset-left\)\)$/,
      );
    }
  });

  it("draws 发布's 参考作品 sheet in mockup A's idiom: a grab bar over a flush header", () => {
    const grab = rule(
      '.sheetHost[data-phone-sheet="references"] .sheet::before',
    )!;
    expect(grab).toMatch(/width:\s*36px;/);
    expect(grab).toMatch(/height:\s*5px;/);
    expect(grab).toMatch(/margin:\s*0 auto var\(--yoyi-space-4\);/);
    expect(grab).toMatch(/background:\s*var\(--yoyi-color-border-default\);/);
    expect(grab).toMatch(/border-radius:\s*var\(--yoyi-radius-full\);/);
    expect(rule('.sheetHost[data-phone-sheet="references"] .shHead')).toMatch(
      /padding:\s*0 max\(var\(--yoyi-space-6\), env\(safe-area-inset-right\)\)\s+var\(--yoyi-space-4\) max\(var\(--yoyi-space-6\), env\(safe-area-inset-left\)\);/,
    );
  });

  it("stills every movement under reduced motion", () => {
    const reduced =
      /@media \(prefers-reduced-motion: reduce\)\s*\{([\s\S]*)\}\s*$/.exec(
        css.trim(),
      )![1]!;
    expect(reduced).toMatch(/\.toast\[data-out\]\s*\{\s*transition:\s*none;/);
    expect(reduced).toMatch(
      /\.toast,\s*\.backdrop,\s*\.sheet\s*\{\s*animation:\s*none;/,
    );
  });
});

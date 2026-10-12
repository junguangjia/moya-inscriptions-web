// @vitest-environment jsdom
import { act, createRef } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { sortAnnouncements } from "../../../media-composer/sort-announcements";
import {
  FIRST_MARK,
  ThumbnailStrip,
  alongStrip,
  needsAttention,
  revealThumb,
  stripScreenReaderInstructions,
  thumbName,
} from "./thumbnail-strip";
import { projectedIndex } from "./photo-tile";
// @ts-expect-error -- Vite serves the stylesheet's own text for a ?raw import.
import editCss from "./edit-screen.module.css?raw";

import type {
  StripAddInputs,
  StripSource,
  ThumbnailStripProps,
} from "./thumbnail-strip";
import type { ItemStatus } from "../media/media-status";
import type { Active, ClientRect, Over } from "@dnd-kit/core";
import type { PublishingMediaItem, WorkDraftItem } from "@moya/contracts";
import type { Root } from "react-dom/client";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

/** CSS module class names without the test build's `_name_hash` wrapping. */
const names = (element: Element) =>
  [...element.classList].map((name) =>
    name.replace(/^_(.+)_[0-9a-f]+$/u, "$1"),
  );

const css = (editCss as string).replace(/\/\*[\s\S]*?\*\//gu, "");
/** A rule's declarations, whitespace folded. */
const rule = (selector: string) => {
  const start = css.indexOf(`\n${selector} {`);
  expect(start).toBeGreaterThanOrEqual(0);
  return css.slice(start, css.indexOf("}", start)).replace(/\s+/gu, " ");
};

const item = (
  key: string,
  overrides: Partial<WorkDraftItem> = {},
): WorkDraftItem => ({
  key,
  itemId: `item-${key}`,
  kind: "static",
  qualityMode: "standard",
  edit: { rotation: 0, crop: null },
  ...overrides,
});

const server = (key: string): PublishingMediaItem =>
  ({
    id: `item-${key}`,
    kind: "static",
    qualityMode: "standard",
    state: "ready",
    failureCode: null,
    components: [],
    presentation: { width: 4000, height: 3000 },
    media: { thumbSrc: `/thumb/${key}`, displaySrc: `/display/${key}` },
  }) as unknown as PublishingMediaItem;

const ready: ItemStatus = { kind: "ready", label: "已就绪" };
const failed: ItemStatus = {
  kind: "failed",
  label: "失败",
  message: "网络中断",
  retry: { type: "registration" },
};

let container: HTMLDivElement;
let root: Root;
let scrolls: { element: HTMLElement; options: ScrollToOptions }[];

const keysOf = (count: number) => "abcdefghijklmnop".slice(0, count).split("");

const inputs = (capture = false): StripAddInputs => ({
  pick: createRef<HTMLInputElement>(),
  capture: capture ? createRef<HTMLInputElement>() : null,
});

const render = (
  overrides: Partial<ThumbnailStripProps> = {},
  statuses = new Map<string, ItemStatus>([
    ["b", { kind: "uploading", label: "上传中 42%", percent: 42 }],
    ["c", failed],
  ]),
  covers: readonly string[] = [],
) => {
  const props: ThumbnailStripProps = {
    id: "strip",
    items: [item("a"), item("b"), item("c")],
    currentKey: "a",
    sourceOf: (entry): StripSource => ({
      view:
        entry.key === "c"
          ? ({ phase: "failed" } as StripSource["view"])
          : undefined,
      server: server(entry.key),
      localStill: null,
      editedThumbSrc: null,
      status: statuses.get(entry.key) ?? ready,
      chosenCover: covers.includes(entry.key),
    }),
    onSelect: vi.fn(),
    onFix: vi.fn(),
    onMenu: vi.fn(),
    onRemove: vi.fn(),
    onReorder: vi.fn(),
    onMove: vi.fn(),
    onSortStart: vi.fn(),
    onAdd: vi.fn(),
    addInputs: inputs(),
    onAddFiles: vi.fn(),
    addHidden: false,
    addDisabled: false,
    reducedMotion: false,
    ...overrides,
  };
  act(() => root.render(<ThumbnailStrip {...props} />));
  const strip = container.querySelector<HTMLElement>("[data-edit-strip]")!;
  const thumbs = [
    ...strip.querySelectorAll<HTMLButtonElement>("[data-edit-thumb]"),
  ];
  return { props, strip, thumbs };
};

const cell = (index: number) =>
  container.querySelector<HTMLElement>(`[data-edit-index="${index}"]`)!;
const thumb = (index: number) =>
  cell(index).querySelector<HTMLButtonElement>("[data-edit-thumb]")!;
/** Each photo's mark, `kind:text`, in strip order. */
const marks = () =>
  [...container.querySelectorAll("[data-edit-index]")].map((entry) => {
    const mark = entry.querySelector("[data-edit-mark]");
    return mark === null
      ? ""
      : `${mark.getAttribute("data-edit-mark")}:${mark.textContent}`;
  });

const key = async (
  target: EventTarget,
  value: string,
  init: KeyboardEventInit = {},
) => {
  const event = new KeyboardEvent("keydown", {
    key: value === "Space" ? " " : value,
    code: value,
    bubbles: true,
    cancelable: true,
    ...init,
  });
  await act(async () => {
    target.dispatchEvent(event);
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
  return event;
};

const STRIP_WIDTH = 400;
const box = (left: number, width: number, top = 0, height = 44) =>
  ({
    x: left,
    y: top,
    top,
    left,
    width,
    height,
    right: left + width,
    bottom: top + height,
    toJSON: () => ({}),
  }) as DOMRect;

/**
 * The strip drawn right to left: photo i at `W − (i + 1) × 56` (44px
 * thumbnails 12px apart, photo 1 at the right edge), the strip `W` wide.
 */
const layOut = (width = STRIP_WIDTH) =>
  vi
    .spyOn(Element.prototype, "getBoundingClientRect")
    .mockImplementation(function (this: Element) {
      if (this.hasAttribute("data-edit-strip")) return box(0, width, 0, 80);
      const photo = this.closest("[data-edit-index]");
      if (photo === null) return box(0, 0, 0, 0);
      const index = Number(photo.getAttribute("data-edit-index"));
      return box(width - (index + 1) * 56, 44, 18);
    });

beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  scrolls = [];
  Object.defineProperty(HTMLElement.prototype, "scrollTo", {
    configurable: true,
    value(this: HTMLElement, options: ScrollToOptions) {
      scrolls.push({ element: this, options });
    },
  });
  // A scroll of anything around the strip would move the page.
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
    configurable: true,
    value() {
      throw new Error("scrollIntoView moves the screen");
    },
  });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  document.body.replaceChildren();
  Reflect.deleteProperty(HTMLElement.prototype, "scrollTo");
  Reflect.deleteProperty(HTMLElement.prototype, "scrollIntoView");
  vi.restoreAllMocks();
});

describe("ThumbnailStrip", () => {
  it("lists the photos in logical order in a right-to-left track, then an icon-only 添加照片 outside the scroller", () => {
    const { strip, thumbs } = render();
    expect(strip.getAttribute("role")).toBe("group");
    expect(strip.getAttribute("aria-label")).toBe("照片");
    expect(names(strip)).toEqual(["strip"]);
    const track = strip.querySelector("[data-edit-strip-track]")!;
    expect(track.tagName).toBe("OL");
    expect(track.parentElement).toBe(strip);
    expect(names(track)).toEqual(["stripTrack"]);
    expect(track.getAttribute("aria-label")).toBe("照片，从右往左按发布顺序");
    // DOM order is 第 1 项 → 第 N 项, then +: tab order and screen readers.
    const cells = [...track.children];
    expect(cells.map((entry) => entry.tagName)).toEqual(["LI", "LI", "LI"]);
    expect(cells.map((entry) => entry.getAttribute("data-edit-key"))).toEqual([
      "a",
      "b",
      "c",
    ]);
    expect(cells.map((entry) => entry.getAttribute("data-edit-index"))).toEqual(
      ["0", "1", "2"],
    );
    expect(thumbs.map((entry) => entry.dataset.editThumb)).toEqual([
      "a",
      "b",
      "c",
    ]);
    for (const entry of cells) expect(names(entry)).toEqual(["stripCell"]);
    // + follows the last photo beside the scroller, never scrolled out of
    // reach (r4 F3): the scroller's next sibling, drawn left of it by the row.
    expect(strip.querySelector("[data-edit-add]")).toBe(null);
    const addCell = strip.nextElementSibling!;
    expect(addCell.hasAttribute("data-edit-add-cell")).toBe(true);
    expect(names(addCell)).toEqual(["stripAddCell"]);
    const add = addCell.querySelector<HTMLButtonElement>("[data-edit-add]")!;
    expect(add.textContent).toBe("");
    expect(add.getAttribute("aria-label")).toBe("添加照片");
    expect(add.getAttribute("aria-haspopup")).toBe("dialog");
    expect(names(add)).toEqual(["stripThumb", "stripAdd"]);
    expect(add.querySelector("svg path")!.getAttribute("d")).toBe(
      "M12 5v14M5 12h14",
    );
    // The help dnd-kit reads with each thumbnail says the direction.
    expect(document.body.textContent).toContain(
      stripScreenReaderInstructions.draggable,
    );
    expect(stripScreenReaderInstructions.draggable).toContain(
      "照片从右往左排列，最右一张是首图",
    );
  });

  it("draws the track right to left, + right after the last photo, without growing the band", () => {
    // The row: the photos at the right, 应用到全部 at the left (r4 D22).
    expect(rule(".stripRow")).toContain("flex-direction: row-reverse;");
    // An ordinary scroller around a row-reverse track that never scrolls,
    // never wider than its photos: + follows the last one, with no gap
    // however few they are, and the divider's auto margin takes the room
    // left between + and 应用到全部 (a full album without + too).
    const strip = rule(".strip");
    expect(strip).not.toContain("row-reverse");
    expect(strip).toContain("flex: 0 1 auto;");
    expect(strip).toContain("min-width: 0;");
    expect(strip).toContain("overflow-x: auto;");
    expect(strip).toContain("touch-action: pan-x;");
    expect(strip).toContain("padding: calc(var(--yoyi-space-4) + 6px) 0 6px;");
    expect(rule(".stripDivider")).toContain("margin-right: auto;");
    expect(rule(".stripAddCell")).not.toMatch(/margin[^;]*auto/u);
    const track = rule(".stripTrack");
    expect(track).toContain("flex-direction: row-reverse;");
    expect(track).toContain("margin: 0;");
    expect(track).not.toMatch(/justify-content|overflow/u);
    expect(track).toContain("gap: var(--yoyi-space-4);");
    expect(track).toContain(
      "padding: 0 max(var(--yoyi-space-5), env(safe-area-inset-right)) 0 var(--yoyi-space-3);",
    );
    expect(track).toContain("-webkit-touch-callout: none;");
    expect(track).toContain("user-select: none;");
    expect(rule(".stripThumb img")).toContain("-webkit-user-drag: none;");
    // The badge straddles the thumbnail's bottom edge, in the strip's 6px.
    const mark = rule(".stripMark");
    expect(mark).toContain("position: absolute;");
    expect(mark).toContain("bottom: -6px;");
    expect(mark).toContain("height: 14px;");
    expect(mark).toContain("pointer-events: none;");
    // Token pairs at 4.5:1 or more in both themes (12px text, never large):
    // 首图 on the deeper seal red, 封面 in ink on the muted seal red, a
    // place past ten quieter but still readable.
    const first = rule('.stripMark[data-edit-mark="first"]');
    expect(first).toContain("background: var(--yoyi-color-seal-red-hover);");
    expect(mark).toContain("color: var(--yoyi-color-text-inverse);");
    const cover = rule('.stripMark[data-edit-mark="cover"]');
    expect(cover).toContain("color: var(--yoyi-color-text-primary);");
    expect(cover).toContain("background: var(--yoyi-color-seal-red-muted);");
    const beyond = rule('.stripMark[data-edit-mark="beyond"]');
    expect(beyond).toContain("color: var(--yoyi-color-text-secondary);");
    expect(beyond).toContain("background: var(--yoyi-color-background-muted);");
    // Lifted: the dialog shadow and a little larger; the × steps aside.
    const lifted = rule('.stripCell[data-dragging="true"] .stripThumb');
    expect(lifted).toContain("box-shadow: var(--yoyi-shadow-dialog);");
    expect(lifted).toContain("transform: scale(1.08);");
    expect(rule(".strip[data-sorting] .stripRemove")).toContain(
      "pointer-events: none;",
    );
    // + outside the scroller (r4 F3): the strip's room above and below, so
    // it lines up with the thumbnails, and always its whole 44px.
    const add = rule(".stripAddCell");
    expect(add).toContain("flex: 0 0 auto;");
    expect(add).toContain("box-sizing: content-box;");
    expect(add).toContain("width: 44px;");
    expect(add).toContain("height: 44px;");
    expect(add).toContain("padding: calc(var(--yoyi-space-4) + 6px) 0 6px;");
    // The badge ends on the strip's bottom edge: the band keeps at least 8px
    // under it, or the home indicator's inset (r4 F2).
    expect(rule(".editBand")).toContain(
      "padding-bottom: max(var(--yoyi-space-3), var(--editor-bottom-safe-area));",
    );
  });

  it("keeps the ×'s target in the thumbnail's corner, so a tap or a long press on the current photo is the photo's", () => {
    /** A length a rule declares, in px (0 with no unit). */
    const length = (selector: string, property: string) => {
      const found = new RegExp(`[{;] ${property}: (-?\\d+)(?:px)?;`, "u").exec(
        rule(selector),
      );
      expect(found).not.toBe(null);
      return Number(found![1]);
    };
    const cellSize = 44;
    const gap = 12; // var(--yoyi-space-4)
    const room = 12 + 6; // the strip's top padding, calc(var(--yoyi-space-4) + 6px)
    expect(rule(".stripCell")).toContain(`width: ${cellSize}px;`);
    // The × in the cell (its top-right corner) and its ::before around it.
    const crossLeft =
      cellSize -
      length(".stripRemove", "right") -
      length(".stripRemove", "width");
    const crossTop = length(".stripRemove", "top");
    const crossRight = crossLeft + length(".stripRemove", "width");
    const crossBottom = crossTop + length(".stripRemove", "height");
    // An inset pushes the box in; a negative one, out.
    const target = {
      left: crossLeft + length(".stripRemove::before", "left"),
      top: crossTop + length(".stripRemove::before", "top"),
      right: crossRight - length(".stripRemove::before", "right"),
      bottom: crossBottom - length(".stripRemove::before", "bottom"),
    };
    const contains = (x: number, y: number) =>
      x >= target.left &&
      x <= target.right &&
      y >= target.top &&
      y <= target.bottom;
    // The thumbnail's middle, and every point of it the × itself does not
    // cover, belong to the thumbnail (its sheet, its long-press lift).
    expect(contains(cellSize / 2, cellSize / 2)).toBe(false);
    expect(target.left).toBeGreaterThanOrEqual(crossLeft);
    expect(target.bottom).toBeLessThanOrEqual(crossBottom);
    // Inside the strip's clip above, short of the next thumbnail beside.
    expect(target.top).toBeGreaterThanOrEqual(-room);
    expect(target.right).toBeLessThanOrEqual(cellSize + gap);
    expect(target).toEqual({ left: 30, top: -18, right: 56, bottom: 14 });
  });

  it("marks photo 1 as 首图 at rest, and an older draft's chosen cover as 封面", () => {
    render({}, new Map(), ["c"]);
    expect(marks()).toEqual(["first:首图", "", "cover:封面"]);
    const first = cell(0).querySelector("[data-edit-mark]")!;
    expect(first.getAttribute("aria-hidden")).toBe("true");
    expect(names(first)).toEqual(["stripMark"]);
    // The mark sits beside the button: the button's name says it.
    expect(first.closest("button")).toBe(null);
    expect(FIRST_MARK).toBe("首图");
  });

  it("makes two or more photos sortable, and a single photo a plain button", () => {
    const { thumbs } = render();
    for (const entry of thumbs) {
      expect(entry.getAttribute("aria-roledescription")).toBe("可排序的图片");
      expect(entry.getAttribute("aria-keyshortcuts")).toBe(
        "Alt+ArrowLeft Alt+ArrowRight",
      );
    }
    const single = render({ items: [item("a")] }).thumbs[0]!;
    expect(single.hasAttribute("aria-roledescription")).toBe(false);
    expect(single.hasAttribute("aria-disabled")).toBe(false);
    expect(single.hasAttribute("aria-keyshortcuts")).toBe(false);
    expect(single.getAttribute("aria-label")).toBe(
      "第 1 项，首图。点按查看操作",
    );
  });

  it("names each thumbnail by place, its marks, its state and what a tap does", () => {
    const { thumbs } = render({ currentKey: "b" });
    expect(thumbs.map((entry) => entry.getAttribute("aria-label"))).toEqual([
      "第 1 项，首图，长按拖动可排序",
      "第 2 项，上传中 42%。点按查看操作，长按拖动可排序",
      "第 3 项，上传失败，长按拖动可排序",
    ]);
    expect(thumbs.map((entry) => entry.getAttribute("aria-current"))).toEqual([
      "false",
      "true",
      "false",
    ]);
    for (const entry of thumbs) expect(names(entry)).toEqual(["stripThumb"]);
    expect(
      render({ currentKey: "c" }).thumbs[2]!.getAttribute("aria-label"),
    ).toBe("第 3 项，上传失败。点按处理，长按拖动可排序");
    // Only the current photo opens a sheet.
    expect(thumbs[0]!.hasAttribute("aria-haspopup")).toBe(false);

    const parts = {
      number: 2,
      count: 3,
      live: false,
      status: ready,
      uploadFailed: false,
      current: false,
      chosenCover: false,
    };
    expect(
      thumbName({ ...parts, status: { kind: "uploaded", label: "已上传" } }),
    ).toBe("第 2 项，等待处理，长按拖动可排序");
    expect(thumbName({ ...parts, live: true, chosenCover: true })).toBe(
      "第 2 项，实况照片，封面，长按拖动可排序",
    );
    expect(thumbName({ ...parts, number: 11, count: 11 })).toBe(
      "第 11 项，仅作品页，长按拖动可排序",
    );
    expect(thumbName({ ...parts, number: 10, count: 11 })).toBe(
      "第 10 项，长按拖动可排序",
    );
    expect(
      thumbName({
        ...parts,
        number: 1,
        current: true,
        status: { kind: "removing", label: "正在移除" },
      }),
    ).toBe("第 1 项，首图，正在移除");
  });

  it("draws progress and attention as marks, never by colour alone", () => {
    const { thumbs } = render();
    const [first, second, third] = thumbs as [
      HTMLButtonElement,
      HTMLButtonElement,
      HTMLButtonElement,
    ];
    const progress = second.querySelector<HTMLElement>('[aria-hidden="true"]')!;
    expect(names(progress)).toEqual(["stripProgress"]);
    expect((progress.firstElementChild as HTMLElement).style.width).toBe("42%");
    expect(second.hasAttribute("data-attention")).toBe(false);

    expect(third.getAttribute("data-attention")).toBe("true");
    const disc = [...third.children].find((child) =>
      names(child).includes("stripDisc"),
    )!;
    expect(disc.getAttribute("aria-hidden")).toBe("true");
    expect(disc.querySelector('[data-icon="error"]')).not.toBe(null);
    // Each thumbnail draws its photo from the account's thumbnail.
    expect(first.querySelector("img")!.getAttribute("src")).toBe("/thumb/a");
  });

  it("removes the current photo from its × only", () => {
    const { strip, props } = render({ currentKey: "b" });
    const removers = [
      ...strip.querySelectorAll<HTMLButtonElement>("[data-edit-remove]"),
    ];
    expect(removers).toHaveLength(1);
    const remove = removers[0]!;
    expect(remove.getAttribute("aria-label")).toBe("移除第 2 项");
    expect(names(remove)).toEqual(["stripRemove"]);
    // A sibling of the thumbnail, never inside it.
    expect(remove.closest("[data-edit-thumb]")).toBe(null);
    expect(remove.closest("[data-edit-index]")).toBe(cell(1));
    expect(remove.querySelector('[data-icon="close"]')).not.toBe(null);
    act(() => remove.click());
    expect(props.onRemove).toHaveBeenCalledExactlyOnceWith("b");
    expect(props.onSelect).not.toHaveBeenCalled();
  });

  it("switches photos on a tap, and opens the current photo's sheet: its actions, or what it needs", () => {
    const { thumbs, props } = render();
    act(() => thumbs[2]!.click());
    expect(props.onSelect).toHaveBeenCalledExactlyOnceWith("c");
    // The current, healthy photo: its photo sheet.
    expect(thumbs[0]!.getAttribute("aria-haspopup")).toBe("dialog");
    act(() => thumbs[0]!.click());
    expect(props.onMenu).toHaveBeenCalledExactlyOnceWith("a");
    expect(props.onFix).not.toHaveBeenCalled();
    // The tap is the photo's, never its ×'s.
    expect(props.onRemove).not.toHaveBeenCalled();
    // The current photo that needs the author: its fix sheet.
    const again = render({ ...props, currentKey: "c" });
    act(() => again.thumbs[2]!.click());
    expect(props.onFix).toHaveBeenCalledExactlyOnceWith("c");
    expect(props.onMenu).toHaveBeenCalledTimes(1);
    // + opens the add sheet.
    act(() =>
      container.querySelector<HTMLButtonElement>("[data-edit-add]")!.click(),
    );
    expect(props.onAdd).toHaveBeenCalledOnce();
  });

  it("centres the current photo by scrolling the strip sideways only, again as photos join", () => {
    const offsets = new Map([
      ["a", 256],
      ["b", 200],
      ["c", 144],
      ["d", 88],
    ]);
    Object.defineProperty(HTMLElement.prototype, "offsetLeft", {
      configurable: true,
      get(this: HTMLElement) {
        const found =
          this.querySelector("[data-edit-thumb]")?.getAttribute(
            "data-edit-thumb",
          );
        return found ? (offsets.get(found) ?? 0) : 0;
      },
    });
    Object.defineProperty(HTMLElement.prototype, "offsetWidth", {
      configurable: true,
      get: () => 44,
    });
    Object.defineProperty(HTMLElement.prototype, "clientWidth", {
      configurable: true,
      get: () => 100,
    });
    try {
      const { strip, props } = render();
      // The first placement jumps; later ones glide.
      expect(scrolls).toEqual([
        { element: strip, options: { left: 228, behavior: "auto" } },
      ]);
      render({ ...props, currentKey: "c" });
      expect(scrolls.at(-1)).toEqual({
        element: strip,
        options: { left: 116, behavior: "smooth" },
      });
      // A photo joins at the left end: the content shifts, so it centres again.
      offsets.set("c", 200);
      render({ ...props, currentKey: "c", items: [...props.items, item("d")] });
      expect(scrolls).toHaveLength(3);
      expect(scrolls.at(-1)).toEqual({
        element: strip,
        options: { left: 172, behavior: "smooth" },
      });
      render({
        ...props,
        currentKey: "b",
        items: [...props.items, item("d")],
        reducedMotion: true,
      });
      expect(scrolls.at(-1)).toEqual({
        element: strip,
        options: { left: 172, behavior: "auto" },
      });
      expect(scrolls.every((scroll) => scroll.element === strip)).toBe(true);
    } finally {
      for (const name of ["offsetLeft", "offsetWidth", "clientWidth"])
        Reflect.deleteProperty(HTMLElement.prototype, name);
    }
  });

  it("holds the pick input and, on a coarse pointer, the camera input in the + cell", () => {
    const onAddFiles = vi.fn();
    const addInputs = inputs(true);
    const { strip } = render({ onAddFiles, addInputs });
    const last = strip.nextElementSibling!;
    expect(last.hasAttribute("data-edit-add-cell")).toBe(true);
    const add = last.querySelector<HTMLButtonElement>("[data-edit-add]")!;
    expect(add).not.toBe(null);
    const [pick, capture] = [
      ...last.querySelectorAll<HTMLInputElement>('input[type="file"]'),
    ] as [HTMLInputElement, HTMLInputElement];
    expect(addInputs.pick.current).toBe(pick);
    expect(addInputs.capture!.current).toBe(capture);
    expect(pick.hidden).toBe(true);
    expect(pick.multiple).toBe(true);
    expect(pick.getAttribute("aria-label")).toBe("选择照片");
    expect(capture.getAttribute("capture")).toBe("environment");
    expect(capture.multiple).toBe(false);
    expect(capture.getAttribute("aria-label")).toBe("拍照");
    // The tap opens the sheet, never the picker itself.
    const opened = vi.spyOn(pick, "click").mockImplementation(() => {});
    act(() => add.click());
    expect(opened).not.toHaveBeenCalled();

    const file = new File(["x"], "photo.jpg", { type: "image/jpeg" });
    for (const input of [pick, capture]) {
      Object.defineProperty(input, "files", {
        configurable: true,
        value: [file],
      });
      act(() => input.dispatchEvent(new Event("change", { bubbles: true })));
    }
    expect(onAddFiles.mock.calls).toEqual([
      [[file], "picker"],
      [[file], "picker"],
    ]);

    // Without a coarse pointer there is no camera input.
    render({ addInputs: inputs() });
    expect(container.querySelectorAll('input[type="file"]')).toHaveLength(1);
    render({ addDisabled: true });
    expect(
      container.querySelector<HTMLButtonElement>("[data-edit-add]")!.disabled,
    ).toBe(true);
    expect(
      container.querySelector<HTMLInputElement>('input[type="file"]')!.disabled,
    ).toBe(true);
    render({ addHidden: true });
    expect(container.querySelector("[data-edit-add-cell]")).toBe(null);
    expect(container.querySelector('input[type="file"]')).toBe(null);
  });

  it("hands focus from + to the last photo when the album fills up under it", () => {
    render();
    const add = container.querySelector<HTMLButtonElement>("[data-edit-add]")!;
    act(() => add.focus());
    expect(document.activeElement).toBe(add);
    // The add sheet's pick brings the album to its limit: + goes.
    render({ items: keysOf(4).map((entry) => item(entry)), addHidden: true });
    expect(container.querySelector("[data-edit-add]")).toBe(null);
    expect(document.activeElement).toBe(thumb(3));

    // + going while focus is elsewhere leaves focus where it is.
    render({ items: keysOf(3).map((entry) => item(entry)) });
    act(() => thumb(1).focus());
    render({ items: keysOf(4).map((entry) => item(entry)), addHidden: true });
    expect(document.activeElement).toBe(thumb(1));
  });

  it("reports each photo's source size for 应用到全部", () => {
    const onSourceSize = vi.fn();
    render({ onSourceSize });
    expect(onSourceSize).toHaveBeenCalledWith("a", {
      width: 4000,
      height: 3000,
    });
    expect(onSourceSize).toHaveBeenCalledTimes(3);
  });

  it("walks focus with → towards 首图 and ← away from it, showing the photo inside the strip only", async () => {
    const { strip } = render({ items: keysOf(5).map((entry) => item(entry)) });
    layOut(160);
    let scrollLeft = 100;
    Object.defineProperty(strip, "scrollLeft", {
      configurable: true,
      get: () => scrollLeft,
      set: (value: number) => {
        scrollLeft = value;
      },
    });
    const pageScroll = vi
      .spyOn(window, "scrollTo")
      .mockImplementation(() => {});
    act(() => thumb(2).focus());
    // ← is the later photo, drawn to the left.
    const left = await key(thumb(2), "ArrowLeft");
    expect(left.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(thumb(3));
    // 第 4 项 sits at 160 − 4 × 56 = −64: the strip brings it in, × room too.
    expect(scrollLeft).toBe(100 - (0 - -64 + 6));
    const right = await key(thumb(3), "ArrowRight");
    expect(right.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(thumb(2));
    act(() => thumb(0).focus());
    // Nothing to the right of 首图: the key is left alone.
    expect((await key(thumb(0), "ArrowRight")).defaultPrevented).toBe(false);
    expect(document.activeElement).toBe(thumb(0));
    expect(pageScroll).not.toHaveBeenCalled();
  });

  it("reveals a thumbnail past either end by the overhang, and leaves one in view alone", () => {
    const strip = document.createElement("div");
    const target = document.createElement("div");
    let scrollLeft = 50;
    Object.defineProperty(strip, "scrollLeft", {
      get: () => scrollLeft,
      set: (value: number) => {
        scrollLeft = value;
      },
    });
    strip.getBoundingClientRect = () => box(0, 200);
    target.getBoundingClientRect = () => box(180, 44);
    revealThumb(strip, target);
    expect(scrollLeft).toBe(50 + (224 - 200 + 6));
    target.getBoundingClientRect = () => box(-10, 44);
    revealThumb(strip, target);
    expect(scrollLeft).toBe(80 - 16);
    target.getBoundingClientRect = () => box(60, 44);
    revealThumb(strip, target);
    expect(scrollLeft).toBe(64);
  });

  it("moves one place with Alt + arrows: → towards 首图, ← away; Enter is the tap", async () => {
    const { props } = render();
    const toward = await key(thumb(1), "ArrowRight", { altKey: true });
    expect(toward.defaultPrevented).toBe(true);
    expect(props.onMove).toHaveBeenLastCalledWith("b", -1);
    await key(thumb(1), "ArrowLeft", { altKey: true });
    expect(props.onMove).toHaveBeenLastCalledWith("b", 1);
    expect(props.onMove).toHaveBeenCalledTimes(2);
    expect(props.onReorder).not.toHaveBeenCalled();
    const enter = await key(thumb(1), "Enter");
    expect(enter.defaultPrevented).toBe(false);
    expect(container.querySelector('[data-dragging="true"]')).toBe(null);
    // A single photo has nothing to move among.
    const single = render({ items: [item("a")] });
    await key(single.thumbs[0]!, "ArrowRight", { altKey: true });
    expect(props.onMove).toHaveBeenCalledTimes(2);
  });

  describe("keyboard sorting", () => {
    beforeEach(() => {
      Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
        configurable: true,
        value: vi.fn(),
      });
    });

    it("lifts with Space, renumbers every photo live and drops towards 首图 with →", async () => {
      const { props, strip } = render({}, new Map());
      layOut();
      act(() => thumb(1).focus());
      await key(thumb(1), "Space");
      expect(props.onSortStart).toHaveBeenCalledOnce();
      expect(strip.hasAttribute("data-sorting")).toBe(true);
      expect([...container.querySelectorAll('[data-dragging="true"]')]).toEqual(
        [cell(1)],
      );
      // The flow's Escape guard sees a photo being sorted.
      expect(
        container.querySelector('[aria-roledescription][aria-pressed="true"]'),
      ).toBe(thumb(1));
      // Held: every photo shows its place.
      expect(marks()).toEqual(["first:首图", "order:2", "order:3"]);
      await key(document, "ArrowRight");
      // 首图 moves to the photo that would land first.
      expect(marks()).toEqual(["order:2", "first:首图", "order:3"]);
      await key(document, "Space");
      expect(props.onReorder).toHaveBeenCalledExactlyOnceWith("b", 0);
      expect(strip.hasAttribute("data-sorting")).toBe(false);
      // At rest again: the badge alone.
      expect(marks()).toEqual(["first:首图", "", ""]);
    });

    it("drops away from 首图 with ←, and dims a place past the feed's ten", async () => {
      const keys = keysOf(11);
      const { props } = render(
        { items: keys.map((entry) => item(entry)), currentKey: "k" },
        new Map(),
      );
      layOut(700);
      act(() => thumb(0).focus());
      await key(thumb(0), "Space");
      expect(marks()).toEqual([
        "first:首图",
        ...keys.slice(1, 10).map((_, at) => `order:${at + 2}`),
        "beyond:11",
      ]);
      await key(document, "ArrowLeft");
      expect(marks().slice(0, 3)).toEqual(["order:2", "first:首图", "order:3"]);
      await key(document, "Space");
      expect(props.onReorder).toHaveBeenCalledExactlyOnceWith("a", 1);
    });

    it("puts the photo back on Escape, with only the badge", async () => {
      const { props, strip } = render({}, new Map());
      layOut();
      act(() => thumb(0).focus());
      await key(thumb(0), "Space");
      await key(document, "ArrowLeft");
      await key(document, "Escape");
      expect(props.onReorder).not.toHaveBeenCalled();
      expect(container.querySelector('[data-dragging="true"]')).toBe(null);
      expect(strip.hasAttribute("data-sorting")).toBe(false);
      expect(marks()).toEqual(["first:首图", "", ""]);
    });

    it("moves the other photos without a transition under reduced motion", async () => {
      render({ reducedMotion: true }, new Map());
      layOut();
      act(() => thumb(1).focus());
      await key(thumb(1), "Space");
      await key(document, "ArrowRight");
      expect(cell(0).style.transition).toBe("");
      await key(document, "Escape");

      render({ reducedMotion: false }, new Map());
      act(() => thumb(1).focus());
      await key(thumb(1), "Space");
      await key(document, "ArrowRight");
      expect(cell(0).style.transition).not.toBe("");
      await key(document, "Escape");

      const reduced =
        /@media \(prefers-reduced-motion: reduce\) \{([\s\S]*?)\n\}/u.exec(
          css,
        )![1]!;
      expect(reduced).toMatch(/\.stripThumb,/u);
      expect(reduced).toMatch(/\.stripHint,/u);
    });
  });

  it("keeps a lifted photo in the strip: sideways only, never past its ends", () => {
    const rect = (left: number, width: number): ClientRect => ({
      top: 18,
      left,
      width,
      height: 44,
      right: left + width,
      bottom: 62,
    });
    const args = (x: number, y: number) =>
      ({
        transform: { x, y, scaleX: 1, scaleY: 1 },
        draggingNodeRect: rect(200, 44),
        scrollableAncestorRects: [rect(0, 400)],
      }) as unknown as Parameters<typeof alongStrip>[0];
    expect(alongStrip(args(-50, 30))).toEqual({
      x: -50,
      y: 0,
      scaleX: 1,
      scaleY: 1,
    });
    expect(alongStrip(args(-500, 0)).x).toBe(-200);
    expect(alongStrip(args(500, 0)).x).toBe(156);
    expect(
      alongStrip({
        ...args(40, 12),
        scrollableAncestorRects: [],
      }),
    ).toEqual({ x: 40, y: 0, scaleX: 1, scaleY: 1 });
  });

  it("says who is, or becomes, 首图 while photos are sorted", () => {
    const say = sortAnnouncements(["a", "b", "c"], { first: FIRST_MARK });
    const active = (id: string) => ({ id }) as unknown as Active;
    const over = (id: string) => ({ id }) as unknown as Over;
    expect(say.onDragStart({ active: active("a") })).toBe(
      "已拿起第 1 项（首图）。",
    );
    expect(say.onDragOver({ active: active("c"), over: over("a") })).toBe(
      "第 3 项将移到第 1 位，成为首图。",
    );
    expect(say.onDragEnd({ active: active("c"), over: over("a") })).toBe(
      "第 3 项已移到第 1 位，现在是首图。",
    );
    expect(say.onDragEnd({ active: active("a"), over: over("c") })).toBe(
      "第 1 项已移到第 3 位，原第 2 项现在是首图。",
    );
  });

  it("projects where each photo would sit while one is held over another", () => {
    const order = (active: number, over: number) =>
      [0, 1, 2, 3].map((index) => projectedIndex(index, active, over));
    expect(order(-1, -1)).toEqual([0, 1, 2, 3]);
    expect(order(0, -1)).toEqual([0, 1, 2, 3]);
    expect(order(0, 0)).toEqual([0, 1, 2, 3]);
    expect(order(0, 2)).toEqual([2, 0, 1, 3]);
    expect(order(3, 1)).toEqual([0, 2, 3, 1]);
  });

  it("asks for attention only in the states that need the author", () => {
    expect(needsAttention(ready)).toBe(false);
    expect(needsAttention({ kind: "processing", label: "处理中" })).toBe(false);
    expect(
      needsAttention({ kind: "paused", label: "已暂停", message: null }),
    ).toBe(true);
    expect(
      needsAttention({
        kind: "missing_local",
        label: "缺少本地文件",
        message: "",
      }),
    ).toBe(true);
    expect(
      needsAttention({ kind: "unavailable", label: "无法读取", message: "" }),
    ).toBe(true);
    expect(
      needsAttention({ kind: "needs_choice", label: "需要选择", message: "" }),
    ).toBe(true);
  });
});

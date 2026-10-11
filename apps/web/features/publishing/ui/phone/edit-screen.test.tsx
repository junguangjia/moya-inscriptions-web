// @vitest-environment jsdom
import { act, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { cropper } = vi.hoisted(() => ({
  cropper: {
    props: null as null | {
      aspect: number;
      rotation: number;
      image: string;
      objectFit: string;
      showGrid: boolean;
      classes: { cropAreaClassName: string };
      cropperProps: {
        tabIndex: number;
        "aria-label": string;
        "aria-describedby": string;
      };
      initialCroppedAreaPercentages?: {
        x: number;
        y: number;
        width: number;
        height: number;
      };
      onCropAreaChange: (area: {
        x: number;
        y: number;
        width: number;
        height: number;
      }) => void;
      onCropChange: (position: { x: number; y: number }) => void;
      onCropSizeChange?: (size: { width: number; height: number }) => void;
      /** React 19 hands a function component its ref as a prop. */
      ref?: { current: unknown } | undefined;
    },
  },
}));
vi.mock("react-easy-crop", () => ({
  default: (props: NonNullable<typeof cropper.props>) => {
    cropper.props = props;
    return <div data-test-cropper="" tabIndex={props.cropperProps.tabIndex} />;
  },
}));

import { startCrop } from "../media/crop-workspace";
import {
  indexOfKey,
  moveToIndex,
  removeItem,
  setItemEdit,
} from "../media/media-order";
import { createMediaUiStore, useMediaUiState } from "../media/media-ui-store";
import {
  EditScreen,
  LEGACY_NOTE,
  STRIP_HINT_KEY,
  STRIP_HINT_MS,
  WAIT_SAY_MS,
} from "./edit-screen";
import { COVER_RESET_NOTICE } from "./cover-rule";
import { cropperBox } from "./edit-stage";
// @ts-expect-error -- Vite serves the stylesheet's own text for a ?raw import.
import editCss from "./edit-screen.module.css?raw";

import type { EditorSessionHandle } from "../editor/editor-session-provider";
import type { MediaValue } from "../media/media-order";
import type { ItemStatus } from "../media/media-status";
import type { MediaUiStore } from "../media/media-ui-store";
import type { MediaActions } from "../media/use-media-actions";
import type { SaveWait } from "./edit-screen";
import type { UploadItemView } from "../../upload-manager";
import type {
  MediaCrop,
  MediaEdit,
  PublishingMediaItem,
  WorkDraftItem,
} from "@moya/contracts";
import type { ReactNode } from "react";
import type { Root } from "react-dom/client";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

/** CSS module class names without the test build's `_name_hash` wrapping. */
const names = (element: Element) =>
  [...element.classList].map((name) =>
    name.replace(/^_(.+)_[0-9a-f]+$/u, "$1"),
  );
const plain = (name: string) => name.replace(/^_(.+)_[0-9a-f]+$/u, "$1");

const item = (
  key: string,
  edit: MediaEdit = { rotation: 0, crop: null },
  qualityMode: WorkDraftItem["qualityMode"] = "standard",
): WorkDraftItem => ({
  key,
  itemId: `item-${key}`,
  kind: "static",
  qualityMode,
  edit,
});

const server = (
  key: string,
  size = { width: 4000, height: 3000 },
  displaySrc = `/display/${key}`,
): PublishingMediaItem =>
  ({
    id: `item-${key}`,
    kind: "static",
    qualityMode: "standard",
    state: "ready",
    failureCode: null,
    components: [],
    presentation: size,
    media: { thumbSrc: `/thumb/${key}`, displaySrc },
  }) as unknown as PublishingMediaItem;

const ready: ItemStatus = { kind: "ready", label: "已就绪" };

interface Setup {
  readonly items: readonly WorkDraftItem[];
  readonly coverKey?: string | null;
  readonly coverCrop?: MediaCrop | null;
  /** null: the account has no picture of the photo. */
  readonly servers?: ReadonlyMap<string, PublishingMediaItem | null>;
  readonly statuses?: ReadonlyMap<string, ItemStatus>;
  readonly views?: ReadonlyMap<string, Partial<UploadItemView>>;
  /** The feed stage ratio the first photo sets; null while unknown. */
  readonly stageRatio?: number | null;
  readonly reducedMotion?: boolean;
  readonly maxItems?: number;
  /** Where the screen registers what ‹ keeps, for the editor's Back. */
  readonly commitRef?: { current: (() => void) | null };
  /** What the editor was opened as: a new work (the default) or a draft. */
  readonly openedAs?: "new" | "draft";
  /** The upload session's save mode (drafts on by default). */
  readonly saveMode?: "saved" | "unsaved";
  /** Photos the start screen holds for 撤销. */
  readonly heldKeys?: readonly string[];
  /** A pick being read (the runtime's staging); none by default. */
  readonly staging?: MediaActions["staging"];
  readonly notices?: ReactNode;
  readonly canSelect?: boolean;
}

const spies = {
  applyEdit: vi.fn<(key: string, edit: MediaEdit) => void>(),
  setMedia: vi.fn<(value: MediaValue) => void>(),
  remove: vi.fn<(key: string) => void>(),
  announce: vi.fn<(text: string) => void>(),
  showNotice: vi.fn<(text: string | null, lead?: string | null) => void>(),
  retry: vi.fn(),
  chooseOriginal: vi.fn<(key: string) => void>(),
  reselect: vi.fn<(key: string) => void>(),
  continueUploads: vi.fn(async () => undefined),
  onBack: vi.fn<() => void>(),
  onLeave: vi.fn<() => void>(),
  onSaveAndLeave: vi.fn<() => Promise<string | null> | undefined>(),
  onNext: vi.fn<() => void>(),
  onRemoveLast: vi.fn<(key: string) => void>(),
  onRemoveAll: vi.fn<(keys: readonly string[], current: string) => void>(),
  onComposeCover: vi.fn<(key: string) => void>(),
  onAttentionTaken: vi.fn<() => void>(),
  onAddFiles: vi.fn(),
  reorder: vi.fn<(key: string, index: number) => void>(),
  setOriginalNext: vi.fn<(next: boolean) => void>(),
};

let album: MediaValue;
/** Appends photos to the album, as a finished pick does. */
let growAlbum: (added: readonly WorkDraftItem[]) => void;
/** Sets the album from elsewhere (a version chosen, another screen's edit). */
let replaceAlbum: (next: MediaValue) => void;
/** 存草稿并退出's wait for the uploads, as the editor reports it. */
let setSaveWait: (wait: SaveWait | null) => void;

/** The editor session and PhoneFlow's media actions, as far as the screen uses them. */
const Harness = ({ setup, ui }: { setup: Setup; ui: MediaUiStore }) => {
  const [value, setValue] = useState<MediaValue>(() => ({
    items: setup.items,
    coverKey: setup.coverKey ?? null,
    coverCrop: setup.coverCrop ?? null,
  }));
  const current = useRef(value);
  current.current = value;
  album = value;
  const [originalNext, setOriginalNext] = useState(false);
  const [saveWait, changeSaveWait] = useState<SaveWait | null>(null);
  setSaveWait = changeSaveWait;
  const { notice, phone } = useMediaUiState(ui);
  const setMedia = (next: MediaValue) => {
    current.current = next;
    album = next;
    spies.setMedia(next);
    setValue(next);
  };
  growAlbum = (added) =>
    setMedia({
      ...current.current,
      items: [...current.current.items, ...added],
    });
  replaceAlbum = setMedia;
  const editor = {
    state: {
      key: "session-1",
      openedAs:
        setup.openedAs === "draft"
          ? { type: "draft", id: "draft-1" }
          : { type: "new" },
      originalNext,
    },
    content: {},
    actions: {
      media: () => current.current,
      setMedia,
      setOriginalNext: (next: boolean) => {
        spies.setOriginalNext(next);
        setOriginalNext(next);
      },
    },
  } as unknown as EditorSessionHandle;
  const serverOf = (entry: WorkDraftItem) =>
    setup.servers?.has(entry.key)
      ? setup.servers.get(entry.key)!
      : server(entry.key);
  const first = setup.items[0];
  const media = {
    ui,
    notice,
    uploads: null,
    value,
    views: new Map(
      [...(setup.views ?? new Map())].map(([key, view]) => [key, view]),
    ),
    derivations: new Map(),
    feed: {
      slides:
        setup.stageRatio === null || first === undefined
          ? []
          : [{ key: first.key, size: { width: 4, height: 5 } }],
      stageRatio: setup.stageRatio ?? 1,
      total: value.items.length,
      unedited: 0,
    },
    session: {
      localStill: () => null,
      continueUploads: spies.continueUploads,
      session: { saveMode: setup.saveMode ?? "saved" },
    },
    canSelect: setup.canSelect ?? true,
    staging: setup.staging ?? null,
    maxItems: setup.maxItems ?? 50,
    reducedMotion: setup.reducedMotion ?? true,
    serverFor: serverOf,
    statusOf: (entry: WorkDraftItem) => setup.statuses?.get(entry.key) ?? ready,
    applyEdit: (key: string, edit: MediaEdit) => {
      spies.applyEdit(key, edit);
      const result = setItemEdit(current.current, key, edit);
      if (result.value !== current.current) setMedia(result.value);
    },
    remove: (key: string) => {
      spies.remove(key);
      const before = current.current;
      const index = indexOfKey(before, key);
      const next = removeItem(before, key).value;
      const neighbour =
        next.items[index]?.key ?? next.items[index - 1]?.key ?? null;
      if (ui.get().phone.currentKey === key) ui.setCurrentKey(neighbour);
      ui.retainPhoneKeys(next.items.map((entry) => entry.key));
      setMedia(next);
    },
    // The plain album move: the screen keeps 首图 = 封面 around it.
    reorder: (key: string, index: number) => {
      spies.reorder(key, index);
      setMedia(moveToIndex(current.current, key, index));
    },
    announce: spies.announce,
    showNotice: (text: string | null, lead?: string | null) => {
      spies.showNotice(text, lead);
      ui.setNotice(text);
    },
    retry: spies.retry,
    chooseOriginal: spies.chooseOriginal,
    reselect: spies.reselect,
  } as unknown as MediaActions;
  return (
    <EditScreen
      attentionKey={phone.attentionKey}
      commitRef={setup.commitRef}
      editor={editor}
      heldKeys={setup.heldKeys}
      media={media}
      notices={setup.notices}
      onAddFiles={spies.onAddFiles}
      onAttentionTaken={() => {
        spies.onAttentionTaken();
        ui.setAttentionKey(null);
      }}
      // The flow's step back on a work started here: the back sheet.
      onBack={() => {
        spies.onBack();
        ui.setBackAsk(true);
      }}
      onComposeCover={spies.onComposeCover}
      onLeave={spies.onLeave}
      onNext={spies.onNext}
      onRemoveAll={spies.onRemoveAll}
      onRemoveLast={spies.onRemoveLast}
      onSaveAndLeave={async () => (await spies.onSaveAndLeave()) ?? null}
      saveWait={saveWait}
    />
  );
};

let container: HTMLDivElement;
let root: Root;
let ui: MediaUiStore;

const render = (setup: Setup) =>
  act(() => root.render(<Harness setup={setup} ui={ui} />));

const screen = () =>
  container.querySelector<HTMLElement>('[data-editor-screen="edit"]');
const stage = () => container.querySelector<HTMLElement>("[data-edit-stage]")!;
const title = () =>
  screen()!.querySelector("[data-editor-step-heading]")!.textContent;
const button = (name: string) => {
  const found = [...document.querySelectorAll("button")].find(
    (element) =>
      (element.getAttribute("aria-label") ?? element.textContent) === name,
  );
  if (!found) throw new Error(`No button ${name}`);
  return found;
};
const ratio = (label: string) => {
  const found = [
    ...container.querySelectorAll<HTMLButtonElement>('[role="radio"]'),
  ].find((element) => element.textContent === label);
  if (!found) throw new Error(`No ratio ${label}`);
  return found;
};
const checkedRatios = () =>
  [...container.querySelectorAll('[role="radio"][aria-checked="true"]')].map(
    (element) => element.textContent,
  );
const thumb = (key: string) =>
  container.querySelector<HTMLButtonElement>(`[data-edit-thumb="${key}"]`)!;
const applyAll = () =>
  container.querySelector<HTMLButtonElement>("[data-edit-apply-all]")!;
const toastText = () =>
  container.querySelector("[data-edit-toasts]")!.textContent;
const undo = () =>
  click(container.querySelector<HTMLButtonElement>("[data-edit-undo]")!);
const sheet = () =>
  document.querySelector<HTMLDialogElement>("dialog[data-phone-sheet]");
const click = (element: HTMLElement) => act(() => element.click());
const key = (target: HTMLElement, name: string) =>
  act(() => {
    target.dispatchEvent(
      new KeyboardEvent("keydown", { key: name, bubbles: true }),
    );
  });

/** A pointer event as React reads it (jsdom has no PointerEvent). */
const pointer = (type: string, target: EventTarget, id = 1) => {
  const event = new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    button: 0,
  });
  Object.defineProperties(event, {
    pointerId: { value: id },
    pointerType: { value: "touch" },
  });
  act(() => {
    target.dispatchEvent(event);
  });
};
const cropTarget = () =>
  container.querySelector<HTMLElement>("[data-test-cropper]")!;

/** An author's drag: a finger on the photo, the cropper moves and reports, the finger lifts. */
const drag = (area: {
  x: number;
  y: number;
  width: number;
  height: number;
}) => {
  pointer("pointerdown", cropTarget());
  act(() => cropper.props!.onCropChange({ x: -12, y: -3 }));
  act(() => cropper.props!.onCropAreaChange(area));
  pointer("pointerup", window);
};

/** The cropper's own report as it mounts: no author input before it. */
const mountReport = (area: {
  x: number;
  y: number;
  width: number;
  height: number;
}) => {
  act(() => cropper.props!.onCropChange({ x: 0, y: 0 }));
  act(() => cropper.props!.onCropAreaChange(area));
};

const touch = (
  type: string,
  touches: readonly { x: number; y: number }[],
  changed: readonly { x: number; y: number }[],
) => {
  const event = new Event(type, { bubbles: true, cancelable: true });
  const list = (points: readonly { x: number; y: number }[]) =>
    points.map((point, identifier) => ({
      identifier,
      clientX: point.x,
      clientY: point.y,
    }));
  Object.defineProperties(event, {
    touches: { value: list(touches) },
    targetTouches: { value: list(touches) },
    changedTouches: { value: list(changed) },
  });
  act(() => {
    cropTarget().dispatchEvent(event);
  });
};

beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  ui = createMediaUiStore();
  cropper.props = null;
  window.sessionStorage.clear();
  window.localStorage.clear();
  for (const spy of Object.values(spies)) spy.mockReset();
  spies.continueUploads.mockImplementation(async () => undefined);
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
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  document.body.replaceChildren();
  vi.useRealTimers();
});

const three = () => [item("a"), item("b"), item("c")];

describe("EditScreen", () => {
  it("draws mockup B's 编辑: counter bar, full-bleed stage, round tools, ratio row and strip", () => {
    render({ items: three() });
    const shown = screen()!;
    expect(shown.getAttribute("data-editor-layout")).toBe("phone");
    const heading = shown.querySelector("[data-editor-step-heading]")!;
    expect(heading.textContent).toBe("1 / 3第 1 项，共 3 项");
    expect(heading.firstElementChild!.getAttribute("aria-hidden")).toBe("true");
    expect(button("返回").querySelector('[data-icon="back"]')).not.toBe(null);
    const next = shown.querySelector<HTMLButtonElement>("[data-edit-next]")!;
    expect(next.textContent).toBe("下一步");
    expect(names(next)).toEqual(["textButton", "next"]);

    // The stage: full-bleed, focusable for ← →, the photo in the cropper's box.
    expect(names(stage())).toEqual(["stage"]);
    expect(stage().tabIndex).toBe(0);
    expect(stage().getAttribute("aria-label")).toBe(
      "裁剪区域。拖动调整位置，双指缩放；左右方向键切换照片",
    );
    expect(stage().getAttribute("data-guide")).toBe("off");
    expect(names(stage().parentElement!)).toEqual(["editBody"]);
    const viewport = shown.querySelector("[data-media-crop]")!;
    expect(names(viewport)).toEqual(["cropBox"]);
    expect(plain(cropper.props!.classes.cropAreaClassName)).toBe(
      "stageCropArea",
    );
    expect(cropper.props!.showGrid).toBe(false);
    expect(cropper.props!.objectFit).toBe("contain");
    expect(cropper.props!.image).toBe("/display/a");
    expect(cropper.props!.aspect).toBeCloseTo(4 / 3);
    expect(cropper.props!.cropperProps.tabIndex).toBe(0);
    // No visible hint row: its words stay the crop area's description.
    const described = document.getElementById(
      cropper.props!.cropperProps["aria-describedby"],
    )!;
    expect(described.textContent).toContain("双指缩放");
    expect(described.closest("[data-media-crop]")).toBe(null);

    // Round tools on the stage; a ready photo shows no state at all.
    const guide = shown.querySelector<HTMLButtonElement>("[data-edit-guide]")!;
    expect(guide.getAttribute("aria-label")).toBe("动态流参考线");
    expect(guide.getAttribute("aria-pressed")).toBe("false");
    expect(names(guide)).toEqual(["fab"]);
    expect(names(guide.parentElement!)).toEqual(["stageTop"]);
    const revert = button("还原");
    expect(revert.getAttribute("title")).toBe("还原");
    expect(revert.getAttribute("aria-disabled")).toBe("true");
    const rotate = button("向右旋转 90°");
    expect(rotate.getAttribute("title")).toBe("旋转");
    expect(names(rotate.parentElement!)).toEqual(["stageRail"]);
    expect([...rotate.parentElement!.children]).toEqual([revert, rotate]);
    expect(shown.querySelector("[data-edit-status]")!.childElementCount).toBe(
      0,
    );
    // Photos change from the strip or the keys: no edge arrows, no tools row.
    expect(shown.querySelector("[data-edge]")).toBe(null);
    expect(shown.querySelector("[data-edit-tools]")).toBe(null);

    // Ratio row: one segmented radio group, each segment with its shape.
    const group = shown.querySelector("[data-edit-ratio]")!;
    expect(group.getAttribute("role")).toBe("radiogroup");
    expect(group.getAttribute("aria-label")).toBe("裁剪比例");
    expect(names(group)).toEqual(["segment"]);
    const radios = [...group.querySelectorAll("[role='radio']")];
    expect(radios.map((radio) => radio.textContent)).toEqual([
      "原始比例",
      "4:5",
      "3:4",
      "1:1",
      "4:3",
    ]);
    expect(checkedRatios()).toEqual(["原始比例"]);
    expect(radios.map((radio) => radio.getAttribute("tabindex"))).toEqual([
      "0",
      "-1",
      "-1",
      "-1",
      "-1",
    ]);
    for (const radio of radios)
      expect(radio.querySelector("svg")).not.toBe(null);
    expect(shown.textContent).not.toContain("裁剪比例");

    // The strip row: the strip, +, a divider and 应用到全部, off while all match.
    const strip = shown.querySelector("[data-edit-strip]")!;
    expect(strip.querySelectorAll("[data-edit-thumb]")).toHaveLength(3);
    expect(thumb("a").getAttribute("aria-current")).toBe("true");
    expect(applyAll().textContent).toBe("应用到全部");
    expect(applyAll().getAttribute("aria-disabled")).toBe("true");
    const row = applyAll().parentElement!;
    expect(names(row)).toEqual(["stripRow"]);
    expect(names(row.parentElement!)).toEqual(["editBand"]);
    // DOM order strip, +, divider, 应用到全部 (the row draws it mirrored),
    // then the strip's hint: + follows the last photo outside the scroller
    // (r4 F3); photo 1 carries its 首图 badge.
    expect([...row.children].map((child) => names(child)[0])).toEqual([
      "strip",
      "stripAddCell",
      "stripDivider",
      "applyButton",
      "stripHint",
    ]);
    const add = row.querySelector("[data-edit-add]")!;
    expect(add.getAttribute("aria-label")).toBe("添加照片");
    expect(add.closest("[data-edit-strip]")).toBe(null);
    expect(
      [...strip.querySelectorAll("[data-edit-mark]")].map(
        (mark) => mark.textContent,
      ),
    ).toEqual(["首图"]);
  });

  it("frames the largest box of the ratio the stage holds, with the photo just covering it", () => {
    const stageBox = { width: 390, height: 600 };
    // 4:3 at 原始比例: the frame is the photo, the stage's width.
    expect(cropperBox(stageBox, 4 / 3, { width: 4, height: 3 }, false)).toEqual(
      { width: 390, height: 600 },
    );
    // 4:5 on a 4:3 photo: a 390 × 487.5 frame, the photo 650 × 487.5; the
    // box keeps the stage's height so a drag anywhere on it moves the photo.
    expect(cropperBox(stageBox, 0.8, { width: 4, height: 3 }, false)).toEqual({
      width: 650,
      height: 600,
    });
    // A tall frame limited by the stage's height.
    expect(cropperBox(stageBox, 0.5, { width: 1, height: 3 }, false)).toEqual({
      width: 390,
      height: 900,
    });
    // Turned (3:4 as shown): the box is square around the photo's long side.
    expect(cropperBox(stageBox, 0.75, { width: 3, height: 4 }, true)).toEqual({
      width: 520,
      height: 600,
    });
    expect(cropperBox(stageBox, 0, { width: 3, height: 4 }, false)).toBe(null);
  });

  it("never keeps the cropper's own re-report of a stored crop", () => {
    vi.useFakeTimers();
    const square = { x: 0.125, y: 0, width: 0.75, height: 1 };
    render({ items: [item("a", { rotation: 0, crop: square })] });
    expect(checkedRatios()).toEqual(["1:1"]);
    expect(cropper.props!.initialCroppedAreaPercentages).toEqual({
      x: 12.5,
      y: 0,
      width: 75,
      height: 100,
    });
    act(() =>
      cropper.props!.onCropAreaChange({
        x: 12.50004,
        y: 0,
        width: 74.99996,
        height: 100,
      }),
    );
    act(() => vi.advanceTimersByTime(2000));
    act(() => root.unmount());
    expect(spies.applyEdit).not.toHaveBeenCalled();
    root = createRoot(container);
  });

  it("never keeps a seeded photo's clamped re-report the author did not cause", () => {
    vi.useFakeTimers();
    // A full-width crop of a turned photo the cropper cannot show at zoom 1.
    const wide = { x: 0, y: 0.1, width: 1, height: 0.6 };
    render({
      items: [item("a", { rotation: 90, crop: wide }), item("b")],
    });
    // It seeds, moves itself there and reports a narrower area.
    act(() => cropper.props!.onCropChange({ x: 0, y: 14 }));
    mountReport({ x: 9.375, y: 9.375, width: 81.25, height: 60 });
    act(() => vi.advanceTimersByTime(2000));
    click(thumb("b"));
    act(() => root.unmount());
    expect(spies.applyEdit).not.toHaveBeenCalled();
    root = createRoot(container);
  });

  it("never stores a turned photo's mount report on a switch back, a new source or a remount (review r2)", () => {
    vi.useFakeTimers();
    const turned = (displaySrc: string) =>
      new Map([["a", server("a", undefined, displaySrc)]]);
    const setup: Setup = {
      items: [item("a", { rotation: 90, crop: null }), item("b")],
      servers: turned("/display/a"),
    };
    render(setup);
    // What react-easy-crop reports by itself for a turned 4:3 on a wide layout.
    const report = { x: 9.375, y: 9.375, width: 81.25, height: 81.25 };
    mountReport(report);
    act(() => vi.advanceTimersByTime(2000));
    // (1) away and back.
    click(thumb("b"));
    click(thumb("a"));
    expect(cropper.props!.initialCroppedAreaPercentages).toBeUndefined();
    mountReport(report);
    act(() => vi.advanceTimersByTime(2000));
    // (2) the account's derivative replaces the source.
    render({ ...setup, servers: turned("/display/a-derivative") });
    expect(cropper.props!.image).toBe("/display/a-derivative");
    mountReport(report);
    act(() => vi.advanceTimersByTime(2000));
    // (3) a remount (a layout swap).
    act(() => root.unmount());
    root = createRoot(container);
    render(setup);
    expect(cropper.props!.initialCroppedAreaPercentages).toBeUndefined();
    mountReport(report);
    act(() => vi.advanceTimersByTime(2000));
    act(() => root.unmount());
    root = createRoot(container);
    expect(spies.applyEdit).not.toHaveBeenCalled();
  });

  it("keeps a turn once, and never the mount report that follows it", () => {
    vi.useFakeTimers();
    render({ items: [item("a"), item("b")] });
    click(button("向右旋转 90°"));
    expect(spies.applyEdit).toHaveBeenCalledExactlyOnceWith("a", {
      rotation: 90,
      crop: null,
    });
    mountReport({ x: 9.375, y: 9.375, width: 81.25, height: 81.25 });
    act(() => vi.advanceTimersByTime(2000));
    click(thumb("b"));
    click(thumb("a"));
    mountReport({ x: 9.375, y: 9.375, width: 81.25, height: 81.25 });
    act(() => vi.advanceTimersByTime(2000));
    expect(spies.applyEdit).toHaveBeenCalledOnce();
  });

  it("keeps a moved crop 800 ms after the last change, once", () => {
    vi.useFakeTimers();
    const square = { x: 0.125, y: 0, width: 0.75, height: 1 };
    render({ items: [item("a", { rotation: 0, crop: square })] });
    drag({ x: 5, y: 0, width: 75, height: 100 });
    act(() => vi.advanceTimersByTime(799));
    expect(spies.applyEdit).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(1));
    expect(spies.applyEdit).toHaveBeenCalledExactlyOnceWith("a", {
      rotation: 0,
      crop: { x: 0.05, y: 0, width: 0.75, height: 1 },
    });
    expect(album.items[0]!.edit.crop).toEqual({
      x: 0.05,
      y: 0,
      width: 0.75,
      height: 1,
    });
    // The same area reported again is no new edit.
    act(() =>
      cropper.props!.onCropAreaChange({ x: 5, y: 0, width: 75, height: 100 }),
    );
    act(() => vi.advanceTimersByTime(800));
    expect(spies.applyEdit).toHaveBeenCalledOnce();
  });

  it("steps the frame back while a finger is down and fades the stage's buttons", () => {
    render({ items: three() });
    expect(stage().hasAttribute("data-gesture")).toBe(false);
    // A finger on a stage button is no gesture.
    pointer("pointerdown", button("向右旋转 90°"));
    expect(stage().hasAttribute("data-gesture")).toBe(false);
    pointer("pointerdown", cropTarget(), 1);
    pointer("pointerdown", cropTarget(), 2);
    expect(stage().hasAttribute("data-gesture")).toBe(true);
    pointer("pointerup", window, 1);
    expect(stage().hasAttribute("data-gesture")).toBe(true);
    pointer("pointercancel", window, 2);
    expect(stage().hasAttribute("data-gesture")).toBe(false);
    const css = editCss as string;
    expect(css).toMatch(
      /\.stage\[data-gesture\] \.cropBox \{\s*transform: scale\(0\.94\);/u,
    );
    expect(css).toMatch(
      /\.stage\[data-gesture\] \.cropBox \.stageCropArea \{\s*color: var\(--dim-peek\);/u,
    );
    expect(css).toMatch(/\.stage\[data-gesture\] \.thirds \{\s*opacity: 1;/u);
  });

  it("keeps a turn, a ratio and 还原 at once", () => {
    render({ items: three() });
    click(button("向右旋转 90°"));
    expect(spies.applyEdit).toHaveBeenLastCalledWith("a", {
      rotation: 90,
      crop: null,
    });
    expect(cropper.props!.rotation).toBe(90);
    expect(cropper.props!.aspect).toBeCloseTo(3 / 4);
    expect(toastText()).toBe("已向右旋转 90°撤销");

    click(ratio("4:5"));
    // Turned, the frame is 3000 × 4000: the centred 4:5 box.
    expect(spies.applyEdit).toHaveBeenLastCalledWith("a", {
      rotation: 90,
      crop: { x: 0, y: 0.03125, width: 1, height: 0.9375 },
    });
    expect(cropper.props!.aspect).toBeCloseTo(4 / 5);
    expect(checkedRatios()).toEqual(["4:5"]);
    expect(ratio("4:5").tabIndex).toBe(0);
    // The other photos are still 原始比例.
    expect(applyAll().getAttribute("aria-disabled")).toBe("false");
    // The same ratio again changes nothing.
    click(ratio("4:5"));
    expect(spies.applyEdit).toHaveBeenCalledTimes(2);

    const revert = button("还原");
    expect(revert.getAttribute("aria-disabled")).toBe("false");
    click(revert);
    expect(spies.applyEdit).toHaveBeenLastCalledWith("a", {
      rotation: 0,
      crop: null,
    });
    expect(checkedRatios()).toEqual(["原始比例"]);
    expect(applyAll().getAttribute("aria-disabled")).toBe("true");
    expect(button("还原").getAttribute("aria-disabled")).toBe("true");
    expect(toastText()).toBe("第 1 项已还原撤销");
    // Nothing left to restore: 还原 does nothing.
    click(button("还原"));
    expect(spies.applyEdit).toHaveBeenCalledTimes(3);
  });

  it("takes a turn and 还原 back from their toast", () => {
    const square = { x: 0.125, y: 0, width: 0.75, height: 1 };
    render({ items: [item("a", { rotation: 0, crop: square }), item("b")] });
    click(button("向右旋转 90°"));
    // A turn keeps the ratio and starts its crop again, centred.
    expect(album.items[0]!.edit).toEqual({
      rotation: 90,
      crop: { x: 0, y: 0.125, width: 1, height: 0.75 },
    });
    undo();
    expect(spies.applyEdit).toHaveBeenLastCalledWith("a", {
      rotation: 0,
      crop: square,
    });
    expect(album.items[0]!.edit).toEqual({ rotation: 0, crop: square });
    expect(cropper.props!.rotation).toBe(0);
    expect(checkedRatios()).toEqual(["1:1"]);
    expect(cropper.props!.initialCroppedAreaPercentages).toEqual({
      x: 12.5,
      y: 0,
      width: 75,
      height: 100,
    });
    expect(container.querySelector("[data-edit-undo]")).toBe(null);

    click(button("还原"));
    expect(album.items[0]!.edit).toEqual({ rotation: 0, crop: null });
    // Taken back after switching away: the photo still gets its crop back.
    click(thumb("b"));
    undo();
    expect(album.items[0]!.edit).toEqual({ rotation: 0, crop: square });
    click(thumb("a"));
    expect(checkedRatios()).toEqual(["1:1"]);
  });

  it("brings the cover's composition back with the 撤销 of a turn or 还原 of the 首图", () => {
    const square = { x: 0.125, y: 0, width: 0.75, height: 1 };
    const composed = { x: 0.1, y: 0.1, width: 0.5, height: 0.5 };
    render({
      items: [item("a", { rotation: 0, crop: square }), item("b")],
      coverCrop: composed,
    });
    act(() => ui.setNotice("图片编辑后，封面构图已恢复为完整画面，可重新调整"));

    // A turn of the 首图 resets the cover's composition; 撤销 brings both back.
    click(button("向右旋转 90°"));
    expect(album.items[0]!.edit.rotation).toBe(90);
    expect(album.coverCrop).toBe(null);
    undo();
    expect(album.items[0]!.edit).toEqual({ rotation: 0, crop: square });
    expect(album.coverCrop).toEqual(composed);
    expect(ui.get().notice).toBe(null);

    // 还原 as well, taken back after switching to another photo.
    click(button("还原"));
    expect(album.items[0]!.edit).toEqual({ rotation: 0, crop: null });
    expect(album.coverCrop).toBe(null);
    click(thumb("b"));
    undo();
    expect(album.items[0]!.edit).toEqual({ rotation: 0, crop: square });
    expect(album.coverCrop).toEqual(composed);

    // Another photo's turn never touched the composition: its 撤销 leaves
    // a composition made since as it is.
    click(button("向右旋转 90°"));
    expect(album.items[1]!.edit.rotation).toBe(90);
    const recomposed = { x: 0, y: 0, width: 0.4, height: 0.4 };
    act(() => replaceAlbum({ ...album, coverCrop: recomposed }));
    undo();
    expect(album.items[1]!.edit.rotation).toBe(0);
    expect(album.coverCrop).toEqual(recomposed);
  });

  it("leaves the cover's composition reset when the cover moved to another photo since the turn", () => {
    const composed = { x: 0.1, y: 0.1, width: 0.5, height: 0.5 };
    render({ items: [item("a"), item("b")], coverCrop: composed });
    click(button("向右旋转 90°"));
    expect(album.coverCrop).toBe(null);
    // The composition belonged to photo 1 as the cover; once another photo
    // is the cover, 撤销 brings back only photo 1's edit.
    act(() => replaceAlbum({ ...album, coverKey: "b" }));
    undo();
    expect(album.items[0]!.edit.rotation).toBe(0);
    expect(album.coverCrop).toBe(null);
  });

  it("applies the chosen ratio to every photo that differs in one album edit, and 撤销 takes it back", () => {
    const placed = { x: 0.1, y: 0.4, width: 0.3, height: 0.5 };
    const composed = { x: 0, y: 0, width: 0.5, height: 0.5 };
    render({
      items: [item("a"), item("b"), item("c", { rotation: 0, crop: placed })],
      coverKey: "b",
      coverCrop: composed,
    });
    click(ratio("4:5"));
    spies.setMedia.mockClear();
    act(() => applyAll().focus());
    click(applyAll());
    expect(spies.setMedia).toHaveBeenCalledOnce();
    const centred = { x: 0.2, y: 0, width: 0.6, height: 1 };
    expect(album.items.map((entry) => entry.edit.crop)).toEqual([
      centred,
      centred,
      // Already 4:5: its author's position stays.
      placed,
    ]);
    // The cover's composition followed its edit (the dialog's notice).
    expect(album.coverCrop).toBe(null);
    expect(spies.showNotice).toHaveBeenCalledWith(
      "图片编辑后，封面构图已恢复为完整画面，可重新调整",
      undefined,
    );
    expect(toastText()).toBe("已应用到全部 3 项撤销");
    // Nothing differs now: 已应用, until something changes.
    expect(applyAll().textContent).toBe("已应用");
    expect(applyAll().getAttribute("aria-disabled")).toBe("true");
    expect(applyAll().hasAttribute("data-done")).toBe(true);
    // Off without `disabled`: focus stays on it, never on the page.
    expect(applyAll().disabled).toBe(false);
    expect(document.activeElement).toBe(applyAll());
    spies.setMedia.mockClear();
    click(applyAll());
    expect(spies.setMedia).not.toHaveBeenCalled();

    undo();
    expect(album.items.map((entry) => entry.edit.crop)).toEqual([
      centred,
      null,
      placed,
    ]);
    expect(album.coverCrop).toEqual(composed);
    expect(ui.get().notice).toBe(null);
    expect(applyAll().textContent).toBe("应用到全部");
    expect(applyAll().getAttribute("aria-disabled")).toBe("false");
  });

  it("says how many photos 应用到全部 reached and which it left, staying 应用到全部 until they can take it", () => {
    const servers = new Map<string, PublishingMediaItem | null>([["c", null]]);
    const items = [
      item("a"),
      item("b"),
      item("c"),
      item("d", undefined, "legacy"),
    ];
    render({ items, servers });
    click(ratio("4:5"));
    act(() => applyAll().focus());
    click(applyAll());
    const centred = { x: 0.2, y: 0, width: 0.6, height: 1 };
    // c's size is not known yet; d is a carried-over photo.
    expect(album.items.map((entry) => entry.edit.crop)).toEqual([
      centred,
      centred,
      null,
      null,
    ]);
    expect(toastText()).toBe("已应用到 2 项，1 项暂不能裁剪，1 项不能裁剪撤销");
    // Not 已应用 while c waits: nothing more to apply for now.
    expect(applyAll().textContent).toBe("应用到全部");
    expect(applyAll().getAttribute("aria-disabled")).toBe("true");
    expect(document.activeElement).toBe(applyAll());

    // Its size arrives: it differs, so 应用到全部 is on again.
    render({ items, servers: new Map() });
    expect(applyAll().getAttribute("aria-disabled")).toBe("false");
    click(applyAll());
    expect(album.items[2]!.edit.crop).toEqual(centred);
    expect(toastText()).toBe("已应用到 3 项，1 项不能裁剪撤销");
    expect(applyAll().textContent).toBe("已应用");
  });

  it("applies 原始比例 to every photo too, and 已应用 lasts until the author changes something", () => {
    const square = { x: 0.125, y: 0, width: 0.75, height: 1 };
    render({
      items: [
        item("a"),
        item("b", { rotation: 0, crop: square }),
        item("c", {
          rotation: 90,
          crop: { x: 0, y: 0, width: 1, height: 0.5 },
        }),
      ],
    });
    expect(applyAll().getAttribute("aria-disabled")).toBe("false");
    click(applyAll());
    expect(album.items.map((entry) => entry.edit)).toEqual([
      { rotation: 0, crop: null },
      { rotation: 0, crop: null },
      // Rotation is never touched.
      { rotation: 90, crop: null },
    ]);
    expect(applyAll().textContent).toBe("已应用");
    // A gesture that moved the crop sets 已应用 aside.
    drag({ x: 10, y: 10, width: 80, height: 80 });
    expect(applyAll().textContent).toBe("应用到全部");
    expect(applyAll().getAttribute("aria-disabled")).toBe("true");
  });

  it("offers nothing to apply for a stored shape outside the phone set", () => {
    // 16:9 inside a 4000 × 3000 frame.
    const banner = { x: 0, y: 0.125, width: 1, height: 0.75 };
    render({ items: [item("a", { rotation: 0, crop: banner }), item("b")] });
    expect(checkedRatios()).toEqual([]);
    expect(ratio("原始比例").tabIndex).toBe(0);
    expect(applyAll().getAttribute("aria-disabled")).toBe("true");
  });

  it("moves the ratio with the arrow keys, wrapping, focus following the choice", () => {
    render({ items: three() });
    const first = ratio("原始比例");
    act(() => first.focus());
    key(first, "ArrowLeft");
    expect(checkedRatios()).toEqual(["4:3"]);
    expect(document.activeElement).toBe(ratio("4:3"));
    key(ratio("4:3"), "ArrowRight");
    expect(checkedRatios()).toEqual(["原始比例"]);
    key(ratio("原始比例"), "ArrowDown");
    expect(checkedRatios()).toEqual(["4:5"]);
    expect(document.activeElement).toBe(ratio("4:5"));
    // 4:3 on a 4:3 photo is the whole frame: only 4:5 is a new edit.
    expect(spies.applyEdit).toHaveBeenCalledExactlyOnceWith("a", {
      rotation: 0,
      crop: { x: 0.2, y: 0, width: 0.6, height: 1 },
    });
  });

  it("keeps the crop before switching photos by strip or arrow key", () => {
    render({ items: three(), reducedMotion: false });
    const shownWhenKept: (string | null)[] = [];
    spies.applyEdit.mockImplementation(() => {
      shownWhenKept.push(ui.get().phone.currentKey);
    });
    drag({ x: 10, y: 10, width: 80, height: 80 });
    click(thumb("b"));
    expect(spies.applyEdit).toHaveBeenCalledWith("a", {
      rotation: 0,
      crop: { x: 0.1, y: 0.1, width: 0.8, height: 0.8 },
    });
    expect(shownWhenKept).toEqual([null]);
    expect(title()).toBe("2 / 3第 2 项，共 3 项");
    expect(cropper.props!.image).toBe("/display/b");
    expect(thumb("b").getAttribute("aria-current")).toBe("true");
    // It slides in from its side.
    const slide = () => stage().firstElementChild!;
    expect(names(slide())).toEqual(["slide"]);
    expect(slide().getAttribute("data-enter")).toBe("next");

    // Right to left (r4 D10): ← brings in the next photo, → the previous.
    key(stage(), "ArrowLeft");
    expect(title()).toBe("3 / 3第 3 项，共 3 项");
    key(stage(), "ArrowLeft");
    expect(title()).toBe("3 / 3第 3 项，共 3 项");
    key(stage(), "ArrowRight");
    expect(title()).toBe("2 / 3第 2 项，共 3 项");
    expect(slide().getAttribute("data-enter")).toBe("previous");
    // The arrows inside the crop area move the crop, not the photo shown.
    key(cropTarget(), "ArrowLeft");
    key(cropTarget(), "ArrowRight");
    expect(title()).toBe("2 / 3第 2 项，共 3 项");
  });

  it("never pages on a swipe: one finger always moves the crop", () => {
    render({ items: three() });
    mountReport({ x: 0, y: 0, width: 100, height: 100 });
    const from = { x: 200, y: 200 };
    touch("touchstart", [from], [from]);
    touch("touchend", [], [{ x: 80, y: 205 }]);
    touch("touchstart", [from], [from]);
    touch("touchend", [], [{ x: 320, y: 200 }]);
    expect(title()).toBe("1 / 3第 1 项，共 3 项");
  });

  it("keeps the crop before Back, 下一步 and leaving the screen", () => {
    // A draft: ‹ keeps the crop, then leaves through the leave guard.
    render({ items: three(), openedAs: "draft" });
    drag({ x: 10, y: 10, width: 80, height: 80 });
    click(button("返回"));
    expect(spies.applyEdit).toHaveBeenCalledOnce();
    expect(spies.applyEdit.mock.invocationCallOrder[0]).toBeLessThan(
      spies.onLeave.mock.invocationCallOrder[0]!,
    );
    expect(spies.onBack).not.toHaveBeenCalled();
    expect(sheet()).toBe(null);

    drag({ x: 0, y: 0, width: 50, height: 50 });
    click(button("下一步"));
    expect(spies.applyEdit).toHaveBeenCalledTimes(2);
    expect(spies.onNext).toHaveBeenCalledOnce();
    expect(spies.applyEdit.mock.invocationCallOrder[1]).toBeLessThan(
      spies.onNext.mock.invocationCallOrder[0]!,
    );

    drag({ x: 20, y: 20, width: 50, height: 50 });
    act(() => root.unmount());
    expect(spies.applyEdit).toHaveBeenLastCalledWith("a", {
      rotation: 0,
      crop: { x: 0.2, y: 0.2, width: 0.5, height: 0.5 },
    });
    root = createRoot(container);
  });

  it("resumes a photo's unfinished crop from its draft", () => {
    ui.saveCropDraft("b", {
      basis: { rotation: 0, crop: null },
      rotation: 0,
      stored: { previewable: true, session: startCrop("3:4", null) },
    });
    ui.setCurrentKey("b");
    render({ items: three() });
    expect(title()).toBe("2 / 3第 2 项，共 3 项");
    expect(checkedRatios()).toEqual(["3:4"]);
    // Its own draft is kept as the author works on.
    click(thumb("a"));
    expect(ui.cropDraftFor("a")).not.toBe(null);
  });

  it("removes a photo at once from its ×; 撤销 brings it back, and the removal waits until then", () => {
    vi.useFakeTimers();
    render({ items: three() });
    const cross = () =>
      container.querySelector<HTMLButtonElement>("[data-edit-remove]")!;
    expect(cross().getAttribute("aria-label")).toBe("移除第 1 项");
    act(() => cross().focus());
    click(cross());
    // No confirmation (mockup B): the photo leaves the screen at once.
    expect(sheet()).toBe(null);
    expect(title()).toBe("1 / 2第 1 项，共 2 项");
    expect(container.querySelector('[data-edit-thumb="a"]')).toBe(null);
    expect(cropper.props!.image).toBe("/display/b");
    expect(document.activeElement).toBe(thumb("b"));
    expect(toastText()).toBe("已移除第 1 项撤销");
    expect(spies.remove).not.toHaveBeenCalled();

    undo();
    expect(title()).toBe("1 / 3第 1 项，共 3 项");
    expect(thumb("a").getAttribute("aria-current")).toBe("true");
    expect(document.activeElement).toBe(thumb("a"));
    act(() => vi.advanceTimersByTime(5000));
    expect(spies.remove).not.toHaveBeenCalled();

    // Once 撤销 runs out, the removal goes through (its upload is cancelled).
    click(cross());
    act(() => vi.advanceTimersByTime(4199));
    expect(spies.remove).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(1));
    expect(spies.remove).toHaveBeenCalledExactlyOnceWith("a");
    expect(title()).toBe("1 / 2第 1 项，共 2 项");

    // Another toast takes 撤销's place: the waiting removal goes first.
    click(cross());
    expect(title()).toBe("1 / 1第 1 项，共 1 项");
    expect(spies.remove).toHaveBeenCalledTimes(1);
    click(button("向右旋转 90°"));
    expect(spies.remove).toHaveBeenLastCalledWith("b");
    expect(spies.applyEdit).toHaveBeenLastCalledWith("c", {
      rotation: 90,
      crop: null,
    });
    expect(spies.remove.mock.invocationCallOrder[1]).toBeLessThan(
      spies.applyEdit.mock.invocationCallOrder.at(-1)!,
    );

    // The last photo leaves nothing to edit: the start screen takes its
    // removal over (with the same 撤销 there); nothing is removed here.
    click(cross());
    expect(spies.onRemoveLast).toHaveBeenCalledExactlyOnceWith("c");
    expect(spies.remove).toHaveBeenCalledTimes(2);
    expect(spies.onBack).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(5000));
    expect(spies.remove).toHaveBeenCalledTimes(2);
  });

  it("keeps the last photo's crop before the start screen takes its removal over", () => {
    render({ items: [item("a")] });
    drag({ x: 10, y: 10, width: 80, height: 80 });
    click(container.querySelector<HTMLButtonElement>("[data-edit-remove]")!);
    expect(spies.applyEdit).toHaveBeenCalledExactlyOnceWith("a", {
      rotation: 0,
      crop: { x: 0.1, y: 0.1, width: 0.8, height: 0.8 },
    });
    expect(spies.applyEdit.mock.invocationCallOrder[0]).toBeLessThan(
      spies.onRemoveLast.mock.invocationCallOrder[0]!,
    );
    expect(spies.onRemoveLast).toHaveBeenCalledExactlyOnceWith("a");
    expect(spies.remove).not.toHaveBeenCalled();
  });

  it("holds 撤销 while focus or a pointer is on it, and gives focus to the stage after it", () => {
    vi.useFakeTimers();
    render({ items: three() });
    click(container.querySelector<HTMLButtonElement>("[data-edit-remove]")!);
    const undoButton = () =>
      container.querySelector<HTMLButtonElement>("[data-edit-undo]");
    act(() => undoButton()!.focus());
    act(() => vi.advanceTimersByTime(10_000));
    expect(spies.remove).not.toHaveBeenCalled();
    expect(undoButton()).not.toBe(null);
    // Focus leaves: the rest of its time runs.
    act(() => stage().focus());
    act(() => vi.advanceTimersByTime(4199));
    expect(spies.remove).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(1));
    expect(spies.remove).toHaveBeenCalledExactlyOnceWith("a");
    // While it fades, a tap goes through (its 撤销 is gone).
    expect(
      container
        .querySelector("[data-edit-toasts] > div")!
        .hasAttribute("data-leaving"),
    ).toBe(true);
    expect(editCss as string).toMatch(
      /\.toast\[data-leaving\] \{[^}]*pointer-events: none;/u,
    );

    // A pointer resting on it holds it too.
    click(button("向右旋转 90°"));
    const toast = () => container.querySelector("[data-edit-toasts] > div")!;
    pointer("pointerover", toast());
    act(() => vi.advanceTimersByTime(10_000));
    expect(undoButton()).not.toBe(null);
    pointer("pointerout", toast());
    act(() => vi.advanceTimersByTime(4200 + 220));
    expect(undoButton()).toBe(null);

    // 撤销 goes with its toast: focus lands on the stage, not the page.
    click(button("向右旋转 90°"));
    act(() => undoButton()!.focus());
    undo();
    expect(document.activeElement).toBe(stage());
  });

  it("ends 应用到全部's 撤销 once the author moves to another photo or drags", () => {
    render({ items: three() });
    click(ratio("4:5"));
    click(applyAll());
    expect(container.querySelector("[data-edit-undo]")).not.toBe(null);
    // Another photo: its 撤销 would overwrite what the author does there.
    click(thumb("b"));
    expect(container.querySelector("[data-edit-undo]")).toBe(null);
    expect(album.items.map((entry) => entry.edit.crop)).toEqual([
      { x: 0.2, y: 0, width: 0.6, height: 1 },
      { x: 0.2, y: 0, width: 0.6, height: 1 },
      { x: 0.2, y: 0, width: 0.6, height: 1 },
    ]);

    click(ratio("1:1"));
    click(applyAll());
    expect(container.querySelector("[data-edit-undo]")).not.toBe(null);
    drag({ x: 10, y: 0, width: 75, height: 100 });
    expect(container.querySelector("[data-edit-undo]")).toBe(null);
  });

  it("shows a photo's edit changed elsewhere at once, and never keeps the crop it replaced", () => {
    vi.useFakeTimers();
    const top = { x: 0, y: 0, width: 1, height: 0.9375 };
    render({ items: [item("a"), item("b", { rotation: 90, crop: top })] });
    click(thumb("b"));
    expect(checkedRatios()).toEqual(["4:5"]);
    const seeded = cropper.props!.initialCroppedAreaPercentages;
    // A version chosen elsewhere puts a 1:1 crop on the photo shown.
    const square = { x: 0, y: 0.125, width: 1, height: 0.75 };
    act(() =>
      replaceAlbum({
        ...album,
        items: album.items.map((entry) =>
          entry.key === "b"
            ? { ...entry, edit: { rotation: 90, crop: square } }
            : entry,
        ),
      }),
    );
    // The stage starts again from it: its ratio, and the cropper reseeded.
    expect(checkedRatios()).toEqual(["1:1"]);
    expect(cropper.props!.initialCroppedAreaPercentages).not.toEqual(seeded);
    expect(cropper.props!.initialCroppedAreaPercentages).toEqual({
      x: 0,
      y: 12.5,
      width: 100,
      height: 75,
    });
    // Nothing of the replaced crop is kept on the way out.
    act(() => vi.advanceTimersByTime(2000));
    click(button("下一步"));
    expect(spies.applyEdit).not.toHaveBeenCalled();
    expect(album.items[1]!.edit).toEqual({ rotation: 90, crop: square });
  });

  it("keeps a drag the desktop dialog handed over, as the stage's own", () => {
    const moved = { x: 0.1, y: 0, width: 0.8, height: 1 };
    // `adoptDesktopDialog` marks a touched, moved crop as the author's.
    ui.saveCropDraft("b", {
      basis: { rotation: 0, crop: null },
      rotation: 0,
      stored: {
        previewable: true,
        session: { ...startCrop("original", null), area: moved, touched: true },
      },
      explicit: true,
    });
    ui.setCurrentKey("b");
    render({ items: three() });
    // The stage shows it where the dialog left it.
    expect(cropper.props!.initialCroppedAreaPercentages).toEqual({
      x: 10,
      y: 0,
      width: 80,
      height: 100,
    });
    click(button("下一步"));
    expect(spies.applyEdit).toHaveBeenCalledExactlyOnceWith("b", {
      rotation: 0,
      crop: moved,
    });
  });

  it("keeps a turn the desktop dialog handed over, as the stage's own", () => {
    ui.saveCropDraft("b", {
      basis: { rotation: 0, crop: null },
      rotation: 90,
      stored: null,
      explicit: true,
    });
    ui.setCurrentKey("b");
    render({ items: three() });
    expect(cropper.props!.rotation).toBe(90);
    click(button("下一步"));
    expect(spies.applyEdit).toHaveBeenCalledExactlyOnceWith("b", {
      rotation: 90,
      crop: null,
    });
    expect(spies.onNext).toHaveBeenCalledOnce();
  });

  it("says which photo the stage's arrow keys brought in", () => {
    render({
      items: three(),
      statuses: new Map<string, ItemStatus>([
        ["c", { kind: "uploading", label: "上传中 42%", percent: 42 }],
      ]),
    });
    key(stage(), "ArrowLeft");
    expect(spies.announce).toHaveBeenLastCalledWith("第 2 项，共 3 项");
    key(stage(), "ArrowLeft");
    expect(spies.announce).toHaveBeenLastCalledWith(
      "第 3 项，共 3 项，上传中 42%",
    );
    spies.announce.mockClear();
    // Nothing further: nothing said.
    key(stage(), "ArrowLeft");
    expect(spies.announce).not.toHaveBeenCalled();
  });

  it("measures the cropper again once a peek it was mounted under is gone", () => {
    vi.useFakeTimers();
    render({ items: three() });
    const computeSizes = vi.fn();
    const instance = () => {
      cropper.props!.ref!.current = { computeSizes };
    };
    instance();
    // A plain drag measures nothing: nothing to redo.
    drag({ x: 10, y: 10, width: 80, height: 80 });
    act(() => vi.advanceTimersByTime(1000));
    expect(computeSizes).not.toHaveBeenCalled();

    // An interrupted touch remounts the cropper under the 0.94 peek: it
    // measures the scaled box.
    pointer("pointerdown", cropTarget());
    act(() => cropper.props!.onCropSizeChange!({ width: 300, height: 300 }));
    instance();
    pointer("pointerup", window);
    act(() => vi.advanceTimersByTime(399));
    expect(computeSizes).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(1));
    expect(computeSizes).toHaveBeenCalledExactlyOnceWith({
      isResizeTriggered: true,
    });

    // Measured while the peek is still easing out: redone as well.
    pointer("pointerdown", cropTarget());
    pointer("pointerup", window);
    act(() => vi.advanceTimersByTime(100));
    act(() => cropper.props!.onCropSizeChange!({ width: 310, height: 310 }));
    act(() => vi.advanceTimersByTime(400));
    expect(computeSizes).toHaveBeenCalledTimes(2);
  });

  it("hands the editor's Back what ‹ keeps: the crop, then a waiting removal", () => {
    const commitRef: { current: (() => void) | null } = { current: null };
    render({ items: three(), commitRef });
    expect(commitRef.current).toBeTypeOf("function");
    drag({ x: 10, y: 10, width: 80, height: 80 });
    act(() => commitRef.current!());
    expect(spies.applyEdit).toHaveBeenCalledExactlyOnceWith("a", {
      rotation: 0,
      crop: { x: 0.1, y: 0.1, width: 0.8, height: 0.8 },
    });

    click(container.querySelector<HTMLButtonElement>("[data-edit-remove]")!);
    expect(spies.remove).not.toHaveBeenCalled();
    act(() => commitRef.current!());
    expect(spies.remove).toHaveBeenCalledExactlyOnceWith("a");

    act(() => root.unmount());
    expect(commitRef.current).toBe(null);
    root = createRoot(container);
  });

  it("puts a waiting removal through before leaving the screen", () => {
    render({ items: three(), openedAs: "draft" });
    click(container.querySelector<HTMLButtonElement>("[data-edit-remove]")!);
    click(button("返回"));
    expect(spies.remove).toHaveBeenCalledExactlyOnceWith("a");
    expect(spies.remove.mock.invocationCallOrder[0]).toBeLessThan(
      spies.onLeave.mock.invocationCallOrder[0]!,
    );

    click(container.querySelector<HTMLButtonElement>("[data-edit-remove]")!);
    act(() => root.unmount());
    expect(spies.remove).toHaveBeenLastCalledWith("b");
    root = createRoot(container);
  });

  it("shows the photo's state on the stage: nothing when ready, a chip while pending, a button to its fix sheet", () => {
    const retry = { type: "registration" } as const;
    render({
      items: [item("a"), item("b"), item("c"), item("d")],
      views: new Map([["a", { phase: "failed" }]]),
      statuses: new Map<string, ItemStatus>([
        ["a", { kind: "failed", label: "失败", message: "网络中断", retry }],
        ["b", { kind: "uploading", label: "上传中 42%", percent: 42 }],
        [
          "c",
          {
            kind: "failed",
            label: "失败",
            message: "编辑处理失败，可重新编辑或移除",
            retry: null,
          },
        ],
      ]),
    });
    const status = () => container.querySelector("[data-edit-status]")!;
    const chip = () => container.querySelector("[data-edit-chip]");
    const said = () =>
      container.querySelector('[data-edit-stage] > [aria-live="polite"]')!
        .textContent;
    const fix = status().querySelector<HTMLButtonElement>("button[data-fix]")!;
    expect(fix.getAttribute("aria-label")).toBe("上传失败，点按处理");
    expect(names(fix)).toEqual(["stageStatus"]);
    expect(chip()!.textContent).toBe("上传失败");
    expect(names(chip()!)).toEqual(["tileChip"]);
    expect(chip()!.querySelector('[data-icon="error"]')).not.toBe(null);
    expect(chip()!.querySelector('[data-icon="next"]')).not.toBe(null);
    expect(said()).toBe("上传失败：网络中断");
    expect(thumb("a").getAttribute("data-attention")).toBe("true");

    // The fix sheet: the remedy first, 取消, then 移除.
    click(fix);
    // The phone screens' shared fix sheet (PhoneSheet).
    const dialog = sheet()!;
    expect(dialog.getAttribute("data-phone-sheet")).toBe("photo-attention");
    expect(
      document.getElementById(dialog.getAttribute("aria-labelledby")!)!
        .textContent,
    ).toBe("上传失败");
    expect(dialog.querySelector("small")!.textContent).toBe("第 1 项");
    expect(dialog.querySelector('span[aria-hidden="true"]')).not.toBe(null);
    expect(
      document.getElementById(dialog.getAttribute("aria-describedby")!)!
        .textContent,
    ).toBe("网络中断");
    const actions = [...dialog.querySelectorAll("button")];
    expect(actions.map((action) => action.textContent)).toEqual([
      "重试",
      "取消",
      "移除",
    ]);
    expect(document.activeElement).toBe(actions[0]);
    click(actions[0]!);
    expect(spies.retry).toHaveBeenCalledExactlyOnceWith("a", retry);
    expect(sheet()).toBe(null);
    expect(toastText()).toBe("正在重新上传第 1 项");
    // The chip turns plain once the upload runs again: focus is on the
    // photo's thumbnail, which stays, never on the page.
    expect(document.activeElement).toBe(thumb("a"));

    // The current photo's thumbnail opens it too; Escape closes it.
    click(thumb("a"));
    expect(sheet()).not.toBe(null);
    act(() => {
      sheet()!.dispatchEvent(new Event("cancel", { cancelable: true }));
    });
    expect(sheet()).toBe(null);

    click(thumb("b"));
    expect(status().querySelector("button")).toBe(null);
    expect(chip()!.textContent).toBe("上传中 42%");
    expect(said()).toBe("");

    // 处理失败 of an edit: 重新编辑 is this screen, so no remedy button.
    click(thumb("c"));
    expect(button("处理失败，点按处理")).not.toBe(null);
    expect(said()).toBe("处理失败：编辑处理失败，可重新编辑或移除");
    click(button("处理失败，点按处理"));
    expect(
      [...sheet()!.querySelectorAll("button")].map(
        (action) => action.textContent,
      ),
    ).toEqual(["取消", "移除"]);
    // 移除 there is the strip's ×: the photo leaves at once, 撤销 offered.
    click(
      sheet()!.querySelector<HTMLButtonElement>(
        '[data-media-action="remove"]',
      )!,
    );
    expect(sheet()).toBe(null);
    expect(toastText()).toBe("已移除第 3 项撤销");
    expect(title()).toBe("3 / 3第 3 项，共 3 项");
    expect(thumb("d").getAttribute("aria-current")).toBe("true");
    expect(status().childElementCount).toBe(0);
  });

  it("offers each photo's remedy in its fix sheet", () => {
    const retry = { type: "registration" } as const;
    render({
      items: ["a", "b", "c", "d"].map((key) => item(key)),
      views: new Map([["a", { phase: "failed" }]]),
      statuses: new Map<string, ItemStatus>([
        ["a", { kind: "failed", label: "失败", message: "网络中断", retry }],
        ["b", { kind: "needs_choice", label: "需要选择", message: "无法压缩" }],
        [
          "c",
          {
            kind: "missing_local",
            label: "缺少本地文件",
            message: "请重新选择",
          },
        ],
        ["d", { kind: "paused", label: "已暂停", message: null }],
      ]),
    });
    const remedy = () =>
      sheet()!.querySelector<HTMLButtonElement>("button:first-child")!;
    const open = () =>
      click(container.querySelector<HTMLButtonElement>("button[data-fix]")!);
    open();
    expect(remedy().textContent).toBe("重试");
    expect(remedy().getAttribute("data-media-action")).toBe("retry");
    click(remedy());
    expect(spies.retry).toHaveBeenCalledExactlyOnceWith("a", retry);

    click(thumb("b"));
    open();
    expect(remedy().textContent).toBe("上传原图");
    click(remedy());
    expect(spies.chooseOriginal).toHaveBeenCalledExactlyOnceWith("b");

    click(thumb("c"));
    open();
    expect(sheet()!.querySelector("h2")!.textContent).toBe("缺少本地文件");
    expect(remedy().textContent).toBe("重新选择");
    click(remedy());
    expect(spies.reselect).toHaveBeenCalledExactlyOnceWith("c");

    click(thumb("d"));
    open();
    expect(remedy().textContent).toBe("继续上传");
    expect(sheet()!.textContent).toContain("上传已暂停，确认网络正常后可继续");
    click(remedy());
    expect(spies.continueUploads).toHaveBeenCalledOnce();
  });

  it("still turns a photo it cannot preview", () => {
    render({
      items: [item("a"), item("b")],
      servers: new Map([
        ["a", null],
        ["b", null],
      ]),
      statuses: new Map<string, ItemStatus>([
        [
          "a",
          {
            kind: "missing_local",
            label: "缺少本地文件",
            message: "这台设备上没有这个文件，请重新选择",
          },
        ],
      ]),
    });
    expect(cropper.props).toBe(null);
    const fallback = container.querySelector("[data-edit-fallback]")!;
    expect(names(fallback)).toEqual(["dialogMessage", "stageFallback"]);
    expect(fallback.textContent).toContain(
      "这台设备无法预览这张图片，仍可旋转。",
    );
    expect(container.querySelector("[data-edit-chip]")!.textContent).toBe(
      "缺少文件",
    );
    expect(ratio("4:5").disabled).toBe(true);
    click(button("向右旋转 90°"));
    expect(spies.applyEdit).toHaveBeenCalledWith("a", {
      rotation: 90,
      crop: null,
    });

    click(thumb("b"));
    expect(
      container.querySelector("[data-edit-fallback]")!.textContent,
    ).toContain("这台设备暂时无法预览这张图片，仍可旋转；处理完成后可裁剪。");
  });

  it("shows a carried-over photo whole and says why it cannot be cropped or turned", () => {
    vi.useFakeTimers();
    render({ items: [item("a", undefined, "legacy"), item("b")] });
    // No cropper, so no gesture hint of any kind.
    expect(cropper.props).toBe(null);
    expect(
      container.querySelector("[data-edit-still] img")!.getAttribute("src"),
    ).toBe("/display/a");
    expect(container.textContent).not.toContain("双指缩放");
    expect(container.querySelector("[data-edit-hint]")).toBe(null);
    // The reason, next to the tools it turns off.
    const note = container.querySelector("[data-edit-locked]")!;
    expect(note.textContent).toBe(LEGACY_NOTE);
    expect(note.closest("[data-edit-band]")).not.toBe(null);
    expect(button("向右旋转 90°").disabled).toBe(true);
    expect(ratio("4:5").disabled).toBe(true);
    expect(button("还原").getAttribute("aria-disabled")).toBe("true");
    click(button("还原"));
    click(button("向右旋转 90°"));
    pointer("pointerdown", stage());
    act(() => vi.advanceTimersByTime(2000));
    expect(spies.applyEdit).not.toHaveBeenCalled();
    // The first photo the author can crop gets the first-time hint.
    click(thumb("b"));
    expect(container.querySelector("[data-edit-locked]")).toBe(null);
    expect(
      container.querySelector("[data-edit-hint]")!.hasAttribute("data-show"),
    ).toBe(true);
  });

  it("draws the 动态流参考线 band with its caption once the guide is on", () => {
    render({
      items: [item("tall"), item("wide")],
      servers: new Map([
        ["tall", server("tall", { width: 1000, height: 3000 })],
        ["wide", server("wide")],
      ]),
      stageRatio: 1.25,
    });
    act(() => cropper.props!.onCropSizeChange!({ width: 100, height: 300 }));
    const band = () =>
      container.querySelector<HTMLElement>("[data-feed-window]");
    const guide = () =>
      container.querySelector<HTMLButtonElement>("[data-edit-guide]")!;
    // Off at first (mockup B): the frame and its corner marks only.
    expect(band()).toBe(null);
    const frame = container.querySelector<HTMLElement>("[data-edit-frame]")!;
    expect(frame.style.width).toBe("100px");
    expect(frame.style.height).toBe("300px");
    expect(frame.querySelectorAll("[data-corner]")).toHaveLength(4);
    expect(guide().hasAttribute("aria-describedby")).toBe(false);

    click(guide());
    expect(guide().getAttribute("aria-pressed")).toBe("true");
    expect(stage().getAttribute("data-guide")).toBe("on");
    expect(toastText()).toBe("动态流参考线：亮处是动态流里看到的部分");
    // 1:3 against its own 4:5 stage: the feed shows the middle 41.7 %.
    expect(band()!.getAttribute("data-feed-fit")).toBe("cover");
    const edges = [...band()!.querySelectorAll<HTMLElement>("[data-edge]")];
    for (const edge of edges)
      expect(Number.parseFloat(edge.style.height)).toBeCloseTo(87.5, 3);
    const label = band()!.lastElementChild as HTMLElement;
    expect(label.textContent).toBe("动态流显示范围");
    // 36px above the visible band's foot, 8px in from the frame's side.
    expect(Number.parseFloat(label.style.top)).toBeCloseTo(176.5, 3);
    expect(
      document.getElementById(guide().getAttribute("aria-describedby")!)!
        .textContent,
    ).toContain("上下各裁去 29%");

    click(guide());
    expect(guide().getAttribute("aria-pressed")).toBe("false");
    expect(band()).toBe(null);
    expect(toastText()).toBe("已隐藏动态流参考线");
    click(guide());

    // Another photo is measured against the stage the first one sets.
    click(thumb("wide"));
    act(() => cropper.props!.onCropSizeChange!({ width: 300, height: 225 }));
    expect(band()!.getAttribute("data-feed-fit")).toBe("contain");
    expect(band()!.querySelectorAll("[data-edge]")).toHaveLength(0);
    expect(band()!.textContent).toBe("动态流整张显示");
    expect((band()!.lastElementChild as HTMLElement).style.top).toBe("189px");
  });

  it("turns the guide off while the stage shape is unknown", () => {
    ui.setCurrentKey("b");
    render({ items: [item("a"), item("b")], stageRatio: null });
    const guide =
      container.querySelector<HTMLButtonElement>("[data-edit-guide]")!;
    expect(guide.disabled).toBe(true);
    click(guide);
    expect(guide.hasAttribute("aria-describedby")).toBe(false);
    expect(container.querySelector("[data-feed-window]")).toBe(null);
  });

  it("shows a notice in the band above the ratio row until 知道了, never on the stage", () => {
    render({
      items: [item("a"), item("b")],
      coverKey: "b",
      coverCrop: { x: 0, y: 0, width: 0.5, height: 0.5 },
    });
    expect(container.querySelector("[data-media-notice]")).toBe(null);
    click(ratio("4:5"));
    click(applyAll());
    const notice = container.querySelector("[data-media-notice]")!;
    expect(notice.textContent).toBe(
      "图片编辑后，封面构图已恢复为完整画面，可重新调整知道了",
    );
    expect(notice.closest("[data-edit-stage]")).toBe(null);
    const band = container.querySelector("[data-edit-band]")!;
    expect(names(notice.parentElement!)).toEqual(["bandNotes"]);
    expect(band.firstElementChild).toBe(notice.parentElement);
    click(button("知道了"));
    expect(container.querySelector("[data-media-notice]")).toBe(null);
    expect(ui.get().notice).toBe(null);
  });

  it("shows the first-time hint once, for 2.4 s or until the first touch", () => {
    vi.useFakeTimers();
    render({ items: three() });
    const hint = () => container.querySelector("[data-edit-hint]")!;
    expect(hint().getAttribute("aria-hidden")).toBe("true");
    expect(hint().textContent).toBe(
      "拖动调整位置，双指缩放点缩略图切换，再点一下有更多操作",
    );
    expect(hint().hasAttribute("data-show")).toBe(true);
    act(() => vi.advanceTimersByTime(2399));
    expect(hint().hasAttribute("data-show")).toBe(true);
    act(() => vi.advanceTimersByTime(1));
    expect(hint().hasAttribute("data-show")).toBe(false);

    // Once per tab.
    act(() => root.unmount());
    root = createRoot(container);
    render({ items: three() });
    expect(hint().hasAttribute("data-show")).toBe(false);

    act(() => root.unmount());
    root = createRoot(container);
    window.sessionStorage.clear();
    render({ items: three() });
    expect(hint().hasAttribute("data-show")).toBe(true);
    pointer("pointerdown", cropTarget());
    expect(hint().hasAttribute("data-show")).toBe(false);
  });

  it("says a photo added from the strip once it is in the album", () => {
    spies.onAddFiles.mockImplementation(() =>
      growAlbum([item("d", undefined, "original")]),
    );
    render({ items: three() });
    const input = container.querySelector<HTMLInputElement>(
      '[data-edit-add-cell] input[type="file"]',
    )!;
    const file = new File(["x"], "photo.jpg", { type: "image/jpeg" });
    Object.defineProperty(input, "files", {
      configurable: true,
      value: [file],
    });
    act(() => input.dispatchEvent(new Event("change", { bubbles: true })));
    expect(spies.onAddFiles).toHaveBeenCalledWith([file], "picker");
    expect(toastText()).toBe("已添加第 4 项（原图画质）");
    expect(title()).toBe("1 / 4第 1 项，共 4 项");
  });

  it("leaves out the add tile once the album is full", () => {
    render({ items: three(), maxItems: 3 });
    expect(container.querySelector("[data-edit-add]")).toBe(null);
  });

  it("never brings back a kept crop once the photo's edit returns from elsewhere", () => {
    vi.useFakeTimers();
    const square = { x: 0.125, y: 0, width: 0.75, height: 1 };
    render({ items: [item("a", { rotation: 0, crop: square }), item("b")] });
    click(ratio("4:5"));
    const portrait = { x: 0.2, y: 0, width: 0.6, height: 1 };
    expect(spies.applyEdit).toHaveBeenLastCalledWith("a", {
      rotation: 0,
      crop: portrait,
    });
    // Another photo's 应用到全部 gives 第 1 项 its old edit back.
    click(thumb("b"));
    click(ratio("1:1"));
    click(applyAll());
    expect(album.items[0]!.edit.crop).toEqual(square);
    spies.applyEdit.mockClear();

    click(thumb("a"));
    expect(checkedRatios()).toEqual(["1:1"]);
    act(() => vi.advanceTimersByTime(2000));
    click(thumb("b"));
    expect(spies.applyEdit).not.toHaveBeenCalled();

    // Nor when the screen opens on it again (a version restored on 发布).
    act(() => root.unmount());
    root = createRoot(container);
    ui.setCurrentKey("a");
    render({ items: album.items });
    expect(checkedRatios()).toEqual(["1:1"]);
    act(() => vi.advanceTimersByTime(2000));
    act(() => root.unmount());
    root = createRoot(container);
    expect(spies.applyEdit).not.toHaveBeenCalled();
    expect(album.items[0]!.edit.crop).toEqual(square);
  });

  it("gives the ratio segments and the strip's × whole targets the strip never clips", () => {
    const css = (editCss as string).replace(/\/\*[\s\S]*?\*\//gu, "");
    const rule = (selector: string) => {
      const start = css.indexOf(`${selector} {`);
      expect(start).toBeGreaterThanOrEqual(0);
      return css.slice(start, css.indexOf("}", start)).replace(/\s+/gu, " ");
    };
    // The 44px track pads each segment by space-1: its target reaches back out.
    expect(rule(".segment")).toContain("height: 44px;");
    expect(rule(".segment")).toContain("padding: var(--yoyi-space-1);");
    expect(rule(".segmentButton::before")).toContain(
      "inset: calc(-1 * var(--yoyi-space-1)) 0;",
    );
    // The × sits 6px out with its target 12px above it: 18px of room above;
    // 6px below hold the 首图 badge's overhang. The side gutters are the
    // track's (r4 D8).
    expect(rule(".strip")).toContain(
      "padding: calc(var(--yoyi-space-4) + 6px) 0 6px;",
    );
    const cross = rule(".stripRemove::before");
    expect(cross).toContain("top: -12px;");
    // Never further over the thumbnail than the × itself (r4 F1): a tap on
    // the current photo opens its sheet.
    expect(cross).toContain("bottom: 0;");
    expect(cross).toContain("left: 0;");
    // The × reaches 6px into the 12px gap, its target the rest: never over
    // the next thumbnail.
    expect(cross).toContain("right: -6px;");
    expect(rule(".stripTrack")).toContain("gap: var(--yoyi-space-4);");
  });

  it("declares only tokens, the mockup's token mixes and its shape values", () => {
    // Rules only: the comments cite issues (#244) and precedents.
    const css = (editCss as string).replace(/\/\*[\s\S]*?\*\//gu, "");
    expect(css).not.toMatch(/#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(/iu);
    // The local mixes are mixes of tokens, nothing else.
    for (const local of css.matchAll(
      /--(?:crop-line|dim-mask|dim-peek|dim-band|stage-edge):\s*([^;]+);/gu,
    ))
      expect(local[1]!.replace(/\s+/gu, " ")).toMatch(
        /^color-mix\( ?in srgb, var\(--yoyi-color-[a-z-]+\) \d+%, transparent ?\)$/u,
      );
    const values = [...css.matchAll(/:\s*([^;{}]+);/g)].map((match) =>
      match[1]!.replace(/\s+/gu, " ").trim(),
    );
    for (const value of values) {
      const raw = value
        .replace(/var\(--[a-z0-9-]+(?:, 0px)?\)/gu, "")
        .replace(/env\(safe-area-inset-[a-z]+\)/gu, "");
      expect(raw).not.toMatch(
        /\b(?!(?:0|1|2|3|4|6|12|14|16|20|28|32|36|44|60|112|160)px\b)\d+px/u,
      );
    }
    for (const size of css.matchAll(/font-size:\s*([^;]+);/gu))
      expect(size[1]).toMatch(/^var\(--yoyi-type-[a-z-]+-size\)$/u);
    for (const colour of css.matchAll(
      /(?:^|\s)(?:color|background|border-color|border|box-shadow):\s*([^;]+);/gu,
    ))
      expect(colour[1]).toMatch(
        /var\(--yoyi-|var\(--(?:crop-line|dim-[a-z]+|stage-edge)\)|transparent|^0$|^none$|^inherit$/u,
      );
  });
});

describe("EditScreen order, sheets and Back (r4)", () => {
  /** A key press dnd-kit's keyboard sensor reads, with time for its effects. */
  const sortKey = async (
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

  /** The strip drawn right to left: photo i at `400 − (i + 1) × 56`. */
  const layOut = () =>
    vi
      .spyOn(Element.prototype, "getBoundingClientRect")
      .mockImplementation(function (this: Element) {
        const rect = (left: number, width: number, height: number) =>
          ({
            x: left,
            y: 0,
            top: 0,
            left,
            width,
            height,
            right: left + width,
            bottom: height,
            toJSON: () => ({}),
          }) as DOMRect;
        if (this.hasAttribute("data-edit-strip")) return rect(0, 400, 80);
        const photo = this.closest("[data-edit-index]");
        if (photo === null) return rect(0, 0, 0);
        const index = Number(photo.getAttribute("data-edit-index"));
        return rect(400 - (index + 1) * 56, 44, 44);
      });

  const stripKeys = () =>
    [...container.querySelectorAll("[data-edit-thumb]")].map((entry) =>
      entry.getAttribute("data-edit-thumb"),
    );
  const action = (name: string) =>
    sheet()!.querySelector<HTMLButtonElement>(`[data-media-action="${name}"]`)!;
  const backAction = (name: string) =>
    sheet()!.querySelector<HTMLButtonElement>(`[data-back-action="${name}"]`)!;
  const quietToast = () =>
    container
      .querySelector("[data-edit-toasts] span")!
      .getAttribute("aria-hidden");

  beforeEach(() => {
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
      configurable: true,
      value: vi.fn(),
    });
  });

  afterEach(() => {
    Reflect.deleteProperty(HTMLElement.prototype, "scrollIntoView");
    Reflect.deleteProperty(window, "matchMedia");
    vi.restoreAllMocks();
  });

  it("drops a photo onto 首图 without moving the stage off its photo, pinned before photo 1 changes", async () => {
    render({ items: three() });
    const pinned: (string | null)[] = [];
    spies.reorder.mockImplementation(() =>
      pinned.push(ui.get().phone.currentKey),
    );
    layOut();
    act(() => thumb("c").focus());
    await sortKey(thumb("c"), "Space");
    await sortKey(document, "ArrowRight");
    await sortKey(document, "ArrowRight");
    await sortKey(document, "Space");
    expect(spies.reorder).toHaveBeenCalledExactlyOnceWith("c", 0);
    // A null current key (photo 1 shown) was pinned to a first.
    expect(pinned).toEqual(["a"]);
    expect(album.items.map((entry) => entry.key)).toEqual(["c", "a", "b"]);
    // The stage stays on its photo; only its place changed.
    expect(title()).toBe("2 / 3第 2 项，共 3 项");
    expect(cropper.props!.image).toBe("/display/a");
    expect(thumb("a").getAttribute("aria-current")).toBe("true");
    expect(stripKeys()).toEqual(["c", "a", "b"]);
    // The badge follows the new photo 1; dnd-kit said the move already.
    expect(
      container.querySelector('[data-edit-key="c"] [data-edit-mark]')!
        .textContent,
    ).toBe("首图");
    expect(toastText()).toBe("已设为首图");
    expect(quietToast()).toBe("true");
  });

  it("says a drop elsewhere quietly and keeps focus on the moved photo", async () => {
    render({ items: three() });
    layOut();
    act(() => thumb("a").focus());
    await sortKey(thumb("a"), "Space");
    await sortKey(document, "ArrowLeft");
    await sortKey(document, "Space");
    expect(spies.reorder).toHaveBeenCalledExactlyOnceWith("a", 1);
    expect(toastText()).toBe("顺序已更新");
    expect(quietToast()).toBe("true");
    expect(document.activeElement).toBe(thumb("a"));
    expect(title()).toBe("2 / 3第 2 项，共 3 项");
  });

  it("puts a removal waiting for 撤销 through before a move, so strip places are album places", async () => {
    render({ items: ["a", "b", "c", "d"].map((entry) => item(entry)) });
    click(thumb("b"));
    click(container.querySelector<HTMLButtonElement>("[data-edit-remove]")!);
    expect(stripKeys()).toEqual(["a", "c", "d"]);
    expect(spies.remove).not.toHaveBeenCalled();
    // Alt + → moves 第 3 项 (d) one place towards 首图: onto c's place.
    const event = await sortKey(thumb("d"), "ArrowRight", { altKey: true });
    expect(event.defaultPrevented).toBe(true);
    expect(spies.remove).toHaveBeenCalledExactlyOnceWith("b");
    expect(spies.remove.mock.invocationCallOrder[0]).toBeLessThan(
      spies.reorder.mock.invocationCallOrder[0]!,
    );
    expect(spies.reorder).toHaveBeenCalledExactlyOnceWith("d", 1);
    expect(album.items.map((entry) => entry.key)).toEqual(["a", "d", "c"]);
    expect(toastText()).toBe("已移到第 2 项");
    expect(quietToast()).toBe(null);
    expect(document.activeElement).toBe(thumb("d"));
    // Alt + ← moves it back, away from 首图.
    await sortKey(thumb("d"), "ArrowLeft", { altKey: true });
    expect(spies.reorder).toHaveBeenLastCalledWith("d", 2);
    expect(toastText()).toBe("已移到第 3 项");
  });

  it("keeps 首图 = 封面 on a move: a chosen cover gives way to the new photo 1", async () => {
    render({
      items: three(),
      coverKey: "a",
      coverCrop: { x: 0, y: 0, width: 0.5, height: 0.5 },
    });
    await sortKey(thumb("b"), "ArrowRight", { altKey: true });
    expect(album.items.map((entry) => entry.key)).toEqual(["b", "a", "c"]);
    expect(album.coverKey).toBe(null);
    expect(album.coverCrop).toBe(null);
    expect(spies.showNotice).toHaveBeenCalledExactlyOnceWith(
      COVER_RESET_NOTICE,
      "第 2 项已设为首图",
    );
    expect(container.querySelector("[data-media-notice]")!.textContent).toBe(
      `${COVER_RESET_NOTICE}知道了`,
    );
    // One live region says it (the notice, after the move's words): the
    // toast is only seen.
    expect(toastText()).toBe("已设为首图");
    expect(quietToast()).toBe("true");

    // A move that leaves photo 1 alone keeps the cover as it is.
    spies.showNotice.mockClear();
    act(() => root.unmount());
    root = createRoot(container);
    render({ items: three(), coverKey: "a" });
    await sortKey(thumb("c"), "ArrowRight", { altKey: true });
    expect(album.coverKey).toBe("a");
    expect(spies.showNotice).not.toHaveBeenCalled();
    expect(toastText()).toBe("已移到第 2 项");
    expect(quietToast()).toBe(null);
  });

  it("marks an older draft's chosen cover off photo 1 as 封面 until photo 1 changes", () => {
    render({ items: three(), coverKey: "c" });
    expect(
      container.querySelector('[data-edit-key="c"] [data-edit-mark]')!
        .textContent,
    ).toBe("封面");
    expect(thumb("c").getAttribute("aria-label")).toBe(
      "第 3 项，封面，长按拖动可排序",
    );
  });

  it("offers the current photo's actions from its thumbnail: 设为首图, 前移, 后移, 封面构图 and 移除", () => {
    render({ items: three() });
    // Photo 1: 设为首图 and 前移 off, 封面构图 on.
    click(thumb("a"));
    expect(sheet()!.getAttribute("data-phone-sheet")).toBe("photo-menu");
    // The tap is the photo's, never its ×'s (r4 F1).
    expect(spies.remove).not.toHaveBeenCalled();
    expect(stripKeys()).toEqual(["a", "b", "c"]);
    expect(sheet()!.querySelector("h2")!.textContent).toBe("第 1 项 · 首图");
    expect(action("first").disabled).toBe(true);
    expect(action("earlier").disabled).toBe(true);
    expect(document.activeElement).toBe(action("later"));
    // 封面构图 keeps the crop first, then the flow draws it over 编辑.
    act(() =>
      sheet()!.dispatchEvent(new Event("cancel", { cancelable: true })),
    );
    drag({ x: 10, y: 10, width: 80, height: 80 });
    click(thumb("a"));
    click(action("compose-cover"));
    expect(sheet()).toBe(null);
    expect(spies.onComposeCover).toHaveBeenCalledExactlyOnceWith("a");
    expect(spies.applyEdit.mock.invocationCallOrder[0]).toBeLessThan(
      spies.onComposeCover.mock.invocationCallOrder[0]!,
    );

    // Another photo: no 封面构图; 前移 points right, towards 首图.
    click(thumb("b"));
    click(thumb("b"));
    expect(sheet()!.querySelector("h2")!.textContent).toBe("第 2 项");
    expect(sheet()!.querySelector('[data-media-action="compose-cover"]')).toBe(
      null,
    );
    expect(action("earlier").querySelector('[data-icon="next"]')).not.toBe(
      null,
    );
    expect(action("later").querySelector('[data-icon="previous"]')).not.toBe(
      null,
    );
    click(action("first"));
    expect(sheet()).toBe(null);
    expect(spies.reorder).toHaveBeenLastCalledWith("b", 0);
    expect(toastText()).toBe("已设为首图");
    expect(title()).toBe("1 / 3第 1 项，共 3 项");
    expect(document.activeElement).toBe(thumb("b"));

    click(thumb("b"));
    click(action("later"));
    expect(spies.reorder).toHaveBeenLastCalledWith("b", 1);
    expect(toastText()).toBe("已移到第 2 项");
    click(thumb("b"));
    click(action("earlier"));
    expect(spies.reorder).toHaveBeenLastCalledWith("b", 0);
    expect(toastText()).toBe("已设为首图");

    // 移除 there is the ×: at once, with 撤销.
    click(thumb("b"));
    click(action("remove"));
    expect(sheet()).toBe(null);
    expect(toastText()).toBe("已移除第 1 项撤销");
    expect(container.querySelector('[data-edit-thumb="b"]')).toBe(null);
  });

  it("opens 前往处理's fix sheet once over its focused thumbnail, and only clears a key that needs nothing", () => {
    ui.setCurrentKey("b");
    ui.setAttentionKey("b");
    render({
      items: three(),
      statuses: new Map<string, ItemStatus>([
        [
          "b",
          {
            kind: "missing_local",
            label: "缺少本地文件",
            message: "请重新选择",
          },
        ],
      ]),
    });
    expect(spies.onAttentionTaken).toHaveBeenCalledOnce();
    expect(ui.get().phone.attentionKey).toBe(null);
    expect(sheet()!.getAttribute("data-phone-sheet")).toBe("photo-attention");
    expect(document.activeElement).toBe(
      sheet()!.querySelector('[data-media-action="reselect"]'),
    );
    // Closing it hands focus to the photo's thumbnail beneath.
    act(() =>
      sheet()!.dispatchEvent(new Event("cancel", { cancelable: true })),
    );
    expect(sheet()).toBe(null);
    expect(document.activeElement).toBe(thumb("b"));

    act(() => ui.setAttentionKey("c"));
    expect(spies.onAttentionTaken).toHaveBeenCalledTimes(2);
    expect(sheet()).toBe(null);
    expect(title()).toBe("2 / 3第 2 项，共 3 项");
  });

  it("closes the fix sheet's <dialog> before 重新选择 opens the album", () => {
    const openAtClick: (Element | null)[] = [];
    spies.reselect.mockImplementation(() =>
      openAtClick.push(document.querySelector("dialog[open]")),
    );
    render({
      items: [item("a"), item("b")],
      statuses: new Map<string, ItemStatus>([
        [
          "a",
          {
            kind: "missing_local",
            label: "缺少本地文件",
            message: "请重新选择",
          },
        ],
      ]),
    });
    click(thumb("a"));
    expect(sheet()!.getAttribute("data-phone-sheet")).toBe("photo-attention");
    click(action("reselect"));
    expect(spies.reselect).toHaveBeenCalledExactlyOnceWith("a");
    expect(openAtClick).toEqual([null]);
    expect(sheet()).toBe(null);
  });

  it("shows the editor's notices first in the band", () => {
    render({
      items: three(),
      notices: <p data-test-notice="">已恢复本机未完成的编辑</p>,
    });
    const notices = container.querySelector("[data-edit-notices]")!;
    expect(notices.textContent).toBe("已恢复本机未完成的编辑");
    expect(names(notices)).toEqual(["bandNotices"]);
    const band = container.querySelector("[data-edit-band]")!;
    expect(band.firstElementChild!.firstElementChild).toBe(notices);
    act(() => root.unmount());
    root = createRoot(container);
    render({ items: three(), notices: null });
    expect(container.querySelector("[data-edit-notices]")).toBe(null);
    expect(container.querySelector("[data-edit-band]")!.firstElementChild).toBe(
      container.querySelector("[data-edit-ratio]")!.parentElement,
    );
  });

  it("never shows a photo the start screen holds, even before its removal lands", () => {
    render({ items: three(), heldKeys: ["a"] });
    expect(stripKeys()).toEqual(["b", "c"]);
    expect(title()).toBe("1 / 2第 1 项，共 2 项");
    expect(cropper.props!.image).toBe("/display/b");
    act(() => ui.setHeldRemoval({ keys: ["b"], current: "b" }));
    expect(stripKeys()).toEqual(["c"]);
    expect(title()).toBe("1 / 1第 1 项，共 1 项");
  });

  it("shows the strip's hint once per device, after the stage's, until a touch or a lift", async () => {
    vi.useFakeTimers();
    render({ items: three() });
    const stageHint = () => container.querySelector("[data-edit-hint]")!;
    const stripHint = () => container.querySelector("[data-edit-strip-hint]")!;
    expect(stripHint().textContent).toBe("长按拖动排序，最右是首图");
    expect(stripHint().getAttribute("aria-hidden")).toBe("true");
    expect(names(stripHint())).toEqual(["stripHint"]);
    // Never with the stage's hint: it waits until that one is gone.
    expect(stageHint().hasAttribute("data-show")).toBe(true);
    expect(stripHint().hasAttribute("data-show")).toBe(false);
    act(() => vi.advanceTimersByTime(2400));
    expect(stageHint().hasAttribute("data-show")).toBe(false);
    expect(stripHint().hasAttribute("data-show")).toBe(true);
    expect(window.localStorage.getItem(STRIP_HINT_KEY)).toBe("1");
    act(() => vi.advanceTimersByTime(STRIP_HINT_MS - 1));
    expect(stripHint().hasAttribute("data-show")).toBe(true);
    act(() => vi.advanceTimersByTime(1));
    expect(stripHint().hasAttribute("data-show")).toBe(false);

    // Once per device.
    act(() => root.unmount());
    root = createRoot(container);
    render({ items: three() });
    expect(stripHint().hasAttribute("data-show")).toBe(false);

    // A touch on the row ends it early.
    act(() => root.unmount());
    root = createRoot(container);
    window.localStorage.clear();
    render({ items: three() });
    expect(stripHint().hasAttribute("data-show")).toBe(true);
    pointer("pointerdown", thumb("b"));
    expect(stripHint().hasAttribute("data-show")).toBe(false);

    // So does lifting a photo.
    act(() => root.unmount());
    root = createRoot(container);
    window.localStorage.clear();
    render({ items: three() });
    expect(stripHint().hasAttribute("data-show")).toBe(true);
    vi.useRealTimers();
    layOut();
    act(() => thumb("b").focus());
    await sortKey(thumb("b"), "Space");
    expect(stripHint().hasAttribute("data-show")).toBe(false);
    await sortKey(document, "Escape");

    // One photo has nothing to sort: no hint.
    act(() => root.unmount());
    root = createRoot(container);
    render({ items: [item("a")] });
    expect(container.querySelector("[data-edit-strip-hint]")).toBe(null);
  });

  it("asks on ‹ for a work started here: 重新选择照片 hands every photo to the start screen", () => {
    ui.setCurrentKey("b");
    render({ items: three() });
    drag({ x: 10, y: 10, width: 80, height: 80 });
    click(button("返回"));
    // Nothing is kept yet: 继续编辑 finds the screen as it was.
    expect(spies.onBack).toHaveBeenCalledOnce();
    expect(spies.applyEdit).not.toHaveBeenCalled();
    expect(spies.onLeave).not.toHaveBeenCalled();
    const dialog = sheet()!;
    expect(dialog.getAttribute("data-phone-sheet")).toBe("edit-back");
    expect(dialog.querySelector("h2")!.textContent).toBe("返回");
    expect(dialog.querySelector("small")!.textContent).toBe("已选 3 项");
    const actions = [...dialog.querySelectorAll("button")];
    expect(
      actions.map((entry) => [
        entry.getAttribute("data-back-action"),
        entry.textContent,
      ]),
    ).toEqual([
      ["reselect", "重新选择照片"],
      ["leave", "存草稿并退出"],
      ["continue", "继续编辑"],
    ]);
    expect(names(actions[0]!)).toEqual(["inkBtn"]);
    expect(document.activeElement).toBe(actions[0]);

    // 继续编辑 and Escape close it.
    click(backAction("continue"));
    expect(ui.get().phone.backAsk).toBe(false);
    expect(sheet()).toBe(null);
    expect(document.activeElement).toBe(button("返回"));
    act(() => ui.setBackAsk(true));
    act(() =>
      sheet()!.dispatchEvent(new Event("cancel", { cancelable: true })),
    );
    expect(ui.get().phone.backAsk).toBe(false);

    act(() => ui.setBackAsk(true));
    click(backAction("reselect"));
    expect(ui.get().phone.backAsk).toBe(false);
    expect(spies.applyEdit).toHaveBeenCalledExactlyOnceWith("b", {
      rotation: 0,
      crop: { x: 0.1, y: 0.1, width: 0.8, height: 0.8 },
    });
    expect(spies.onRemoveAll).toHaveBeenCalledExactlyOnceWith(
      ["a", "b", "c"],
      "b",
    );
    expect(spies.applyEdit.mock.invocationCallOrder[0]).toBeLessThan(
      spies.onRemoveAll.mock.invocationCallOrder[0]!,
    );
    expect(spies.onLeave).not.toHaveBeenCalled();
  });

  it("saves and leaves in one tap from 存草稿并退出, the crop and a waiting removal kept first", async () => {
    let settle: (refused: string | null) => void = () => undefined;
    spies.onSaveAndLeave.mockImplementationOnce(
      () =>
        new Promise<string | null>((resolve) => {
          settle = resolve;
        }),
    );
    render({ items: three() });
    click(container.querySelector<HTMLButtonElement>("[data-edit-remove]")!);
    drag({ x: 10, y: 10, width: 80, height: 80 });
    click(button("返回"));
    click(backAction("leave"));
    // One tap saves and leaves (r4 ASK-1): never the leave guard's question.
    expect(spies.onSaveAndLeave).toHaveBeenCalledOnce();
    expect(spies.onLeave).not.toHaveBeenCalled();
    expect(spies.applyEdit).toHaveBeenCalledOnce();
    expect(spies.remove).toHaveBeenCalledExactlyOnceWith("a");
    expect(spies.applyEdit.mock.invocationCallOrder[0]).toBeLessThan(
      spies.remove.mock.invocationCallOrder[0]!,
    );
    expect(spies.remove.mock.invocationCallOrder[0]).toBeLessThan(
      spies.onSaveAndLeave.mock.invocationCallOrder[0]!,
    );
    expect(spies.onRemoveAll).not.toHaveBeenCalled();

    // While it saves the sheet stays and its choices wait, focus kept.
    expect(ui.get().phone.backAsk).toBe(true);
    expect(backAction("leave").textContent).toBe("保存中…");
    expect(backAction("leave").getAttribute("aria-busy")).toBe("true");
    for (const name of ["reselect", "leave", "continue"]) {
      expect(backAction(name).getAttribute("aria-disabled")).toBe("true");
      expect(backAction(name).disabled).toBe(false);
    }
    click(backAction("leave"));
    click(backAction("continue"));
    click(backAction("reselect"));
    act(() =>
      sheet()!.dispatchEvent(new Event("cancel", { cancelable: true })),
    );
    expect(spies.onSaveAndLeave).toHaveBeenCalledOnce();
    expect(spies.onRemoveAll).not.toHaveBeenCalled();
    expect(ui.get().phone.backAsk).toBe(true);

    // Settled: left (the editor goes), or refused, its reason among the
    // editor's notices: 编辑 as it was, focus back on ‹, and then the
    // reason said through the flow's announcer (an inserted notice often
    // is not), once ‹ has focus.
    const reason = "图片还未准备好，请完成上传或移除失败项后保存草稿";
    const focusedWhenSaid: (Element | null)[] = [];
    spies.announce.mockImplementation(() => {
      focusedWhenSaid.push(document.activeElement);
    });
    await act(async () => {
      settle(reason);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(ui.get().phone.backAsk).toBe(false);
    expect(sheet()).toBe(null);
    expect(document.activeElement).toBe(button("返回"));
    expect(spies.onLeave).not.toHaveBeenCalled();
    expect(spies.announce).toHaveBeenCalledExactlyOnceWith(reason);
    expect(focusedWhenSaid).toEqual([button("返回")]);

    // Ready for another try: refused again, it is said again.
    click(button("返回"));
    expect(backAction("leave").textContent).toBe("存草稿并退出");
    spies.onSaveAndLeave.mockResolvedValueOnce(reason);
    await act(async () => {
      backAction("leave").click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(spies.onSaveAndLeave).toHaveBeenCalledTimes(2);
    expect(sheet()).toBe(null);
    expect(spies.announce).toHaveBeenCalledTimes(2);
    expect(spies.announce).toHaveBeenLastCalledWith(reason);
    expect(document.activeElement).toBe(button("返回"));

    // Left (nothing refused): nothing is said.
    click(button("返回"));
    spies.onSaveAndLeave.mockResolvedValueOnce(null);
    await act(async () => {
      backAction("leave").click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(spies.onSaveAndLeave).toHaveBeenCalledTimes(3);
    expect(sheet()).toBe(null);
    expect(spies.announce).toHaveBeenCalledTimes(2);
  });

  it("says a refused 存草稿并退出 at once when the back sheet already went another way", async () => {
    let settle: (refused: string | null) => void = () => undefined;
    spies.onSaveAndLeave.mockImplementationOnce(
      () =>
        new Promise<string | null>((resolve) => {
          settle = resolve;
        }),
    );
    render({ items: three() });
    click(button("返回"));
    click(backAction("leave"));
    // The store closes the sheet while it saves (an emptied album does).
    act(() => ui.setBackAsk(false));
    expect(spies.announce).not.toHaveBeenCalled();
    await act(async () => {
      settle("保存没有完成，请再试一次");
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(spies.announce).toHaveBeenCalledExactlyOnceWith(
      "保存没有完成，请再试一次",
    );
    expect(ui.get().phone.backAsk).toBe(false);
  });

  it("ends a removal's 撤销 once 存草稿并退出 or a fix makes the removal, whether or not it then leaves", async () => {
    render({
      items: [...three(), item("d")],
      statuses: new Map<string, ItemStatus>([
        [
          "c",
          {
            kind: "missing_local",
            label: "缺少本地文件",
            message: "请重新选择",
          },
        ],
      ]),
    });
    const cross = () =>
      container.querySelector<HTMLButtonElement>("[data-edit-remove]")!;
    const offered = () => container.querySelector("[data-edit-undo]");

    // 存草稿并退出, refused at once: the removal was made before it asked,
    // so 编辑 stays without its 撤销 (no 撤销 that could not bring it back).
    click(cross());
    expect(toastText()).toBe("已移除第 1 项撤销");
    click(button("返回"));
    spies.onSaveAndLeave.mockResolvedValueOnce(
      "图片还未准备好，请完成上传或移除失败项后保存草稿",
    );
    await act(async () => {
      backAction("leave").click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(spies.remove).toHaveBeenCalledExactlyOnceWith("a");
    expect(sheet()).toBe(null);
    expect(offered()).toBe(null);
    expect(toastText()).toBe("");
    expect(stripKeys()).toEqual(["b", "c", "d"]);

    // A fix that makes the removal first (重新选择 here) ends 撤销 too.
    click(cross());
    expect(toastText()).toBe("已移除第 1 项撤销");
    expect(thumb("c").getAttribute("aria-current")).toBe("true");
    click(thumb("c"));
    expect(sheet()!.getAttribute("data-phone-sheet")).toBe("photo-attention");
    click(action("reselect"));
    expect(spies.reselect).toHaveBeenCalledExactlyOnceWith("c");
    expect(spies.remove).toHaveBeenLastCalledWith("b");
    expect(offered()).toBe(null);
    expect(toastText()).toBe("");
  });

  it("waits for the uploads from 存草稿并退出: 等待上传完成… with the progress, said sparingly, and 继续编辑 ends the wait", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    let settle: (refused: string | null) => void = () => undefined;
    spies.onSaveAndLeave.mockImplementation(
      () =>
        new Promise<string | null>((resolve) => {
          settle = resolve;
        }),
    );
    render({ items: three() });
    click(button("返回"));
    const status = sheet()!.querySelector("[data-wait-status]")!;
    // Mounted with the sheet, silent until the wait starts.
    expect(status.getAttribute("aria-live")).toBe("polite");
    expect(status.getAttribute("role")).toBe("status");
    expect(status.textContent).toBe("");
    click(backAction("leave"));
    // The editor found the picks still uploading: it waits for them.
    act(() => setSaveWait({ received: 0, total: 3, reading: false }));
    const leave = backAction("leave");
    expect(leave.hasAttribute("data-waiting")).toBe(true);
    expect(leave.textContent).toBe("等待上传完成…已上传 0 / 3 项");
    expect(leave.getAttribute("aria-disabled")).toBe("true");
    expect(leave.getAttribute("aria-busy")).toBe("true");
    // The progress is seen live and said through the sheet's own region.
    const progress = leave.querySelector("[data-wait-progress]")!;
    expect(progress.getAttribute("aria-hidden")).toBe("true");
    expect(status.textContent).toBe("等待上传完成，已上传 0 / 3 项");
    // 重新选择照片 waits; 继续编辑 stays a choice.
    expect(backAction("reselect").getAttribute("aria-disabled")).toBe("true");
    expect(backAction("continue").hasAttribute("aria-disabled")).toBe(false);
    click(backAction("reselect"));
    click(backAction("leave"));
    expect(spies.onRemoveAll).not.toHaveBeenCalled();
    expect(spies.onSaveAndLeave).toHaveBeenCalledOnce();

    // Each photo in shows at once; it is said no more than every few seconds.
    act(() => setSaveWait({ received: 1, total: 3, reading: false }));
    act(() => setSaveWait({ received: 2, total: 3, reading: false }));
    expect(progress.textContent).toBe("已上传 2 / 3 项");
    expect(status.textContent).toBe("等待上传完成，已上传 0 / 3 项");
    act(() => vi.advanceTimersByTime(WAIT_SAY_MS - 1));
    expect(status.textContent).toBe("等待上传完成，已上传 0 / 3 项");
    act(() => vi.advanceTimersByTime(1));
    expect(status.textContent).toBe("已上传 2 / 3 项");
    // A pick from + still being read: its photos are not counted yet.
    act(() => setSaveWait({ received: 2, total: 3, reading: true }));
    expect(progress.textContent).toBe("已上传 2 / 3 项，正在读取照片…");

    // 继续编辑 ends the wait: the sheet goes, 编辑 stays, nothing is said.
    click(backAction("continue"));
    expect(ui.get().phone.backAsk).toBe(false);
    expect(sheet()).toBe(null);
    expect(document.activeElement).toBe(button("返回"));
    // The editor settles its wait once the sheet is gone.
    act(() => setSaveWait(null));
    await act(async () => {
      settle(null);
      await Promise.resolve();
    });
    expect(spies.announce).not.toHaveBeenCalled();
    expect(spies.onLeave).not.toHaveBeenCalled();

    // Escape (the sheet's cancel) ends a wait the same way.
    click(button("返回"));
    expect(backAction("leave").textContent).toBe("存草稿并退出");
    expect(sheet()!.querySelector("[data-wait-status]")!.textContent).toBe("");
    click(backAction("leave"));
    act(() => setSaveWait({ received: 0, total: 3, reading: false }));
    act(() =>
      sheet()!.dispatchEvent(new Event("cancel", { cancelable: true })),
    );
    expect(ui.get().phone.backAsk).toBe(false);
    expect(sheet()).toBe(null);
  });

  it("lets 重新选择照片 wait while a pick from + is still being read, so its photos go along", () => {
    const reading = { identifying: 2 } as MediaActions["staging"];
    render({ items: three(), staging: reading });
    click(button("返回"));
    const dialog = sheet()!;
    // Why it waits, read as the sheet's description.
    const description = document.getElementById(
      dialog.getAttribute("aria-describedby")!,
    )!;
    expect(description.textContent).toBe(
      "正在读取照片，读取完成后可重新选择照片",
    );
    expect(backAction("reselect").getAttribute("aria-disabled")).toBe("true");
    expect(backAction("reselect").disabled).toBe(false);
    click(backAction("reselect"));
    expect(spies.onRemoveAll).not.toHaveBeenCalled();
    expect(ui.get().phone.backAsk).toBe(true);

    // The pick is in: its photo joins the album, and 重新选择照片 takes it too.
    act(() => growAlbum([item("d")]));
    render({ items: three(), staging: null });
    expect(dialog.hasAttribute("aria-describedby")).toBe(false);
    expect(backAction("reselect").hasAttribute("aria-disabled")).toBe(false);
    click(backAction("reselect"));
    expect(spies.onRemoveAll).toHaveBeenCalledExactlyOnceWith(
      ["a", "b", "c", "d"],
      "a",
    );
  });

  it("leaves through the leave guard from 退出编辑 without drafts, and never outlives the screen", () => {
    render({ items: three(), saveMode: "unsaved" });
    drag({ x: 10, y: 10, width: 80, height: 80 });
    click(button("返回"));
    expect(backAction("leave").textContent).toBe("退出编辑");
    click(backAction("leave"));
    // 结束本次编辑？ is the guard's: nothing is saved here.
    expect(spies.onLeave).toHaveBeenCalledOnce();
    expect(spies.onSaveAndLeave).not.toHaveBeenCalled();
    expect(spies.applyEdit.mock.invocationCallOrder[0]).toBeLessThan(
      spies.onLeave.mock.invocationCallOrder[0]!,
    );
    expect(ui.get().phone.backAsk).toBe(false);

    act(() => ui.setBackAsk(true));
    expect(sheet()).not.toBe(null);
    act(() => root.unmount());
    expect(ui.get().phone.backAsk).toBe(false);
    root = createRoot(container);
  });

  it("leaves from a draft on ‹ at once, the crop and a waiting removal kept first", () => {
    render({ items: three(), openedAs: "draft" });
    click(container.querySelector<HTMLButtonElement>("[data-edit-remove]")!);
    drag({ x: 10, y: 10, width: 80, height: 80 });
    click(button("返回"));
    expect(sheet()).toBe(null);
    expect(spies.onBack).not.toHaveBeenCalled();
    expect(ui.get().phone.backAsk).toBe(false);
    expect(spies.applyEdit.mock.invocationCallOrder[0]).toBeLessThan(
      spies.remove.mock.invocationCallOrder[0]!,
    );
    expect(spies.remove.mock.invocationCallOrder[0]).toBeLessThan(
      spies.onLeave.mock.invocationCallOrder[0]!,
    );
  });

  it("adds from +'s sheet: 原图画质 for this device, then the strip's own pick or camera input", () => {
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: () => ({
        matches: true,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
      }),
    });
    window.localStorage.setItem("yoyi.publishing.original-quality", "standard");
    const clicked: { input: HTMLInputElement; open: Element | null }[] = [];
    vi.spyOn(HTMLInputElement.prototype, "click").mockImplementation(function (
      this: HTMLInputElement,
    ) {
      clicked.push({
        input: this,
        open: document.querySelector("dialog[open]"),
      });
    });
    render({ items: three() });
    const add = container.querySelector<HTMLButtonElement>("[data-edit-add]")!;
    click(add);
    // The tap opens the sheet, never the picker.
    expect(clicked).toEqual([]);
    const dialog = sheet()!;
    expect(dialog.getAttribute("data-phone-sheet")).toBe("add");
    expect(dialog.querySelector("h2")!.textContent).toBe("添加照片");
    expect(dialog.querySelector("small")!.textContent).toBe(
      "已选 3 项 · 最多 50 项",
    );
    expect(document.activeElement).toBe(
      dialog.querySelector('[data-add-option="photos"]'),
    );
    const toggle = () =>
      dialog.querySelector<HTMLButtonElement>('[role="switch"]')!;
    expect(toggle().getAttribute("aria-checked")).toBe("false");
    click(
      dialog.querySelector<HTMLElement>('[data-editor-switch="original"]')!,
    );
    expect(
      window.localStorage.getItem("yoyi.publishing.original-quality"),
    ).toBe("original");
    expect(spies.setOriginalNext).toHaveBeenLastCalledWith(true);
    expect(toggle().getAttribute("aria-checked")).toBe("true");
    expect(toastText()).toBe("原图画质已打开");

    // 选择照片: the strip's input, clicked once the sheet's <dialog> closed.
    click(
      dialog.querySelector<HTMLButtonElement>('[data-add-option="photos"]')!,
    );
    expect(clicked).toHaveLength(1);
    expect(clicked[0]!.open).toBe(null);
    expect(clicked[0]!.input.multiple).toBe(true);
    expect(clicked[0]!.input.closest("[data-edit-add-cell]")).not.toBe(null);
    expect(sheet()).toBe(null);
    const file = new File(["x"], "photo.jpg", { type: "image/jpeg" });
    Object.defineProperty(clicked[0]!.input, "files", {
      configurable: true,
      value: [file],
    });
    act(() =>
      clicked[0]!.input.dispatchEvent(new Event("change", { bubbles: true })),
    );
    expect(spies.onAddFiles).toHaveBeenCalledExactlyOnceWith([file], "picker");

    // 拍照 on a phone: the strip's camera input.
    click(add);
    expect(sheet()!.querySelector("[data-add-option]")!.textContent).toBe(
      "选择照片",
    );
    click(
      sheet()!.querySelector<HTMLButtonElement>('[data-add-option="camera"]')!,
    );
    expect(clicked).toHaveLength(2);
    expect(clicked[1]!.open).toBe(null);
    expect(clicked[1]!.input.getAttribute("capture")).toBe("environment");
    expect(sheet()).toBe(null);
  });

  it("opens +'s sheet on the device's last 原图画质, and offers no 拍照 without a coarse pointer", () => {
    window.localStorage.setItem("yoyi.publishing.original-quality", "original");
    render({ items: three() });
    click(container.querySelector<HTMLButtonElement>("[data-edit-add]")!);
    expect(spies.setOriginalNext).toHaveBeenCalledExactlyOnceWith(true);
    expect(
      sheet()!.querySelector('[role="switch"]')!.getAttribute("aria-checked"),
    ).toBe("true");
    expect(sheet()!.querySelector('[data-add-option="camera"]')).toBe(null);
    expect(
      container.querySelectorAll('[data-edit-add-cell] input[type="file"]'),
    ).toHaveLength(1);
    click(
      sheet()!.querySelector<HTMLButtonElement>('[data-add-option="cancel"]')!,
    );
    expect(sheet()).toBe(null);
    expect(document.activeElement).toBe(
      container.querySelector("[data-edit-add]"),
    );
  });
});

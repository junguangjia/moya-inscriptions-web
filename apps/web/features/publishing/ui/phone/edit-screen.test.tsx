// @vitest-environment jsdom
import { spacing, typography } from "@moya/design-tokens";
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
      crop: { x: number; y: number };
      zoom: number;
      maxZoom: number;
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
      onZoomChange: (zoom: number) => void;
      onTouchRequest: () => boolean;
      onCropSizeChange?: (size: { width: number; height: number }) => void;
      /** React 19 hands a function component its ref as a prop. */
      ref?: { current: unknown } | undefined;
    },
    /** Croppers mounted so far (a new generation mounts a new one). */
    mounts: 0,
    /**
     * Seed as react-easy-crop does when its image is already decoded: while
     * it mounts, it moves to the seed and reports the seeded area.
     */
    seeding: false,
  },
}));
vi.mock("react-easy-crop", async () => {
  const { useLayoutEffect } = await import("react");
  return {
    default: (props: NonNullable<typeof cropper.props>) => {
      cropper.props = props;
      useLayoutEffect(() => {
        cropper.mounts += 1;
        const seed = props.initialCroppedAreaPercentages;
        if (!cropper.seeding || seed === undefined) return;
        props.onCropChange({ x: -7, y: -3 });
        props.onZoomChange(100 / seed.width);
        props.onCropAreaChange(seed);
        // Mounted once: the props of this render are the ones it seeds with.
      }, []);
      return (
        <div data-test-cropper="" tabIndex={props.cropperProps.tabIndex} />
      );
    },
  };
});

import { startCrop } from "../media/crop-workspace";
import { initialSession } from "../media/media-edit-dialog";
import {
  indexOfKey,
  moveToIndex,
  removeItem,
  setItemEdit,
  setItemFeed,
} from "../media/media-order";
import { MEDIA_ACCEPT } from "../media/media-picker";
import { createMediaUiStore, useMediaUiState } from "../media/media-ui-store";
import {
  EditScreen,
  LEGACY_NOTE,
  STRIP_HINT_KEY,
  STRIP_HINT_MS,
  WAIT_SAY_MS,
} from "./edit-screen";
import { COVER_RESET_NOTICE } from "./cover-rule";
import {
  EditStage,
  cropperBox,
  feedToolState,
  phoneInitialSession,
  useStageCrop,
} from "./edit-stage";
import { CROP_FIELD_INSETS, REFRAME_MAX_MS } from "./stage-frame";
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
  MediaFeedFraming,
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
  applyFeed: vi.fn<(key: string, feed: MediaFeedFraming | undefined) => void>(),
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
    // As `useMediaActions` keeps it: silently, never the pixels (#341).
    applyFeed: (key: string, feed: MediaFeedFraming | undefined) => {
      spies.applyFeed(key, feed);
      const next = setItemFeed(current.current, key, feed);
      if (next !== current.current) setMedia(next);
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
  cropper.mounts = 0;
  cropper.seeding = false;
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
    expect(stage().getAttribute("data-feed-tool")).toBe("off");
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
    const feedTool = shown.querySelector<HTMLButtonElement>(
      "[data-edit-feed-tool]",
    )!;
    expect(feedTool.getAttribute("aria-label")).toBe("动态流");
    expect(feedTool.getAttribute("title")).toBe("动态流");
    expect(feedTool.getAttribute("aria-pressed")).toBe("false");
    expect(names(feedTool)).toEqual(["fab"]);
    expect(names(feedTool.parentElement!)).toEqual(["stageTop"]);
    expect(shown.querySelector("[data-edit-guide]")).toBe(null);
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

    // Ratio row: one segmented radio group of six (#341): 原始比例 and 自由
    // as words, each fixed ratio with its shape.
    const group = shown.querySelector("[data-edit-ratio]")!;
    expect(group.getAttribute("role")).toBe("radiogroup");
    expect(group.getAttribute("aria-label")).toBe("裁剪比例");
    expect(group.getAttribute("data-count")).toBe("6");
    expect(names(group)).toEqual(["segment"]);
    const radios = [...group.querySelectorAll("[role='radio']")];
    expect(radios.map((radio) => radio.textContent)).toEqual([
      "原始比例",
      "自由",
      "4:5",
      "3:4",
      "1:1",
      "4:3",
    ]);
    expect(radios.map((radio) => radio.getAttribute("data-ratio"))).toEqual([
      "original",
      "custom",
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
      "-1",
    ]);
    expect(radios.map((radio) => radio.querySelector("svg") !== null)).toEqual([
      false,
      false,
      true,
      true,
      true,
      true,
    ]);
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

  it("reopens a stored shape outside the phone set as 自由, with nothing to apply", () => {
    // 16:9 inside a 4000 × 3000 frame.
    const banner = { x: 0, y: 0.125, width: 1, height: 0.75 };
    render({ items: [item("a", { rotation: 0, crop: banner }), item("b")] });
    expect(checkedRatios()).toEqual(["自由"]);
    expect(ratio("自由").tabIndex).toBe(0);
    expect(cropper.props!.aspect).toBeCloseTo(16 / 9);
    expect(cropper.props!.initialCroppedAreaPercentages).toEqual({
      x: 0,
      y: 12.5,
      width: 100,
      height: 75,
    });
    expect(applyAll().getAttribute("aria-disabled")).toBe("true");
  });

  it("reopens a zoomed crop of the frame's own shape as 自由: 原始比例 is the whole frame", () => {
    const zoomed = { x: 0.1, y: 0.1, width: 0.8, height: 0.8 };
    render({ items: [item("a", { rotation: 0, crop: zoomed }), item("b")] });
    expect(checkedRatios()).toEqual(["自由"]);
    expect(cropper.props!.aspect).toBeCloseTo(4 / 3);
    expect(button("还原").getAttribute("aria-disabled")).toBe("false");
    click(button("还原"));
    expect(checkedRatios()).toEqual(["原始比例"]);
    expect(spies.applyEdit).toHaveBeenLastCalledWith("a", {
      rotation: 0,
      crop: null,
    });
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
    expect(checkedRatios()).toEqual(["自由"]);
    expect(document.activeElement).toBe(ratio("自由"));
    key(ratio("自由"), "ArrowDown");
    expect(checkedRatios()).toEqual(["4:5"]);
    expect(document.activeElement).toBe(ratio("4:5"));
    // 4:3 on a 4:3 photo is the whole frame and 自由 keeps the crop as it
    // is: only 4:5 is a new edit.
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

  it("draws the 「动态流」 band with its caption once the tool is on", () => {
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
    const tool = () =>
      container.querySelector<HTMLButtonElement>("[data-edit-feed-tool]")!;
    // Off at first (mockup B): the frame and its corner marks only.
    expect(band()).toBe(null);
    const frame = container.querySelector<HTMLElement>("[data-edit-frame]")!;
    expect(frame.style.width).toBe("100px");
    expect(frame.style.height).toBe("300px");
    expect(frame.querySelectorAll("[data-corner]")).toHaveLength(4);
    expect(tool().hasAttribute("aria-describedby")).toBe(false);

    click(tool());
    expect(tool().getAttribute("aria-pressed")).toBe("true");
    expect(stage().getAttribute("data-feed-tool")).toBe("on");
    expect(toastText()).toBe("动态流：上下拖动亮处，选择动态流里显示的部分");
    // 1:3 against its own 4:5 stage: the feed shows the middle 41.7 %.
    expect(band()!.getAttribute("data-feed-fit")).toBe("cover");
    const edges = [...band()!.querySelectorAll<HTMLElement>("[data-edge]")];
    expect(edges.map((edge) => edge.getAttribute("data-edge"))).toEqual([
      "top",
      "bottom",
    ]);
    for (const edge of edges)
      expect(Number.parseFloat(edge.style.height)).toBeCloseTo(87.5, 3);
    const label = band()!.lastElementChild as HTMLElement;
    expect(label.textContent).toBe("动态流显示范围");
    // 36px above the visible band's foot, 8px in from the frame's side.
    expect(Number.parseFloat(label.style.top)).toBeCloseTo(176.5, 3);
    const hint = document.getElementById(
      tool().getAttribute("aria-describedby")!,
    )!.textContent;
    expect(hint).toContain("居中，上下各裁去 29%");
    expect(hint).toContain("上下拖动选择显示的部分");
    expect(hint).not.toContain("始终居中");

    click(tool());
    expect(tool().getAttribute("aria-pressed")).toBe("false");
    expect(band()).toBe(null);
    expect(toastText()).toBe("已退出动态流");
    click(tool());

    // Another photo is measured against the stage the first one sets; the
    // tool stays on from photo to photo.
    click(thumb("wide"));
    act(() => cropper.props!.onCropSizeChange!({ width: 300, height: 225 }));
    expect(tool().getAttribute("aria-pressed")).toBe("true");
    expect(band()!.getAttribute("data-feed-fit")).toBe("contain");
    expect(band()!.querySelectorAll("[data-edge]")).toHaveLength(0);
    expect(band()!.textContent).toBe("动态流整张显示");
    expect((band()!.lastElementChild as HTMLElement).style.top).toBe("189px");
    expect(container.querySelector("[data-edit-feed-note]")!.textContent).toBe(
      "动态流中整张显示，无需选择",
    );
  });

  it("keeps 「动态流」 off while the stage shape is unknown", () => {
    ui.setCurrentKey("b");
    render({ items: [item("a"), item("b")], stageRatio: null });
    const tool = container.querySelector<HTMLButtonElement>(
      "[data-edit-feed-tool]",
    )!;
    expect(tool.getAttribute("aria-disabled")).toBe("true");
    click(tool);
    expect(tool.getAttribute("aria-pressed")).toBe("false");
    expect(tool.hasAttribute("aria-describedby")).toBe(false);
    expect(container.querySelector("[data-feed-window]")).toBe(null);
    expect(container.querySelector("[data-edit-ratio]")).not.toBe(null);
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

  it("keeps each of the six ratio segments whole from a 320px phone to a 390px one", () => {
    const css = (editCss as string).replace(/\/\*[\s\S]*?\*\//gu, "");
    /** A rule's `property`, in px: a spacing token as the tokens define it. */
    const declared = (
      selector: string,
      property: string,
      pattern = "([^;]+)",
    ) => {
      const start = css.indexOf(`${selector} {`);
      expect(start).toBeGreaterThanOrEqual(0);
      const body = css
        .slice(start, css.indexOf("}", start))
        .replace(/\s+/gu, " ");
      const value = new RegExp(`[{;] ${property}: ${pattern};`, "u").exec(
        body,
      )?.[1];
      const step = /^var\(--yoyi-space-(\d+)\)$/u.exec(value ?? "")?.[1];
      expect(step).toBeDefined();
      return Number.parseFloat(spacing[Number(step) as keyof typeof spacing]);
    };
    // The row's sides (no safe area on these phones) and the track's insets.
    const side = declared(
      ".ratioRow",
      "padding",
      "\\S+ max\\((\\S+), env\\(safe-area-inset-right\\)\\) [^;]+",
    );
    const inset = declared(".segment", "padding");
    const wordPadding = declared(
      '.segment[data-count="6"] .segmentButton:nth-child(-n + 2)',
      "padding",
      "0 (\\S+)",
    );
    const gap = declared(
      '.segment[data-count="6"] .segmentButton:nth-child(n + 3)',
      "gap",
    );
    const em = Number.parseFloat(typography.label.mobileSize);
    // 原始比例 (1.2fr) and 自由 (0.8fr), never narrower than their words.
    const words = [
      { flex: 1.2, width: 4 * em + 2 * wordPadding },
      { flex: 0.8, width: 2 * em + 2 * wordPadding },
    ];
    /** Each shape's 1fr: a word whose share is under its width keeps its width. */
    const shapeColumn = (track: number) => {
      let rest = track;
      let factors = 6;
      const fixed = new Set<(typeof words)[number]>();
      for (;;) {
        const fr = rest / factors;
        const narrow = words.find(
          (word) => !fixed.has(word) && word.flex * fr < word.width,
        );
        if (narrow === undefined) return fr;
        fixed.add(narrow);
        rest -= narrow.width;
        factors -= narrow.flex;
      }
    };
    // A 20px glyph, the gap and a semibold 4:5 (21.8px in SF Pro, at most
    // 23.7px in a fallback face as wide as Verdana).
    const shape = 20 + gap + 23.7;
    for (const width of [320, 360, 375, 390])
      expect(shapeColumn(width - 2 * side - 2 * inset)).toBeGreaterThanOrEqual(
        shape,
      );
    // At 320px: 284px of track, the words 60 and 37.3px, each shape 46.7px.
    expect(shapeColumn(284)).toBeCloseTo(224 / 4.8, 5);
    expect(320 - 2 * side - 2 * inset).toBe(284);
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
  const stripPick = () =>
    container.querySelector<HTMLInputElement>(
      '[data-edit-add-cell] input[aria-label="选择照片"]',
    )!;
  /** Hands `files` to the strip's 选择照片 input as a finished pick. */
  const pickFiles = (files: File[]) => {
    Object.defineProperty(stripPick(), "files", {
      configurable: true,
      value: files,
    });
    act(() =>
      stripPick().dispatchEvent(new Event("change", { bubbles: true })),
    );
  };
  /**
   * The `accept` entries that are not a photo type: image types and the
   * HEIC/HEIF extensions only, never video, any file or another extension
   * (static photos only, and Chrome's Android photo picker stays eligible).
   */
  const notPhotos = (accept: string) =>
    accept
      .split(",")
      .map((type) => type.trim())
      .filter(
        (type) =>
          !type.startsWith("image/") && type !== ".heic" && type !== ".heif",
      );

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

  it("asks +'s album for several static photos, and its camera for one", () => {
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: () => ({
        matches: true,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
      }),
    });
    render({ items: three() });
    const camera = container.querySelector<HTMLInputElement>(
      '[data-edit-add-cell] input[aria-label="拍照"]',
    )!;
    // On a phone too: 选择照片 never turns into the camera.
    expect(stripPick().multiple).toBe(true);
    expect(stripPick().hasAttribute("capture")).toBe(false);
    expect(stripPick().accept).toBe(MEDIA_ACCEPT);
    expect(notPhotos(stripPick().accept)).toEqual([]);
    expect(camera.getAttribute("capture")).toBe("environment");
    expect(camera.multiple).toBe(false);
  });

  it("hands +'s pick of several photos on whole, in the picker's order", () => {
    render({ items: three() });
    const files = ["d", "e", "f"].map(
      (name) => new File([name], `${name}.jpg`, { type: "image/jpeg" }),
    );
    pickFiles(files);
    expect(spies.onAddFiles).toHaveBeenCalledOnce();
    const [added, origin] = spies.onAddFiles.mock.calls[0]!;
    expect(origin).toBe("picker");
    // The same File objects, in the picker's order.
    expect((added as File[]).map((file) => files.indexOf(file))).toEqual([
      0, 1, 2,
    ]);
  });

  it("keeps the album and a waiting removal as they are when +'s album comes back empty or is cancelled", () => {
    vi.useFakeTimers();
    render({ items: three() });
    click(container.querySelector<HTMLButtonElement>("[data-edit-remove]")!);
    expect(title()).toBe("1 / 2第 1 项，共 2 项");
    // A cancelled pick must never count as a pick.
    pickFiles([]);
    act(() =>
      stripPick().dispatchEvent(new Event("cancel", { bubbles: true })),
    );
    // No pick: nothing added, and the removal still waits for 撤销.
    expect(spies.onAddFiles).not.toHaveBeenCalled();
    expect(spies.remove).not.toHaveBeenCalled();
    expect(title()).toBe("1 / 2第 1 项，共 2 项");
    expect(stripKeys()).toEqual(["b", "c"]);
    expect(album.items.map((entry) => entry.key)).toEqual(["a", "b", "c"]);
    expect(toastText()).toBe("已移除第 1 项撤销");
  });
});

describe("EditScreen corner handles and the crop field (#341)", () => {
  /** The stage's room as a 390 × 600 phone lays it out (jsdom lays nothing out). */
  const layOutStage = (width = 390, height = 600) => {
    vi.spyOn(Element.prototype, "clientWidth", "get").mockImplementation(
      function (this: Element) {
        return this.hasAttribute("data-edit-stage") ? width : 0;
      },
    );
    vi.spyOn(Element.prototype, "clientHeight", "get").mockImplementation(
      function (this: Element) {
        return this.hasAttribute("data-edit-stage") ? height : 0;
      },
    );
  };
  /** The cropper's frame for `ratio` in the 358 × 480 field of that stage. */
  const frameFor = (ratio: number) => {
    const width = Math.min(358, 480 * ratio);
    return { width, height: width / ratio };
  };
  const layOutFrame = (ratio: number) =>
    act(() => cropper.props!.onCropSizeChange!(frameFor(ratio)));
  const full = { x: 0, y: 0, width: 100, height: 100 };

  const handle = (corner: string) =>
    container.querySelector<HTMLButtonElement>(
      `[data-crop-handle="${corner}"]`,
    )!;
  const handles = () => [
    ...container.querySelectorAll<HTMLButtonElement>("[data-crop-handle]"),
  ];
  const cropWindow = () =>
    container.querySelector<HTMLElement>("[data-edit-window]")!;
  const reframeLayer = () =>
    container.querySelector<HTMLElement>("[data-edit-reframe]");
  const resizing = () => stage().hasAttribute("data-resizing");
  const backAction = (name: string) =>
    sheet()!.querySelector<HTMLButtonElement>(`[data-back-action="${name}"]`)!;

  /** A pointer event at client (x, y), as React reads it. */
  const press = (
    type: string,
    target: EventTarget,
    x: number,
    y: number,
    { id = 1, primary }: { id?: number; primary?: boolean } = {},
  ) => {
    const event = new MouseEvent(type, {
      bubbles: true,
      cancelable: true,
      button: 0,
      clientX: x,
      clientY: y,
    });
    Object.defineProperties(event, {
      pointerId: { value: id },
      pointerType: { value: "touch" },
      ...(primary === undefined ? {} : { isPrimary: { value: primary } }),
    });
    act(() => {
      target.dispatchEvent(event);
    });
  };
  /** A finger drags `corner` by `by` (client px) and lifts. */
  const dragCorner = (corner: string, by: { x: number; y: number }) => {
    press("pointerdown", handle(corner), 0, 0);
    press("pointermove", handle(corner), by.x / 2, by.y / 2);
    press("pointermove", handle(corner), by.x, by.y);
    act(() => vi.advanceTimersByTime(16));
    press("pointerup", handle(corner), by.x, by.y);
  };
  const keyPress = (
    target: HTMLElement,
    name: string,
    init: KeyboardEventInit = {},
  ) => {
    for (const type of ["keydown", "keyup"])
      act(() => {
        target.dispatchEvent(
          new KeyboardEvent(type, {
            key: name,
            bubbles: true,
            cancelable: true,
            ...init,
          }),
        );
      });
  };
  /** The page goes to the background for a moment. */
  const hidePage = () => {
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "hidden",
    });
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    delete (document as { visibilityState?: unknown }).visibilityState;
  };
  const expectCrop = (
    actual: MediaCrop | null | undefined,
    expected: MediaCrop,
  ) => {
    expect(actual).not.toBe(null);
    expect(actual!.x).toBeCloseTo(expected.x, 5);
    expect(actual!.y).toBeCloseTo(expected.y, 5);
    expect(actual!.width).toBeCloseTo(expected.width, 5);
    expect(actual!.height).toBeCloseTo(expected.height, 5);
  };
  const lastEdit = () => spies.applyEdit.mock.lastCall![1];
  /** The new cropper shows the crop it was seeded with. */
  const reportSeed = () =>
    act(() =>
      cropper.props!.onCropAreaChange(
        cropper.props!.initialCroppedAreaPercentages!,
      ),
    );

  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("fits the frame into a crop field clear of the stage's buttons, the box still covering the stage", () => {
    expect(CROP_FIELD_INSETS).toEqual({ block: 60, inline: 16 });
    const stageBox = { width: 390, height: 600 };
    // 4:3 at 原始比例: the field's width, 358 × 268.5; the stage's height to drag on.
    expect(
      cropperBox(stageBox, 4 / 3, { width: 4, height: 3 }, false, {
        block: 60,
        inline: 16,
      }),
    ).toEqual({ width: 358, height: 600 });
    // 4:5 on a 4:3 photo: a 358 × 447.5 frame, the photo 596.7 wide.
    const portrait = cropperBox(
      stageBox,
      0.8,
      { width: 4, height: 3 },
      false,
      CROP_FIELD_INSETS,
    )!;
    expect(portrait.width).toBeCloseTo(596.667, 3);
    expect(portrait.height).toBe(600);
    // A tall frame limited by the field's height: 240 × 480.
    expect(
      cropperBox(
        stageBox,
        0.5,
        { width: 1, height: 3 },
        false,
        CROP_FIELD_INSETS,
      ),
    ).toEqual({ width: 390, height: 720 });
    // Turned (3:4 as shown): square around the photo's long side.
    const turned = cropperBox(
      stageBox,
      0.75,
      { width: 3, height: 4 },
      true,
      CROP_FIELD_INSETS,
    )!;
    expect(turned.width).toBeCloseTo(477.333, 3);
    expect(turned.height).toBe(600);

    layOutStage();
    render({ items: three() });
    expect(stage().style.getPropertyValue("--crop-box-width")).toBe("358px");
    expect(stage().style.getPropertyValue("--crop-box-height")).toBe("600px");
    expect(stage().getAttribute("aria-label")).toBe(
      "裁剪区域。拖动调整位置，双指缩放，拖动四角改变裁剪范围；左右方向键切换照片",
    );
    // 还原 and 旋转 side by side at the bottom: every button within 52px
    // of the stage's top or bottom edge, every handle 60px or more inside.
    expect(editCss as string).toMatch(
      /\.stageRail \{[^}]*flex-direction: row;/u,
    );
  });

  it("turns the four corners into labelled handles, the frame's marks staying decorative", () => {
    layOutStage();
    render({ items: three() });
    expect(handles()).toHaveLength(0);
    layOutFrame(4 / 3);
    const frame = container.querySelector<HTMLElement>("[data-edit-frame]")!;
    expect(frame.style.width).toBe("358px");
    expect(frame.style.height).toBe("268.5px");
    expect(frame.hasAttribute("aria-hidden")).toBe(false);
    expect(handles().map((entry) => entry.getAttribute("aria-label"))).toEqual([
      "调整裁剪左上角",
      "调整裁剪右上角",
      "调整裁剪左下角",
      "调整裁剪右下角",
    ]);
    for (const entry of handles()) {
      expect(names(entry)).toEqual(["handle"]);
      expect(entry.type).toBe("button");
      expect(entry.closest("[data-edit-window]")).toBe(cropWindow());
      expect(entry.closest("[data-crop-own-control]")).not.toBe(null);
      expect(
        document.getElementById(entry.getAttribute("aria-describedby")!)!
          .textContent,
      ).toBe("拖动或用方向键调整裁剪范围");
    }
    const marks = [...frame.querySelectorAll("[data-corner]")];
    expect(marks.map((mark) => mark.getAttribute("data-corner"))).toEqual([
      "top-left",
      "top-right",
      "bottom-left",
      "bottom-right",
    ]);
    for (const mark of marks)
      expect(mark.getAttribute("aria-hidden")).toBe("true");
    expect(
      [...cropWindow().children]
        .filter((child) => child.tagName === "SPAN")
        .every(
          (child) =>
            child.getAttribute("aria-hidden") === "true" ||
            child.hasAttribute("data-crop-own-control"),
        ),
    ).toBe(true);
    // The 「动态流」 band is drawn in the window, hidden from assistive tech.
    click(container.querySelector<HTMLButtonElement>("[data-edit-feed-tool]")!);
    expect(
      cropWindow()
        .querySelector("[data-feed-window]")!
        .getAttribute("aria-hidden"),
    ).toBe("true");
  });

  it("keeps the whole stage and no handles where the field leaves too little, for a carried-over photo, or one without a preview", () => {
    layOutStage(390, 240);
    render({
      items: [item("a"), item("b", undefined, "legacy"), item("c")],
      servers: new Map([["c", null]]),
    });
    expect(stage().style.getPropertyValue("--crop-box-width")).toBe("390px");
    expect(stage().style.getPropertyValue("--crop-box-height")).toBe("240px");
    act(() => cropper.props!.onCropSizeChange!({ width: 320, height: 240 }));
    expect(container.querySelectorAll("[data-corner]")).toHaveLength(4);
    expect(handles()).toHaveLength(0);
    expect(stage().getAttribute("aria-label")).toBe(
      "裁剪区域。拖动调整位置，双指缩放；左右方向键切换照片",
    );
    click(thumb("b"));
    expect(container.querySelector("[data-edit-still]")).not.toBe(null);
    expect(handles()).toHaveLength(0);
    click(thumb("c"));
    expect(container.querySelector("[data-edit-fallback]")).not.toBe(null);
    expect(handles()).toHaveLength(0);
  });

  it("drags a corner at 原始比例 into a free crop: 自由, kept at once, the photo zoomed to fill the field", () => {
    layOutStage();
    render({ items: [item("a"), item("b")] });
    layOutFrame(4 / 3);
    mountReport(full);
    const mounted = cropper.mounts;
    const corner = handle("nw");
    press("pointerdown", corner, 10, 20);
    // Within the slop it is a tap, not a drag.
    press("pointermove", corner, 11, 21);
    expect(resizing()).toBe(false);
    press("pointermove", corner, 60, 60);
    act(() => vi.advanceTimersByTime(16));
    // The window follows the corner, the opposite one anchored; the photo
    // stays still under it and never steps back (no 0.94 peek).
    expect(resizing()).toBe(true);
    expect(stage().hasAttribute("data-gesture")).toBe(false);
    expect(
      container.querySelector("[data-media-crop]")!.hasAttribute("data-frozen"),
    ).toBe(true);
    expect(cropWindow().style.left).toBe("50px");
    expect(cropWindow().style.top).toBe("40px");
    expect(cropWindow().style.width).toBe("308px");
    expect(cropWindow().style.height).toBe("228.5px");
    expect(spies.applyEdit).not.toHaveBeenCalled();

    press("pointerup", corner, 60, 60);
    const kept = {
      x: 50 / 358,
      y: 40 / 268.5,
      width: 308 / 358,
      height: 228.5 / 268.5,
    };
    expect(spies.applyEdit).toHaveBeenCalledOnce();
    expect(spies.applyEdit.mock.calls[0]![0]).toBe("a");
    expect(lastEdit().rotation).toBe(0);
    expectCrop(lastEdit().crop, kept);
    expect(checkedRatios()).toEqual(["自由"]);
    // A new cropper of the dragged shape, seeded with it, centred at zoom 1
    // until the seed applies.
    expect(cropper.mounts).toBe(mounted + 1);
    expect(cropper.props!.aspect).toBeCloseTo(
      (kept.width * 4000) / (kept.height * 3000),
      5,
    );
    const seed = cropper.props!.initialCroppedAreaPercentages!;
    expect(seed.x).toBeCloseTo(kept.x * 100, 3);
    expect(seed.y).toBeCloseTo(kept.y * 100, 3);
    expect(seed.width).toBeCloseTo(kept.width * 100, 3);
    expect(seed.height).toBeCloseTo(kept.height * 100, 3);
    expect(cropper.props!.zoom).toBe(1);
    expect(cropper.props!.crop).toEqual({ x: 0, y: 0 });
    expect(resizing()).toBe(false);
    expect(cropWindow().style.cssText).toBe("");
    // The frame overlay stays (the new frame fills the field) while the
    // photo as it was covers the new cropper until it shows the crop.
    expect(
      container.querySelector<HTMLElement>("[data-edit-frame]")!.style.width,
    ).toBe("358px");
    const layer = reframeLayer()!;
    expect(layer.getAttribute("aria-hidden")).toBe("true");
    expect(layer.querySelector("img")!.getAttribute("src")).toBe("/display/a");
    reportSeed();
    expect(reframeLayer()).toBe(null);
    act(() => vi.advanceTimersByTime(2000));
    expect(spies.applyEdit).toHaveBeenCalledOnce();
    expect(album.items[0]!.edit.crop).toEqual(lastEdit().crop);
  });

  it("zooms the window to the field before the new cropper takes over, and lets it go after a second at most", () => {
    layOutStage();
    render({ items: [item("a"), item("b")], reducedMotion: false });
    layOutFrame(4 / 3);
    mountReport(full);
    dragCorner("nw", { x: 50, y: 40 });
    const motion = reframeLayer()!.firstElementChild as HTMLElement;
    // At first exactly as let go, then on to fill the field.
    expect(motion.style.transform).toBe("");
    const from = reframeLayer()!.querySelector<HTMLElement>("span")!;
    expect(from.style.left).toBe("66px");
    expect(from.style.width).toBe("308px");
    act(() => vi.advanceTimersByTime(16));
    expect(motion.style.transform).toContain(`scale(${358 / 308})`);
    // The new cropper's seed alone does not end the zoom, its end does.
    reportSeed();
    expect(reframeLayer()).not.toBe(null);
    act(() => {
      motion.dispatchEvent(new Event("transitionend", { bubbles: true }));
    });
    expect(reframeLayer()).toBe(null);

    // A cropper that never shows its seed: a second at most.
    dragCorner("se", { x: -40, y: -30 });
    expect(reframeLayer()).not.toBe(null);
    act(() => vi.advanceTimersByTime(REFRAME_MAX_MS - 1));
    expect(reframeLayer()).not.toBe(null);
    act(() => vi.advanceTimersByTime(1));
    expect(reframeLayer()).toBe(null);

    // Nor does it outlive its photo.
    dragCorner("se", { x: -40, y: -30 });
    expect(reframeLayer()).not.toBe(null);
    click(thumb("b"));
    expect(reframeLayer()).toBe(null);
  });

  it("keeps a preset's ratio while its corner is dragged, the crop snapped to it", () => {
    layOutStage();
    render({ items: three() });
    click(ratio("4:5"));
    expect(spies.applyEdit).toHaveBeenCalledOnce();
    layOutFrame(0.8);
    mountReport({ x: 20, y: 0, width: 60, height: 100 });
    const mounted = cropper.mounts;
    // Mostly sideways, a little up: the shape holds along the diagonal.
    dragCorner("se", { x: -60, y: -20 });
    const scale = (298 * 358 + 427.5 * 447.5) / (358 * 358 + 447.5 * 447.5);
    expect(checkedRatios()).toEqual(["4:5"]);
    expect(spies.applyEdit).toHaveBeenCalledTimes(2);
    const crop = lastEdit().crop!;
    expect((crop.width * 4000) / (crop.height * 3000)).toBeCloseTo(0.8, 5);
    expect(crop.x).toBeCloseTo(0.2, 4);
    expect(crop.y).toBeCloseTo(0, 5);
    expect(crop.width).toBeCloseTo(0.6 * scale, 4);
    expect(crop.height).toBeCloseTo(scale, 4);
    expect(cropper.mounts).toBe(mounted + 1);
    expect(cropper.props!.aspect).toBeCloseTo(0.8);
  });

  it("frees a preset's corners with 自由, keeping its crop and its cropper", () => {
    layOutStage();
    render({ items: three() });
    click(ratio("4:5"));
    const mounted = cropper.mounts;
    click(ratio("自由"));
    expect(checkedRatios()).toEqual(["自由"]);
    expect(cropper.mounts).toBe(mounted);
    expect(cropper.props!.aspect).toBeCloseTo(0.8);
    act(() => vi.advanceTimersByTime(2000));
    expect(spies.applyEdit).toHaveBeenCalledOnce();
    expect(applyAll().getAttribute("aria-disabled")).toBe("true");

    // Free now: a sideways drag changes the shape.
    layOutFrame(0.8);
    mountReport({ x: 20, y: 0, width: 60, height: 100 });
    dragCorner("se", { x: -60, y: 0 });
    const shape = { x: 0.2, y: 0, width: (0.6 * 298) / 358, height: 1 };
    expectCrop(lastEdit().crop, shape);
    expect(checkedRatios()).toEqual(["自由"]);
    expect(cropper.props!.aspect).toBeCloseTo((shape.width * 4000) / 3000, 5);
    reportSeed();

    // 还原: 原始比例, the whole frame again, with 撤销.
    click(button("还原"));
    expect(spies.applyEdit).toHaveBeenLastCalledWith("a", {
      rotation: 0,
      crop: null,
    });
    expect(checkedRatios()).toEqual(["原始比例"]);
    expect(toastText()).toBe("第 1 项已还原撤销");
  });

  it("maps a turned photo's window the same way, and keeps the turn", () => {
    layOutStage();
    render({ items: [item("a", { rotation: 90, crop: null }), item("b")] });
    expect(cropper.props!.rotation).toBe(90);
    layOutFrame(0.75);
    mountReport(full);
    const { width, height } = frameFor(0.75);
    dragCorner("nw", { x: 30, y: 40 });
    expect(spies.applyEdit).toHaveBeenCalledOnce();
    expect(lastEdit().rotation).toBe(90);
    expectCrop(lastEdit().crop, {
      x: 30 / width,
      y: 40 / height,
      width: (width - 30) / width,
      height: (height - 40) / height,
    });
    expect(cropper.props!.rotation).toBe(90);
  });

  it("takes an interrupted corner drag back, and a tap on a handle is no drag", () => {
    layOutStage();
    render({ items: three() });
    layOutFrame(4 / 3);
    mountReport(full);
    const mounted = cropper.mounts;
    const start = () => {
      press("pointerdown", handle("nw"), 0, 0);
      press("pointermove", handle("nw"), 40, 30);
      act(() => vi.advanceTimersByTime(16));
      expect(resizing()).toBe(true);
    };
    const expectTakenBack = () => {
      expect(resizing()).toBe(false);
      expect(cropWindow().style.cssText).toBe("");
      // Nothing more comes of the finger.
      press("pointerup", handle("nw"), 40, 30);
      expect(checkedRatios()).toEqual(["原始比例"]);
      expect(cropper.mounts).toBe(mounted);
      expect(spies.applyEdit).not.toHaveBeenCalled();
    };
    start();
    press("pointercancel", handle("nw"), 40, 30);
    expectTakenBack();
    start();
    press("lostpointercapture", handle("nw"), 40, 30);
    expectTakenBack();
    start();
    act(() => {
      window.dispatchEvent(new Event("blur"));
    });
    expectTakenBack();
    start();
    hidePage();
    expectTakenBack();
    start();
    act(() => {
      window.dispatchEvent(new Event("pagehide"));
    });
    expectTakenBack();
    // A finger landing outside the photo.
    start();
    act(() => {
      document.body.dispatchEvent(new Event("touchstart", { bubbles: true }));
    });
    expectTakenBack();
    // The back sheet opening over it.
    start();
    click(button("返回"));
    expect(sheet()).not.toBe(null);
    expectTakenBack();
    click(backAction("continue"));
    // A tap: nothing at all.
    press("pointerdown", handle("se"), 5, 5);
    press("pointerup", handle("se"), 6, 5);
    expect(resizing()).toBe(false);
    act(() => vi.advanceTimersByTime(2000));
    expect(spies.applyEdit).not.toHaveBeenCalled();
    expect(checkedRatios()).toEqual(["原始比例"]);
  });

  it("ignores a second pointer, keeps the photo still meanwhile and never leaves a window under 88px", () => {
    layOutStage();
    render({ items: three() });
    layOutFrame(4 / 3);
    mountReport(full);
    press("pointerdown", handle("nw"), 0, 0, { id: 1 });
    press("pointerdown", handle("se"), 0, 0, { id: 2 });
    press("pointermove", handle("nw"), 500, 500, { id: 1 });
    press("pointermove", handle("se"), -100, -100, { id: 2 });
    act(() => vi.advanceTimersByTime(16));
    expect(cropWindow().style.left).toBe("270px");
    expect(cropWindow().style.top).toBe("180.5px");
    expect(cropWindow().style.width).toBe("88px");
    expect(cropWindow().style.height).toBe("88px");
    // A finger on the photo meanwhile starts no gesture of its own.
    pointer("pointerdown", cropTarget(), 3);
    expect(stage().hasAttribute("data-gesture")).toBe(false);
    pointer("pointerup", window, 3);
    press("pointerup", handle("se"), -100, -100, { id: 2 });
    expect(spies.applyEdit).not.toHaveBeenCalled();
    press("pointerup", handle("nw"), 500, 500, { id: 1 });
    expectCrop(lastEdit().crop, {
      x: 270 / 358,
      y: 180.5 / 268.5,
      width: 88 / 358,
      height: 88 / 268.5,
    });
  });

  it("holds the photo still from the moment a corner is taken, before the finger has moved", () => {
    layOutStage();
    render({ items: three() });
    layOutFrame(4 / 3);
    mountReport(full);
    press("pointerdown", handle("nw"), 0, 0, { id: 1 });
    // Inside the slop: no drag yet, but the photo takes no touch already,
    // so a second finger landing with the first never pinches it.
    expect(resizing()).toBe(false);
    expect(
      container.querySelector("[data-media-crop]")!.hasAttribute("data-frozen"),
    ).toBe(true);
    expect(cropper.props!.onTouchRequest()).toBe(false);
    press("pointerdown", cropTarget(), 200, 200, { id: 2 });
    expect(stage().hasAttribute("data-gesture")).toBe(false);
    // The corner drags on over the photo as it was, and the crop is the
    // window over what was shown.
    press("pointermove", handle("nw"), 50, 40, { id: 1 });
    act(() => vi.advanceTimersByTime(16));
    expect(resizing()).toBe(true);
    expect(stage().hasAttribute("data-gesture")).toBe(false);
    press("pointerup", handle("nw"), 50, 40, { id: 1 });
    pointer("pointerup", window, 2);
    expect(spies.applyEdit).toHaveBeenCalledOnce();
    expectCrop(lastEdit().crop, {
      x: 50 / 358,
      y: 40 / 268.5,
      width: 308 / 358,
      height: 228.5 / 268.5,
    });
    expect(cropper.props!.zoom).toBe(1);
    // Let go, and once the new cropper shows the crop, the photo is the
    // fingers' again; a tap on a corner gives it back at once.
    reportSeed();
    expect(cropper.props!.onTouchRequest()).toBe(true);
    press("pointerdown", handle("se"), 5, 5);
    expect(cropper.props!.onTouchRequest()).toBe(false);
    press("pointerup", handle("se"), 6, 5);
    expect(cropper.props!.onTouchRequest()).toBe(true);
    expect(spies.applyEdit).toHaveBeenCalledOnce();
  });

  it("holds the photo in the very turn a corner is taken, before any render", () => {
    layOutStage();
    render({ items: three() });
    layOutFrame(4 / 3);
    mountReport(full);
    const frame = container.querySelector("[data-media-crop]")!;
    let rendered = true;
    let touch = true;
    // Both fingers land in one turn: nothing renders between them.
    act(() => {
      press("pointerdown", handle("nw"), 0, 0, { id: 1 });
      rendered = frame.hasAttribute("data-frozen");
      touch = cropper.props!.onTouchRequest();
      press("pointerdown", cropTarget(), 200, 200, { id: 2 });
    });
    expect(rendered).toBe(false);
    expect(touch).toBe(false);
    expect(stage().hasAttribute("data-gesture")).toBe(false);
    press("pointerup", handle("nw"), 0, 0, { id: 1 });
    pointer("pointerup", window, 2);
    expect(spies.applyEdit).not.toHaveBeenCalled();
    expect(cropper.props!.onTouchRequest()).toBe(true);
  });

  it("frees a 16:9 a desktop dialog handed over: 自由 at its own shape, in the same cropper, the corners free", () => {
    layOutStage();
    // The desktop dialog's 16:9, adopted by a layout swap (`explicit`).
    ui.saveCropDraft("a", {
      basis: { rotation: 0, crop: null },
      rotation: 0,
      stored: {
        previewable: true,
        session: { ...startCrop("16:9", null), generation: 1 },
      },
      explicit: true,
    });
    render({ items: three() });
    expect(checkedRatios()).toEqual(["自由"]);
    expect(ratio("自由").tabIndex).toBe(0);
    expect(cropper.mounts).toBe(1);
    expect(cropper.props!.aspect).toBeCloseTo(16 / 9);
    expect(applyAll().getAttribute("aria-disabled")).toBe("true");
    // A sideways drag changes the shape: nothing holds 16:9 any more.
    layOutFrame(16 / 9);
    mountReport({ x: 0, y: 12.5, width: 100, height: 75 });
    expect(cropper.mounts).toBe(1);
    dragCorner("se", { x: -60, y: 0 });
    expectCrop(lastEdit().crop, {
      x: 0,
      y: 0.125,
      width: 298 / 358,
      height: 0.75,
    });
    expect(checkedRatios()).toEqual(["自由"]);
    expect(cropper.props!.aspect).toBeCloseTo((298 / 358 / 0.75) * (4 / 3), 5);
  });

  it("resizes from the keyboard: a run of arrow presses is one reframe once they rest, Escape drops one, focus stays", () => {
    layOutStage();
    render({ items: three() });
    layOutFrame(4 / 3);
    mountReport(full);
    const corner = handle("se");
    act(() => corner.focus());
    // The crop area's zoom keys stay off the photo here.
    keyPress(corner, "+");
    expect(cropper.props!.zoom).toBe(1);
    for (let press = 0; press < 3; press += 1) keyPress(corner, "ArrowLeft");
    expect(resizing()).toBe(true);
    expect(cropWindow().style.width).toBe("334px");
    // Shift takes a fifth of a step.
    keyPress(corner, "ArrowUp", { shiftKey: true });
    expect(Number.parseFloat(cropWindow().style.height)).toBeCloseTo(266.9, 5);
    act(() => vi.advanceTimersByTime(399));
    expect(spies.applyEdit).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(1));
    expect(spies.applyEdit).toHaveBeenCalledOnce();
    expectCrop(lastEdit().crop, {
      x: 0,
      y: 0,
      width: 334 / 358,
      height: 266.9 / 268.5,
    });
    expect(checkedRatios()).toEqual(["自由"]);
    // The same handle, focused, across the new cropper.
    expect(handle("se")).toBe(corner);
    expect(document.activeElement).toBe(corner);
    reportSeed();

    // Escape drops a window the keys moved.
    keyPress(corner, "ArrowLeft");
    expect(resizing()).toBe(true);
    keyPress(corner, "Escape");
    expect(resizing()).toBe(false);
    expect(cropWindow().style.cssText).toBe("");
    act(() => vi.advanceTimersByTime(1000));
    expect(spies.applyEdit).toHaveBeenCalledOnce();
  });

  it("keeps nothing while a finger is down: the idle wait stands still, and leaving keeps the photo as the finger found it", () => {
    render({ items: [item("a"), item("b")] });
    pointer("pointerdown", cropTarget());
    act(() => cropper.props!.onCropChange({ x: -12, y: -3 }));
    act(() =>
      cropper.props!.onCropAreaChange({ x: 10, y: 10, width: 80, height: 80 }),
    );
    act(() => vi.advanceTimersByTime(2000));
    expect(spies.applyEdit).not.toHaveBeenCalled();
    // Lifted: kept once the wait is over.
    pointer("pointerup", window);
    act(() => vi.advanceTimersByTime(799));
    expect(spies.applyEdit).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(1));
    expect(spies.applyEdit).toHaveBeenCalledExactlyOnceWith("a", {
      rotation: 0,
      crop: { x: 0.1, y: 0.1, width: 0.8, height: 0.8 },
    });

    // Down again and moved: 下一步 and a switch meanwhile keep the photo as
    // the finger found it, and it resumes so.
    pointer("pointerdown", cropTarget());
    act(() => cropper.props!.onCropChange({ x: -30, y: -3 }));
    act(() =>
      cropper.props!.onCropAreaChange({ x: 0, y: 10, width: 80, height: 80 }),
    );
    click(button("下一步"));
    expect(spies.onNext).toHaveBeenCalledOnce();
    click(thumb("b"));
    pointer("pointerup", window);
    click(thumb("a"));
    expect(cropper.props!.initialCroppedAreaPercentages).toEqual({
      x: 10,
      y: 10,
      width: 80,
      height: 80,
    });
    act(() => vi.advanceTimersByTime(2000));
    expect(spies.applyEdit).toHaveBeenCalledOnce();
    expect(album.items[0]!.edit.crop).toEqual({
      x: 0.1,
      y: 0.1,
      width: 0.8,
      height: 0.8,
    });
  });

  it("waits for the last finger before an earlier change is kept by the idle wait", () => {
    render({ items: three() });
    drag({ x: 10, y: 10, width: 80, height: 80 });
    act(() => vi.advanceTimersByTime(400));
    // A finger lands before the change was kept: the wait stands still.
    pointer("pointerdown", cropTarget());
    act(() => vi.advanceTimersByTime(2000));
    expect(spies.applyEdit).not.toHaveBeenCalled();
    act(() => cropper.props!.onCropChange({ x: -20, y: -3 }));
    act(() =>
      cropper.props!.onCropAreaChange({ x: 5, y: 10, width: 80, height: 80 }),
    );
    pointer("pointerup", window);
    act(() => vi.advanceTimersByTime(800));
    expect(spies.applyEdit).toHaveBeenCalledExactlyOnceWith("a", {
      rotation: 0,
      crop: { x: 0.05, y: 0.1, width: 0.8, height: 0.8 },
    });
  });

  it("keeps nothing while the back sheet is open, takes a gesture under way back, and keeps the rest once 继续编辑", async () => {
    render({ items: three() });
    drag({ x: 10, y: 10, width: 80, height: 80 });
    click(button("返回"));
    act(() => vi.advanceTimersByTime(2000));
    expect(spies.applyEdit).not.toHaveBeenCalled();
    click(backAction("continue"));
    act(() => vi.advanceTimersByTime(800));
    expect(spies.applyEdit).toHaveBeenCalledExactlyOnceWith("a", {
      rotation: 0,
      crop: { x: 0.1, y: 0.1, width: 0.8, height: 0.8 },
    });

    // A finger still on the photo as the sheet opens (the browser's Back):
    // its gesture is taken back, in a cropper of its own.
    const mounted = cropper.mounts;
    pointer("pointerdown", cropTarget());
    act(() => cropper.props!.onCropChange({ x: -30, y: 0 }));
    act(() =>
      cropper.props!.onCropAreaChange({ x: 0, y: 10, width: 80, height: 80 }),
    );
    act(() => ui.setBackAsk(true));
    expect(cropper.mounts).toBe(mounted + 1);
    expect(cropper.props!.initialCroppedAreaPercentages).toEqual({
      x: 10,
      y: 10,
      width: 80,
      height: 80,
    });
    pointer("pointerup", window);
    // 存草稿并退出 keeps the photo as it was: nothing new.
    spies.onSaveAndLeave.mockResolvedValueOnce(null);
    await act(async () => {
      backAction("leave").click();
      await Promise.resolve();
    });
    expect(spies.onSaveAndLeave).toHaveBeenCalledOnce();
    expect(spies.applyEdit).toHaveBeenCalledOnce();
  });

  it("ends a pan once the page loses the finger, keeping it as today, and a new touch clears a lift it never saw", () => {
    render({ items: three() });
    pointer("pointerdown", cropTarget());
    act(() => cropper.props!.onCropChange({ x: -12, y: -3 }));
    act(() =>
      cropper.props!.onCropAreaChange({ x: 10, y: 10, width: 80, height: 80 }),
    );
    expect(stage().hasAttribute("data-gesture")).toBe(true);
    act(() => {
      window.dispatchEvent(new Event("blur"));
    });
    expect(stage().hasAttribute("data-gesture")).toBe(false);
    act(() => vi.advanceTimersByTime(800));
    expect(spies.applyEdit).toHaveBeenCalledExactlyOnceWith("a", {
      rotation: 0,
      crop: { x: 0.1, y: 0.1, width: 0.8, height: 0.8 },
    });
    pointer("pointerdown", cropTarget());
    act(() => {
      window.dispatchEvent(new Event("pagehide"));
    });
    expect(stage().hasAttribute("data-gesture")).toBe(false);
    pointer("pointerdown", cropTarget());
    hidePage();
    expect(stage().hasAttribute("data-gesture")).toBe(false);

    // A lift lost to the system: the next touch starts afresh, and its own
    // lift ends it (the idle wait never stays stopped).
    press("pointerdown", cropTarget(), 0, 0, { id: 7, primary: true });
    press("pointerdown", cropTarget(), 0, 0, { id: 8, primary: true });
    act(() => cropper.props!.onCropChange({ x: -20, y: -3 }));
    act(() =>
      cropper.props!.onCropAreaChange({ x: 5, y: 10, width: 80, height: 80 }),
    );
    pointer("pointerup", window, 8);
    expect(stage().hasAttribute("data-gesture")).toBe(false);
    act(() => vi.advanceTimersByTime(800));
    expect(spies.applyEdit).toHaveBeenLastCalledWith("a", {
      rotation: 0,
      crop: { x: 0.05, y: 0.1, width: 0.8, height: 0.8 },
    });
  });

  it("turns 原始比例 into 自由 once a move or zoom makes a crop, without a new cropper; a pan that moves nothing stays", () => {
    render({ items: three() });
    mountReport(full);
    const mounted = cropper.mounts;
    pointer("pointerdown", cropTarget());
    act(() => cropper.props!.onCropChange({ x: 0, y: 0 }));
    act(() => cropper.props!.onCropAreaChange(full));
    pointer("pointerup", window);
    expect(checkedRatios()).toEqual(["原始比例"]);

    pointer("pointerdown", cropTarget());
    act(() => cropper.props!.onZoomChange(1.25));
    act(() =>
      cropper.props!.onCropAreaChange({ x: 10, y: 10, width: 80, height: 80 }),
    );
    expect(checkedRatios()).toEqual(["自由"]);
    expect(cropper.mounts).toBe(mounted);
    expect(cropper.props!.aspect).toBeCloseTo(4 / 3);
    // Zoomed back out, it stays the author's 自由.
    act(() => cropper.props!.onZoomChange(1));
    act(() => cropper.props!.onCropAreaChange(full));
    pointer("pointerup", window);
    expect(checkedRatios()).toEqual(["自由"]);
    expect(applyAll().getAttribute("aria-disabled")).toBe("true");
    // A turn at 自由 starts again at 原始比例 (as for any custom shape).
    click(button("向右旋转 90°"));
    expect(checkedRatios()).toEqual(["原始比例"]);
    expect(spies.applyEdit).toHaveBeenLastCalledWith("a", {
      rotation: 90,
      crop: null,
    });
  });

  it("zooms as far as a reopened small crop needs, and only the shared 3× otherwise", () => {
    render({
      items: [
        item("a", {
          rotation: 0,
          crop: { x: 0.4, y: 0.4, width: 0.2, height: 0.2 },
        }),
        item("b"),
      ],
    });
    expect(checkedRatios()).toEqual(["自由"]);
    expect(cropper.props!.maxZoom).toBeGreaterThanOrEqual(5);
    expect(cropper.props!.maxZoom).toBeCloseTo(5, 2);
    for (let step = 0; step < 60; step += 1) key(cropTarget(), "=");
    expect(cropper.props!.zoom).toBe(cropper.props!.maxZoom);
    click(thumb("b"));
    expect(cropper.props!.maxZoom).toBe(3);
  });

  it("keeps the seed a new cropper applies as it mounts, never resetting it afterwards", () => {
    cropper.seeding = true;
    const square = { x: 0.125, y: 0, width: 0.75, height: 1 };
    render({ items: [item("a", { rotation: 0, crop: square }), item("b")] });
    expect(cropper.props!.zoom).toBeCloseTo(100 / 75);
    expect(cropper.props!.crop).toEqual({ x: -7, y: -3 });
    // A new generation without a seed starts centred at zoom 1 …
    click(button("向右旋转 90°"));
    expect(cropper.props!.zoom).toBe(1);
    expect(cropper.props!.crop).toEqual({ x: 0, y: 0 });
    // … and one with a seed (撤销 of the turn) keeps where it seeded itself.
    undo();
    expect(cropper.props!.initialCroppedAreaPercentages).toEqual({
      x: 12.5,
      y: 0,
      width: 75,
      height: 100,
    });
    expect(cropper.props!.zoom).toBeCloseTo(100 / 75);
    expect(cropper.props!.crop).toEqual({ x: -7, y: -3 });
    act(() => vi.advanceTimersByTime(2000));
    // The turn and its 撤销: the seeding is never an edit.
    expect(spies.applyEdit).toHaveBeenCalledTimes(2);
  });

  it("hands the stage to another tool: no handles, no gesture, the photo's keys held back, a drag under way taken back", () => {
    layOutStage();
    const Stage = ({ paused }: { readonly paused: boolean }) => {
      const crop = useStageCrop({
        item: item("a"),
        src: "/display/a",
        blob: null,
        knownSize: { width: 4000, height: 3000 },
        drafts: ui,
        editable: true,
        onCommit: spies.applyEdit,
      });
      return (
        <EditStage
          crop={crop}
          cropPaused={paused}
          derivativeExpected={false}
          enter={undefined}
          feedHint={null}
          feedTool="off"
          feedWindow={null}
          hint={false}
          onFeedRegion={() => undefined}
          onFix={() => undefined}
          onGestureEnd={() => undefined}
          onInput={() => undefined}
          onPage={() => undefined}
          onRevert={() => undefined}
          onRotate={() => undefined}
          onToggleFeedTool={() => undefined}
          status={ready}
          uploadFailed={false}
        />
      );
    };
    act(() => root.render(<Stage paused={false} />));
    layOutFrame(4 / 3);
    expect(handles()).toHaveLength(4);
    press("pointerdown", handle("nw"), 0, 0);
    press("pointermove", handle("nw"), 40, 30);
    act(() => root.render(<Stage paused />));
    expect(handles()).toHaveLength(0);
    expect(resizing()).toBe(false);
    expect(container.querySelectorAll("[data-corner]")).toHaveLength(4);
    expect(
      container.querySelector("[data-media-crop]")!.hasAttribute("data-frozen"),
    ).toBe(true);
    expect(cropper.props!.onTouchRequest()).toBe(false);
    pointer("pointerdown", cropTarget());
    expect(stage().hasAttribute("data-gesture")).toBe(false);
    const arrow = new KeyboardEvent("keydown", {
      key: "ArrowLeft",
      bubbles: true,
      cancelable: true,
    });
    act(() => {
      cropTarget().dispatchEvent(arrow);
    });
    expect(arrow.defaultPrevented).toBe(true);
    act(() => root.render(<Stage paused={false} />));
    expect(handles()).toHaveLength(4);
    expect(cropper.props!.onTouchRequest()).toBe(true);
    act(() => vi.advanceTimersByTime(2000));
    expect(spies.applyEdit).not.toHaveBeenCalled();
  });

  it("reopens on the phone at 原始比例 only for the whole frame, a fixed ratio for its shape, 自由 for any other", () => {
    const size = { width: 4000, height: 3000 };
    const square = { x: 0.125, y: 0, width: 0.75, height: 1 };
    const zoomed = { x: 0.1, y: 0.1, width: 0.8, height: 0.8 };
    const banner = { x: 0, y: 0.125, width: 1, height: 0.75 };
    const tall = { x: 0.2890625, y: 0, width: 0.421875, height: 1 };
    const preset = (crop: MediaCrop | null, rotation: 0 | 90 = 0) =>
      phoneInitialSession({ rotation: 0, crop }, size, rotation).preset;
    expect(preset(null)).toBe("original");
    expect(preset(square)).toBe("1:1");
    expect(preset(zoomed)).toBe("custom");
    expect(preset(banner)).toBe("custom");
    expect(preset(tall)).toBe("custom");
    // A turn made before the preview opened starts again, as in the dialog.
    expect(preset(square, 90)).toBe("original");
    // The desktop dialog keeps its labels.
    expect(initialSession({ rotation: 0, crop: zoomed }, size, 0).preset).toBe(
      "original",
    );
    expect(initialSession({ rotation: 0, crop: banner }, size, 0).preset).toBe(
      "16:9",
    );
  });

  it("draws the crop window, its handles and the reframe zoom with tokens", () => {
    const css = editCss as string;
    expect(css).toMatch(
      /\.stage\[data-resizing\] \.cropBox \.stageCropArea \{\s*color: transparent;\s*border-color: transparent;/u,
    );
    expect(css).toMatch(
      /\.stage\[data-resizing\] \.window \{\s*box-shadow:\s*inset 0 0 0 1px var\(--crop-line\),\s*0 0 0 9999em var\(--dim-mask\);/u,
    );
    expect(css).toMatch(/\.stage\[data-resizing\] \.thirds \{\s*opacity: 1;/u);
    expect(css).toMatch(
      /\.stage\[data-resizing\] \.stageRail \{\s*opacity: 0;\s*pointer-events: none;/u,
    );
    expect(css).toMatch(
      /\.handle \{[^}]*width: 44px;[^}]*height: 44px;[^}]*pointer-events: auto;[^}]*touch-action: none;/u,
    );
    expect(css).toMatch(
      /\.cropBox\[data-frozen\] > :first-child \{[^}]*pointer-events: none;/u,
    );
    // One mask darkness: the frame's at rest, the window's, the zoom's.
    expect(css).toMatch(/\.reframeWindow \{[^}]*var\(--dim-mask\)/u);
    expect(css).toMatch(
      /@media \(prefers-reduced-motion: reduce\) \{[^@]*\.reframeMotion,/u,
    );
    // Six segments whole from a 320px phone.
    expect(css).toMatch(
      /\.segment\[data-count="6"\] \{\s*grid-template-columns:\s*minmax\(max-content, 1\.2fr\) minmax\(max-content, 0\.8fr\)\s*repeat\(4, minmax\(0, 1fr\)\);/u,
    );
  });
});

describe("EditScreen 「动态流」 tool (#341)", () => {
  /** A 1:3 photo against the 4:5 stage it sets: 41.7 % shown, 175px of 300 cut. */
  const tall = (
    key: string,
    edit: MediaEdit = { rotation: 0, crop: null },
    qualityMode: WorkDraftItem["qualityMode"] = "standard",
  ) => item(key, edit, qualityMode);
  const tallServer = (key: string) =>
    server(key, { width: 1000, height: 3000 });
  const renderTall = (setup: Partial<Setup> = {}) =>
    render({
      items: [tall("a"), tall("b"), item("c")],
      servers: new Map([
        ["a", tallServer("a")],
        ["b", tallServer("b")],
        ["c", server("c")],
      ]),
      stageRatio: 1.25,
      ...setup,
    });
  const layOutFrame = (width = 100, height = 300) =>
    act(() => cropper.props!.onCropSizeChange!({ width, height }));

  const tool = () =>
    container.querySelector<HTMLButtonElement>("[data-edit-feed-tool]")!;
  const slider = () =>
    container.querySelector<HTMLElement>('[data-feed-control][role="slider"]');
  const band = () => container.querySelector<HTMLElement>("[data-feed-window]");
  const edges = () =>
    [...band()!.querySelectorAll<HTMLElement>("[data-edge]")].map((edge) => [
      edge.getAttribute("data-edge"),
      Number.parseFloat(edge.style.height),
    ]);
  const fitBar = () => container.querySelector("[data-edit-feed-fit]");
  const fit = (name: "region" | "whole") =>
    container.querySelector<HTMLButtonElement>(`[data-feed-choice="${name}"]`)!;
  const note = () => container.querySelector("[data-edit-feed-note]");
  const feedOf = (key: string) =>
    album.items.find((entry) => entry.key === key)!.edit.feed;
  const valueNow = () => Number(slider()!.getAttribute("aria-valuenow"));
  const backAction = (name: string) =>
    sheet()!.querySelector<HTMLButtonElement>(`[data-back-action="${name}"]`)!;

  /** A pointer event at client y, as React reads it. */
  const press = (
    type: string,
    target: EventTarget,
    y: number,
    id = 1,
  ): MouseEvent => {
    const event = new MouseEvent(type, {
      bubbles: true,
      cancelable: true,
      button: 0,
      clientX: 50,
      clientY: y,
    });
    Object.defineProperties(event, {
      pointerId: { value: id },
      pointerType: { value: "touch" },
    });
    act(() => {
      target.dispatchEvent(event);
    });
    return event;
  };
  const keyOn = (
    target: HTMLElement,
    name: string,
    init: KeyboardEventInit = {},
  ): KeyboardEvent => {
    const event = new KeyboardEvent("keydown", {
      key: name,
      bubbles: true,
      cancelable: true,
      ...init,
    });
    act(() => {
      target.dispatchEvent(event);
    });
    return event;
  };
  /** A finger on the window, moved by `dy` px, still down. */
  const grab = (dy: number, id = 1) => {
    press("pointerdown", slider()!, 100, id);
    press("pointermove", slider()!, 100 + dy / 2, id);
    press("pointermove", slider()!, 100 + dy, id);
  };
  const hidePage = () => {
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "hidden",
    });
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    delete (document as { visibilityState?: unknown }).visibilityState;
  };

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("tells each photo's state apart", () => {
    const cover = {
      fit: "cover",
      height: 0.5,
      top: 0.25,
      tall: true,
      stageRatio: 1.25,
    } as const;
    expect(feedToolState(false, cover, false)).toBe("off");
    expect(feedToolState(true, null, true)).toBe("pending");
    expect(feedToolState(true, null, false)).toBe("none");
    expect(
      feedToolState(true, { ...cover, fit: "contain", tall: false }, false),
    ).toBe("shown");
    expect(
      feedToolState(true, { ...cover, fit: "fill", tall: false }, false),
    ).toBe("shown");
    expect(feedToolState(true, cover, false)).toBe("region");
    expect(feedToolState(true, { ...cover, fit: "contain" }, false)).toBe(
      "whole",
    );
  });

  it("keeps the crop shown, then rests it: no handle, no gesture, no key, the ratio row away", () => {
    vi.useFakeTimers();
    vi.spyOn(Element.prototype, "clientWidth", "get").mockImplementation(
      function (this: Element) {
        return this.hasAttribute("data-edit-stage") ? 390 : 0;
      },
    );
    vi.spyOn(Element.prototype, "clientHeight", "get").mockImplementation(
      function (this: Element) {
        return this.hasAttribute("data-edit-stage") ? 600 : 0;
      },
    );
    render({ items: three() });
    act(() => cropper.props!.onCropSizeChange!({ width: 358, height: 268.5 }));
    expect(container.querySelectorAll("[data-crop-handle]").length).toBe(4);
    // A crop under way, not kept yet.
    drag({ x: 10, y: 10, width: 80, height: 80 });
    expect(spies.applyEdit).not.toHaveBeenCalled();
    expect(applyAll().getAttribute("aria-disabled")).toBe("true");
    click(tool());
    // Kept at once: the window lies over the frame the feed will have.
    expect(spies.applyEdit).toHaveBeenCalledExactlyOnceWith("a", {
      rotation: 0,
      crop: { x: 0.1, y: 0.1, width: 0.8, height: 0.8 },
    });
    expect(container.querySelectorAll("[data-crop-handle]")).toHaveLength(0);
    expect(container.querySelectorAll("[data-corner]")).toHaveLength(4);
    expect(
      container.querySelector("[data-media-crop]")!.hasAttribute("data-frozen"),
    ).toBe(true);
    expect(cropper.props!.onTouchRequest()).toBe(false);
    expect(cropper.props!.cropperProps["aria-label"]).toBe(
      "裁剪已暂停，关闭动态流后可调整",
    );
    pointer("pointerdown", cropTarget());
    expect(stage().hasAttribute("data-gesture")).toBe(false);
    pointer("pointerup", window);
    const arrow = keyOn(cropTarget(), "ArrowLeft");
    expect(arrow.defaultPrevented).toBe(true);
    act(() => vi.advanceTimersByTime(2000));
    expect(spies.applyEdit).toHaveBeenCalledOnce();
    // A 4:3 photo on the square stage the first one sets: nothing to choose.
    expect(container.querySelector("[data-edit-ratio]")).toBe(null);
    expect(fitBar()).toBe(null);
    expect(note()!.textContent).toBe("动态流中整张显示，无需选择");
    expect(stage().getAttribute("aria-label")).toBe(
      "动态流预览；左右方向键切换照片",
    );
    expect(applyAll().getAttribute("aria-disabled")).toBe("true");

    click(tool());
    expect(container.querySelector("[data-edit-ratio]")).not.toBe(null);
    expect(note()).toBe(null);
    expect(container.querySelectorAll("[data-crop-handle]")).toHaveLength(4);
    expect(cropper.props!.onTouchRequest()).toBe(true);
  });

  it("offers 局部 · 整张 for a tall photo, its region a vertical slider over the whole frame", () => {
    renderTall();
    layOutFrame();
    click(tool());
    const group = fitBar()!;
    expect(group.getAttribute("role")).toBe("radiogroup");
    expect(group.getAttribute("aria-label")).toBe("动态流显示");
    expect(group.getAttribute("data-count")).toBe("2");
    expect(
      [...group.querySelectorAll("[role='radio']")].map((radio) => [
        radio.textContent,
        radio.getAttribute("aria-checked"),
        radio.querySelector("svg") !== null,
      ]),
    ).toEqual([
      ["局部", "true", true],
      ["整张", "false", true],
    ]);
    expect(stage().getAttribute("aria-label")).toBe(
      "动态流显示范围。上下拖动选择显示的部分；左右方向键切换照片",
    );
    const control = slider()!;
    expect(names(control)).toEqual(["feedControl"]);
    expect(control.tabIndex).toBe(0);
    expect(control.getAttribute("aria-label")).toBe("动态流显示范围");
    expect(control.getAttribute("aria-orientation")).toBe("vertical");
    expect(control.getAttribute("aria-valuemin")).toBe("0");
    expect(control.getAttribute("aria-valuemax")).toBe("100");
    expect(valueNow()).toBe(50);
    expect(control.getAttribute("aria-valuetext")).toBe("居中，上下各裁去 29%");
    expect(control.hasAttribute("data-crop-own-control")).toBe(true);
    expect(control.closest("[data-edit-window]")).not.toBe(null);
    expect(
      document.getElementById(control.getAttribute("aria-describedby")!)!
        .textContent,
    ).toContain("上下拖动选择显示的部分");
    // The band beside it stays hidden from assistive tech.
    expect(band()!.getAttribute("aria-hidden")).toBe("true");
  });

  it("moves the region from the keyboard, each step kept at once (the APG's vertical slider)", () => {
    renderTall();
    layOutFrame();
    click(tool());
    const control = slider()!;
    act(() => control.focus());
    // ↑ raises the value: the window moves up. It reaches the slider
    // through the resting cropper's own key lock.
    const up = keyOn(control, "ArrowUp");
    expect(up.defaultPrevented).toBe(true);
    expect(spies.applyFeed).toHaveBeenLastCalledWith("a", {
      fit: "cover",
      y: 0.45,
    });
    expect(feedOf("a")).toEqual({ fit: "cover", y: 0.45 });
    expect(valueNow()).toBe(55);
    expect(slider()!.getAttribute("aria-valuetext")).toBe(
      "上方裁去 26%，下方裁去 32%",
    );
    // Back to the centre: stored as no framing at all.
    keyOn(slider()!, "ArrowDown");
    expect(feedOf("a")).toBeUndefined();
    expect("feed" in album.items[0]!.edit).toBe(false);
    keyOn(slider()!, "ArrowDown", { shiftKey: true });
    expect(feedOf("a")).toEqual({ fit: "cover", y: 0.51 });
    keyOn(slider()!, "PageUp");
    expect(feedOf("a")).toEqual({ fit: "cover", y: 0.26 });
    keyOn(slider()!, "PageDown");
    expect(feedOf("a")).toEqual({ fit: "cover", y: 0.51 });
    // Home the minimum (the bottom), End the maximum (the top).
    keyOn(slider()!, "Home");
    expect(feedOf("a")).toEqual({ fit: "cover", y: 1 });
    expect(valueNow()).toBe(0);
    expect(edges()).toEqual([["top", expect.closeTo(175, 3)]]);
    keyOn(slider()!, "End");
    expect(feedOf("a")).toEqual({ fit: "cover", y: 0 });
    expect(valueNow()).toBe(100);
    // Only the edge that cuts something is drawn.
    expect(edges()).toEqual([["bottom", expect.closeTo(175, 3)]]);
    const label = band()!.lastElementChild as HTMLElement;
    expect(Number.parseFloat(label.style.top)).toBeCloseTo(89, 3);
    // Nothing further up: no new edit.
    spies.applyFeed.mockClear();
    keyOn(slider()!, "ArrowUp");
    keyOn(slider()!, "PageUp");
    expect(spies.applyFeed).not.toHaveBeenCalled();
    // ← → stay the stage's, + − 0 never reach the photo.
    expect(keyOn(slider()!, "ArrowLeft").defaultPrevented).toBe(false);
    keyOn(slider()!, "+");
    expect(cropper.props!.zoom).toBe(1);
    expect(spies.applyEdit).not.toHaveBeenCalled();
  });

  it("drags the region with a finger and keeps it only once the finger lifts", () => {
    vi.useFakeTimers();
    renderTall();
    layOutFrame();
    click(tool());
    // A tap moves nothing.
    press("pointerdown", slider()!, 100);
    press("pointerup", slider()!, 101);
    expect(spies.applyFeed).not.toHaveBeenCalled();
    expect(slider()!.hasAttribute("data-dragging")).toBe(false);

    // 50px of the 175px the feed cuts.
    grab(50);
    expect(slider()!.hasAttribute("data-dragging")).toBe(true);
    expect(stage().hasAttribute("data-feed-drag")).toBe(true);
    expect(stage().hasAttribute("data-gesture")).toBe(false);
    expect(valueNow()).toBe(21);
    expect(edges()[0]![1]).toBeCloseTo(137.5, 3);
    act(() => vi.advanceTimersByTime(2000));
    expect(spies.applyFeed).not.toHaveBeenCalled();
    expect(feedOf("a")).toBeUndefined();
    press("pointerup", slider()!, 150);
    expect(spies.applyFeed).toHaveBeenCalledExactlyOnceWith("a", {
      fit: "cover",
      y: 0.7857,
    });
    expect(feedOf("a")).toEqual({ fit: "cover", y: 0.7857 });
    expect(stage().hasAttribute("data-feed-drag")).toBe(false);
    expect(slider()!.hasAttribute("data-dragging")).toBe(false);
    // Clamped at the bottom.
    grab(400);
    press("pointerup", slider()!, 500);
    expect(feedOf("a")).toEqual({ fit: "cover", y: 1 });
    expect(spies.applyEdit).not.toHaveBeenCalled();
  });

  it("takes an interrupted drag back, and a second finger never takes it over", () => {
    renderTall();
    layOutFrame();
    click(tool());
    const expectTakenBack = () => {
      expect(slider()!.hasAttribute("data-dragging")).toBe(false);
      expect(valueNow()).toBe(50);
      expect(stage().hasAttribute("data-feed-drag")).toBe(false);
      // Nothing more comes of the finger.
      press("pointerup", slider()!, 150);
      expect(spies.applyFeed).not.toHaveBeenCalled();
    };
    grab(50);
    press("pointercancel", slider()!, 150);
    expectTakenBack();
    grab(50);
    press("lostpointercapture", slider()!, 150);
    expectTakenBack();
    grab(50);
    act(() => {
      window.dispatchEvent(new Event("blur"));
    });
    expectTakenBack();
    grab(50);
    hidePage();
    expectTakenBack();
    grab(50);
    act(() => {
      window.dispatchEvent(new Event("pagehide"));
    });
    expectTakenBack();
    // Escape takes the drag back, never a step back of the screen.
    grab(50);
    const escape = keyOn(document.body, "Escape");
    expect(escape.defaultPrevented).toBe(true);
    expectTakenBack();
    expect(spies.onBack).not.toHaveBeenCalled();
    // The back sheet opening over it (the browser's Back).
    grab(50);
    act(() => ui.setBackAsk(true));
    expectTakenBack();
    click(backAction("continue"));

    // A second finger: ignored, the first one's drag goes on.
    grab(35);
    press("pointerdown", slider()!, 0, 2);
    press("pointermove", slider()!, 300, 2);
    expect(valueNow()).toBe(30);
    press("pointerup", slider()!, 300, 2);
    expect(spies.applyFeed).not.toHaveBeenCalled();
    press("pointerup", slider()!, 135);
    expect(spies.applyFeed).toHaveBeenCalledExactlyOnceWith("a", {
      fit: "cover",
      y: 0.7,
    });
  });

  it("switches 局部 and 整张, 整张 → 局部 bringing back the photo's region, and 还原 never brings back a reset one", () => {
    renderTall();
    layOutFrame();
    click(tool());
    for (let step = 0; step < 8; step += 1) keyOn(slider()!, "ArrowUp");
    expect(feedOf("a")).toEqual({ fit: "cover", y: 0.1 });

    click(fit("whole"));
    expect(feedOf("a")).toEqual({ fit: "contain" });
    expect(spies.announce).toHaveBeenLastCalledWith("动态流整张显示，左右留白");
    expect(fit("whole").getAttribute("aria-checked")).toBe("true");
    expect(slider()).toBe(null);
    expect(band()!.getAttribute("data-feed-fit")).toBe("contain");
    expect(band()!.hasAttribute("data-feed-whole")).toBe(true);
    expect(band()!.querySelectorAll("[data-edge]")).toHaveLength(0);
    expect(band()!.textContent).toBe("动态流整张显示 · 左右留白");
    expect(stage().getAttribute("aria-label")).toBe(
      "动态流预览；左右方向键切换照片",
    );
    expect(
      document.getElementById(tool().getAttribute("aria-describedby")!)!
        .textContent,
    ).toContain("动态中整张显示，左右留白");

    click(fit("region"));
    expect(feedOf("a")).toEqual({ fit: "cover", y: 0.1 });
    expect(spies.announce).toHaveBeenLastCalledWith(
      "动态流显示局部，上下拖动选择显示的部分",
    );
    expect(valueNow()).toBe(90);

    // 还原: centred again; 整张 and back stays centred.
    click(button("还原"));
    layOutFrame();
    expect(feedOf("a")).toBeUndefined();
    click(fit("whole"));
    click(fit("region"));
    expect(feedOf("a")).toBeUndefined();
    expect(valueNow()).toBe(50);
    // The roving radio group: arrows pick and move focus.
    act(() => fit("region").focus());
    keyOn(fit("region"), "ArrowRight");
    expect(feedOf("a")).toEqual({ fit: "contain" });
    expect(document.activeElement).toBe(fit("whole"));
    keyOn(fit("whole"), "ArrowRight");
    expect(feedOf("a")).toBeUndefined();
    expect(document.activeElement).toBe(fit("region"));
  });

  it("says a photo the feed shows full or whole needs no choice", () => {
    render({
      items: [item("a"), item("b"), item("c")],
      servers: new Map([
        ["a", server("a", { width: 4000, height: 5000 })],
        ["b", server("b", { width: 4000, height: 5000 })],
        ["c", server("c")],
      ]),
      stageRatio: 1.25,
    });
    layOutFrame(240, 300);
    click(tool());
    expect(toastText()).toBe("动态流：这张满幅显示，无需选择");
    expect(note()!.textContent).toBe("动态流中满幅显示，无需选择");
    expect(note()!.getAttribute("data-edit-feed-note")).toBe("shown");
    expect(fitBar()).toBe(null);
    expect(slider()).toBe(null);
    expect(band()!.getAttribute("data-feed-fit")).toBe("fill");
    click(thumb("c"));
    expect(note()!.textContent).toBe("动态流中整张显示，无需选择");
  });

  it("resets the crop, the turn and the framing with 还原, all three back with 撤销", () => {
    const square = { x: 0.125, y: 0, width: 0.75, height: 1 };
    const framed = {
      rotation: 0,
      crop: square,
      feed: { fit: "contain" },
    } as const;
    render({
      items: [
        item("a", framed),
        item("b", { rotation: 0, crop: null, feed: { fit: "cover", y: 0.2 } }),
      ],
    });
    expect(button("还原").getAttribute("aria-disabled")).toBe("false");
    click(button("还原"));
    expect(spies.applyEdit).toHaveBeenLastCalledWith("a", {
      rotation: 0,
      crop: null,
    });
    expect(spies.applyFeed).toHaveBeenLastCalledWith("a", undefined);
    expect(album.items[0]!.edit).toEqual({ rotation: 0, crop: null });
    expect(toastText()).toBe("第 1 项已还原撤销");
    expect(button("还原").getAttribute("aria-disabled")).toBe("true");
    undo();
    expect(album.items[0]!.edit).toEqual(framed);
    expect(checkedRatios()).toEqual(["1:1"]);

    // Framing alone is something to restore.
    click(thumb("b"));
    expect(button("还原").getAttribute("aria-disabled")).toBe("false");
    click(button("还原"));
    expect(album.items[1]!.edit).toEqual({ rotation: 0, crop: null });
    // Taken back from another photo: its framing comes back too.
    click(thumb("a"));
    undo();
    expect(album.items[1]!.edit).toEqual({
      rotation: 0,
      crop: null,
      feed: { fit: "cover", y: 0.2 },
    });

    // A turn keeps the framing, and so does its 撤销.
    click(button("向右旋转 90°"));
    expect(album.items[0]!.edit.feed).toEqual({ fit: "contain" });
    undo();
    expect(album.items[0]!.edit).toEqual(framed);
  });

  it("leaves every photo's framing alone through 应用到全部 and its 撤销", () => {
    const placed = { fit: "cover", y: 0.3 } as const;
    render({
      items: [
        item("a", { rotation: 0, crop: null, feed: placed }),
        item("b", { rotation: 0, crop: null, feed: { fit: "contain" } }),
        item("c"),
      ],
    });
    click(ratio("4:5"));
    click(applyAll());
    expect(album.items.map((entry) => entry.edit.feed)).toEqual([
      placed,
      { fit: "contain" },
      undefined,
    ]);
    expect(album.items[1]!.edit.crop).not.toBe(null);
    undo();
    expect(album.items.map((entry) => entry.edit)).toEqual([
      {
        rotation: 0,
        crop: { x: 0.2, y: 0, width: 0.6, height: 1 },
        feed: placed,
      },
      { rotation: 0, crop: null, feed: { fit: "contain" } },
      { rotation: 0, crop: null },
    ]);
    expect(spies.applyFeed).not.toHaveBeenCalled();
  });

  it("keeps each photo's framing across a switch, and follows the stage a new 首图 sets", () => {
    // b is 1000 × 1200: whole on a 4:5 stage, taller than a square one.
    render({
      items: [
        tall("a"),
        item("b", { rotation: 0, crop: null, feed: { fit: "cover", y: 0 } }),
        item("c"),
      ],
      servers: new Map([
        ["a", tallServer("a")],
        ["b", server("b", { width: 1000, height: 1200 })],
        ["c", server("c")],
      ]),
      stageRatio: 1.25,
    });
    layOutFrame();
    click(tool());
    keyOn(slider()!, "Home");
    expect(feedOf("a")).toEqual({ fit: "cover", y: 1 });
    click(thumb("b"));
    layOutFrame(250, 300);
    expect(tool().getAttribute("aria-pressed")).toBe("true");
    // Its stored region rests while the feed shows it whole, kept as it is.
    expect(note()!.textContent).toBe("动态流中整张显示，无需选择");
    expect(feedOf("b")).toEqual({ fit: "cover", y: 0 });
    // A square 首图 now (a reorder): b is taller than the stage, its region live.
    render({
      items: album.items,
      servers: new Map([
        ["a", tallServer("a")],
        ["b", server("b", { width: 1000, height: 1200 })],
        ["c", server("c")],
      ]),
      stageRatio: 1,
    });
    expect(fit("region").getAttribute("aria-checked")).toBe("true");
    expect(valueNow()).toBe(100);
    expect(edges()).toEqual([["bottom", expect.closeTo(50, 3)]]);
    click(thumb("a"));
    layOutFrame();
    expect(valueNow()).toBe(0);
  });

  it("waits, crop resting, while a photo's window is not known yet", () => {
    renderTall();
    layOutFrame();
    click(tool());
    render({
      items: album.items,
      servers: new Map([
        ["a", tallServer("a")],
        ["b", tallServer("b")],
        ["c", server("c")],
      ]),
      stageRatio: null,
    });
    click(thumb("b"));
    expect(note()!.textContent).toBe("正在确定动态流画幅…");
    expect(note()!.getAttribute("data-edit-feed-note")).toBe("pending");
    expect(container.querySelector("[data-edit-ratio]")).toBe(null);
    expect(tool().getAttribute("aria-disabled")).toBe("false");
    expect(
      container.querySelector("[data-media-crop]")!.hasAttribute("data-frozen"),
    ).toBe(true);
    // The window arrives: the tool was on all along, nothing locks anew.
    render({
      items: album.items,
      servers: new Map([
        ["a", tallServer("a")],
        ["b", tallServer("b")],
        ["c", server("c")],
      ]),
      stageRatio: 1.25,
    });
    layOutFrame();
    expect(fit("region").getAttribute("aria-checked")).toBe("true");
    // A photo without a preview says so.
    render({
      items: album.items,
      servers: new Map([
        ["a", tallServer("a")],
        ["b", tallServer("b")],
        ["c", null],
      ]),
      stageRatio: 1.25,
    });
    click(thumb("c"));
    expect(note()!.textContent).toBe(
      "这张图片暂时无法预览，不能选择动态流显示",
    );
    click(tool());
    expect(tool().getAttribute("aria-disabled")).toBe("true");
  });

  it("keeps focus on 「动态流」 as the press that leaves the tool turns it off on a photo without a window", () => {
    const servers = (c: PublishingMediaItem | null) =>
      new Map([
        ["a", tallServer("a")],
        ["b", tallServer("b")],
        ["c", c],
      ]);
    const leave = (state: string) => {
      expect(note()!.getAttribute("data-edit-feed-note")).toBe(state);
      act(() => tool().focus());
      click(tool());
      expect(tool().getAttribute("aria-pressed")).toBe("false");
      // Off now and unavailable, yet never natively disabled under focus.
      expect(tool().getAttribute("aria-disabled")).toBe("true");
      expect(tool().disabled).toBe(false);
      expect(document.activeElement).toBe(tool());
      // Another press does nothing.
      click(tool());
      expect(tool().getAttribute("aria-pressed")).toBe("false");
      expect(document.activeElement).toBe(tool());
    };
    // `pending`: photo 2 while the feed's stage is not known yet.
    renderTall();
    layOutFrame();
    click(tool());
    render({
      items: album.items,
      servers: servers(server("c")),
      stageRatio: null,
    });
    click(thumb("b"));
    leave("pending");
    // `none`: a photo without a preview.
    render({
      items: album.items,
      servers: servers(server("c")),
      stageRatio: 1.25,
    });
    click(thumb("a"));
    layOutFrame();
    click(tool());
    render({ items: album.items, servers: servers(null), stageRatio: 1.25 });
    click(thumb("c"));
    leave("none");
  });

  it("takes a turn back with its 撤销, never a framing chosen after the turn", () => {
    renderTall({
      items: [
        tall("a", { rotation: 0, crop: null, feed: { fit: "cover", y: 0.2 } }),
        tall("b"),
        item("c"),
      ],
    });
    layOutFrame();
    click(tool());
    expect(fit("region").getAttribute("aria-checked")).toBe("true");
    // Turned twice, upside down: taller than the stage again.
    click(button("向右旋转 90°"));
    click(button("向右旋转 90°"));
    expect(album.items[0]!.edit.rotation).toBe(180);
    click(fit("whole"));
    expect(feedOf("a")).toEqual({ fit: "contain" });
    expect(toastText()).toBe("已向右旋转 90°撤销");
    undo();
    expect(album.items[0]!.edit).toEqual({
      rotation: 90,
      crop: null,
      feed: { fit: "contain" },
    });
  });

  it("never turns on or off under a finger on the photo", () => {
    renderTall();
    pointer("pointerdown", cropTarget());
    act(() => tool().click());
    expect(tool().getAttribute("aria-pressed")).toBe("false");
    pointer("pointerup", window);
    click(tool());
    expect(tool().getAttribute("aria-pressed")).toBe("true");
  });

  it("frames a carried-over photo over its still, and 还原 resets that framing", () => {
    vi.spyOn(Element.prototype, "clientWidth", "get").mockImplementation(
      function (this: Element) {
        return this.closest("[data-edit-still]") !== null &&
          this.tagName === "IMG"
          ? 100
          : 0;
      },
    );
    vi.spyOn(Element.prototype, "clientHeight", "get").mockImplementation(
      function (this: Element) {
        return this.closest("[data-edit-still]") !== null &&
          this.tagName === "IMG"
          ? 300
          : 0;
      },
    );
    render({
      items: [tall("old", undefined, "legacy"), item("b")],
      servers: new Map([["old", tallServer("old")]]),
      stageRatio: 1.25,
    });
    expect(cropper.props).toBe(null);
    expect(button("还原").getAttribute("aria-disabled")).toBe("true");
    click(tool());
    const frame = container.querySelector<HTMLElement>(
      "[data-edit-still] [data-edit-still-frame]",
    )!;
    expect(names(frame)).toEqual(["frame"]);
    expect(frame.style.width).toBe("100px");
    expect(frame.style.height).toBe("300px");
    expect(fit("region").getAttribute("aria-checked")).toBe("true");
    expect(slider()!.closest("[data-edit-still-frame]")).toBe(frame);
    keyOn(slider()!, "End");
    expect(feedOf("old")).toEqual({ fit: "cover", y: 0 });
    grab(70);
    press("pointerup", slider()!, 170);
    expect(feedOf("old")).toEqual({ fit: "cover", y: 0.4 });
    click(fit("whole"));
    expect(feedOf("old")).toEqual({ fit: "contain" });
    // Its crop stays off; its framing is the author's to reset.
    expect(container.querySelector("[data-edit-locked]")!.textContent).toBe(
      LEGACY_NOTE,
    );
    expect(button("还原").getAttribute("aria-disabled")).toBe("false");
    click(button("还原"));
    expect(feedOf("old")).toBeUndefined();
    expect(spies.applyEdit).not.toHaveBeenCalled();
    undo();
    expect(feedOf("old")).toEqual({ fit: "contain" });
    expect(spies.applyEdit).not.toHaveBeenCalled();
  });

  it("draws the tool with tokens and the allowed sizes", () => {
    const css = editCss as string;
    expect(css).toMatch(
      /\.feedControl \{\s*position: absolute;\s*inset: 0;\s*pointer-events: auto;\s*touch-action: none;/u,
    );
    expect(css).toMatch(
      /\.stage\[data-feed-tool="on"\] \.thirds \{\s*opacity: 0;/u,
    );
    expect(css).toMatch(
      /\.stage\[data-feed-drag\] \.stageRail,\s*\.stage\[data-resizing\] \.stageTop,/u,
    );
    expect(css).toMatch(
      /\.segment\[data-count="2"\] \{\s*grid-template-columns: repeat\(2, minmax\(0, 1fr\)\);/u,
    );
    expect(css).toMatch(/\.feedNote \{[^}]*min-height: 44px;/u);
    // A zero-height edge would still draw its dashed border: none is rendered.
    expect(css).toMatch(
      /\.bandEdge\[data-edge="top"\] \{\s*top: 0;\s*border-bottom: 1px dashed var\(--crop-line\);/u,
    );
  });
});

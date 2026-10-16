"use client";

import { Icon } from "@moya/ui";
import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";

import { CropSurface } from "../../../media-composer/crop-surface";
import editorStyles from "../editor/editor.module.css";
import { CROP_IMAGE_EDGE } from "../media/bounded-preview";
import {
  restartCrop,
  resolvedCrop,
  resumeCrop,
  useNaturalSize,
} from "../media/crop-workspace";
import { initialSession } from "../media/media-edit-dialog";
import {
  EDIT_PRESETS,
  closeEdit,
  cropFromPercentages,
  cropRatio,
  normalizeCrop,
  presetRatio,
  rotatedSize,
  sameEdit,
  turn,
} from "../media/media-geometry";
import { useBoundedPreview } from "../media/media-preview";
import mediaStyles from "../media/media.module.css";
import styles from "./edit-screen.module.css";

import type { CropPreset, CropSession } from "../media/crop-workspace";
import type { FeedStageWindow, Size } from "../media/media-geometry";
import type { ItemStatus } from "../media/media-status";
import type { EditDraft, MediaUiStore } from "../media/media-ui-store";
import type {
  MediaCrop,
  MediaEdit,
  MediaRotation,
  WorkDraftItem,
} from "@moya/contracts";
import type {
  CSSProperties,
  Dispatch,
  KeyboardEvent as ReactKeyboardEvent,
  PointerEvent as ReactPointerEvent,
  SetStateAction,
  WheelEvent as ReactWheelEvent,
} from "react";

/**
 * The phone edit screen's stage (#244 r3, mockup B `.stage`): the current
 * photo full-bleed on paper-dark between the bar and the control band, on
 * the crop surface of the edit dialog (drag, two-finger zoom, Ctrl + wheel,
 * `+ − 0`, no slider). The crop frame is the largest frame of the chosen
 * ratio the stage holds and the photo covers it, dimmed outside the frame,
 * with corner marks; while a finger is down the frame steps back a little,
 * the thirds appear and the stage's own buttons fade. Over the photo: the
 * photo's state (a chip, or a button to its fix sheet when it needs the
 * author) and 动态流参考线 at the top, 还原 and 旋转 at the bottom right, and
 * the first-time hint. Photos change from the strip or the stage's arrow
 * keys only: one finger always moves the crop. The photos read right to
 * left as the strip draws them (r4 D10): ← brings in the next photo, which
 * slides in from the left, and → the previous one.
 *
 * The crop model is the dialog's (`CropSession`, `initialSession`); unlike
 * the dialog there is no 完成, so the screen keeps the edit itself (see
 * `useStageCrop`).
 */

/** Idle time after the last crop change before it is kept (plan v2). */
export const IDLE_COMMIT_MS = 800;
/**
 * How long after the last finger lifts the peek (the box scaled while a
 * finger is down) is surely gone: its transition is the normal duration.
 */
export const PEEK_SETTLE_MS = 400;
/** `normalizeCrop`'s full-frame tolerance, per edge. */
const FULL_EDGE = 1 - 0.002;
/** The keys the crop surface answers (react-easy-crop's arrows, `+ − 0`). */
const CROP_KEYS = new Set([
  "ArrowLeft",
  "ArrowRight",
  "ArrowUp",
  "ArrowDown",
  "+",
  "=",
  "-",
  "_",
  "0",
]);

type Stored = EditDraft["stored"];

/** The unfinished edit of the photo on the stage, in this opening of it. */
export interface StageWork {
  readonly key: string;
  /** The item's edit when the work started; a draft is resumed only against it. */
  readonly basis: MediaEdit;
  readonly rotation: MediaRotation;
  readonly stored: Stored;
  /** The author pointed at, wheeled or keyed the crop in this opening. */
  readonly input: boolean;
  /**
   * The author changed the photo in this opening: a turn, a ratio, 还原, or a
   * move or zoom that followed their own input. Only such work is kept by
   * the automatic commits (idle, leaving the photo or the screen): a
   * cropper's report of its own, which a turned or clamped photo can make
   * on any layout, never is (review r2).
   */
  readonly authored: boolean;
}

type CropDrafts = Pick<MediaUiStore, "cropDraftFor" | "saveCropDraft">;

/** A session in a new opening of its photo: where the author left it, untouched so far. */
const reopen = (session: CropSession): CropSession => ({
  ...resumeCrop(session),
  touched: false,
});

/**
 * Resumes the photo's crop draft while it still has the edit it was made on.
 * A draft that carries the author's unkept change (`explicit`: the desktop
 * edit dialog's turn or ratio, adopted by a layout swap) resumes as authored,
 * so the stage keeps it like its own; any other resumes untouched.
 */
const openWork = (drafts: CropDrafts, item: WorkDraftItem): StageWork => {
  const saved = drafts.cropDraftFor(item.key);
  if (saved === null || !sameEdit(saved.basis, item.edit))
    return {
      key: item.key,
      basis: item.edit,
      rotation: item.edit.rotation,
      stored: null,
      input: false,
      authored: false,
    };
  return {
    key: item.key,
    basis: saved.basis,
    rotation: saved.rotation,
    stored:
      saved.stored === null
        ? null
        : {
            previewable: saved.stored.previewable,
            session: reopen(saved.stored.session),
          },
    input: false,
    authored: saved.explicit === true,
  };
};

export interface StageCropOptions {
  readonly item: WorkDraftItem;
  /** The account's display derivative (unedited), preferred over local bytes. */
  readonly src: string | null;
  /** The local still, drawn as a bounded copy while no derivative exists. */
  readonly blob: Blob | null;
  readonly knownSize: Size | null;
  /** Where each photo's unfinished crop waits (the session's media UI store). */
  readonly drafts: CropDrafts;
  /** A carried-over `legacy` photo has no edit (as on the strip tile). */
  readonly editable: boolean;
  /** Keeps an edit: `media.applyEdit`, with its cover-crop reset notice. */
  readonly onCommit: (key: string, edit: MediaEdit) => void;
}

/** The stage as it was before a turn or 还原, for 撤销. */
export interface StageSnapshot {
  readonly key: string;
  /** The edit the stage showed. */
  readonly edit: MediaEdit;
  readonly rotation: MediaRotation;
  readonly previewable: boolean;
  readonly session: CropSession;
}

export interface StageCrop {
  readonly key: string;
  readonly image: string | null;
  /** The source size in display orientation, once known. */
  readonly size: Size | null;
  readonly previewable: boolean;
  readonly loading: boolean;
  readonly editable: boolean;
  readonly rotation: MediaRotation;
  readonly session: CropSession;
  readonly onSession: Dispatch<SetStateAction<CropSession>>;
  /** Width / height of the crop frame. */
  readonly ratio: number;
  /** The rotated frame; null without a preview. */
  readonly frame: Size | null;
  /** The edit the stage shows now (the stored one while nothing changed). */
  readonly next: MediaEdit;
  /** 还原 has something to undo: a turn, a crop or a chosen ratio. */
  readonly restorable: boolean;
  /** The photo is larger than the frame at this zoom, so a drag moves it. */
  readonly pannable: boolean;
  /** Every area the cropper reports, in percentages of the frame. */
  readonly report: (area: {
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
  }) => void;
  /** The cropper moved or zoomed: the author's only after their own input. */
  readonly touch: () => void;
  /** The author pointed at, wheeled or keyed the crop. */
  readonly noteInput: () => void;
  readonly rotate: () => void;
  readonly choosePreset: (preset: CropPreset) => void;
  readonly revert: () => void;
  /** Keeps the shown edit when the author changed it and it differs from the stored one. */
  readonly commit: () => void;
  /** The stage now, for 撤销 of a turn or 还原. */
  readonly snapshot: () => StageSnapshot;
  /** Brings a snapshot back and keeps its edit (撤销). */
  readonly restore: (snapshot: StageSnapshot) => void;
}

/**
 * The crop work of the photo on the stage. Kept (via `onCommit`) when the
 * screen leaves the photo (switch, ‹, 下一步, unmount), at once after a
 * turn, a ratio or 还原, and 800 ms after the last crop change, but only
 * once the author changed something in this opening (`authored`): the
 * cropper's own report when it mounts, relayouts or resumes is never an
 * edit. Unfinished work waits in `drafts` per photo, so a layout swap or a
 * switch back resumes it.
 */
export const useStageCrop = ({
  item,
  src,
  blob,
  knownSize,
  drafts,
  editable,
  onCommit,
}: StageCropOptions): StageCrop => {
  const local = useBoundedPreview(src === null ? blob : null, CROP_IMAGE_EDGE);
  const image = src ?? local.url;
  // The bounded copy knows its size: no second full decode to measure it.
  const natural = useNaturalSize(
    image,
    knownSize ?? (src === null ? local.size : null),
  );
  const size = natural.size;
  const previewable = image !== null && size !== null;
  const loading =
    (src === null && local.status === "loading") ||
    (image !== null && size === null && !natural.failed);

  // One photo's work at a time; another photo opens its own (or its draft).
  // An edit made elsewhere (撤销 of 应用到全部, a chosen version) sets the
  // work aside too: the stage shows the photo's edit as it now is, and the
  // set-aside crop can never be kept over it.
  const [opened, setOpened] = useState<StageWork>(() => openWork(drafts, item));
  let work = opened;
  const editedElsewhere =
    opened.key === item.key && !sameEdit(opened.basis, item.edit);
  if (opened.key !== item.key || editedElsewhere) {
    work = openWork(drafts, item);
    if (editedElsewhere) {
      // A new generation: the cropper starts again from the edit as it is
      // now, never from where the set-aside crop left it.
      const before =
        opened.stored !== null && opened.stored.previewable === previewable
          ? opened.stored.session.generation
          : 0;
      const session =
        work.stored !== null && work.stored.previewable === previewable
          ? work.stored.session
          : initialSession(item.edit, previewable ? size : null, work.rotation);
      work = {
        ...work,
        stored: {
          previewable,
          session: {
            ...session,
            generation: Math.max(before, session.generation) + 1,
          },
        },
      };
    }
    setOpened(work);
  }
  const edit = item.edit;
  const sessionOf = (current: StageWork): CropSession =>
    current.stored !== null && current.stored.previewable === previewable
      ? current.stored.session
      : initialSession(edit, previewable ? size : null, current.rotation);
  const update = (change: (current: StageWork) => StageWork) =>
    setOpened((current) =>
      current.key === item.key ? change(current) : current,
    );
  const onSession: Dispatch<SetStateAction<CropSession>> = (action) =>
    update((current) => {
      const base = sessionOf(current);
      return {
        ...current,
        stored: {
          previewable,
          session: typeof action === "function" ? action(base) : action,
        },
      };
    });
  /** An explicit change of the author's: a turn, a ratio or 还原. */
  const author = (change: (current: StageWork) => StageWork) =>
    update((current) => ({ ...change(current), authored: true }));

  const session = sessionOf(work);
  const rotation = work.rotation;
  const frame =
    size === null || !previewable ? null : rotatedSize(size, rotation);
  const preset = EDIT_PRESETS.find((option) => option.id === session.preset);
  const ratio =
    size === null || frame === null
      ? 1
      : preset !== undefined
        ? presetRatio(preset, frame)
        : cropRatio(edit.crop, rotatedSize(size, edit.rotation));
  const original: MediaEdit = {
    rotation: edit.rotation,
    crop: normalizeCrop(edit.crop),
  };
  // Without a preview the stored crop stays until a turn or 还原 restarts it.
  const candidate: MediaEdit = {
    rotation,
    crop: resolvedCrop(session, ratio, frame),
  };
  const unchanged = closeEdit(candidate, original);
  const next = unchanged ? original : candidate;
  const area = session.area;
  const pannable =
    area !== undefined &&
    area !== null &&
    (area.width < FULL_EDGE || area.height < FULL_EDGE);

  const latest = useRef({
    key: item.key,
    work,
    session,
    previewable,
    next,
    unchanged,
    editable,
    onCommit,
    drafts,
  });
  latest.current = {
    key: item.key,
    work,
    session,
    previewable,
    next,
    unchanged,
    editable,
    onCommit,
    drafts,
  };
  /**
   * Keeps `edit` for the photo and makes it the work's basis: the draft now
   * continues that edit, and only an edit made elsewhere (应用到全部 from
   * another photo, a restored version) can set it aside. Left on the old
   * basis, a later return of the item to that edit would resume the draft
   * and commit it again unasked.
   */
  const keep = useCallback((key: string, from: StageWork, edit: MediaEdit) => {
    const shown = latest.current;
    shown.onCommit(key, edit);
    // As the album stores it (`setItemEdit`), so the basis compares equal.
    const basis: MediaEdit = {
      rotation: edit.rotation,
      crop: normalizeCrop(edit.crop),
    };
    shown.drafts.saveCropDraft(key, {
      basis,
      rotation: from.rotation,
      stored: from.stored,
    });
    setOpened((current) =>
      current.key === key ? { ...current, basis } : current,
    );
  }, []);
  const commit = useCallback(() => {
    const shown = latest.current;
    if (!shown.editable || !shown.work.authored || shown.unchanged) return;
    keep(shown.key, shown.work, shown.next);
  }, [keep]);

  // A turn, a ratio or 还原 is kept as soon as it has rendered.
  const commitRendered = useRef(false);
  useEffect(() => {
    if (!commitRendered.current) return;
    commitRendered.current = false;
    commit();
  });
  // Every crop report restarts the idle wait; a report that changes
  // nothing, or that the author did not cause, commits nothing.
  useEffect(() => {
    if (work.stored === null) return;
    const timer = setTimeout(commit, IDLE_COMMIT_MS);
    return () => clearTimeout(timer);
  }, [work.stored, commit]);
  useEffect(() => () => commit(), [commit]);

  useEffect(() => {
    drafts.saveCropDraft(work.key, {
      basis: work.basis,
      rotation: work.rotation,
      stored: work.stored,
    });
  }, [drafts, work]);

  // A new source of the same photo (the account derivative replacing local
  // bytes) continues from where the author left the crop (CropWorkspace).
  const shown = useRef({ key: item.key, image });
  useEffect(() => {
    const before = shown.current;
    if (before.key === item.key && before.image === image) return;
    shown.current = { key: item.key, image };
    if (before.key === item.key)
      setOpened((current) =>
        current.key !== item.key || current.stored === null
          ? current
          : {
              ...current,
              stored: {
                ...current.stored,
                session: resumeCrop(current.stored.session),
              },
            },
      );
  }, [item.key, image]);

  const snapshot = useCallback((): StageSnapshot => {
    const now = latest.current;
    return {
      key: now.key,
      edit: now.next,
      rotation: now.work.rotation,
      previewable: now.previewable,
      session: now.session,
    };
  }, []);
  const restore = useCallback(
    (snap: StageSnapshot) => {
      const now = latest.current;
      if (snap.key === now.key && !now.editable) return;
      const generation =
        Math.max(snap.session.generation, now.session.generation) + 1;
      const restored: StageWork = {
        key: snap.key,
        basis: {
          rotation: snap.edit.rotation,
          crop: normalizeCrop(snap.edit.crop),
        },
        rotation: snap.rotation,
        stored: {
          previewable: snap.previewable,
          session: { ...reopen(snap.session), generation },
        },
        input: false,
        authored: false,
      };
      setOpened((current) => (current.key === snap.key ? restored : current));
      keep(snap.key, restored, snap.edit);
    },
    [keep],
  );

  return {
    key: item.key,
    image,
    size,
    previewable,
    loading,
    editable,
    rotation,
    session,
    onSession,
    ratio,
    frame,
    next,
    restorable:
      next.rotation !== 0 ||
      next.crop !== null ||
      session.preset !== "original",
    pannable,
    report: (reported) =>
      onSession((current) => ({
        ...current,
        area: cropFromPercentages(reported),
      })),
    touch: () =>
      update((current) => {
        if (!current.input) return current;
        const base = sessionOf(current);
        return {
          ...current,
          authored: true,
          stored: {
            previewable,
            session: base.touched ? base : { ...base, touched: true },
          },
        };
      }),
    noteInput: () =>
      update((current) =>
        current.input ? current : { ...current, input: true },
      ),
    rotate: () => {
      if (!editable) return;
      author((current) => {
        const base = sessionOf(current);
        return {
          ...current,
          rotation: turn(current.rotation, 1),
          stored: {
            previewable,
            session: restartCrop(
              base,
              base.preset === "custom" ? "original" : base.preset,
            ),
          },
        };
      });
      commitRendered.current = true;
    },
    choosePreset: (id) => {
      if (!editable || id === session.preset) return;
      author((current) => ({
        ...current,
        stored: { previewable, session: restartCrop(sessionOf(current), id) },
      }));
      commitRendered.current = true;
    },
    revert: () => {
      if (!editable) return;
      author((current) => ({
        ...current,
        rotation: 0,
        stored: {
          previewable,
          session: restartCrop(sessionOf(current), "original"),
        },
      }));
      commitRendered.current = true;
    },
    commit,
    snapshot,
    restore,
  };
};

/** The states that ask something of the author (design-language S1.8). */
export const needsAttention = (status: ItemStatus): boolean =>
  status.kind === "paused" ||
  status.kind === "needs_choice" ||
  status.kind === "failed" ||
  status.kind === "missing_local" ||
  status.kind === "unavailable";

/**
 * The chip's short label (design-language S1.8, §6 G8): the full label
 * otherwise, which the photo's name and the fix sheet keep.
 */
export const chipLabel = (status: ItemStatus, uploadFailed: boolean) => {
  switch (status.kind) {
    case "uploaded":
      return "等待处理";
    case "failed":
      // An upload the manager failed, or the account's processing or edit.
      return uploadFailed ? "上传失败" : "处理失败";
    case "missing_local":
      return "缺少文件";
    default:
      return status.label;
  }
};

/** What the stage says out loud for a state that needs the author (S1.12's title and message). */
const attentionText = (status: ItemStatus, uploadFailed: boolean) => {
  if (!needsAttention(status)) return "";
  const title =
    status.kind === "missing_local"
      ? status.label
      : chipLabel(status, uploadFailed);
  const message = "message" in status ? status.message : null;
  return message === null ? title : `${title}：${message}`;
};

/**
 * The stage's line icons, copied from mockup B (24 viewBox, the shared
 * icons' round 1.7 stroke) until the shared set has them (G5, G16).
 */
const GLYPHS = {
  plus: "M12 5v14M5 12h14",
  rotate:
    "M4.5 11h9a1 1 0 0 1 1 1v7.5a1 1 0 0 1-1 1h-9a1 1 0 0 1-1-1V12a1 1 0 0 1 1-1ZM8.5 6.5h3.8a6.2 6.2 0 0 1 6.2 6.2v1.8M16 12.2l2.5 2.6 2.5-2.6",
  reset: "M6.9 6.5A7.5 7.5 0 1 1 4.5 12M6.9 2.9v3.6h3.6",
  check: "m5 12.5 4.3 4.3L19 7.2",
  guide: "M4 4.5h16M4 19.5h16M4.5 8.5h15v7h-15z",
  stack: "M8.5 8.5h11v11h-11zM5 15.5V5h10.5",
  hand: "M5 12h14M8 9l-3 3 3 3M16 9l3 3-3 3",
} as const;

export type EditGlyphName = keyof typeof GLYPHS;

export const EditGlyph = ({
  name,
  size = 24,
}: {
  readonly name: EditGlyphName;
  readonly size?: 18 | 20 | 24;
}) => (
  <svg
    aria-hidden="true"
    className={styles.glyph}
    fill="none"
    focusable="false"
    height={size}
    stroke="currentColor"
    strokeLinecap="round"
    strokeLinejoin="round"
    strokeWidth={1.7}
    viewBox="0 0 24 24"
    width={size}
  >
    <path d={GLYPHS[name]} />
  </svg>
);

/**
 * The box the cropper lays the photo out in. react-easy-crop fits the
 * unturned photo into its box (`contain`) and takes the largest frame of
 * the ratio inside both the turned photo and the box. Sized so the photo,
 * as shown, just covers the largest frame of the ratio the stage holds, the
 * cropper's own frame is that frame (mockup B's geometry). An unturned photo
 * also gets the whole stage to drag on; a turned one gets its square.
 */
export const cropperBox = (
  stage: Size,
  ratio: number,
  photo: Size,
  turned: boolean,
): Size | null => {
  if (
    !(stage.width > 0 && stage.height > 0 && ratio > 0) ||
    !(photo.width > 0 && photo.height > 0)
  )
    return null;
  const frameWidth = Math.min(stage.width, stage.height * ratio);
  const frameHeight = frameWidth / ratio;
  const aspect = photo.width / photo.height;
  // The photo, at the scale where it just covers the frame.
  const width = aspect >= ratio ? frameHeight * aspect : frameWidth;
  const height = aspect >= ratio ? frameHeight : frameWidth / aspect;
  if (turned)
    return height >= width
      ? { width: height, height: Math.max(height, stage.height) }
      : { width: Math.max(width, stage.width), height: width };
  return frameWidth >= stage.width
    ? { width, height: Math.max(height, stage.height) }
    : { width: Math.max(width, stage.width), height };
};

/** Where the stage's feed band says what the phone feed shows of this frame. */
const BAND_TEXT: Readonly<Record<FeedStageWindow["fit"], string>> = {
  cover: "动态流显示范围",
  fill: "动态流满幅显示",
  contain: "动态流整张显示",
};

/** The label's gap to the frame's edges, and its height (mockup B, px). */
const BAND_LABEL_INSET = 8;
const BAND_LABEL_RISE = 36;

/** The 动态流参考线 band over the crop frame: dims what the feed cuts and says what it shows. */
const FeedBand = ({
  window,
  frame,
}: {
  readonly window: FeedStageWindow;
  readonly frame: Size;
}) => {
  const cut =
    window.fit === "cover" ? (frame.height * (1 - window.height)) / 2 : 0;
  return (
    <span
      className={styles.band}
      data-feed-fit={window.fit}
      data-feed-window=""
    >
      {window.fit === "cover" ? (
        <>
          <span
            className={styles.bandEdge}
            data-edge="top"
            style={{ height: `${cut}px` }}
          />
          <span
            className={styles.bandEdge}
            data-edge="bottom"
            style={{ height: `${cut}px` }}
          />
        </>
      ) : null}
      <span
        className={styles.bandLabel}
        style={{
          top: `${Math.max(BAND_LABEL_INSET, frame.height - cut - BAND_LABEL_RISE)}px`,
        }}
      >
        <span className={styles.tileChip}>{BAND_TEXT[window.fit]}</span>
      </span>
    </span>
  );
};

export interface EditStageProps {
  readonly crop: StageCrop;
  readonly status: ItemStatus;
  /** The manager failed this photo's upload (上传失败, not 处理失败). */
  readonly uploadFailed: boolean;
  /** The account will still make a derivative (the no-preview copy says so). */
  readonly derivativeExpected: boolean;
  /** The part the phone feed shows; null while it is not known. */
  readonly feedWindow: FeedStageWindow | null;
  /** 动态流参考线 is on. */
  readonly guide: boolean;
  /** What the guide shows of this frame, in words (the guide button's description). */
  readonly guideHint: string | null;
  /** The first-time hint is showing. */
  readonly hint: boolean;
  /** The photo arrived from the next or previous one (its slide-in). */
  readonly enter: "next" | "previous" | undefined;
  readonly onToggleGuide: () => void;
  readonly onRotate: () => void;
  readonly onRevert: () => void;
  /** The state chip's button: the photo's fix sheet. */
  readonly onFix: () => void;
  /**
   * ← / → on the focused stage, mirrored to the right-to-left order (r4
   * D10): ← the next photo (1), → the previous one (−1).
   */
  readonly onPage: (direction: -1 | 1) => void;
  /** The author's first pointer or Ctrl + wheel on the photo (hides the hint). */
  readonly onInput: () => void;
  /** The last finger left the photo; `moved` when the crop changed meanwhile. */
  readonly onGestureEnd: (moved: boolean) => void;
}

const sameArea = (
  left: MediaCrop | null | undefined,
  right: MediaCrop | null | undefined,
) =>
  left === right ||
  (left !== null &&
    left !== undefined &&
    right !== null &&
    right !== undefined &&
    left.x === right.x &&
    left.y === right.y &&
    left.width === right.width &&
    left.height === right.height);

const inCrop = (target: EventTarget | null) =>
  target instanceof Element &&
  target.closest("button") === null &&
  target.closest("[data-media-crop]") !== null;

export const EditStage = ({
  crop,
  status,
  uploadFailed,
  derivativeExpected,
  feedWindow,
  guide,
  guideHint,
  hint,
  enter,
  onToggleGuide,
  onRotate,
  onRevert,
  onFix,
  onPage,
  onInput,
  onGestureEnd,
}: EditStageProps) => {
  const stage = useRef<HTMLDivElement>(null);
  const guideHintId = useId();
  const [stageSize, setStageSize] = useState<Size | null>(null);
  // The crop frame in stage pixels, as this photo's cropper last laid it out.
  const surface = `${crop.key}:${crop.session.generation}`;
  const [measured, setMeasured] = useState<{
    readonly surface: string;
    readonly size: Size;
  } | null>(null);
  const cropSize = measured?.surface === surface ? measured.size : null;
  const [gesture, setGesture] = useState(false);
  const attention = needsAttention(status);

  // The peek scales the cropper's box while a finger is down. A cropper
  // mounted meanwhile (an interrupted touch remounts it) measures the
  // scaled box and keeps those sizes, so it measures again once the box is
  // whole (`CropSurface` `remeasure`).
  const gestureNow = useRef(gesture);
  gestureNow.current = gesture;
  const peekEndedAt = useRef<number | null>(null);
  const remeasureDue = useRef(false);
  const settleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [remeasure, setRemeasure] = useState(0);
  const remeasureAfterPeek = useCallback(() => {
    if (settleTimer.current !== null) return;
    settleTimer.current = setTimeout(() => {
      settleTimer.current = null;
      setRemeasure((count) => count + 1);
    }, PEEK_SETTLE_MS);
  }, []);
  useEffect(
    () => () => {
      if (settleTimer.current !== null) clearTimeout(settleTimer.current);
    },
    [],
  );
  const onCropSize = (size: Size) => {
    setMeasured({ surface, size });
    if (gestureNow.current) remeasureDue.current = true;
    else if (
      peekEndedAt.current !== null &&
      Date.now() - peekEndedAt.current < PEEK_SETTLE_MS
    )
      remeasureAfterPeek();
  };

  // The stage's room, so the cropper's box can be fitted to it.
  useLayoutEffect(() => {
    const node = stage.current;
    if (node === null) return undefined;
    const measure = () => {
      const width = node.clientWidth;
      const height = node.clientHeight;
      setStageSize((current) =>
        width > 0 && height > 0
          ? current?.width === width && current.height === height
            ? current
            : { width, height }
          : null,
      );
    };
    measure();
    if (typeof ResizeObserver === "undefined") return undefined;
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  // A finger (or the primary button) down on the photo, until the last one lifts.
  const pointers = useRef(new Set<number>());
  const startArea = useRef<MediaCrop | null | undefined>(undefined);
  const latest = useRef({ area: crop.session.area, onGestureEnd });
  latest.current = { area: crop.session.area, onGestureEnd };
  useEffect(() => {
    if (!gesture) return undefined;
    const end = (event: PointerEvent) => {
      if (!pointers.current.delete(event.pointerId)) return;
      if (pointers.current.size > 0) return;
      setGesture(false);
      peekEndedAt.current = Date.now();
      if (remeasureDue.current) {
        remeasureDue.current = false;
        remeasureAfterPeek();
      }
      const shown = latest.current;
      shown.onGestureEnd(!sameArea(startArea.current, shown.area));
    };
    window.addEventListener("pointerup", end);
    window.addEventListener("pointercancel", end);
    return () => {
      window.removeEventListener("pointerup", end);
      window.removeEventListener("pointercancel", end);
    };
  }, [gesture, remeasureAfterPeek]);

  const editing = crop.editable && crop.image !== null && crop.previewable;
  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!editing || !inCrop(event.target)) return;
    if (event.pointerType === "mouse" && event.button !== 0) return;
    crop.noteInput();
    onInput();
    if (pointers.current.size === 0) startArea.current = crop.session.area;
    pointers.current.add(event.pointerId);
    setGesture(true);
  };
  const onWheel = (event: ReactWheelEvent<HTMLDivElement>) => {
    if (!editing || !event.ctrlKey || !inCrop(event.target)) return;
    crop.noteInput();
    onInput();
  };
  const onKeyDownCapture = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (
      editing &&
      CROP_KEYS.has(event.key) &&
      !event.ctrlKey &&
      !event.metaKey &&
      !event.altKey &&
      inCrop(event.target)
    )
      crop.noteInput();
  };
  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    // The stage itself pages; the crop area inside it moves the crop. The
    // next photo sits to the left of this one (right to left, as the feed).
    if (event.target !== event.currentTarget) return;
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    onPage(event.key === "ArrowLeft" ? 1 : -1);
  };

  const box =
    stageSize === null || crop.frame === null
      ? null
      : cropperBox(
          stageSize,
          crop.ratio,
          crop.frame,
          crop.rotation % 180 !== 0,
        );
  const chip = chipLabel(status, uploadFailed);
  const guideShown = guide && feedWindow !== null;

  const frameLayer =
    cropSize === null ? null : (
      <span
        aria-hidden="true"
        className={styles.frame}
        data-edit-frame=""
        style={{ width: `${cropSize.width}px`, height: `${cropSize.height}px` }}
      >
        {guideShown ? <FeedBand frame={cropSize} window={feedWindow} /> : null}
        <span className={styles.thirds}>
          <span />
          <span />
          <span />
          <span />
        </span>
        <span className={styles.corner} data-corner="top-left" />
        <span className={styles.corner} data-corner="top-right" />
        <span className={styles.corner} data-corner="bottom-left" />
        <span className={styles.corner} data-corner="bottom-right" />
      </span>
    );

  const content =
    crop.image !== null && crop.previewable ? (
      crop.editable ? (
        <CropSurface
          key={crop.key}
          aspect={crop.ratio}
          cropAreaClassName={styles.stageCropArea}
          generation={crop.session.generation}
          image={crop.image}
          label="拖动图片调整裁剪位置，可用方向键移动，+ − 键缩放，0 键还原"
          objectFit="contain"
          onArea={crop.report}
          onCropSize={onCropSize}
          // The cropper re-reports its position when it mounts or clamps;
          // only a move or zoom after the author's own input is theirs.
          onTouched={crop.touch}
          overlay={frameLayer}
          remeasure={remeasure}
          rotation={crop.rotation}
          seed={crop.session.seed}
          tools="hintOnly"
          viewportClassName={styles.cropBox}
        />
      ) : (
        // A carried-over photo has no edit: shown whole, nothing to crop.
        <span className={styles.still} data-edit-still="">
          <img alt="" draggable={false} src={crop.image} />
        </span>
      )
    ) : (
      <div
        className={`${mediaStyles.dialogMessage} ${styles.stageFallback}`}
        data-edit-fallback=""
      >
        <span role="status">
          {crop.loading
            ? "正在打开图片…"
            : !crop.editable
              ? "这台设备无法预览这张图片。"
              : derivativeExpected
                ? "这台设备暂时无法预览这张图片，仍可旋转；处理完成后可裁剪。"
                : "这台设备无法预览这张图片，仍可旋转。"}
        </span>
      </div>
    );

  return (
    <div
      ref={stage}
      aria-label="裁剪区域。拖动调整位置，双指缩放；左右方向键切换照片"
      className={styles.stage}
      data-boxed={box === null ? undefined : ""}
      data-edit-stage=""
      data-gesture={gesture ? "" : undefined}
      data-guide={guideShown ? "on" : "off"}
      data-pan={crop.pannable ? "1" : "0"}
      onKeyDown={onKeyDown}
      onKeyDownCapture={onKeyDownCapture}
      onPointerDown={onPointerDown}
      onWheel={onWheel}
      role="group"
      style={
        box === null
          ? undefined
          : ({
              "--crop-box-width": `${box.width}px`,
              "--crop-box-height": `${box.height}px`,
            } as CSSProperties)
      }
      tabIndex={0}
    >
      <div key={crop.key} className={styles.slide} data-enter={enter}>
        {content}
      </div>
      <div className={styles.stageTop}>
        <div className={styles.stageStatusSlot} data-edit-status="">
          {status.kind === "ready" &&
          status.background === undefined ? null : attention ? (
            <button
              aria-label={`${chip}，点按处理`}
              className={styles.stageStatus}
              data-fix=""
              onClick={(event) => {
                // Focus returns here when the fix sheet closes (a tap does
                // not focus a button everywhere).
                event.currentTarget.focus({ preventScroll: true });
                onFix();
              }}
              type="button"
            >
              <span className={styles.tileChip} data-edit-chip={status.kind}>
                <Icon
                  aria-hidden="true"
                  className={styles.icon16}
                  name="error"
                />
                <span className={styles.tileChipText}>{chip}</span>
                <Icon
                  aria-hidden="true"
                  className={styles.icon14}
                  name="next"
                />
              </span>
            </button>
          ) : (
            <span className={styles.stageStatus}>
              <span className={styles.tileChip} data-edit-chip={status.kind}>
                <span className={styles.tileChipText}>{chip}</span>
              </span>
            </span>
          )}
        </div>
        <button
          aria-describedby={
            guide && guideHint !== null ? guideHintId : undefined
          }
          aria-label="动态流参考线"
          aria-pressed={guide}
          className={styles.fab}
          data-edit-guide=""
          disabled={feedWindow === null}
          onClick={onToggleGuide}
          title="动态流参考线"
          type="button"
        >
          <EditGlyph name="guide" />
        </button>
        {guide && guideHint !== null ? (
          <span className={editorStyles.visuallyHidden} id={guideHintId}>
            {guideHint}
          </span>
        ) : null}
      </div>
      <div className={styles.stageRail}>
        <button
          aria-disabled={!crop.editable || !crop.restorable}
          aria-label="还原"
          className={styles.fab}
          data-edit-action="revert"
          onClick={onRevert}
          title="还原"
          type="button"
        >
          <EditGlyph name="reset" />
        </button>
        <button
          aria-label="向右旋转 90°"
          className={styles.fab}
          data-edit-action="rotate"
          disabled={!crop.editable}
          onClick={onRotate}
          title="旋转"
          type="button"
        >
          <EditGlyph name="rotate" />
        </button>
      </div>
      {editing ? (
        <div
          aria-hidden="true"
          className={styles.hint}
          data-edit-hint=""
          data-show={hint ? "" : undefined}
        >
          <span>
            <EditGlyph name="hand" size={18} />
            拖动调整位置，双指缩放
          </span>
          <small>点缩略图切换，再点一下有更多操作</small>
        </div>
      ) : null}
      {/* The chip is drawn; a state that needs the author is also said once. */}
      <span
        aria-live="polite"
        className={editorStyles.visuallyHidden}
        role="status"
      >
        {attentionText(status, uploadFailed)}
      </span>
    </div>
  );
};

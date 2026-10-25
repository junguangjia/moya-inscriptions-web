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

import { CROP_MAX_ZOOM } from "../../../authors/crop-gestures";
import { CropSurface } from "../../../media-composer/crop-surface";
import {
  fitFrame,
  imageRect,
  seedMaxZoom,
  snapToRatio,
  windowToCrop,
} from "../../../media-composer/crop-window";
import editorStyles from "../editor/editor.module.css";
import { CROP_IMAGE_EDGE } from "../media/bounded-preview";
import {
  freeCrop,
  freedOriginal,
  reframeCrop,
  restartCrop,
  resolvedCrop,
  resumeCrop,
  sessionRatio,
  useNaturalSize,
} from "../media/crop-workspace";
import {
  feedCuts,
  regionOf,
  useFeedRegion,
} from "../media/feed-window-overlay";
import { initialSession } from "../media/media-edit-dialog";
import {
  EDIT_PRESETS,
  closeCrop,
  closeEdit,
  cropFromPercentages,
  cropRatio,
  normalizeCrop,
  normalizeFeed,
  rotatedSize,
  sameEdit,
  turn,
  withFeed,
} from "../media/media-geometry";
import { useBoundedPreview } from "../media/media-preview";
import mediaStyles from "../media/media.module.css";
import styles from "./edit-screen.module.css";
import { isPhonePreset } from "./ratio-bar";
import {
  CROP_FIELD_INSETS,
  CROP_KEYS,
  CropWindow,
  HANDLE_HINT,
  REFRAME_MAX_MS,
  ReframeLayer,
  cancelFrame,
  nextFrame,
  offsetRect,
  predecode,
} from "./stage-frame";

import type { CropInset } from "../../../media-composer/crop-window";
import type { CropPreset, CropSession } from "../media/crop-workspace";
import type { FeedStageWindow, Size } from "../media/media-geometry";
import type { ItemStatus } from "../media/media-status";
import type { EditDraft, MediaUiStore } from "../media/media-ui-store";
import type { Reframe, WindowRelease } from "./stage-frame";
import type {
  MediaCrop,
  MediaEdit,
  MediaFeedFraming,
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
import type { Area } from "react-easy-crop";

/**
 * The phone edit screen's stage (#244 r3, mockup B `.stage`): the current
 * photo full-bleed on paper-dark between the bar and the control band, on
 * the crop surface of the edit dialog (drag, two-finger zoom, Ctrl + wheel,
 * `+ − 0`, no slider). The crop frame is the largest frame of the chosen
 * ratio the stage holds and the photo covers it, dimmed outside the frame,
 * with corner marks; while a finger is down the frame steps back a little,
 * the thirds appear and the stage's own buttons fade. Over the photo: the
 * photo's state (a chip, or a button to its fix sheet when it needs the
 * author) and the 「动态流」 tool at the top, 还原 and 旋转 at the bottom
 * right, and the first-time hint. Photos change from the strip or the
 * stage's arrow keys only: one finger always moves the crop. The photos
 * read right to left as the strip draws them (r4 D10): ← brings in the next
 * photo, which slides in from the left, and → the previous one.
 *
 * The frame's four corners are handles (#341, iOS Photos' crop): a corner
 * drags the crop window with the opposite corner anchored (free at 原始比例
 * and 自由, a preset keeps its ratio), and on release the photo re-centres
 * and zooms so the window fills the crop field again. The field keeps room
 * at the top and bottom for the stage's buttons and at the sides for the
 * screen's edge (`CROP_FIELD_INSETS`), so no button ever covers a handle.
 * The handles answer the arrow keys too; VoiceOver users, who cannot drag
 * them, pick a ratio from the row instead.
 *
 * The 「动态流」 tool (#341) has the stage while it is on: the crop rests
 * (no gesture, no handle), and the frame shows what the phone feed shows of
 * it. A photo taller than the feed's stage is the author's to frame: 局部
 * (the whole frame is a vertical slider that drags the shown region; it
 * takes the arrow keys) or 整张, chosen in the band below. A carried-over
 * photo, which cannot be cropped, is framed the same way over its still.
 *
 * The crop model is the dialog's (`CropSession`, `initialSession`, on the
 * phone `phoneInitialSession`); unlike the dialog there is no 完成, so the
 * screen keeps the edit itself (see `useStageCrop`).
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
const NO_INSET: CropInset = { block: 0, inline: 0 };
/** A field smaller than this either way keeps the whole stage, without handles. */
const CROP_FIELD_MINIMUM = 132;

type Stored = EditDraft["stored"];

/**
 * The crop session a stored edit reopens at on the phone (#341): the
 * dialog's, except that here 原始比例 is only the whole frame and there is
 * no 16:9 or 9:16, so any other stored shape (a zoomed crop of the frame's
 * own shape included) reopens as 自由. The desktop dialog keeps its labels.
 */
export const phoneInitialSession = (
  edit: MediaEdit,
  size: Size | null,
  rotation: MediaRotation,
): CropSession => {
  const session = initialSession(edit, size, rotation);
  return session.seed !== undefined &&
    (session.preset === "original" || !isPhonePreset(session.preset))
    ? { ...session, preset: "custom" }
    : session;
};

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
  /**
   * The back sheet is open: nothing is kept on its own (继续编辑 finds the
   * screen as it was), and a gesture under way is taken back (#341).
   */
  readonly paused?: boolean;
}

/** The stage as it was before a turn or 还原, for 撤销. */
export interface StageSnapshot {
  readonly key: string;
  /** The edit the stage showed. */
  readonly edit: MediaEdit;
  readonly rotation: MediaRotation;
  readonly previewable: boolean;
  readonly session: CropSession;
  /** The photo's feed framing (#341), which 撤销 of 还原 brings back too. */
  readonly feed: MediaFeedFraming | undefined;
  /** It could be cropped: a carried-over photo has only its framing to restore. */
  readonly editable: boolean;
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
  /** The corner handles keep `ratio` (a fixed preset); 原始比例 and 自由 are free. */
  readonly locked: boolean;
  /** How far the cropper may zoom: the shared 3×, or what its seed needs (#341). */
  readonly maxZoom: number;
  /** The rotated frame; null without a preview. */
  readonly frame: Size | null;
  /** The edit the stage shows now (the stored one while nothing changed). */
  readonly next: MediaEdit;
  /**
   * 还原 has something to undo: a turn, a crop, a chosen ratio or a feed
   * framing the author chose (a carried-over photo's framing only).
   */
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
  /**
   * A corner drag let go (#341): the photo reframed to `crop`, in a new
   * cropper that fills the field with it; kept at once, like a ratio.
   */
  readonly reframe: (crop: MediaCrop | null) => void;
  /**
   * A finger is down on the photo or a handle (true), or the last one lifted
   * (false). Meanwhile every commit keeps the edit as it was when it landed.
   */
  readonly hold: (on: boolean) => void;
  /**
   * Keeps the shown edit when the author changed it and it differs from the
   * stored one; while a finger is down, the edit as it was before it landed.
   */
  readonly commit: () => void;
  /** The stage now, for 撤销 of a turn or 还原. */
  readonly snapshot: () => StageSnapshot;
  /** Brings a snapshot back and keeps its edit (撤销). */
  readonly restore: (snapshot: StageSnapshot) => void;
}

/** The stage's work as a finger landed: what the commits keep until it lifts. */
interface Settled {
  readonly key: string;
  readonly work: StageWork;
  readonly session: CropSession;
  readonly previewable: boolean;
  readonly next: MediaEdit;
  readonly unchanged: boolean;
}

/**
 * The crop work of the photo on the stage. Kept (via `onCommit`) when the
 * screen leaves the photo (switch, ‹, 下一步, unmount), at once after a
 * turn, a ratio, a corner drag or 还原, and 800 ms after the last crop
 * change, but only once the author changed something in this opening
 * (`authored`): the cropper's own report when it mounts, relayouts or
 * resumes is never an edit. While a finger is down nothing half done is
 * kept (#341): the idle wait stands still and every commit keeps the edit
 * as it was when the finger landed. Unfinished work waits in `drafts` per
 * photo, so a layout swap or a switch back resumes it.
 */
export const useStageCrop = ({
  item,
  src,
  blob,
  knownSize,
  drafts,
  editable,
  onCommit,
  paused = false,
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
          : phoneInitialSession(
              item.edit,
              previewable ? size : null,
              work.rotation,
            );
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
  const frameAt = (turned: MediaRotation): Size | null =>
    size === null || !previewable ? null : rotatedSize(size, turned);
  /**
   * 原始比例 is the whole frame: a crop made at it is 自由 (`freedOriginal`).
   * 16:9 and 9:16 are not the phone's: a desktop dialog's (a layout swap
   * hands its draft over) is 自由 at its own shape, in the same cropper.
   */
  const settle = (session: CropSession, turned: MediaRotation) => {
    const fixed = EDIT_PRESETS.find((preset) => preset.id === session.preset);
    if (fixed !== undefined && fixed.ratio !== null && !isPhonePreset(fixed.id))
      return freeCrop(session, fixed.ratio);
    const shown = frameAt(turned);
    return shown === null
      ? session
      : freedOriginal(session, shown.width / shown.height);
  };
  const sessionOf = (current: StageWork): CropSession =>
    settle(
      current.stored !== null && current.stored.previewable === previewable
        ? current.stored.session
        : phoneInitialSession(
            edit,
            previewable ? size : null,
            current.rotation,
          ),
      current.rotation,
    );
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
          session: settle(
            typeof action === "function" ? action(base) : action,
            current.rotation,
          ),
        },
      };
    });
  /** An explicit change of the author's: a turn, a ratio, a corner drag or 还原. */
  const author = (change: (current: StageWork) => StageWork) =>
    update((current) => ({ ...change(current), authored: true }));

  const session = sessionOf(work);
  const rotation = work.rotation;
  const frame = frameAt(rotation);
  const ratio =
    size === null || frame === null
      ? 1
      : sessionRatio(session, frame, {
          crop: edit.crop,
          frame: rotatedSize(size, edit.rotation),
        });
  const locked = session.preset !== "original" && session.preset !== "custom";
  const maxZoom =
    frame === null
      ? CROP_MAX_ZOOM
      : seedMaxZoom(
          session.seed === undefined ? null : cropFromPercentages(session.seed),
          ratio,
          frame,
        );
  // The photo's feed framing is presentation, not pixels: every crop it
  // keeps carries it, as that crop stores it (its default as none).
  const original = withFeed(
    { rotation: edit.rotation, crop: normalizeCrop(edit.crop) },
    edit.feed,
  );
  // Without a preview the stored crop stays until a turn or 还原 restarts it.
  const candidate = withFeed(
    { rotation, crop: resolvedCrop(session, ratio, frame) },
    edit.feed,
  );
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
  // The work as the first finger landed, until the last one lifts: what
  // every commit keeps meanwhile (#341). Another photo shown since has no
  // say in it.
  const settled = useRef<Settled | null>(null);
  const [holding, setHolding] = useState(false);
  if (settled.current !== null && settled.current.key !== item.key)
    settled.current = null;
  const hold = useCallback((on: boolean) => {
    if (!on) settled.current = null;
    else if (settled.current === null) {
      const now = latest.current;
      settled.current = {
        key: now.key,
        work: now.work,
        session: now.session,
        previewable: now.previewable,
        next: now.next,
        unchanged: now.unchanged,
      };
    }
    setHolding(on);
  }, []);
  const commit = useCallback(() => {
    const shown = latest.current;
    const held = settled.current?.key === shown.key ? settled.current : null;
    // Half a gesture is never kept, nor resumed: the photo's draft is the
    // work as the finger found it (a switch, a layout swap, the screen
    // going while the finger is still down).
    if (held !== null)
      shown.drafts.saveCropDraft(held.key, {
        basis: held.work.basis,
        rotation: held.work.rotation,
        stored: held.work.stored,
      });
    const from = held ?? shown;
    if (!shown.editable || !from.work.authored || from.unchanged) return;
    keep(shown.key, from.work, from.next);
  }, [keep]);
  /**
   * Takes back a gesture under way (the back sheet opened over it): the
   * photo is as the finger found it, in a new cropper, which also ends the
   * cropper's own drag.
   */
  const revertGesture = useCallback(() => {
    const held = settled.current;
    if (held === null) return;
    settled.current = null;
    setHolding(false);
    setOpened((current) => {
      if (current.key !== held.key) return current;
      const now =
        current.stored?.previewable === held.previewable
          ? current.stored.session.generation
          : 0;
      return {
        ...held.work,
        basis: current.basis,
        stored: {
          previewable: held.previewable,
          session: {
            ...resumeCrop(held.session),
            generation: Math.max(now, held.session.generation) + 1,
          },
        },
      };
    });
  }, []);
  useEffect(() => {
    if (paused) revertGesture();
  }, [paused, revertGesture]);

  // A turn, a ratio, a corner drag or 还原 is kept as soon as it has rendered.
  const commitRendered = useRef(false);
  useEffect(() => {
    if (!commitRendered.current) return;
    commitRendered.current = false;
    commit();
  });
  // Every crop report restarts the idle wait; a report that changes
  // nothing, or that the author did not cause, commits nothing. It stands
  // still while a finger is down or the back sheet is open, and starts over
  // once they are gone.
  useEffect(() => {
    if (work.stored === null || holding || paused) return;
    const timer = setTimeout(commit, IDLE_COMMIT_MS);
    return () => clearTimeout(timer);
  }, [work.stored, holding, paused, commit]);
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
      feed: now.next.feed,
      editable: now.editable,
    };
  }, []);
  const restore = useCallback(
    (snap: StageSnapshot) => {
      const now = latest.current;
      if (!snap.editable || (snap.key === now.key && !now.editable)) return;
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
    locked,
    maxZoom,
    frame,
    next,
    restorable:
      (editable &&
        (next.rotation !== 0 ||
          next.crop !== null ||
          session.preset !== "original")) ||
      normalizeFeed(edit.feed, edit) !== undefined,
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
            session: base.touched
              ? base
              : settle({ ...base, touched: true }, current.rotation),
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
      // 自由 frees the corners: the crop stays as it is, so nothing to keep.
      if (id === "custom") {
        onSession((current) => freeCrop(current, ratio));
        return;
      }
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
    reframe: (next) => {
      if (!editable || frame === null) return;
      author((current) => {
        const base = sessionOf(current);
        return {
          ...current,
          stored: {
            previewable,
            session: locked
              ? reframeCrop(base, next, base.preset)
              : reframeCrop(base, next, "custom", cropRatio(next, frame)),
          },
        };
      });
      commitRendered.current = true;
    },
    hold,
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
 * as shown, just covers the largest frame of the ratio the crop field (the
 * stage less `inset`) holds, the cropper's own frame is that frame (mockup
 * B's geometry). An unturned photo also gets the whole stage to drag on; a
 * turned one gets its square.
 */
export const cropperBox = (
  stage: Size,
  ratio: number,
  photo: Size,
  turned: boolean,
  inset: CropInset = NO_INSET,
): Size | null => {
  const field = {
    width: stage.width - 2 * inset.inline,
    height: stage.height - 2 * inset.block,
  };
  if (
    !(field.width > 0 && field.height > 0 && ratio > 0) ||
    !(photo.width > 0 && photo.height > 0)
  )
    return null;
  const frameWidth = Math.min(field.width, field.height * ratio);
  const frameHeight = frameWidth / ratio;
  const aspect = photo.width / photo.height;
  // The photo, at the scale where it just covers the frame.
  const width = aspect >= ratio ? frameHeight * aspect : frameWidth;
  const height = aspect >= ratio ? frameHeight : frameWidth / aspect;
  if (turned)
    return height >= width
      ? { width: height, height: Math.max(height, stage.height) }
      : { width: Math.max(width, stage.width), height: width };
  return frameWidth >= field.width
    ? { width, height: Math.max(height, stage.height) }
    : { width: Math.max(width, stage.width), height };
};

/**
 * What the 「动态流」 tool offers for the photo shown (#341): `off`, or on
 * for a photo whose window is not known yet (`pending`: its picture or the
 * feed's stage is still on its way), one without a preview (`none`), one
 * the feed shows whole or full without a choice (`shown`), or a photo taller
 * than the stage, shown in part (`region`, 局部) or whole (`whole`, 整张).
 */
export type FeedToolState =
  "off" | "pending" | "none" | "shown" | "region" | "whole";

export const feedToolState = (
  on: boolean,
  window: FeedStageWindow | null,
  waiting: boolean,
): FeedToolState => {
  if (!on) return "off";
  if (window === null) return waiting ? "pending" : "none";
  if (!window.tall) return "shown";
  return window.fit === "contain" ? "whole" : "region";
};

/** What the stage's feed band says the phone feed shows of this frame. */
const bandText = (window: FeedStageWindow): string => {
  if (window.fit === "cover") return "动态流显示范围";
  if (window.fit === "fill") return "动态流满幅显示";
  return window.tall ? "动态流整张显示 · 左右留白" : "动态流整张显示";
};

/** The label's gap to the frame's edges, and its height (mockup B, px). */
const BAND_LABEL_INSET = 8;
const BAND_LABEL_RISE = 36;

/**
 * The 「动态流」 band over the crop frame: dims what the feed cuts above and
 * below the shown region (each edge only where it cuts something) and says
 * what it shows.
 */
const FeedBand = ({
  window,
  frame,
}: {
  readonly window: FeedStageWindow;
  readonly frame: Size;
}) => {
  const cuts = feedCuts(window);
  const top = frame.height * cuts.top;
  const bottom = frame.height * cuts.bottom;
  return (
    <span
      aria-hidden="true"
      className={styles.band}
      data-feed-fit={window.fit}
      data-feed-whole={window.fit === "contain" && window.tall ? "" : undefined}
      data-feed-window=""
    >
      {top > 0 ? (
        <span
          className={styles.bandEdge}
          data-edge="top"
          style={{ height: `${top}px` }}
        />
      ) : null}
      {bottom > 0 ? (
        <span
          className={styles.bandEdge}
          data-edge="bottom"
          style={{ height: `${bottom}px` }}
        />
      ) : null}
      <span
        className={styles.bandLabel}
        style={{
          top: `${Math.max(
            BAND_LABEL_INSET + top,
            frame.height - bottom - BAND_LABEL_RISE,
          )}px`,
        }}
      >
        <span className={styles.tileChip}>{bandText(window)}</span>
      </span>
    </span>
  );
};

/**
 * 局部 on the stage: the band where the finger has it, under a slider as
 * large as the frame (so its target is too), which drags the shown region
 * up and down and takes the arrow keys.
 */
const FeedRegionLayer = ({
  feedWindow,
  frame,
  y,
  hintId,
  interrupted,
  onRegion,
  onDragging,
}: {
  readonly feedWindow: FeedStageWindow;
  readonly frame: Size;
  readonly y: number;
  readonly hintId: string | undefined;
  readonly interrupted: boolean;
  readonly onRegion: (y: number) => void;
  readonly onDragging: (dragging: boolean) => void;
}) => {
  const control = useFeedRegion({
    feedWindow,
    y,
    frame,
    onCommit: onRegion,
    interrupted,
    onDragging,
    describedBy: hintId,
  });
  return (
    <>
      <FeedBand frame={frame} window={control.shown} />
      <span {...control.sliderProps} className={styles.feedControl} />
    </>
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
  /** The 「动态流」 tool (#341): off, or what it offers for this photo. */
  readonly feedTool: FeedToolState;
  /** What the feed shows of this frame, in words (the tool's description). */
  readonly feedHint: string | null;
  /** The first-time hint is showing. */
  readonly hint: boolean;
  /** The photo arrived from the next or previous one (its slide-in). */
  readonly enter: "next" | "previous" | undefined;
  /**
   * Another tool has the stage (#341, 「动态流」): the photo takes no
   * gesture or key, and the corner handles are away. The field stays.
   */
  readonly cropPaused?: boolean | undefined;
  /** The back sheet is over the stage: a corner drag under way is taken back. */
  readonly interrupted?: boolean | undefined;
  /** Motion is reduced: a reframe cuts to the new frame instead of zooming. */
  readonly reducedMotion?: boolean | undefined;
  readonly onToggleFeedTool: () => void;
  /** 局部: the shown region (0 top … 1 bottom) as the finger lifts or a key moves it. */
  readonly onFeedRegion: (y: number) => void;
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

/** On the photo itself: no button, no control of the stage's own (a handle). */
const inCrop = (target: EventTarget | null) =>
  target instanceof Element &&
  target.closest("button") === null &&
  target.closest("[data-crop-own-control]") === null &&
  target.closest("[data-media-crop]") !== null;

export const EditStage = ({
  crop,
  status,
  uploadFailed,
  derivativeExpected,
  feedWindow,
  feedTool,
  feedHint,
  hint,
  enter,
  cropPaused = false,
  interrupted = false,
  reducedMotion = false,
  onToggleFeedTool,
  onFeedRegion,
  onRotate,
  onRevert,
  onFix,
  onPage,
  onInput,
  onGestureEnd,
}: EditStageProps) => {
  const stage = useRef<HTMLDivElement>(null);
  const feedHintId = useId();
  const handleHintId = useId();
  const [stageSize, setStageSize] = useState<Size | null>(null);
  // The crop frame in stage pixels, as this photo's cropper last laid it out.
  const surface = `${crop.key}:${crop.session.generation}`;
  const [measured, setMeasured] = useState<{
    readonly surface: string;
    readonly size: Size;
  } | null>(null);
  const cropSize = measured?.surface === surface ? measured.size : null;
  const [gesture, setGesture] = useState(false);
  // A corner is taken (#341): from the finger's landing, inside its slop too.
  const [grabbed, setGrabbed] = useState(false);
  // The same, set in the corner's own pointerdown: read before that event's
  // render, by the photo's handlers and the cropper (holdRef).
  const grabbedNow = useRef(false);
  // A corner's window is off the frame (#341).
  const [resizing, setResizing] = useState(false);
  const [reframe, setReframe] = useState<Reframe | null>(null);
  // What the cropper shows right now (CropSurface fills it).
  const areaRef = useRef<(() => Area | null) | null>(null);
  const attention = needsAttention(status);
  const feedOn = feedTool !== "off";
  // A finger drags the 局部 window: the stage's buttons step aside (#341).
  const [feedDrag, setFeedDrag] = useState(false);

  // A reframe covers its own photo and cropper only, and goes once the zoom
  // is over and the new cropper shows the crop (or after a second at most).
  const reframing =
    reframe !== null &&
    reframe.key === crop.key &&
    reframe.generation === crop.session.generation;
  if (reframe !== null && (!reframing || (reframe.still && reframe.seeded)))
    setReframe(null);
  const reframeId = reframing ? `${reframe.key}:${reframe.generation}` : null;
  useEffect(() => {
    if (reframeId === null) return undefined;
    const start = nextFrame(() =>
      setReframe((current) =>
        current === null ? current : { ...current, moving: true },
      ),
    );
    const settled = setTimeout(
      () =>
        setReframe((current) =>
          current === null ? current : { ...current, still: true },
        ),
      PEEK_SETTLE_MS,
    );
    const cap = setTimeout(() => setReframe(null), REFRAME_MAX_MS);
    return () => {
      cancelFrame(start);
      clearTimeout(settled);
      clearTimeout(cap);
    };
  }, [reframeId]);

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
  const onArea = (area: Area) => {
    crop.report(area);
    if (
      reframing &&
      !reframe.seeded &&
      closeCrop(cropFromPercentages(area), reframe.next, 0.002)
    )
      setReframe((current) =>
        current === null ? current : { ...current, seeded: true },
      );
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

  // A carried-over photo's still as laid out (never larger than its own
  // pixels), so the 「动态流」 band lies over it exactly.
  const still = useRef<HTMLImageElement>(null);
  const stillShown = crop.image !== null && crop.previewable && !crop.editable;
  const [stillSize, setStillSize] = useState<{
    readonly key: string;
    readonly size: Size;
  } | null>(null);
  useLayoutEffect(() => {
    const node = still.current;
    if (!stillShown || node === null) return undefined;
    const key = crop.key;
    const measure = () => {
      const width = node.clientWidth;
      const height = node.clientHeight;
      setStillSize((current) =>
        width > 0 && height > 0
          ? current?.key === key &&
            current.size.width === width &&
            current.size.height === height
            ? current
            : { key, size: { width, height } }
          : null,
      );
    };
    measure();
    node.addEventListener("load", measure);
    const observer =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(measure);
    observer?.observe(node);
    return () => {
      node.removeEventListener("load", measure);
      observer?.disconnect();
    };
  }, [stillShown, crop.key, crop.image]);
  const stillBox = stillSize?.key === crop.key ? stillSize.size : null;

  // A finger (or the primary button) down on the photo, until the last one
  // lifts, or the page loses it (another app, a dialog of the system): the
  // gesture then ends as it was, by today's rule for a pan or a pinch.
  const pointers = useRef(new Set<number>());
  const startArea = useRef<MediaCrop | null | undefined>(undefined);
  const latest = useRef({
    area: crop.session.area,
    hold: crop.hold,
    onGestureEnd,
  });
  latest.current = { area: crop.session.area, hold: crop.hold, onGestureEnd };
  useEffect(() => {
    if (!gesture) return undefined;
    const finish = () => {
      pointers.current.clear();
      setGesture(false);
      peekEndedAt.current = Date.now();
      if (remeasureDue.current) {
        remeasureDue.current = false;
        remeasureAfterPeek();
      }
      const shown = latest.current;
      shown.hold(false);
      shown.onGestureEnd(!sameArea(startArea.current, shown.area));
    };
    const end = (event: PointerEvent) => {
      if (!pointers.current.delete(event.pointerId)) return;
      if (pointers.current.size > 0) return;
      finish();
    };
    const hidden = () => {
      if (document.visibilityState === "hidden") finish();
    };
    window.addEventListener("pointerup", end);
    window.addEventListener("pointercancel", end);
    window.addEventListener("blur", finish);
    window.addEventListener("pagehide", finish);
    document.addEventListener("visibilitychange", hidden);
    return () => {
      window.removeEventListener("pointerup", end);
      window.removeEventListener("pointercancel", end);
      window.removeEventListener("blur", finish);
      window.removeEventListener("pagehide", finish);
      document.removeEventListener("visibilitychange", hidden);
    };
  }, [gesture, remeasureAfterPeek]);

  const editing = crop.editable && crop.image !== null && crop.previewable;
  // The crop field: the stage less room for the corner handles (照片留边),
  // or the whole stage, without handles, where that leaves too little.
  const fielded =
    editing &&
    stageSize !== null &&
    stageSize.width - 2 * CROP_FIELD_INSETS.inline >= CROP_FIELD_MINIMUM &&
    stageSize.height - 2 * CROP_FIELD_INSETS.block >= CROP_FIELD_MINIMUM;
  const inset = fielded ? CROP_FIELD_INSETS : NO_INSET;
  // The photo is someone else's for now: a corner taken (as the finger
  // lands, so a second finger meanwhile never pinches the photo under the
  // window), the reframe zoom or another tool.
  const frozen = grabbed || resizing || reframing || cropPaused;

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!editing || frozen || grabbedNow.current || !inCrop(event.target))
      return;
    if (event.pointerType === "mouse" && event.button !== 0) return;
    // A primary pointer starts a new touch: any finger still counted lifted
    // unseen, and its gesture (and hold) are over.
    if (event.isPrimary === true && pointers.current.size > 0) {
      pointers.current.clear();
      crop.hold(false);
    }
    crop.noteInput();
    onInput();
    if (pointers.current.size === 0) {
      startArea.current = crop.session.area;
      crop.hold(true);
    }
    pointers.current.add(event.pointerId);
    setGesture(true);
  };
  const onWheel = (event: ReactWheelEvent<HTMLDivElement>) => {
    if (
      !editing ||
      frozen ||
      grabbedNow.current ||
      !event.ctrlKey ||
      !inCrop(event.target)
    )
      return;
    crop.noteInput();
    onInput();
  };
  const onKeyDownCapture = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (
      editing &&
      !frozen &&
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

  /** What the frame shows now: the cropper's own area, else its last report. */
  const shownArea = (): MediaCrop | null => {
    const live = areaRef.current?.();
    if (live !== null && live !== undefined) return cropFromPercentages(live);
    if (crop.session.area !== undefined) return crop.session.area;
    return resolvedCrop(crop.session, crop.ratio, crop.frame);
  };
  /** A corner let go: the window becomes the crop, which then fills the field. */
  const release = ({ rect, frame, area }: WindowRelease) => {
    const source = crop.frame;
    if (stageSize === null || source === null || crop.image === null) return;
    const drawn = windowToCrop(rect, frame, area);
    const next = crop.locked ? snapToRatio(drawn, crop.ratio, source) : drawn;
    const shape = crop.locked ? crop.ratio : cropRatio(next, source);
    const target = fitFrame(
      {
        width: stageSize.width - 2 * CROP_FIELD_INSETS.inline,
        height: stageSize.height - 2 * CROP_FIELD_INSETS.block,
      },
      shape,
    );
    const generation = crop.session.generation + 1;
    // The frame overlay (and a focused handle) stays across the new cropper.
    setMeasured({ surface: `${crop.key}:${generation}`, size: target });
    const x = (stageSize.width - frame.width) / 2;
    const y = (stageSize.height - frame.height) / 2;
    setReframe({
      key: crop.key,
      generation,
      next,
      image: crop.image,
      rotation: crop.rotation,
      from: offsetRect(rect, x, y),
      to: {
        left: (stageSize.width - target.width) / 2,
        top: (stageSize.height - target.height) / 2,
        width: target.width,
        height: target.height,
      },
      picture: offsetRect(imageRect(frame, area), x, y),
      moving: false,
      still: reducedMotion,
      seeded: false,
    });
    crop.reframe(next);
    onGestureEnd(true);
  };

  const box =
    stageSize === null || crop.frame === null
      ? null
      : cropperBox(
          stageSize,
          crop.ratio,
          crop.frame,
          crop.rotation % 180 !== 0,
          inset,
        );
  const chip = chipLabel(status, uploadFailed);
  /** The 「动态流」 band over a frame of `frame` (the cropper's, or the still's). */
  const feedLayer = (frame: Size) =>
    !feedOn || feedWindow === null ? null : feedTool === "region" ? (
      <FeedRegionLayer
        key={crop.key}
        feedWindow={feedWindow}
        frame={frame}
        hintId={feedHint === null ? undefined : feedHintId}
        interrupted={interrupted}
        onDragging={setFeedDrag}
        onRegion={onFeedRegion}
        y={regionOf(crop.next.feed)}
      />
    ) : (
      <FeedBand frame={frame} window={feedWindow} />
    );
  const stillLayer = stillBox === null ? null : feedLayer(stillBox);

  const frameLayer =
    cropSize === null ? null : (
      <CropWindow
        active={!reframing && !gesture}
        area={shownArea}
        band={feedLayer(cropSize)}
        frame={cropSize}
        hintId={handleHintId}
        interrupted={interrupted}
        offered={fielded && !cropPaused}
        onBegin={() => {
          grabbedNow.current = true;
          setGrabbed(true);
          crop.noteInput();
          onInput();
          crop.hold(true);
          if (crop.image !== null) predecode(crop.image);
        }}
        onEnd={() => {
          grabbedNow.current = false;
          setGrabbed(false);
          crop.hold(false);
        }}
        onRelease={release}
        onResizing={setResizing}
        ratio={crop.locked ? crop.ratio : null}
        stage={stageSize}
      />
    );

  const content =
    crop.image !== null && crop.previewable ? (
      crop.editable ? (
        <CropSurface
          key={crop.key}
          areaRef={areaRef}
          aspect={crop.ratio}
          cropAreaClassName={styles.stageCropArea}
          frozen={frozen}
          generation={crop.session.generation}
          holdRef={grabbedNow}
          image={crop.image}
          keepControlFocus
          label={
            cropPaused
              ? "裁剪已暂停，关闭动态流后可调整"
              : "拖动图片调整裁剪位置，可用方向键移动，+ − 键缩放，0 键还原"
          }
          maxZoom={crop.maxZoom}
          objectFit="contain"
          onArea={onArea}
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
        // A carried-over photo has no edit: shown whole, nothing to crop;
        // its feed framing is the author's (#341).
        <span className={styles.still} data-edit-still="">
          <img ref={still} alt="" draggable={false} src={crop.image} />
          {stillLayer === null || stillBox === null ? null : (
            <span
              className={styles.frame}
              data-edit-still-frame=""
              style={{
                width: `${stillBox.width}px`,
                height: `${stillBox.height}px`,
              }}
            >
              {stillLayer}
            </span>
          )}
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
      aria-label={
        feedTool === "region"
          ? "动态流显示范围。上下拖动选择显示的部分；左右方向键切换照片"
          : feedOn
            ? "动态流预览；左右方向键切换照片"
            : fielded
              ? "裁剪区域。拖动调整位置，双指缩放，拖动四角改变裁剪范围；左右方向键切换照片"
              : "裁剪区域。拖动调整位置，双指缩放；左右方向键切换照片"
      }
      className={styles.stage}
      data-boxed={box === null ? undefined : ""}
      data-edit-stage=""
      data-feed-drag={feedDrag ? "" : undefined}
      data-feed-tool={feedOn ? "on" : "off"}
      data-gesture={gesture ? "" : undefined}
      data-pan={crop.pannable ? "1" : "0"}
      data-resizing={resizing ? "" : undefined}
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
      {reframing ? (
        <ReframeLayer
          onStill={() =>
            setReframe((current) =>
              current === null ? current : { ...current, still: true },
            )
          }
          reframe={reframe}
        />
      ) : null}
      {fielded && !cropPaused ? (
        <span className={editorStyles.visuallyHidden} id={handleHintId}>
          {HANDLE_HINT}
        </span>
      ) : null}
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
            feedOn && feedHint !== null ? feedHintId : undefined
          }
          // Off (`aria-disabled`, so focus stays on it as the press that
          // leaves the tool on a photo without a window turns it off).
          aria-disabled={!feedOn && feedWindow === null}
          aria-label="动态流"
          aria-pressed={feedOn}
          className={styles.fab}
          data-edit-feed-tool=""
          onClick={() => {
            if (!feedOn && feedWindow === null) return;
            // Never under a finger on the photo or a corner: what it does is
            // not kept until it lifts (#341).
            if (gesture || grabbed || grabbedNow.current || resizing) return;
            onToggleFeedTool();
          }}
          title="动态流"
          type="button"
        >
          <EditGlyph name="guide" />
        </button>
        {feedOn && feedHint !== null ? (
          <span className={editorStyles.visuallyHidden} id={feedHintId}>
            {feedHint}
          </span>
        ) : null}
      </div>
      <div className={styles.stageRail}>
        <button
          aria-disabled={!crop.restorable}
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

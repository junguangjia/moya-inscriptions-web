"use client";

import { DndContext, closestCenter } from "@dnd-kit/core";
import {
  SortableContext,
  rectSortingStrategy,
  useSortable,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { Icon } from "@moya/ui";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";

import { sortAnnouncements } from "../../../media-composer/sort-announcements";
import {
  liftTick,
  useMediaSortSensors,
} from "../../../media-composer/sort-sensors";
import { FEED_GALLERY_MAXIMUM } from "../media/feed-stage-slides";
import { useItemThumb } from "../media/media-item-tile";
import { EditedImage } from "../media/media-preview";
import { CaptureInput, PickInput } from "./add-tiles";
import styles from "./edit-screen.module.css";
import { EditGlyph, chipLabel, needsAttention } from "./edit-stage";
import { projectedIndex } from "./photo-tile";

import type { FileOrigin } from "../../import-grouping";
import type { UploadItemView } from "../../upload-manager";
import type { Size } from "../media/media-geometry";
import type { ItemStatus } from "../media/media-status";
import type {
  DragEndEvent,
  DragStartEvent,
  Modifier,
  ScreenReaderInstructions,
} from "@dnd-kit/core";
import type { PublishingMediaItem, WorkDraftItem } from "@moya/contracts";
import type {
  CSSProperties,
  KeyboardEvent as ReactKeyboardEvent,
  ReactNode,
  RefObject,
} from "react";

export { needsAttention };

/**
 * 编辑's thumbnail strip (#244 r4 R3/R4, mockup B `.strip`), read right to
 * left as the feed reads: 第 1 项, the 首图, sits at the right edge and the
 * later photos follow leftwards; an icon-only 添加照片 (left out once the
 * album is full) follows the last photo, outside the scroller, so it is
 * always whole: the scroller is only as wide as its photos until they
 * overflow it. The DOM keeps the logical order (第 1 项 first, + last), so
 * tab order and screen readers go 1 → N, then +; a row-reverse track inside
 * an ordinary left-to-right scroller draws it mirrored (D8), which keeps
 * dnd-kit's scrolling and `scrollLeft` arithmetic as it expects. Should +
 * go (the album filled up) while it has focus, the last photo takes it.
 *
 * Photo 1 always carries a seal-red 首图 badge on its bottom edge (D9);
 * while a photo is held every thumbnail shows the place it would take,
 * renumbering live. A long press on touch, or a short drag with mouse or
 * pen, lifts a thumbnail and moves it along the strip only; Space lifts it
 * from the keyboard. → and ← walk focus towards and away from 首图, and
 * Alt + → / ← move the focused photo one place (D10). A tap makes a photo
 * current; a tap on the current photo opens its sheet: the fix sheet while
 * it needs the author, the photo sheet otherwise (D11). The current photo
 * carries the ring and the × that removes it. A focused thumbnail is always
 * scrolled into the strip's view by the strip alone, never the page.
 */

/** The word for position 1 (r4 ASK-4): the badge, the names, the hint. */
export const FIRST_MARK = "首图";

/** What one thumbnail draws, from the screen's media actions. */
export interface StripSource {
  readonly view: UploadItemView | undefined;
  readonly server: PublishingMediaItem | undefined;
  readonly localStill: Blob | null;
  /** The account's thumbnail of the edited photo, once it exists. */
  readonly editedThumbSrc: string | null;
  readonly status: ItemStatus;
  /**
   * An older draft's chosen cover that is not photo 1: it keeps its 封面
   * mark until position 1 changes (§6 G6).
   */
  readonly chosenCover: boolean;
}

/** The + cell's hidden inputs, which 编辑's add sheet clicks. */
export interface StripAddInputs {
  /** The picker for several photos (选择照片). */
  readonly pick: RefObject<HTMLInputElement | null>;
  /** The rear camera (拍照); null where none is drawn (not a coarse pointer). */
  readonly capture: RefObject<HTMLInputElement | null> | null;
}

export interface ThumbnailStripProps {
  /** The DndContext id (one per editor session). */
  readonly id: string;
  /** In content order: index 0 is 第 1 项, the 首图. */
  readonly items: readonly WorkDraftItem[];
  readonly currentKey: string;
  readonly sourceOf: (item: WorkDraftItem) => StripSource;
  /** A tap on another photo: it becomes current. */
  readonly onSelect: (key: string) => void;
  /** A tap on the current photo while it needs the author: its fix sheet. */
  readonly onFix: (key: string) => void;
  /** A tap on the current photo that needs nothing: its photo sheet. */
  readonly onMenu: (key: string) => void;
  /** × on the current photo. */
  readonly onRemove: (key: string) => void;
  /** A drop: `key` moves to the strip index of the photo it was dropped on. */
  readonly onReorder: (key: string, index: number) => void;
  /** Alt + → (−1, towards 首图) and Alt + ← (+1). */
  readonly onMove: (key: string, offset: -1 | 1) => void;
  /** A photo was lifted (pointer, touch or keyboard). */
  readonly onSortStart?: (() => void) | undefined;
  /** A tap on +: the screen opens its add sheet. */
  readonly onAdd: () => void;
  readonly addInputs: StripAddInputs;
  /** Files chosen through either input (the screen stages them). */
  readonly onAddFiles: (files: readonly File[], origin: FileOrigin) => void;
  /** The album is full: the strip ends without the add cell. */
  readonly addHidden: boolean;
  /** No upload session yet: the add cell waits. */
  readonly addDisabled: boolean;
  readonly reducedMotion: boolean;
  /**
   * Each photo's source size once its thumbnail knows it (the account's
   * presentation or the decoded local copy), for 应用到全部.
   */
  readonly onSourceSize?:
    ((key: string, size: Size | null) => void) | undefined;
}

/** dnd-kit's keyboard help for the strip, in its right-to-left order. */
export const stripScreenReaderInstructions: ScreenReaderInstructions = {
  draggable: `照片从右往左排列，最右一张是${FIRST_MARK}。按空格键拿起，用左右方向键移动，向右是往前；再按空格键或回车键放下，按 Esc 取消。也可以按 Alt 加左右方向键移动一位，或点按当前照片后选择设为首图、前移、后移。`,
};

/**
 * Keeps a lifted thumbnail in the strip: it moves sideways only, and never
 * past the strip's visible ends (no `@dnd-kit/modifiers`, rule 9).
 */
export const alongStrip: Modifier = ({
  transform,
  draggingNodeRect,
  scrollableAncestorRects,
}) => {
  const bounds = scrollableAncestorRects[0];
  if (draggingNodeRect === null || bounds === undefined)
    return { ...transform, y: 0 };
  return {
    ...transform,
    y: 0,
    x: Math.min(
      Math.max(transform.x, bounds.left - draggingNodeRect.left),
      bounds.right - draggingNodeRect.right,
    ),
  };
};

/** How far the current photo's × pokes out of its thumbnail. */
const REMOVE_OVERHANG_PX = 6;

/** Scrolls the strip, never the page, until `cell` (and its × room) is inside it. */
export const revealThumb = (strip: HTMLElement, cell: HTMLElement) => {
  const view = strip.getBoundingClientRect();
  const box = cell.getBoundingClientRect();
  const room = REMOVE_OVERHANG_PX;
  if (box.left - room < view.left)
    strip.scrollLeft -= view.left - box.left + room;
  else if (box.right + room > view.right)
    strip.scrollLeft += box.right - view.right + room;
};

/**
 * Focuses the thumbnail of `key` inside `scope` without scrolling the page,
 * then shows it inside its strip (`revealThumb`). False when it is not there.
 */
export const focusThumb = (scope: ParentNode, key: string): boolean => {
  const thumb = scope.querySelector<HTMLElement>(`[data-edit-thumb="${key}"]`);
  if (thumb === null) return false;
  thumb.focus({ preventScroll: true });
  const cell = thumb.closest<HTMLElement>("[data-edit-index]");
  const strip = thumb.closest<HTMLElement>("[data-edit-strip]");
  if (cell !== null && strip !== null) revealThumb(strip, cell);
  return true;
};

export interface ThumbNameParts {
  /** 1-based: 第 N 项. */
  readonly number: number;
  /** How many photos the strip holds (two or more can be sorted). */
  readonly count: number;
  readonly live: boolean;
  readonly status: ItemStatus;
  /** The manager failed the upload (上传失败, not 处理失败). */
  readonly uploadFailed: boolean;
  readonly current: boolean;
  readonly chosenCover: boolean;
}

/**
 * The thumbnail's name: 「第 N 项[，实况照片][，首图][，仅作品页][，封面][，状态]」,
 * then what a tap on the current photo does (。点按查看操作 or 。点按处理),
 * then 长按拖动可排序 while there is something to sort it among.
 */
export const thumbName = ({
  number,
  count,
  live,
  status,
  uploadFailed,
  current,
  chosenCover,
}: ThumbNameParts): string => {
  const removing = status.kind === "removing";
  const marks = [
    `第 ${number} 项`,
    live ? "实况照片" : null,
    number === 1 ? FIRST_MARK : null,
    number > FEED_GALLERY_MAXIMUM ? "仅作品页" : null,
    chosenCover ? "封面" : null,
    status.kind === "ready" ? null : chipLabel(status, uploadFailed),
  ]
    .filter((part) => part !== null)
    .join("，");
  const tap =
    !current || removing
      ? null
      : needsAttention(status)
        ? "点按处理"
        : "点按查看操作";
  const sort = count >= 2 && !removing ? "长按拖动可排序" : null;
  if (tap === null) return sort === null ? marks : `${marks}，${sort}`;
  return sort === null ? `${marks}。${tap}` : `${marks}。${tap}，${sort}`;
};

/** The thumbnail's picture: the account's (edited) thumbnail or the local still. */
const useStripThumb = (item: WorkDraftItem, source: StripSource) =>
  useItemThumb({
    view: source.view,
    server: source.server,
    localStill: source.localStill,
    editedThumbSrc: source.editedThumbSrc,
    edit: item.edit,
  });

/**
 * The mark on a thumbnail's bottom edge (aria-hidden: the name says the
 * same): 首图 on the photo that is (or would land) first; while a photo is
 * held, every other photo's place, dimmed past the feed's ten; at rest an
 * older draft's chosen cover reads 封面.
 */
const StripMark = ({
  place,
  held,
  chosenCover,
}: {
  /** 0-based, projected while a photo is held. */
  readonly place: number;
  readonly held: boolean;
  readonly chosenCover: boolean;
}) => {
  if (place === 0)
    return (
      <span
        aria-hidden="true"
        className={styles.stripMark}
        data-edit-mark="first"
      >
        {FIRST_MARK}
      </span>
    );
  if (held)
    return (
      <span
        aria-hidden="true"
        className={styles.stripMark}
        data-edit-mark={place >= FEED_GALLERY_MAXIMUM ? "beyond" : "order"}
      >
        {place + 1}
      </span>
    );
  if (chosenCover)
    return (
      <span
        aria-hidden="true"
        className={styles.stripMark}
        data-edit-mark="cover"
      >
        封面
      </span>
    );
  return null;
};

/** Plain arrows walk the strip as it is drawn: → is towards 首图. */
const WALK: Readonly<Record<string, -1 | 1>> = {
  ArrowRight: -1,
  ArrowLeft: 1,
};

const StripThumb = ({
  item,
  index,
  count,
  current,
  source,
  reducedMotion,
  onSelect,
  onFix,
  onMenu,
  onRemove,
  onMove,
  onWalk,
  onSourceSize,
  register,
}: {
  readonly item: WorkDraftItem;
  readonly index: number;
  readonly count: number;
  readonly current: boolean;
  readonly source: StripSource;
  readonly reducedMotion: boolean;
  readonly onSelect: (key: string) => void;
  readonly onFix: (key: string) => void;
  readonly onMenu: (key: string) => void;
  readonly onRemove: (key: string) => void;
  readonly onMove: (key: string, offset: -1 | 1) => void;
  readonly onWalk: (index: number) => boolean;
  readonly onSourceSize: ((key: string, size: Size | null) => void) | undefined;
  readonly register: (key: string, node: HTMLElement | null) => void;
}) => {
  const { key } = item;
  const { status } = source;
  const removing = status.kind === "removing";
  // Sorting needs two photos; a photo being removed stays a place to drop on.
  const sortable = count >= 2 && !removing;
  const {
    activeIndex,
    attributes,
    isDragging,
    listeners,
    overIndex,
    setActivatorNodeRef,
    setNodeRef,
    transform,
    transition,
  } = useSortable({
    id: key,
    attributes: { roleDescription: "可排序的图片" },
    disabled: sortable ? false : { draggable: true, droppable: false },
    ...(reducedMotion ? { transition: null } : {}),
  });
  const cellRef = useCallback(
    (node: HTMLLIElement | null) => {
      setNodeRef(node);
      register(key, node);
    },
    [key, register, setNodeRef],
  );

  const thumb = useStripThumb(item, source);
  const width = thumb.account?.presentation?.width ?? thumb.local.size?.width;
  const height =
    thumb.account?.presentation?.height ?? thumb.local.size?.height;
  const latest = useRef(onSourceSize);
  useEffect(() => {
    latest.current = onSourceSize;
  });
  useEffect(() => {
    latest.current?.(
      key,
      width === undefined || height === undefined ? null : { width, height },
    );
  }, [key, width, height]);

  const attention = needsAttention(status);
  const style: CSSProperties = {
    transform: CSS.Translate.toString(transform),
    ...(transition ? { transition } : {}),
  };

  const onKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>) => {
    if (!isDragging && !event.ctrlKey && !event.metaKey) {
      // Enter is the tap (the button's own click); Space lifts the photo.
      if (event.key === "Enter" && !event.altKey) return;
      const step = WALK[event.key];
      if (step !== undefined) {
        if (!event.altKey) {
          if (onWalk(index + step)) event.preventDefault();
          return;
        }
        if (sortable) {
          event.preventDefault();
          onMove(key, step);
        }
        return;
      }
    }
    if (sortable) listeners?.onKeyDown?.(event);
  };

  return (
    <li
      ref={cellRef}
      className={styles.stripCell}
      // The thumbnail itself is the lifted one under the finger: one copy.
      data-dragging={isDragging ? "true" : undefined}
      data-edit-index={index}
      data-edit-key={key}
      data-media-status={status.kind}
      style={style}
    >
      <button
        ref={setActivatorNodeRef}
        {...(sortable ? attributes : {})}
        {...(sortable ? listeners : {})}
        aria-current={current ? "true" : "false"}
        aria-haspopup={current && !removing ? "dialog" : undefined}
        aria-keyshortcuts={
          sortable ? "Alt+ArrowLeft Alt+ArrowRight" : undefined
        }
        aria-label={thumbName({
          number: index + 1,
          count,
          live: item.kind === "live",
          status,
          uploadFailed: source.view?.phase === "failed",
          current,
          chosenCover: source.chosenCover,
        })}
        className={styles.stripThumb}
        data-attention={attention ? "true" : undefined}
        data-edit-thumb={key}
        data-media-status={status.kind}
        onClick={(event) => {
          if (isDragging) return;
          if (!current || removing) {
            onSelect(key);
            return;
          }
          // The sheet hands focus back to what opened it, and a tap does
          // not focus a button everywhere (iOS): the thumbnail takes it.
          event.currentTarget.focus({ preventScroll: true });
          if (attention) onFix(key);
          else onMenu(key);
        }}
        // The long press that lifts a photo never opens a menu.
        onContextMenu={(event) => event.preventDefault()}
        onKeyDown={onKeyDown}
        type="button"
      >
        <EditedImage
          edit={thumb.edit}
          fallback={item.kind === "live" ? "实况照片" : "照片"}
          knownSize={thumb.knownSize}
          src={thumb.src}
        />
        {status.kind === "uploading" ? (
          <span aria-hidden="true" className={styles.stripProgress}>
            <span style={{ width: `${status.percent}%` }} />
          </span>
        ) : attention ? (
          <span aria-hidden="true" className={styles.stripDisc}>
            <Icon aria-hidden="true" className={styles.icon14} name="error" />
          </span>
        ) : null}
      </button>
      {current ? (
        <button
          aria-label={`移除第 ${index + 1} 项`}
          className={styles.stripRemove}
          data-edit-remove={key}
          onClick={() => onRemove(key)}
          type="button"
        >
          <Icon aria-hidden="true" className={styles.icon14} name="close" />
        </button>
      ) : null}
      <StripMark
        chosenCover={source.chosenCover}
        held={activeIndex >= 0}
        place={projectedIndex(index, activeIndex, overIndex)}
      />
    </li>
  );
};

/**
 * + 's cell, outside the scroller. It tells `onFocusLost` when it goes
 * while it holds focus (the album filled up): its layout cleanup runs
 * before React takes it out of the page, while focus is still inside.
 */
const StripAddCell = ({
  onFocusLost,
  children,
}: {
  readonly onFocusLost: () => void;
  readonly children: ReactNode;
}) => {
  const ref = useRef<HTMLDivElement>(null);
  const lost = useRef(onFocusLost);
  lost.current = onFocusLost;
  useLayoutEffect(() => {
    const cell = ref.current;
    return () => {
      if (cell?.contains(document.activeElement)) lost.current();
    };
  }, []);
  return (
    <div ref={ref} className={styles.stripAddCell} data-edit-add-cell="">
      {children}
    </div>
  );
};

export const ThumbnailStrip = ({
  id,
  items,
  currentKey,
  sourceOf,
  onSelect,
  onFix,
  onMenu,
  onRemove,
  onReorder,
  onMove,
  onSortStart,
  onAdd,
  addInputs,
  onAddFiles,
  addHidden,
  addDisabled,
  reducedMotion,
  onSourceSize,
}: ThumbnailStripProps) => {
  const strip = useRef<HTMLDivElement>(null);
  const cells = useRef(new Map<string, HTMLElement>());
  const register = useCallback((key: string, node: HTMLElement | null) => {
    if (node === null) cells.current.delete(key);
    else cells.current.set(key, node);
  }, []);
  const sensors = useMediaSortSensors({ reducedMotion });
  const [sorting, setSorting] = useState(false);
  const keys = items.map((item) => item.key);
  const count = items.length;
  const addFiles = (files: File[]) => onAddFiles(files, "picker");

  // The current photo is centred in the strip as it changes (a tap, the
  // stage's arrow keys, a removal) and as photos join or leave: the scroll
  // origin is the left end, where photos are added, so the rest shift. Only
  // the strip scrolls, and only sideways: never the screen around it. The
  // first placement is not animated (photo 1 lands at the right end).
  const placed = useRef(false);
  useEffect(() => {
    const host = strip.current;
    const cell = cells.current.get(currentKey);
    if (!host || !cell) return;
    const left = Math.max(
      0,
      cell.offsetLeft - host.clientWidth / 2 + cell.offsetWidth / 2,
    );
    const behavior = reducedMotion || !placed.current ? "auto" : "smooth";
    placed.current = true;
    host.scrollTo?.({ left, behavior });
  }, [currentKey, reducedMotion, count]);

  // + went with focus on it (the album is full): the photo beside it, the
  // last one, takes focus, shown in the strip, so focus never falls to the
  // page.
  const addFocusLost = useRef(false);
  const lastKey = keys[keys.length - 1];
  useLayoutEffect(() => {
    if (!addFocusLost.current) return;
    addFocusLost.current = false;
    const host = strip.current;
    const active = document.activeElement;
    if (
      host === null ||
      lastKey === undefined ||
      (active !== null && active !== document.body)
    )
      return;
    focusThumb(host, lastKey);
  });

  /** Focus to the photo at `index` (→ / ←), shown inside the strip. */
  const walk = (index: number): boolean => {
    const key = keys[index];
    const host = strip.current;
    if (key === undefined || host === null) return false;
    return focusThumb(host, key);
  };

  const onDragStart = (event: DragStartEvent) => {
    setSorting(true);
    liftTick(event);
    onSortStart?.();
  };
  const onDragEnd = ({ active, over }: DragEndEvent) => {
    setSorting(false);
    if (over === null || active.id === over.id) return;
    const index = keys.indexOf(String(over.id));
    if (index >= 0) onReorder(String(active.id), index);
  };

  return (
    <>
      <div
        ref={strip}
        aria-label="照片"
        className={styles.strip}
        data-edit-strip=""
        data-sorting={sorting ? "" : undefined}
        role="group"
      >
        <DndContext
          accessibility={{
            announcements: sortAnnouncements(keys, { first: FIRST_MARK }),
            screenReaderInstructions: stripScreenReaderInstructions,
          }}
          autoScroll={{ threshold: { x: 0.2, y: 0 } }}
          collisionDetection={closestCenter}
          id={id}
          modifiers={[alongStrip]}
          onDragCancel={() => setSorting(false)}
          onDragEnd={onDragEnd}
          onDragStart={onDragStart}
          sensors={sensors}
        >
          <SortableContext items={keys} strategy={rectSortingStrategy}>
            <ol
              aria-label="照片，从右往左按发布顺序"
              className={styles.stripTrack}
              data-edit-strip-track=""
            >
              {items.map((item, index) => (
                <StripThumb
                  key={item.key}
                  count={count}
                  current={item.key === currentKey}
                  index={index}
                  item={item}
                  onFix={onFix}
                  onMenu={onMenu}
                  onMove={onMove}
                  onRemove={onRemove}
                  onSelect={onSelect}
                  onSourceSize={onSourceSize}
                  onWalk={walk}
                  reducedMotion={reducedMotion}
                  register={register}
                  source={sourceOf(item)}
                />
              ))}
            </ol>
          </SortableContext>
        </DndContext>
      </div>
      {/* After the photos in the DOM; drawn left of them, outside the scroller. */}
      {addHidden ? null : (
        <StripAddCell
          onFocusLost={() => {
            addFocusLost.current = true;
          }}
        >
          {/* The add sheet's choices click these: they stay mounted here. */}
          <PickInput
            disabled={addDisabled}
            inputRef={addInputs.pick}
            onFiles={addFiles}
          />
          {addInputs.capture === null ? null : (
            <CaptureInput
              disabled={addDisabled}
              inputRef={addInputs.capture}
              onFiles={addFiles}
            />
          )}
          <button
            aria-haspopup="dialog"
            aria-label="添加照片"
            className={`${styles.stripThumb} ${styles.stripAdd}`}
            data-edit-add=""
            disabled={addDisabled}
            onClick={(event) => {
              // Focus returns here when the add sheet closes.
              event.currentTarget.focus({ preventScroll: true });
              onAdd();
            }}
            type="button"
          >
            <EditGlyph name="plus" size={20} />
          </button>
        </StripAddCell>
      )}
    </>
  );
};

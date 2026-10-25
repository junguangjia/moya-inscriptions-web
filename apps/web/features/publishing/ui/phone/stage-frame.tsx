"use client";

import { useEffect, useRef, useState } from "react";

import {
  fieldRect,
  imageRect,
  intersectRect,
  minimumWindow,
  resizeRect,
} from "../../../media-composer/crop-window";
import {
  capturePointer,
  releasePointer,
} from "../../../media-composer/pointer-capture";
import styles from "./edit-screen.module.css";

import type {
  CropCorner,
  CropInset,
  CropPoint,
  CropRect,
} from "../../../media-composer/crop-window";
import type { Size } from "../media/media-geometry";
import type { MediaCrop, MediaRotation } from "@moya/contracts";
import type {
  CSSProperties,
  KeyboardEvent as ReactKeyboardEvent,
  PointerEvent as ReactPointerEvent,
  ReactNode,
} from "react";

/**
 * The phone 编辑 stage's crop frame (#341, iOS Photos' crop): the frame's
 * marks, its four corner handles (`CropWindow`) and the zoom that follows a
 * corner let go (`ReframeLayer`). The stage (edit-stage.tsx) owns the
 * cropper and the crop work; this owns the window while a corner moves, so
 * the cropper does not render on every move.
 */

/**
 * The crop field's insets while the corner handles are offered (the
 * Owner's 照片留边): 60px keeps every handle off the top row (8px down, 44px
 * buttons) and the bottom rail, 16px off the screen's edge swipes.
 */
export const CROP_FIELD_INSETS: CropInset = { block: 60, inline: 16 };
/** The keys the crop surface answers (react-easy-crop's arrows, `+ − 0`). */
export const CROP_KEYS: ReadonlySet<string> = new Set([
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
/** A handle's arrow-key step, as the crop area's nudge; Shift takes a fifth. */
const HANDLE_KEY_STEP = 8;
/** A run of arrow presses is let go once the keys rest this long (the peek's settle). */
export const HANDLE_KEY_REST_MS = 400;
/** How far a finger goes before a handle drags (a tap moves nothing). */
const HANDLE_SLOP = 2;
/** The reframe zoom's longest stay, whatever the new cropper does. */
export const REFRAME_MAX_MS = 1000;
/** A released window within this many px of where it started is no change. */
const WINDOW_TOLERANCE = 0.5;

const CORNERS: readonly CropCorner[] = ["nw", "ne", "sw", "se"];

/** The handles' names (as the article crop's corners). */
const CORNER_LABELS: Readonly<Record<CropCorner, string>> = {
  nw: "调整裁剪左上角",
  ne: "调整裁剪右上角",
  sw: "调整裁剪左下角",
  se: "调整裁剪右下角",
};

/** The corner marks' places (B `.cn`, as 封面构图 draws them). */
const CORNER_MARKS: Readonly<Record<CropCorner, string>> = {
  nw: "top-left",
  ne: "top-right",
  sw: "bottom-left",
  se: "bottom-right",
};

/** Which way a handle's arrow key moves its corner. */
const ARROWS: Readonly<Partial<Record<string, CropPoint>>> = {
  ArrowLeft: { x: -1, y: 0 },
  ArrowRight: { x: 1, y: 0 },
  ArrowUp: { x: 0, y: -1 },
  ArrowDown: { x: 0, y: 1 },
};

/** What a handle says it does (its description). */
export const HANDLE_HINT = "拖动或用方向键调整裁剪范围";

/** A corner drag let go: the window over the cropper's frame as it then was. */
export interface WindowRelease {
  readonly rect: CropRect;
  /** The cropper's frame the window was drawn in. */
  readonly frame: Size;
  /** What that frame showed (null: the whole edited frame). */
  readonly area: MediaCrop | null;
}

/** A corner under way: by a finger (`pointer`) or by the arrow keys (null). */
interface WindowDrag {
  readonly corner: CropCorner;
  readonly pointer: number | null;
  readonly element: HTMLElement | null;
  /** Where the finger landed, in client pixels. */
  readonly origin: CropPoint;
  /** Client pixels per frame pixel. */
  readonly scale: number;
  readonly frame: Size;
  readonly area: MediaCrop | null;
  /** The photo and the crop field, both: where the window may go. */
  readonly bounds: CropRect;
  readonly minimum: Size;
  readonly ratio: number | null;
  readonly start: CropRect;
  rect: CropRect;
  /** Past the slop (a finger) or keyed: a drag, not a tap. */
  moved: boolean;
}

const sameRect = (left: CropRect, right: CropRect, tolerance: number) =>
  Math.abs(left.left - right.left) <= tolerance &&
  Math.abs(left.top - right.top) <= tolerance &&
  Math.abs(left.width - right.width) <= tolerance &&
  Math.abs(left.height - right.height) <= tolerance;

export const offsetRect = (rect: CropRect, x: number, y: number): CropRect => ({
  ...rect,
  left: rect.left + x,
  top: rect.top + y,
});

const px = (rect: CropRect): CSSProperties => ({
  left: `${rect.left}px`,
  top: `${rect.top}px`,
  width: `${rect.width}px`,
  height: `${rect.height}px`,
});

export const nextFrame = (callback: () => void): number =>
  typeof requestAnimationFrame === "function"
    ? requestAnimationFrame(callback)
    : window.setTimeout(callback, 16);

export const cancelFrame = (id: number) => {
  if (typeof cancelAnimationFrame === "function") cancelAnimationFrame(id);
  else window.clearTimeout(id);
};

/** Has the photo decoded before the reframe layer shows it (WebKit draws an undecoded image late). */
export const predecode = (src: string) => {
  if (typeof Image === "undefined") return;
  const image = new Image();
  image.src = src;
  if (typeof image.decode === "function")
    void image.decode().catch(() => undefined);
};

interface CropWindowProps {
  /** The cropper's frame as it laid it out, in stage pixels. */
  readonly frame: Size;
  readonly stage: Size | null;
  /** The field has room for the handles: they are drawn. */
  readonly offered: boolean;
  /** The handles take input (not while the photo reframes or anything else has it). */
  readonly active: boolean;
  /** A drag under way ends without a change (the back sheet, the framing tool). */
  readonly interrupted: boolean;
  /** The shape a corner keeps (width / height); null: free. */
  readonly ratio: number | null;
  /** What the frame shows now (null: the whole edited frame). */
  readonly area: () => MediaCrop | null;
  /** The feed band, drawn over the window at rest. */
  readonly band: ReactNode;
  readonly hintId: string;
  /** A corner is taken: the author's input, a finger on the stage. */
  readonly onBegin: () => void;
  /** The window leaves the frame (true) or is back on it (false). */
  readonly onResizing: (on: boolean) => void;
  /** The corner is let go or taken back. */
  readonly onEnd: () => void;
  readonly onRelease: (release: WindowRelease) => void;
}

/**
 * The crop frame's marks (B: corners, the thirds and the feed band) and its
 * corner handles (#341). Each handle is a 44px target inside its corner; a
 * finger dragging it moves that corner of the window (the opposite one
 * stays), the arrow keys do too, a step at a time, and the window is let go
 * once the keys rest. A drag cancelled by the system, the page losing focus
 * or a touch elsewhere ends with nothing changed. The live window stays
 * local, so the cropper does not render on every move.
 */
export const CropWindow = ({
  frame,
  stage,
  offered,
  active,
  interrupted,
  ratio,
  area,
  band,
  hintId,
  onBegin,
  onResizing,
  onEnd,
  onRelease,
}: CropWindowProps) => {
  const [live, setLive] = useState<CropRect | null>(null);
  const windowRef = useRef<HTMLSpanElement>(null);
  const drag = useRef<WindowDrag | null>(null);
  const drawing = useRef<number | null>(null);
  const keyRest = useRef<ReturnType<typeof setTimeout> | null>(null);
  const unlisten = useRef<(() => void) | null>(null);
  const latest = useRef({
    frame,
    stage,
    active,
    ratio,
    area,
    onBegin,
    onResizing,
    onEnd,
    onRelease,
  });
  latest.current = {
    frame,
    stage,
    active,
    ratio,
    area,
    onBegin,
    onResizing,
    onEnd,
    onRelease,
  };

  /** Ends the drag: kept (`keep`, when the window moved) or taken back. */
  const finish = (keep: boolean) => {
    const current = drag.current;
    if (current === null) return;
    drag.current = null;
    if (drawing.current !== null) cancelFrame(drawing.current);
    drawing.current = null;
    if (keyRest.current !== null) clearTimeout(keyRest.current);
    keyRest.current = null;
    unlisten.current?.();
    unlisten.current = null;
    if (current.element !== null && current.pointer !== null)
      releasePointer(current.element, current.pointer);
    setLive(null);
    const shown = latest.current;
    if (current.moved) shown.onResizing(false);
    shown.onEnd();
    if (
      keep &&
      current.moved &&
      !sameRect(current.rect, current.start, WINDOW_TOLERANCE)
    )
      shown.onRelease({
        rect: current.rect,
        frame: current.frame,
        area: current.area,
      });
  };
  const finishNow = useRef(finish);
  finishNow.current = finish;

  /**
   * A drag of `corner` from the window at rest; null while the handles take
   * no input, a drag is under way, or the photo leaves no room to move in.
   */
  const begin = (
    corner: CropCorner,
    pointer: {
      readonly id: number;
      readonly element: HTMLElement;
      readonly origin: CropPoint;
    } | null,
  ): WindowDrag | null => {
    const shown = latest.current;
    if (!shown.active || drag.current !== null || shown.stage === null)
      return null;
    const size = shown.frame;
    const shownArea = shown.area();
    const picture = imageRect(size, shownArea);
    const bounds = intersectRect(
      picture,
      fieldRect(size, shown.stage, CROP_FIELD_INSETS),
    );
    const minimum = minimumWindow(picture);
    const smallest =
      shown.ratio === null
        ? minimum
        : {
            width: Math.max(minimum.width, minimum.height * shown.ratio),
            height: Math.max(minimum.height, minimum.width / shown.ratio),
          };
    if (
      size.width < smallest.width ||
      size.height < smallest.height ||
      bounds.width < smallest.width ||
      bounds.height < smallest.height
    )
      return null;
    const drawn = windowRef.current?.getBoundingClientRect().width ?? 0;
    const start = { left: 0, top: 0, width: size.width, height: size.height };
    const started: WindowDrag = {
      corner,
      pointer: pointer?.id ?? null,
      element: pointer?.element ?? null,
      origin: pointer?.origin ?? { x: 0, y: 0 },
      scale: drawn > 0 ? drawn / size.width : 1,
      frame: size,
      area: shownArea,
      bounds,
      minimum,
      ratio: shown.ratio,
      start,
      rect: start,
      moved: false,
    };
    drag.current = started;
    shown.onBegin();
    return started;
  };

  /** Follows the finger to `point` (client pixels); a move inside the slop is none. */
  const follow = (current: WindowDrag, point: CropPoint) => {
    const dx = point.x - current.origin.x;
    const dy = point.y - current.origin.y;
    if (!current.moved) {
      if (Math.abs(dx) < HANDLE_SLOP && Math.abs(dy) < HANDLE_SLOP) return;
      current.moved = true;
      latest.current.onResizing(true);
    }
    current.rect = resizeRect(
      current.start,
      current.corner,
      { x: dx / current.scale, y: dy / current.scale },
      current.bounds,
      current.minimum,
      current.ratio,
    );
  };

  /** While a finger drags: the page never scrolls or zooms, and leaving it ends the drag. */
  const listen = () => {
    const cancel = () => finishNow.current(false);
    const hidden = () => {
      if (document.visibilityState === "hidden") cancel();
    };
    const elsewhere = (event: TouchEvent) => {
      if (
        event.target instanceof Element &&
        event.target.closest("[data-media-crop]") === null
      )
        cancel();
    };
    const still = (event: Event) => event.preventDefault();
    window.addEventListener("blur", cancel);
    window.addEventListener("pagehide", cancel);
    document.addEventListener("visibilitychange", hidden);
    document.addEventListener("touchstart", elsewhere, {
      capture: true,
      passive: true,
    });
    document.addEventListener("touchmove", still, { passive: false });
    document.addEventListener("gesturestart", still);
    unlisten.current = () => {
      window.removeEventListener("blur", cancel);
      window.removeEventListener("pagehide", cancel);
      document.removeEventListener("visibilitychange", hidden);
      document.removeEventListener("touchstart", elsewhere, { capture: true });
      document.removeEventListener("touchmove", still);
      document.removeEventListener("gesturestart", still);
    };
  };

  const down = (
    event: ReactPointerEvent<HTMLButtonElement>,
    corner: CropCorner,
  ) => {
    if (event.pointerType === "mouse" && event.button !== 0) return;
    const element = event.currentTarget;
    const started = begin(corner, {
      id: event.pointerId,
      element,
      origin: { x: event.clientX, y: event.clientY },
    });
    if (started === null) return;
    event.preventDefault();
    capturePointer(element, event.pointerId);
    listen();
  };
  const move = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const current = drag.current;
    if (current === null || current.pointer !== event.pointerId) return;
    follow(current, { x: event.clientX, y: event.clientY });
    // One window per frame, however often the pointer reports.
    if (!current.moved || drawing.current !== null) return;
    drawing.current = nextFrame(() => {
      drawing.current = null;
      if (drag.current === current) setLive(current.rect);
    });
  };
  const up = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const current = drag.current;
    if (current === null || current.pointer !== event.pointerId) return;
    follow(current, { x: event.clientX, y: event.clientY });
    finish(true);
  };
  const lost = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (drag.current?.pointer === event.pointerId) finish(false);
  };

  const keyDown = (
    event: ReactKeyboardEvent<HTMLButtonElement>,
    corner: CropCorner,
  ) => {
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    const current = drag.current;
    if (event.key === "Escape") {
      // Drops a window the keys moved; otherwise Escape is the screen's.
      if (current === null || current.pointer !== null) return;
      event.preventDefault();
      event.stopPropagation();
      finish(false);
      return;
    }
    if (!CROP_KEYS.has(event.key)) return;
    // The crop area's nudge and zoom keys stop here: this is not the photo.
    event.stopPropagation();
    const arrow = ARROWS[event.key];
    if (arrow === undefined) return;
    event.preventDefault();
    let keyed = current;
    if (keyed === null) {
      keyed = begin(corner, null);
      if (keyed === null) return;
      keyed.moved = true;
      latest.current.onResizing(true);
    } else if (keyed.pointer !== null || keyed.corner !== corner) return;
    if (keyRest.current !== null) clearTimeout(keyRest.current);
    keyRest.current = null;
    const step = event.shiftKey ? HANDLE_KEY_STEP * 0.2 : HANDLE_KEY_STEP;
    keyed.rect = resizeRect(
      keyed.rect,
      corner,
      { x: arrow.x * step, y: arrow.y * step },
      keyed.bounds,
      keyed.minimum,
      keyed.ratio,
    );
    setLive(keyed.rect);
  };
  // A run of presses is one reframe: it is let go once the keys rest.
  const keyUp = (event: ReactKeyboardEvent<HTMLButtonElement>) => {
    const current = drag.current;
    if (current?.pointer !== null || ARROWS[event.key] === undefined) return;
    if (keyRest.current !== null) clearTimeout(keyRest.current);
    keyRest.current = setTimeout(() => {
      keyRest.current = null;
      finishNow.current(true);
    }, HANDLE_KEY_REST_MS);
  };
  const blur = () => {
    if (drag.current?.pointer === null) finish(true);
  };

  useEffect(() => {
    if (interrupted || !offered) finishNow.current(false);
  }, [interrupted, offered]);
  useEffect(() => () => finishNow.current(false), []);

  return (
    <span
      className={styles.frame}
      data-edit-frame=""
      style={{ width: `${frame.width}px`, height: `${frame.height}px` }}
    >
      <span
        ref={windowRef}
        className={styles.window}
        data-edit-window=""
        style={live === null ? undefined : px(live)}
      >
        {live === null ? band : null}
        <span aria-hidden="true" className={styles.thirds}>
          <span />
          <span />
          <span />
          <span />
        </span>
        {CORNERS.map((corner) => (
          <span
            key={corner}
            aria-hidden="true"
            className={styles.corner}
            data-corner={CORNER_MARKS[corner]}
          />
        ))}
        {offered ? (
          <span
            className={styles.handles}
            data-active={active ? "" : undefined}
            data-crop-own-control=""
          >
            {CORNERS.map((corner) => (
              <button
                key={corner}
                aria-describedby={hintId}
                aria-label={CORNER_LABELS[corner]}
                className={styles.handle}
                data-crop-handle={corner}
                onBlur={blur}
                onKeyDown={(event) => keyDown(event, corner)}
                onKeyUp={keyUp}
                onLostPointerCapture={lost}
                onPointerCancel={lost}
                onPointerDown={(event) => down(event, corner)}
                onPointerMove={move}
                onPointerUp={up}
                type="button"
              />
            ))}
          </span>
        ) : null}
      </span>
    </span>
  );
};

/**
 * The photo as a corner drag left it, zooming until the window fills the
 * field (iOS Photos' crop), drawn over the stage while the new cropper
 * mounts and seeds under it.
 */
export interface Reframe {
  readonly key: string;
  /** The cropper generation it covers; any other drops it. */
  readonly generation: number;
  readonly next: MediaCrop | null;
  readonly image: string;
  readonly rotation: MediaRotation;
  /** Stage pixels: the window let go, where it goes, and the whole edited frame. */
  readonly from: CropRect;
  readonly to: CropRect;
  readonly picture: CropRect;
  /** The zoom has started. */
  readonly moving: boolean;
  /** The zoom has ended, or never runs (reduced motion). */
  readonly still: boolean;
  /** The new cropper has shown `next`. */
  readonly seeded: boolean;
}

export const ReframeLayer = ({
  reframe,
  onStill,
}: {
  readonly reframe: Reframe;
  readonly onStill: () => void;
}) => {
  const { from, to, picture, rotation } = reframe;
  const scale = to.width / from.width;
  const turned = rotation % 180 !== 0;
  // The source unturned, centred where its turned frame was, then turned.
  const width = turned ? picture.height : picture.width;
  const height = turned ? picture.width : picture.height;
  return (
    <div aria-hidden="true" className={styles.reframe} data-edit-reframe="">
      <div
        className={styles.reframeMotion}
        onTransitionEnd={(event) => {
          if (event.target === event.currentTarget) onStill();
        }}
        style={
          reframe.moving
            ? {
                transform: `translate(${to.left - scale * from.left}px, ${
                  to.top - scale * from.top
                }px) scale(${scale})`,
              }
            : undefined
        }
      >
        <img
          alt=""
          draggable={false}
          src={reframe.image}
          style={{
            left: `${picture.left + picture.width / 2 - width / 2}px`,
            top: `${picture.top + picture.height / 2 - height / 2}px`,
            width: `${width}px`,
            height: `${height}px`,
            transform: rotation === 0 ? undefined : `rotate(${rotation}deg)`,
          }}
        />
        <span className={styles.reframeWindow} style={px(from)} />
      </div>
    </div>
  );
};

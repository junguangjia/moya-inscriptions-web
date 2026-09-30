"use client";
import { useEffect, useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import type { Area } from "react-easy-crop";

export const CROP_MAX_ZOOM = 3;
const ZOOM_STEP = 0.1;

/**
 * Input for a react-easy-crop surface shared by the cover and avatar editors
 * (Owner decision, #171 r3/r4): drag to move and two-finger zoom (touch pinch
 * or trackpad pinch) with no zoom bar. Ctrl + wheel and the + − 0 keys are
 * fallbacks for mouse and keyboard; browser shortcuts stay the browser's.
 */
export const useCropGestures = ({
  locked,
  autoFocus = false,
}: {
  /** Saving: user input is blocked; layout re-reports still apply. */
  locked: boolean;
  /** Focus the crop area once the photo is laid out. */
  autoFocus?: boolean;
}) => {
  const [crop, setCrop] = useState({ x: 0, y: 0 }),
    [zoom, setZoom] = useState(1),
    [surface, setSurface] = useState(0),
    [area, setArea] = useState<Area | null>(null),
    [coarse] = useState(
      () =>
        typeof window !== "undefined" &&
        (window.matchMedia?.("(pointer: coarse)").matches ?? false),
    );
  const frame = useRef<HTMLDivElement>(null),
    focused = useRef(false),
    interacting = useRef(false),
    latestLocked = useRef(locked);
  latestLocked.current = locked;
  // react-easy-crop keeps document listeners until touchend or mouseup. A
  // cancelled touch (system gesture, call) or a lost mouseup would leave the
  // next touch dragging: end it by remounting; crop and zoom stay controlled.
  const endInterrupted = () => {
    if (!interacting.current) return;
    interacting.current = false;
    setSurface((value) => value + 1);
  };
  useEffect(() => {
    const hidden = () => {
      if (document.visibilityState === "hidden") endInterrupted();
    };
    // A second finger landing outside the frame starts no pinch in the
    // library (its distance stays 0, so zoom would jump): end the gesture.
    const outside = (event: TouchEvent) => {
      if (
        frame.current &&
        event.target instanceof Node &&
        !frame.current.contains(event.target)
      )
        endInterrupted();
    };
    window.addEventListener("blur", endInterrupted);
    document.addEventListener("visibilitychange", hidden);
    document.addEventListener("touchstart", outside, {
      capture: true,
      passive: true,
    });
    return () => {
      window.removeEventListener("blur", endInterrupted);
      document.removeEventListener("visibilitychange", hidden);
      document.removeEventListener("touchstart", outside, { capture: true });
    };
  }, []);
  // The crop area exists once the library has measured and reported an
  // area: focus it then, once (keyboard and screen readers).
  useEffect(() => {
    if (!autoFocus || focused.current || !area) return;
    const target = frame.current?.querySelector<HTMLElement>('[tabindex="0"]');
    if (!target) return;
    focused.current = true;
    target.focus({ preventScroll: true });
  }, [area, autoFocus]);
  const changeZoom = (value: number) => {
    if (latestLocked.current) return;
    setZoom(Math.min(CROP_MAX_ZOOM, Math.max(1, value)));
  };
  const reset = () => {
    if (latestLocked.current) return;
    setCrop({ x: 0, y: 0 });
    setZoom(1);
  };
  const keys = (event: KeyboardEvent<HTMLElement>) => {
    // Only the photo takes + − 0 (not toolbars or action buttons); browser
    // shortcuts (page zoom Ctrl/⌘ + = − 0) stay the browser's.
    if (
      latestLocked.current ||
      !(
        event.target instanceof Node && frame.current?.contains(event.target)
      ) ||
      event.ctrlKey ||
      event.metaKey ||
      event.altKey
    )
      return;
    if (event.key === "+" || event.key === "=") changeZoom(zoom + ZOOM_STEP);
    else if (event.key === "-" || event.key === "_")
      changeZoom(zoom - ZOOM_STEP);
    else if (event.key === "0") reset();
    else return;
    event.preventDefault();
  };
  const lockKeys = (event: KeyboardEvent<HTMLElement>) => {
    if (
      !event.key.startsWith("Arrow") ||
      !(event.target instanceof Node && frame.current?.contains(event.target))
    )
      return;
    // ⌘/Alt/Ctrl + arrows are the browser's (Back, page scroll): the
    // library would otherwise take them as an 8 px nudge.
    if (event.ctrlKey || event.metaKey || event.altKey) {
      event.stopPropagation();
      return;
    }
    // While saving, a focused crop area's arrow keys must not move the photo.
    if (latestLocked.current) {
      event.preventDefault();
      event.stopPropagation();
    }
  };
  return {
    frame,
    /** Remount key: changes when an interrupted gesture is ended. */
    surface,
    crop,
    zoom,
    area,
    /** A coarse (touch) pointer: hint copy. */
    coarse,
    pristine: zoom === 1 && crop.x === 0 && crop.y === 0,
    reset,
    /** Put on an element around the crop surface and its controls. */
    wrapperProps: { onKeyDown: keys, onKeyDownCapture: lockKeys },
    /** Put on the crop surface's own container. */
    frameProps: {
      ref: frame,
      onTouchCancel: endInterrupted,
      // The library's mousedown prevents focus: take it here so the keys
      // keep working after a toolbar click (mouse-only desktops).
      onPointerDownCapture: () => {
        if (latestLocked.current) return;
        frame.current
          ?.querySelector<HTMLElement>('[tabindex="0"]')
          ?.focus({ preventScroll: true });
      },
      onContextMenu: (event: { preventDefault: () => void }) =>
        event.preventDefault(),
    },
    /** Spread onto the Cropper; call `reportArea` from onCropAreaChange. */
    cropperProps: {
      crop,
      zoom,
      minZoom: 1,
      maxZoom: CROP_MAX_ZOOM,
      keyboardStep: 8,
      // User input is blocked while saving (touch, wheel, keys and
      // pointer-events); what still arrives is layout re-reporting.
      onCropChange: setCrop,
      onZoomChange: setZoom,
      onTouchRequest: () => !latestLocked.current,
      // Plain wheel and two-finger scroll keep scrolling the page; trackpad
      // pinch arrives with ctrlKey (Safari uses gesture events).
      onWheelRequest: (event: WheelEvent) =>
        !latestLocked.current && event.ctrlKey,
      onInteractionStart: () => {
        interacting.current = true;
      },
      onInteractionEnd: () => {
        interacting.current = false;
      },
    },
    reportArea: setArea,
  };
};

/** Hint copy for the crop surface, by pointer type. */
export const cropHint = (coarse: boolean) =>
  coarse
    ? "拖动照片调整位置，双指缩放。"
    : "拖动照片调整位置，双指缩放（鼠标可按住 Ctrl 滚动）。";

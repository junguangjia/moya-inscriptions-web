"use client";
import { useEffect, useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import type { Area } from "react-easy-crop";

export const CROP_MAX_ZOOM = 3;
const ZOOM_STEP = 0.1;

/**
 * Controls of the caller's own inside the crop frame (the phone stage's
 * corner handles, a framing slider): their keys and focus stay theirs.
 */
export const OWN_CONTROL = "[data-crop-own-control]";

const ownControl = (target: EventTarget | null) =>
  target instanceof Element && target.closest(OWN_CONTROL) !== null;

/**
 * Input for a react-easy-crop surface shared by the cover and avatar editors
 * (Owner decision, #171 r3/r4): drag to move and two-finger zoom (touch pinch
 * or trackpad pinch) with no zoom bar. Ctrl + wheel and the + − 0 keys are
 * fallbacks for mouse and keyboard; browser shortcuts stay the browser's.
 */
export const useCropGestures = ({
  locked,
  autoFocus = false,
  frozen = false,
  maxZoom = CROP_MAX_ZOOM,
  keepControlFocus = false,
}: {
  /** Saving: user input is blocked; layout re-reports still apply. */
  locked: boolean;
  /** Focus the crop area once the photo is laid out. */
  autoFocus?: boolean;
  /**
   * The caller has the frame for a moment (a corner handle drag, a framing
   * tool): touch, mouse, wheel, Safari's gestures and keys reach the photo
   * no more. Unlike `locked`, the crop area stays focusable.
   */
  frozen?: boolean;
  /** How far zoom goes (a small stored crop may need more than the shared 3×). */
  maxZoom?: number;
  /**
   * A press on a button or an own control inside the frame keeps its focus
   * instead of handing it to the crop area.
   */
  keepControlFocus?: boolean;
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
    latestLocked = useRef(locked),
    latestFrozen = useRef(frozen),
    latestMaxZoom = useRef(maxZoom);
  latestLocked.current = locked;
  latestFrozen.current = frozen;
  latestMaxZoom.current = maxZoom;
  /** Nothing the author does reaches the photo. */
  const blocked = () => latestLocked.current || latestFrozen.current;
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
    // A corner handle is drawn over the frame but is not the library's.
    const outside = (event: TouchEvent) => {
      if (
        frame.current &&
        event.target instanceof Node &&
        (!frame.current.contains(event.target) ||
          (event.target instanceof Element &&
            event.target.closest("[data-crop-handle]") !== null))
      )
        endInterrupted();
    };
    // Safari's own pinch reaches the library as gesture events on its
    // container: a frozen frame takes them first.
    const node = frame.current;
    const gesture = (event: Event) => {
      if (!latestFrozen.current) return;
      event.preventDefault();
      event.stopPropagation();
    };
    node?.addEventListener("gesturestart", gesture, { capture: true });
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
      node?.removeEventListener("gesturestart", gesture, { capture: true });
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
    if (blocked()) return;
    setZoom(Math.min(latestMaxZoom.current, Math.max(1, value)));
  };
  /** Back to the centre at zoom 1, whatever the author's input may do now. */
  const restart = () => {
    setCrop({ x: 0, y: 0 });
    setZoom(1);
  };
  const reset = () => {
    if (blocked()) return;
    restart();
  };
  const keys = (event: KeyboardEvent<HTMLElement>) => {
    // Only the photo takes + − 0 (not toolbars or action buttons); browser
    // shortcuts (page zoom Ctrl/⌘ + = − 0) stay the browser's.
    if (
      blocked() ||
      !(
        event.target instanceof Node && frame.current?.contains(event.target)
      ) ||
      ownControl(event.target) ||
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
      !(
        event.target instanceof Node && frame.current?.contains(event.target)
      ) ||
      ownControl(event.target)
    )
      return;
    // ⌘/Alt/Ctrl + arrows are the browser's (Back, page scroll): the
    // library would otherwise take them as an 8 px nudge.
    if (event.ctrlKey || event.metaKey || event.altKey) {
      event.stopPropagation();
      return;
    }
    // While saving or frozen, a focused crop area's arrow keys must not
    // move the photo.
    if (blocked()) {
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
    /** A new frame or aspect: centred at zoom 1 (not the author's input, so never blocked). */
    restart,
    /** Put on an element around the crop surface and its controls. */
    wrapperProps: { onKeyDown: keys, onKeyDownCapture: lockKeys },
    /** Put on the crop surface's own container. */
    frameProps: {
      ref: frame,
      onTouchCancel: endInterrupted,
      // The library's mousedown prevents focus: take it here so the keys
      // keep working after a toolbar click (mouse-only desktops).
      onPointerDownCapture: (event: { target: EventTarget | null }) => {
        if (latestLocked.current) return;
        if (
          keepControlFocus &&
          event.target instanceof Element &&
          event.target.closest(`button, ${OWN_CONTROL}`) !== null
        )
          return;
        frame.current
          ?.querySelector<HTMLElement>('[tabindex="0"]')
          ?.focus({ preventScroll: true });
      },
      // The library's own mousedown, while the frame is the caller's.
      onMouseDownCapture: (event: { stopPropagation: () => void }) => {
        if (latestFrozen.current) event.stopPropagation();
      },
      onContextMenu: (event: { preventDefault: () => void }) =>
        event.preventDefault(),
    },
    /** Spread onto the Cropper; call `reportArea` from onCropAreaChange. */
    cropperProps: {
      crop,
      zoom,
      minZoom: 1,
      maxZoom,
      keyboardStep: 8,
      // User input is blocked while saving or frozen (touch, wheel, keys and
      // pointer-events); what still arrives is layout re-reporting.
      onCropChange: setCrop,
      onZoomChange: setZoom,
      onTouchRequest: () => !blocked(),
      // Plain wheel and two-finger scroll keep scrolling the page; trackpad
      // pinch arrives with ctrlKey (Safari uses gesture events).
      onWheelRequest: (event: WheelEvent) => !blocked() && event.ctrlKey,
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

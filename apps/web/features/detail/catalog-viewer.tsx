"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { LivePhotoFrame } from "../publishing/ui/live/live-photo";
import styles from "./catalog-detail.module.css";

import type {
  CSSProperties,
  ReactNode,
  PointerEvent as ReactPointerEvent,
  WheelEvent as ReactWheelEvent,
} from "react";
import type { DetailMediaPresentation } from "./catalog-detail-presentation";
import type { PresentationPlatform } from "../shell/device-platform";

export const VIEWER_AXIS_LOCK_PX = 10;
export const VIEWER_SWIPE_DISTANCE_PX = 48;
export const VIEWER_FLING_PX_PER_MS = 0.55;
export const VIEWER_HORIZONTAL_RATIO = 1.25;
export const VIEWER_EDGE_RUBBER = 0.32;
export const VIEWER_SETTLE_MS = 220;
export const VIEWER_PAGER_HIDE_MS = 2000;

type ViewerAxis = "horizontal" | "pan" | "vertical" | null;

interface ViewerPoint {
  readonly x: number;
  readonly y: number;
}

interface ViewerGesture {
  axis: ViewerAxis;
  carouselOriginX: number;
  carouselX: number;
  didCarousel: boolean;
  readonly id: number;
  lastTime: number;
  lastX: number;
  readonly originX: number;
  readonly originY: number;
  readonly startTime: number;
  readonly startX: number;
  readonly startY: number;
}

interface ViewerTransform {
  readonly scale: number;
  readonly x: number;
  readonly y: number;
}

interface ViewerFit {
  readonly height: number;
  readonly maxScale: number;
  readonly stageHeight: number;
  readonly stageWidth: number;
  readonly width: number;
}

interface WheelGesture {
  accumulatedX: number;
  readonly atEnd: boolean;
  readonly atStart: boolean;
  readonly startedAt: number;
}

type ViewerImageStyle = CSSProperties & {
  readonly "--viewer-scale": number;
  readonly "--viewer-x": string;
  readonly "--viewer-y": string;
};

type ViewerTrackStyle = CSSProperties & {
  readonly "--viewer-carousel-x": string;
};

const FIT_TRANSFORM: ViewerTransform = { scale: 1, x: 0, y: 0 };

export const resolveViewerAxis = (
  horizontalDisplacement: number,
  verticalDisplacement: number,
): Exclude<ViewerAxis, "pan"> => {
  if (
    Math.hypot(horizontalDisplacement, verticalDisplacement) <
    VIEWER_AXIS_LOCK_PX
  ) {
    return null;
  }
  if (
    Math.abs(horizontalDisplacement) >
    Math.abs(verticalDisplacement) * VIEWER_HORIZONTAL_RATIO
  ) {
    return "horizontal";
  }
  if (
    Math.abs(verticalDisplacement) >
    Math.abs(horizontalDisplacement) * VIEWER_HORIZONTAL_RATIO
  ) {
    return "vertical";
  }
  return null;
};

export const shouldCommitViewerSwipe = (
  horizontalDisplacement: number,
  verticalDisplacement: number,
  width: number,
  velocity: number,
) =>
  Math.abs(horizontalDisplacement) > Math.abs(verticalDisplacement) &&
  (Math.abs(horizontalDisplacement) >=
    Math.max(VIEWER_SWIPE_DISTANCE_PX, width * 0.18) ||
    Math.abs(velocity) >= VIEWER_FLING_PX_PER_MS);

export const viewerFit = (
  mediaWidth: number,
  mediaHeight: number,
  stageWidth: number,
  stageHeight: number,
): ViewerFit => {
  const safeMediaWidth = Math.max(1, mediaWidth);
  const safeMediaHeight = Math.max(1, mediaHeight);
  const safeStageWidth = Math.max(1, stageWidth);
  const safeStageHeight = Math.max(1, stageHeight);
  const ratio = Math.min(
    safeStageWidth / safeMediaWidth,
    safeStageHeight / safeMediaHeight,
  );
  const width = safeMediaWidth * ratio;
  const height = safeMediaHeight * ratio;
  return {
    height,
    maxScale: Math.min(8, Math.max(4, safeMediaWidth / width)),
    stageHeight: safeStageHeight,
    stageWidth: safeStageWidth,
    width,
  };
};

export const viewerPanBounds = (fit: ViewerFit, scale: number) => ({
  x: Math.max(0, (fit.width * scale - fit.stageWidth) / 2),
  y: Math.max(0, (fit.height * scale - fit.stageHeight) / 2),
});

export const clampViewerTransform = (
  fit: ViewerFit,
  transform: ViewerTransform,
): ViewerTransform => {
  const scale = Math.min(fit.maxScale, Math.max(1, transform.scale));
  const bounds = viewerPanBounds(fit, scale);
  return {
    scale,
    x: Math.min(bounds.x, Math.max(-bounds.x, transform.x)),
    y: Math.min(bounds.y, Math.max(-bounds.y, transform.y)),
  };
};

export interface CatalogViewerProps {
  readonly controls?: ReactNode;
  readonly index: number;
  readonly media: readonly DetailMediaPresentation[];
  readonly onClose: () => void;
  readonly onIndexChange: (index: number) => void;
  readonly open: boolean;
  readonly platform: PresentationPlatform;
}

/** The Viewer shows the `full` derivative when the work carries one, else display. */
const viewerSrc = (item: DetailMediaPresentation): string =>
  item.fullSrc ?? item.src;

const viewerResourceKey = (item: DetailMediaPresentation): string =>
  JSON.stringify([item.id, viewerSrc(item)]);

export const CatalogViewer = ({
  index,
  media,
  onClose,
  onIndexChange,
  open,
  platform,
  controls,
}: CatalogViewerProps) => {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const pointersRef = useRef(new Map<number, ViewerPoint>());
  const gestureRef = useRef<ViewerGesture | null>(null);
  const pinchDistanceRef = useRef<number | null>(null);
  const didPinchRef = useRef(false);
  const movedRef = useRef(false);
  const transformRef = useRef<ViewerTransform>(FIT_TRANSFORM);
  const settleTimerRef = useRef<number | null>(null);
  const pagerTimerRef = useRef<number | null>(null);
  const wheelGestureRef = useRef<WheelGesture | null>(null);
  const wheelTimerRef = useRef<number | null>(null);
  const wheelIgnoreUntilRef = useRef(0);
  const [carouselX, setCarouselX] = useState(0);
  const [failedMediaKeys, setFailedMediaKeys] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [pagerVisible, setPagerVisible] = useState(false);
  const [settling, setSettling] = useState(false);
  const [transform, setTransform] = useState<ViewerTransform>(FIT_TRANSFORM);
  const active = media[index];

  const updateTransform = useCallback((next: ViewerTransform) => {
    transformRef.current = next;
    setTransform(next);
  }, []);

  const clearPagerTimer = useCallback(() => {
    if (pagerTimerRef.current === null) return;
    window.clearTimeout(pagerTimerRef.current);
    pagerTimerRef.current = null;
  }, []);

  const revealPager = useCallback(() => {
    setPagerVisible(true);
    clearPagerTimer();
    pagerTimerRef.current = window.setTimeout(() => {
      pagerTimerRef.current = null;
      setPagerVisible(false);
    }, VIEWER_PAGER_HIDE_MS);
  }, [clearPagerTimer]);

  const clearSettleTimer = useCallback(() => {
    if (settleTimerRef.current === null) return;
    window.clearTimeout(settleTimerRef.current);
    settleTimerRef.current = null;
  }, []);

  const clearWheelTimer = useCallback(() => {
    if (wheelTimerRef.current === null) return;
    window.clearTimeout(wheelTimerRef.current);
    wheelTimerRef.current = null;
  }, []);

  const resetTransform = useCallback(() => {
    updateTransform(FIT_TRANSFORM);
    pointersRef.current.clear();
    gestureRef.current = null;
    pinchDistanceRef.current = null;
    didPinchRef.current = false;
    movedRef.current = false;
  }, [updateTransform]);

  const currentFit = useCallback(() => {
    const stage = stageRef.current;
    if (active === undefined || stage === null) return null;
    const rectangle = stage.getBoundingClientRect();
    return viewerFit(
      active.width,
      active.height,
      stage.clientWidth || rectangle.width,
      stage.clientHeight || rectangle.height,
    );
  }, [active]);

  const zoomAt = (clientX: number, clientY: number, nextScale: number) => {
    const stage = stageRef.current;
    const fit = currentFit();
    if (stage === null || fit === null) return;
    const rectangle = stage.getBoundingClientRect();
    const current = transformRef.current;
    const scale = Math.min(fit.maxScale, Math.max(1, nextScale));
    const originX = clientX - rectangle.left - rectangle.width / 2;
    const originY = clientY - rectangle.top - rectangle.height / 2;
    const imageX = (originX - current.x) / current.scale;
    const imageY = (originY - current.y) / current.scale;
    updateTransform(
      clampViewerTransform(fit, {
        scale,
        x: originX - imageX * scale,
        y: originY - imageY * scale,
      }),
    );
  };

  const resetCarousel = useCallback(() => {
    clearSettleTimer();
    setCarouselX(0);
    setSettling(false);
  }, [clearSettleTimer]);

  const settleToIndex = (nextIndex: number) => {
    const bounded = Math.min(Math.max(nextIndex, 0), media.length - 1);
    if (bounded === index || settling) {
      setSettling(true);
      setCarouselX(0);
      settleTimerRef.current = window.setTimeout(() => {
        settleTimerRef.current = null;
        setSettling(false);
      }, VIEWER_SETTLE_MS);
      return;
    }
    const stage = stageRef.current;
    const width = Math.max(
      1,
      stage?.clientWidth ?? stage?.getBoundingClientRect().width ?? 1,
    );
    setSettling(true);
    setCarouselX(bounded > index ? -width : width);
    revealPager();
    const reducedMotion = window.matchMedia(
      "(prefers-reduced-motion: reduce)",
    ).matches;
    settleTimerRef.current = window.setTimeout(
      () => {
        settleTimerRef.current = null;
        onIndexChange(bounded);
        setCarouselX(0);
        setSettling(false);
        resetTransform();
      },
      reducedMotion ? 1 : VIEWER_SETTLE_MS,
    );
  };

  const finishWheelGesture = useCallback(() => {
    const gesture = wheelGestureRef.current;
    wheelGestureRef.current = null;
    clearWheelTimer();
    if (gesture === null) return;
    wheelIgnoreUntilRef.current = performance.now() + 180;
    const stage = stageRef.current;
    const width = Math.max(
      1,
      stage?.clientWidth ?? stage?.getBoundingClientRect().width ?? 1,
    );
    const dx = -gesture.accumulatedX;
    const elapsed = Math.max(16, performance.now() - gesture.startedAt);
    if (
      shouldCommitViewerSwipe(dx, 0, width, dx / elapsed) &&
      !((dx < 0 && gesture.atEnd) || (dx > 0 && gesture.atStart))
    ) {
      settleToIndex(index + (dx < 0 ? 1 : -1));
    } else {
      setSettling(true);
      setCarouselX(0);
      settleTimerRef.current = window.setTimeout(() => {
        settleTimerRef.current = null;
        setSettling(false);
      }, VIEWER_SETTLE_MS);
    }
    revealPager();
  }, [clearWheelTimer, index, revealPager]);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog === null) return;
    if (open && !dialog.open) {
      if (typeof dialog.showModal === "function") dialog.showModal();
      else dialog.setAttribute("open", "");
      window.requestAnimationFrame(() => dialog.focus());
    } else if (!open && dialog.open) {
      if (typeof dialog.close === "function") dialog.close();
      else dialog.removeAttribute("open");
    }
  }, [open]);

  useEffect(() => {
    resetTransform();
    resetCarousel();
    setPagerVisible(false);
  }, [active?.id, open, resetCarousel, resetTransform]);

  useEffect(() => {
    const currentKeys = new Set(media.map(viewerResourceKey));
    setFailedMediaKeys((present) => {
      if ([...present].every((key) => currentKeys.has(key))) return present;
      return new Set([...present].filter((key) => currentKeys.has(key)));
    });
  }, [media]);

  useEffect(() => {
    if (!open) return;
    for (const candidate of [media[index - 1], media[index + 1]]) {
      if (candidate === undefined) continue;
      const preload = new Image();
      preload.src = viewerSrc(candidate);
    }
  }, [index, media, open]);

  useEffect(() => {
    if (!open) return;
    const handleResize = () => {
      resetTransform();
      resetCarousel();
    };
    window.addEventListener("orientationchange", handleResize);
    window.addEventListener("resize", handleResize);
    return () => {
      window.removeEventListener("orientationchange", handleResize);
      window.removeEventListener("resize", handleResize);
    };
  }, [open, resetCarousel, resetTransform]);

  useEffect(
    () => () => {
      clearPagerTimer();
      clearSettleTimer();
      clearWheelTimer();
    },
    [clearPagerTimer, clearSettleTimer, clearWheelTimer],
  );

  const pointerDistance = () => {
    const [first, second] = [...pointersRef.current.values()];
    if (first === undefined || second === undefined) return 0;
    return Math.hypot(second.x - first.x, second.y - first.y);
  };

  const handlePointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (
      event.target instanceof Element &&
      event.target.closest("[data-detail-viewer-control]") !== null
    ) {
      return;
    }
    event.preventDefault();
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      // Synthetic pointers may not support capture.
    }
    pointersRef.current.set(event.pointerId, {
      x: event.clientX,
      y: event.clientY,
    });
    if (pointersRef.current.size >= 2) {
      didPinchRef.current = true;
      pinchDistanceRef.current = Math.max(1, pointerDistance());
      gestureRef.current = null;
      return;
    }
    const current = transformRef.current;
    gestureRef.current = {
      axis: null,
      carouselOriginX: 0,
      carouselX: 0,
      didCarousel: false,
      id: event.pointerId,
      lastTime: event.timeStamp,
      lastX: event.clientX,
      originX: current.x,
      originY: current.y,
      startTime: event.timeStamp,
      startX: event.clientX,
      startY: event.clientY,
    };
    movedRef.current = false;
  };

  const handlePointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!pointersRef.current.has(event.pointerId)) return;
    event.preventDefault();
    pointersRef.current.set(event.pointerId, {
      x: event.clientX,
      y: event.clientY,
    });
    if (pointersRef.current.size >= 2 && pinchDistanceRef.current !== null) {
      const points = [...pointersRef.current.values()];
      const distance = Math.max(1, pointerDistance());
      const midpointX = (points[0]!.x + points[1]!.x) / 2;
      const midpointY = (points[0]!.y + points[1]!.y) / 2;
      zoomAt(
        midpointX,
        midpointY,
        transformRef.current.scale * (distance / pinchDistanceRef.current),
      );
      pinchDistanceRef.current = distance;
      movedRef.current = true;
      return;
    }
    const gesture = gestureRef.current;
    if (gesture === null || gesture.id !== event.pointerId) return;
    const dx = event.clientX - gesture.startX;
    const dy = event.clientY - gesture.startY;
    if (Math.hypot(dx, dy) > VIEWER_AXIS_LOCK_PX) movedRef.current = true;
    const current = transformRef.current;
    const fit = currentFit();
    if (fit === null) return;
    const zoomed = current.scale > 1.05;
    if (gesture.axis === null) {
      if (zoomed) {
        const bounds = viewerPanBounds(fit, current.scale);
        const axis = resolveViewerAxis(dx, dy);
        const atLeft = current.x >= bounds.x - 1;
        const atRight = current.x <= -bounds.x + 1;
        const canPage =
          axis === "horizontal" && ((dx < 0 && atRight) || (dx > 0 && atLeft));
        if (canPage) gesture.axis = "horizontal";
        else if (Math.hypot(dx, dy) >= VIEWER_AXIS_LOCK_PX) {
          gesture.axis = "pan";
        }
      } else {
        gesture.axis = resolveViewerAxis(dx, dy);
      }
    }
    gesture.lastTime = event.timeStamp;
    gesture.lastX = event.clientX;
    if (gesture.axis === "horizontal" || gesture.didCarousel) {
      gesture.didCarousel = true;
      const pageDx = dx - gesture.carouselOriginX;
      const atStart = index === 0;
      const atEnd = index === media.length - 1;
      gesture.carouselX =
        (pageDx > 0 && atStart) || (pageDx < 0 && atEnd)
          ? pageDx * VIEWER_EDGE_RUBBER
          : pageDx;
      setCarouselX(gesture.carouselX);
      revealPager();
      return;
    }
    if (!zoomed || gesture.axis !== "pan") return;
    const next = clampViewerTransform(fit, {
      scale: current.scale,
      x: gesture.originX + dx,
      y: gesture.originY + dy,
    });
    updateTransform(next);
    const bounds = viewerPanBounds(fit, next.scale);
    const atLeft = next.x >= bounds.x - 0.5;
    const atRight = next.x <= -bounds.x + 0.5;
    if (
      resolveViewerAxis(dx, dy) === "horizontal" &&
      ((dx < 0 && atRight) || (dx > 0 && atLeft))
    ) {
      gesture.axis = "horizontal";
      gesture.didCarousel = true;
      const unclampedX = gesture.originX + dx;
      const extra = unclampedX - next.x;
      gesture.carouselOriginX = dx - extra;
      gesture.carouselX =
        (extra > 0 && index === 0) || (extra < 0 && index === media.length - 1)
          ? extra * VIEWER_EDGE_RUBBER
          : extra;
      setCarouselX(gesture.carouselX);
      revealPager();
    }
  };

  const releasePointer = (event: ReactPointerEvent<HTMLDivElement>) => {
    try {
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
    } catch {
      // Interrupted pointers may already have released capture.
    }
  };

  const handlePointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!pointersRef.current.has(event.pointerId)) return;
    const gesture = gestureRef.current;
    pointersRef.current.delete(event.pointerId);
    releasePointer(event);
    if (pointersRef.current.size > 0) return;
    const didPinch = didPinchRef.current;
    pinchDistanceRef.current = null;
    didPinchRef.current = false;
    gestureRef.current = null;
    if (didPinch) {
      setCarouselX(0);
      return;
    }
    if (gesture !== null) {
      const dx = gesture.didCarousel
        ? gesture.carouselX
        : event.clientX - gesture.startX;
      const dy = event.clientY - gesture.startY;
      const recentTime = Math.max(1, event.timeStamp - gesture.lastTime);
      const recentVelocity = (event.clientX - gesture.lastX) / recentTime;
      const totalVelocity =
        dx / Math.max(16, event.timeStamp - gesture.startTime);
      const stage = stageRef.current;
      const width = Math.max(
        1,
        stage?.clientWidth ?? stage?.getBoundingClientRect().width ?? 1,
      );
      if (
        gesture.didCarousel &&
        shouldCommitViewerSwipe(
          dx,
          dy,
          width,
          Math.abs(recentVelocity) > 0.01 ? recentVelocity : totalVelocity,
        ) &&
        !((dx < 0 && index === media.length - 1) || (dx > 0 && index === 0))
      ) {
        settleToIndex(index + (dx < 0 ? 1 : -1));
        return;
      }
      if (gesture.didCarousel) {
        setSettling(true);
        setCarouselX(0);
        settleTimerRef.current = window.setTimeout(() => {
          settleTimerRef.current = null;
          setSettling(false);
        }, VIEWER_SETTLE_MS);
      }
      if (
        movedRef.current ||
        Math.hypot(
          event.clientX - gesture.startX,
          event.clientY - gesture.startY,
        ) > VIEWER_AXIS_LOCK_PX
      ) {
        return;
      }
    }
    onClose();
  };

  const cancelPointer = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!pointersRef.current.has(event.pointerId)) return;
    pointersRef.current.clear();
    gestureRef.current = null;
    pinchDistanceRef.current = null;
    didPinchRef.current = false;
    movedRef.current = true;
    setCarouselX(0);
    setSettling(false);
    releasePointer(event);
  };

  const handleWheel = (event: ReactWheelEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.stopPropagation();
    const pinchZoom = event.ctrlKey || event.metaKey;
    const mouseWheel =
      event.deltaMode !== 0 ||
      (Math.abs(event.deltaY) >= 40 && Math.abs(event.deltaX) < 1);
    if (pinchZoom || mouseWheel) {
      if (wheelGestureRef.current !== null) finishWheelGesture();
      const factor = pinchZoom
        ? Math.exp(-event.deltaY * 0.01)
        : event.deltaY < 0
          ? 1.08
          : 1 / 1.08;
      zoomAt(event.clientX, event.clientY, transformRef.current.scale * factor);
      return;
    }
    const fit = currentFit();
    if (fit === null) return;
    const current = transformRef.current;
    const horizontal =
      Math.abs(event.deltaX) > Math.abs(event.deltaY) * VIEWER_HORIZONTAL_RATIO;
    if (current.scale > 1.05 && wheelGestureRef.current === null) {
      const bounds = viewerPanBounds(fit, current.scale);
      const atLeft = current.x >= bounds.x - 1;
      const atRight = current.x <= -bounds.x + 1;
      const atEdge = event.deltaX > 0 ? atRight : atLeft;
      if (!horizontal || !atEdge) {
        updateTransform(
          clampViewerTransform(fit, {
            scale: current.scale,
            x: current.x - event.deltaX,
            y: current.y - event.deltaY,
          }),
        );
        return;
      }
    }
    if (!horizontal || media.length <= 1) return;
    if (performance.now() < wheelIgnoreUntilRef.current) return;
    if (wheelGestureRef.current === null) {
      wheelGestureRef.current = {
        accumulatedX: 0,
        atEnd: index === media.length - 1,
        atStart: index === 0,
        startedAt: performance.now(),
      };
    }
    const gesture = wheelGestureRef.current;
    gesture.accumulatedX += event.deltaX;
    const dx = -gesture.accumulatedX;
    setCarouselX(
      (dx > 0 && gesture.atStart) || (dx < 0 && gesture.atEnd)
        ? dx * VIEWER_EDGE_RUBBER
        : dx,
    );
    revealPager();
    clearWheelTimer();
    wheelTimerRef.current = window.setTimeout(finishWheelGesture, 24);
  };

  const imageStyle: ViewerImageStyle = {
    "--viewer-scale": transform.scale,
    "--viewer-x": `${transform.x}px`,
    "--viewer-y": `${transform.y}px`,
  };
  const trackStyle: ViewerTrackStyle = {
    "--viewer-carousel-x": `${carouselX}px`,
  };
  const peers = [media[index - 1], active, media[index + 1]] as const;

  return (
    <dialog
      aria-label="图像查看"
      aria-modal="true"
      className={styles.viewer}
      data-detail-viewer=""
      data-platform={platform}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClose={() => {
        if (open) onClose();
      }}
      onKeyDown={(event) => {
        if (event.key === "ArrowLeft") {
          event.preventDefault();
          settleToIndex(index - 1);
        } else if (event.key === "ArrowRight") {
          event.preventDefault();
          settleToIndex(index + 1);
        } else if (event.key === "Escape") {
          event.preventDefault();
          onClose();
        }
      }}
      ref={dialogRef}
      tabIndex={-1}
    >
      <div
        className={styles.viewerStage}
        data-active-live={active?.live === undefined ? undefined : "true"}
        data-viewer-scale={transform.scale > 1.05 ? "zoomed" : "fit"}
        onLostPointerCapture={cancelPointer}
        onPointerCancel={cancelPointer}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onWheel={handleWheel}
        ref={stageRef}
      >
        <div
          className={styles.viewerTrack}
          data-dragging={carouselX === 0 ? undefined : "true"}
          data-settling={settling ? "true" : undefined}
          data-detail-viewer-track=""
          style={trackStyle}
        >
          {peers.map((item, peerIndex) => {
            const current = peerIndex === 1;
            const failed =
              item === undefined ||
              failedMediaKeys.has(viewerResourceKey(item));
            const still =
              item === undefined || failed ? null : (
                <img
                  alt={item.alt}
                  className={
                    current ? styles.viewerImage : styles.viewerPeerImage
                  }
                  data-detail-viewer-image={current ? "" : undefined}
                  draggable={false}
                  height={item.height}
                  key={viewerResourceKey(item)}
                  onError={(event) => {
                    const image = event.currentTarget;
                    if (
                      !image.isConnected ||
                      image.getAttribute("src") !== viewerSrc(item)
                    )
                      return;
                    const key = viewerResourceKey(item);
                    setFailedMediaKeys((present) =>
                      present.has(key) ? present : new Set(present).add(key),
                    );
                  }}
                  src={viewerSrc(item)}
                  style={current ? imageStyle : undefined}
                  width={item.width}
                />
              );
            return (
              <div
                aria-hidden={!current}
                className={styles.viewerSlide}
                inert={!current || undefined}
                key={item?.id ?? `empty-${peerIndex}`}
              >
                {item === undefined ? null : failed ? (
                  <div
                    className={styles.viewerMediaError}
                    data-detail-viewer-media-state="failed"
                    role="status"
                  >
                    图像无法加载
                  </div>
                ) : item.live === undefined ? (
                  still
                ) : (
                  <LivePhotoFrame
                    active={current && open}
                    className={styles.viewerLiveFrame}
                    controlAttributes={{ "data-detail-viewer-control": "" }}
                    motion={item.live}
                    videoClassName={
                      current ? styles.viewerImage : styles.viewerPeerImage
                    }
                    videoStyle={current ? imageStyle : undefined}
                  >
                    {still}
                  </LivePhotoFrame>
                )}
              </div>
            );
          })}
        </div>

        {media.length > 1 ? (
          <>
            <span
              aria-live="polite"
              className={styles.viewerCounter}
              data-detail-viewer-index=""
              data-visible={pagerVisible ? "true" : "false"}
            >
              {index + 1} / {media.length}
            </span>
            <button
              aria-label="上一张图像"
              className={`${styles.viewerEdge} ${styles.viewerEdgePrevious}`}
              data-detail-viewer-control=""
              disabled={index === 0 || transform.scale > 1.05}
              onClick={() => settleToIndex(index - 1)}
              type="button"
            />
            <button
              aria-label="下一张图像"
              className={`${styles.viewerEdge} ${styles.viewerEdgeNext}`}
              data-detail-viewer-control=""
              disabled={index === media.length - 1 || transform.scale > 1.05}
              onClick={() => settleToIndex(index + 1)}
              type="button"
            />
          </>
        ) : null}
      </div>
      {media.length > 1 ? (
        <div
          aria-label="选择查看图像"
          className={styles.viewerDots}
          data-detail-viewer-control=""
          role="group"
        >
          {media.map((item, dotIndex) => (
            <button
              aria-current={dotIndex === index ? "true" : undefined}
              aria-label={`第 ${dotIndex + 1} 张图像：${item.alt}`}
              data-active={dotIndex === index ? "true" : "false"}
              key={item.id}
              onClick={() => settleToIndex(dotIndex)}
              type="button"
            />
          ))}
        </div>
      ) : null}
      {controls}
    </dialog>
  );
};

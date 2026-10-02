"use client";

import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import type { CSSProperties, KeyboardEvent, PointerEvent } from "react";
import Cropper from "react-easy-crop";
import "react-easy-crop/react-easy-crop.css";
import type { MediaCrop } from "@moya/contracts";
import type { DetailMediaPresentation } from "../../detail/catalog-detail-presentation";
import { useCropGestures } from "../../authors/crop-gestures";
import {
  cropFromPercentages,
  cropRatio,
  CROP_MINIMUM,
  percentagesFromCrop,
} from "../../publishing/ui/media/media-geometry";
import {
  FULL_ARTICLE_CROP,
  centeredCropWindow,
  cropCornerPoint,
  moveArticleCrop,
  normalizedCropPoint,
  normalizedPointerRect,
  resizeArticleCrop,
} from "./article-free-crop-geometry";
import type {
  CropBounds,
  CropCorner,
  CropPoint,
} from "./article-free-crop-geometry";
import styles from "./article-free-crop.module.css";

const corners: readonly CropCorner[] = ["nw", "ne", "sw", "se"];
const cornerLabels: Record<CropCorner, string> = {
  nw: "调整裁剪左上角",
  ne: "调整裁剪右上角",
  sw: "调整裁剪左下角",
  se: "调整裁剪右下角",
};
const placement = (crop: MediaCrop): CSSProperties => ({
  left: `${crop.x * 100}%`,
  top: `${crop.y * 100}%`,
  width: `${crop.width * 100}%`,
  height: `${crop.height * 100}%`,
});
const capture = (element: HTMLElement, id: number) => {
  if (typeof element.setPointerCapture === "function") {
    try {
      element.setPointerCapture(id);
    } catch {
      // A system-cancelled pointer is already handled by the cancel fence.
    }
  }
};
const release = (element: HTMLElement, id: number) => {
  if (element.hasPointerCapture?.(id)) element.releasePointerCapture(id);
};
const arrowDelta = (event: KeyboardEvent): CropPoint | null => {
  if (event.altKey || event.ctrlKey || event.metaKey) return null;
  const step = event.shiftKey ? 0.05 : 0.01;
  switch (event.key) {
    case "ArrowLeft":
      return { x: -step, y: 0 };
    case "ArrowRight":
      return { x: step, y: 0 };
    case "ArrowUp":
      return { x: 0, y: -step };
    case "ArrowDown":
      return { x: 0, y: step };
    default:
      return null;
  }
};

export const ArticleFreeCrop = ({
  media,
  crop,
  onChange,
}: {
  readonly media: DetailMediaPresentation;
  readonly crop: MediaCrop | null;
  readonly onChange: (crop: MediaCrop | null) => void;
}) => {
  const [coarse] = useState(
    () =>
      typeof window !== "undefined" &&
      (window.matchMedia?.("(pointer: coarse)").matches ?? false),
  );
  return coarse ? (
    <TouchCrop media={media} crop={crop} onChange={onChange} />
  ) : (
    <PointerCrop media={media} crop={crop} onChange={onChange} />
  );
};

interface RectangleGesture {
  readonly id: number;
  readonly mode: "draw" | "move" | CropCorner;
  readonly start: CropPoint;
  readonly bounds: CropBounds;
  readonly before: MediaCrop | null;
}

const PointerCrop = ({
  media,
  crop,
  onChange,
}: {
  readonly media: DetailMediaPresentation;
  readonly crop: MediaCrop | null;
  readonly onChange: (crop: MediaCrop | null) => void;
}) => {
  const frame = useRef<HTMLDivElement>(null);
  const gesture = useRef<RectangleGesture | null>(null);
  const latest = useRef({ crop, onChange });
  latest.current = { crop, onChange };
  const hint = useId();
  const cancel = () => {
    const current = gesture.current;
    gesture.current = null;
    if (current) {
      latest.current.onChange(current.before);
      if (frame.current) release(frame.current, current.id);
    }
  };
  useEffect(() => {
    const hidden = () => {
      if (document.visibilityState === "hidden") cancel();
    };
    window.addEventListener("blur", cancel);
    document.addEventListener("visibilitychange", hidden);
    return () => {
      gesture.current = null;
      window.removeEventListener("blur", cancel);
      document.removeEventListener("visibilitychange", hidden);
    };
  }, []);
  const start = (event: PointerEvent, mode: RectangleGesture["mode"]) => {
    if (event.button !== 0 || !event.isPrimary || !frame.current) return;
    const bounds = frame.current.getBoundingClientRect();
    const point = normalizedCropPoint(event.clientX, event.clientY, bounds);
    if (!point) return;
    event.preventDefault();
    event.stopPropagation();
    frame.current.focus({ preventScroll: true });
    gesture.current = {
      id: event.pointerId,
      mode,
      bounds,
      start: point,
      before: latest.current.crop,
    };
    capture(frame.current, event.pointerId);
  };
  const move = (event: PointerEvent) => {
    const current = gesture.current;
    if (!current || current.id !== event.pointerId) return;
    const point = normalizedCropPoint(
      event.clientX,
      event.clientY,
      current.bounds,
    );
    if (!point) return;
    event.preventDefault();
    if (
      current.mode === "draw" &&
      Math.hypot(
        (point.x - current.start.x) * current.bounds.width,
        (point.y - current.start.y) * current.bounds.height,
      ) < 3
    )
      return;
    const before = current.before ?? FULL_ARTICLE_CROP;
    latest.current.onChange(
      current.mode === "draw"
        ? normalizedPointerRect(current.start, point)
        : current.mode === "move"
          ? moveArticleCrop(before, {
              x: point.x - current.start.x,
              y: point.y - current.start.y,
            })
          : resizeArticleCrop(before, current.mode, {
              x:
                cropCornerPoint(before, current.mode).x +
                point.x -
                current.start.x,
              y:
                cropCornerPoint(before, current.mode).y +
                point.y -
                current.start.y,
            }),
    );
  };
  const finish = (event: PointerEvent) => {
    const current = gesture.current;
    if (!current || current.id !== event.pointerId) return;
    // The release position also works when the browser coalesced move events.
    move(event);
    // A click without a drag leaves the current selection unchanged.
    gesture.current = null;
    if (frame.current) release(frame.current, current.id);
  };
  const shown = crop ?? FULL_ARTICLE_CROP;
  return (
    <>
      <div
        ref={frame}
        className={styles.pointerFrame}
        style={
          {
            aspectRatio: media.width / media.height,
            "--article-crop-aspect": media.width / media.height,
          } as CSSProperties
        }
        data-article-pointer-crop=""
        data-dialog-initial-focus=""
        tabIndex={0}
        role="group"
        aria-label="框选图片显示范围"
        aria-describedby={hint}
        onPointerDown={(event) => start(event, "draw")}
        onPointerMove={move}
        onPointerUp={finish}
        onPointerCancel={cancel}
        onLostPointerCapture={cancel}
        onKeyDown={(event) => {
          if (event.target !== event.currentTarget) return;
          const delta = arrowDelta(event);
          if (!delta) return;
          event.preventDefault();
          onChange(moveArticleCrop(shown, delta));
        }}
      >
        <img
          src={media.fullSrc ?? media.src}
          alt={media.alt}
          draggable={false}
        />
        <div
          className={styles.rectangle}
          style={{
            ...placement(shown),
            pointerEvents: crop === null ? "none" : "auto",
          }}
          data-article-crop-rectangle=""
          onPointerDown={(event) => start(event, "move")}
        >
          {corners.map((corner) => (
            <button
              key={corner}
              type="button"
              className={styles.corner}
              data-corner={corner}
              aria-label={cornerLabels[corner]}
              onPointerDown={(event) => start(event, corner)}
              onKeyDown={(event) => {
                const delta = arrowDelta(event);
                if (!delta) return;
                event.preventDefault();
                event.stopPropagation();
                const point = cropCornerPoint(shown, corner);
                onChange(
                  resizeArticleCrop(shown, corner, {
                    x: point.x + delta.x,
                    y: point.y + delta.y,
                  }),
                );
              }}
            >
              <span aria-hidden="true" />
            </button>
          ))}
        </div>
      </div>
      <p className={styles.hint} id={hint}>
        在原图上拖动框选；拖动选框移动范围，四角可自由调整。方向键微调，Shift
        加速。
      </p>
    </>
  );
};

/** The existing avatar/banner gestures, with a freely resizable crop window. */
const TouchCrop = ({
  media,
  crop,
  onChange,
}: {
  readonly media: DetailMediaPresentation;
  readonly crop: MediaCrop | null;
  readonly onChange: (crop: MediaCrop | null) => void;
}) => {
  const gestures = useCropGestures({ locked: false, autoFocus: true });
  const [seed] = useState(crop);
  const [viewport, setViewport] = useState<{
    width: number;
    height: number;
  } | null>(null);
  const [windowFraction, setWindowFraction] = useState<MediaCrop | null>(null);
  const latest = useRef({ crop, onChange, gestures });
  latest.current = { crop, onChange, gestures };
  const active = useRef(false);
  const pendingIntent = useRef(false);
  const resizing = useRef<{
    id: number;
    corner: CropCorner;
    start: CropPoint;
    windowStart: MediaCrop;
    bounds: CropBounds;
    before: MediaCrop | null;
    windowBefore: MediaCrop | null;
  } | null>(null);
  const hint = useId();
  useLayoutEffect(() => {
    const frame = gestures.frame.current;
    if (!frame) return;
    const measure = () => {
      const { width, height } = frame.getBoundingClientRect();
      if (!(width > 0 && height > 0)) return;
      pendingIntent.current = false;
      setViewport((old) =>
        old?.width === width && old.height === height ? old : { width, height },
      );
    };
    measure();
    if (typeof ResizeObserver !== "function") return;
    const observer = new ResizeObserver(measure);
    observer.observe(frame);
    return () => observer.disconnect();
  }, [gestures.frame]);
  const ratio = cropRatio(seed, media);
  // Keep existing small regions representable; this changes only Article's
  // crop surface, while avatar/banner retain their current zoom limit.
  const maxZoom = Math.min(
    1 / CROP_MINIMUM,
    Math.max(3, 1 / (seed?.width ?? 1), 1 / (seed?.height ?? 1)),
  );
  const fitted =
    viewport === null
      ? null
      : (() => {
          const width = Math.min(viewport.width, viewport.height * ratio);
          return centeredCropWindow(width, width / ratio, viewport);
        })();
  const windowCrop = windowFraction ?? fitted;
  const cropSize =
    windowCrop === null || viewport === null
      ? undefined
      : {
          width: windowCrop.width * viewport.width,
          height: windowCrop.height * viewport.height,
        };
  const resizeCancel = () => {
    const current = resizing.current;
    resizing.current = null;
    if (!current) return;
    pendingIntent.current = false;
    setWindowFraction(current.windowBefore);
    latest.current.onChange(current.before);
    if (gestures.frame.current) release(gestures.frame.current, current.id);
  };
  const endInterruptedInput = () => {
    active.current = false;
    pendingIntent.current = false;
    resizeCancel();
  };
  useEffect(() => {
    const hidden = () => {
      if (document.visibilityState === "hidden") endInterruptedInput();
    };
    const outside = (event: TouchEvent) => {
      if (
        gestures.frame.current &&
        event.target instanceof Node &&
        !gestures.frame.current.contains(event.target)
      )
        endInterruptedInput();
    };
    window.addEventListener("blur", endInterruptedInput);
    document.addEventListener("visibilitychange", hidden);
    document.addEventListener("touchstart", outside, {
      capture: true,
      passive: true,
    });
    return () => {
      resizing.current = null;
      window.removeEventListener("blur", endInterruptedInput);
      document.removeEventListener("visibilitychange", hidden);
      document.removeEventListener("touchstart", outside, { capture: true });
    };
  }, []);
  useEffect(() => {
    active.current = false;
    pendingIntent.current = false;
  }, [gestures.surface]);
  return (
    <div
      {...gestures.wrapperProps}
      onKeyDown={(event) => {
        if (
          event.target instanceof Node &&
          gestures.frame.current?.contains(event.target) &&
          !event.altKey &&
          !event.ctrlKey &&
          !event.metaKey
        ) {
          if (["+", "=", "-", "_"].includes(event.key)) {
            const zoom = Math.max(
              1,
              Math.min(
                maxZoom,
                gestures.zoom + (["+", "="].includes(event.key) ? 0.1 : -0.1),
              ),
            );
            if (zoom !== gestures.zoom) pendingIntent.current = true;
            gestures.cropperProps.onZoomChange(zoom);
            event.preventDefault();
            return;
          }
          if (event.key === "0" && !gestures.pristine)
            pendingIntent.current = true;
        }
        gestures.wrapperProps.onKeyDown(event);
      }}
    >
      <div
        className={styles.touchFrame}
        {...gestures.frameProps}
        onTouchCancel={() => {
          endInterruptedInput();
          gestures.frameProps.onTouchCancel();
        }}
        data-article-touch-crop=""
        onPointerMove={(event) => {
          const current = resizing.current;
          if (!current || current.id !== event.pointerId || !viewport) return;
          const point = normalizedCropPoint(
            event.clientX,
            event.clientY,
            current.bounds,
          );
          if (!point) return;
          event.preventDefault();
          pendingIntent.current = true;
          const anchor = cropCornerPoint(current.windowStart, current.corner);
          const x = anchor.x + point.x - current.start.x;
          const y = anchor.y + point.y - current.start.y;
          // Keep the viewport window centered, as in avatar/banner cropping.
          // Its width and height are independent, so the author controls ratio.
          setWindowFraction(
            centeredCropWindow(
              Math.max(
                44,
                (current.corner.endsWith("w") ? 0.5 - x : x - 0.5) *
                  current.bounds.width *
                  2,
              ),
              Math.max(
                44,
                (current.corner.startsWith("n") ? 0.5 - y : y - 0.5) *
                  current.bounds.height *
                  2,
              ),
              viewport,
            ),
          );
        }}
        onPointerUp={(event) => {
          const current = resizing.current;
          if (!current || current.id !== event.pointerId) return;
          resizing.current = null;
          if (gestures.frame.current)
            release(gestures.frame.current, current.id);
        }}
        onPointerCancel={resizeCancel}
        onLostPointerCapture={resizeCancel}
      >
        <Cropper
          key={gestures.surface}
          image={media.fullSrc ?? media.src}
          {...gestures.cropperProps}
          maxZoom={maxZoom}
          rotation={0}
          aspect={ratio}
          {...(cropSize === undefined ? {} : { cropSize })}
          {...(seed === null
            ? {}
            : { initialCroppedAreaPercentages: percentagesFromCrop(seed) })}
          objectFit="contain"
          showGrid
          disableAutomaticStylesInjection
          classes={{ cropAreaClassName: styles.touchArea ?? "" }}
          cropperProps={{
            tabIndex: 0,
            "aria-label": "拖动照片调整裁剪范围，双指缩放",
            "aria-describedby": hint,
          }}
          mediaProps={{ alt: media.alt, draggable: false }}
          onCropChange={(point) => {
            if (
              active.current &&
              (point.x !== gestures.crop.x || point.y !== gestures.crop.y)
            )
              pendingIntent.current = true;
            gestures.cropperProps.onCropChange(point);
          }}
          onZoomChange={(zoom) => {
            if (active.current && zoom !== gestures.zoom)
              pendingIntent.current = true;
            gestures.cropperProps.onZoomChange(zoom);
          }}
          onInteractionStart={() => {
            active.current = true;
            gestures.cropperProps.onInteractionStart();
          }}
          onInteractionEnd={() => {
            active.current = false;
            gestures.cropperProps.onInteractionEnd();
          }}
          onWheelRequest={(event) => {
            const allowed = gestures.cropperProps.onWheelRequest(event);
            if (allowed) active.current = true;
            return allowed;
          }}
          onCropAreaChange={(area) => {
            gestures.reportArea(area);
            // Mount, reseeding, interrupted gesture and viewport reports do not
            // become an edit merely because the cropper measured its window.
            if (!pendingIntent.current) return;
            pendingIntent.current = false;
            onChange(cropFromPercentages(area));
          }}
        />
        {windowCrop === null ? null : (
          <div className={styles.touchHandles} style={placement(windowCrop)}>
            {corners.map((corner) => (
              <button
                key={corner}
                className={styles.corner}
                data-corner={corner}
                type="button"
                aria-label={cornerLabels[corner]}
                onPointerDown={(event) => {
                  const frame = gestures.frame.current;
                  if (!frame || !event.isPrimary || event.button !== 0) return;
                  event.preventDefault();
                  event.stopPropagation();
                  const bounds = frame.getBoundingClientRect();
                  const start = normalizedCropPoint(
                    event.clientX,
                    event.clientY,
                    bounds,
                  );
                  if (!start || !windowCrop) return;
                  resizing.current = {
                    id: event.pointerId,
                    corner,
                    start,
                    windowStart: windowCrop,
                    bounds,
                    before: latest.current.crop,
                    windowBefore: windowFraction,
                  };
                  capture(frame, event.pointerId);
                }}
                onKeyDown={(event) => {
                  const delta = arrowDelta(event);
                  if (!delta || !viewport || !windowCrop) return;
                  event.preventDefault();
                  event.stopPropagation();
                  pendingIntent.current = true;
                  const point = cropCornerPoint(windowCrop, corner);
                  setWindowFraction(
                    centeredCropWindow(
                      Math.max(
                        44,
                        (corner.endsWith("w")
                          ? 0.5 - point.x - delta.x
                          : point.x + delta.x - 0.5) *
                          viewport.width *
                          2,
                      ),
                      Math.max(
                        44,
                        (corner.startsWith("n")
                          ? 0.5 - point.y - delta.y
                          : point.y + delta.y - 0.5) *
                          viewport.height *
                          2,
                      ),
                      viewport,
                    ),
                  );
                }}
              >
                <span aria-hidden="true" />
              </button>
            ))}
          </div>
        )}
      </div>
      <p className={styles.hint} id={hint}>
        拖动照片调整位置，双指缩放；拖动四角可自由改变裁剪比例。
      </p>
    </div>
  );
};

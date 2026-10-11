"use client";

import { useEffect, useId, useRef } from "react";
import Cropper from "react-easy-crop";
import "react-easy-crop/react-easy-crop.css";

import { useCropGestures } from "../authors/crop-gestures";
import { CropTools } from "../authors/crop-tools";
import media from "../publishing/ui/media/media.module.css";

import type { MediaRotation } from "@moya/contracts";
import type { ReactNode } from "react";
import type { Area } from "react-easy-crop";

/**
 * The one crop surface of the Media Composer (#244): react-easy-crop driven
 * by the shared gesture input of the profile editors (#171 r3/r4) — drag to
 * move, two-finger zoom (touch or trackpad pinch), Ctrl + wheel and the
 * `+ − 0` keys as fallbacks, no zoom bar — with the 还原 / hint row under it.
 *
 * The surface owns position and zoom. A caller that keeps its own crop model
 * (the publishing `CropSession`) seeds the cropper with a stored area and
 * learns about the author's moves through `onTouched`; it never has to mirror
 * position or zoom.
 */

/** A stored area in percentages of the (rotated) frame, as react-easy-crop seeds it. */
export interface CropSeed {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface CropSurfaceProps {
  readonly image: string;
  /** Width / height of the crop frame. */
  readonly aspect: number;
  readonly rotation?: MediaRotation;
  readonly shape?: "rect" | "round";
  readonly objectFit?: "contain" | "cover";
  readonly showGrid?: boolean;
  /**
   * Where the crop starts for this `generation`. The seed is applied once per
   * generation: a remount of the surface after an interrupted gesture keeps
   * the author's position and zoom instead of snapping back to the seed, and
   * a new `image` within the generation starts from the last reported area.
   * A different picture needs a new surface (`key`), not a new `image`.
   */
  readonly seed?: CropSeed | undefined;
  /** A new frame or aspect: the cropper remounts and starts again from `seed` (or centred). */
  readonly generation: number | string;
  /** Saving: user input is blocked; layout re-reports still apply. */
  readonly locked?: boolean;
  readonly autoFocus?: boolean;
  /** Accessible name of the crop area; the hint row describes the gestures. */
  readonly label: string;
  /** The hint and 还原 row: `full` has 还原; `hintOnly` for dialogs with their own 还原. */
  readonly tools?: "full" | "hintOnly";
  /** Every area the cropper reports, in percentages of the frame. */
  readonly onArea: (area: Area) => void;
  /** The author moved or zoomed the crop (a mount re-report never counts). */
  readonly onTouched?: (() => void) | undefined;
  /** The crop box in viewport pixels whenever the cropper lays it out (guides). */
  readonly onCropSize?:
    | ((size: { readonly width: number; readonly height: number }) => void)
    | undefined;
  /** Drawn over the viewport, above the cropper (guides). */
  readonly overlay?: ReactNode;
  readonly viewportClassName?: string | undefined;
  readonly cropAreaClassName?: string | undefined;
  /**
   * Each new value has the cropper measure its box again, keeping the crop
   * where it is (as a resize does). A caller that scales the box for a moment
   * (the phone stage's peek) asks once the scale is gone: a cropper mounted
   * meanwhile measured the scaled box.
   */
  readonly remeasure?: number | undefined;
  readonly children?: ReactNode;
}

export const CropSurface = ({
  image,
  aspect,
  rotation = 0,
  shape = "rect",
  objectFit = "contain",
  showGrid = false,
  seed,
  generation,
  locked = false,
  autoFocus = false,
  label,
  tools = "full",
  onArea,
  onTouched,
  onCropSize,
  overlay,
  viewportClassName,
  cropAreaClassName,
  remeasure,
  children,
}: CropSurfaceProps) => {
  const gestures = useCropGestures({ locked, autoFocus });
  const hintId = useId();
  const cropperRef = useRef<Cropper | null>(null);

  // Measured again on request, never on mount (the cropper measures itself).
  const measuredFor = useRef(remeasure);
  useEffect(() => {
    if (measuredFor.current === remeasure) return;
    measuredFor.current = remeasure;
    const cropper = cropperRef.current;
    if (typeof cropper?.computeSizes === "function")
      cropper.computeSizes({ isResizeTriggered: true });
  }, [remeasure]);

  // The seed belongs to the first cropper instance of a generation: later
  // surface remounts (an interrupted touch) keep the gesture state, so the
  // cropper mounts on the controlled position and zoom instead. A new source
  // of the same picture (the account derivative replacing local bytes) is
  // reseeded when it loads: from the author's last area, not the first seed.
  const seeded = useRef<{
    generation: number | string;
    image: string;
    surface: number;
    seed: CropSeed | undefined;
  } | null>(null);
  const reported = useRef<{
    generation: number | string;
    area: Area;
  } | null>(null);
  if (seeded.current === null || seeded.current.generation !== generation)
    seeded.current = { generation, image, surface: gestures.surface, seed };
  else if (seeded.current.image !== image)
    seeded.current = {
      generation,
      image,
      surface: gestures.surface,
      seed:
        reported.current?.generation === generation
          ? reported.current.area
          : seeded.current.seed,
    };
  const instanceSeed =
    gestures.surface === seeded.current.surface
      ? seeded.current.seed
      : undefined;

  // A new generation starts from zoom 1 at the centre before its seed applies.
  const shownGeneration = useRef(generation);
  const reset = gestures.reset;
  useEffect(() => {
    if (shownGeneration.current === generation) return;
    shownGeneration.current = generation;
    reset();
  }, [generation, reset]);

  // The author's input shows as a position or zoom away from the pristine
  // state; returning to it (还原, a new generation) is not a touch.
  const previous = useRef({ x: 0, y: 0, zoom: 1 });
  const touched = useRef(onTouched);
  touched.current = onTouched;
  const { crop, zoom } = gestures;
  useEffect(() => {
    const changed =
      crop.x !== previous.current.x ||
      crop.y !== previous.current.y ||
      zoom !== previous.current.zoom;
    previous.current = { x: crop.x, y: crop.y, zoom };
    if (changed && !(crop.x === 0 && crop.y === 0 && zoom === 1))
      touched.current?.();
  }, [crop, zoom]);

  return (
    <div {...gestures.wrapperProps} data-crop-surface="">
      <div
        className={viewportClassName ?? media.cropViewport}
        data-media-crop=""
        data-saving={locked ? "true" : undefined}
        {...gestures.frameProps}
      >
        <Cropper
          key={`${generation}:${gestures.surface}`}
          ref={cropperRef}
          {...gestures.cropperProps}
          aspect={aspect}
          classes={{
            cropAreaClassName: cropAreaClassName ?? media.cropArea ?? "",
          }}
          cropShape={shape === "round" ? "round" : "rect"}
          cropperProps={{
            tabIndex: locked ? -1 : 0,
            "aria-label": label,
            "aria-describedby": hintId,
          }}
          disableAutomaticStylesInjection
          image={image}
          {...(instanceSeed === undefined
            ? {}
            : { initialCroppedAreaPercentages: instanceSeed })}
          mediaProps={{ alt: "", draggable: false }}
          objectFit={objectFit}
          onCropAreaChange={(area) => {
            reported.current = { generation, area };
            gestures.reportArea(area);
            onArea(area);
          }}
          {...(onCropSize === undefined
            ? {}
            : { onCropSizeChange: onCropSize })}
          rotation={rotation}
          showGrid={showGrid}
        />
        {overlay}
      </div>
      <CropTools
        coarse={gestures.coarse}
        hintId={hintId}
        locked={locked}
        onReset={gestures.reset}
        pristine={gestures.pristine}
        reset={tools === "full"}
      />
      {children}
    </div>
  );
};

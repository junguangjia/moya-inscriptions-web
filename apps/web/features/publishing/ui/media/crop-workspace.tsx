"use client";

import { useEffect, useRef, useState } from "react";

import { CropSurface } from "../../../media-composer/crop-surface";
import {
  centeredCrop,
  cropFromPercentages,
  normalizeCrop,
  percentagesFromCrop,
} from "./media-geometry";
import styles from "./media.module.css";

import type {
  AspectPreset,
  AspectPresetId,
  PercentArea,
  Size,
} from "./media-geometry";
import type { MediaCrop, MediaRotation } from "@moya/contracts";
import type { Dispatch, ReactNode, SetStateAction } from "react";

/**
 * The crop mechanics shared by the edit and cover composition dialogs: the
 * Media Composer's crop surface (drag, two-finger zoom, Ctrl + wheel and
 * `+ − 0` keys, no zoom bar — #244 after #171 r3/r4) inside a bounded
 * viewport, and aspect presets as a radio group.
 */

export type CropPreset = AspectPresetId | "custom";

export interface CropSession {
  readonly preset: CropPreset;
  /** Where the cropper starts, in percentages of the frame; undefined centers it. */
  readonly seed: PercentArea | undefined;
  /** The last area the cropper reported; undefined until it reports one. */
  readonly area: MediaCrop | null | undefined;
  /**
   * Kept for stored drafts; the crop surface owns the live position and
   * zoom since #244 and seeds itself from `seed` instead.
   */
  readonly position: { readonly x: number; readonly y: number };
  readonly zoom: number;
  /**
   * The author moved or zoomed the crop in this session. The cropper also
   * reports an area on its own when it mounts or its frame changes (with a
   * turned image that area is not the full frame on every layout), and such
   * a report is never an edit the author asked for.
   */
  readonly touched: boolean;
  /** Remounts the cropper when its frame or aspect changes. */
  readonly generation: number;
}

export const startCrop = (
  preset: CropPreset,
  crop: MediaCrop | null,
): CropSession => ({
  preset,
  seed: crop === null ? undefined : percentagesFromCrop(crop),
  area: undefined,
  position: { x: 0, y: 0 },
  zoom: 1,
  touched: false,
  generation: 0,
});

/** A new frame or aspect: the crop starts again centered at full zoom-out. */
export const restartCrop = (
  session: CropSession,
  preset: CropPreset,
): CropSession => ({
  preset,
  seed: undefined,
  area: undefined,
  position: { x: 0, y: 0 },
  zoom: 1,
  touched: false,
  generation: session.generation + 1,
});

/**
 * Whether the session's reported area is an explicit crop: it continues a
 * stored crop (seeded), the author chose an aspect other than 原始比例, or
 * moved or zoomed the crop. A fresh 原始比例 session left alone is the full
 * frame, whatever the cropper reported for it.
 */
const explicitArea = (session: CropSession): boolean =>
  session.seed !== undefined ||
  session.preset !== "original" ||
  session.touched;

/**
 * Continues a session in a newly mounted cropper (the dialog came back after
 * a layout change, or its image source changed): the cropper starts where
 * the author left the crop, not where the session was first seeded. A
 * session that never became explicit stays the full frame: the cropper's own
 * report (a turned image re-reports a part of itself on some layouts) is
 * neither carried over nor turned into a seed (#244, review r2).
 */
export const resumeCrop = (session: CropSession): CropSession => {
  if (session.area === undefined) return session;
  if (!explicitArea(session)) return { ...session, area: undefined };
  return {
    ...session,
    seed: session.area === null ? undefined : percentagesFromCrop(session.area),
  };
};

/**
 * The crop to store: what the cropper reported when that is an explicit
 * crop, else where it was seeded, else the centered crop of the chosen
 * aspect (the full frame is null).
 */
export const resolvedCrop = (
  session: CropSession,
  ratio: number,
  frame: Size | null,
): MediaCrop | null => {
  if (session.area !== undefined && explicitArea(session)) return session.area;
  if (session.seed !== undefined) return cropFromPercentages(session.seed);
  if (frame === null || session.preset === "original") return null;
  return normalizeCrop(centeredCrop(ratio, frame));
};

/** The natural (display-orientation) size of an image URL, or a known size. */
export const useNaturalSize = (
  src: string | null,
  known: Size | null,
): { readonly size: Size | null; readonly failed: boolean } => {
  const [measured, setMeasured] = useState<{
    readonly src: string;
    readonly size: Size | null;
    readonly failed: boolean;
  } | null>(null);
  useEffect(() => {
    if (src === null || known !== null || typeof Image === "undefined") return;
    const image = new Image();
    let active = true;
    image.onload = () => {
      if (!active) return;
      setMeasured(
        image.naturalWidth > 0 && image.naturalHeight > 0
          ? {
              src,
              size: { width: image.naturalWidth, height: image.naturalHeight },
              failed: false,
            }
          : { src, size: null, failed: true },
      );
    };
    image.onerror = () => {
      if (active) setMeasured({ src, size: null, failed: true });
    };
    image.src = src;
    return () => {
      active = false;
      image.onload = null;
      image.onerror = null;
    };
  }, [src, known]);
  if (known !== null) return { size: known, failed: false };
  if (measured === null || measured.src !== src)
    return { size: null, failed: false };
  return { size: measured.size, failed: measured.failed };
};

export const PresetPicker = ({
  name,
  presets,
  value,
  disabled = false,
  hideLegend = false,
  onChange,
}: {
  readonly name: string;
  readonly presets: readonly AspectPreset[];
  readonly value: CropPreset;
  readonly disabled?: boolean;
  /**
   * The group keeps its name for assistive tech but draws none: the phone
   * edit screen's ratio row shows 裁剪比例 in its own header (#244).
   */
  readonly hideLegend?: boolean;
  readonly onChange: (preset: AspectPresetId) => void;
}) => (
  <fieldset className={styles.presets} disabled={disabled}>
    <legend className={hideLegend ? styles.visuallyHidden : undefined}>
      裁剪比例
    </legend>
    <div className={styles.presetOptions}>
      {presets.map((preset) => (
        <label className={styles.presetOption} key={preset.id}>
          <input
            checked={value === preset.id}
            name={name}
            onChange={() => onChange(preset.id)}
            type="radio"
            value={preset.id}
          />
          <span>{preset.label}</span>
        </label>
      ))}
      {value === "custom" && (
        <label className={styles.presetOption}>
          <input checked name={name} readOnly type="radio" value="custom" />
          <span>当前比例</span>
        </label>
      )}
    </div>
  </fieldset>
);

export const CropWorkspace = ({
  itemKey,
  image,
  rotation,
  ratio,
  session,
  onSession,
  label,
  overlay,
  onCropSize,
}: {
  /**
   * The item `session` belongs to. The crop surface owns position and zoom,
   * so a workspace that stays mounted while it switches items starts a new
   * surface for each one instead of carrying the last item's crop over.
   */
  readonly itemKey: string;
  readonly image: string;
  readonly rotation: MediaRotation;
  readonly ratio: number;
  readonly session: CropSession;
  readonly onSession: Dispatch<SetStateAction<CropSession>>;
  readonly label: string;
  /** Guides drawn over the crop viewport. */
  readonly overlay?: ReactNode;
  /** The crop box size in viewport pixels, for guides that follow it. */
  readonly onCropSize?: ((size: Size) => void) | undefined;
}) => {
  // A new source of the same item (e.g. the account derivative replacing
  // local bytes) keeps the crop the author made: the cropper reseeds from it
  // when it loads. Another item brings its own session.
  const shown = useRef({ itemKey, image });
  const latest = useRef(onSession);
  useEffect(() => {
    latest.current = onSession;
  });
  useEffect(() => {
    const before = shown.current;
    if (before.itemKey === itemKey && before.image === image) return;
    shown.current = { itemKey, image };
    if (before.itemKey === itemKey) latest.current(resumeCrop);
  }, [itemKey, image]);
  return (
    <CropFrame
      key={itemKey}
      image={image}
      label={label}
      onCropSize={onCropSize}
      onSession={onSession}
      overlay={overlay}
      ratio={ratio}
      rotation={rotation}
      session={session}
    />
  );
};

const CropFrame = ({
  image,
  rotation,
  ratio,
  session,
  onSession,
  label,
  overlay,
  onCropSize,
}: {
  readonly image: string;
  readonly rotation: MediaRotation;
  readonly ratio: number;
  readonly session: CropSession;
  readonly onSession: Dispatch<SetStateAction<CropSession>>;
  readonly label: string;
  readonly overlay?: ReactNode;
  readonly onCropSize?: ((size: Size) => void) | undefined;
}) => (
  <CropSurface
    aspect={ratio}
    generation={session.generation}
    image={image}
    label={`${label}，+ − 键缩放，0 键还原`}
    objectFit="contain"
    onArea={(area) =>
      onSession((current) => ({
        ...current,
        area: cropFromPercentages(area),
      }))
    }
    onCropSize={onCropSize}
    // The cropper re-reports its position when it mounts or clamps; only a
    // moved or zoomed crop is the author's (the surface tells those apart).
    onTouched={() =>
      onSession((current) =>
        current.touched ? current : { ...current, touched: true },
      )
    }
    overlay={overlay}
    rotation={rotation}
    seed={session.seed}
    showGrid
    tools="hintOnly"
  />
);

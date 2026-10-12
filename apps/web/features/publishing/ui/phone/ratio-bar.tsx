"use client";

import { useRef } from "react";

import { EDIT_PRESETS } from "../media/media-geometry";
import styles from "./edit-screen.module.css";

import type { CropPreset } from "../media/crop-workspace";
import type { AspectPreset, AspectPresetId } from "../media/media-geometry";
import type { KeyboardEvent } from "react";

/**
 * The phone edit screen's ratio row (#244 r3, mockup B `.seg`): one
 * segmented radio group 裁剪比例 (named for assistive tech, no visible
 * legend) in the phone order 原始比例 · 4:5 · 3:4 · 1:1 · 4:3 (16:9 and 9:16
 * stay for the article crop), each segment with the frame's shape. One tab
 * stop; the arrow keys pick the next or previous ratio, wrapping, and focus
 * follows the choice. A stored shape outside the phone set checks none.
 */

const PHONE_ORDER: readonly AspectPresetId[] = [
  "original",
  "4:5",
  "3:4",
  "1:1",
  "4:3",
];

export const PHONE_PRESETS: readonly AspectPreset[] = PHONE_ORDER.flatMap(
  (id) => EDIT_PRESETS.filter((preset) => preset.id === id),
);

/** One of the phone's ratios (a stored shape outside them checks none). */
export const isPhonePreset = (preset: CropPreset): preset is AspectPresetId =>
  PHONE_ORDER.some((id) => id === preset);

/** Each fixed ratio's frame in a 20 box (mockup B `ratioGlyph`): width, height. */
const SHAPES: Readonly<
  Partial<Record<AspectPresetId, readonly [number, number]>>
> = {
  "4:5": [13, 16.25],
  "3:4": [11, 15.5],
  "1:1": [14, 14],
  "4:3": [16, 12],
};

/** The ratio's shape at 20 px; 原始比例 is a picture frame. */
const RatioGlyph = ({ id }: { readonly id: AspectPresetId }) => {
  const shape = SHAPES[id];
  return (
    <svg
      aria-hidden="true"
      className={styles.glyph}
      focusable="false"
      height={20}
      viewBox="0 0 20 20"
      width={20}
    >
      <g
        fill="none"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={1.7}
      >
        {shape === undefined ? (
          <>
            <rect height="12" rx="1.5" width="15" x="2.5" y="4" />
            <path d="m5.5 13.2 3.2-3.4 2.4 2.5 1.5-1.5 2 2.4" />
          </>
        ) : (
          <rect
            height={shape[1]}
            rx="1.5"
            width={shape[0]}
            x={10 - shape[0] / 2}
            y={10 - shape[1] / 2}
          />
        )}
      </g>
    </svg>
  );
};

export interface RatioBarProps {
  /** The current photo's preset; a stored shape outside the set checks none. */
  readonly value: CropPreset;
  /** No preview to crop (or a photo that cannot be edited). */
  readonly disabled: boolean;
  readonly onChange: (preset: AspectPresetId) => void;
  /**
   * The ratios offered, in order, 原始比例 first: the phone's edit set by
   * default; 封面构图 offers the cover's (`COVER_PRESETS`).
   */
  readonly presets?: readonly AspectPreset[] | undefined;
  /** The group's name for assistive tech (no visible legend). */
  readonly label?: string | undefined;
}

export const RatioBar = ({
  value,
  disabled,
  onChange,
  presets = PHONE_PRESETS,
  label = "裁剪比例",
}: RatioBarProps) => {
  const group = useRef<HTMLDivElement>(null);
  const order = presets.map((preset) => preset.id);
  const checked = order.find((id) => id === value) ?? null;
  const tabStop = checked ?? order[0];
  const step = (event: KeyboardEvent<HTMLDivElement>) => {
    const offset =
      event.key === "ArrowRight" || event.key === "ArrowDown"
        ? 1
        : event.key === "ArrowLeft" || event.key === "ArrowUp"
          ? -1
          : 0;
    if (offset === 0 || disabled || order.length === 0) return;
    event.preventDefault();
    const target = event.target;
    const named = target instanceof HTMLElement ? target.dataset.ratio : null;
    const focused = order.find((id) => id === named);
    const from = Math.max(0, order.indexOf(checked ?? focused ?? "original"));
    const next = order[(from + offset + order.length) % order.length]!;
    onChange(next);
    group.current
      ?.querySelector<HTMLElement>(`[data-ratio="${next}"]`)
      ?.focus();
  };
  return (
    <div className={styles.ratioRow}>
      <div
        ref={group}
        aria-label={label}
        className={styles.segment}
        data-count={presets.length}
        data-edit-ratio=""
        onKeyDown={step}
        role="radiogroup"
      >
        {presets.map((preset) => (
          <button
            key={preset.id}
            aria-checked={checked === preset.id}
            className={styles.segmentButton}
            data-ratio={preset.id}
            disabled={disabled}
            onClick={() => onChange(preset.id)}
            role="radio"
            tabIndex={tabStop === preset.id ? 0 : -1}
            type="button"
          >
            <RatioGlyph id={preset.id} />
            <span>{preset.label}</span>
          </button>
        ))}
      </div>
    </div>
  );
};

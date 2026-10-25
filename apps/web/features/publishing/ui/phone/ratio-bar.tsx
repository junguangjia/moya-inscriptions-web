"use client";

import { useRef } from "react";

import { EDIT_PRESETS } from "../media/media-geometry";
import styles from "./edit-screen.module.css";

import type { CropPreset } from "../media/crop-workspace";
import type { AspectPreset, AspectPresetId } from "../media/media-geometry";
import type { KeyboardEvent, ReactNode } from "react";

/**
 * The phone edit screen's ratio row (#244 r3, mockup B `.seg`): one
 * segmented radio group 裁剪比例 (named for assistive tech, no visible
 * legend) in the phone order 原始比例 · 自由 · 4:5 · 3:4 · 1:1 · 4:3 (#341;
 * 16:9 and 9:16 stay for the article crop), each fixed ratio with the
 * frame's shape. One tab stop; the arrow keys pick the next or previous
 * ratio, wrapping, and focus follows the choice. 自由 (`custom`) is the
 * corner handles' free shape, and any stored shape outside the fixed set.
 * While the 「动态流」 tool is on, the same segmented group offers 局部 ·
 * 整张 instead (`FeedFitBar`).
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

/** One of the phone's fixed ratios or 原始比例 (自由 is none of them). */
export const isPhonePreset = (preset: CropPreset): preset is AspectPresetId =>
  PHONE_ORDER.some((id) => id === preset);

/** The free shape's segment (`custom`, the dialogs' 当前比例). */
export const FREE_LABEL = "自由";

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

/** One segment of a `SegmentRadioGroup`. */
export interface SegmentOption<T extends string> {
  readonly id: T;
  readonly label: string;
  /** Drawn before the label (hidden from assistive tech). */
  readonly glyph?: ReactNode;
}

export interface SegmentRadioGroupProps<T extends string> {
  readonly options: readonly SegmentOption<T>[];
  /** The checked option; a value that is none of them checks none. */
  readonly value: string | null;
  readonly disabled: boolean;
  readonly onChange: (id: T) => void;
  /** The group's name for assistive tech (no visible legend). */
  readonly label: string;
  /** Names each segment's data attribute: `ratio` gives `data-ratio="4:5"`. */
  readonly optionAttribute: string;
  /** A data attribute marking the group: `edit-ratio` gives `data-edit-ratio`. */
  readonly groupAttribute?: string | undefined;
}

/**
 * The phone screens' segmented radio group (mockup B `.seg`): one muted
 * track, the checked segment lifted onto the elevated fill. One tab stop
 * (the checked segment, else the first); the arrow keys pick the next or
 * previous segment, wrapping, and focus follows the choice.
 */
export const SegmentRadioGroup = <T extends string>({
  options,
  value,
  disabled,
  onChange,
  label,
  optionAttribute,
  groupAttribute,
}: SegmentRadioGroupProps<T>) => {
  const group = useRef<HTMLDivElement>(null);
  const order = options.map((option) => option.id);
  const checked = order.find((id) => id === value) ?? null;
  const tabStop = checked ?? order[0];
  const attribute = `data-${optionAttribute}`;
  const step = (event: KeyboardEvent<HTMLDivElement>) => {
    const offset =
      event.key === "ArrowRight" || event.key === "ArrowDown"
        ? 1
        : event.key === "ArrowLeft" || event.key === "ArrowUp"
          ? -1
          : 0;
    const first = order[0];
    if (offset === 0 || disabled || first === undefined) return;
    event.preventDefault();
    const target = event.target;
    const named =
      target instanceof HTMLElement ? target.getAttribute(attribute) : null;
    const focused = order.find((id) => id === named);
    const from = Math.max(0, order.indexOf(checked ?? focused ?? first));
    const next = order[(from + offset + order.length) % order.length]!;
    onChange(next);
    group.current
      ?.querySelector<HTMLElement>(`[${attribute}="${next}"]`)
      ?.focus();
  };
  return (
    <div
      ref={group}
      aria-label={label}
      className={styles.segment}
      data-count={options.length}
      onKeyDown={step}
      role="radiogroup"
      {...(groupAttribute === undefined
        ? {}
        : { [`data-${groupAttribute}`]: "" })}
    >
      {options.map((option) => (
        <button
          key={option.id}
          aria-checked={checked === option.id}
          className={styles.segmentButton}
          disabled={disabled}
          onClick={() => onChange(option.id)}
          role="radio"
          tabIndex={tabStop === option.id ? 0 : -1}
          type="button"
          {...{ [attribute]: option.id }}
        >
          {option.glyph}
          <span>{option.label}</span>
        </button>
      ))}
    </div>
  );
};

export interface RatioBarProps {
  /** The current photo's preset; a stored shape outside the set checks none, or 自由. */
  readonly value: CropPreset;
  /** No preview to crop (or a photo that cannot be edited). */
  readonly disabled: boolean;
  readonly onChange: (preset: CropPreset) => void;
  /**
   * The ratios offered, in order, 原始比例 first: the phone's edit set by
   * default; 封面构图 offers the cover's (`COVER_PRESETS`).
   */
  readonly presets?: readonly AspectPreset[] | undefined;
  /**
   * 自由 right after 原始比例 (编辑, #341). Six segments share a 320–390px
   * row, so 原始比例 and 自由 are words there and only the four shapes keep
   * their glyphs.
   */
  readonly free?: boolean | undefined;
  /** The group's name for assistive tech (no visible legend). */
  readonly label?: string | undefined;
}

/** How the feed shows a photo taller than its stage (#341): 局部 or 整张. */
export type FeedFit = "region" | "whole";

/** The two framings at 20 px: a tall photo with its shown band, and one whole between blank sides. */
const FeedFitGlyph = ({ id }: { readonly id: FeedFit }) => (
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
      {id === "region" ? (
        <>
          <rect height="16" rx="1.5" width="10" x="5" y="2" />
          <path d="M3 7h14M3 13h14" strokeDasharray="2 2" />
        </>
      ) : (
        <>
          <rect height="14" rx="1.5" width="8" x="6" y="3" />
          <path d="M2.5 5v10M17.5 5v10" />
        </>
      )}
    </g>
  </svg>
);

const FEED_FITS: readonly SegmentOption<FeedFit>[] = [
  { id: "region", label: "局部", glyph: <FeedFitGlyph id="region" /> },
  { id: "whole", label: "整张", glyph: <FeedFitGlyph id="whole" /> },
];

/**
 * The 「动态流」 tool's row in place of the ratios (#341): 动态流显示 局部
 * (the region the author drags on the stage) or 整张 (whole, blank at the
 * sides), for a photo taller than the feed's stage.
 */
export const FeedFitBar = ({
  value,
  onChange,
  disabled = false,
}: {
  readonly value: FeedFit;
  readonly onChange: (fit: FeedFit) => void;
  readonly disabled?: boolean | undefined;
}) => (
  <div className={styles.ratioRow}>
    <SegmentRadioGroup
      disabled={disabled}
      groupAttribute="edit-feed-fit"
      label="动态流显示"
      onChange={onChange}
      optionAttribute="feed-choice"
      options={FEED_FITS}
      value={value}
    />
  </div>
);

export const RatioBar = ({
  value,
  disabled,
  onChange,
  presets = PHONE_PRESETS,
  free = false,
  label = "裁剪比例",
}: RatioBarProps) => {
  const options = presets.flatMap(
    (preset): readonly SegmentOption<CropPreset>[] => {
      const own: SegmentOption<CropPreset> =
        free && preset.ratio === null
          ? { id: preset.id, label: preset.label }
          : {
              id: preset.id,
              label: preset.label,
              glyph: <RatioGlyph id={preset.id} />,
            };
      return free && preset.id === "original"
        ? [own, { id: "custom", label: FREE_LABEL }]
        : [own];
    },
  );
  return (
    <div className={styles.ratioRow}>
      <SegmentRadioGroup
        disabled={disabled}
        groupAttribute="edit-ratio"
        label={label}
        onChange={onChange}
        optionAttribute="ratio"
        options={options}
        value={value}
      />
    </div>
  );
};

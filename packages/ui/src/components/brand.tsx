import type { HTMLAttributes } from "react";
import { darkTheme, lightTheme } from "@moya/design-tokens";

/** Product control accent retained for existing consumers. */
export const brandAccentColors = {
  light: lightTheme["system-orange"],
  dark: darkTheme["system-orange"],
} as const;

/** Neutral material parameters shared with the independently themed Admin. */
export const brandDebossColors = {
  light: {
    floor: lightTheme["brand-recess-floor"],
    shadow: lightTheme["brand-recess-shadow"],
    highlight: lightTheme["brand-recess-highlight"],
  },
  dark: {
    floor: darkTheme["brand-recess-floor"],
    shadow: darkTheme["brand-recess-shadow"],
    highlight: darkTheme["brand-recess-highlight"],
  },
} as const;

import type { FixedLabelName, IconName } from "../assets.js";
import { cx } from "../utils.js";

export type IconProps = Omit<HTMLAttributes<HTMLSpanElement>, "children"> & {
  name: IconName;
  label?: string;
  size?: "sm" | "md" | "lg";
};

export function Icon({
  name,
  label,
  size = "md",
  className,
  ...props
}: IconProps) {
  return (
    <span
      {...props}
      aria-hidden={label ? undefined : true}
      aria-label={label}
      className={cx("yoyi-icon", `yoyi-icon--${size}`, className)}
      data-icon={name}
      data-yoyi-ui="icon"
      role={label ? "img" : undefined}
    />
  );
}

// These three animated category glyphs share the canonical SVG artwork.
// Direct vectors avoid the external CSS-mask paint path while a parent scales
// continuously from zero. Other Icon consumers retain their existing renderer.
const categoryArtwork = {
  nearby: {
    viewBox: "-2 0 28 24",
    path: "M12 12.2a2.2 2.2 0 1 0 0-4.4 2.2 2.2 0 0 0 0 4.4Zm-5.8 3.5a8 8 0 0 1 0-11.4m11.6 0a8 8 0 0 1 0 11.4M3.5 18.5a11.4 11.4 0 0 1 0-17m17 0a11.4 11.4 0 0 1 0 17",
    strokeWidth: 1.6,
    strokeLinejoin: undefined,
  },
  inscriptions: {
    viewBox: "0 0 24 24",
    path: "M7 20h10M8.2 20V7.2c0-2.1 1.7-3.7 3.8-3.7s3.8 1.6 3.8 3.7V20M10.4 8.2h3.2M10.4 11.4h3.2M10.4 14.6h3.2",
    strokeWidth: 1.7,
    strokeLinejoin: undefined,
  },
  calligraphy: {
    viewBox: "0 0 24 24",
    inkPath:
      "M6.829 15.234C6.297 17.595 5.095 19.494 3.5 21C7.6 20.5 11.1 20 13.4 17.5C14.1 16.759 14.596 16.002 14.931 15.234Z",
    path: "M12.8 10.2 16.9 3.5a1.6 1.6 0 0 1 2.7 1.7l-4.1 6.7M15.7 5.5l2.7 1.7M12.8 10.2c-3-.6-5.4 1.2-5.8 4.1-.4 2.8-1.7 5-3.5 6.7 4.1-.5 7.6-1 9.9-3.5 1.7-1.8 2.2-3.7 2.1-5.6-.9-.7-1.8-1.3-2.7-1.7Z",
    strokeWidth: 1.7,
    strokeLinejoin: "round",
  },
} as const;

export function AnimatedCategoryIcon({
  name,
}: {
  readonly name: keyof typeof categoryArtwork;
}) {
  const artwork = categoryArtwork[name];
  return (
    <svg
      aria-hidden="true"
      focusable="false"
      width="24"
      height="24"
      viewBox={artwork.viewBox}
      preserveAspectRatio="xMidYMid meet"
      data-icon={name}
      data-icon-renderer="svg"
      data-yoyi-ui="icon"
    >
      {"inkPath" in artwork && <path d={artwork.inkPath} fill="currentColor" />}
      <path
        d={artwork.path}
        fill="none"
        stroke="currentColor"
        strokeWidth={artwork.strokeWidth}
        strokeLinecap="round"
        strokeLinejoin={artwork.strokeLinejoin}
      />
    </svg>
  );
}

export type YoyiLogoProps = Omit<
  HTMLAttributes<HTMLSpanElement>,
  "children"
> & {
  label?: string;
};

export function YoyiLogo({
  label = "由于艺",
  className,
  ...props
}: YoyiLogoProps) {
  return (
    <span
      {...props}
      aria-label={label}
      className={cx("yoyi-logo", className)}
      data-yoyi-ui="logo"
      role="img"
    />
  );
}

export type FixedLabelMarkProps = Omit<
  HTMLAttributes<HTMLSpanElement>,
  "children"
> & {
  name: FixedLabelName;
  label: string;
  decorative?: boolean;
};

export function FixedLabelMark({
  name,
  label,
  decorative = false,
  className,
  ...props
}: FixedLabelMarkProps) {
  return (
    <span
      {...props}
      aria-hidden={decorative || undefined}
      aria-label={decorative ? undefined : label}
      className={cx("yoyi-fixed-label", className)}
      data-label={name}
      data-yoyi-ui="fixed-label"
      role={decorative ? undefined : "img"}
    />
  );
}

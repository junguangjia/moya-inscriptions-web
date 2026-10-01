"use client";

import { useId } from "react";
import { fontFamily, typography } from "@moya/design-tokens";
import styles from "./user-identity.module.css";

/** Account decoration only: never substitutes for a nickname, handle or role. */
export const StudioName = ({
  value,
  prominent = false,
}: {
  value?: string | undefined;
  prominent?: boolean;
}) => {
  const id = `studio-${useId().replaceAll(":", "")}`;
  if (!value) return null;
  // SVG coordinates are scaled as one unit, including in the cover crop preview.
  const unit = Number.parseFloat(typography.body.mobileSize);
  const width = [...value].length * unit + unit * 1.25;
  const height = unit * 1.75;
  return (
    <span
      className={`${styles.studio} ${prominent ? styles.prominent : ""}`}
      style={{ width: `${width / unit}em` }}
      role="img"
      aria-label={`斋号：${value}`}
      data-studio-name=""
    >
      <svg
        viewBox={`0 0 ${width} ${height}`}
        aria-hidden="true"
        focusable="false"
      >
        <defs>
          <linearGradient id={`${id}-wood`} x1="0" y1="0" x2="0.2" y2="1">
            <stop offset="0" stopColor="var(--yoyi-color-studio-wood-light)" />
            <stop offset="0.5" stopColor="var(--yoyi-color-studio-wood-base)" />
            <stop offset="1" stopColor="var(--yoyi-color-studio-wood-light)" />
          </linearGradient>
          <pattern
            id={`${id}-grain`}
            width="80"
            height={height}
            patternUnits="userSpaceOnUse"
          >
            <path
              d="M-10 5Q18 0 48 5T100 5M-10 10Q20 5 50 10T100 10M-10 18Q25 12 50 18T100 18M-10 24Q20 18 55 24T100 24"
              fill="none"
              stroke="var(--yoyi-color-studio-wood-grain)"
              strokeWidth="0.6"
              opacity="0.32"
            />
          </pattern>
          <mask
            id={`${id}-cutout`}
            maskUnits="userSpaceOnUse"
            x="0"
            y="0"
            width={width}
            height={height}
          >
            <rect width={width} height={height} rx="3" fill="white" />
            <text
              className={styles.cutoutText}
              x={width / 2}
              y={height / 2}
              textAnchor="middle"
              dominantBaseline="central"
              fontFamily={fontFamily.editorial}
              fontSize={unit}
              fontWeight={typography.label.weight}
              fill="black"
            >
              {value}
            </text>
          </mask>
        </defs>
        <g mask={`url(#${id}-cutout)`}>
          <rect width={width} height={height} fill={`url(#${id}-wood)`} />
          <rect width={width} height={height} fill={`url(#${id}-grain)`} />
        </g>
      </svg>
    </span>
  );
};

export const UserIdentity = ({
  name,
  studioName,
}: {
  name: string;
  studioName?: string | undefined;
}) => (
  <span className={styles.identity}>
    <span className={styles.name}>{name}</span>
    <StudioName value={studioName} />
  </span>
);

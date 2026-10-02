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
  const height = unit * 1.5;
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
              d="M-10 7Q20 2 50 7T100 7M-10 19Q25 13 55 19T100 19"
              fill="none"
              stroke="var(--yoyi-color-studio-wood-grain)"
              strokeWidth="0.6"
              opacity="0.1"
            />
          </pattern>
          <clipPath id={`${id}-shape`}>
            <rect width={width} height={height} rx={height / 2} />
          </clipPath>
          <filter
            id={`${id}-engraved`}
            x="-10%"
            y="-10%"
            width="120%"
            height="120%"
            colorInterpolationFilters="sRGB"
          >
            {/* Paint from alpha so emoji receive the same carved treatment. */}
            <feFlood
              floodColor="var(--yoyi-color-studio-wood-ink)"
              result="ink"
            />
            <feComposite
              in="ink"
              in2="SourceAlpha"
              operator="in"
              result="floor"
            />
            <feOffset in="SourceAlpha" dx="0.55" dy="0.75" result="lower" />
            <feComposite
              in="SourceAlpha"
              in2="lower"
              operator="out"
              result="upperEdge"
            />
            <feFlood
              floodColor="var(--yoyi-color-brand-recess-shadow)"
              result="shadow"
            />
            <feComposite
              in="shadow"
              in2="upperEdge"
              operator="in"
              result="innerShadow"
            />
            <feOffset in="SourceAlpha" dx="-0.35" dy="-0.5" result="upper" />
            <feComposite
              in="SourceAlpha"
              in2="upper"
              operator="out"
              result="lowerEdge"
            />
            <feFlood
              floodColor="var(--yoyi-color-brand-recess-highlight)"
              floodOpacity="0.45"
              result="light"
            />
            <feComposite
              in="light"
              in2="lowerEdge"
              operator="in"
              result="innerLight"
            />
            <feMerge>
              <feMergeNode in="floor" />
              <feMergeNode in="innerShadow" />
              <feMergeNode in="innerLight" />
            </feMerge>
          </filter>
        </defs>
        <g clipPath={`url(#${id}-shape)`}>
          <rect width={width} height={height} fill={`url(#${id}-wood)`} />
          <rect width={width} height={height} fill={`url(#${id}-grain)`} />
          <text
            x={width / 2}
            y={height / 2}
            textAnchor="middle"
            dominantBaseline="central"
            fontFamily={fontFamily.editorial}
            fontSize={unit}
            fontWeight={typography.label.weight}
            fill="var(--yoyi-color-studio-wood-ink)"
            filter={`url(#${id}-engraved)`}
          >
            {value}
          </text>
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

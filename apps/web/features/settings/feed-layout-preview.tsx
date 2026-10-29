import { useId } from "react";
import { feedLayoutLabels } from "../product-shell/preferences";
import styles from "./settings-view.module.css";
import type { PresentationPlatform } from "../shell/device-platform";

/** The same paper, outline and translucent blocks as the theme previews. */
export const FeedLayoutPreview = ({
  value,
  platform = "phone",
}: {
  value: "single" | "double";
  platform?: PresentationPlatform | undefined;
}) => {
  const clipId = useId();
  return (
    <figure
      className={styles.layoutExample}
      aria-label={`${feedLayoutLabels[value]}示意图`}
    >
      <div
        className={`${styles.preview} ${styles.layoutExampleGraphic}`}
        data-layout-example={value}
        aria-hidden="true"
      >
        <svg viewBox="0 0 240 156" fill="none" focusable="false">
          <defs>
            <clipPath id={clipId}>
              <rect x="12" y="12" width="216" height="132" rx="5" />
            </clipPath>
          </defs>
          <rect
            x="12.5"
            y="12.5"
            width="215"
            height="131"
            rx="5"
            stroke="currentColor"
            opacity=".5"
          />
          <path
            d="M24 25h30"
            stroke="currentColor"
            strokeWidth="3"
            opacity=".5"
          />
          <g clipPath={`url(#${clipId})`}>
            {platform === "pc" ? (
              <>
                {/* Both desktop modes browse multiple records. Calligraphy
                    keeps upright labels at each image's right edge. */}
                {[24, 90, 156].map((x, index) => (
                  <g key={x}>
                    <rect
                      x={x}
                      y="35"
                      width={value === "single" ? 40 : 58}
                      height={index === 1 ? 60 : 44}
                      rx="3"
                      fill="currentColor"
                      opacity=".2"
                    />
                    <path
                      d={
                        value === "single"
                          ? `M${x + 48} 36v35M${x + 54} 36v24`
                          : `M${x} ${index === 1 ? 101 : 85}h36`
                      }
                      stroke="currentColor"
                      strokeWidth="2"
                      opacity=".4"
                    />
                    <rect
                      x={x}
                      y={index === 1 ? 112 : 100}
                      width={value === "single" ? 40 : 58}
                      height="48"
                      rx="3"
                      fill="currentColor"
                      opacity=".2"
                    />
                  </g>
                ))}
              </>
            ) : value === "single" ? (
              <>
                <rect
                  x="24"
                  y="35"
                  width="192"
                  height="58"
                  rx="3"
                  fill="currentColor"
                  opacity=".2"
                />
                <path
                  d="M24 101h68"
                  stroke="currentColor"
                  strokeWidth="3"
                  opacity=".4"
                />
                <path
                  d="M24 109h174M24 115h150M24 121h162"
                  stroke="currentColor"
                  strokeWidth="2"
                  opacity=".2"
                />
                <g fill="currentColor" opacity=".4">
                  <circle cx="26" cy="131" r="2.5" />
                  <circle cx="37" cy="131" r="2.5" />
                  <circle cx="48" cy="131" r="2.5" />
                </g>
                <path
                  d="m208 129 3 3 3-3"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  opacity=".4"
                />
                <rect
                  x="24"
                  y="140"
                  width="192"
                  height="58"
                  rx="3"
                  fill="currentColor"
                  opacity=".2"
                />
              </>
            ) : (
              <>
                <g fill="currentColor" opacity=".2">
                  <rect x="24" y="35" width="91" height="45" rx="3" />
                  <rect x="125" y="35" width="91" height="61" rx="3" />
                  <rect x="24" y="95" width="91" height="61" rx="3" />
                  <rect x="125" y="111" width="91" height="45" rx="3" />
                </g>
                <path
                  d="M24 86h42M125 102h42"
                  stroke="currentColor"
                  strokeWidth="3"
                  opacity=".4"
                />
              </>
            )}
          </g>
        </svg>
      </div>
    </figure>
  );
};

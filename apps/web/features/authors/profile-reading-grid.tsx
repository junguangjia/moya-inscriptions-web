"use client";

import type { ContentCard } from "@moya/contracts";
import { listMediaPriority } from "../media/responsive-media";
import type { PresentationPlatform } from "../shell/device-platform";
import { ProfileReadingCard } from "./profile-reading-card";
import styles from "./profile-reading.module.css";

export interface ProfileReadingGridProps {
  readonly items: readonly ContentCard[];
  readonly platform: PresentationPlatform;
  readonly active: boolean;
  readonly label: string;
}

/** Fixed reading presentation for calligraphy profiles; no layout preference. */
export const ProfileReadingGrid = ({
  items,
  platform,
  active,
  label,
}: ProfileReadingGridProps) => (
  <div
    className={styles.reading}
    data-profile-reading=""
    data-reading-platform={platform}
  >
    <div className={styles.grid} role="list" aria-label={label}>
      {items.map((item, index) => (
        <ProfileReadingCard
          key={`${item.target.type}:${item.target.id}`}
          item={item}
          position={index + 1}
          platform={platform}
          priority={active ? listMediaPriority(index) : undefined}
        />
      ))}
    </div>
  </div>
);

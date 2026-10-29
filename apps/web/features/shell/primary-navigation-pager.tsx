"use client";

import type { ReactNode } from "react";

import { PrimaryBottomNavigation } from "./primary-bottom-navigation";
import { PrimaryShell } from "./primary-shell";
import { Icon } from "@moya/ui";

import type { PresentationPlatform } from "./device-platform";
import type { PrimaryDestination } from "./primary-shell";

const primaryPagerSequence = [
  "home",
  "discussion",
  "user",
] as const satisfies readonly PrimaryDestination[];

export type PrimaryDestinationDirection = "previous" | "next";

export const resolveAdjacentPrimaryDestination = (
  activeDestination: PrimaryDestination,
  direction: PrimaryDestinationDirection,
): PrimaryDestination | null => {
  const activeIndex = primaryPagerSequence.indexOf(activeDestination);
  const targetIndex = activeIndex + (direction === "previous" ? -1 : 1);

  return primaryPagerSequence[targetIndex] ?? null;
};

export interface PrimaryNavigationPagerProps {
  readonly displaySettingsOnly?: boolean;
  readonly desktop?: boolean;
  readonly onSettingsIntent?: ((opener: HTMLElement) => void) | undefined;
  readonly activeDestination: PrimaryDestination;
  readonly platform: PresentationPlatform;
  readonly onDestinationChange: (destination: PrimaryDestination) => void;
  readonly home: ReactNode;
  readonly discussion: ReactNode;
  readonly user: ReactNode;
  readonly navigationAction?: ReactNode;
  readonly navigationHidden?: boolean;
  readonly navigationMinimized?: boolean;
  readonly onNavigationExpand?: () => void;
  readonly showDevelopmentPagerControls?: boolean;
}

export const PrimaryNavigationPager = ({
  displaySettingsOnly = false,
  desktop = false,
  onSettingsIntent,
  activeDestination,
  platform,
  onDestinationChange,
  home,
  discussion,
  user,
  navigationAction,
  navigationHidden = false,
  navigationMinimized = false,
  onNavigationExpand = () => undefined,
  showDevelopmentPagerControls = false,
}: PrimaryNavigationPagerProps) => {
  const previousDestination = resolveAdjacentPrimaryDestination(
    activeDestination,
    "previous",
  );
  const nextDestination = resolveAdjacentPrimaryDestination(
    activeDestination,
    "next",
  );

  return (
    <div
      data-primary-navigation-pager=""
      data-active-destination={activeDestination}
    >
      <PrimaryShell
        activeDestination={activeDestination}
        platform={platform}
        home={home}
        discussion={discussion}
        user={user}
      />

      <div
        aria-hidden={navigationHidden || undefined}
        data-primary-navigation-layer=""
        hidden={navigationHidden}
      >
        <PrimaryBottomNavigation
          desktop={desktop}
          onSettingsIntent={onSettingsIntent}
          activeDestination={activeDestination}
          navigationAction={navigationAction}
          minimized={navigationMinimized}
          onExpand={onNavigationExpand}
          platform={platform}
          onDestinationChange={onDestinationChange}
        />
      </div>

      {displaySettingsOnly && onSettingsIntent && (
        <button
          type="button"
          className="yoyi-icon-button"
          data-desktop-display-settings=""
          aria-label="显示设置"
          title="显示设置"
          onClick={(event) => onSettingsIntent(event.currentTarget)}
        >
          <Icon name="settings" />
        </button>
      )}

      {showDevelopmentPagerControls ? (
        <div
          aria-label="主要内容分页"
          data-development-primary-pager=""
          role="group"
        >
          <button
            type="button"
            data-primary-pager-action="previous"
            data-target-destination={previousDestination ?? undefined}
            disabled={previousDestination === null}
            onClick={() => {
              if (previousDestination !== null) {
                onDestinationChange(previousDestination);
              }
            }}
          >
            上一页
          </button>
          <button
            type="button"
            data-primary-pager-action="next"
            data-target-destination={nextDestination ?? undefined}
            disabled={nextDestination === null}
            onClick={() => {
              if (nextDestination !== null) {
                onDestinationChange(nextDestination);
              }
            }}
          >
            下一页
          </button>
        </div>
      ) : null}
    </div>
  );
};

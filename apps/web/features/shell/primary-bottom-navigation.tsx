"use client";

import { useEffect, useRef, useState } from "react";

import type {
  CSSProperties,
  MouseEvent as ReactMouseEvent,
  PointerEvent as ReactPointerEvent,
  ReactElement,
  ReactNode,
} from "react";
import styles from "./primary-bottom-navigation.module.css";
import { Icon } from "@moya/ui";

import type { PresentationPlatform } from "./device-platform";
import type { PrimaryDestination } from "./primary-shell";
import type { IconName } from "@moya/ui";

interface PrimaryNavigationItem {
  readonly id: PrimaryDestination;
  readonly label: string;
  readonly icon: Extract<IconName, "home" | "discussion" | "user">;
  readonly iconPath: string;
  readonly iconUsesLinejoin: boolean;
}

export const PRIMARY_NAVIGATION_ICON_PATHS = {
  home: "M3.5 11.2 12 4l8.5 7.2M6.2 9.7v9.5h11.6V9.7M9.5 19.2v-5.7h5v5.7",
  discussion:
    "M18 14.5h1a2 2 0 0 1 2 2V21l-3.8-2.5H13a2 2 0 0 1-2-2V15M5.5 4h11A2.5 2.5 0 0 1 19 6.5v5a2.5 2.5 0 0 1-2.5 2.5H9l-5 3v-4A2.5 2.5 0 0 1 3 11V6.5A2.5 2.5 0 0 1 5.5 4Z",
  user: "M12 13a4.2 4.2 0 1 0 0-8.4 4.2 4.2 0 0 0 0 8.4ZM4.5 21v-1.2a7.5 5.8 0 0 1 15 0V21",
} as const;

const primaryNavigationItems = [
  {
    id: "home",
    label: "首页",
    icon: "home",
    iconPath: PRIMARY_NAVIGATION_ICON_PATHS.home,
    iconUsesLinejoin: true,
  },
  {
    id: "discussion",
    label: "讨论",
    icon: "discussion",
    iconPath: PRIMARY_NAVIGATION_ICON_PATHS.discussion,
    iconUsesLinejoin: true,
  },
  {
    id: "user",
    label: "用户",
    icon: "user",
    iconPath: PRIMARY_NAVIGATION_ICON_PATHS.user,
    iconUsesLinejoin: true,
  },
] as const satisfies readonly PrimaryNavigationItem[];

type PrimaryNavigationStyle = CSSProperties & {
  readonly "--primary-navigation-active-index": number;
  readonly "--primary-navigation-bubble-index": number;
  readonly "--primary-navigation-item-count": number;
};

interface PrimaryNavigationPointerGesture {
  readonly committedDestination: PrimaryDestination;
  readonly entryCenters: readonly number[];
  readonly focusedElement: Element | null;
  readonly initiatingButton: HTMLButtonElement;
  readonly pointerId: number;
  readonly pointerType: string;
  readonly startIndex: number;
  readonly startX: number;
  readonly startY: number;
  dragging: boolean;
  explicitlyCaptured: boolean;
}

export const PRIMARY_NAVIGATION_DRAG_THRESHOLD_PX = 8;

export const canArmPrimaryNavigationPointer = (
  isPrimary: boolean,
  pointerType: string,
  button: number,
) => isPrimary && (pointerType !== "mouse" || button === 0);

const clampNavigationIndex = (index: number, itemCount: number) =>
  Math.min(Math.max(index, 0), Math.max(itemCount - 1, 0));

export const hasPrimaryNavigationHorizontalDragIntent = (
  horizontalDisplacement: number,
  verticalDisplacement: number,
) =>
  Math.abs(horizontalDisplacement) > PRIMARY_NAVIGATION_DRAG_THRESHOLD_PX &&
  Math.abs(horizontalDisplacement) > Math.abs(verticalDisplacement);

export const resolvePrimaryNavigationBubbleIndex = (
  entryCenters: readonly number[],
  startIndex: number,
  horizontalDisplacement: number,
) => {
  if (entryCenters.length === 0) return 0;

  const clampedStartIndex = clampNavigationIndex(
    startIndex,
    entryCenters.length,
  );
  const startCenter = entryCenters[clampedStartIndex] ?? entryCenters[0] ?? 0;
  const previewCenter = startCenter + horizontalDisplacement;

  if (previewCenter <= (entryCenters[0] ?? previewCenter)) return 0;

  const lastIndex = entryCenters.length - 1;
  if (previewCenter >= (entryCenters[lastIndex] ?? previewCenter)) {
    return lastIndex;
  }

  for (let index = 0; index < lastIndex; index += 1) {
    const leftCenter = entryCenters[index];
    const rightCenter = entryCenters[index + 1];
    if (
      leftCenter === undefined ||
      rightCenter === undefined ||
      previewCenter > rightCenter
    ) {
      continue;
    }

    const centerDistance = Math.max(rightCenter - leftCenter, 1);
    return index + (previewCenter - leftCenter) / centerDistance;
  }

  return lastIndex;
};

export const resolvePrimaryNavigationReleaseIndex = (
  previewIndex: number,
  itemCount: number,
) => clampNavigationIndex(Math.round(previewIndex), itemCount);

export interface PrimaryBottomNavigationProps {
  readonly desktop?: boolean;
  readonly onSettingsIntent?: ((opener: HTMLElement) => void) | undefined;
  readonly activeDestination: PrimaryDestination;
  readonly navigationAction?: ReactNode;
  readonly minimized?: boolean;
  readonly onExpand?: () => void;
  readonly platform: PresentationPlatform;
  readonly onDestinationChange: (destination: PrimaryDestination) => void;
}

const PrimaryNavigationIcon = ({
  icon,
  label,
  path,
  usesLinejoin,
}: {
  readonly icon: Extract<IconName, "home" | "discussion" | "user">;
  readonly label: string;
  readonly path: string;
  readonly usesLinejoin: boolean;
}) => (
  <svg
    aria-hidden="true"
    className={styles.inlineIcon}
    data-icon={icon}
    data-primary-navigation-inline-icon=""
    data-source-asset={`packages/ui/src/assets/icons/${icon}.svg`}
    focusable="false"
    viewBox="0 0 24 24"
  >
    <title>{label}</title>
    <path
      d={path}
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin={usesLinejoin ? "round" : undefined}
      strokeWidth="1.7"
    />
  </svg>
);

export const createPrimaryNavigationEntryElements = (
  activeDestination: PrimaryDestination,
  onDestinationChange: (destination: PrimaryDestination) => void,
): ReactElement[] =>
  primaryNavigationItems.map(
    ({ id, icon, iconPath, iconUsesLinejoin, label }) => {
      const selected = id === activeDestination;

      return (
        <button
          key={id}
          type="button"
          aria-current={selected ? "page" : undefined}
          aria-label={label}
          title={label}
          className={`${styles.entry} yoyi-navigation-entry${
            selected ? " is-active" : ""
          }`}
          data-primary-navigation-destination={id}
          data-selected={selected ? "true" : "false"}
          onClick={() => onDestinationChange(id)}
        >
          <span aria-hidden="true" className={styles.iconWrap}>
            <PrimaryNavigationIcon
              icon={icon}
              label={label}
              path={iconPath}
              usesLinejoin={iconUsesLinejoin}
            />
          </span>
          <span
            aria-hidden="true"
            className={styles.label}
            data-primary-navigation-text-label=""
          >
            {label}
          </span>
        </button>
      );
    },
  );

export const commitPrimaryNavigationDragRelease = (
  committedDestination: PrimaryDestination,
  previewIndex: number,
  onDestinationChange: (destination: PrimaryDestination) => void,
) => {
  const releaseIndex = resolvePrimaryNavigationReleaseIndex(
    previewIndex,
    primaryNavigationItems.length,
  );
  const releaseDestination = primaryNavigationItems[releaseIndex]?.id;

  if (
    releaseDestination !== undefined &&
    releaseDestination !== committedDestination
  ) {
    onDestinationChange(releaseDestination);
  }

  return releaseDestination ?? committedDestination;
};

const readPrimaryNavigationEntryCenters = (navigation: HTMLElement) =>
  Array.from(
    navigation.querySelectorAll<HTMLElement>(
      "[data-primary-navigation-destination]",
    ),
    (entry) => {
      const rect = entry.getBoundingClientRect();
      return rect.left + rect.width / 2;
    },
  );

const releasePrimaryNavigationPointer = (
  initiatingButton: HTMLButtonElement,
  pointerId: number,
) => {
  try {
    if (initiatingButton.hasPointerCapture(pointerId)) {
      initiatingButton.releasePointerCapture(pointerId);
    }
  } catch {
    // Pointer capture may already be released by the browser.
  }
};

export const PrimaryBottomNavigation = ({
  desktop = false,
  onSettingsIntent,
  activeDestination,
  navigationAction,
  minimized = false,
  onExpand = () => undefined,
  platform,
  onDestinationChange,
}: PrimaryBottomNavigationProps) => {
  const navigationRef = useRef<HTMLElement>(null);
  const gestureRef = useRef<PrimaryNavigationPointerGesture | null>(null);
  const suppressClickRef = useRef(false);
  const [dragPreviewIndex, setDragPreviewIndex] = useState<number | null>(null);
  const activeIndex = primaryNavigationItems.findIndex(
    ({ id }) => id === activeDestination,
  );
  const bubbleIndex = dragPreviewIndex ?? activeIndex;
  const navigationStyle: PrimaryNavigationStyle = {
    "--primary-navigation-active-index": activeIndex,
    "--primary-navigation-bubble-index": bubbleIndex,
    "--primary-navigation-item-count": primaryNavigationItems.length,
  };

  const clearPointerGesture = (
    gesture: PrimaryNavigationPointerGesture,
    releasePointer = true,
  ) => {
    gestureRef.current = null;
    if (releasePointer && gesture.explicitlyCaptured) {
      releasePrimaryNavigationPointer(
        gesture.initiatingButton,
        gesture.pointerId,
      );
    }
    setDragPreviewIndex(null);
  };

  const handlePointerDown = (event: ReactPointerEvent<HTMLElement>) => {
    const currentGesture = gestureRef.current;
    if (
      currentGesture !== null &&
      currentGesture.pointerId !== event.pointerId
    ) {
      clearPointerGesture(currentGesture);
      return;
    }
    if (minimized) return;

    if (
      !canArmPrimaryNavigationPointer(
        event.isPrimary,
        event.pointerType,
        event.button,
      ) ||
      gestureRef.current !== null
    ) {
      return;
    }

    const pointerTarget = event.target;
    if (!(pointerTarget instanceof Element)) return;

    const initiatingButton = pointerTarget.closest<HTMLButtonElement>(
      "[data-primary-navigation-destination]",
    );
    if (
      initiatingButton === null ||
      !event.currentTarget.contains(initiatingButton)
    )
      return;

    const entryCenters = readPrimaryNavigationEntryCenters(event.currentTarget);
    if (entryCenters.length !== primaryNavigationItems.length) return;

    gestureRef.current = {
      committedDestination: activeDestination,
      dragging: false,
      entryCenters,
      explicitlyCaptured: false,
      focusedElement: document.activeElement,
      initiatingButton,
      pointerId: event.pointerId,
      pointerType: event.pointerType,
      startIndex: activeIndex,
      startX: event.clientX,
      startY: event.clientY,
    };
  };

  const handlePointerMove = (event: ReactPointerEvent<HTMLElement>) => {
    const gesture = gestureRef.current;
    if (gesture === null || gesture.pointerId !== event.pointerId) return;

    const horizontalDisplacement = event.clientX - gesture.startX;
    const verticalDisplacement = event.clientY - gesture.startY;

    if (!gesture.dragging) {
      if (
        !hasPrimaryNavigationHorizontalDragIntent(
          horizontalDisplacement,
          verticalDisplacement,
        )
      ) {
        return;
      }

      gesture.dragging = true;
      if (
        gesture.focusedElement instanceof HTMLElement &&
        gesture.focusedElement !== document.body
      ) {
        gesture.focusedElement.focus({ preventScroll: true });
      } else {
        gesture.initiatingButton.blur();
      }
      if (gesture.pointerType === "mouse") {
        try {
          gesture.initiatingButton.setPointerCapture(event.pointerId);
          gesture.explicitlyCaptured = true;
        } catch {
          // Synthetic and embedded mouse events may not support capture.
        }
      }
    }

    event.preventDefault();
    setDragPreviewIndex(
      resolvePrimaryNavigationBubbleIndex(
        gesture.entryCenters,
        gesture.startIndex,
        horizontalDisplacement,
      ),
    );
  };

  const suppressCompletedDragClick = () => {
    suppressClickRef.current = true;
    window.setTimeout(() => {
      suppressClickRef.current = false;
    }, 0);
  };

  const handlePointerUp = (event: ReactPointerEvent<HTMLElement>) => {
    const gesture = gestureRef.current;
    if (gesture === null || gesture.pointerId !== event.pointerId) return;

    if (!gesture.dragging) {
      clearPointerGesture(gesture);
      return;
    }

    event.preventDefault();
    const previewIndex = resolvePrimaryNavigationBubbleIndex(
      gesture.entryCenters,
      gesture.startIndex,
      event.clientX - gesture.startX,
    );

    clearPointerGesture(gesture);
    suppressCompletedDragClick();
    commitPrimaryNavigationDragRelease(
      gesture.committedDestination,
      previewIndex,
      onDestinationChange,
    );
  };

  const handlePointerCancel = (event: ReactPointerEvent<HTMLElement>) => {
    const gesture = gestureRef.current;
    if (gesture === null || gesture.pointerId !== event.pointerId) return;

    clearPointerGesture(gesture);
  };

  const handleLostPointerCapture = (event: ReactPointerEvent<HTMLElement>) => {
    const gesture = gestureRef.current;
    if (
      gesture === null ||
      gesture.pointerId !== event.pointerId ||
      !gesture.explicitlyCaptured ||
      event.target !== gesture.initiatingButton
    )
      return;

    clearPointerGesture(gesture, false);
  };

  const handleClickCapture = (event: ReactMouseEvent<HTMLElement>) => {
    if (minimized) {
      event.preventDefault();
      event.stopPropagation();
      onExpand();
      return;
    }
    if (!suppressClickRef.current || event.detail === 0) return;

    suppressClickRef.current = false;
    event.preventDefault();
    event.stopPropagation();
  };

  useEffect(() => {
    const gesture = gestureRef.current;
    if (minimized && gesture !== null) clearPointerGesture(gesture);

    const navigation = navigationRef.current;
    if (
      !minimized ||
      navigation === null ||
      !(document.activeElement instanceof Element) ||
      !navigation.contains(document.activeElement)
    ) {
      return;
    }

    navigation
      .querySelector<HTMLButtonElement>('[data-selected="true"]')
      ?.focus({ preventScroll: true });
  }, [activeDestination, minimized]);

  if (desktop) {
    return (
      <aside className={styles.desktopDock} data-desktop-navigation="">
        <nav
          aria-label="主要内容"
          data-primary-navigation=""
          data-platform="pc"
        >
          {createPrimaryNavigationEntryElements(
            activeDestination,
            onDestinationChange,
          )}
        </nav>
        <div className={styles.desktopTools}>
          {navigationAction == null ? null : (
            <div className={styles.desktopAction}>{navigationAction}</div>
          )}
          {onSettingsIntent && (
            <button
              className="yoyi-icon-button"
              type="button"
              aria-label="设置"
              title="设置"
              data-desktop-settings=""
              onClick={(event) => onSettingsIntent(event.currentTarget)}
            >
              <Icon name="settings" />
            </button>
          )}
        </div>
      </aside>
    );
  }

  return (
    <>
      <div
        className={styles.dock}
        data-primary-navigation-dock=""
        data-has-action={navigationAction == null ? "false" : "true"}
        data-minimized={minimized ? "true" : "false"}
        data-platform={platform}
        onClickCapture={(event) => {
          // A release outside the capsule must not activate its sibling action.
          if (!suppressClickRef.current || event.detail === 0) return;
          suppressClickRef.current = false;
          event.preventDefault();
          event.stopPropagation();
        }}
      >
        <nav
          ref={navigationRef}
          aria-label="主要内容"
          className={styles.navigation}
          data-active-index={activeIndex}
          data-bubble-preview-index={dragPreviewIndex ?? undefined}
          data-dragging={dragPreviewIndex === null ? undefined : "true"}
          data-item-count={primaryNavigationItems.length}
          data-minimized={minimized ? "true" : "false"}
          data-platform={platform}
          data-primary-navigation=""
          onClickCapture={handleClickCapture}
          onLostPointerCapture={handleLostPointerCapture}
          onPointerCancel={handlePointerCancel}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          style={navigationStyle}
        >
          <span
            aria-hidden="true"
            className={`${styles.glass} yoyi-functional-glass`}
            data-primary-navigation-glass=""
          />
          <span
            aria-hidden="true"
            className={`${styles.bubble} yoyi-nav-bubble`}
            data-primary-navigation-bubble=""
          />
          {createPrimaryNavigationEntryElements(
            activeDestination,
            onDestinationChange,
          )}
        </nav>
        {navigationAction == null ? null : (
          <div className={styles.action} data-primary-navigation-action="">
            {navigationAction}
          </div>
        )}
      </div>
    </>
  );
};

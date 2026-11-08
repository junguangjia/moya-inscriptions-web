"use client";

import { useRef } from "react";
import { Icon } from "@moya/ui";

import { AuthorDialog } from "../../authors/author-dialog";
import styles from "./timeline.module.css";

import type { PointerEvent, ReactNode, RefObject, WheelEvent } from "react";
import type { AuthorDialogNavigationHandle } from "../../authors/author-dialog";

const SWIPE_CLOSE_PX = 72;

/**
 * The timeline's sheet chrome over AuthorDialog, which owns the native modal,
 * the Back entry and the viewport lock. Its full-page frame and header give
 * way to a bottom sheet (a 360 side panel on tablet, a 400 drawer when wide)
 * through this class. The dialog itself is the scrim so the dim needs no
 * ::backdrop, which does not inherit custom properties on the older browsers
 * this product supports.
 */
const stopWheel = (event: WheelEvent<HTMLElement>) => event.stopPropagation();

export const TimelineSheet = ({
  children,
  closeRequested = false,
  navigationDepth,
  navigationRef,
  onBack,
  onClose,
  title,
}: {
  readonly children: ReactNode;
  /** Finish the Back transition first, then `onClose` runs. */
  readonly closeRequested?: boolean;
  readonly navigationDepth?: number;
  readonly navigationRef: RefObject<AuthorDialogNavigationHandle | null>;
  readonly onBack?: (depth: number) => void;
  readonly onClose: () => void;
  readonly title: string;
}) => {
  const panelRef = useRef<HTMLDivElement>(null);
  const swipe = useRef<{ start: number; distance: number } | null>(null);

  const startSwipe = (event: PointerEvent<HTMLDivElement>) => {
    event.currentTarget.setPointerCapture?.(event.pointerId);
    swipe.current = { start: event.clientY, distance: 0 };
    panelRef.current?.setAttribute("data-sheet-swiping", "");
  };
  const moveSwipe = (event: PointerEvent<HTMLDivElement>) => {
    if (swipe.current === null) return;
    swipe.current.distance = Math.max(0, event.clientY - swipe.current.start);
    panelRef.current?.style.setProperty(
      "transform",
      `translateY(${swipe.current.distance}px)`,
    );
  };
  const endSwipe = () => {
    if (swipe.current === null) return;
    const { distance } = swipe.current;
    swipe.current = null;
    panelRef.current?.removeAttribute("data-sheet-swiping");
    panelRef.current?.style.removeProperty("transform");
    if (distance > SWIPE_CLOSE_PX) navigationRef.current?.back();
  };

  return (
    <AuthorDialog
      className={styles.sheetDialog}
      closeRequested={closeRequested}
      headerHidden
      navigationRef={navigationRef}
      onClose={onClose}
      title={title}
      {...(navigationDepth === undefined ? {} : { navigationDepth })}
      {...(onBack === undefined ? {} : { onBack })}
    >
      {/* Local touches and wheels keep the home pager still under the modal. */}
      <div
        className={styles.sheetPanel}
        data-local-horizontal=""
        data-timeline-sheet-panel=""
        onWheel={stopWheel}
        ref={panelRef}
      >
        <div
          aria-hidden="true"
          className={styles.sheetGrip}
          onPointerCancel={endSwipe}
          onPointerDown={startSwipe}
          onPointerMove={moveSwipe}
          onPointerUp={endSwipe}
        >
          <span />
        </div>
        {children}
        {/* The drawer has no grip to pull; the stylesheet shows this only there. */}
        <button
          aria-label="关闭"
          className={`${styles.sheetIconButton} ${styles.sheetClose}`}
          onClick={() => navigationRef.current?.back()}
          type="button"
        >
          <Icon aria-hidden="true" name="close" />
        </button>
      </div>
      <button
        aria-label="关闭"
        className={styles.sheetScrim}
        data-local-horizontal=""
        onClick={() => navigationRef.current?.back()}
        onWheel={stopWheel}
        tabIndex={-1}
        type="button"
      />
    </AuthorDialog>
  );
};

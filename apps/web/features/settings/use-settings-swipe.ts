"use client";
import { useEffect, useRef } from "react";
import type { PointerEvent, RefObject } from "react";
import {
  SETTINGS_BROWSER_EDGE_PX,
  settingsSwipeIntent,
  shouldCommitSettingsBack,
} from "./settings-motion";

const interactive =
  "input, textarea, select, button, a, [contenteditable], [role='slider'], [data-settings-no-swipe]";
export const useSettingsSwipe = ({
  frame,
  page,
  enabled,
  canBack,
  onBack,
}: {
  frame: RefObject<HTMLDivElement | null>;
  page: string;
  enabled: boolean;
  canBack: () => boolean;
  onBack: () => void;
}) => {
  const latest = useRef({ canBack, onBack, enabled, page });
  latest.current = { canBack, onBack, enabled, page };
  const session = useRef<{
    id: number;
    x: number;
    y: number;
    time: number;
    page: string;
    locked: boolean;
    distance: number;
  } | null>(null);
  const raf = useRef<number | null>(null);
  const reset = () => {
    const old = session.current;
    session.current = null;
    if (raf.current !== null) window.cancelAnimationFrame(raf.current);
    raf.current = null;
    const node = frame.current;
    if (old && node?.hasPointerCapture?.(old.id))
      node.releasePointerCapture(old.id);
    node?.removeAttribute("data-settings-dragging");
    node?.style.removeProperty("--settings-drag-x");
  };
  useEffect(() => {
    reset();
    const cancel = () => reset();
    const touch = (event: globalThis.PointerEvent) => {
      if (event.pointerType === "touch" && !event.isPrimary) reset();
    };
    window.addEventListener("pointerdown", touch, true);
    window.addEventListener("resize", cancel);
    window.addEventListener("blur", cancel);
    document.addEventListener("visibilitychange", cancel);
    return () => {
      reset();
      window.removeEventListener("pointerdown", touch, true);
      window.removeEventListener("resize", cancel);
      window.removeEventListener("blur", cancel);
      document.removeEventListener("visibilitychange", cancel);
    };
  }, [page, enabled]);
  return {
    onPointerDown: (event: PointerEvent<HTMLDivElement>) => {
      if (
        !latest.current.enabled ||
        !latest.current.canBack() ||
        event.pointerType !== "touch" ||
        !event.isPrimary ||
        event.clientX < SETTINGS_BROWSER_EDGE_PX ||
        session.current ||
        (event.target instanceof Element &&
          event.target.closest(interactive)) ||
        document.activeElement?.matches(
          "input, textarea, select, [contenteditable]",
        )
      )
        return;
      session.current = {
        id: event.pointerId,
        x: event.clientX,
        y: event.clientY,
        time: event.timeStamp,
        page: latest.current.page,
        locked: false,
        distance: 0,
      };
    },
    onPointerMove: (event: PointerEvent<HTMLDivElement>) => {
      const current = session.current;
      if (!current || event.pointerId !== current.id) return;
      if (!latest.current.canBack() || current.page !== latest.current.page) {
        reset();
        return;
      }
      const distance = event.clientX - current.x;
      if (!current.locked) {
        const intent = settingsSwipeIntent(distance, event.clientY - current.y);
        if (intent === "cancel") {
          reset();
          return;
        }
        if (intent !== "back") return;
        current.locked = true;
        frame.current?.setPointerCapture?.(current.id);
      }
      current.distance = Math.max(0, distance);
      event.preventDefault();
      if (raf.current === null)
        raf.current = window.requestAnimationFrame(() => {
          raf.current = null;
          if (!session.current) return;
          frame.current?.setAttribute("data-settings-dragging", "true");
          frame.current?.style.setProperty(
            "--settings-drag-x",
            `${session.current.distance}px`,
          );
        });
    },
    onPointerUp: (event: PointerEvent<HTMLDivElement>) => {
      const current = session.current;
      if (!current || current.id !== event.pointerId) return;
      const commit =
        current.locked &&
        current.page === latest.current.page &&
        latest.current.canBack() &&
        shouldCommitSettingsBack(
          current.distance,
          frame.current?.clientWidth || 390,
          event.timeStamp - current.time,
        );
      reset();
      if (commit) latest.current.onBack();
    },
    onPointerCancel: reset,
    onLostPointerCapture: reset,
  };
};

"use client";

import { useEffect, useRef } from "react";
import type {
  PointerEvent as ReactPointerEvent,
  MouseEvent as ReactMouseEvent,
} from "react";

/** Same hold/tolerance as existing card gestures; scrolling always wins. */
export const useDraftSelectionGesture = (
  identity: string,
  onSelect: (id: string) => void,
  allowed: () => boolean,
) => {
  const dispose = useRef<(() => void) | null>(null);
  const suppress = useRef<string | null>(null);
  const held = useRef<{ id: string; pointerId: number } | null>(null);
  const latest = useRef({ onSelect, allowed });
  latest.current = { onSelect, allowed };
  const cancel = () => {
    dispose.current?.();
    dispose.current = null;
    held.current = null;
  };
  useEffect(() => {
    suppress.current = null;
    return cancel;
  }, [identity]);
  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (held.current !== null && held.current.pointerId !== event.pointerId) {
      suppress.current = held.current.id;
      cancel();
      return;
    }
    cancel();
    suppress.current = null;
    if (!event.isPrimary || event.button !== 0 || !latest.current.allowed())
      return;
    if (
      !(event.target instanceof Element) ||
      event.target.closest("button,a,input,label,select,textarea")
    )
      return;
    const row = event.target.closest<HTMLElement>("[data-draft-id]");
    const id = row?.dataset.draftId;
    if (!row || !id || row.hasAttribute("data-draft-active")) return;
    const { pointerId, clientX, clientY } = event;
    held.current = { id, pointerId };
    const scale = window.visualViewport?.scale ?? 1;
    const timer = window.setTimeout(() => {
      if (
        !row.isConnected ||
        !latest.current.allowed() ||
        document.visibilityState === "hidden"
      )
        return cancel();
      suppress.current = id;
      latest.current.onSelect(id);
    }, 400);
    const move = (next: PointerEvent) => {
      if (
        next.pointerId === pointerId &&
        Math.hypot(next.clientX - clientX, next.clientY - clientY) > 10 / scale
      ) {
        suppress.current = id;
        cancel();
      }
    };
    const finish = (next: PointerEvent) => {
      if (next.pointerId === pointerId) cancel();
    };
    const second = (next: PointerEvent) => {
      if (next.pointerId !== pointerId) {
        suppress.current = id;
        cancel();
      }
    };
    const stop = () => {
      suppress.current = id;
      cancel();
    };
    document.addEventListener("pointermove", move);
    document.addEventListener("pointerup", finish);
    document.addEventListener("pointercancel", stop);
    document.addEventListener("lostpointercapture", stop);
    document.addEventListener("pointerdown", second);
    document.addEventListener("visibilitychange", stop);
    document.addEventListener("keydown", stop);
    window.addEventListener("scroll", stop, true);
    window.addEventListener("wheel", stop, true);
    window.addEventListener("resize", stop);
    dispose.current = () => {
      window.clearTimeout(timer);
      document.removeEventListener("pointermove", move);
      document.removeEventListener("pointerup", finish);
      document.removeEventListener("pointercancel", stop);
      document.removeEventListener("lostpointercapture", stop);
      document.removeEventListener("pointerdown", second);
      document.removeEventListener("visibilitychange", stop);
      document.removeEventListener("keydown", stop);
      window.removeEventListener("scroll", stop, true);
      window.removeEventListener("wheel", stop, true);
      window.removeEventListener("resize", stop);
    };
  };
  const onClickCapture = (event: ReactMouseEvent<HTMLDivElement>) => {
    if (!(event.target instanceof Element)) return;
    const id =
      event.target.closest<HTMLElement>("[data-draft-id]")?.dataset.draftId;
    if (id && suppress.current === id) {
      suppress.current = null;
      event.preventDefault();
      event.stopPropagation();
    }
  };
  return {
    onPointerDown,
    onClickCapture,
    onContextMenu: (event: ReactMouseEvent) => event.preventDefault(),
  };
};

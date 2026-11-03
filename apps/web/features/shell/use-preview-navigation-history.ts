"use client";

import { useEffect, useRef } from "react";
import { flushSync } from "react-dom";
import { requestIdentity } from "./request-identity";

/** Local preview children sit above the shell's existing parent history entry. */
export function usePreviewNavigationHistory({
  depth,
  onBack,
  nativeModal = false,
  stateKey = "yoyiPreviewNavigation",
}: {
  depth: number;
  onBack: (targetDepth: number) => void;
  /** This child owns the currently open native viewer, rather than sitting below it. */
  nativeModal?: boolean;
  /** A nested modal preserves the underlying preview's own navigation marker. */
  stateKey?: string;
}) {
  const id = useRef(requestIdentity());
  const currentDepth = useRef(0);
  const pending = useRef(false);
  const correcting = useRef(false);
  const generation = useRef(0);
  const latest = useRef({ depth, onBack, nativeModal });
  latest.current = { depth, onBack, nativeModal };
  useEffect(() => {
    const run = ++generation.current;
    const pop = (event: PopStateEvent) => {
      // Native modal navigation owns its own capture listener and history.
      if (document.querySelector("dialog[open]") && !latest.current.nativeModal)
        return;
      if (correcting.current) {
        event.stopImmediatePropagation();
        correcting.current = false;
        pending.current = false;
        return;
      }
      const entry = event.state?.[stateKey];
      if (entry?.id !== id.current) {
        // A history-menu jump may skip the local root as well as its child.
        // The shell owns that destination and must receive its popstate.
        const ownedNativeChild =
          latest.current.nativeModal && currentDepth.current > 0;
        currentDepth.current = 0;
        pending.current = false;
        if (ownedNativeChild) {
          // A history-menu jump can skip this child's local base. Close the
          // native layer before the parent handles that destination; replay
          // once so parent capture listeners that ran earlier see no modal.
          event.stopImmediatePropagation();
          flushSync(() => latest.current.onBack(0));
          queueMicrotask(() => {
            window.dispatchEvent(
              new PopStateEvent("popstate", { state: event.state }),
            );
          });
        }
        return;
      }
      const targetDepth = entry.depth;
      // Another child can own this step while retaining our unchanged marker.
      if (currentDepth.current === targetDepth) return;
      event.stopImmediatePropagation();
      if (targetDepth > currentDepth.current) {
        // The local state for a dismissed child is no longer on the stack.
        correcting.current = true;
        window.history.go(currentDepth.current - targetDepth);
        return;
      }
      pending.current = false;
      currentDepth.current = targetDepth;
      if (latest.current.depth !== targetDepth)
        latest.current.onBack(targetDepth);
    };
    window.addEventListener("popstate", pop, true);
    return () => {
      window.removeEventListener("popstate", pop, true);
      queueMicrotask(() => {
        if (generation.current !== run) return;
        const entry = window.history.state?.[stateKey];
        if (entry?.id !== id.current || !entry.depth) return;
        const consume = (event: PopStateEvent) => {
          event.stopImmediatePropagation();
          window.removeEventListener("popstate", consume, true);
        };
        window.addEventListener("popstate", consume, true);
        // Consume children only. The parent topic belongs to ProductShell.
        if (!latest.current.nativeModal || !pending.current)
          window.history.go(-entry.depth);
      });
    };
  }, []);
  useEffect(() => {
    const targetDepth = Math.max(0, depth);
    if (targetDepth > currentDepth.current) {
      if (currentDepth.current === 0) {
        // Mark, but do not push, the shell-owned base so it is distinguishable
        // from an older shell destination when browser history skips entries.
        window.history.replaceState(
          {
            ...window.history.state,
            [stateKey]: { id: id.current, depth: 0 },
          },
          "",
          window.location.href,
        );
      }
      for (let next = currentDepth.current + 1; next <= targetDepth; next++) {
        window.history.pushState(
          {
            ...window.history.state,
            [stateKey]: { id: id.current, depth: next },
          },
          "",
          window.location.href,
        );
      }
      currentDepth.current = targetDepth;
    } else if (targetDepth < currentDepth.current && !pending.current) {
      pending.current = true;
      window.history.go(targetDepth - currentDepth.current);
    }
  }, [depth]);
  return {
    /** False means the parent shell, rather than a local child, owns Back. */
    requestBack: () => {
      if (currentDepth.current === 0) return false;
      if (!pending.current) {
        pending.current = true;
        window.history.back();
      }
      return true;
    },
  };
}

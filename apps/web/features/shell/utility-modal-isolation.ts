"use client";

import { useCallback, useLayoutEffect, useRef } from "react";
import { acquireDesktopViewportScrollLock } from "./desktop-viewport-scroll-lock";

import type { RefObject } from "react";

const backgroundSelector =
  "[data-qa-controls], [data-primary-navigation-pager], [data-primary-navigation-dock], [data-primary-navigation], [data-t02p-qa-search], [data-catalog-search], [data-inscription-filter], [data-qa-user-interface], [data-user-trigger]";
const focusableSelector =
  "button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]";
const upperOverlayAttributes = [
  "data-detail-open",
  "data-topic-open",
  "data-viewer-open",
  "data-settings-open",
];
const hasUpperOverlay = (shell: HTMLElement | null) =>
  shell?.isConnected === true &&
  upperOverlayAttributes.some((name) => shell.getAttribute(name) === "true");

interface TargetLock {
  count: number;
  readonly ariaHidden: string | null;
  readonly inert: boolean;
  readonly inertAttribute: string | null;
}

const targetLocks = new Map<HTMLElement, TargetLock>();
const activeModals = new Set<HTMLElement>();
let bodySnapshot: {
  readonly overflow: string;
  readonly scrollX: number;
  readonly scrollY: number;
  readonly releaseViewport: () => void;
} | null = null;
let releaseFrame: number | null = null;
let upperOverlayObserver: MutationObserver | null = null;

const restoreBody = () => {
  if (activeModals.size !== 0 || bodySnapshot === null) return;
  const snapshot = bodySnapshot;
  bodySnapshot = null;
  document.body.style.overflow = snapshot.overflow;
  if (
    window.scrollX !== snapshot.scrollX ||
    window.scrollY !== snapshot.scrollY
  ) {
    window.scrollTo(snapshot.scrollX, snapshot.scrollY);
  }
  snapshot.releaseViewport();
};

const scheduleBodyRelease = (shell: HTMLElement | null) => {
  if (releaseFrame !== null) window.cancelAnimationFrame(releaseFrame);
  releaseFrame = window.requestAnimationFrame(() => {
    releaseFrame = null;
    if (activeModals.size !== 0) return;
    if (shell !== null && hasUpperOverlay(shell)) {
      upperOverlayObserver?.disconnect();
      upperOverlayObserver = new MutationObserver(() => {
        if (hasUpperOverlay(shell)) return;
        upperOverlayObserver?.disconnect();
        upperOverlayObserver = null;
        scheduleBodyRelease(shell);
      });
      upperOverlayObserver.observe(shell, {
        attributes: true,
        attributeFilter: upperOverlayAttributes,
      });
      // A client-side route can remove the whole shell without changing its
      // owner flags. Watch only its ancestor chain's direct child removals.
      for (
        let parent = shell.parentElement;
        parent !== null;
        parent = parent.parentElement
      ) {
        upperOverlayObserver.observe(parent, { childList: true });
      }
      return;
    }
    restoreBody();
  });
};

const isInteractive = (element: HTMLElement) =>
  !element.closest('[inert], [hidden], [aria-hidden="true"]') &&
  !element.hasAttribute("disabled") &&
  window.getComputedStyle(element).visibility !== "hidden" &&
  window.getComputedStyle(element).display !== "none";

export interface UtilityModalIsolationOptions {
  readonly open: boolean;
  readonly overlayRef: RefObject<HTMLElement | null>;
  readonly initialFocusRef: RefObject<HTMLElement | null>;
  readonly openerRef: RefObject<HTMLElement | null>;
  readonly onRequestClose: () => void;
  readonly suspended?: boolean;
}

/** Utility focus/isolation; ProductShell continues to own upper overlays. */
export const useUtilityModalIsolation = ({
  open,
  overlayRef,
  initialFocusRef,
  openerRef,
  onRequestClose,
  suspended = false,
}: UtilityModalIsolationOptions) => {
  const latest = useRef({ onRequestClose, suspended });
  const restoreOpener = useRef(false);
  const focusFrame = useRef<number | null>(null);

  useLayoutEffect(() => {
    latest.current = { onRequestClose, suspended };
  });

  const close = useCallback(() => {
    restoreOpener.current = true;
    latest.current.onRequestClose();
  }, []);

  useLayoutEffect(() => {
    if (!open || overlayRef.current === null) return;
    const overlay = overlayRef.current;
    const harness = overlay.closest<HTMLElement>("[data-t02p-qa-harness]");
    const shell = overlay.closest<HTMLElement>("[data-product-shell]");
    const scope = harness ?? shell;
    const targets = Array.from(
      scope?.querySelectorAll<HTMLElement>(backgroundSelector) ?? [],
    ).filter(
      (target) => !target.contains(overlay) && !overlay.contains(target),
    );
    const sourceScroll = Array.from(
      scope?.querySelectorAll<HTMLElement>(
        "[data-primary-destination], [data-home-feed-panel], [data-primary-navigation-pager]",
      ) ?? [],
    ).map((element) => ({
      element,
      left: element.scrollLeft,
      top: element.scrollTop,
    }));
    if (releaseFrame !== null) window.cancelAnimationFrame(releaseFrame);
    releaseFrame = null;
    upperOverlayObserver?.disconnect();
    upperOverlayObserver = null;
    if (bodySnapshot === null) {
      bodySnapshot = {
        overflow: document.body.style.overflow,
        scrollX: window.scrollX,
        scrollY: window.scrollY,
        releaseViewport: acquireDesktopViewportScrollLock(),
      };
    }
    activeModals.add(overlay);
    document.body.style.overflow = "hidden";
    for (const target of targets) {
      const existing = targetLocks.get(target);
      if (existing !== undefined) existing.count += 1;
      else {
        targetLocks.set(target, {
          count: 1,
          ariaHidden: target.getAttribute("aria-hidden"),
          inert: target.inert,
          inertAttribute: target.getAttribute("inert"),
        });
        target.inert = true;
        target.setAttribute("inert", "");
        target.setAttribute("aria-hidden", "true");
      }
    }

    const isSuspended = () =>
      latest.current.suspended ||
      hasUpperOverlay(shell) ||
      !overlay.isConnected ||
      !isInteractive(overlay);
    // The dock trigger also focuses synchronously in the native click path.
    // This handles scenario-driven opens and User without delaying that path.
    if (!isSuspended()) initialFocusRef.current?.focus({ preventScroll: true });

    // History can restore Detail above an already-open QA surface without
    // closing it. Observe existing owner/isolation attributes, not a new stack.
    let resumeFrame: number | null = null;
    let wasSuspended = isSuspended();
    let lastFocus = initialFocusRef.current;
    const rememberFocus = (event: FocusEvent) => {
      if (!isSuspended() && event.target instanceof HTMLElement) {
        lastFocus = event.target;
      }
    };
    const ownershipObserver = new MutationObserver(() => {
      const nowSuspended = isSuspended();
      if (nowSuspended && resumeFrame !== null) {
        window.cancelAnimationFrame(resumeFrame);
        resumeFrame = null;
      } else if (wasSuspended && !nowSuspended) {
        resumeFrame = window.requestAnimationFrame(() => {
          resumeFrame = null;
          // Recheck at execution: another upper layer may have opened since
          // notification, or its own return path may already have set focus.
          if (isSuspended() || overlay.contains(document.activeElement)) return;
          const target =
            lastFocus?.isConnected &&
            overlay.contains(lastFocus) &&
            isInteractive(lastFocus)
              ? lastFocus
              : initialFocusRef.current;
          (target ?? overlay).focus({ preventScroll: true });
        });
      }
      wasSuspended = nowSuspended;
    });
    for (
      let ancestor: HTMLElement | null = overlay;
      ancestor !== null;
      ancestor = ancestor.parentElement
    ) {
      ownershipObserver.observe(ancestor, {
        attributes: true,
        attributeFilter: [
          "inert",
          "hidden",
          "aria-hidden",
          ...upperOverlayAttributes,
        ],
      });
      if (ancestor === shell) break;
    }
    overlay.addEventListener("focusin", rememberFocus);

    const handleKeyDown = (event: KeyboardEvent) => {
      if (isSuspended() || event.defaultPrevented || event.isComposing) return;
      if (event.key === "Escape") {
        event.preventDefault();
        close();
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = Array.from(
        overlay.querySelectorAll<HTMLElement>(focusableSelector),
      ).filter((element) => element.tabIndex >= 0 && isInteractive(element));
      const first = focusable[0];
      const last = focusable.at(-1);
      if (first === undefined || last === undefined) {
        event.preventDefault();
        overlay.focus({ preventScroll: true });
      } else if (
        event.shiftKey &&
        (document.activeElement === first ||
          !overlay.contains(document.activeElement))
      ) {
        event.preventDefault();
        last.focus({ preventScroll: true });
      } else if (
        !event.shiftKey &&
        (document.activeElement === last ||
          !overlay.contains(document.activeElement))
      ) {
        event.preventDefault();
        first.focus({ preventScroll: true });
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      overlay.removeEventListener("focusin", rememberFocus);
      ownershipObserver.disconnect();
      if (resumeFrame !== null) window.cancelAnimationFrame(resumeFrame);
      activeModals.delete(overlay);
      for (const target of targets) {
        const snapshot = targetLocks.get(target);
        if (snapshot === undefined) continue;
        snapshot.count -= 1;
        if (snapshot.count !== 0) continue;
        target.inert = snapshot.inert;
        if (snapshot.inertAttribute === null) target.removeAttribute("inert");
        else target.setAttribute("inert", snapshot.inertAttribute);
        if (snapshot.ariaHidden === null) target.removeAttribute("aria-hidden");
        else target.setAttribute("aria-hidden", snapshot.ariaHidden);
        targetLocks.delete(target);
      }
      sourceScroll.forEach(({ element, left, top }) => {
        if (element.scrollLeft !== left) element.scrollLeft = left;
        if (element.scrollTop !== top) element.scrollTop = top;
      });
      scheduleBodyRelease(shell);
    };
  }, [close, initialFocusRef, open, overlayRef]);

  useLayoutEffect(() => {
    if (open || !restoreOpener.current) return;
    restoreOpener.current = false;
    focusFrame.current = window.requestAnimationFrame(() => {
      focusFrame.current = null;
      const opener = openerRef.current;
      if (
        activeModals.size === 0 &&
        !latest.current.suspended &&
        opener?.isConnected &&
        !hasUpperOverlay(opener.closest<HTMLElement>("[data-product-shell]")) &&
        isInteractive(opener)
      ) {
        opener.focus({ preventScroll: true });
      }
    });
    return () => {
      if (focusFrame.current !== null)
        window.cancelAnimationFrame(focusFrame.current);
      focusFrame.current = null;
    };
  }, [open, openerRef]);

  return { close };
};

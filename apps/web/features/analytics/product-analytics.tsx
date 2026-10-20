"use client";

import { useEffect, useRef } from "react";
import { useProductShell } from "../product-shell/product-shell";
import { useOptionalAuthors } from "../authors/author-context";
import {
  analyticsContentContext,
  clearAnalyticsQueue,
  readAnalyticsContext,
  startAnalytics,
  stopAnalytics,
  trackAnalytics,
} from "./client";
import { createForegroundClock } from "./runtime";
import type { AnalyticsInput } from "./runtime";

const contentTarget = (element: HTMLElement) => {
  const type = element.dataset.contentType ?? "catalog";
  const id = element.dataset.contentId ?? element.dataset.catalogId;
  return id && (type === "catalog" || type === "work")
    ? ({ targetType: type, targetId: id } as const)
    : null;
};

/** A single observer for the existing cards; list position is their source order. */
export const observeVisibleContent = (
  root: HTMLElement,
  surface: () => AnalyticsInput["surface"],
) => {
  if (typeof IntersectionObserver === "undefined") return () => {};
  const timers = new Map<HTMLElement, ReturnType<typeof setTimeout>>();
  const observed = new Set<HTMLElement>();
  const seen = new Set<string>();
  const eligible = (element: HTMLElement) => {
    if (
      document.visibilityState !== "visible" ||
      !element.isConnected ||
      element.closest('[hidden], [inert], [aria-hidden="true"]')
    )
      return false;
    const box = element.getBoundingClientRect();
    const area =
      Math.max(
        0,
        Math.min(box.right, window.innerWidth) - Math.max(box.left, 0),
      ) *
      Math.max(
        0,
        Math.min(box.bottom, window.innerHeight) - Math.max(box.top, 0),
      );
    return (
      box.width > 0 && box.height > 0 && area / (box.width * box.height) >= 0.5
    );
  };
  const cancel = (element: HTMLElement) => {
    const timer = timers.get(element);
    if (timer) clearTimeout(timer);
    timers.delete(element);
  };
  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        const element = entry.target as HTMLElement;
        if (
          !entry.isIntersecting ||
          entry.intersectionRatio < 0.5 ||
          !eligible(element)
        ) {
          cancel(element);
          continue;
        }
        if (timers.has(element)) continue;
        timers.set(
          element,
          setTimeout(() => {
            timers.delete(element);
            if (!eligible(element)) return;
            const target = contentTarget(element);
            if (!target) return;
            const context = readAnalyticsContext(element);
            const elementSurface = element.closest("[data-search-results]")
              ? "search"
              : surface();
            const feed =
              element.closest<HTMLElement>("[data-active-home-feed]")?.dataset
                .activeHomeFeed ?? "";
            const identity = `${elementSurface}:${feed}:${target.targetType}:${target.targetId}:${context.sequenceId ?? ""}:${context.requestId ?? ""}:${context.position ?? ""}`;
            if (seen.has(identity)) return;
            seen.add(identity);
            if (seen.size > 1_000) seen.delete(seen.values().next().value!);
            trackAnalytics({
              ...context,
              ...target,
              name: "content_impression",
              surface: elementSurface,
            });
          }, 1_000),
        );
      }
    },
    { threshold: [0.5] },
  );
  const scan = () => {
    for (const element of observed)
      if (!element.isConnected) {
        observer.unobserve(element);
        observed.delete(element);
        cancel(element);
      }
    root
      .querySelectorAll<HTMLElement>(
        "article[data-content-id], article[data-catalog-card][data-catalog-id]",
      )
      .forEach((element) => {
        if (!observed.has(element)) {
          observed.add(element);
          observer.observe(element);
        }
      });
  };
  scan();
  const mutations = new MutationObserver((changes) => {
    scan();
    if (changes.some((change) => change.type === "attributes")) {
      for (const element of observed) {
        cancel(element);
        observer.unobserve(element);
        observer.observe(element);
      }
    }
  });
  mutations.observe(root, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: [
      "data-analytics-sequence",
      "data-analytics-position",
      "data-analytics-search-request",
      "data-active-home-feed",
      "inert",
      "aria-hidden",
    ],
  });
  const visibility = () => {
    for (const element of timers.keys()) cancel(element);
    // Re-observe on a visible return so an unchanged intersection starts a new second.
    if (document.visibilityState === "visible")
      for (const element of observed) {
        observer.unobserve(element);
        observer.observe(element);
      }
  };
  document.addEventListener("visibilitychange", visibility);
  return () => {
    mutations.disconnect();
    observer.disconnect();
    for (const element of timers.keys()) cancel(element);
    document.removeEventListener("visibilitychange", visibility);
  };
};

/** Composed only in FormalPage's utility slot, inside the current Shell/providers. */
export const ProductAnalytics = ({ enabled }: { enabled: boolean }) => {
  const shell = useProductShell();
  const authors = useOptionalAuthors();
  const account = useRef<string | undefined>(undefined);
  const previousPage = useRef("");
  useEffect(() => {
    if (!authors || authors.checking || authors.sessionError) return;
    const next = authors.viewer?.id ?? "guest";
    // A queued action must not acquire another account when the cookie changes.
    if (account.current !== undefined && account.current !== next)
      clearAnalyticsQueue();
    account.current = next;
  }, [authors?.viewer?.id, authors?.checking, authors?.sessionError]);
  useEffect(() => {
    const runtime = startAnalytics(enabled);
    if (!runtime) return;
    const timer = window.setInterval(() => void runtime.flush(), 30_000);
    const final = () => {
      queueMicrotask(() => runtime.beacon());
    };
    const visibility = () => {
      if (document.visibilityState === "hidden") final();
    };
    const storage = (event: StorageEvent) => {
      if (event.key === "moya.analytics.disabled") runtime.exclude();
    };
    document.addEventListener("visibilitychange", visibility);
    window.addEventListener("pagehide", final);
    window.addEventListener("storage", storage);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", visibility);
      window.removeEventListener("pagehide", final);
      window.removeEventListener("storage", storage);
      runtime.beacon();
      stopAnalytics();
    };
  }, [enabled]);

  useEffect(() => {
    if (!enabled || shell.activeEditor) return;
    const root = document.querySelector<HTMLElement>("[data-product-shell]");
    if (!root) return;
    const surface = (): AnalyticsInput["surface"] => {
      if (shell.activeProfile || shell.activeDestination === "user")
        return "profile";
      if (shell.activeContent) return "detail";
      if (shell.activeTopicId || shell.activeDestination === "discussion")
        return "thread";
      const feed = root.querySelector<HTMLElement>("[data-active-home-feed]")
        ?.dataset.activeHomeFeed;
      return feed === "inscriptions" || feed === "calligraphy"
        ? "browse"
        : "home";
    };
    const page = () => {
      const target = shell.activeContent ?? shell.activeFeedViewer?.target;
      const next = `${surface()}:${target?.type ?? ""}:${target?.id ?? ""}:${shell.activeTopicId ?? ""}:${shell.activeViewerMediaId !== null ? "viewer" : ""}:${shell.activeFeedViewer ? "feed-viewer" : ""}:${shell.activeProfile?.entryId ?? ""}:${shell.activeProfile?.tab ?? ""}:${shell.settingsOpen}:${root.querySelector<HTMLElement>("[data-active-home-feed]")?.dataset.activeHomeFeed ?? ""}`;
      if (next === previousPage.current) return;
      previousPage.current = next;
      trackAnalytics({
        name: "page_view",
        surface: shell.settingsOpen ? "other" : surface(),
        ...(target ? { targetType: target.type, targetId: target.id } : {}),
      });
    };
    // The Shell restores a direct Detail/Viewer in its mount effect. Coalesce
    // that transition so a deep link is not first counted as a Home visit.
    let frame = 0;
    const schedulePage = () => {
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(page);
    };
    schedulePage();
    const feedChanges = new MutationObserver(schedulePage);
    feedChanges.observe(root, {
      subtree: true,
      attributes: true,
      attributeFilter: ["data-active-home-feed"],
    });
    const overlays =
      shell.activeContent ||
      shell.activeTopicId ||
      shell.activeProfile ||
      shell.activeFeedViewer ||
      shell.settingsOpen;
    const dispose = overlays ? () => {} : observeVisibleContent(root, surface);
    return () => {
      dispose();
      feedChanges.disconnect();
      window.cancelAnimationFrame(frame);
    };
  }, [
    enabled,
    shell.activeContent,
    shell.activeDestination,
    shell.activeEditor,
    shell.activeFeedViewer,
    shell.activeProfile,
    shell.activeTopicId,
    shell.activeViewerMediaId,
    shell.settingsOpen,
  ]);
  return null;
};

/** Call only after real detail data loaded. Dwell events contain foreground deltas. */
export const useContentAnalytics = (
  targetType: "catalog" | "work" | "article",
  targetId: string,
  loaded: boolean,
) => {
  useEffect(() => {
    if (!loaded) return;
    const context = analyticsContentContext({ type: targetType, id: targetId });
    const target = { targetType, targetId };
    trackAnalytics({
      ...context,
      ...target,
      name: "content_open",
      surface: "detail",
    });
    const clock = createForegroundClock(
      () => performance.now(),
      document.visibilityState === "visible",
    );
    let emitted = 0;
    const report = () => {
      const total = clock.read();
      if (total - emitted >= 1_000) {
        trackAnalytics({
          ...context,
          ...target,
          name: "content_dwell",
          surface: "detail",
          dwellMs: total - emitted,
        });
        emitted = total;
      }
    };
    const visibility = () => {
      clock.visibility(document.visibilityState === "visible");
      if (document.visibilityState === "hidden") report();
    };
    document.addEventListener("visibilitychange", visibility);
    window.addEventListener("pagehide", report);
    return () => {
      report();
      document.removeEventListener("visibilitychange", visibility);
      window.removeEventListener("pagehide", report);
    };
  }, [targetType, targetId, loaded]);
};

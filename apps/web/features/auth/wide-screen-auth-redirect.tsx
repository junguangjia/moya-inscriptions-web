"use client";

import { useLayoutEffect, useSyncExternalStore } from "react";

import {
  WIDE_LAYOUT_MINIMUM_WIDTH,
  isWideLayout,
  resolveRuntimePresentationPlatform,
} from "../shell/device-platform";

/**
 * Sends a wide screen on /login or /register back to Home before the first
 * paint (pc-browse-only-v1). It runs in the body after the head boot script,
 * which has already set the iPadOS-aware `data-platform`. The marker records
 * the decision once per document ("home" also hides the body until the
 * replacement page loads); a page restored from the back-forward cache decides
 * again.
 */
export const WIDE_SCREEN_AUTH_REDIRECT_SCRIPT = `(() => {
  const root = document.documentElement;
  const decide = () => {
    const platform = root.dataset.platform;
    const wide =
      platform === "pc" ||
      (platform === "tablet" && window.innerWidth >= ${WIDE_LAYOUT_MINIMUM_WIDTH});
    root.dataset.authRedirect = wide ? "home" : "none";
    if (wide) location.replace("/");
  };
  decide();
  window.addEventListener("pageshow", (event) => {
    if (event.persisted) decide();
  });
})();`;

const subscribe = () => () => undefined;

/**
 * The server and the hydrating client render the inline script. A client
 * render (a soft navigation) leaves it out, since React never runs a script it
 * creates, and the layout effect makes the same check instead. Load-time only:
 * resizing during sign-in or registration does not leave the page.
 */
export const WideScreenAuthRedirect = () => {
  const serverRendered = useSyncExternalStore(
    subscribe,
    () => false,
    () => true,
  );

  useLayoutEffect(() => {
    const root = document.documentElement;
    // The first check in a document decides, so switching between 登录 and
    // 注册 never leaves a form that was allowed when it loaded.
    if (root.dataset.authRedirect !== undefined) return;
    const decide = () => {
      const width = window.innerWidth;
      const platform = resolveRuntimePresentationPlatform(navigator, width);
      const wide = isWideLayout(platform, width);
      root.dataset.authRedirect = wide ? "home" : "none";
      if (wide) window.location.replace("/");
    };
    decide();
    // Like the inline script: a document restored from the back-forward cache
    // decides again, so it is never left hidden.
    const restored = (event: PageTransitionEvent) => {
      if (event.persisted) decide();
    };
    window.addEventListener("pageshow", restored);
    return () => window.removeEventListener("pageshow", restored);
  }, []);

  return serverRendered ? (
    <script
      dangerouslySetInnerHTML={{ __html: WIDE_SCREEN_AUTH_REDIRECT_SCRIPT }}
      id="yoyi-auth-redirect"
    />
  ) : null;
};

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
 * which has already set the iPadOS-aware `data-platform`; the marker hides the
 * body until the replacement page loads.
 */
export const WIDE_SCREEN_AUTH_REDIRECT_SCRIPT = `(() => {
  const root = document.documentElement;
  const platform = root.dataset.platform;
  const wide =
    platform === "pc" ||
    (platform === "tablet" && window.innerWidth >= ${WIDE_LAYOUT_MINIMUM_WIDTH});
  if (!wide) return;
  root.dataset.authRedirect = "home";
  location.replace("/");
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
    if (root.dataset.authRedirect !== undefined) return;
    const width = window.innerWidth;
    const platform = resolveRuntimePresentationPlatform(navigator, width);
    if (!isWideLayout(platform, width)) return;
    root.dataset.authRedirect = "home";
    window.location.replace("/");
  }, []);

  return serverRendered ? (
    <script
      dangerouslySetInnerHTML={{ __html: WIDE_SCREEN_AUTH_REDIRECT_SCRIPT }}
      id="yoyi-auth-redirect"
    />
  ) : null;
};

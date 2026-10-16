import type { BrowserContext } from "@playwright/test";

/** Web's Community session cookie name (apps/web community-session-cookie.ts). */
const SESSION_COOKIE_NAME = "yoyi-session";

/**
 * A well-formed session cookie, as every signed-in browser carries one
 * (pc-browse-only-v1). The fixture Backend never reads it; Web learns from it
 * only that a session may exist, so a wide screen waits for /me before it
 * decides browse-only. Specs that answer /me as signed in add it.
 */
export const addSessionCookie = (context: BrowserContext, baseURL: string) =>
  context.addCookies([
    {
      name: SESSION_COOKIE_NAME,
      value: "s".repeat(43),
      url: baseURL,
    },
  ]);

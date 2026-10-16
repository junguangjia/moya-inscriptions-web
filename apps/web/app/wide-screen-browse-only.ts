import { readVisitorAccess } from "./product-access";

import type { VisitorAccess } from "./product-access";
import type { WideScreenBrowseOnlyHint } from "../features/shell/browse-only";

/**
 * Wide-screen browse-only for visitors without an account (pc-browse-only-v1)
 * is on unless the server environment turns it off. Read per request; the Web
 * process re-reads its environment file only when restarted.
 */
export const WIDE_SCREEN_BROWSE_ONLY_ENV = "MOYA_WIDE_SCREEN_BROWSE_ONLY";

const switchedOff = new Set(["off", "false", "0"]);

export const isWideScreenBrowseOnlyEnabled = (
  value: string | undefined = process.env[WIDE_SCREEN_BROWSE_ONLY_ENV],
): boolean => !switchedOff.has((value ?? "").trim().toLowerCase());

/**
 * The hint the Formal root passes to the client, or undefined when the policy
 * does not apply: switched off, or closed beta, whose gate needs sign-in. Only
 * whether a session cookie exists leaves the server, never the token.
 */
export const wideScreenBrowseOnlyHint = (
  access: Extract<VisitorAccess, { state: "granted" }>,
): WideScreenBrowseOnlyHint | undefined =>
  isWideScreenBrowseOnlyEnabled() && !access.closedBeta
    ? { sessionHint: access.token !== undefined }
    : undefined;

/** How long sign-in waits for the access answer before it shows the form. */
export const AUTH_PAGE_ACCESS_WAIT_MS = 1_500;

/**
 * Whether /login and /register send a wide screen back to Home. Only for the
 * public product: a closed beta, a refused account or an unknown access state
 * keeps sign-in reachable, and nothing is asked of the Backend when off. A slow
 * answer also keeps the form rather than delaying it.
 */
export const readAuthPageWideScreenRedirect = async (
  waitMs: number = AUTH_PAGE_ACCESS_WAIT_MS,
): Promise<boolean> => {
  if (!isWideScreenBrowseOnlyEnabled()) return false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), waitMs);
  });
  try {
    const access = await Promise.race([readVisitorAccess(), late]);
    return access !== null && access.state === "granted" && !access.closedBeta;
  } finally {
    clearTimeout(timer);
  }
};

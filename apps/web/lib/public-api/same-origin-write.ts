/**
 * An Origin, when present, must be this exact origin. A request without one is
 * not a browser cross-origin write (browsers send none on a same-origin GET)
 * and still needs the cookie.
 *
 * Next's development Request.url may normalize the hostname to localhost, so
 * the browser's requested authority comes from Host, which scripts cannot
 * forge; forwarded-host is never trusted.
 */
const originMatches = (request: Request): boolean => {
  const origin = request.headers.get("origin");
  if (origin === null) return true;
  const incoming = new URL(request.url);
  const authority = request.headers.get("host") ?? incoming.host;
  try {
    const source = new URL(origin);
    return (
      source.origin === origin &&
      source.host === authority &&
      source.protocol === incoming.protocol
    );
  } catch {
    return false;
  }
};

/**
 * The community relay's write check, shared by same-origin routes that change
 * state with the session cookie: the Origin check above, and Fetch Metadata
 * must not report a cross-site request.
 */
export const isSameOriginWrite = (request: Request): boolean =>
  request.headers.get("sec-fetch-site") !== "cross-site" &&
  originMatches(request);

/**
 * account-switching-v1: the check for a read that names this browser's
 * accounts. Fetch Metadata, when the browser sends it, must say `same-origin`:
 * a cross-site or same-site request, or a navigation the reader started
 * (`none`), is refused. A browser without Fetch Metadata sends no Origin on a
 * same-origin GET either, so such a request passes the Origin check alone;
 * the read changes nothing and its answer is never readable cross-origin.
 */
export const isSameOriginRead = (request: Request): boolean => {
  const site = request.headers.get("sec-fetch-site");
  return (site === null || site === "same-origin") && originMatches(request);
};

/** The confirmed account a browser write asserts; absent is allowed, malformed is not. */
export const assertedAccountOf = (
  request: Request,
): { readonly valid: boolean; readonly account?: string } => {
  const account = request.headers.get("x-author-account");
  if (account === null) return { valid: true };
  return /^user-[0-9a-f]{32}$/u.test(account)
    ? { valid: true, account }
    : { valid: false };
};

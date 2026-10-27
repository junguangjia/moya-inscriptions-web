/**
 * The community relay's write check, shared by same-origin routes that change
 * state with the session cookie: an Origin, when present, must be this exact
 * origin, and Fetch Metadata must not report a cross-site request. A request
 * without Origin is not a browser cross-site write and still needs the cookie.
 *
 * Next's development Request.url may normalize the hostname to localhost, so
 * the browser's requested authority comes from Host, which scripts cannot
 * forge; forwarded-host is never trusted.
 */
export const isSameOriginWrite = (request: Request): boolean => {
  if (request.headers.get("sec-fetch-site") === "cross-site") return false;
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

/**
 * Issue #355, login door: what a person reads when the issuer has to stop.
 *
 * Never a blank page, because the person reading it may have just clicked allow.
 * The issuer has no stylesheet of its own to borrow, and the one-time secret may
 * be in this URL, so the page loads nothing and sends no referrer.
 */

export const plainPageHeaders = {
  "content-type": "text/html; charset=utf-8",
  "cache-control": "no-store",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
  "content-security-policy": "default-src 'none'; frame-ancestors 'none'",
} as const;

export const plainPageHtml = (
  title: string,
  body: string,
  code?: string,
  controls = "",
): string =>
  `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">` +
  `<meta name="viewport" content="width=device-width, initial-scale=1">` +
  `<title>${title}</title></head><body><h1>${title}</h1><p>${body}</p>` +
  controls +
  `${code === undefined ? "" : `<p><small>${code}</small></p>`}</body></html>`;

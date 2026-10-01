/**
 * Whether the Product application composes the live comment section, and
 * where its signed-out readers go to sign in.
 *
 * Community V1 (amendment 2026-09-11, section 7 and decision 7): merged code
 * enables nothing in Production. The Formal root therefore composes the real
 * comment client only where the Development sign-in entry exists — the
 * Development runtime — and a Production build keeps the accepted Detail
 * without a comment section and never links to the Development-only sign-in
 * route. Opening a Production surface is a separate Owner decision under
 * decision 7 and changes this one resolver.
 *
 * Next inlines `process.env.NODE_ENV` per build: `next build` (served by
 * `next start`) bakes in "production", `next dev` "development" — the same
 * gate the `/dev/*` routes rely on.
 */
export const developmentSignInPath = "/login";

export interface CommunityCommentSurface {
  /** Where a signed-out reader goes to sign in. */
  readonly signInHref: string;
}

export const resolveCommunityCommentSurface = (
  nodeEnv: string | undefined = process.env.NODE_ENV,
): CommunityCommentSurface | null =>
  nodeEnv === "development" ? { signInHref: developmentSignInPath } : null;

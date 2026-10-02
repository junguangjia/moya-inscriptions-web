/**
 * The real business surface is shared by Development and Production. Its
 * availability is separate from Development sign-in, QA and provider fixtures.
 * Backend authentication capabilities remain the authority for usable sign-in.
 */
export const developmentSignInPath = "/login";

export interface CommunityCommentSurface {
  /** Where a signed-out reader goes to sign in. */
  readonly signInHref: string;
}

export const resolveCommunityCommentSurface = (
  nodeEnv: string | undefined = process.env.NODE_ENV,
): CommunityCommentSurface | null =>
  nodeEnv === "development" || nodeEnv === "production"
    ? { signInHref: developmentSignInPath }
    : null;

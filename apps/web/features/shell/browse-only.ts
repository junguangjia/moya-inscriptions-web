/**
 * Wide-screen browse-only for visitors without an account (pc-browse-only-v1).
 *
 * `true` is a signed-in viewer (or a session cookie the Backend could not
 * check), `false` a visitor without an account, `null` a session cookie still
 * waiting for /me. Presentation-only; never a Public Contract.
 */
export type BrowseOnlySession = boolean | null;

/** What the Formal root tells the shell; absent means the policy is off. */
export interface BrowseOnlyPolicy {
  readonly session: BrowseOnlySession;
}

/** Decided on the server: whether the request carried a session cookie. */
export interface WideScreenBrowseOnlyHint {
  readonly sessionHint: boolean;
}

export const resolveBrowseOnlySession = ({
  viewer,
  checking,
  sessionError,
  sessionHint,
}: {
  readonly viewer: boolean;
  readonly checking: boolean;
  readonly sessionError: boolean;
  readonly sessionHint: boolean;
}): BrowseOnlySession => {
  if (viewer) return true;
  if (!sessionHint) return false;
  if (sessionError) return true;
  return checking ? null : false;
};

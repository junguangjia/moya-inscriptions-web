import { headers } from "next/headers";

import { readCommunitySessionToken } from "../lib/public-api/community-session-cookie";
import {
  fetchServerCurrentUser,
  fetchServerProductAccess,
} from "../lib/public-api/server";

/**
 * What this visitor may see, as the Backend's product access policy answers
 * for the session cookie. Web holds no copy of the mode or of who is approved,
 * and anything but a clear "granted" renders no product content.
 */
export type VisitorAccess =
  | {
      readonly state: "granted";
      /** True while only approved accounts are admitted. */
      readonly closedBeta: boolean;
      readonly token: string | undefined;
    }
  | { readonly state: "sign_in_required" }
  | {
      readonly state: "restricted";
      readonly account: {
        readonly displayName: string;
        readonly handle: string;
      } | null;
    }
  | { readonly state: "unavailable" };

const accessFor = async (cookie: string | null): Promise<VisitorAccess> => {
  const token = readCommunitySessionToken(cookie);
  const result = await fetchServerProductAccess(token);
  if (result.state !== "success") return { state: "unavailable" };
  const { mode, access } = result.access;
  if (access === "granted")
    return { state: "granted", closedBeta: mode === "closed_beta", token };
  if (access === "sign_in_required") return { state: "sign_in_required" };
  // The signed-in visitor is told which account was refused, nothing else.
  const owner =
    token === undefined ? null : await fetchServerCurrentUser(token);
  return {
    state: "restricted",
    account:
      owner?.state === "success"
        ? {
            displayName: owner.profile.displayName,
            handle: owner.profile.handle,
          }
        : null,
  };
};

/** For a page: decided on the server, before anything is loaded or sent. */
export const readVisitorAccess = async (): Promise<VisitorAccess> =>
  accessFor((await headers()).get("cookie"));

/** For a route handler that serves content of its own rather than relaying the Backend. */
export const isProductAccessGranted = async (
  request: Request,
): Promise<boolean> =>
  (await accessFor(request.headers.get("cookie"))).state === "granted";

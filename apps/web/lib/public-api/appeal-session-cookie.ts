import {
  readCommunitySessionToken,
  serializeClearedCommunitySessionCookie,
  serializeCommunitySessionCookie,
} from "./community-session-cookie";
const name = "yoyi-appeal-session";
export const readAppealSessionToken = (
  header: string | null | undefined,
): string | undefined => {
  if (!header) return undefined;
  const value = header
    .split(";")
    .find((part) => part.trim().startsWith(`${name}=`));
  return value
    ? readCommunitySessionToken(
        value.trim().replace(`${name}=`, "yoyi-session="),
      )
    : undefined;
};
export const serializeAppealSessionCookie = (
  token: string,
  expiresAt: Date,
  secure: boolean,
): string =>
  serializeCommunitySessionCookie(token, expiresAt, secure).replace(
    /^yoyi-session=/u,
    `${name}=`,
  );
export const serializeClearedAppealSessionCookie = (secure: boolean): string =>
  serializeClearedCommunitySessionCookie(secure).replace(
    /^yoyi-session=/u,
    `${name}=`,
  );

import { hashSessionToken } from "../session-token.js";

/** The CLI and service share this domain-separated digest; raw codes are never stored. */
export const registrationInvitationDigest = async (
  code: string,
): Promise<string | null> => {
  const normalized = code.trim();
  if (!/^[A-Za-z0-9_-]{22}$/u.test(normalized)) return null;
  return hashSessionToken(`artvenn:registration-invitation:v1:${normalized}`);
};

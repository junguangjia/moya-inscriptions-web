export {
  authRequest,
  parseAccountDeletionResult,
  parseAuthAccount,
  parseAuthCapabilities,
  requestAccountDeletion,
  hasCompletedAuthSession,
  safeReturnPath,
  validAuthPassword,
  normalizedStudioName,
  studioNameInput,
} from "../../lib/public-api/auth-client";
export type {
  AuthAccountDeletionResult,
  AuthAccountSecurity,
  AuthAccountView,
  AuthCapabilitiesView,
  AuthChallengeView,
  AuthFactorView,
} from "../../lib/public-api/auth-client";

/** Account authentication reads and password commands. Session grants stay server-only. */
const reference = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const json = (description: string, schema: string) => ({
  description,
  content: { "application/json": { schema: reference(schema) } },
});
const failure = (description: string) => ({
  description,
  content: { "application/json": { schema: reference("ApiError") } },
});

const passwordFailures = {
  "422": failure(
    "Invalid input or purpose-bound proof. ApiErrorCode INVALID_INPUT.",
  ),
  "401": failure("Generic invalid credentials. ApiErrorCode UNAUTHENTICATED."),
  "409": failure("Attempt limit or state conflict. ApiErrorCode CONFLICT."),
  "500": failure("Internal service error. ApiErrorCode INTERNAL_ERROR."),
  "503": failure(
    "Authentication unavailable. ApiErrorCode SERVICE_UNAVAILABLE.",
  ),
};
const commandBody = (name: string) => ({
  required: true,
  content: { "application/json": { schema: reference(name) } },
});

export const authPaths = {
  "/v1/community/auth/appeals/login": {
    post: {
      operationId: "signInForAppeal",
      summary: "Verify a password for restricted case access",
      description:
        "Existing identity verification and attempt budgets. A short-lived appeal-only server grant cannot authorize normal community reads or writes; Web stores it in a separate HttpOnly cookie.",
      requestBody: commandBody("AuthPasswordLoginRequest"),
      responses: {
        "200": {
          description:
            "Server-only appeal session grant. Relay removes the credential before browser delivery.",
        },
        ...passwordFailures,
      },
    },
  },
  "/v1/community/auth/appeals/challenges": {
    post: {
      operationId: "createAppealSignInChallenge",
      summary:
        "Send an existing-account sign-in challenge without an ordinary session",
      description:
        "Only purpose sign_in is accepted. Provider availability and source/target attempt budgets remain unchanged.",
      requestBody: commandBody("AuthChallengeRequest"),
      responses: {
        "200": json(
          "Existing challenge continuation.",
          "AuthChallengeAccepted",
        ),
        ...passwordFailures,
      },
    },
  },
  "/v1/community/auth/appeals/verify": {
    post: {
      operationId: "verifyAppealSignInChallenge",
      summary: "Verify a sign-in challenge for restricted case access",
      requestBody: commandBody("AuthVerifyRequest"),
      responses: {
        "200": {
          description:
            "Server-only short-lived appeal grant; no ordinary session is issued.",
        },
        ...passwordFailures,
      },
    },
  },
  "/v1/community/auth/appeals/session": {
    get: {
      operationId: "readOwnAppealSession",
      summary: "Read the verified appeal session owner",
      security: [{ session: [] }],
      responses: {
        "200": json(
          "Identity metadata only, no credential.",
          "CommunityAppealSession",
        ),
        ...passwordFailures,
      },
    },
  },
  "/v1/community/auth/appeals/sign-out": {
    post: {
      operationId: "signOutAppealSession",
      summary: "Revoke the restricted session without changing ordinary login",
      responses: {
        "204": { description: "Restricted session ended." },
        ...passwordFailures,
      },
    },
  },

  "/v1/community/auth/passwords/login": {
    post: {
      operationId: "passwordSignIn",
      summary: "Password sign-in for an existing public account",
      description:
        "The same-origin relay receives a server-only Session grant and sets an HttpOnly Cookie. Runtime capabilities select supported identifiers, including explicitly enabled provisioned handles. Missing credentials and wrong passwords have the same response.",
      requestBody: commandBody("AuthPasswordLoginRequest"),
      responses: {
        "200": {
          description:
            "Existing server-only Session grant; never expose its raw token to browser JavaScript.",
        },
        ...passwordFailures,
      },
    },
  },
  "/v1/community/auth/passwords/reset": {
    post: {
      operationId: "resetPublicAccountPassword",
      summary:
        "Consume a password_reset proof and replace an existing account's password",
      description:
        "Revoke all Sessions, close prior auth receipts and invalidate proofs atomically. No Session is created. Exact manual retries return the prior result.",
      requestBody: commandBody("AuthPasswordResetRequest"),
      responses: {
        "200": json(
          "Password reset. Continue with explicit sign-in.",
          "AuthPasswordResetResult",
        ),
        ...passwordFailures,
      },
    },
  },
  "/v1/community/auth/capabilities": {
    get: {
      operationId: "getAuthCapabilities",
      summary: "Authentication channel capabilities",
      description:
        "Server-owned channel and registration capabilities, invitation requirement and approved agreement. A client cannot enable registration, simulation or live delivery. Production requires explicit server configuration.",
      responses: {
        "200": json("The active acceptance profile.", "AuthCapabilities"),
        "400": failure("Invalid query. ApiErrorCode INVALID_QUERY."),
        "500": failure("Internal service error. ApiErrorCode INTERNAL_ERROR."),
        "503": failure(
          "Service unavailable. ApiErrorCode SERVICE_UNAVAILABLE.",
        ),
      },
    },
  },
  "/v1/community/auth/account": {
    get: {
      operationId: "getAuthAccountSecurity",
      summary: "Masked login factors for the current account",
      description:
        "Authenticated account security view. Masked contacts only; no raw email, phone, OTP or session token.",
      security: [{ session: [] }],
      responses: {
        "200": json(
          "The current account's login factors.",
          "AuthAccountSecurity",
        ),
        "400": failure("Invalid query. ApiErrorCode INVALID_QUERY."),
        "401": failure(
          "A valid session is required. ApiErrorCode UNAUTHENTICATED.",
        ),
        "500": failure("Internal service error. ApiErrorCode INTERNAL_ERROR."),
        "503": failure(
          "Service unavailable. ApiErrorCode SERVICE_UNAVAILABLE.",
        ),
      },
    },
  },
  "/v1/community/auth/account/deletion": {
    post: {
      operationId: "deleteOwnAccount",
      summary: "Permanently delete the signed-in public account",
      description:
        "account-deletion-v1. Takes effect at once and cannot be undone. Requires the Session, x-author-account naming the Session's account and a single-use reauthenticate proof of a bound phone or email issued to this Session. One transaction revokes every Session, closes auth receipts, removes every login identity and the password credential (the phone and email are free to register again), anonymizes the profile (the handle stays reserved), removes the account's follows in both directions, the blocks it set (blocks other users set against it stay in force), its likes, favorites and comment likes, and withdraws its public content; works and media are purged in the background. Comments, replies and direct messages keep their text under the anonymized name. An exact retry with the same idempotency key returns the same result after the Session was revoked.",
      security: [{ session: [] }],
      parameters: [
        {
          name: "x-author-account",
          in: "header",
          required: true,
          schema: { type: "string", pattern: "^user-[0-9a-f]{32}$" },
          description:
            "The account the client confirmed. A missing or different account is refused and nothing changes.",
        },
      ],
      requestBody: commandBody("AuthAccountDeletionRequest"),
      responses: {
        "200": json(
          "The account is deleted. No credential in the body.",
          "AuthAccountDeletionResult",
        ),
        "401": failure(
          "No valid Session of the confirmed active account, or a deleted account's non-matching retry. ApiErrorCode UNAUTHENTICATED.",
        ),
        "422": failure(
          "Missing, expired, consumed or foreign re-verification proof. ApiErrorCode INVALID_INPUT.",
        ),
        "500": failure("Internal service error. ApiErrorCode INTERNAL_ERROR."),
        "503": failure(
          "Re-verification is unavailable in this profile, or the service is unavailable. ApiErrorCode SERVICE_UNAVAILABLE.",
        ),
      },
    },
  },
};

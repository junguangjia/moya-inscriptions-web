/** Development-only account authentication reads. Session grants stay off this document. */
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
    "Development auth unavailable. ApiErrorCode SERVICE_UNAVAILABLE.",
  ),
};
const commandBody = (name: string) => ({
  required: true,
  content: { "application/json": { schema: reference(name) } },
});

export const authPaths = {
  "/v1/community/auth/passwords/login": {
    post: {
      operationId: "passwordSignIn",
      summary: "Development password sign-in for an existing public account",
      description:
        "Existing same-origin relay receives a server-only Session grant and sets HttpOnly Cookie. Production mounting is unchanged. Missing credentials and wrong passwords have the same response.",
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
        "Server-owned email and phone availability. A client cannot enable simulation or live delivery. Production does not mount this route in this task.",
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
};

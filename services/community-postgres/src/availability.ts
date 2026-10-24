import {
  CommunityConflictError,
  CommunityStoreUnavailableError,
} from "@moya/api";

// The same connection-level signals @moya/catalog-postgres treats as
// unavailability; the community adapter maps them to its own error type.
const unavailableCodes = new Set([
  "53300",
  "57P01",
  "57P02",
  "57P03",
  "ECONNREFUSED",
  "ECONNRESET",
  "ENETDOWN",
  "ENETUNREACH",
  "ENOTFOUND",
  "EPIPE",
  "ETIMEDOUT",
]);

const errorCode = (error: unknown): string | undefined => {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return undefined;
  }
  return typeof error.code === "string" ? error.code : undefined;
};

export const asCommunityOperationError = (
  error: unknown,
  phase: "connect" | "query",
): unknown => {
  if (error instanceof CommunityStoreUnavailableError) return error;
  if (
    typeof error === "object" &&
    error !== null &&
    "constraint" in error &&
    error.constraint === "report_comments_restricted"
  )
    return new CommunityConflictError("Commenting is restricted");
  if (
    typeof error === "object" &&
    error !== null &&
    "constraint" in error &&
    error.constraint === "active_report_restriction"
  )
    return new CommunityConflictError(
      "An active report decision still restricts this target",
    );
  const code = errorCode(error);
  if (
    phase === "connect" ||
    (code !== undefined &&
      (code.startsWith("08") || unavailableCodes.has(code)))
  ) {
    return new CommunityStoreUnavailableError({ cause: error });
  }
  return error;
};

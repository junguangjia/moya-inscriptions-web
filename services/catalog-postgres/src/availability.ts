import { CatalogQueryUnavailableError } from "@moya/api";

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

export const asPostgresOperationError = (
  error: unknown,
  phase: "connect" | "query",
): unknown => {
  if (error instanceof CatalogQueryUnavailableError) return error;
  const code = errorCode(error);
  if (
    phase === "connect" ||
    (code !== undefined &&
      (code.startsWith("08") || unavailableCodes.has(code)))
  ) {
    return new CatalogQueryUnavailableError({ cause: error });
  }

  return error;
};

/**
 * For a read whose every failure means its published facts are unavailable
 * (the Catalog rendition-fact lookup): the documented 503, never a 500,
 * whatever the cause (catalog-delivery-release-hardening-v1 F9).
 */
export const asCatalogQueryUnavailableError = (
  error: unknown,
): CatalogQueryUnavailableError =>
  error instanceof CatalogQueryUnavailableError
    ? error
    : new CatalogQueryUnavailableError({ cause: error });

/** Content-free failure codes; mirrors `PublishingMediaStoreFailureCode`. */
export type PublishingMediaStoreErrorCode =
  | "invalid_argument"
  | "invalid_key"
  | "size_limit_exceeded"
  | "size_mismatch"
  | "empty_content"
  | "aborted"
  | "not_regular_file"
  | "unavailable";

export class PublishingMediaStoreError extends Error {
  /** System error code (for example `ENOSPC`) behind `unavailable`, never a path. */
  readonly systemCode: string | null;

  constructor(
    readonly code: PublishingMediaStoreErrorCode,
    systemCode: string | null = null,
  ) {
    super(`Publishing media store failure: ${code}`);
    this.name = "PublishingMediaStoreError";
    this.systemCode = systemCode;
  }
}

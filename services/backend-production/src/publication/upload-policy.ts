/** Publication only. Control calls retain their existing 30-second bound. */
export const PUBLICATION_PUT_MAX_TOTAL_MS = 240_000;
export const PUBLICATION_PUT_VALIDITY_MARGIN_MS = 30_000;

/** A finite request budget, not a measured production throughput promise.
 * Newly rendered outputs are at most 128 MiB. The 5 GiB destination ceiling
 * is retained; larger historical units have the same 240-second hard cap.
 */
export const publicationPutTotalTimeoutMs = (byteSize: number): number => {
  if (
    !Number.isSafeInteger(byteSize) ||
    byteSize < 1 ||
    byteSize > 5 * 1024 ** 3
  )
    throw new RangeError("Publication copy size is invalid");
  return Math.min(
    PUBLICATION_PUT_MAX_TOTAL_MS,
    90_000 + Math.ceil(byteSize / (1024 * 1024)) * 1_000,
  );
};

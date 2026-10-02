import type { PublishingMediaByteRange } from "../ports/publishing-media-store-port.js";
import type { PublishingMediaDelivery } from "./work-publishing-service.js";

/** Existing private PNG delivery; range and release semantics match stored derivatives. */
export const openPublishingMemoryMedia = (
  png: Uint8Array,
  sha256: string,
  range?: PublishingMediaByteRange,
): PublishingMediaDelivery => {
  const byteSize = png.byteLength;
  const start =
    range === undefined
      ? 0
      : "suffixLength" in range
        ? Math.max(0, byteSize - range.suffixLength)
        : range.start;
  const end =
    range !== undefined && "start" in range
      ? Math.min(range.end ?? byteSize - 1, byteSize - 1)
      : byteSize - 1;
  if (
    byteSize === 0 ||
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    start < 0 ||
    end < start ||
    start >= byteSize ||
    (range !== undefined &&
      "suffixLength" in range &&
      (!Number.isSafeInteger(range.suffixLength) || range.suffixLength <= 0))
  )
    return {
      contentType: "image/png",
      sha256: sha256,
      read: { status: "range_not_satisfiable", byteSize },
    };
  let bytes: Uint8Array | null = png.subarray(start, end + 1);
  return {
    contentType: "image/png",
    sha256: sha256,
    read: {
      status: "ok",
      byteSize,
      start,
      end,
      contentLength: end - start + 1,
      body: (async function* () {
        if (bytes !== null) yield bytes;
        bytes = null;
      })(),
      close: async () => {
        bytes = null;
      },
    },
  };
};

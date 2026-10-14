import { pipeline } from "node:stream/promises";

import type {
  PublishingMediaByteRange,
  PublishingMediaDelivery,
} from "@moya/api";
import type { IncomingMessage, ServerResponse } from "node:http";

/** Derivative types the media routes may ever send; anything else is refused. */
const deliverableTypes: ReadonlySet<string> = new Set([
  "image/png", // Operator-only unedited legacy user-media compatibility.
  "image/webp",
  "video/mp4",
]);

const bytesUnitPattern = /^bytes=/iu;
const singleRangePattern = /^(?:(\d{1,16})-(\d{0,16})|-(\d{1,16}))$/u;

/**
 * One `Range` header (RFC 9110 §14.2): `undefined` without a header and for a
 * header the server ignores (a unit other than bytes, several ranges), which
 * is answered with the whole representation; `invalid` for a malformed byte
 * range (a last position before the first, a zero suffix, other syntax).
 */
export const parsePublishingByteRange = (
  header: string | readonly string[] | undefined,
): PublishingMediaByteRange | undefined | "invalid" => {
  if (typeof header !== "string") return undefined;
  const value = header.trim();
  if (!bytesUnitPattern.test(value)) return undefined;
  const ranges = value.slice("bytes=".length).trim();
  if (ranges.includes(",")) return undefined;
  const match = singleRangePattern.exec(ranges);
  if (match === null) return "invalid";
  const [, first, last, suffix] = match;
  if (suffix !== undefined) {
    const suffixLength = Number(suffix);
    return Number.isSafeInteger(suffixLength) && suffixLength > 0
      ? { suffixLength }
      : "invalid";
  }
  const start = Number(first);
  if (!Number.isSafeInteger(start)) return "invalid";
  if (last === undefined || last === "") return { start };
  const end = Number(last);
  return Number.isSafeInteger(end) && end >= start ? { start, end } : "invalid";
};

export interface PublishingMediaHeaders {
  readonly "cache-control": string;
  readonly vary?: string;
  /** Sent only where the route lets the bytes be revalidated. */
  readonly etag?: string;
}

/**
 * Sends one opened derivative: 200 for the whole blob, 206 for a range, 416
 * when the range lies outside it. Private and never cached; HEAD sends the
 * headers only. The file is always released, also when the client leaves.
 */
export const sendPublishingMedia = async (
  request: IncomingMessage,
  response: ServerResponse,
  delivery: PublishingMediaDelivery,
  ranged: boolean,
  privateHeaders: PublishingMediaHeaders,
): Promise<void> => {
  const { read } = delivery;
  const common = {
    ...privateHeaders,
    "accept-ranges": "bytes",
    "x-content-type-options": "nosniff",
    "cross-origin-resource-policy": "same-origin",
  };
  if (read.status === "range_not_satisfiable") {
    response.writeHead(416, {
      ...common,
      "content-range": `bytes */${read.byteSize}`,
      "content-length": 0,
    });
    response.end();
    return;
  }
  try {
    if (!deliverableTypes.has(delivery.contentType))
      throw new TypeError("Undeliverable media type");
    response.writeHead(ranged ? 206 : 200, {
      ...common,
      "content-type": delivery.contentType,
      "content-length": read.contentLength,
      ...(ranged
        ? {
            "content-range": `bytes ${read.start}-${read.end}/${read.byteSize}`,
          }
        : {}),
    });
    if (request.method === "HEAD") {
      response.end();
      return;
    }
    await pipeline(read.body, response);
  } catch (error) {
    if (!response.headersSent) throw error;
    // The client went away or the file failed mid-stream: nothing more to say.
    response.destroy();
  } finally {
    await read.close().catch(() => undefined);
  }
};

/**
 * Opens and sends a derivative for a media route. An ignored `Range` header
 * (another unit, several ranges) sends the whole derivative; a malformed byte
 * range answers 416 with the complete length, like an unsatisfiable one.
 * Errors before any header was sent propagate to the route's error mapping.
 */
export const deliverPublishingMedia = async (
  request: IncomingMessage,
  response: ServerResponse,
  open: (
    range: PublishingMediaByteRange | undefined,
  ) => Promise<PublishingMediaDelivery>,
  privateHeaders: PublishingMediaHeaders,
): Promise<void> => {
  const range = parsePublishingByteRange(request.headers.range);
  if (range === "invalid") {
    const whole = await open(undefined);
    if (whole.read.status === "ok") await whole.read.close();
    await sendPublishingMedia(
      request,
      response,
      {
        ...whole,
        read: {
          status: "range_not_satisfiable",
          byteSize: whole.read.byteSize,
        },
      },
      true,
      privateHeaders,
    );
    return;
  }
  await sendPublishingMedia(
    request,
    response,
    await open(range),
    range !== undefined,
    privateHeaders,
  );
};

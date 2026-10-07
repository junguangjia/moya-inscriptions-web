import { pipeline } from "node:stream/promises";

import { sendJson } from "../http/json-response.js";

import type {
  PublishingMediaReadTarget,
  PublishingMediaStorePort,
} from "@moya/api";
import type { IncomingMessage, ServerResponse } from "node:http";

/**
 * Development-only delivery of Catalog rendition bytes (unified media
 * pipeline, PR 1b), so the complete design can be inspected locally while
 * Production delivers no Catalog rendition in increment 1. The composition
 * root supplies it only for synthetic Development with local storage, where
 * the Development URL resolver names this route.
 */
export interface DevelopmentCatalogRenditions {
  /**
   * The committed blob of a rendition the Catalog delivery view lists (ready,
   * of a ready Catalog asset the published projection names), or null.
   */
  readonly resolve: (
    renditionId: string,
  ) => Promise<PublishingMediaReadTarget | null>;
  /** The local publishing store that holds the rendition blobs. */
  readonly store: PublishingMediaStorePort;
}

const privateHeaders = {
  "cache-control": "private, no-store",
  "x-content-type-options": "nosniff",
};

const notFound = (response: ServerResponse): void =>
  sendJson(
    response,
    404,
    { error: { status: 404, message: "Not Found" } },
    privateHeaders,
  );

/**
 * `GET /v1/development/catalog-renditions/<rendition id>`: exactly that
 * request target (no query, no other form) and GET only; the whole committed
 * blob with its recorded type and length, private and never cached. Any
 * other request, and any id the delivery view does not list, answers 404.
 * Every increment-1 rendition is WebP, the one still type the shared read
 * target admits; a JPEG still (the increment-4 viewer image) arrives with
 * that target, the relay and this route together.
 */
export const handleDevelopmentCatalogRendition = async (
  request: IncomingMessage,
  response: ServerResponse,
  renditionId: string,
  delivery: DevelopmentCatalogRenditions,
): Promise<void> => {
  if (
    request.method !== "GET" ||
    request.url !== `/v1/development/catalog-renditions/${renditionId}`
  ) {
    notFound(response);
    return;
  }
  const target = await delivery.resolve(renditionId);
  if (target === null || target.contentType !== "image/webp") {
    notFound(response);
    return;
  }
  const read = await delivery.store.openRead(target.storageKey);
  if (read === null || read.status !== "ok") {
    notFound(response);
    return;
  }
  try {
    if (
      read.byteSize !== target.byteSize ||
      read.contentLength !== target.byteSize
    ) {
      notFound(response);
      return;
    }
    response.writeHead(200, {
      ...privateHeaders,
      "content-type": target.contentType,
      "content-length": read.contentLength,
    });
    await pipeline(read.body, response);
  } catch (error) {
    if (!response.headersSent) throw error;
    // The client went away or the file failed mid-stream.
    response.destroy();
  } finally {
    await read.close().catch(() => undefined);
  }
};

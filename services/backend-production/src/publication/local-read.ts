import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { pipeline } from "node:stream/promises";

import { hasPublicationProviderConfig } from "./config.js";
import { validatePublishedKey, validatePublishedOrigin } from "./keys.js";
import { PUBLICATION_CACHE_CONTROL } from "./provider.js";
import type { PublicationConfig } from "./config.js";
import type { FileHandle } from "node:fs/promises";
import type {
  IncomingMessage,
  RequestListener,
  Server,
  ServerResponse,
} from "node:http";

const opaqueAssetPath = /^\/v1\/[0-9a-f]{32}(?:\/|$)/u;
const loopbackHosts = new Set(["localhost", "127.0.0.1", "[::1]"]);
const loopbackAddresses = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);
const missing = (error: unknown): boolean =>
  typeof error === "object" &&
  error !== null &&
  "code" in error &&
  error.code === "ENOENT";
const reject = (response: ServerResponse, status = 404): void => {
  response.statusCode = status;
  response.setHeader("Cache-Control", "private, no-store");
  response.setHeader("Content-Length", "0");
  response.end();
};

/** Open exactly one immutable derivative, without creating directories or
 * following a file/parent symlink. The worker and HTTP process share this
 * Development-only store; no Production listener is introduced.
 */
async function openPublishedFile(
  root: string,
  key: string,
): Promise<FileHandle | undefined> {
  validatePublishedKey(key);
  try {
    if ((await lstat(root)).isSymbolicLink()) return undefined;
    let directory = await realpath(root);
    const segments = key.split("/");
    for (const segment of segments.slice(0, -1)) {
      directory = join(directory, segment);
      const info = await lstat(directory);
      if (!info.isDirectory() || info.isSymbolicLink()) return undefined;
    }
    return await open(
      join(directory, segments.at(-1)!),
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
  } catch (error) {
    if (
      missing(error) ||
      (typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "ELOOP")
    )
      return undefined;
    throw error;
  }
}

function readRange(
  value: string,
  size: number,
): { start: number; end: number } | undefined {
  const match = /^bytes=([0-9]*)-([0-9]*)$/u.exec(value);
  if (!match || (!match[1] && !match[2])) return undefined;
  if (!match[1]) {
    const suffix = Number(match[2]);
    return Number.isSafeInteger(suffix) && suffix > 0
      ? { start: Math.max(0, size - suffix), end: size - 1 }
      : undefined;
  }
  const start = Number(match[1]);
  const end = match[2] ? Number(match[2]) : size - 1;
  return Number.isSafeInteger(start) &&
    Number.isSafeInteger(end) &&
    start < size &&
    end >= start
    ? { start, end: Math.min(end, size - 1) }
    : undefined;
}

const matchesEtag = (value: string, etag: string): boolean =>
  value.split(",").some((candidate) => {
    const tag = candidate.trim();
    return (
      tag === "*" || tag.replace(/^W\//u, "") === etag.replace(/^W\//u, "")
    );
  });

/** Decorates the existing Backend listener with the inspectable local origin.
 * Only public Development can read bytes, even when configuration switches are
 * set in Beta. Public relay preparation may inspect a copied derivative before
 * enabling DTO edge delivery. Other Backend paths retain their existing gate.
 */
export function createLocalPublicationReadHandler(
  config: PublicationConfig,
  next: RequestListener,
): RequestListener {
  if (config.nodeEnv !== "development") return next;
  let expectedOrigin: URL | undefined;
  if (config.nodeEnv === "development" && config.origin) {
    expectedOrigin = new URL(validatePublishedOrigin(config.origin, true));
    if (!loopbackHosts.has(expectedOrigin.hostname)) expectedOrigin = undefined;
  }
  const root = config.localRoot;
  const enabled =
    config.nodeEnv === "development" &&
    config.productMode === "public" &&
    hasPublicationProviderConfig(config) &&
    Boolean(expectedOrigin) &&
    Boolean(root && isAbsolute(root));
  async function serve(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    // This denial precedes file and validator access, so a Beta 304 never
    // authorizes a previously cached public Development representation.
    if (
      !enabled ||
      !root ||
      request.headers.host !== expectedOrigin?.host ||
      !loopbackAddresses.has(request.socket.remoteAddress ?? "")
    )
      return reject(response);
    const key = (request.url ?? "").slice(1);
    try {
      validatePublishedKey(key);
    } catch {
      return reject(response);
    }
    if (request.method !== "GET" && request.method !== "HEAD") {
      response.setHeader("Allow", "GET, HEAD");
      return reject(response, 405);
    }
    const handle = await openPublishedFile(root, key);
    if (!handle) return reject(response);
    try {
      const info = await handle.stat({ bigint: true });
      if (!info.isFile() || info.size < 1n || info.size > BigInt(5 * 1024 ** 3))
        return reject(response);
      const size = Number(info.size);
      // The store never overwrites a generation. A weak metadata validator is
      // enough for GET/HEAD cache validation and avoids hashing a 5 GiB movie
      // merely to answer HEAD. It deliberately cannot authorize If-Range.
      const etag = `W/"${createHash("sha256").update(`${info.dev}:${info.ino}:${info.size}:${info.mtimeNs}`).digest("hex")}"`;
      const modified = Math.floor(Number(info.mtimeMs) / 1_000) * 1_000;
      const contentType = key.endsWith(".webp")
        ? "image/webp"
        : key.endsWith(".jpg")
          ? "image/jpeg"
          : "video/mp4";
      response.setHeader("Cache-Control", PUBLICATION_CACHE_CONTROL);
      response.setHeader("Access-Control-Allow-Origin", "*");
      response.setHeader("Content-Type", contentType);
      response.setHeader("X-Content-Type-Options", "nosniff");
      response.setHeader("Accept-Ranges", "bytes");
      response.setHeader("ETag", etag);
      response.setHeader("Last-Modified", new Date(modified).toUTCString());
      const ifNoneMatch = request.headers["if-none-match"];
      const since = request.headers["if-modified-since"];
      if (
        typeof ifNoneMatch === "string"
          ? matchesEtag(ifNoneMatch, etag)
          : typeof since === "string" && Date.parse(since) >= modified
      ) {
        response.statusCode = 304;
        response.end();
        return;
      }
      const rangeHeader = request.headers.range;
      const ifRange = request.headers["if-range"];
      // Weak ETags never satisfy If-Range; an applicable date may.
      const useRange =
        request.method === "GET" &&
        typeof rangeHeader === "string" &&
        (ifRange === undefined ||
          (typeof ifRange === "string" &&
            !ifRange.includes('"') &&
            Date.parse(ifRange) >= modified));
      const range = useRange ? readRange(rangeHeader, size) : undefined;
      if (useRange && !range) {
        response.statusCode = 416;
        response.setHeader("Content-Range", `bytes */${size}`);
        response.setHeader("Content-Length", "0");
        response.end();
        return;
      }
      response.statusCode = range ? 206 : 200;
      response.setHeader(
        "Content-Length",
        String(range ? range.end - range.start + 1 : size),
      );
      if (range)
        response.setHeader(
          "Content-Range",
          `bytes ${range.start}-${range.end}/${size}`,
        );
      if (request.method === "HEAD") {
        response.end();
        return;
      }
      const stream = handle.createReadStream({
        autoClose: false,
        ...(range ?? {}),
      });
      try {
        await pipeline(stream, response);
      } finally {
        stream.destroy();
      }
    } finally {
      await handle.close();
    }
  }
  return function (this: Server, request, response) {
    if (!opaqueAssetPath.test(request.url ?? ""))
      return next.call(this, request, response);
    void serve(request, response).catch(() => {
      if (!response.headersSent) reject(response);
      else response.destroy();
    });
  };
}

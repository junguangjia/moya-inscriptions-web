/** Editorial span body writer only. Never follows redirects or exposes diagnostics. */
import http from "node:http";
import { createHash } from "node:crypto";
import https from "node:https";
import { Readable } from "node:stream";
import { Buffer } from "node:buffer";
import { URL } from "node:url";

const { Response, Headers } = globalThis;
const WRITE_BYTES = 128 * 1024;
const MAX_BYTES = 40 * 1024 * 1024;
const fail = (code) => Object.assign(new Error(code), { code });

export class NativeStreamBody {
  constructor(bytes, offset, length, onWrite = () => {}) {
    if (
      !(bytes instanceof Uint8Array) ||
      bytes.byteLength > MAX_BYTES ||
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      !Number.isSafeInteger(length) ||
      length < 1 ||
      length > MAX_BYTES ||
      offset + length > bytes.length ||
      typeof onWrite !== "function"
    )
      throw fail("MEDIA_UPLOAD_INPUT_INVALID");
    this.bytes = bytes;
    this.offset = offset;
    this.byteLength = length;
    this.onWrite = onWrite;
  }
}

/** One exact supported chunk only; the session's total image and immutable identity stay server-owned. */
export class NativeChunkBody {
  constructor(bytes, index, onWrite = () => {}) {
    if (
      !(bytes instanceof Uint8Array) ||
      bytes.length < 1 ||
      bytes.length > WRITE_BYTES ||
      !Number.isSafeInteger(index) ||
      index < 0 ||
      index >= 320 ||
      typeof onWrite !== "function"
    )
      throw fail("MEDIA_UPLOAD_INPUT_INVALID");
    this.bytes = bytes;
    this.offset = 0;
    this.byteLength = bytes.length;
    this.index = index;
    this.onWrite = onWrite;
  }
}

/** The counters advance after request.write callbacks, not fetch-generator enqueue. */
export function createNativeUploadFetch(
  fallback,
  { onRequestClosed = () => {} } = {},
) {
  return async (url, options = {}) => {
    const body = options.body;
    if (
      !(body instanceof NativeStreamBody) &&
      !(body instanceof NativeChunkBody)
    )
      return fallback(url, options);
    const target = new URL(url);
    const chunkBody = body instanceof NativeChunkBody;
    const route = chunkBody
      ? /^\/api\/editorial\/media-upload\/chunk\/[a-f0-9]{64}\/(0|[1-9]\d{0,2})$/.exec(
          target.pathname,
        )
      : /^\/api\/editorial\/media-upload\/stream\/[a-f0-9]{64}\/(\d{1,8})$/.exec(
          target.pathname,
        );
    const headers = new Headers(options.headers);
    const hashHeader = chunkBody
      ? "x-editorial-chunk-sha256"
      : "x-editorial-stream-sha256";
    if (
      !route ||
      Number(route[1]) !== (chunkBody ? body.index : body.offset) ||
      target.search ||
      target.hash ||
      target.username ||
      target.password ||
      options.method !== "POST" ||
      options.redirect !== "error" ||
      !["http:", "https:"].includes(target.protocol) ||
      headers.get("content-type") !== "application/octet-stream" ||
      headers.get("content-length") !== String(body.byteLength) ||
      !headers.has("authorization") ||
      !/^[a-f0-9]{64}$/.test(headers.get(hashHeader) ?? "") ||
      (chunkBody &&
        (!(body.bytes instanceof Uint8Array) ||
          !Number.isSafeInteger(body.index) ||
          body.index < 0 ||
          body.index >= 320 ||
          !Number.isSafeInteger(body.byteLength) ||
          body.bytes.length !== body.byteLength ||
          body.byteLength < 1 ||
          body.byteLength > WRITE_BYTES ||
          body.offset !== 0 ||
          headers.get(hashHeader) !==
            createHash("sha256").update(body.bytes).digest("hex"))) ||
      !options.signal
    )
      throw fail("MEDIA_UPLOAD_INPUT_INVALID");
    if (options.signal.aborted) throw fail("TRANSPORT_UNCERTAIN");
    return new Promise((resolve, reject) => {
      let stopped = false;
      let settled = false;
      let response;
      const finishError = () => {
        stopped = true;
        options.signal.removeEventListener("abort", abort);
        if (settled) return;
        settled = true;
        reject(fail("TRANSPORT_UNCERTAIN"));
      };
      const req = (target.protocol === "https:" ? https : http).request(
        target,
        {
          method: "POST",
          headers: Object.fromEntries(headers),
        },
      );
      const abort = () => {
        stopped = true;
        req.destroy(fail("TRANSPORT_UNCERTAIN"));
        response?.destroy();
        finishError();
      };
      options.signal.addEventListener("abort", abort, { once: true });
      req.once("error", finishError);
      req.once("close", () => {
        try {
          onRequestClosed(body);
        } catch {
          /* observation only */
        }
        stopped = true;
        if (!response) finishError();
      });
      req.once("response", (incoming) => {
        response = incoming;
        if ((incoming.statusCode ?? 500) >= 300) stopped = true;
        incoming.once("end", () => {
          options.signal.removeEventListener("abort", abort);
          if (stopped) req.destroy();
        });
        incoming.once("close", () =>
          options.signal.removeEventListener("abort", abort),
        );
        if (settled) return;
        const responseHeaders = new Headers();
        for (const [name, value] of Object.entries(incoming.headers))
          if (value !== undefined)
            responseHeaders.set(
              name,
              Array.isArray(value) ? value.join(", ") : value,
            );
        let result;
        try {
          result = new Response(Readable.toWeb(incoming), {
            status: incoming.statusCode,
            headers: responseHeaders,
          });
        } catch {
          // A malformed/null-body HTTP status must never escape the event callback.
          incoming.destroy();
          req.destroy();
          finishError();
          return;
        }
        settled = true;
        resolve(result);
      });
      (async () => {
        for (let written = 0; written < body.byteLength;) {
          if (stopped || options.signal.aborted)
            throw fail("TRANSPORT_UNCERTAIN");
          const length = Math.min(WRITE_BYTES, body.byteLength - written);
          const chunk = Buffer.from(
            body.bytes.buffer,
            body.bytes.byteOffset + body.offset + written,
            length,
          );
          await new Promise((done, failWrite) =>
            req.write(chunk, (error) => (error ? failWrite(error) : done())),
          );
          written += length;
          // Observer failure never changes transmitted bytes or adds a request.
          try {
            await body.onWrite(length, written);
          } catch {
            /* bounded caller observes independently */
          }
        }
        if (!stopped) req.end();
      })().catch(() => {
        stopped = true;
        req.destroy();
        finishError();
      });
    });
  };
}

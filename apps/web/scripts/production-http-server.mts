import { createServer, IncomingMessage } from "node:http";

import type { ServerResponse } from "node:http";

type RequestHandler = (
  request: IncomingMessage,
  response: ServerResponse,
) => void | Promise<void>;

export const productionHttpLimits = Object.freeze({
  headersTimeoutMs: 60_000,
  requestDeadlineMs: 300_000,
  bodyIdleTimeoutMs: 120_000,
  uploadResponseTimeoutMs: 75_000,
  keepAliveTimeoutMs: 5_000,
  connectionsCheckingIntervalMs: 1_000,
  maxHeaderBytes: 16 * 1024,
  maxHeaders: 100,
  maxConnections: 512,
  maxConcurrentUploads: 16,
  uploadMaxBytes: 8 * 1024 * 1024 * 1024,
  ordinaryMaxBytes: 1024 * 1024,
  profileMediaMaxBytes: 4 * 1024 * 1024,
  articleMaxBytes: 1040 * 1024,
});

type Limits = { [Key in keyof typeof productionHttpLimits]: number };
type BodyObserver = (chunk: Uint8Array | null) => boolean;
const bodyObservers = new WeakMap<IncomingMessage, BodyObserver>();

/** Observe parser-enqueued bytes without consuming or duplicating the stream. */
class BoundedIncomingMessage extends IncomingMessage {
  override push(chunk: Uint8Array | null): boolean {
    if (bodyObservers.get(this)?.(chunk) === false) return false;
    return super.push(chunk);
  }
}

const componentUploadPath =
  /^\/api\/community\/publishing\/uploads\/media-component-[0-9a-f]{32}$/;

/**
 * Next's CLI leaves Node's five-minute total body deadline in place. Own the
 * server so only the exact raw-upload route uses progress-based limits. All
 * other requests retain the total deadline, including malformed upload paths.
 * Limits are code constants; overrides exist for bounded real-HTTP tests only.
 */
export const createProductionHttpServer = (
  handler: RequestHandler,
  overrides: Partial<Limits> = {},
) => {
  const limits = { ...productionHttpLimits, ...overrides };
  for (const value of Object.values(limits)) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new Error("HTTP limits must be positive safe integers");
    }
  }
  let activeUploads = 0;
  const server = createServer(
    {
      IncomingMessage: BoundedIncomingMessage,
      // Node has no per-request exemption. Equivalent ordinary-body deadline
      // and upload-only idle/size/concurrency guards are installed below.
      requestTimeout: 0,
      headersTimeout: limits.headersTimeoutMs,
      keepAliveTimeout: limits.keepAliveTimeoutMs,
      connectionsCheckingInterval: limits.connectionsCheckingIntervalMs,
      maxHeaderSize: limits.maxHeaderBytes,
    },
    (request, response) => {
      const upload =
        request.method === "POST" &&
        componentUploadPath.test(request.url ?? "");
      const path = (request.url ?? "").split("?", 1)[0];
      const maxBytes = upload
        ? limits.uploadMaxBytes
        : path === "/api/community/media"
          ? limits.profileMediaMaxBytes
          : path === "/api/community/article-authoring" ||
              path?.startsWith("/api/community/article-authoring/")
            ? limits.articleMaxBytes
            : limits.ordinaryMaxBytes;
      let received = 0;
      let bodyComplete = false;
      let stopped = false;
      let ownsUploadSlot = false;
      let idleTimer: ReturnType<typeof setTimeout> | undefined;
      let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
      let responseTimer: ReturnType<typeof setTimeout> | undefined;

      const cleanup = () => {
        stopped = true;
        clearTimeout(idleTimer);
        clearTimeout(deadlineTimer);
        clearTimeout(responseTimer);
        bodyObservers.delete(request);
        if (ownsUploadSlot) {
          ownsUploadSlot = false;
          activeUploads -= 1;
        }
      };
      const reject = (status: number) => {
        if (stopped) return;
        cleanup();
        if (response.headersSent) {
          request.destroy();
          return;
        }
        response.writeHead(status, {
          "cache-control": "no-store",
          connection: "close",
          "content-length": "0",
          ...(status === 503 ? { "retry-after": "1" } : {}),
        });
        // Flush the bounded response, then stop reading this connection. A
        // rejected sender cannot retain a slot or keep streaming unused bytes.
        response.end(() => request.socket.destroySoon());
      };
      const resetIdle = () => {
        clearTimeout(idleTimer);
        idleTimer = setTimeout(() => reject(408), limits.bodyIdleTimeoutMs);
        idleTimer.unref();
      };
      response.once("close", cleanup);
      response.once("finish", () => {
        cleanup();
        if (!request.complete) request.socket.destroySoon();
        if (!server.listening) server.closeIdleConnections();
      });
      request.once("aborted", cleanup);

      const lengthHeader = request.headers["content-length"];
      if (upload && request.headers["transfer-encoding"] !== undefined) {
        reject(422);
        return;
      }
      if (upload && lengthHeader === undefined) {
        reject(411);
        return;
      }
      const length =
        lengthHeader === undefined ? undefined : Number(lengthHeader);
      if (
        length !== undefined &&
        (!Number.isSafeInteger(length) ||
          length < 0 ||
          (upload && length === 0))
      ) {
        reject(422);
        return;
      }
      if (length !== undefined && length > maxBytes) {
        reject(413);
        return;
      }
      if (upload) {
        if (activeUploads >= limits.maxConcurrentUploads) {
          reject(503);
          return;
        }
        activeUploads += 1;
        ownsUploadSlot = true;
      } else {
        deadlineTimer = setTimeout(() => {
          if (!bodyComplete) reject(408);
        }, limits.requestDeadlineMs);
        deadlineTimer.unref();
      }
      resetIdle();
      bodyObservers.set(request, (chunk) => {
        if (stopped) return false;
        if (chunk === null) {
          bodyComplete = true;
          clearTimeout(idleTimer);
          clearTimeout(deadlineTimer);
          if (upload) {
            // The existing relay allows 60s after the last byte. Bound an
            // unresponsive handler too without imposing a total upload time.
            responseTimer = setTimeout(
              () => reject(504),
              limits.uploadResponseTimeoutMs,
            );
            responseTimer.unref();
          }
        } else if (chunk.byteLength > 0) {
          received += chunk.byteLength;
          if (received > maxBytes) {
            reject(413);
            return false;
          }
          resetIdle();
        }
        return true;
      });
      try {
        Promise.resolve(handler(request, response)).catch(() => reject(500));
      } catch {
        reject(500);
      }
    },
  );
  server.maxHeadersCount = limits.maxHeaders;
  server.maxConnections = limits.maxConnections;
  // No product route uses HTTP Upgrade or Expect: 100-continue. Reject these
  // before Next handles an upgrade or solicits a request body.
  server.on("upgrade", (_request, socket) => socket.destroy());
  server.on("checkContinue", (_request, response) => {
    response.writeHead(417, { connection: "close", "content-length": "0" });
    response.end(() => response.socket?.destroySoon());
  });
  return server;
};

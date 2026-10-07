import { randomUUID } from "node:crypto";

import {
  isCommunityConflictError,
  isCommunityInputError,
  isCommunityNotFoundError,
  parseWorkPublishingSegment,
} from "@moya/api";
import {
  apiErrorSchema,
  workPublishingFailureCodeSchema,
} from "@moya/contracts/schemas";

import { sendJson } from "../http/json-response.js";
import { exemptFromRequestDeadline } from "../server.js";

import type { WorkPublishingService } from "@moya/api";
import type { ApiErrorCode } from "@moya/contracts";
import type { IncomingMessage, ServerResponse } from "node:http";

const privateHeaders = {
  "cache-control": "private, no-store",
  vary: "Authorization",
};
const attemptPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const lengthPattern = /^[1-9]\d{0,15}$/u;
const failureCodes: ReadonlySet<string> = new Set(
  workPublishingFailureCodeSchema.options,
);

export type TransferRefusalStatus = 401 | 403 | 404 | 409 | 413 | 422 | 503;

/**
 * An error answer for a transfer whose body may still be arriving.
 *
 * The answer does not announce `Connection: close`: a client still streaming
 * the body (the Web relay's half-duplex fetch) is not told to give up the
 * exchange, reads the answer and decides itself when to stop sending. Closing
 * a socket with unread request bytes resets it, so the complete answer is
 * written at once and the connection stays open while the remaining bytes are
 * read and discarded, until the body ends or `readMs` passed. Only then the
 * response ends and the connection closes: gracefully after a body that
 * ended, at once while bytes are still arriving. A body that had already
 * arrived keeps the connection the client asked for.
 */
export const refuseTransfer = (
  request: IncomingMessage,
  response: ServerResponse,
  status: TransferRefusalStatus,
  code: ApiErrorCode,
  message: string,
  readMs: number,
): void => {
  if (response.headersSent) return;
  const payload = JSON.stringify(
    apiErrorSchema.parse({ error: { code, message, requestId: randomUUID() } }),
  );
  // A client error listener keeps a reset during the window from surfacing
  // as an unhandled stream error; `close` follows it.
  request.on("error", () => undefined);
  response.writeHead(status, {
    "content-length": Buffer.byteLength(payload),
    "content-type": "application/json; charset=utf-8",
    ...privateHeaders,
  });
  if (request.complete || request.readableEnded || request.destroyed) {
    response.end(payload);
    // Bytes the parser already received but nobody read: bounded, drop them.
    if (!request.readableEnded && !request.destroyed) request.resume();
    return;
  }
  response.write(payload);
  const socket = request.socket;
  let finished = false;
  const discard = () => {
    while (request.read() !== null);
  };
  const finish = (bodyEnded: boolean) => {
    if (finished) return;
    finished = true;
    clearTimeout(window);
    request.off("readable", discard);
    request.off("end", onEnd);
    request.off("close", onClose);
    if (response.destroyed || socket.destroyed) return;
    if (bodyEnded) {
      // Nothing unread is left: the answer ends, then the connection closes
      // after it flushed.
      response.end(() => {
        socket.destroySoon();
      });
      return;
    }
    // The grace passed while bytes still arrive: this connection cannot
    // continue, and its client had the whole window to read the answer.
    response.end();
    socket.destroy();
  };
  const onEnd = () => {
    finish(true);
  };
  const onClose = () => {
    finish(false);
  };
  const window = setTimeout(() => {
    finish(false);
  }, readMs);
  window.unref();
  request.on("readable", discard);
  request.once("end", onEnd);
  request.once("close", onClose);
  discard();
};

/**
 * The request body as an async iterable that never destroys the socket when
 * the consumer stops early (an early answer must still reach the client).
 * It fails when the client aborts before the declared length arrived.
 */
const requestBody = (request: IncomingMessage): AsyncIterable<Uint8Array> => ({
  [Symbol.asyncIterator]: (): AsyncIterator<Uint8Array> => {
    let ended = request.readableEnded;
    let failed = false;
    let wake: (() => void) | null = null;
    const notify = () => {
      const resume = wake;
      wake = null;
      resume?.();
    };
    const onEnd = () => {
      ended = true;
      notify();
    };
    const onFailure = () => {
      if (!ended) failed = true;
      notify();
    };
    const detach = () => {
      request.off("readable", notify);
      request.off("end", onEnd);
      request.off("aborted", onFailure);
      request.off("error", onFailure);
      request.off("close", onFailure);
    };
    request.on("readable", notify);
    request.once("end", onEnd);
    request.once("aborted", onFailure);
    request.once("error", onFailure);
    request.once("close", onFailure);
    return {
      next: async () => {
        for (;;) {
          const chunk = request.read() as Buffer | null;
          if (chunk !== null) return { value: chunk, done: false };
          if (ended) {
            detach();
            return { value: undefined, done: true };
          }
          if (failed || request.destroyed) {
            detach();
            throw new Error("The transfer ended before its declared length");
          }
          await new Promise<void>((resolve) => {
            wake = resolve;
          });
        }
      },
      return: async () => {
        detach();
        return { value: undefined, done: true };
      },
    };
  },
});

/**
 * `POST /v1/community/publishing/uploads/:componentId` (design §3.4, §8.1,
 * §9.4): one raw component body behind the attempt/cancel fence. The declared
 * `content-length` must equal the registered component size; no automatic
 * retry exists anywhere, and a cancel in this process answers 409 at once.
 * The body has no whole-request deadline: a transfer that delivers no byte
 * for the service's idle timeout ends and its connection closes.
 */
export const handlePublishingUpload = async (
  request: IncomingMessage,
  response: ServerResponse,
  service: WorkPublishingService,
  actorId: string,
  componentId: string,
): Promise<void> => {
  exemptFromRequestDeadline(request);
  const refuse = (
    status: TransferRefusalStatus,
    code: ApiErrorCode,
    message: string,
  ) =>
    refuseTransfer(
      request,
      response,
      status,
      code,
      message,
      service.transferPolicy.refusalReadMs,
    );
  // A client error listener keeps an aborted transfer from surfacing as an
  // unhandled stream error; the body reader reports the abort itself.
  request.on("error", () => undefined);
  try {
    if (!service.acceptsMedia) {
      refuse(503, "SERVICE_UNAVAILABLE", "Media uploads are not available");
      return;
    }
    const length = request.headers["content-length"];
    const attempt = request.headers["x-upload-attempt"];
    if (
      new URL(request.url ?? "/", "http://request.invalid").search !== "" ||
      request.headers["content-type"] !== "application/octet-stream" ||
      request.headers["transfer-encoding"] !== undefined ||
      typeof length !== "string" ||
      !lengthPattern.test(length) ||
      !Number.isSafeInteger(Number(length)) ||
      typeof attempt !== "string" ||
      !attemptPattern.test(attempt)
    ) {
      refuse(422, "INVALID_INPUT", "Invalid community input");
      return;
    }

    const disconnect = new AbortController();
    const onGone = () => {
      if (!response.writableEnded) disconnect.abort();
    };
    request.once("aborted", onGone);
    response.once("close", onGone);
    try {
      const component = parseWorkPublishingSegment("componentId", componentId);
      const outcome = await service.uploadComponent(actorId, component, {
        attempt,
        contentLength: Number(length),
        source: requestBody(request),
        signal: disconnect.signal,
        onStopped: () => refuse(409, "CONFLICT", "The transfer was cancelled"),
      });
      switch (outcome.status) {
        case "committed":
          if (!response.headersSent)
            sendJson(response, 200, outcome.result, privateHeaders);
          return;
        case "superseded":
          refuse(409, "CONFLICT", "The transfer was superseded");
          return;
        case "cancelled":
          refuse(409, "CONFLICT", "The transfer was cancelled");
          return;
        case "too_large":
          refuse(413, "INVALID_INPUT", "component_too_large");
          return;
        case "incomplete":
          refuse(422, "INVALID_INPUT", "Invalid community input");
          return;
        case "aborted":
        case "stalled":
          // Nobody is left to answer, or the peer stopped sending: close.
          if (!response.headersSent) response.destroy();
          return;
      }
    } finally {
      request.off("aborted", onGone);
      response.off("close", onGone);
    }
  } catch (error) {
    if (isCommunityInputError(error)) {
      const code = failureCodes.has(error.message) ? error.message : null;
      if (code === "component_too_large") refuse(413, "INVALID_INPUT", code);
      else refuse(422, "INVALID_INPUT", code ?? "Invalid community input");
    } else if (isCommunityNotFoundError(error))
      refuse(404, "ITEM_NOT_FOUND", "This item is unavailable");
    else if (isCommunityConflictError(error))
      refuse(409, "CONFLICT", error.message);
    else
      refuse(
        503,
        "SERVICE_UNAVAILABLE",
        "Community service is temporarily unavailable",
      );
  }
};

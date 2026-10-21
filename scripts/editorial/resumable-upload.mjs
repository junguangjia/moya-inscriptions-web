/** Native authenticated chunk transport. Never logs content or credentials. */
import { createHash } from "node:crypto";
import { NativeStreamBody, NativeChunkBody } from "./native-stream-fetch.mjs";
import * as uploadContract from "../../packages/contracts/dist/internal/editorial/index.js";

const {
  MEDIA_UPLOAD_CHUNK_BYTES,
  MEDIA_UPLOAD_STREAM_VERSION,
  editorialMediaUploadStartSchema,
  editorialMediaUploadSessionSchema,
  editorialMediaUploadChunkResultSchema,
  editorialMediaUploadCompleteResultSchema,
} = uploadContract;

const digest = (value) => createHash("sha256").update(value).digest("hex");
const failed = (code, retryable = false, diagnostics) => ({
  ok: false,
  code,
  retryable,
  ...(diagnostics ? { diagnostics } : {}),
});
const aborted = (signal) => signal?.aborted === true;

function parseResult(response, schema) {
  if (!response.ok) return response;
  if (response.result?.ok !== true)
    return failed("MEDIA_UPLOAD_RESPONSE_INVALID");
  const parsed = schema.safeParse(response.result.result);
  return parsed.success
    ? {
        ok: true,
        result: parsed.data,
        streamUploadVersion: response.streamUploadVersion ?? null,
      }
    : failed("MEDIA_UPLOAD_RESPONSE_INVALID");
}

function validSession(session, bytes, uploadId) {
  return (
    (!uploadId || session.uploadId === uploadId) &&
    session.chunkBytes === MEDIA_UPLOAD_CHUNK_BYTES &&
    session.chunkCount === Math.ceil(bytes / MEDIA_UPLOAD_CHUNK_BYTES) &&
    new Set(session.receivedIndices).size === session.receivedIndices.length &&
    session.receivedIndices.every((index) => index < session.chunkCount) &&
    (session.state === "uploading" ||
      session.receivedIndices.length === session.chunkCount)
  );
}

const acknowledgedBytes = (session, bytes) =>
  session.receivedIndices.reduce(
    (total, index) =>
      total +
      Math.min(
        MEDIA_UPLOAD_CHUNK_BYTES,
        bytes - index * MEDIA_UPLOAD_CHUNK_BYTES,
      ),
    0,
  );

/** Missing contiguous spans preserve older noncontiguous chunk receipts. */
export function missingUploadSpans(session, bytes) {
  const received = new Set(session.receivedIndices);
  const spans = [];
  for (let index = 0; index < session.chunkCount;) {
    if (received.has(index)) {
      index++;
      continue;
    }
    const first = index;
    while (index < session.chunkCount && !received.has(index)) index++;
    const offset = first * MEDIA_UPLOAD_CHUNK_BYTES;
    spans.push({
      offset,
      length: Math.min(bytes, index * MEDIA_UPLOAD_CHUNK_BYTES) - offset,
    });
  }
  return spans;
}

async function streamMissing({
  session,
  bytes,
  expected,
  post,
  inspect,
  signal,
  onProgress,
}) {
  const initialAck = acknowledgedBytes(session, bytes.length);
  let wireBytesSent = 0,
    sentBytes = 0,
    lastTransferAt = null,
    continuations = 0;
  const notify = (phase) =>
    onProgress({
      mediaId: expected.mediaId,
      totalBytes: bytes.length,
      acknowledgedBytes: acknowledgedBytes(session, bytes.length),
      reusedBytes: initialAck,
      sentBytes,
      wireBytesSent,
      lastTransferAt,
      phase,
    });
  await notify("streaming");
  for (;;) {
    const span = missingUploadSpans(session, bytes.length)[0];
    if (!span) {
      await notify("confirming");
      return {
        ok: true,
        result: session,
        progress: {
          mediaId: expected.mediaId,
          totalBytes: bytes.length,
          acknowledgedBytes: acknowledgedBytes(session, bytes.length),
          reusedBytes: initialAck,
          sentBytes,
          wireBytesSent,
          lastTransferAt,
        },
      };
    }
    if (aborted(signal)) return failed("TRANSPORT_UNCERTAIN", true);
    const ackBefore = acknowledgedBytes(session, bytes.length) - initialAck;
    const body = new NativeStreamBody(
      bytes,
      span.offset,
      span.length,
      async (count, written) => {
        wireBytesSent += count;
        sentBytes = Math.max(sentBytes, ackBefore + written);
        lastTransferAt = new Date().toISOString();
        await notify("streaming");
      },
    );
    let response = parseResult(
      await post(
        `/api/editorial/media-upload/stream/${session.uploadId}/${span.offset}`,
        body,
        {
          "Content-Length": String(span.length),
          "x-editorial-stream-sha256": digest(
            bytes.subarray(span.offset, span.offset + span.length),
          ),
        },
      ),
      editorialMediaUploadSessionSchema,
    );
    if (!response.ok) {
      if (!response.retryable || aborted(signal) || continuations++ >= 1)
        return response;
      await notify("retrying");
      response = await inspect(session.uploadId);
      if (!response.ok) return response; // Never send while old request/session lock is uncertain.
      if (
        !validSession(response.result, bytes.length, session.uploadId) ||
        session.receivedIndices.some(
          (index) => !response.result.receivedIndices.includes(index),
        )
      )
        return failed("MEDIA_UPLOAD_RESPONSE_INVALID");
      session = response.result;
      sentBytes = acknowledgedBytes(session, bytes.length) - initialAck;
      await notify("retrying");
      continue;
    }
    if (
      !validSession(response.result, bytes.length, session.uploadId) ||
      session.receivedIndices.some(
        (index) => !response.result.receivedIndices.includes(index),
      ) ||
      Array.from(
        { length: Math.ceil(span.length / MEDIA_UPLOAD_CHUNK_BYTES) },
        (_, index) => span.offset / MEDIA_UPLOAD_CHUNK_BYTES + index,
      ).some((index) => !response.result.receivedIndices.includes(index))
    )
      return failed("MEDIA_UPLOAD_RESPONSE_INVALID");
    session = response.result;
    sentBytes = acknowledgedBytes(session, bytes.length) - initialAck;
    await notify("confirming");
  }
}

// One global eight-request pool across all photographs/transports in this Node job.
let activeChunkRequests = 0;
const chunkWaiters = [];
async function withChunkSlot(work) {
  if (activeChunkRequests < 8) activeChunkRequests++;
  else await new Promise((resolve) => chunkWaiters.push(resolve));
  try {
    return await work();
  } finally {
    if (chunkWaiters.length) chunkWaiters.shift()();
    else activeChunkRequests--;
  }
}

async function parallelChunks({
  session,
  bytes,
  expected,
  post,
  inspect,
  signal,
  onProgress,
}) {
  const initial = new Set(session.receivedIndices);
  let received = new Set(initial),
    wireBytesSent = 0,
    lastTransferAt = null,
    continuation = 0;
  const sentByIndex = new Map();
  const byteCount = (indices) =>
    [...indices].reduce(
      (sum, index) =>
        sum +
        Math.min(
          MEDIA_UPLOAD_CHUNK_BYTES,
          bytes.length - index * MEDIA_UPLOAD_CHUNK_BYTES,
        ),
      0,
    );
  const snapshot = () => ({
    mediaId: expected.mediaId,
    totalBytes: bytes.length,
    acknowledgedBytes: byteCount(received),
    reusedBytes: byteCount(initial),
    sentBytes: [...sentByIndex.values()].reduce((sum, n) => sum + n, 0),
    wireBytesSent,
    lastTransferAt,
  });
  const notify = async (phase) => {
    try {
      await onProgress({ ...snapshot(), phase });
    } catch {
      /* observer only */
    }
  };
  await notify("streaming");
  for (;;) {
    const missing = Array.from(
      { length: session.chunkCount },
      (_, i) => i,
    ).filter((i) => !received.has(i));
    if (!missing.length) {
      await notify("confirming");
      return { ok: true, result: session, progress: snapshot() };
    }
    let cursor = 0,
      stopped = false;
    const failures = [];
    const worker = async () => {
      while (!stopped && !aborted(signal) && cursor < missing.length) {
        const index = missing[cursor++];
        await withChunkSlot(async () => {
          if (stopped || aborted(signal)) return;
          const chunk = bytes.subarray(
            index * MEDIA_UPLOAD_CHUNK_BYTES,
            Math.min(bytes.length, (index + 1) * MEDIA_UPLOAD_CHUNK_BYTES),
          );
          const sha256 = digest(chunk);
          const body = new NativeChunkBody(
            chunk,
            index,
            async (count, written) => {
              wireBytesSent += count;
              sentByIndex.set(
                index,
                Math.max(sentByIndex.get(index) ?? 0, written),
              );
              lastTransferAt = new Date().toISOString();
              await notify("streaming");
            },
          );
          let response;
          try {
            response = parseResult(
              await post(
                `/api/editorial/media-upload/chunk/${session.uploadId}/${index}`,
                body,
                {
                  "Content-Length": String(chunk.length),
                  "x-editorial-chunk-sha256": sha256,
                },
              ),
              editorialMediaUploadChunkResultSchema,
            );
          } catch {
            response = failed("TRANSPORT_UNCERTAIN", true);
          }
          if (
            response.ok &&
            (response.result.uploadId !== session.uploadId ||
              response.result.index !== index ||
              response.result.bytes !== chunk.length ||
              response.result.sha256 !== sha256)
          )
            response = failed("MEDIA_UPLOAD_RESPONSE_INVALID");
          if (response.ok) {
            sentByIndex.set(index, chunk.length);
            received.add(index);
            await notify("streaming");
          } else {
            stopped = true;
            failures.push(response);
          }
        });
      }
    };
    // No status or continuation can overlap an outstanding uncertain body.
    await Promise.all(
      Array.from({ length: Math.min(4, missing.length) }, worker),
    );
    if (aborted(signal)) {
      await notify("idle");
      return failed("TRANSPORT_UNCERTAIN", true);
    }
    if (!failures.length) {
      session = {
        ...session,
        receivedIndices: [...received],
        state: received.size === session.chunkCount ? "ready" : "uploading",
      };
      continue;
    }
    const nonretryable = failures.find((value) => !value.retryable);
    if (nonretryable) {
      await notify("idle");
      return nonretryable;
    }
    await notify("retrying");
    const reconciled = await inspect(session.uploadId);
    if (!reconciled.ok) {
      await notify("idle");
      return reconciled;
    }
    if (
      !validSession(reconciled.result, bytes.length, session.uploadId) ||
      [...received].some(
        (index) => !reconciled.result.receivedIndices.includes(index),
      )
    ) {
      await notify("idle");
      return failed("MEDIA_UPLOAD_RESPONSE_INVALID");
    }
    session = reconciled.result;
    received = new Set(session.receivedIndices);
    for (const index of received)
      if (!initial.has(index))
        sentByIndex.set(
          index,
          Math.min(
            MEDIA_UPLOAD_CHUNK_BYTES,
            bytes.length - index * MEDIA_UPLOAD_CHUNK_BYTES,
          ),
        );
    // Uncertain transmitted counters may roll back only to the durable confirmed prefix.
    for (const index of missing)
      if (!received.has(index)) sentByIndex.delete(index);
    await notify("retrying");
    if (received.size === session.chunkCount) continue;
    if (continuation++ >= 1) {
      await notify("idle");
      return failures[0];
    }
  }
}

/**
 * send uses the existing bounded/sanitized native HTTP client. A missing reply
 * is reconciled against durable session state before one bounded continuation.
 */
export async function stageMediaUpload({
  item,
  bytes,
  transferId = item.requestHash,
  send,
  signal,
  onProgress = async () => {},
  complete = (operation) => operation(),
  existingOnly = false,
  uploadMode = "auto",
}) {
  if (aborted(signal)) return failed("TRANSPORT_UNCERTAIN", true);
  if (!["auto", "parallel-chunks-v1"].includes(uploadMode))
    return failed("MEDIA_UPLOAD_INPUT_INVALID");
  if (
    !Number.isSafeInteger(MEDIA_UPLOAD_CHUNK_BYTES) ||
    typeof editorialMediaUploadStartSchema?.safeParse !== "function" ||
    typeof editorialMediaUploadSessionSchema?.safeParse !== "function" ||
    typeof editorialMediaUploadChunkResultSchema?.safeParse !== "function" ||
    typeof editorialMediaUploadCompleteResultSchema?.safeParse !== "function"
  )
    return failed("MEDIA_UPLOAD_PROTOCOL_UNAVAILABLE");
  if (!(bytes instanceof Uint8Array) || typeof send !== "function")
    return failed("MEDIA_UPLOAD_INPUT_INVALID");
  const expected = {
    transferId,
    existingOnly,
    mediaId: item.body.mediaId,
    catalogId: item.body.catalogId,
    sha256: item.file.sha256,
    bytes: bytes.length,
    mimeType: item.file.mimeType,
    alt: item.body.alt,
    ...(item.body.rights === undefined ? {} : { rights: item.body.rights }),
    ...(item.body.orderConfidence === undefined
      ? {}
      : { orderConfidence: item.body.orderConfidence }),
  };
  if (
    !editorialMediaUploadStartSchema.safeParse(expected).success ||
    bytes.length !== item.file.size ||
    digest(bytes) !== expected.sha256
  )
    return failed("MEDIA_SOURCE_CHANGED");
  const post = (route, body, headers) =>
    send(route, "POST", body, signal, headers);
  const inspect = async (uploadId) =>
    parseResult(
      await post("/api/editorial/media-upload/status", { uploadId }),
      editorialMediaUploadSessionSchema,
    );
  let started = parseResult(
    await post("/api/editorial/media-upload/start", expected),
    editorialMediaUploadSessionSchema,
  );
  if (!started.ok && started.retryable && !aborted(signal)) {
    // The same actor, transferId and immutable metadata identify the same
    // session even if the server's successful start reply was lost.
    started = parseResult(
      await post("/api/editorial/media-upload/start", expected),
      editorialMediaUploadSessionSchema,
    );
  }
  if (!started.ok) return started;
  let session = started.result;
  if (!validSession(session, bytes.length))
    return failed("MEDIA_UPLOAD_RESPONSE_INVALID");
  const uploadId = session.uploadId;
  await onProgress({
    mediaId: expected.mediaId,
    acknowledgedBytes: acknowledgedBytes(session, bytes.length),
    totalBytes: bytes.length,
  });
  let streamProgress;
  if (uploadMode === "parallel-chunks-v1") {
    const chunked = await parallelChunks({
      session,
      bytes,
      expected,
      post,
      inspect,
      signal,
      onProgress,
    });
    if (!chunked.ok) return chunked;
    streamProgress = chunked.progress;
  } else if (started.streamUploadVersion !== null) {
    if (
      started.streamUploadVersion !== MEDIA_UPLOAD_STREAM_VERSION ||
      MEDIA_UPLOAD_STREAM_VERSION !== "1"
    )
      return failed("MEDIA_UPLOAD_PROTOCOL_UNAVAILABLE");
    const streamed = await streamMissing({
      session,
      bytes,
      expected,
      post,
      inspect,
      signal,
      onProgress,
    });
    if (!streamed.ok) return streamed;
    streamProgress = streamed.progress;
  } else
    for (let index = 0; index < session.chunkCount; index += 1) {
      if (aborted(signal)) return failed("TRANSPORT_UNCERTAIN", true);
      if (session.receivedIndices.includes(index)) continue;
      const chunk = bytes.subarray(
        index * MEDIA_UPLOAD_CHUNK_BYTES,
        Math.min(bytes.length, (index + 1) * MEDIA_UPLOAD_CHUNK_BYTES),
      );
      const route = `/api/editorial/media-upload/chunk/${uploadId}/${index}`;
      const headers = { "x-editorial-chunk-sha256": digest(chunk) };
      let response = parseResult(
        await post(route, chunk, headers),
        editorialMediaUploadChunkResultSchema,
      );
      let reconciledSession;
      if (!response.ok && response.retryable && !aborted(signal)) {
        const reconciled = await inspect(uploadId);
        if (!reconciled.ok) return reconciled;
        if (!validSession(reconciled.result, bytes.length, uploadId))
          return failed("MEDIA_UPLOAD_RESPONSE_INVALID");
        if (reconciled.result.receivedIndices.includes(index)) {
          reconciledSession = reconciled.result;
          response = { ok: true };
        } else
          response = parseResult(
            await post(route, chunk, headers),
            editorialMediaUploadChunkResultSchema,
          );
      }
      if (!response.ok) return response;
      if (
        (!reconciledSession &&
          (response.result.uploadId !== uploadId ||
            response.result.index !== index ||
            response.result.bytes !== chunk.length ||
            response.result.sha256 !== headers["x-editorial-chunk-sha256"])) ||
        (reconciledSession &&
          session.receivedIndices.some(
            (previous) => !reconciledSession.receivedIndices.includes(previous),
          ))
      )
        return failed("MEDIA_UPLOAD_RESPONSE_INVALID");
      session = reconciledSession ?? {
        ...session,
        receivedIndices: [...session.receivedIndices, index],
      };
      await onProgress({
        mediaId: expected.mediaId,
        acknowledgedBytes: acknowledgedBytes(session, bytes.length),
        totalBytes: bytes.length,
      });
    }
  if (aborted(signal)) return failed("TRANSPORT_UNCERTAIN", true);
  // Keep the one full-image native decoder/storage operation serial while
  // separate photographs' bounded chunks can use the existing worker limit.
  const result = await complete(async () => {
    if (aborted(signal)) return failed("TRANSPORT_UNCERTAIN", true);
    let response = parseResult(
      await post("/api/editorial/media-upload/complete", { uploadId }),
      editorialMediaUploadCompleteResultSchema,
    );
    if (!response.ok && response.retryable && !aborted(signal)) {
      const reconciled = await inspect(uploadId);
      if (!reconciled.ok) return reconciled;
      if (!validSession(reconciled.result, bytes.length, uploadId))
        return failed("MEDIA_UPLOAD_RESPONSE_INVALID");
      // Finalize reconciles the durable native MediaId before a second create.
      response = parseResult(
        await post("/api/editorial/media-upload/complete", { uploadId }),
        editorialMediaUploadCompleteResultSchema,
      );
    }
    return response;
  });
  if (!result.ok) return result;
  const media = result.result.media;
  if (
    result.result.validatedBytes !== bytes.length ||
    result.result.validatedSha256 !== expected.sha256 ||
    (existingOnly && result.result.reused !== true) ||
    media.mediaId !== expected.mediaId ||
    media.catalogId !== expected.catalogId ||
    media.sha256 !== expected.sha256 ||
    media.filesize !== bytes.length ||
    media.mimeType !== expected.mimeType ||
    ["alt", "rights", "orderConfidence"].some(
      (field) => (media[field] ?? undefined) !== (expected[field] ?? undefined),
    )
  )
    return failed("MEDIA_UPLOAD_READBACK_MISMATCH");
  if (streamProgress)
    await onProgress({ ...streamProgress, phase: "complete" });
  return {
    ok: true,
    result: media,
    reused: result.result.reused,
    validatedBytes: result.result.validatedBytes,
    validatedSha256: result.result.validatedSha256,
  };
}

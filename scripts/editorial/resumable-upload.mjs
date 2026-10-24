/** Native authenticated chunk transport. Never logs content or credentials. */
import { createHash } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { URL } from "node:url";
import { NativeStreamBody, NativeChunkBody } from "./native-stream-fetch.mjs";
import * as uploadContract from "../../packages/contracts/dist/internal/editorial/index.js";

const {
  MEDIA_UPLOAD_CHUNK_BYTES,
  MEDIA_UPLOAD_STREAM_VERSION,
  MAX_MEDIA_UPLOAD_BYTES,
  CATALOG_ORIGINAL_MAX_BYTES,
  editorialMediaUploadStartSchema,
  editorialMediaUploadSessionSchema,
  editorialMediaUploadChunkResultSchema,
  editorialMediaUploadCompleteResultSchema,
  editorialMediaIngestStartSchema,
  editorialMediaIngestStartResultSchema,
  editorialMediaIngestCompleteResultSchema,
  editorialMediaIngestAbandonResultSchema,
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

export const MEDIA_INGEST_ROUTES = Object.freeze({
  start: "/api/editorial/media-ingest/start",
  complete: "/api/editorial/media-ingest/complete",
  abandon: "/api/editorial/media-ingest/abandon",
});
const STAGING_PATH = /^\/catalog-ingest\/v1\/([a-f0-9]{2})\/([a-f0-9]{64})$/;
const DNS_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/**
 * The configured COS API host suffix in lower case without a leading dot, or
 * null unless it is at least two DNS labels with an alphabetic top label, so
 * no IP literal or single name can match.
 */
export function normalizeCosHostSuffix(value) {
  if (typeof value !== "string") return null;
  const lower = value.toLowerCase();
  const suffix = lower.startsWith(".") ? lower.slice(1) : lower;
  const labels = suffix.split(".");
  return suffix.length <= 253 &&
    labels.length >= 2 &&
    labels.every((label) => DNS_LABEL.test(label)) &&
    /[a-z]/.test(labels.at(-1))
    ? suffix
    : null;
}

/**
 * The staging PUT target or null: https on the default port, a host strictly
 * under the configured suffix (the virtual-hosted bucket), no credentials or
 * fragment, and the path of this ingest's staging key (any ingest's when
 * ingestId is omitted). The signature stays in the query. Never logged.
 */
export function stagingUploadTarget(value, hostSuffix, ingestId) {
  const suffix = normalizeCosHostSuffix(hostSuffix);
  if (!suffix || typeof value !== "string" || value.includes("#")) return null;
  let url;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  const key = STAGING_PATH.exec(url.pathname);
  return url.protocol === "https:" &&
    url.port === "" &&
    !url.username &&
    !url.password &&
    url.hostname.endsWith(`.${suffix}`) &&
    key &&
    key[1] === key[2].slice(0, 2) &&
    (ingestId === undefined || key[2] === ingestId)
    ? url
    : null;
}

/**
 * The immutable ingest intent of an item and its exact bytes, or null when
 * the bytes are not the item's. start, complete and abandon all send it.
 */
export function mediaIngestIntent({ item, bytes, transferId }) {
  if (
    !(bytes instanceof Uint8Array) ||
    bytes.length !== item?.file?.size ||
    digest(bytes) !== item.file.sha256
  )
    return null;
  const intent = {
    transferId,
    catalogId: item.body.catalogId,
    mediaId: item.body.mediaId,
    sha256: item.file.sha256,
    bytes: bytes.length,
    mimeType: item.file.mimeType,
    md5Base64: createHash("md5").update(bytes).digest("base64"),
    ...(item.file.width === undefined ? {} : { width: item.file.width }),
    ...(item.file.height === undefined ? {} : { height: item.file.height }),
    alt: item.body.alt,
    ...(item.body.rights === undefined ? {} : { rights: item.body.rights }),
    ...(item.body.orderConfidence === undefined
      ? {}
      : { orderConfidence: item.body.orderConfidence }),
  };
  return editorialMediaIngestStartSchema.safeParse(intent).success
    ? intent
    : null;
}

/** The anonymous Range 0-0 outcomes for a final original (direct-ingest.mjs). */
const PRIVACY = new Set([
  "private",
  "public",
  "unexpected",
  "uncertain",
  "skipped",
]);
const ingestRetryable = (response) =>
  response.retryable === true && response.code !== "INGEST_FINAL_INVALID";

/** The content-addressed key the Admin derives (collection.ts) for new bytes. */
const registeredKey = (intent) => {
  const extension =
    intent.mimeType === "image/jpeg" ? "jpg" : intent.mimeType.split("/")[1];
  const filename = `${digest(String(intent.mediaId))}-${intent.sha256}.${extension}`;
  return {
    filename,
    objectKey: `editorial/${digest(String(intent.catalogId))}/${filename}`,
  };
};

const registeredMatches = (media, intent) =>
  media.mediaId === intent.mediaId &&
  media.catalogId === intent.catalogId &&
  media.sha256 === intent.sha256 &&
  media.filesize === intent.bytes &&
  media.mimeType === intent.mimeType &&
  media.alt === intent.alt &&
  (media.rights ?? undefined) === (intent.rights ?? undefined) &&
  (media.orderConfidence ?? undefined) ===
    (intent.orderConfidence ?? undefined) &&
  (intent.width === undefined || media.width === intent.width) &&
  (intent.height === undefined || media.height === intent.height);

/**
 * Catalog original ingest (direct-cos-v1): start signs one staging PUT, the
 * injected putObject sends the bytes straight to COS with exactly the signed
 * headers, and complete has the Admin verify, copy and register them. start,
 * the PUT (forbid-overwrite) and complete are each safe to repeat, so every
 * uncertain answer is retried. A 404 from an ingest route means the routes
 * are absent ({fallback: true}). A terminal failure after a PUT, in this run
 * or the staged run resumeStaged continues (start included), is final and
 * abandons the staging key; a retryable one keeps it, and resumeStaged then
 * skips the PUT after start. A start that finds the mediaId registered after
 * such a PUT reuses the doc and abandons the key first (best effort), as the
 * Admin's complete deletes it on a reuse. privacyCheck, when given, receives
 * the signed URL (for its bucket origin) and the key of each new
 * registration; only its status string is returned. Every answer but a
 * fallback carries metrics: the bytes, each PUT's milliseconds and status,
 * and each complete phase's milliseconds (numbers only, for the canary's
 * record). ownsStaging, when
 * given, is the caller's record of the staging id an earlier run may have
 * written under (the Admin derives it from the caller): a grant for another
 * id is another credential's, so the item stops, final, with
 * INGEST_ACTOR_MISMATCH before any PUT, complete or abandon, and an abandon
 * that answers for another id clears nothing.
 */
async function ingestDirect(options) {
  const metrics = { bytes: options.bytes.length, puts: [], completes: [] };
  const result = await ingestDirectRun({ ...options, metrics });
  return result.fallback ? result : { ...result, metrics };
}
async function ingestDirectRun({
  intent,
  bytes,
  md5Base64,
  post,
  putObject,
  put,
  complete,
  privacyCheck,
  hostSuffix,
  signal,
  onProgress,
  resumeStaged,
  ownsStaging,
  retryDelayMs,
  now,
  metrics,
}) {
  const owned = (ingestId) =>
    typeof ownsStaging !== "function" || ownsStaging(ingestId) === true;
  const control = async (route, body, schema, attempts) => {
    let response;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      if (attempt)
        await sleep(retryDelayMs * 2 ** (attempt - 1), undefined, {
          signal,
        }).catch(() => {});
      if (aborted(signal)) return failed("TRANSPORT_UNCERTAIN", true);
      try {
        response = parseResult(await post(route, body), schema);
      } catch {
        response = failed("TRANSPORT_UNCERTAIN", true);
      }
      if (response.ok || !ingestRetryable(response)) return response;
    }
    return response;
  };
  // ingestId (once start granted one): the caller's own staging id, which a
  // batch's state can bind to its actor; never a URL or key.
  const notify = (phase, staged) =>
    onProgress({
      mediaId: intent.mediaId,
      totalBytes: bytes.length,
      acknowledgedBytes: staged ? bytes.length : 0,
      phase,
      ...(grant ? { ingestId: grant.ingestId } : {}),
    });
  // Only server-derived facts are accepted, and new bytes only under the
  // content-addressed key; a reuse reports the doc's own registered facts.
  const registered = (media, reused, validatedMd5) => {
    const key = registeredKey(intent);
    return registeredMatches(media, intent) &&
      (reused ||
        (media.objectKey === key.objectKey && media.filename === key.filename))
      ? {
          ok: true,
          result: media,
          reused,
          validatedBytes: media.filesize,
          validatedSha256: media.sha256,
          validatedMd5,
          transport: "direct-cos-v1",
        }
      : failed("MEDIA_UPLOAD_READBACK_MISMATCH");
  };
  const begin = async () => {
    const response = await control(
      MEDIA_INGEST_ROUTES.start,
      intent,
      editorialMediaIngestStartResultSchema,
      3,
    );
    if (!response.ok || response.result.state === "registered") return response;
    const { ingestId, upload } = response.result,
      expiresAt = Date.parse(upload.expiresAt);
    if (
      !stagingUploadTarget(upload.url, hostSuffix, ingestId) ||
      upload.headers["content-length"] !== String(bytes.length) ||
      upload.headers["content-type"] !== intent.mimeType ||
      upload.headers["content-md5"] !== md5Base64 ||
      !Number.isFinite(expiresAt)
    )
      return failed("MEDIA_UPLOAD_RESPONSE_INVALID");
    if (!owned(ingestId))
      return { ...failed("INGEST_ACTOR_MISMATCH"), foreign: true };
    return {
      ok: true,
      result: { state: "upload", ingestId, upload, expiresAt, used: false },
    };
  };
  // staged: skip the PUT on this pass (the first pass of a resumed item);
  // every path back to the loop's top clears it, and a PUT that lands goes
  // straight on to complete.
  let grant,
    staged = resumeStaged === true,
    putBegan = staged,
    putAttempts = 0,
    lastPutStatus = 0,
    rePut = false;
  // Final: the item fails (never retried, even after a 5xx such as
  // INGEST_FINAL_INVALID), and a staging key a PUT may have written, in this
  // run or the one resumed, is abandoned.
  const giveUp = async ({ foreign, ...failure }) => {
    const final = { ...failure, retryable: false };
    // Another credential's grant: the recorded staging key is not this
    // caller's to abandon, and nothing went under the new one.
    if (foreign || !putBegan || aborted(signal)) return final;
    const response = await control(
      MEDIA_INGEST_ROUTES.abandon,
      { intent },
      editorialMediaIngestAbandonResultSchema,
      2,
    );
    // stagingCleared: nothing is left under this actor's staging key (the
    // grant's, or before any grant the recorded one); abandoned: an object
    // was there and is removed.
    const cleared =
      response.ok &&
      (grant === undefined
        ? owned(response.result.ingestId)
        : response.result.ingestId === grant.ingestId);
    return {
      ...final,
      abandoned: cleared && response.result.state === "abandoned",
      stagingCleared: cleared,
    };
  };
  // A doc registered meanwhile (the relay, another credential) is reused.
  // Bytes this item may have staged, in this run or the one resumed, are
  // never copied, so the caller's own staging key is abandoned first;
  // best effort, the staging lifecycle is the backstop.
  const reuse = async (media) => {
    if (putBegan && !aborted(signal))
      await control(
        MEDIA_INGEST_ROUTES.abandon,
        { intent },
        editorialMediaIngestAbandonResultSchema,
        2,
      );
    return registered(media, true, null);
  };
  // start first, also on resume: a doc registered meanwhile is reused without
  // a PUT or complete, and a 404 means the routes are absent.
  const first = await begin();
  if (!first.ok)
    return first.httpStatus === 404
      ? { fallback: true }
      : ingestRetryable(first)
        ? first
        : giveUp(first);
  if (first.result.state === "registered") return reuse(first.result.media);
  grant = first.result;
  for (;;) {
    if (!staged) {
      // Three refused PUTs are final; three uncertain ones may have landed,
      // so their staging key is kept for the next run.
      if (putAttempts >= 3)
        return lastPutStatus === 403
          ? giveUp(failed("MEDIA_INGEST_PUT_FORBIDDEN"))
          : failed("MEDIA_INGEST_PUT_UNCERTAIN", true);
      // A used or nearly expired URL is re-signed for the same key.
      if (grant.used || grant.expiresAt - now() < 15_000) {
        const started = await begin();
        if (!started.ok)
          return started.httpStatus === 404
            ? { fallback: true }
            : ingestRetryable(started)
              ? started
              : giveUp(started);
        if (started.result.state === "registered")
          return reuse(started.result.media);
        grant = started.result;
      }
      if (aborted(signal)) return failed("TRANSPORT_UNCERTAIN", true);
      putAttempts += 1;
      putBegan = true;
      grant.used = true;
      await notify("streaming", false);
      let response;
      let putMs = 0;
      try {
        response = await put(async () => {
          const began = now();
          try {
            return await putObject({
              url: grant.upload.url,
              headers: { ...grant.upload.headers },
              body: bytes,
              signal,
            });
          } finally {
            putMs = now() - began;
          }
        });
      } catch {
        response = { ok: false, status: 0 };
      }
      metrics.puts.push({
        ms: putMs,
        status: Number.isSafeInteger(response?.status) ? response.status : 0,
      });
      // A local refusal (target or header guard) is final and content-free.
      if (typeof response?.code === "string")
        return giveUp(
          failed(
            /^COS_[A-Z_]{2,60}$/.test(response.code)
              ? response.code
              : "MEDIA_INGEST_PUT_REJECTED",
          ),
        );
      lastPutStatus = Number.isSafeInteger(response?.status)
        ? response.status
        : 0;
      // 409: forbid-overwrite refused a second PUT, so the bytes are staged.
      if (
        (lastPutStatus >= 200 && lastPutStatus < 300) ||
        lastPutStatus === 409
      )
        await notify("staged", true);
      else if (
        [0, 403, 408, 429].includes(lastPutStatus) ||
        lastPutStatus >= 500
      )
        continue; // uncertain, expired or busy: re-sign and PUT again
      else return giveUp(failed("MEDIA_INGEST_PUT_REJECTED"));
    }
    await notify("confirming", true);
    const done = await complete(async () => {
      const began = now();
      try {
        return await control(
          MEDIA_INGEST_ROUTES.complete,
          { intent },
          editorialMediaIngestCompleteResultSchema,
          4,
        );
      } finally {
        metrics.completes.push(now() - began);
      }
    });
    if (done.ok) {
      const result = registered(
        done.result.media,
        done.result.reused,
        done.result.validatedMd5,
      );
      if (
        !result.ok ||
        (done.result.validatedMd5 !== null &&
          done.result.validatedMd5 !== md5Base64)
      )
        return failed("MEDIA_UPLOAD_READBACK_MISMATCH");
      if (result.reused || typeof privacyCheck !== "function") return result;
      let privacy;
      try {
        privacy = await privacyCheck({
          url: grant.upload.url,
          objectKey: result.result.objectKey,
        });
      } catch {
        privacy = "uncertain";
      }
      return {
        ...result,
        privacy: PRIVACY.has(privacy) ? privacy : "uncertain",
      };
    }
    if (done.httpStatus === 404) return { fallback: true };
    // The staging object is gone (expired, abandoned, or deleted after a
    // mismatch the server found): PUT again, and only once after a mismatch.
    if (done.code === "INGEST_NOT_UPLOADED") {
      staged = false;
      continue;
    }
    if (
      (done.code === "INGEST_HASH_MISMATCH" ||
        done.code === "INGEST_SIZE_MISMATCH") &&
      !rePut
    ) {
      rePut = true;
      staged = false;
      continue;
    }
    return ingestRetryable(done) ? done : giveUp(done);
  }
}

/**
 * send uses the existing bounded/sanitized native HTTP client. A missing reply
 * is reconciled against durable session state before one bounded continuation.
 *
 * uploadMode "direct-cos-v1" ingests a Catalog original of up to
 * CATALOG_ORIGINAL_MAX_BYTES through the media-ingest routes and the injected
 * putObject (see ingestDirect); while those routes are absent (404) it falls
 * back to the relay only for files within MAX_MEDIA_UPLOAD_BYTES.
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
  putObject,
  cosHostSuffix,
  put = (operation) => operation(),
  privacyCheck,
  resumeStaged = false,
  ownsStaging,
  retryDelayMs = 1_000,
  now = Date.now,
}) {
  if (aborted(signal)) return failed("TRANSPORT_UNCERTAIN", true);
  if (!["auto", "parallel-chunks-v1", "direct-cos-v1"].includes(uploadMode))
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
  if (uploadMode === "direct-cos-v1") {
    // Branches before the relay's 40 MiB start schema.
    if (
      !Number.isSafeInteger(CATALOG_ORIGINAL_MAX_BYTES) ||
      typeof editorialMediaIngestStartSchema?.safeParse !== "function" ||
      typeof editorialMediaIngestStartResultSchema?.safeParse !== "function" ||
      typeof editorialMediaIngestCompleteResultSchema?.safeParse !==
        "function" ||
      typeof editorialMediaIngestAbandonResultSchema?.safeParse !== "function"
    )
      return failed("MEDIA_UPLOAD_PROTOCOL_UNAVAILABLE");
    if (
      existingOnly ||
      typeof putObject !== "function" ||
      typeof put !== "function" ||
      (privacyCheck !== undefined && typeof privacyCheck !== "function") ||
      (ownsStaging !== undefined && typeof ownsStaging !== "function") ||
      !normalizeCosHostSuffix(cosHostSuffix) ||
      !Number.isSafeInteger(retryDelayMs) ||
      retryDelayMs < 0 ||
      typeof now !== "function"
    )
      return failed("MEDIA_UPLOAD_INPUT_INVALID");
    const intent = mediaIngestIntent({ item, bytes, transferId });
    if (!intent) return failed("MEDIA_SOURCE_CHANGED");
    const direct = await ingestDirect({
      intent,
      bytes,
      md5Base64: intent.md5Base64,
      post: (route, body) => send(route, "POST", body, signal),
      putObject,
      put,
      complete,
      privacyCheck,
      hostSuffix: cosHostSuffix,
      signal,
      onProgress,
      resumeStaged,
      ownsStaging,
      retryDelayMs,
      now,
    });
    if (!direct.fallback) return direct;
    if (bytes.length > MAX_MEDIA_UPLOAD_BYTES)
      return failed("MEDIA_INGEST_UNAVAILABLE");
    const relayed = await stageMediaUpload({
      item,
      bytes,
      transferId,
      send,
      signal,
      onProgress,
      complete,
      uploadMode: "parallel-chunks-v1",
    });
    return relayed.ok ? { ...relayed, transport: "relay" } : relayed;
  }
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

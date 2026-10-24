/**
 * Catalog original ingest client and Codex CLI (catalog-scale-v1 increment
 * 2). Original bytes go only to the configured COS host, through one signed
 * staging PUT per image; the Admin receives start, complete and abandon
 * control requests and never the bytes, and nothing is read back. Output is
 * counts and fixed codes only: never a URL, object key, host, credential or
 * response body.
 */
import { createHash, randomUUID } from "node:crypto";
import { Buffer } from "node:buffer";
import { constants } from "node:fs";
import { mkdir, open, readFile, rename, stat, unlink } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { setTimeout as sleep } from "node:timers/promises";
import { pathToFileURL, URL } from "node:url";
import {
  createNativeUploadFetch,
  NativeChunkBody,
} from "./native-stream-fetch.mjs";
import {
  MEDIA_INGEST_ROUTES,
  mediaIngestIntent,
  normalizeCosHostSuffix,
  stageMediaUpload,
  stagingUploadTarget,
} from "./resumable-upload.mjs";
import * as contracts from "../../packages/contracts/dist/internal/editorial/index.js";

const { AbortController, AbortSignal, fetch } = globalThis;
const {
  CATALOG_ORIGINAL_MAX_BYTES,
  MAX_MEDIA_UPLOAD_BYTES,
  editorialMediaIngestAbandonResultSchema,
  editorialMediaIngestStartSchema,
} = contracts;

const MiB = 1024 * 1024;
const MAX_INPUT_BYTES = 32 * MiB;
const MAX_CONFIG_BYTES = 64 * 1024;
const MAX_RESPONSE_BYTES = 256 * 1024;
const MAX_ITEMS = 10_000;
const STATE_KIND = "catalog-direct-ingest-v1";
const PRIVACY_ROW = "#privacy";
// The final key form of collection.ts and the worker's EDITORIAL_KEY.
const EDITORIAL_KEY =
  /^editorial\/[a-f0-9]{64}\/[a-f0-9]{64}-[a-f0-9]{64}\.(?:jpg|png|webp)$/;
const ITEM_FIELDS = new Set([
  "key",
  "file",
  "mimeType",
  "catalogId",
  "mediaId",
  "sha256",
  "bytes",
  "width",
  "height",
  "alt",
  "rights",
  "orderConfidence",
]);
const CONFIG_FIELDS = new Set([
  "baseURL",
  "apiKey",
  "sessionToken",
  "cosHostSuffix",
  "concurrency",
  "completeConcurrency",
  "attempts",
  "budgetMs",
]);
/** Admin error codes that may be reported; any other becomes a status class. */
const ADMIN_CODES = new Set([
  "AUTHORIZATION_REQUIRED",
  "INGEST_FORBIDDEN",
  "INGEST_INPUT_INVALID",
  "INGEST_QUOTA_EXCEEDED",
  "INGEST_BUSY",
  "INGEST_NOT_UPLOADED",
  "INGEST_SIZE_MISMATCH",
  "INGEST_CONTENT_INVALID",
  "INGEST_HASH_MISMATCH",
  "INGEST_FINAL_INVALID",
  "INGEST_STAGING_INVALID",
  // Retried by status (5xx) like any other, but named, so a canary shows a
  // setting (L1 without the tag count on HEAD), signer or storage fault.
  "INGEST_CONFIGURATION_INVALID",
  "INGEST_SIGNER_UNAVAILABLE",
  "INGEST_STORAGE_UNAVAILABLE",
  "INGEST_DEADLINE_EXCEEDED",
  "MEDIA_IDENTITY_CONFLICT",
  "MEDIA_IDENTITY_EXISTS",
  "MEDIA_IDENTITY_INVALID",
  "MEDIA_FILE_INVALID",
  "MEDIA_FORBIDDEN",
  "UPLOAD_FORBIDDEN",
  "UPLOAD_INPUT_INVALID",
  "UPLOAD_JSON_INVALID",
  "UPLOAD_CONTENT_TYPE_INVALID",
  "UPLOAD_COMPLETION_BUSY",
  "UPLOAD_QUOTA_EXCEEDED",
  "UPLOAD_EXPIRED",
  "UPLOAD_NOT_FOUND",
  "UPLOAD_CHUNK_CONFLICT",
  "UPLOAD_FILE_HASH_MISMATCH",
  "CONCURRENT_OPERATION_BUSY",
]);
// Ingest control routes and the relay's, for the 40 MiB fallback only.
const ADMIN_ROUTE =
  /^\/api\/editorial\/(?:media-ingest\/(?:start|complete|abandon)|media-upload\/(?:start|status|complete|chunk\/[a-f0-9]{64}\/(?:0|[1-9]\d{0,2})))$/;
const BUSY_RETRIED_ROUTE =
  /^\/api\/editorial\/media-ingest\/(?:complete|abandon)$/;
const PUT_HEADERS = new Set([
  "content-length",
  "content-type",
  "content-md5",
  "x-cos-forbid-overwrite",
  "x-cos-tagging",
]);

const digest = (value) => createHash("sha256").update(value).digest("hex");
const token = (value) =>
  typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value);
const plainObject = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const safeCode = (value) =>
  typeof value === "string" && /^[A-Z][A-Z0-9_]{2,63}$/.test(value)
    ? value
    : "REQUEST_FAILED";
const throwCode = (code) => {
  const error = new Error(code);
  error.code = code;
  throw error;
};
const canonical = (value) => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (plainObject(value))
    return `{${Object.keys(value)
      .filter((key) => value[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
      .join(",")}}`;
  return JSON.stringify(value);
};
const stableDigest = (value) => digest(canonical(value));
/**
 * The state's record of the staging id a PUT went (or may have gone) under:
 * a one-way digest, so a resumed run and --abandon can tell this batch's
 * actor from another (the Admin derives the id from the caller) without the
 * state holding a key. It is dropped once that key is known to be empty.
 */
const stagingDigest = (ingestId) =>
  typeof ingestId === "string" && /^[a-f0-9]{64}$/.test(ingestId)
    ? digest(`direct-ingest-staging:${ingestId}`)
    : null;
const keepStaging = (row) =>
  typeof row?.stagingDigest === "string"
    ? { stagingDigest: row.stagingDigest }
    : {};
/** The recorded actor's own grant only (any grant when none is recorded). */
const ownsRecordedStaging = (row) =>
  typeof row?.stagingDigest === "string"
    ? (ingestId) => stagingDigest(ingestId) === row.stagingDigest
    : undefined;
const bounded = (value, min, max, code) => {
  if (!Number.isSafeInteger(value) || value < min || value > max)
    throwCode(code);
  return value;
};
const withTimeout = (signal, ms) =>
  signal
    ? AbortSignal.any([signal, AbortSignal.timeout(ms)])
    : AbortSignal.timeout(ms);
/** At most limit concurrent operations; the rest wait in order. */
const slots = (limit) => {
  let active = 0;
  const waiting = [];
  return async (work) => {
    if (active < limit) active++;
    else await new Promise((resolve) => waiting.push(resolve));
    try {
      return await work();
    } finally {
      if (waiting.length) waiting.shift()();
      else active--;
    }
  };
};
/** Discards a response body without reading more than a small bound. */
async function discard(response) {
  try {
    await response.body?.cancel();
  } catch {
    /* already closed */
  }
}
async function readLimited(response, limit) {
  const reader = response.body?.getReader();
  if (!reader) return Buffer.alloc(0);
  const chunks = [];
  let total = 0;
  for (;;) {
    const next = await reader.read();
    if (next.done) break;
    total += next.value.length;
    if (total > limit) {
      await reader.cancel().catch(() => {});
      throwCode("RESPONSE_TOO_LARGE");
    }
    chunks.push(Buffer.from(next.value));
  }
  return Buffer.concat(chunks);
}

/**
 * The only path original bytes take. putObject sends one PUT straight to the
 * staging key with exactly the signed headers it was given, never an
 * Authorization, cookie or other x-cos-/x-amz- header, and refuses
 * redirects. checkPrivate sends one anonymous Range 0-0 GET for a final key
 * at the bucket origin of a staging URL: 401/403 is private, 2xx public.
 * Neither returns, stores or logs a URL, and response bodies are discarded.
 */
export function createCosClient({
  hostSuffix,
  fetchImpl = fetch,
  putTimeoutMs = 900_000,
  checkTimeoutMs = 30_000,
}) {
  const suffix = normalizeCosHostSuffix(hostSuffix);
  if (!suffix || typeof fetchImpl !== "function")
    throwCode("CONFIG_COS_INVALID");
  const putObject = async ({ url, headers, body, signal }) => {
    if (!stagingUploadTarget(url, suffix))
      return { ok: false, status: 0, code: "COS_TARGET_REFUSED" };
    if (
      !plainObject(headers) ||
      !(body instanceof Uint8Array) ||
      Object.entries(headers).some(
        ([name, value]) =>
          !PUT_HEADERS.has(name) ||
          typeof value !== "string" ||
          /[\r\n]/.test(value),
      ) ||
      headers["content-length"] !== String(body.byteLength) ||
      headers["x-cos-forbid-overwrite"] !== "true" ||
      !headers["content-type"] ||
      !headers["content-md5"]
    )
      return { ok: false, status: 0, code: "COS_HEADERS_REFUSED" };
    let response;
    try {
      response = await fetchImpl(url, {
        method: "PUT",
        headers: { ...headers },
        body,
        redirect: "error",
        credentials: "omit",
        signal: withTimeout(signal, putTimeoutMs),
      });
    } catch {
      return { ok: false, status: 0 };
    }
    await discard(response);
    return { ok: response.ok, status: response.status };
  };
  const checkPrivate = async ({ url, objectKey, signal }) => {
    const target = stagingUploadTarget(url, suffix);
    if (
      !target ||
      typeof objectKey !== "string" ||
      !EDITORIAL_KEY.test(objectKey)
    )
      return "uncertain";
    let response;
    try {
      response = await fetchImpl(`${target.origin}/${objectKey}`, {
        method: "GET",
        headers: { range: "bytes=0-0" },
        redirect: "error",
        credentials: "omit",
        signal: withTimeout(signal, checkTimeoutMs),
      });
    } catch {
      return "uncertain";
    }
    await discard(response);
    if (response.status === 401 || response.status === 403) return "private";
    if (response.status >= 200 && response.status < 300) return "public";
    // An existing private object is never 404 to an anonymous caller.
    return response.status === 404 ? "unexpected" : "uncertain";
  };
  return { putObject, checkPrivate };
}

/** The Admin origin: https, or http only on loopback; no path or credentials. */
export function adminOrigin(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throwCode("CONFIG_ENDPOINT_INVALID");
  }
  if (
    url.username ||
    url.password ||
    url.hash ||
    url.search ||
    url.pathname !== "/" ||
    (url.protocol !== "https:" &&
      !(
        url.protocol === "http:" &&
        ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
      ))
  )
    throwCode("CONFIG_ENDPOINT_INVALID");
  return url.origin;
}

const adminFailure = (status, code, retryable) => ({
  ok: false,
  httpStatus: status,
  retryable,
  code: ADMIN_CODES.has(code)
    ? code
    : status === 401
      ? "ADMIN_UNAUTHORIZED"
      : status === 403
        ? "ADMIN_FORBIDDEN"
        : status === 404
          ? "ADMIN_ROUTE_NOT_FOUND"
          : status === 409
            ? "ADMIN_CONFLICT"
            : status === 429
              ? "ADMIN_BUSY"
              : status >= 500
                ? "ADMIN_UNAVAILABLE"
                : "ADMIN_REQUEST_REJECTED",
});

/**
 * send(route, method, body, signal, headers) for stageMediaUpload: POST of
 * the ingest control routes (and the relay's, for the fallback) to the
 * configured Admin origin with the configured credential. complete waits 75
 * s, past nginx's 60 s, so a server deadline answers before the client gives
 * up. Remote error text is never kept; only allowlisted codes are.
 */
export function createAdminSend(config, { fetchImpl = fetch } = {}) {
  const origin = adminOrigin(config?.baseURL);
  const credentials = ["apiKey", "sessionToken"].filter(
    (name) => config[name] !== undefined,
  );
  const value = config[credentials[0]];
  if (
    credentials.length !== 1 ||
    typeof value !== "string" ||
    value.length < 8 ||
    value.length > 8_192 ||
    /\s/.test(value)
  )
    throwCode("CONFIG_AUTH_INVALID");
  const authorization =
    credentials[0] === "apiKey" ? `users API-Key ${value}` : `JWT ${value}`;
  const nativeFetch = createNativeUploadFetch(fetchImpl);
  const send = async (route, method, body, signal, headers = {}) => {
    const chunk = body instanceof NativeChunkBody;
    if (
      method !== "POST" ||
      typeof route !== "string" ||
      !ADMIN_ROUTE.test(route) ||
      (!chunk && !plainObject(body))
    )
      return { ok: false, retryable: false, code: "OPERATION_NOT_AUTHORIZED" };
    if (signal?.aborted)
      return { ok: false, retryable: true, code: "TRANSPORT_UNCERTAIN" };
    let response;
    try {
      response = await nativeFetch(`${origin}${route}`, {
        method: "POST",
        headers: {
          ...(chunk ? headers : {}),
          Authorization: authorization,
          "Content-Type": chunk
            ? "application/octet-stream"
            : "application/json",
        },
        body: chunk ? body : JSON.stringify(body),
        redirect: "error",
        signal: withTimeout(
          signal,
          route.endsWith("/complete") ? 75_000 : chunk ? 120_000 : 30_000,
        ),
      });
    } catch {
      return { ok: false, retryable: true, code: "TRANSPORT_UNCERTAIN" };
    }
    let json;
    try {
      json = JSON.parse(
        (await readLimited(response, MAX_RESPONSE_BYTES)).toString("utf8"),
      );
    } catch {
      // Every route here is idempotent, so a mangled success is retried.
      return {
        ...adminFailure(
          response.status,
          undefined,
          response.ok || response.status === 429 || response.status >= 500,
        ),
        ...(response.ok ? { code: "ADMIN_RESPONSE_INVALID" } : {}),
      };
    }
    if (response.ok && plainObject(json) && json.ok !== false)
      return {
        ok: true,
        httpStatus: response.status,
        result: json,
        streamUploadVersion: response.headers.get("x-editorial-upload-stream"),
      };
    const code = plainObject(json?.error) ? json.error.code : undefined;
    return adminFailure(
      response.status,
      code,
      response.status === 429 ||
        response.status >= 500 ||
        // A chunk, or an ingest complete or abandon, that waited out its 5 s
        // for the mediaId's lock (held by the relay through its own complete):
        // nothing changed, so the same request is safe to repeat.
        ((chunk || BUSY_RETRIED_ROUTE.test(route)) &&
          response.status === 409 &&
          code === "CONCURRENT_OPERATION_BUSY"),
    );
  };
  Object.defineProperty(send, "scopeFingerprint", {
    value: stableDigest({ kind: STATE_KIND, origin }),
  });
  return send;
}

/**
 * A batch manifest: {version: 1, batchId, items}. Each item names a local
 * JPEG, PNG or WebP file and its exact bytes and SHA-256, the Catalog and
 * Media identity, alt and the optional rights and orderConfidence, and the
 * required width and height of the package's full local decode, which
 * complete compares with what the Admin reads (the start schema keeps them
 * optional for other clients). No URL is accepted.
 */
export function validateIngestManifest(manifest) {
  if (
    !plainObject(manifest) ||
    Object.keys(manifest).some(
      (key) => !["version", "batchId", "items"].includes(key),
    ) ||
    manifest.version !== 1 ||
    !token(manifest.batchId) ||
    !Array.isArray(manifest.items) ||
    !manifest.items.length ||
    manifest.items.length > MAX_ITEMS
  )
    throwCode("MANIFEST_INVALID");
  const keys = new Set(),
    mediaIds = new Set();
  for (const item of manifest.items) {
    if (
      !plainObject(item) ||
      Object.keys(item).some((key) => !ITEM_FIELDS.has(key)) ||
      !token(item.key) ||
      keys.has(item.key) ||
      mediaIds.has(item.mediaId)
    )
      throwCode("ITEM_IDENTITY_INVALID");
    keys.add(item.key);
    mediaIds.add(item.mediaId);
    if (
      typeof item.file !== "string" ||
      !item.file.length ||
      /^[A-Za-z][A-Za-z0-9+.-]*:/.test(item.file) ||
      item.file.includes("\0") ||
      !Number.isSafeInteger(item.width) ||
      !Number.isSafeInteger(item.height) ||
      !editorialMediaIngestStartSchema.safeParse({
        ...intentFields(item),
        transferId: "0".repeat(64),
        md5Base64: "A".repeat(22) + "==",
      }).success
    )
      throwCode("MEDIA_INPUT_INVALID");
  }
  return manifest;
}

function intentFields(item) {
  return Object.fromEntries(
    Object.entries({
      catalogId: item.catalogId,
      mediaId: item.mediaId,
      sha256: item.sha256,
      bytes: item.bytes,
      mimeType: item.mimeType,
      width: item.width,
      height: item.height,
      alt: item.alt,
      rights: item.rights,
      orderConfidence: item.orderConfidence,
    }).filter(([, value]) => value !== undefined),
  );
}

/** The stageMediaUpload item, its request hash and a stable transferId. */
function prepare(manifest, directory) {
  return validateIngestManifest(manifest).items.map((item) => {
    const fields = intentFields(item);
    const requestHash = stableDigest(fields);
    return {
      key: item.key,
      filePath: localPath(directory, item.file),
      requestHash,
      // One staging key per item and content across runs, so a resumed run
      // completes bytes an earlier run staged.
      transferId: digest(
        `${STATE_KIND}:${manifest.batchId}:${item.key}:${requestHash}`,
      ),
      upload: {
        requestHash,
        body: {
          catalogId: item.catalogId,
          mediaId: item.mediaId,
          alt: item.alt,
          ...(item.rights === undefined ? {} : { rights: item.rights }),
          ...(item.orderConfidence === undefined
            ? {}
            : { orderConfidence: item.orderConfidence }),
        },
        file: {
          sha256: item.sha256,
          size: item.bytes,
          mimeType: item.mimeType,
          width: item.width,
          height: item.height,
        },
      },
    };
  });
}

function localPath(root, value) {
  return path.resolve(root, value);
}

const MAGIC = {
  "image/jpeg": (bytes) =>
    bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff,
  "image/png": (bytes) =>
    Buffer.from(bytes.subarray(0, 8)).equals(
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    ),
  "image/webp": (bytes) =>
    Buffer.from(bytes.subarray(0, 4)).toString("latin1") === "RIFF" &&
    Buffer.from(bytes.subarray(8, 12)).toString("latin1") === "WEBP",
};

/** The item's exact local bytes (no symlink), or MEDIA_SOURCE_CHANGED. */
async function readOriginal(prepared) {
  let handle;
  try {
    handle = await open(
      prepared.filePath,
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
  } catch {
    throwCode("MEDIA_FILE_UNREADABLE");
  }
  try {
    const info = await handle.stat();
    const { file } = prepared.upload;
    if (
      !info.isFile() ||
      info.size !== file.size ||
      info.size > CATALOG_ORIGINAL_MAX_BYTES
    )
      throwCode("MEDIA_SOURCE_CHANGED");
    const bytes = await handle.readFile();
    if (
      bytes.length !== file.size ||
      !MAGIC[file.mimeType](bytes) ||
      digest(bytes) !== file.sha256
    )
      throwCode("MEDIA_SOURCE_CHANGED");
    return bytes;
  } finally {
    await handle.close();
  }
}

async function readBounded(file, maxBytes, privateFile = false) {
  const info = await stat(file);
  if (
    !info.isFile() ||
    info.size > maxBytes ||
    (privateFile && info.mode & 0o077)
  )
    throwCode("LOCAL_FILE_INVALID");
  const bytes = await readFile(file);
  if (bytes.length > maxBytes) throwCode("LOCAL_FILE_INVALID");
  return bytes;
}
const parseJSON = (bytes) => {
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch {
    throwCode("JSON_INVALID");
  }
};

/**
 * The private state file: a header line, then one synced JSON row per change
 * (the last row of a key wins). Rows hold outcomes, counts and the
 * registered facts, never a URL, object key or credential.
 */
async function loadState(file, batchId, scopeFingerprint) {
  let bytes;
  try {
    bytes = await readBounded(file, MAX_INPUT_BYTES, true);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const state = { batchId, scopeFingerprint, rows: new Map() };
  if (!bytes) return state;
  const text = bytes.toString("utf8");
  // Only a last, unsynced append can be torn; every earlier row is complete.
  const lines = text.slice(0, text.lastIndexOf("\n") + 1).split("\n");
  const header = parseJSON(Buffer.from(lines.shift() ?? ""));
  if (
    !plainObject(header) ||
    header.version !== 1 ||
    header.kind !== STATE_KIND ||
    header.batchId !== batchId ||
    header.scopeFingerprint !== scopeFingerprint
  )
    throwCode("STATE_SCOPE_MISMATCH");
  for (const line of lines) {
    if (!line) continue;
    const row = parseJSON(Buffer.from(line));
    if (
      !plainObject(row) ||
      !(token(row.key) || row.key === PRIVACY_ROW) ||
      !plainObject(row.value)
    )
      throwCode("STATE_INVALID");
    state.rows.set(row.key, row.value);
  }
  return state;
}
async function writeState(file, state) {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${randomUUID()}.tmp`;
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(
      [
        JSON.stringify({
          version: 1,
          kind: STATE_KIND,
          batchId: state.batchId,
          scopeFingerprint: state.scopeFingerprint,
        }),
        ...[...state.rows].map(([key, value]) =>
          JSON.stringify({ key, value }),
        ),
      ].join("\n") + "\n",
      "utf8",
    );
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary, file);
  const directory = await open(path.dirname(file), "r");
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}
async function appendState(file, key, value) {
  const handle = await open(file, "a", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify({ key, value })}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/** Registered facts kept in state: no object key, filename or URL. */
const registeredFacts = (media) => ({
  id: media.id,
  mediaId: media.mediaId,
  catalogId: media.catalogId,
  sha256: media.sha256,
  filesize: media.filesize,
  mimeType: media.mimeType,
  width: media.width,
  height: media.height,
});

async function withStateLock(stateFile, work) {
  await mkdir(path.dirname(stateFile), { recursive: true, mode: 0o700 });
  let lock;
  try {
    lock = await open(`${stateFile}.lock`, "wx", 0o600);
  } catch {
    throwCode("STATE_LOCKED");
  }
  try {
    await lock.writeFile(
      `${JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() })}\n`,
    );
    await lock.sync();
    return await work();
  } finally {
    await lock.close();
    await unlink(`${stateFile}.lock`);
  }
}

/**
 * Ingests a batch. Up to 4 items stage at once (about 4 × 128 MiB in memory)
 * and at most 2 completes run; registered items are skipped on resume, and an
 * item whose bytes an earlier run staged goes from start straight to
 * complete. While the ingest routes are absent, items within 40 MiB use the
 * relay and larger ones stop with MEDIA_INGEST_UNAVAILABLE. After the first
 * new registration of a run, one anonymous Range 0-0 GET checks that the
 * final original is private; a public answer stops the run, and
 * INGEST_QUOTA_EXCEEDED admits no further item. dryRun (the default) only
 * verifies the local files and makes no request.
 */
export async function runDirectIngest({
  manifest,
  directory,
  stateFile,
  send,
  cos,
  cosHostSuffix,
  dryRun = true,
  concurrency = 4,
  completeConcurrency = 2,
  attempts = 2,
  budgetMs = 3_600_000,
  retryDelayMs = 1_000,
  now = Date.now,
  signal,
}) {
  bounded(concurrency, 1, 4, "CONCURRENCY_INVALID");
  bounded(completeConcurrency, 1, 2, "CONCURRENCY_INVALID");
  bounded(attempts, 1, 3, "ATTEMPTS_INVALID");
  bounded(budgetMs, 1_000, 86_400_000, "BUDGET_INVALID");
  bounded(retryDelayMs, 0, 60_000, "RETRY_DELAY_INVALID");
  const prepared = prepare(manifest, directory);
  if (dryRun) {
    let bytes = 0,
      overRelayLimit = 0;
    for (const item of prepared) {
      if (signal?.aborted) throwCode("INTERRUPTED");
      bytes += (await readOriginal(item)).length;
      if (item.upload.file.size > MAX_MEDIA_UPLOAD_BYTES) overRelayLimit++;
    }
    return { dryRun: true, total: prepared.length, bytes, overRelayLimit };
  }
  if (
    typeof send !== "function" ||
    typeof cos?.putObject !== "function" ||
    typeof cos?.checkPrivate !== "function" ||
    !normalizeCosHostSuffix(cosHostSuffix) ||
    typeof stateFile !== "string"
  )
    throwCode("TRANSPORT_REQUIRED");
  return withStateLock(stateFile, async () => {
    const state = await loadState(
      stateFile,
      manifest.batchId,
      send.scopeFingerprint ?? "isolated-injected-transport",
    );
    for (const item of prepared)
      if (
        state.rows.has(item.key) &&
        state.rows.get(item.key).requestHash !== item.requestHash
      )
        throwCode("STATE_INPUT_CHANGED");
    let writes = writeState(stateFile, state);
    const record = (key, value) => {
      state.rows.set(key, value);
      writes = writes.then(() => appendState(stateFile, key, value));
      return writes;
    };
    await writes;
    const stop = new AbortController();
    const deadline = now() + budgetMs;
    const operationSignal = AbortSignal.any(
      [signal, AbortSignal.timeout(budgetMs), stop.signal].filter(Boolean),
    );
    const stopped = () => operationSignal.aborted || now() >= deadline;
    const put = slots(concurrency),
      complete = slots(completeConcurrency);
    const run = {
      newlyRegistered: 0,
      reused: 0,
      relayFallbacks: 0,
      abandoned: 0,
      privacy: "not-needed",
      privacyChecks: 0,
    };
    // One check per run; an uncertain answer lets a later registration retry
    // (three tries in all). Only the status is kept.
    const privacyCheck = async ({ url, objectKey }) => {
      if (
        ["private", "public", "checking"].includes(run.privacy) ||
        run.privacyChecks >= 3
      )
        return "skipped";
      run.privacy = "checking";
      run.privacyChecks++;
      const status = await cos.checkPrivate({ url, objectKey, signal });
      run.privacy = status;
      await record(PRIVACY_ROW, {
        status,
        checkedAt: new Date(now()).toISOString(),
      });
      if (status === "public") stop.abort();
      return status;
    };
    // The Admin's ingest quota (per actor or global, per rolling hour) closes
    // admission: items in flight finish, no new item or attempt starts, and
    // the rest stay pending for a later run.
    let quotaReached = false;
    const admitting = () => !stopped() && !quotaReached;
    // One attempt. The original's bytes live only inside it, so no buffer of
    // up to 128 MiB is held through a retry's backoff.
    const attemptItem = async (item) => {
      const previous = state.rows.get(item.key);
      let bytes;
      try {
        bytes = await readOriginal(item);
      } catch (error) {
        return { ok: false, retryable: false, code: safeCode(error?.code) };
      }
      await record(item.key, {
        requestHash: item.requestHash,
        status: "pending",
        attempts: (previous?.attempts ?? 0) + 1,
        staged: previous?.staged === true,
        ...keepStaging(previous),
        ...(previous?.metrics ? { metrics: previous.metrics } : {}),
      });
      try {
        return await stageMediaUpload({
          item: item.upload,
          bytes,
          transferId: item.transferId,
          send,
          signal: operationSignal,
          uploadMode: "direct-cos-v1",
          putObject: cos.putObject,
          cosHostSuffix,
          put,
          complete,
          privacyCheck,
          resumeStaged: previous?.staged === true,
          // A key an earlier run may have written stays this row's: a grant
          // for another credential's actor stops the item
          // (INGEST_ACTOR_MISMATCH) before it PUTs, completes or abandons.
          ownsStaging: ownsRecordedStaging(previous),
          retryDelayMs,
          now,
          onProgress: async ({ phase, ingestId }) => {
            // Recorded before any PUT of the grant, so a run interrupted
            // mid-PUT still knows which actor's key it may have written (a
            // grant for another id never gets here: ownsStaging).
            const row = state.rows.get(item.key);
            const granted = stagingDigest(ingestId);
            const change = {
              ...(granted && row?.stagingDigest !== granted
                ? { stagingDigest: granted }
                : {}),
              ...(phase === "staged" && row?.staged !== true
                ? { staged: true }
                : {}),
            };
            if (Object.keys(change).length)
              await record(item.key, { ...row, ...change });
          },
        });
      } catch {
        return { ok: false, retryable: false, code: "CLIENT_FAILURE" };
      }
    };
    let cursor = 0;
    const worker = async () => {
      while (cursor < prepared.length) {
        const item = prepared[cursor++];
        if (state.rows.get(item.key)?.status === "registered") continue;
        if (!admitting()) break;
        let outcome;
        for (let attempt = 1; attempt <= attempts; attempt += 1) {
          if (!admitting()) break;
          outcome = await attemptItem(item);
          if (outcome.metrics)
            await record(item.key, {
              ...state.rows.get(item.key),
              metrics: mergeMetrics(
                state.rows.get(item.key)?.metrics,
                outcome.metrics,
              ),
            });
          if (outcome.code === "INGEST_QUOTA_EXCEEDED") quotaReached = true;
          if (
            outcome.ok ||
            !outcome.retryable ||
            attempt === attempts ||
            !admitting()
          )
            break;
          await sleep(retryDelayMs * 2 ** (attempt - 1), undefined, {
            signal: operationSignal,
          }).catch(() => {});
        }
        if (!outcome) break;
        const current = state.rows.get(item.key);
        if (outcome.ok) {
          if (outcome.transport === "relay") run.relayFallbacks++;
          if (outcome.reused) run.reused++;
          else run.newlyRegistered++;
          await record(item.key, {
            requestHash: item.requestHash,
            status: "registered",
            attempts: current?.attempts ?? 1,
            transport: outcome.transport,
            reused: outcome.reused === true,
            media: registeredFacts(outcome.result),
            ...(current?.metrics ? { metrics: current.metrics } : {}),
          });
        } else {
          if (outcome.abandoned) run.abandoned++;
          await record(item.key, {
            requestHash: item.requestHash,
            status: outcome.retryable ? "pending" : "failed",
            attempts: current?.attempts ?? 0,
            // Cleared: the recorded key is empty, so no actor binds the row.
            staged: outcome.stagingCleared ? false : current?.staged === true,
            ...(outcome.stagingCleared ? {} : keepStaging(current)),
            code: safeCode(outcome.code),
            retryable: outcome.retryable === true,
            ...(current?.metrics ? { metrics: current.metrics } : {}),
          });
        }
      }
    };
    const workers = await Promise.allSettled(
      Array.from({ length: concurrency }, worker),
    );
    await writes;
    const rejected = workers.find((result) => result.status === "rejected");
    if (rejected) throw rejected.reason;
    return summarize(prepared, state, run);
  });
}

/** Timing rows kept per item: the latest 24 PUTs and complete phases. */
function mergeMetrics(previous, next) {
  const list = (value) => (Array.isArray(value) ? value : []);
  return {
    bytes: next?.bytes ?? previous?.bytes ?? 0,
    puts: [...list(previous?.puts), ...list(next?.puts)].slice(-24),
    completes: [...list(previous?.completes), ...list(next?.completes)].slice(
      -24,
    ),
  };
}

const spread = (values, digits = 0) => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const round = (value) => Number(value.toFixed(digits));
  return {
    p50: round(sorted[Math.floor((sorted.length - 1) / 2)]),
    min: round(sorted[0]),
    max: round(sorted.at(-1)),
  };
};

/**
 * The canary's record (decision D13), numbers only: every PUT attempt and
 * its outcome, how many originals over 40 MiB were PUT and how many of those
 * needed more than one PUT, the throughput of the PUTs that stored the
 * bytes, and the duration of each complete phase (retries included).
 */
function metricsSummary(rows) {
  const stored = (status) => status >= 200 && status < 300;
  const landed = (status) => stored(status) || status === 409;
  const rates = [],
    putMs = [],
    completeMs = [];
  let putAttempts = 0,
    failedPuts = 0,
    largePuts = 0,
    largePutsFailedOnce = 0;
  for (const row of rows) {
    const metrics = row?.metrics;
    if (!plainObject(metrics) || !Array.isArray(metrics.puts)) continue;
    const puts = metrics.puts.filter(
      (put) =>
        plainObject(put) &&
        Number.isSafeInteger(put.status) &&
        Number.isFinite(put.ms),
    );
    putAttempts += puts.length;
    for (const put of puts) {
      if (!landed(put.status)) failedPuts++;
      else if (stored(put.status)) {
        putMs.push(put.ms);
        if (put.ms > 0) rates.push(metrics.bytes / MiB / (put.ms / 1000));
      }
    }
    if (metrics.bytes > MAX_MEDIA_UPLOAD_BYTES && puts.length) {
      largePuts++;
      if (puts.some((put) => !landed(put.status))) largePutsFailedOnce++;
    }
    if (Array.isArray(metrics.completes))
      completeMs.push(...metrics.completes.filter(Number.isFinite));
  }
  return {
    putAttempts,
    failedPuts,
    largePuts,
    largePutsFailedOnce,
    putMiBps: spread(rates, 2),
    putMs: spread(putMs),
    completeMs: spread(completeMs),
  };
}

function summarize(prepared, state, run) {
  const rows = prepared.map(({ key }) => state.rows.get(key));
  const codes = {};
  for (const row of rows)
    if (row && row.status !== "registered" && row.code)
      codes[row.code] = (codes[row.code] ?? 0) + 1;
  return {
    dryRun: false,
    total: prepared.length,
    registered: rows.filter((row) => row?.status === "registered").length,
    failed: rows.filter((row) => row?.status === "failed").length,
    pending: rows.filter((row) => !row || row.status === "pending").length,
    newlyRegistered: run.newlyRegistered,
    reused: run.reused,
    relayFallbacks: run.relayFallbacks,
    abandoned: run.abandoned,
    // New originals through the relay only are checked by the Admin's path.
    privacy:
      run.privacy === "not-needed" &&
      run.newlyRegistered > 0 &&
      run.newlyRegistered === run.relayFallbacks
        ? "relay-only"
        : run.privacy === "checking"
          ? "uncertain"
          : run.privacy,
    codes,
    metrics: metricsSummary(rows),
  };
}

/**
 * Abandons the staging key of every started item the state file does not
 * show registered (lifecycle L2 cleanup, or a batch given up). Idempotent;
 * reads each local file once to rebuild the exact intent. Counts only:
 * abandoned (an object was removed), absent (nothing was staged under this
 * actor's key), notStarted (no row: this state never started the item, so
 * no request is sent). The Admin derives the staging key from the caller, so
 * only the credential that ran the batch reaches its objects: an item whose
 * recorded staging id differs from the caller's is counted under
 * INGEST_ACTOR_MISMATCH and keeps its state; a cleared item's record is
 * dropped, its key being empty. Without the batch's state file
 * it refuses (STATE_NOT_FOUND): it cannot know what was staged.
 */
export async function abandonIngest({
  manifest,
  directory,
  stateFile,
  send,
  signal,
}) {
  const prepared = prepare(manifest, directory);
  if (typeof send !== "function" || typeof stateFile !== "string")
    throwCode("TRANSPORT_REQUIRED");
  return withStateLock(stateFile, async () => {
    try {
      await stat(stateFile);
    } catch (error) {
      if (error?.code === "ENOENT") throwCode("STATE_NOT_FOUND");
      throw error;
    }
    const state = await loadState(
      stateFile,
      manifest.batchId,
      send.scopeFingerprint ?? "isolated-injected-transport",
    );
    let writes = writeState(stateFile, state);
    await writes;
    const result = {
      abandon: true,
      total: prepared.length,
      abandoned: 0,
      absent: 0,
      notStarted: 0,
    };
    const codes = {};
    for (const item of prepared) {
      const row = state.rows.get(item.key);
      // An item with no row never started here, so this state staged nothing.
      if (!row) {
        result.notStarted++;
        continue;
      }
      if (row.status === "registered") continue;
      if (row && row.requestHash !== item.requestHash)
        throwCode("STATE_INPUT_CHANGED");
      if (signal?.aborted) break;
      let code;
      let answer;
      try {
        const intent = mediaIngestIntent({
          item: item.upload,
          bytes: await readOriginal(item),
          transferId: item.transferId,
        });
        if (!intent) throwCode("MEDIA_SOURCE_CHANGED");
        const response = await send(
          MEDIA_INGEST_ROUTES.abandon,
          "POST",
          { intent },
          signal,
        );
        const parsed = response.ok
          ? editorialMediaIngestAbandonResultSchema.safeParse(
              response.result?.result,
            )
          : null;
        code = !response.ok
          ? safeCode(response.code)
          : parsed.success && response.result?.ok === true
            ? null
            : "RESPONSE_INVALID";
        answer = code ? undefined : parsed.data;
        // Another credential's actor: its own key, not this batch's, was
        // looked at, so nothing is known of this batch's object.
        if (
          answer &&
          typeof row.stagingDigest === "string" &&
          stagingDigest(answer.ingestId) !== row.stagingDigest
        )
          code = "INGEST_ACTOR_MISMATCH";
      } catch (error) {
        code = safeCode(error?.code);
      }
      if (code) codes[code] = (codes[code] ?? 0) + 1;
      else {
        if (answer.state === "abandoned") result.abandoned++;
        else result.absent++;
        // The recorded key is empty now, so no actor binds the row.
        const value = { ...row, staged: false };
        delete value.stagingDigest;
        state.rows.set(item.key, value);
        writes = writes.then(() => appendState(stateFile, item.key, value));
        await writes;
      }
    }
    return { ...result, codes };
  });
}

function parseConfig(config) {
  if (
    !plainObject(config) ||
    Object.keys(config).some((key) => !CONFIG_FIELDS.has(key))
  )
    throwCode("CONFIG_INVALID");
  return config;
}

async function main() {
  const controller = new AbortController();
  const interrupt = () => {
    process.exitCode = 130;
    controller.abort();
  };
  const terminate = () => {
    process.exitCode = 143;
    controller.abort();
  };
  process.on("SIGINT", interrupt);
  process.on("SIGTERM", terminate);
  try {
    const flags = {};
    for (let index = 2; index < process.argv.length; index += 1) {
      const arg = process.argv[index];
      if (arg === "--execute" || arg === "--abandon")
        flags[arg.slice(2)] = true;
      else if (
        ["--manifest", "--config", "--state"].includes(arg) &&
        process.argv[index + 1]
      )
        flags[arg.slice(2)] = process.argv[++index];
      else throwCode("ARGUMENTS_INVALID");
    }
    if (!flags.manifest) throwCode("MANIFEST_REQUIRED");
    if (flags.execute && flags.abandon) throwCode("ARGUMENTS_INVALID");
    const live = flags.execute || flags.abandon;
    if (live && (!flags.config || !flags.state)) throwCode("CONFIG_REQUIRED");
    const manifest = parseJSON(
      await readBounded(flags.manifest, MAX_INPUT_BYTES),
    );
    const directory = path.dirname(path.resolve(flags.manifest));
    const config = live
      ? parseConfig(
          parseJSON(await readBounded(flags.config, MAX_CONFIG_BYTES, true)),
        )
      : {};
    const send = live ? createAdminSend(config) : undefined;
    const result = flags.abandon
      ? await abandonIngest({
          manifest,
          directory,
          stateFile: path.resolve(flags.state),
          send,
          signal: controller.signal,
        })
      : await runDirectIngest({
          manifest,
          directory,
          stateFile: flags.execute ? path.resolve(flags.state) : undefined,
          send,
          cos: flags.execute
            ? createCosClient({ hostSuffix: config.cosHostSuffix })
            : undefined,
          cosHostSuffix: config.cosHostSuffix,
          dryRun: !flags.execute,
          concurrency: config.concurrency,
          completeConcurrency: config.completeConcurrency,
          attempts: config.attempts,
          budgetMs: config.budgetMs,
          signal: controller.signal,
        });
    process.stdout.write(`${JSON.stringify(result)}\n`);
    if (
      !process.exitCode &&
      (result.failed ||
        result.pending ||
        Object.keys(result.codes ?? {}).length ||
        ["public", "unexpected", "uncertain"].includes(result.privacy))
    )
      process.exitCode = 1;
  } finally {
    process.off("SIGINT", interrupt);
    process.off("SIGTERM", terminate);
  }
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
)
  main().catch((error) => {
    process.stderr.write(
      `EDITORIAL_DIRECT_INGEST_FAILED ${safeCode(error?.code)}: inspect protected input and state locally; no private values were logged.\n`,
    );
    process.exitCode = 1;
  });

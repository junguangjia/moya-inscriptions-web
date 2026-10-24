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
import {
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  rename,
  stat,
  unlink,
} from "node:fs/promises";
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
  recordedIngestIntent,
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
/**
 * The state file a run reads, and the rows appended before it is written
 * whole again (stateWriter). A row is under 3 KiB: a 128-character key,
 * mediaId and catalogId (each character JSON-escaped to at most 6 bytes) and
 * the 24 latest PUT and complete timings. So the rows of MAX_ITEMS items and
 * the privacy row are under 30 MiB written whole, and with the rows appended
 * since, the file stays under 38 MiB, within what the next run reads (the
 * unit test measures the largest row a run writes against these bounds).
 */
const MAX_STATE_BYTES = 64 * MiB;
const STATE_COMPACT_BYTES = 8 * MiB;
export const STATE_LIMITS = Object.freeze({
  maxItems: MAX_ITEMS,
  maxStateBytes: MAX_STATE_BYTES,
  compactAfterBytes: STATE_COMPACT_BYTES,
});
const STATE_KIND = "catalog-direct-ingest-v1";
const PRIVACY_ROW = "#privacy";
/** Recorded privacy answers that refuse --execute until the Owner acts. */
const PRIVACY_STOPS = new Set(["public", "unexpected"]);
const PRIVACY_ANSWERS = new Set([
  "private",
  "public",
  "unexpected",
  "uncertain",
]);
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
 * A path that stays inside the directory it is relative to: not absolute,
 * and no ".." step that leaves it, nested ones included (normalize folds
 * "a/../../b" to "../b").
 */
const insideDirectory = (file) => {
  const normal = path.normalize(file);
  return (
    !path.isAbsolute(normal) &&
    normal !== ".." &&
    !normal.startsWith(`..${path.sep}`)
  );
};

/**
 * A batch manifest: {version: 1, batchId, items}. Each item names a local
 * JPEG, PNG or WebP file and its exact bytes and SHA-256, the Catalog and
 * Media identity, alt and the optional rights and orderConfidence, and the
 * required width and height of the package's full local decode, which
 * complete compares with what the Admin reads (the start schema keeps them
 * optional for other clients). No URL is accepted, and a file path outside
 * the manifest's directory is refused (MEDIA_PATH_INVALID).
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
    if (!insideDirectory(item.file)) throwCode("MEDIA_PATH_INVALID");
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

/**
 * prepare, with each item's directory confined to the batch directory: the
 * real path (no symlink) of every item's directory must be the batch
 * directory's own real path joined with the item's relative directory. A
 * symlinked directory on the way refuses the whole batch
 * (MEDIA_PATH_INVALID) before any file is read or request sent; a directory
 * that does not exist is left to the item's read (MEDIA_FILE_UNREADABLE).
 * readOriginal opens each file in that real directory (openOriginal), never
 * through the batch directory's name again.
 */
async function prepareConfined(manifest, directory) {
  const items = prepare(manifest, directory);
  const root = await realpath(directory).catch(() =>
    throwCode("MEDIA_FILE_UNREADABLE"),
  );
  const parents = new Map();
  for (const item of items) {
    const parent = path.dirname(item.filePath);
    item.realParent = path.join(
      root,
      path.relative(path.resolve(directory), parent),
    );
    parents.set(parent, item.realParent);
  }
  for (const [parent, expected] of parents) {
    const real = await realpath(parent).catch(() => null);
    if (real !== null && real !== expected) throwCode("MEDIA_PATH_INVALID");
  }
  return items;
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

/**
 * Flags that open an original without following a symlink. On macOS,
 * O_NOFOLLOW_ANY (0x20000000 in <sys/fcntl.h>; Node's fs.constants lacks it,
 * and open fails with EINVAL if O_NOFOLLOW is added) refuses a symlink in
 * any component, so a directory swapped for a link while the file is opened
 * cannot redirect the open. Elsewhere only the final component is
 * O_NOFOLLOW, and openOriginal's checks after the open stand in.
 */
const ORIGINAL_OPEN_FLAGS =
  process.platform === "darwin"
    ? constants.O_RDONLY | 0x20000000
    : constants.O_RDONLY | constants.O_NOFOLLOW;

/**
 * The original `name` opened in its confined directory `realParent` (the
 * real path prepareConfined fixed), as {handle, info}, before any byte is
 * read. After the open the directory must still be its own real path, and
 * the path must still name the opened file (same device and inode), or
 * MEDIA_PATH_INVALID: a directory left as a link is caught, and one swapped
 * for a link only while the file was opened is caught unless it is swapped
 * back and forth again before the second check (on macOS the open itself
 * refuses it). A failed open is MEDIA_PATH_INVALID for a link met on the
 * way (ELOOP while the file itself is no link) and MEDIA_FILE_UNREADABLE
 * otherwise. `openFile` and `flags` are for tests.
 */
export async function openOriginal(
  realParent,
  name,
  { openFile = open, flags = ORIGINAL_OPEN_FLAGS } = {},
) {
  const file = path.join(realParent, name);
  let handle;
  try {
    handle = await openFile(file, flags);
  } catch (error) {
    const link = await lstat(file).then(
      (info) => info.isSymbolicLink(),
      () => false,
    );
    throwCode(
      error?.code === "ELOOP" && !link
        ? "MEDIA_PATH_INVALID"
        : "MEDIA_FILE_UNREADABLE",
    );
  }
  try {
    if ((await realpath(realParent).catch(() => null)) !== realParent)
      throwCode("MEDIA_PATH_INVALID");
    const named = await lstat(file).catch(() => null);
    const info = await handle.stat();
    if (named === null || named.dev !== info.dev || named.ino !== info.ino)
      throwCode("MEDIA_PATH_INVALID");
    return { handle, info };
  } catch (error) {
    await handle.close();
    throw error;
  }
}

/** The item's exact local bytes (openOriginal), or MEDIA_SOURCE_CHANGED. */
async function readOriginal(prepared) {
  const { handle, info } = await openOriginal(
    prepared.realParent,
    path.basename(prepared.filePath),
  );
  try {
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
 * (the last row of a key wins). Rows hold outcomes, counts, the registered
 * facts and the MD5 of the item's bytes (not secret: the staging PUT sends
 * it), never a URL, object key or credential.
 */
async function loadState(file, batchId, scopeFingerprint) {
  let bytes;
  try {
    bytes = await readBounded(file, MAX_STATE_BYTES, true);
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
async function appendState(file, line) {
  const handle = await open(file, "a", 0o600);
  try {
    await handle.writeFile(line, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/**
 * Writes the state whole, then appends each recorded row, synced and in
 * order. Once the rows appended since the last whole write pass compactBytes,
 * the next row is written by writing the state whole again (its header and
 * the last row of each key) instead, so the file never holds more than one
 * whole state and compactBytes of rows (MAX_STATE_BYTES). record returns the
 * write chain, settled once that row is on disk; settled() is the chain.
 */
function stateWriter(file, state, compactBytes) {
  let appended = 0;
  let writes = writeState(file, state);
  const record = (key, value) => {
    state.rows.set(key, value);
    const line = `${JSON.stringify({ key, value })}\n`;
    appended += Buffer.byteLength(line);
    if (appended > compactBytes) {
      appended = 0;
      writes = writes.then(() => writeState(file, state));
    } else writes = writes.then(() => appendState(file, line));
    return writes;
  };
  return { record, settled: () => writes };
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
 * relay unless a staging PUT of theirs began (recorded in the state), and
 * the others stop with MEDIA_INGEST_UNAVAILABLE, keeping their record. After
 * the first new direct registration of a run, one anonymous Range 0-0 GET
 * (up to three tries while uncertain) checks that the final original is
 * private. Fail closed: no item or attempt starts while it runs, and any
 * answer but private stops the run before it is recorded; a state whose
 * recorded answer is public or unexpected refuses to start (PRIVACY_STOPPED,
 * before any request) until the Owner has made the bucket private and the
 * batch continues with a new state file, and a recorded uncertain answer is
 * reported again by every run that makes no check, until one answers
 * private. INGEST_QUOTA_EXCEEDED admits no further item. dryRun (the default)
 * only verifies the local files and makes no request. stateCompactBytes is
 * for tests (stateWriter).
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
  stateCompactBytes = STATE_COMPACT_BYTES,
}) {
  bounded(concurrency, 1, 4, "CONCURRENCY_INVALID");
  bounded(completeConcurrency, 1, 2, "CONCURRENCY_INVALID");
  bounded(attempts, 1, 3, "ATTEMPTS_INVALID");
  bounded(budgetMs, 1_000, 86_400_000, "BUDGET_INVALID");
  bounded(retryDelayMs, 0, 60_000, "RETRY_DELAY_INVALID");
  bounded(stateCompactBytes, 1, STATE_COMPACT_BYTES, "STATE_COMPACT_INVALID");
  const prepared = await prepareConfined(manifest, directory);
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
    // An earlier run of this state saw a final original answer anonymously:
    // a run would register another before its own check could stop it.
    const recordedPrivacy = state.rows.get(PRIVACY_ROW)?.status;
    if (PRIVACY_STOPS.has(recordedPrivacy)) throwCode("PRIVACY_STOPPED");
    const { record, settled } = stateWriter(
      stateFile,
      state,
      stateCompactBytes,
    );
    await settled();
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
    // One check per run, of its first new direct registration, with up to
    // three tries while the answer is uncertain. Anything but private stops
    // the run (no new item or attempt; transfers in flight are aborted)
    // before the answer is recorded, so a failed write cannot skip the stop.
    // Only the status is kept.
    let privacyPending = null;
    const privacyCheck = ({ url, objectKey }) => {
      if (run.privacy !== "not-needed") return "skipped";
      run.privacy = "checking";
      privacyPending = (async () => {
        let status = "uncertain";
        for (let attempt = 0; attempt < 3; attempt += 1) {
          if (attempt)
            await sleep(retryDelayMs * 2 ** (attempt - 1), undefined, {
              signal,
            }).catch(() => {});
          if (signal?.aborted) break;
          run.privacyChecks++;
          let answer;
          try {
            answer = await cos.checkPrivate({ url, objectKey, signal });
          } catch {
            answer = "uncertain";
          }
          status = PRIVACY_ANSWERS.has(answer) ? answer : "uncertain";
          if (status !== "uncertain") break;
        }
        run.privacy = status;
        if (status !== "private") stop.abort();
        await record(PRIVACY_ROW, {
          status,
          checkedAt: new Date(now()).toISOString(),
        });
        return status;
      })();
      return privacyPending;
    };
    // The Admin's ingest quota (per actor or global, per rolling hour) closes
    // admission: items in flight finish, no new item or attempt starts, and
    // the rest stay pending for a later run. A privacy check in flight holds
    // admission until it answers.
    let quotaReached = false;
    const admitting = async () => {
      await privacyPending?.catch(() => {});
      return !stopped() && !quotaReached;
    };
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
      // Recorded before start: --abandon rebuilds the intent (and so the
      // staging id the Admin derives from it) from the manifest and this,
      // even after the local file changed or was removed. Only bytes that are
      // the manifest's (its size and SHA-256, as start's intent checks them)
      // give the row its MD5: other bytes fail the item and keep the MD5 and
      // staging record an earlier run left for --abandon.
      const intent = mediaIngestIntent({
        item: item.upload,
        bytes,
        transferId: item.transferId,
      });
      if (!intent)
        return { ok: false, retryable: false, code: "MEDIA_SOURCE_CHANGED" };
      await record(item.key, {
        requestHash: item.requestHash,
        status: "pending",
        attempts: (previous?.attempts ?? 0) + 1,
        staged: previous?.staged === true,
        md5Base64: intent.md5Base64,
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
          // A PUT an earlier run began (its grant was recorded first) may
          // have landed: never the relay for this item while it is recorded.
          stagingRecorded: typeof previous?.stagingDigest === "string",
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
        if (!(await admitting())) break;
        let outcome;
        for (let attempt = 1; attempt <= attempts; attempt += 1) {
          if (!(await admitting())) break;
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
            !(await admitting())
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
            ...(typeof current?.md5Base64 === "string"
              ? { md5Base64: current.md5Base64 }
              : {}),
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
    await settled();
    const rejected = workers.find((result) => result.status === "rejected");
    if (rejected) throw rejected.reason;
    return summarize(prepared, state, run, recordedPrivacy);
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

/**
 * The run's privacy answer. A run that made no check carries forward an
 * uncertain answer its state recorded: no check of this batch has answered
 * private since, so it stays unsettled (exit 1) until one does. New
 * originals through the relay only are checked by the Admin's path.
 */
function privacyOf(run, recordedPrivacy) {
  if (run.privacy === "checking") return "uncertain";
  if (run.privacy !== "not-needed") return run.privacy;
  if (recordedPrivacy === "uncertain") return "uncertain";
  return run.newlyRegistered > 0 && run.newlyRegistered === run.relayFallbacks
    ? "relay-only"
    : "not-needed";
}

function summarize(prepared, state, run, recordedPrivacy) {
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
    privacy: privacyOf(run, recordedPrivacy),
    codes,
    metrics: metricsSummary(rows),
  };
}

/**
 * Abandons the staging key of every started item the state file does not
 * show registered (lifecycle L2 cleanup, or a batch given up). Idempotent;
 * rebuilds each exact intent from the manifest and the MD5 its row recorded,
 * so a local file changed or removed since is never read (a row recorded
 * without one, by an earlier version, reads the file once). Counts only:
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
  const prepared = await prepareConfined(manifest, directory);
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
    const { record, settled } = stateWriter(
      stateFile,
      state,
      STATE_COMPACT_BYTES,
    );
    await settled();
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
        const intent =
          row.md5Base64 === undefined
            ? mediaIngestIntent({
                item: item.upload,
                bytes: await readOriginal(item),
                transferId: item.transferId,
              })
            : recordedIngestIntent({
                item: item.upload,
                transferId: item.transferId,
                md5Base64: row.md5Base64,
              });
        if (!intent)
          throwCode(
            row.md5Base64 === undefined
              ? "MEDIA_SOURCE_CHANGED"
              : "STATE_INVALID",
          );
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
        await record(item.key, value);
      }
    }
    return { ...result, codes };
  });
}

const ORPHAN_RUNBOOK =
  "the mediaId is registered with other facts, or by a record outside this credential's scope. When complete answered this after its copy, the verified original has no record (Admin log EDITORIAL_MEDIA_INGEST_ORPHAN): the Owner deletes that object once no media doc names its key.";
const PRIVACY_CONTINUE =
  "the batch then continues with a new state file (registered items are reused, staged bytes completed), and --abandon still runs with this one.";
/**
 * Fixed operator guidance for outcomes a plain re-run does not settle, by the
 * code the summary (or the error) shows. Never a value of the run.
 */
const RUNBOOK = Object.freeze({
  INGEST_FINAL_INVALID:
    "a final original already at the item's content-addressed key failed the Admin's re-verification (Admin log EDITORIAL_MEDIA_INGEST_FINAL_INVALID). Every run fails the same way: the mediaId stays blocked until the Owner inspects that object and deletes it, which the Admin cannot.",
  MEDIA_IDENTITY_CONFLICT: ORPHAN_RUNBOOK,
  MEDIA_IDENTITY_EXISTS: ORPHAN_RUNBOOK,
  MEDIA_INGEST_UNAVAILABLE:
    "the ingest routes answered 404 (the switch is off, or an older Admin runs). Items over 40 MiB, and items whose staging PUT began, keep their record: run the batch again with the same state file once the switch is on, or --abandon then for a batch given up (under L2 nothing else removes a staging object).",
  PRIVACY_PUBLIC: `a new final original answered an anonymous read, so the run stopped and this state now refuses --execute (PRIVACY_STOPPED). The Owner makes the bucket private and confirms it; ${PRIVACY_CONTINUE}`,
  PRIVACY_UNEXPECTED: `an anonymous read of a new final original answered 404, which a private object never does, so the run stopped and this state now refuses --execute (PRIVACY_STOPPED). The Owner checks the bucket's access and the COS host; ${PRIVACY_CONTINUE}`,
  PRIVACY_UNCERTAIN:
    "the anonymous read of a new final original had no clear answer in three tries, so that run stopped, and every run of this state that checks nothing reports uncertain again until a check answers private. Check the network path to the bucket, then run again with the same state file: its first new original is checked again. When no unregistered item remains there is nothing new to check: the Owner reads one of the batch's final originals anonymously by hand (it must answer 401 or 403), or the next batch's first new original settles it.",
  PRIVACY_STOPPED: `this state recorded a public or unexpected answer to the anonymous read of a final original, so nothing was sent. The Owner makes the bucket private and confirms it; ${PRIVACY_CONTINUE}`,
  ABANDON_SCOPE:
    "--abandon reaches unregistered items only. A staging object left after its item registered (the Admin's removal failed: Admin log EDITORIAL_MEDIA_INGEST_STAGING_DELETE_FAILED) is found by the Owner's listing of the staging prefix after the batch.",
});

/** The RUNBOOK lines for a summary, an --abandon result or an error code. */
export function runbookLines(result) {
  const keys = [
    ...Object.keys(plainObject(result?.codes) ? result.codes : {}),
    ...(["public", "unexpected", "uncertain"].includes(result?.privacy)
      ? [`PRIVACY_${result.privacy.toUpperCase()}`]
      : []),
    ...(result?.abandon === true ? ["ABANDON_SCOPE"] : []),
  ];
  return [...new Set(keys)]
    .filter((key) => Object.hasOwn(RUNBOOK, key))
    .map((key) => `EDITORIAL_DIRECT_INGEST_RUNBOOK ${key}: ${RUNBOOK[key]}`);
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
    for (const line of runbookLines(result)) process.stderr.write(`${line}\n`);
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
    const code = safeCode(error?.code);
    process.stderr.write(
      `EDITORIAL_DIRECT_INGEST_FAILED ${code}: inspect protected input and state locally; no private values were logged.\n`,
    );
    for (const line of runbookLines({ codes: { [code]: 1 } }))
      process.stderr.write(`${line}\n`);
    process.exitCode = 1;
  });

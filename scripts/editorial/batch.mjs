/** Controlled API client: no content, endpoint, credential or raw error output. */
import { createHash, randomUUID } from "node:crypto";
import { Buffer } from "node:buffer";
import {
  open,
  mkdir,
  readFile,
  rename,
  stat,
  lstat,
  unlink,
} from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { pathToFileURL, URL } from "node:url";
const { AbortController, AbortSignal, Blob, fetch, FormData } = globalThis;
import { setTimeout as sleep } from "node:timers/promises";

const MAX_INPUT_BYTES = 32 * 1024 * 1024;
const MAX_MEDIA_BYTES = 40 * 1024 * 1024;
const digest = (value) => createHash("sha256").update(value).digest("hex");
const token = (value) =>
  typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value);
const plainObject = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const throwCode = (code) => {
  const error = new Error(code);
  error.code = code;
  throw error;
};
const canonical = (value) => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (plainObject(value))
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
      .join(",")}}`;
  return JSON.stringify(value);
};
export const stableDigest = (value) => digest(canonical(value));

async function readBounded(
  file,
  maxBytes = MAX_INPUT_BYTES,
  privateFile = false,
) {
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

export function validateManifest(manifest) {
  if (
    !plainObject(manifest) ||
    manifest.version !== 1 ||
    !token(manifest.batchId) ||
    ![
      "save-draft",
      "upload-media",
      "publish-approved",
      "save-curation-metadata",
    ].includes(manifest.operation) ||
    !Array.isArray(manifest.items) ||
    !manifest.items.length ||
    manifest.items.length > 10_000
  )
    throwCode("MANIFEST_INVALID");
  const keys = new Set();
  for (const item of manifest.items) {
    if (!plainObject(item) || !token(item.key) || keys.has(item.key))
      throwCode("ITEM_IDENTITY_INVALID");
    keys.add(item.key);
    if (
      manifest.operation === "save-curation-metadata" &&
      (typeof item.metadataFile !== "string" ||
        !(
          item.expectedPreviousSha256 === null ||
          /^[a-f0-9]{64}$/.test(item.expectedPreviousSha256)
        ))
    )
      throwCode("CURATION_METADATA_INPUT_INVALID");
    if (
      manifest.operation === "save-draft" &&
      ((!plainObject(item.content) && typeof item.contentFile !== "string") ||
        (item.content && item.contentFile))
    )
      throwCode("DRAFT_INPUT_INVALID");
    if (
      manifest.operation === "upload-media" &&
      (typeof item.metadata?.mediaId !== "string" ||
        !item.metadata.mediaId.length ||
        item.metadata.mediaId.length > 128 ||
        typeof item.metadata?.catalogId !== "string" ||
        !item.metadata.catalogId.length ||
        item.metadata.catalogId.length > 128 ||
        typeof item.file !== "string" ||
        !["image/jpeg", "image/png", "image/webp"].includes(item.mimeType))
    )
      throwCode("MEDIA_INPUT_INVALID");
    if (
      manifest.operation === "publish-approved" &&
      (!token(String(item.id)) || !token(String(item.approvalId)))
    )
      throwCode("APPROVAL_INPUT_INVALID");
  }
  return manifest;
}

function localPath(root, value) {
  if (
    typeof value !== "string" ||
    /^[A-Za-z][A-Za-z0-9+.-]*:/.test(value) ||
    value.includes("\0")
  )
    throwCode("LOCAL_FILE_REQUIRED");
  return path.resolve(root, value);
}

export async function prepareItems(manifest, directory) {
  validateManifest(manifest);
  const prepared = [];
  let preparedBytes = 0;
  for (const item of manifest.items) {
    let body;
    let file;
    if (manifest.operation === "save-draft") {
      const content = item.contentFile
        ? parseJSON(await readBounded(localPath(directory, item.contentFile)))
        : item.content;
      body = {
        ...(item.id === undefined ? {} : { id: item.id }),
        ...(item.expectedRevision === undefined
          ? {}
          : { expectedRevision: item.expectedRevision }),
        content,
      };
    } else if (manifest.operation === "save-curation-metadata") {
      const { MAX_CURATION_METADATA_BYTES, decodeCurationMetadata } =
        await import("../../packages/contracts/dist/internal/editorial/index.js");
      const metadataPath = localPath(directory, item.metadataFile);
      const metadataInfo = await lstat(metadataPath);
      if (
        metadataInfo.isSymbolicLink() ||
        metadataInfo.uid !== process.getuid?.()
      )
        throwCode("CURATION_METADATA_FILE_INVALID");
      const bytes = await readBounded(
        metadataPath,
        MAX_CURATION_METADATA_BYTES,
        true,
      );
      const payloadJSON = bytes.toString("utf8");
      if (!bytes.equals(Buffer.from(payloadJSON, "utf8")))
        throwCode("CURATION_METADATA_ENCODING_INVALID");
      decodeCurationMetadata(payloadJSON);
      body = {
        payloadJSON,
        snapshotSha256: digest(bytes),
        expectedPreviousSha256: item.expectedPreviousSha256,
      };
    } else if (manifest.operation === "publish-approved") {
      body = { id: item.id, approvalId: item.approvalId };
    } else {
      const filePath = localPath(directory, item.file);
      const bytes = await readBounded(filePath, MAX_MEDIA_BYTES);
      const sha256 = digest(bytes);
      file = { filePath, sha256, size: bytes.length, mimeType: item.mimeType };
      // No source filename is transferred to the CMS; stable MediaId supplies it.
      body = { ...item.metadata, origin: "upload" };
      if (body.sha256 !== undefined && body.sha256 !== sha256)
        throwCode("MEDIA_DIGEST_MISMATCH");
      body.sha256 = sha256;
    }
    preparedBytes += Buffer.byteLength(JSON.stringify(body));
    if (preparedBytes > 64 * 1024 * 1024)
      throwCode("BATCH_MEMORY_BOUND_EXCEEDED");
    const requestHash = stableDigest({
      operation: manifest.operation,
      body,
      file: file
        ? { sha256: file.sha256, size: file.size, mimeType: file.mimeType }
        : null,
    });
    // Content changes must not reuse an idempotency key. Item identity is independently stable.
    const idempotencyKey = `batch-${digest(`${manifest.batchId}:${item.key}:${requestHash}`)}`;
    prepared.push({
      key: item.key,
      body: ["upload-media", "save-curation-metadata"].includes(
        manifest.operation,
      )
        ? body
        : { ...body, idempotencyKey },
      file,
      requestHash,
    });
  }
  return prepared;
}

async function writeReceipt(file, receipt) {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${randomUUID()}.tmp`;
  const handle = await open(temporary, "wx", 0o600);
  const { items, ...header } = receipt;
  try {
    await handle.writeFile(
      `${JSON.stringify(header)}\n${Object.entries(items)
        .map(([key, value]) => JSON.stringify({ key, value }))
        .join("\n")}${Object.keys(items).length ? "\n" : ""}`,
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
async function appendReceipt(file, key, value) {
  const handle = await open(file, "a", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify({ key, value })}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}
async function loadReceipt(file, manifest, scopeFingerprint) {
  let bytes;
  try {
    bytes = await readBounded(file, MAX_INPUT_BYTES, true);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  if (!bytes)
    return {
      version: 1,
      batchId: manifest.batchId,
      operation: manifest.operation,
      scopeFingerprint,
      items: {},
    };
  const text = bytes.toString("utf8");
  // A crash may interrupt only the last append. The preceding synced pending
  // record is replayed under the same idempotency key; no complete row is lost.
  const lines = text.slice(0, text.lastIndexOf("\n") + 1).split("\n");
  const header = parseJSON(lines.shift());
  if (
    !plainObject(header) ||
    header.version !== 1 ||
    header.batchId !== manifest.batchId ||
    header.operation !== manifest.operation ||
    header.scopeFingerprint !== scopeFingerprint
  )
    throwCode("RECEIPT_SCOPE_MISMATCH");
  const receipt = { ...header, items: {} };
  for (const line of lines) {
    if (!line) continue;
    const row = parseJSON(line);
    if (!token(row.key) || !plainObject(row.value))
      throwCode("RECEIPT_INVALID");
    receipt.items[row.key] = row.value;
  }
  return receipt;
}

function requestBase(config) {
  let url;
  try {
    url = new URL(config.baseURL);
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
  if (
    typeof config.apiKey !== "string" ||
    !config.apiKey.length ||
    /[\r\n]/.test(config.apiKey)
  )
    throwCode("CONFIG_AUTH_INVALID");
  return url.origin;
}

/** Inject fetch only for isolated tests. Fixed endpoints never come from source text. */
export function createTransport(config, fetchImpl = fetch) {
  const origin = requestBase(config);
  const timeoutMs = bounded(
    config.timeoutMs ?? 30_000,
    100,
    120_000,
    "TIMEOUT_INVALID",
  );
  const request = async (route, method, body, signal) => {
    if (signal?.aborted)
      return { ok: false, retryable: true, code: "TRANSPORT_UNCERTAIN" };
    let response;
    try {
      response = await fetchImpl(`${origin}${route}`, {
        method,
        headers: {
          Authorization: `users API-Key ${config.apiKey}`,
          ...(body instanceof FormData
            ? {}
            : { "Content-Type": "application/json" }),
        },
        body:
          body === undefined
            ? undefined
            : body instanceof FormData
              ? body
              : JSON.stringify(body),
        signal: signal
          ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)])
          : AbortSignal.timeout(timeoutMs),
        redirect: "error",
      });
    } catch {
      return { ok: false, retryable: true, code: "TRANSPORT_UNCERTAIN" };
    }
    let result;
    try {
      const reader = response.body?.getReader();
      if (!reader)
        return { ok: false, retryable: false, code: "RESPONSE_INVALID" };
      const chunks = [];
      let responseBytes = 0;
      for (;;) {
        const next = await reader.read();
        if (next.done) break;
        responseBytes += next.value.length;
        if (responseBytes > MAX_INPUT_BYTES) {
          await reader.cancel();
          return { ok: false, retryable: false, code: "RESPONSE_INVALID" };
        }
        chunks.push(Buffer.from(next.value));
      }
      const text = Buffer.concat(chunks).toString("utf8");
      if (text.length > MAX_INPUT_BYTES)
        return { ok: false, retryable: false, code: "RESPONSE_INVALID" };
      result = JSON.parse(text);
    } catch {
      return {
        ok: false,
        retryable: response.status >= 500,
        code: "RESPONSE_INVALID",
      };
    }
    if (!response.ok || result?.ok === false) {
      // Do not trust error text or even error code from a remote response as log-safe.
      const retryable = response.status === 429 || response.status >= 500;
      return {
        ok: false,
        retryable,
        code:
          response.status === 409
            ? "CONFLICT"
            : response.status === 401 || response.status === 403
              ? "FORBIDDEN"
              : retryable
                ? "SERVER_RETRYABLE"
                : "REQUEST_REJECTED",
      };
    }
    return { ok: true, result };
  };
  const transport = async (operation, item, { signal } = {}) => {
    const send = (route, method, body) => request(route, method, body, signal);
    if (
      ![
        "save-draft",
        "upload-media",
        "publish-approved",
        "save-curation-metadata",
      ].includes(operation)
    )
      throwCode("OPERATION_INVALID");
    if (operation === "upload-media") {
      const find = await send(
        `/api/media?where[mediaId][equals]=${encodeURIComponent(item.body.mediaId)}&limit=1&depth=0`,
        "GET",
      );
      if (!find.ok) return find;
      const existing = find.result?.docs?.[0];
      if (existing) {
        if (
          existing.mediaId !== item.body.mediaId ||
          existing.catalogId !== item.body.catalogId ||
          existing.sha256 !== item.file.sha256 ||
          ["alt", "rights", "orderConfidence"].some(
            (field) =>
              (existing[field] ?? undefined) !==
              (item.body[field] ?? undefined),
          )
        )
          return {
            ok: false,
            retryable: false,
            code: "MEDIA_IDENTITY_CONFLICT",
          };
        return { ok: true, result: projectReceipt(existing, true) };
      }
      const bytes = await readBounded(item.file.filePath, MAX_MEDIA_BYTES);
      if (digest(bytes) !== item.file.sha256)
        return { ok: false, retryable: false, code: "MEDIA_SOURCE_CHANGED" };
      const multipart = new FormData();
      multipart.set("_payload", JSON.stringify(item.body));
      multipart.set(
        "file",
        new Blob([bytes], { type: item.file.mimeType }),
        `${digest(item.body.mediaId)}.${item.file.mimeType === "image/jpeg" ? "jpg" : item.file.mimeType.split("/")[1]}`,
      );
      const result = await send("/api/media", "POST", multipart);
      if (result.ok)
        return {
          ok: true,
          result: projectReceipt(result.result.doc ?? result.result),
        };
      // A parallel successful create or a lost reply must be reconciled by MediaId before a replay.
      if (result.code === "CONFLICT") return { ...result, retryable: true };
      return result;
    }
    const response = await send(
      `/api/editorial/${operation}`,
      "POST",
      item.body,
    );
    if (!response.ok) return response;
    if (response.result?.ok !== true || !plainObject(response.result.result))
      return { ok: false, retryable: false, code: "RESPONSE_INVALID" };
    if (operation === "save-curation-metadata") {
      const { decodeCurationMetadata, deriveCurationMetadataCounts } =
        await import("../../packages/contracts/dist/internal/editorial/index.js");
      const committed = response.result.result;
      // An ACK is not complete acceptance. Read the stored metadata through
      // the controlled API before recording success; this route reads no media.
      const decoded = decodeCurationMetadata(item.body.payloadJSON);
      const readback = await send(
        "/api/editorial/read-curation-metadata",
        "POST",
        {
          catalogId: decoded.catalogId,
          snapshotSha256: item.body.snapshotSha256,
        },
      );
      if (!readback.ok) return readback;
      const stored = readback.result?.result;
      if (
        readback.result?.ok !== true ||
        !plainObject(stored) ||
        stored.payloadJSON !== item.body.payloadJSON ||
        stored.snapshotSha256 !== item.body.snapshotSha256 ||
        digest(stored.payloadJSON) !== item.body.snapshotSha256 ||
        stableDigest(stored.counts) !==
          stableDigest(deriveCurationMetadataCounts(decoded)) ||
        stored.previousSha256 !== item.body.expectedPreviousSha256 ||
        committed.snapshotSha256 !== stored.snapshotSha256 ||
        stored.current !== true
      )
        return {
          ok: false,
          retryable: false,
          code: "CURATION_METADATA_READBACK_MISMATCH",
        };
      return {
        ok: true,
        result: {
          ...projectReceipt(committed),
          snapshotSha256: stored.snapshotSha256,
          counts: stored.counts,
          verifiedReadback: true,
          currentAtReadback: true,
        },
      };
    }
    return { ok: true, result: projectReceipt(response.result.result) };
  };
  Object.defineProperty(transport, "scopeFingerprint", {
    value: stableDigest({ origin, identity: digest(config.apiKey) }),
  });
  return transport;
}

function projectReceipt(result, replayed = false) {
  if (result?.id === undefined || !token(String(result.id)))
    throwCode("RESPONSE_INVALID");
  return {
    id: result.id,
    ...(Number.isSafeInteger(result.revision)
      ? { revision: result.revision }
      : {}),
    ...(typeof result.fingerprint === "string" &&
    /^[a-f0-9]{64}$/.test(result.fingerprint)
      ? { fingerprint: result.fingerprint }
      : {}),
    replayed: replayed || result.replayed === true,
  };
}
function bounded(value, min, max, code) {
  if (!Number.isSafeInteger(value) || value < min || value > max)
    throwCode(code);
  return value;
}

/**
 * Receipt lock is fail-closed; after an interrupted process inspect before removing its lock.
 * Inject `now` only for isolated tests; the abort of in-flight requests always follows real time.
 */
export async function runBatch({
  manifest,
  directory,
  receiptFile,
  transport,
  dryRun = true,
  concurrency = 2,
  attempts = 3,
  budgetMs = 120_000,
  retryDelayMs = 250,
  now = Date.now,
  onProgress = () => {},
  signal,
}) {
  bounded(concurrency, 1, 8, "CONCURRENCY_INVALID");
  bounded(attempts, 1, 5, "ATTEMPTS_INVALID");
  bounded(budgetMs, 100, 900_000, "BUDGET_INVALID");
  bounded(retryDelayMs, 0, 10_000, "RETRY_DELAY_INVALID");
  const deadline = now() + budgetMs;
  const operationSignal = signal
    ? AbortSignal.any([signal, AbortSignal.timeout(budgetMs)])
    : AbortSignal.timeout(budgetMs);
  const stopped = () => operationSignal.aborted || now() >= deadline;
  const prepared = await prepareItems(manifest, directory);
  if (dryRun)
    return {
      dryRun: true,
      total: prepared.length,
      succeeded: 0,
      failed: 0,
      pending: prepared.length,
    };
  if (!transport) throwCode("TRANSPORT_REQUIRED");
  await mkdir(path.dirname(receiptFile), { recursive: true, mode: 0o700 });
  const lockFile = `${receiptFile}.lock`;
  let lock;
  try {
    lock = await open(lockFile, "wx", 0o600);
  } catch {
    throwCode("RECEIPT_LOCKED");
  }
  try {
    await lock.writeFile(
      `${JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() })}\n`,
    );
    await lock.sync();
    const receipt = await loadReceipt(
      receiptFile,
      manifest,
      transport.scopeFingerprint ?? "isolated-injected-transport",
    );
    for (const item of prepared)
      if (
        receipt.items[item.key] &&
        receipt.items[item.key].requestHash !== item.requestHash
      )
        throwCode("RECEIPT_INPUT_CHANGED");
    // Metadata success belongs to this invocation's controlled readback. If
    // cancelled or timed out before a request, an older success is only history.
    if (manifest.operation === "save-curation-metadata") {
      for (const item of prepared) {
        const previous = receipt.items[item.key];
        receipt.items[item.key] = {
          requestHash: item.requestHash,
          status: "pending",
          attempts: previous?.attempts ?? 0,
          ...(previous?.status === "succeeded"
            ? { priorCompletedResult: previous.result }
            : {}),
        };
      }
    }
    let cursor = 0;
    let writeQueue = Promise.resolve();
    const save = (key) => {
      const entry = key ? receipt.items[key] : undefined;
      writeQueue = writeQueue.then(() =>
        key
          ? appendReceipt(receiptFile, key, entry)
          : writeReceipt(receiptFile, receipt),
      );
      return writeQueue;
    };
    await save();
    const worker = async () => {
      while (cursor < prepared.length) {
        const item = prepared[cursor++];
        if (
          receipt.items[item.key]?.status === "succeeded" &&
          manifest.operation !== "save-curation-metadata"
        )
          continue;
        if (stopped()) break;
        let outcome;
        for (let attempt = 1; attempt <= attempts; attempt += 1) {
          if (stopped()) break;
          receipt.items[item.key] = {
            requestHash: item.requestHash,
            status: "pending",
            attempts: (receipt.items[item.key]?.attempts ?? 0) + 1,
          };
          await save(item.key);
          // Fsync can consume the remaining budget. Persist pending identity,
          // then recheck before starting any further request.
          if (stopped()) break;
          try {
            outcome = await transport(manifest.operation, item, {
              signal: operationSignal,
            });
          } catch {
            outcome = { ok: false, retryable: false, code: "CLIENT_FAILURE" };
          }
          if (
            outcome.ok ||
            !outcome.retryable ||
            attempt === attempts ||
            stopped()
          )
            break;
          await sleep(
            Math.min(
              retryDelayMs * 2 ** (attempt - 1),
              Math.max(0, deadline - now()),
            ),
            undefined,
            { signal: operationSignal },
          ).catch(() => {});
        }
        // An interrupted request may have committed remotely. Preserve its
        // pending identity so resume reconciles it before any retry.
        if (
          !outcome ||
          ((signal?.aborted ||
            (manifest.operation === "save-curation-metadata" &&
              operationSignal.aborted)) &&
            !outcome.ok)
        )
          break;
        receipt.items[item.key] = {
          ...receipt.items[item.key],
          status: outcome.ok ? "succeeded" : "failed",
          ...(outcome.ok
            ? { result: outcome.result }
            : {
                code: /^[A-Z_]{1,64}$/.test(outcome.code)
                  ? outcome.code
                  : "REQUEST_FAILED",
                retryable: outcome.retryable === true,
              }),
        };
        await save(item.key);
        onProgress({
          completed: Object.values(receipt.items).filter(
            (item) => item.status === "succeeded",
          ).length,
          total: prepared.length,
        });
      }
    };
    const workers = await Promise.allSettled(
      Array.from({ length: concurrency }, worker),
    );
    const failedWorker = workers.find((result) => result.status === "rejected");
    if (failedWorker) throw failedWorker.reason;
    await writeQueue;
    const scoped = prepared.map(({ key }) => receipt.items[key]);
    return {
      dryRun: false,
      total: prepared.length,
      succeeded: scoped.filter((item) => item?.status === "succeeded").length,
      failed: scoped.filter((item) => item?.status === "failed").length,
      pending: scoped.filter((item) => !item || item.status === "pending")
        .length,
    };
  } finally {
    await lock.close();
    await unlink(lockFile);
  }
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
      if (arg === "--execute") flags.execute = true;
      else if (
        ["--manifest", "--config", "--receipt"].includes(arg) &&
        process.argv[index + 1]
      )
        flags[arg.slice(2)] = process.argv[++index];
      else throwCode("ARGUMENTS_INVALID");
    }
    if (!flags.manifest) throwCode("MANIFEST_REQUIRED");
    const manifest = parseJSON(await readBounded(flags.manifest));
    const config = flags.execute
      ? parseJSON(await readBounded(flags.config, MAX_INPUT_BYTES, true))
      : {};
    if (flags.execute && !flags.receipt) throwCode("RECEIPT_REQUIRED");
    const result = await runBatch({
      manifest,
      directory: path.dirname(path.resolve(flags.manifest)),
      receiptFile: flags.receipt,
      transport: flags.execute ? createTransport(config) : undefined,
      dryRun: !flags.execute,
      concurrency: config.concurrency,
      attempts: config.attempts,
      budgetMs: config.budgetMs,
      signal: controller.signal,
    });
    process.stdout.write(`${JSON.stringify(result)}\n`);
    if (
      !process.exitCode &&
      (result.failed || (flags.execute && result.pending))
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
  main().catch(() => {
    process.stderr.write(
      "EDITORIAL_BATCH_FAILED: inspect protected input and receipts locally; no private values were logged.\n",
    );
    process.exitCode = 1;
  });

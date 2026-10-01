import { createHash, randomUUID } from "node:crypto";
import { Buffer } from "node:buffer";
import process from "node:process";
import { constants } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  rename,
  unlink,
} from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL, URL } from "node:url";

const { fetch, AbortSignal } = globalThis;

const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const plain = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const digestPattern = /^[a-f0-9]{64}$/u;
const tokenPattern = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u;
const fail = (code) => {
  throw Object.assign(new Error(code), { code });
};
const MAX_BYTES = 40 * 1024 * 1024;
const MIME = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
};

export async function privateJSON(file, maximum = 32 * 1024 * 1024) {
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await handle.stat();
    if (
      !info.isFile() ||
      info.size > maximum ||
      info.mode & 0o077 ||
      info.uid !== process.getuid()
    )
      fail("PRIVATE_INPUT_INVALID");
    const bytes = await handle.readFile();
    if (bytes.length > maximum) fail("PRIVATE_INPUT_INVALID");
    try {
      return JSON.parse(bytes.toString("utf8"));
    } catch {
      fail("JSON_INVALID");
    }
  } finally {
    await handle.close();
  }
}

export async function atomicPrivateJSON(file, value) {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${randomUUID()}.tmp`;
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary, file);
  await chmod(file, 0o600);
}

export async function dependencies(repoRoot) {
  const batch = await import(
    pathToFileURL(path.join(repoRoot, "scripts/editorial/batch.mjs")).href
  );
  const contracts = await import(
    pathToFileURL(
      path.join(
        repoRoot,
        "packages/contracts/dist/internal/editorial/index.js",
      ),
    ).href
  );
  const nextRequire = createRequire(
    path.join(repoRoot, "apps/admin/node_modules/next/package.json"),
  );
  const sharp = (await import(pathToFileURL(nextRequire.resolve("sharp")).href))
    .default;
  return { ...batch, ...contracts, sharp };
}

export function developmentOrigin(config) {
  if (
    !plain(config) ||
    config.instance !== "development" ||
    config.targetVerified !== true
  )
    fail("DEVELOPMENT_TARGET_REQUIRED");
  let url;
  try {
    url = new URL(config.baseURL);
  } catch {
    fail("DEVELOPMENT_TARGET_INVALID");
  }
  if (
    url.protocol !== "http:" ||
    !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ||
    !url.port ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  )
    fail("DEVELOPMENT_LOOPBACK_REQUIRED");
  if (
    typeof config.apiKey !== "string" ||
    !config.apiKey ||
    /[\r\n]/u.test(config.apiKey)
  )
    fail("DEVELOPMENT_AUTH_REQUIRED");
  if (config.syntheticOnly !== true) fail("ISOLATED_DEVELOPMENT_REQUIRED");
  return url.origin;
}

/** Only reviewed Catalog fields reach the existing internal Editorial contract. */
export async function validatePublicationPackage(
  input,
  { repoRoot, packageDirectory, deps } = {},
) {
  deps ??= await dependencies(repoRoot);
  if (
    !plain(input) ||
    input.version !== 1 ||
    input.instance !== "development" ||
    input.selectionConfirmed !== true ||
    !Array.isArray(input.objects) ||
    input.objects.length < 1 ||
    input.objects.length > 100
  )
    fail("PUBLICATION_PACKAGE_INVALID");
  const identities = new Set();
  const mediaIdentities = new Set();
  const objects = [];
  for (const object of input.objects) {
    if (
      !plain(object) ||
      !tokenPattern.test(object.objectId) ||
      identities.has(`object:${object.objectId}`) ||
      identities.has(`catalog:${object.catalogId}`) ||
      identities.has(`source:${object.sourceId}`) ||
      !plain(object.fields) ||
      !Array.isArray(object.media) ||
      object.media.length > 100
    )
      fail("OBJECT_IDENTITY_INVALID");
    for (const reserved of ["catalogId", "sourceId", "kind", "title", "media"])
      if (Object.hasOwn(object.fields, reserved))
        fail("RESERVED_EDITORIAL_FIELD");
    for (const [kind, value] of [
      ["object", object.objectId],
      ["catalog", object.catalogId],
      ["source", object.sourceId],
    ])
      identities.add(`${kind}:${value}`);
    const parsed = deps.editorialDraftSchema.safeParse({
      catalogId: object.catalogId,
      sourceId: object.sourceId,
      kind: object.kind,
      title: object.title,
      ...object.fields,
      media: [],
    });
    if (!parsed.success) fail("EDITORIAL_CONTENT_INVALID");
    if (
      object.cmsDraft !== undefined &&
      (!plain(object.cmsDraft) ||
        !Number.isSafeInteger(object.cmsDraft.id) ||
        object.cmsDraft.id < 1 ||
        !Number.isSafeInteger(object.cmsDraft.expectedRevision) ||
        object.cmsDraft.expectedRevision < 1 ||
        object.cmsDraft.instance !== "development" ||
        typeof object.cmsDraft.baseURL !== "string")
    )
      fail("CMS_DRAFT_MAPPING_INVALID");
    const positions = new Set();
    const assets = new Set();
    const media = [];
    for (const item of object.media) {
      if (
        !plain(item) ||
        !tokenPattern.test(item.assetId) ||
        assets.has(item.assetId) ||
        typeof item.mediaId !== "string" ||
        mediaIdentities.has(item.mediaId) ||
        !digestPattern.test(item.sourceSha256) ||
        !digestPattern.test(item.uploadedSha256) ||
        !Number.isSafeInteger(item.position) ||
        item.position < 0 ||
        positions.has(item.position) ||
        typeof item.isRepresentative !== "boolean" ||
        typeof item.alt !== "string" ||
        !item.alt ||
        item.alt.length > 2000 ||
        typeof item.derivativePath !== "string" ||
        /^[A-Za-z][A-Za-z0-9+.-]*:/u.test(item.derivativePath) ||
        item.derivativePath.includes("\0")
      )
        fail("MEDIA_PACKAGE_INVALID");
      if (
        item.rights !== undefined &&
        (typeof item.rights !== "string" ||
          !item.rights ||
          item.rights !== item.rights.trim() ||
          item.rights.length > 2000)
      )
        fail("MEDIA_RIGHTS_INVALID");
      if (
        item.orderConfidence !== undefined &&
        !["HIGH", "LOW"].includes(item.orderConfidence)
      )
        fail("MEDIA_ORDER_CONFIDENCE_INVALID");
      if (
        !deps.editorialMediaSchema.shape.mediaId.safeParse(item.mediaId).success
      )
        fail("MEDIA_IDENTITY_INVALID");
      positions.add(item.position);
      assets.add(item.assetId);
      mediaIdentities.add(item.mediaId);
      const file = path.resolve(packageDirectory, item.derivativePath);
      const info = await lstat(file);
      if (
        !info.isFile() ||
        info.isSymbolicLink() ||
        info.size < 1 ||
        info.size > MAX_BYTES
      )
        fail("MEDIA_FILE_INVALID");
      const bytes = await readFile(file);
      if (hash(bytes) !== item.uploadedSha256)
        fail("DERIVATIVE_DIGEST_MISMATCH");
      const mimeType = MIME[path.extname(file).toLowerCase()];
      if (!mimeType) fail("MEDIA_FORMAT_UNSUPPORTED");
      let image;
      try {
        image = await deps
          .sharp(bytes, { limitInputPixels: 80_000_000 })
          .metadata();
        await deps.sharp(bytes, { limitInputPixels: 80_000_000 }).stats();
      } catch {
        fail("MEDIA_FILE_INVALID");
      }
      const expectedFormat =
        mimeType === "image/jpeg" ? "jpeg" : mimeType.split("/")[1];
      if (
        image.format !== expectedFormat ||
        (image.pages ?? 1) > 1 ||
        !image.width ||
        !image.height
      )
        fail("MEDIA_FORMAT_MISMATCH");
      media.push({
        ...item,
        file,
        mimeType,
        width: image.width,
        height: image.height,
      });
    }
    if (
      media.length &&
      media.filter((item) => item.isRepresentative).length !== 1
    )
      fail("REPRESENTATIVE_MEDIA_REQUIRED");
    media.sort((left, right) => left.position - right.position);
    objects.push({ ...object, content: parsed.data, media });
  }
  return { objects, packageHash: deps.stableDigest(input), localOnly: true };
}

async function receiptItems(file) {
  const info = await lstat(file);
  if (!info.isFile() || info.mode & 0o077 || info.uid !== process.getuid())
    fail("RECEIPT_INVALID");
  const text = await readFile(file, "utf8");
  // The existing batch journal recovers a truncated final append from the
  // preceding synced pending identity. Read the same complete-row boundary.
  const rows = text.slice(0, text.lastIndexOf("\n") + 1).split("\n");
  rows.shift();
  const items = {};
  for (const row of rows)
    if (row) {
      const parsed = JSON.parse(row);
      items[parsed.key] = parsed.value;
    }
  return items;
}

export function createDraftReadClient(
  config,
  { fetchImpl = fetch, deadline = Date.now() + 120_000 } = {},
) {
  const origin = developmentOrigin(config);
  const request = async (route, method = "GET", body, authenticated = true) => {
    const remaining = deadline - Date.now();
    if (remaining <= 0) fail("TIME_BUDGET_EXCEEDED");
    if (
      !route.startsWith("/api/") ||
      route.includes("approve") ||
      route.includes("publish") ||
      route.includes("restore")
    )
      fail("OPERATION_NOT_AUTHORIZED");
    let response;
    try {
      response = await fetchImpl(`${origin}${route}`, {
        method,
        redirect: "error",
        headers: {
          ...(authenticated
            ? { Authorization: `users API-Key ${config.apiKey}` }
            : {}),
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(Math.min(30_000, remaining)),
      });
    } catch {
      fail("TRANSPORT_UNCERTAIN");
    }
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > MAX_BYTES + 1024 * 1024) fail("RESPONSE_TOO_LARGE");
    return {
      status: response.status,
      ok: response.ok,
      bytes,
      json: () => {
        try {
          return JSON.parse(bytes.toString("utf8"));
        } catch {
          fail("RESPONSE_INVALID");
        }
      },
    };
  };
  return {
    origin,
    request,
    async readDraft(id) {
      const response = await request("/api/editorial/read-draft", "POST", {
        id,
      });
      const value = response.json();
      if (
        !response.ok ||
        value.ok !== true ||
        !plain(value.result) ||
        value.result.id !== id ||
        !Number.isSafeInteger(value.result.revision) ||
        !digestPattern.test(value.result.fingerprint)
      )
        fail("DRAFT_READ_FAILED");
      return value.result;
    },
    async media(mediaId) {
      const response = await request(
        `/api/media?where[mediaId][equals]=${encodeURIComponent(mediaId)}&limit=1&depth=0`,
      );
      const result = response.json();
      if (
        !response.ok ||
        !Array.isArray(result.docs) ||
        result.docs.length !== 1 ||
        result.docs[0].mediaId !== mediaId
      )
        fail("MEDIA_READ_FAILED");
      return result.docs[0];
    },
  };
}

// Payload materializes absent stateful groups as UNSUPPLIED. Compare their
// declared canonical absence without changing omission/patch intentions sent.
export function readbackContent(content, deps) {
  return deps.editorialDraftSchema.parse({
    ...content,
    ...Object.fromEntries(
      deps.EDITORIAL_STATEFUL_FIELDS.map((key) => [
        key,
        content[key] ?? { state: "UNSUPPLIED" },
      ]),
    ),
  });
}

/** Executes only save-draft/upload-media using the existing bounded batch client. */
export async function draftRoundtrip({
  repoRoot,
  packageFile,
  configFile,
  stateDirectory,
  budgetMs = 120_000,
  signal,
  deps,
  fetchImpl = fetch,
}) {
  deps ??= await dependencies(repoRoot);
  const input = await privateJSON(packageFile);
  if (input.synthetic !== true) fail("REAL_MATERIAL_TRANSFER_NOT_AUTHORIZED");
  const prepared = await validatePublicationPackage(input, {
    repoRoot,
    packageDirectory: path.dirname(packageFile),
    deps,
  });
  const config = await privateJSON(configFile, 64 * 1024);
  developmentOrigin(config);
  if (
    !Array.isArray(config.catalogIds) ||
    prepared.objects.some(
      (object) => !config.catalogIds.includes(object.catalogId),
    )
  )
    fail("CATALOG_SCOPE_NOT_CONFIGURED");
  await mkdir(stateDirectory, { recursive: true, mode: 0o700 });
  const lockFile = path.join(stateDirectory, "adapter.lock");
  let lock;
  try {
    lock = await open(lockFile, "wx", 0o600);
  } catch {
    fail("ADAPTER_LOCKED");
  }
  const deadline = Date.now() + budgetMs;
  const operationSignal = signal
    ? AbortSignal.any([signal, AbortSignal.timeout(budgetMs)])
    : AbortSignal.timeout(budgetMs);
  const client = createDraftReadClient(config, { fetchImpl, deadline });
  // Existing transport follows native CMS redirects; pin every request here.
  const guardedFetch = (url, options) => {
    const target = new URL(url);
    if (
      target.origin !== client.origin ||
      (!target.pathname.startsWith("/api/media") &&
        !["/api/editorial/save-draft"].includes(target.pathname))
    )
      fail("OPERATION_NOT_AUTHORIZED");
    return fetchImpl(url, { ...options, redirect: "error" });
  };
  const transport = deps.createTransport(
    { ...config, timeoutMs: Math.min(30_000, budgetMs) },
    guardedFetch,
  );
  const batchPrefix = `av-${prepared.packageHash.slice(0, 24)}`;
  const keyFor = (value) => `item-${hash(value).slice(0, 32)}`;
  const results = [];
  let state;
  const stateFile = path.join(stateDirectory, "adapter-state.json");
  try {
    await lock.writeFile(
      `${JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() })}\n`,
    );
    try {
      state = await privateJSON(stateFile);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    const targetIdentity = deps.stableDigest({
      origin: client.origin,
      databaseName: config.databaseName ?? null,
    });
    state ??= {
      version: 1,
      instance: "development",
      targetIdentity,
      packageHash: prepared.packageHash,
      objects: {},
    };
    if (state.targetIdentity !== targetIdentity)
      fail("TARGET_INSTANCE_CHANGED");
    if (state.packageHash !== prepared.packageHash)
      fail("PACKAGE_STATE_CHANGED");
    const execute = async (manifest, phase) => {
      const remaining = deadline - Date.now();
      if (remaining < 100) fail("TIME_BUDGET_EXCEEDED");
      const receiptFile = path.join(stateDirectory, `${phase}.receipt.jsonl`);
      const outcome = await deps.runBatch({
        manifest,
        directory: path.dirname(packageFile),
        receiptFile,
        transport,
        dryRun: false,
        concurrency: 1,
        attempts: 2,
        budgetMs: remaining,
        signal: operationSignal,
      });
      return { outcome, items: await receiptItems(receiptFile) };
    };
    for (const object of prepared.objects) {
      const objectKey = keyFor(object.objectId);
      try {
        let record = state.objects[object.objectId];
        if (!record && object.cmsDraft) {
          if (object.cmsDraft.baseURL !== client.origin)
            fail("EXISTING_DRAFT_INSTANCE_MISMATCH");
          const existing = await client.readDraft(object.cmsDraft.id);
          if (existing.revision !== object.cmsDraft.expectedRevision)
            fail("REVISION_CONFLICT");
          if (
            existing.content.catalogId !== object.catalogId ||
            existing.content.sourceId !== object.sourceId ||
            existing.content.kind !== object.kind
          )
            fail("EXISTING_DRAFT_IDENTITY_MISMATCH");
          record = state.objects[object.objectId] = {
            id: existing.id,
            revision: existing.revision,
            packageHash: prepared.packageHash,
            phase: "created",
            existingDraft: true,
            // Persist update intentions merged with the exact current snapshot;
            // schema defaults must not clear arrays the package omitted.
            expectedContent: deps.editorialDraftSchema.parse({
              ...existing.content,
              catalogId: object.catalogId,
              sourceId: object.sourceId,
              kind: object.kind,
              title: object.title,
              ...object.fields,
              media: [],
            }),
          };
          await atomicPrivateJSON(stateFile, state);
        }
        if (!record) {
          const created = await execute(
            {
              version: 1,
              batchId: `${batchPrefix}-create`,
              operation: "save-draft",
              items: [{ key: objectKey, content: object.content }],
            },
            `${objectKey}-create`,
          );
          const item = created.items[objectKey];
          if (item?.status !== "succeeded")
            fail(item?.code ?? "DRAFT_CREATE_FAILED");
          if (
            !Number.isSafeInteger(item.result?.id) ||
            !Number.isSafeInteger(item.result?.revision)
          )
            fail("DRAFT_RECEIPT_INVALID");
          record = state.objects[object.objectId] = {
            id: item.result.id,
            revision: item.result.revision,
            packageHash: prepared.packageHash,
            phase: "created",
          };
          await atomicPrivateJSON(stateFile, state);
        }
        const snapshots = [];
        if (object.media.length) {
          const uploaded = await execute(
            {
              version: 1,
              batchId: `${batchPrefix}-media`,
              operation: "upload-media",
              items: object.media.map((media) => ({
                key: keyFor(`${object.objectId}:${media.assetId}`),
                file: media.file,
                mimeType: media.mimeType,
                metadata: {
                  mediaId: media.mediaId,
                  catalogId: object.catalogId,
                  alt: media.alt,
                  ...(media.rights === undefined
                    ? {}
                    : { rights: media.rights }),
                  ...(media.orderConfidence === undefined
                    ? {}
                    : { orderConfidence: media.orderConfidence }),
                },
              })),
            },
            `${objectKey}-media`,
          );
          if (uploaded.outcome.succeeded !== object.media.length)
            fail("MEDIA_BATCH_INCOMPLETE");
          for (const media of object.media) {
            const registered = await client.media(media.mediaId);
            if (
              registered.catalogId !== object.catalogId ||
              registered.sha256 !== media.uploadedSha256 ||
              registered.width !== media.width ||
              registered.height !== media.height
            )
              fail("MEDIA_READBACK_MISMATCH");
            const snapshot = {
              mediaId: media.mediaId,
              objectKey: registered.objectKey,
              width: registered.width,
              height: registered.height,
              alt: media.alt,
              position: media.position,
              isRepresentative: media.isRepresentative,
              ...(media.rights === undefined ? {} : { rights: media.rights }),
              ...(media.orderConfidence === undefined
                ? {}
                : { orderConfidence: media.orderConfidence }),
            };
            if (!deps.editorialMediaSchema.safeParse(snapshot).success)
              fail("MEDIA_SNAPSHOT_INVALID");
            snapshots.push(snapshot);
            if (typeof registered.filename !== "string")
              fail("MEDIA_FILENAME_MISSING");
            const route = `/api/media/file/${encodeURIComponent(registered.filename)}`;
            const bytes = await client.request(route);
            if (!bytes.ok || hash(bytes.bytes) !== media.uploadedSha256)
              fail("MEDIA_BYTES_READBACK_MISMATCH");
            const anonymous = await client.request(
              route,
              "GET",
              undefined,
              false,
            );
            if (anonymous.ok) fail("DRAFT_MEDIA_PUBLICLY_READABLE");
          }
        }
        const content = deps.editorialDraftSchema.parse({
          ...(record.expectedContent ?? object.content),
          media: snapshots,
        });
        const current = await client.readDraft(record.id);
        if (record.phase === "created") {
          if (record.attachExpectedRevision === undefined) {
            if (current.revision !== record.revision) fail("REVISION_CONFLICT");
            record.attachExpectedRevision = current.revision;
            await atomicPrivateJSON(stateFile, state);
          }
          const saved = await execute(
            {
              version: 1,
              batchId: `${batchPrefix}-attach`,
              operation: "save-draft",
              items: [
                {
                  key: objectKey,
                  id: record.id,
                  expectedRevision: record.attachExpectedRevision,
                  content,
                },
              ],
            },
            `${objectKey}-attach`,
          );
          const receipt = saved.items[objectKey];
          if (
            receipt?.status !== "succeeded" ||
            !Number.isSafeInteger(receipt.result?.revision)
          )
            fail(receipt?.code ?? "DRAFT_ATTACH_FAILED");
          record.revision = receipt.result.revision;
          record.phase = "attached";
          await atomicPrivateJSON(stateFile, state);
        }
        const readback = await client.readDraft(record.id);
        if (
          readback.revision !== record.revision ||
          deps.stableDigest(readbackContent(readback.content, deps)) !==
            deps.stableDigest(readbackContent(content, deps))
        )
          fail("DRAFT_CONTENT_READBACK_MISMATCH");
        // Reinvoke the actual server command rather than counting local receipt skipping as replay.
        const receiptFile = path.join(
          stateDirectory,
          `${objectKey}-attach.receipt.jsonl`,
        );
        const prior = await receiptItems(receiptFile);
        const attachRevision = record.attachExpectedRevision;
        if (
          !Number.isSafeInteger(attachRevision) ||
          prior[objectKey]?.status !== "succeeded"
        )
          fail("DRAFT_REPLAY_STATE_INVALID");
        const manifest = {
          version: 1,
          batchId: `${batchPrefix}-attach`,
          operation: "save-draft",
          items: [
            {
              key: objectKey,
              id: record.id,
              expectedRevision: attachRevision,
              content,
            },
          ],
        };
        const [item] = await deps.prepareItems(
          manifest,
          path.dirname(packageFile),
        );
        const replay = await transport("save-draft", item, {
          signal: operationSignal,
        });
        if (
          !replay.ok ||
          replay.result.replayed !== true ||
          replay.result.revision !== readback.revision
        )
          fail("SERVER_REPLAY_NOT_VERIFIED");
        const stale = await transport(
          "save-draft",
          {
            ...item,
            body: {
              ...item.body,
              idempotencyKey: `${batchPrefix}:${objectKey}:stale`,
              expectedRevision: Math.max(0, readback.revision - 1),
            },
          },
          { signal: operationSignal },
        );
        if (stale.ok || stale.code !== "CONFLICT")
          fail("STALE_REVISION_NOT_REJECTED");
        const afterStale = await client.readDraft(record.id);
        if (
          afterStale.revision !== readback.revision ||
          afterStale.fingerprint !== readback.fingerprint
        )
          fail("STALE_REVISION_CHANGED_DRAFT");
        const anonymous = await client.request(
          "/api/editorial/read-draft",
          "POST",
          { id: record.id },
          false,
        );
        if (anonymous.ok) fail("ANONYMOUS_DRAFT_READ_ALLOWED");
        const summary = await client.request(
          `/api/catalogs/${record.id}?depth=0&draft=false`,
        );
        if (summary.ok && summary.json()._status === "published")
          fail("UNAUTHORIZED_PUBLICATION_STATE");
        record.phase = "verified";
        record.fingerprint = readback.fingerprint;
        await atomicPrivateJSON(stateFile, state);
        results.push({
          objectId: object.objectId,
          id: record.id,
          revision: record.revision,
          status: "verified",
          cmsDraft: {
            id: record.id,
            expectedRevision: record.revision,
            instance: "development",
            baseURL: client.origin,
          },
          media: object.media.length,
          exactContentReadback: true,
          mediaBytesReadback: true,
          replay: true,
          staleRevisionRejected: true,
          draftPrivate: true,
        });
      } catch (error) {
        results.push({
          objectId: object.objectId,
          status: "failed",
          category: /^[A-Z_]{3,64}$/u.test(error.code ?? error.message)
            ? (error.code ?? error.message)
            : "DRAFT_INTEGRATION_FAILED",
        });
      }
    }
    const summary = {
      version: 1,
      instance: "development",
      packageHash: prepared.packageHash,
      total: results.length,
      succeeded: results.filter((item) => item.status === "verified").length,
      failed: results.filter((item) => item.status === "failed").length,
      results,
      productionPublication: "NOT_AUTHORIZED_NOT_RUN",
    };
    await atomicPrivateJSON(
      path.join(stateDirectory, "integration-summary.json"),
      summary,
    );
    return summary;
  } finally {
    await lock.close();
    await unlink(lockFile);
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  const [operation, repoRoot, packageFile, configFile, stateDirectory] =
    process.argv.slice(2);
  try {
    if (operation === "validate") {
      const prepared = await validatePublicationPackage(
        await privateJSON(packageFile),
        { repoRoot, packageDirectory: path.dirname(packageFile) },
      );
      process.stdout.write(
        `${JSON.stringify({ offlineValidation: "PASS", objects: prepared.objects.length, media: prepared.objects.reduce((sum, item) => sum + item.media.length, 0) })}\n`,
      );
    } else if (operation === "draft") {
      const result = await draftRoundtrip({
        repoRoot,
        packageFile,
        configFile,
        stateDirectory,
      });
      process.stdout.write(
        `${JSON.stringify({ developmentIntegration: result.failed ? "PARTIAL" : "PASS", succeeded: result.succeeded, failed: result.failed, productionPublication: result.productionPublication })}\n`,
      );
      if (result.failed) process.exitCode = 1;
    } else fail("OPERATION_NOT_AUTHORIZED");
  } catch (error) {
    process.stdout.write(
      `${JSON.stringify({ status: "FAIL", category: /^[A-Z_]{3,64}$/u.test(error.code ?? error.message) ? (error.code ?? error.message) : "ADAPTER_FAILED" })}\n`,
    );
    process.exitCode = 1;
  }
}

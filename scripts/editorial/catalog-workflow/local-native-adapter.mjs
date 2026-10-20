import { constants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { Buffer } from "node:buffer";
import {
  editorialDraftSchema,
  editorialSaveDraftSchema,
  editorialUploadedMediaSchema,
  EDITORIAL_FIELD_NAMES,
  MEDIA_UPLOAD_CHUNK_BYTES,
} from "../../../packages/contracts/dist/internal/editorial/index.js";
import { stageMediaUpload } from "../resumable-upload.mjs";
import { privateJSON } from "../../curation/adapter.mjs";
import { withLocalHTTPCheckpointStore } from "./checkpoint-store.mjs";
import {
  createTransferBudget,
  openTransferBudget,
} from "./transfer-budget.mjs";
import {
  digest,
  fail,
  targetIdentity,
  validateManifest,
  verifyPrincipal,
} from "./identity.mjs";
import {
  createLocalNativeHTTP,
  nativeRouteClass,
  validateLocalFixture,
} from "./local-native-http.mjs";
import { runLocalHTTPDraftWorkflow } from "./workflow.mjs";
import {
  importRegisteredMediaProof,
  registeredProofDigest,
  validateRegisteredMediaProof,
} from "./registered-media-proof.mjs";
import { verifyHistoricalConversion } from "./historical-proof-converter.mjs";

const clone = (value) => JSON.parse(JSON.stringify(value));
const hashBytes = (value) => createHash("sha256").update(value).digest("hex");
const exact = (value, keys) =>
  value &&
  Object.getPrototypeOf(value) === Object.prototype &&
  Object.keys(value).length === keys.length &&
  keys.every((key) => Object.hasOwn(value, key));
const SHA = /^[a-f0-9]{64}$/;
const positive = (value) => Number.isSafeInteger(value) && value > 0;

export function uploadProofInputs(record, asset, mapping) {
  const body = {
    catalogId: record.catalogId,
    mediaId: asset.mediaId,
    alt: mapping.alt,
    ...(mapping.rights === null ? {} : { rights: mapping.rights }),
    ...(mapping.orderConfidence === null
      ? {}
      : { orderConfidence: mapping.orderConfidence }),
  };
  return {
    body,
    requestHash: digest({
      catalogId: record.catalogId,
      mediaId: asset.mediaId,
      sourceSha256: asset.sourceSha256,
      uploadedSha256: asset.uploadedSha256,
      bytes: asset.bytes,
      mimeType: mapping.mimeType,
      body,
    }),
  };
}

// Matches the existing server's ordered JSON fingerprint, not canonical manifest hashing.
export function saveReceiptIdentity(actorId, originalBody) {
  const parsed = editorialSaveDraftSchema.parse(originalBody);
  const patch = Object.fromEntries(
    EDITORIAL_FIELD_NAMES.filter((key) =>
      Object.hasOwn(originalBody.content, key),
    ).map((key) => [key, parsed.content[key]]),
  );
  return {
    deduplicationKey: hashBytes(
      JSON.stringify([actorId, parsed.idempotencyKey]),
    ),
    requestFingerprint: hashBytes(
      JSON.stringify({ operation: "save-draft", ...parsed, content: patch }),
    ),
  };
}

export function validateControlledInput(manifest, input) {
  if (
    !exact(input, ["version", "root", "records"]) ||
    input.version !== 1 ||
    !path.isAbsolute(input.root) ||
    !Array.isArray(input.records) ||
    input.records.length !== manifest.records.length
  )
    fail("CONTROLLED_INPUT_INVALID");
  const records = new Map();
  for (const row of input.records) {
    const record = manifest.records.find(
      (item) => item.recordId === row.recordId,
    );
    if (
      !record ||
      records.has(row.recordId) ||
      !exact(row, [
        "recordId",
        "nativeId",
        "baselineStatus",
        "content",
        "media",
      ]) ||
      !["draft", "published"].includes(row.baselineStatus) ||
      !positive(row.nativeId) ||
      !Array.isArray(row.media) ||
      row.media.length !== record.media.length
    )
      fail("CONTROLLED_INPUT_INVALID");
    const content =
      row.content === null ? null : editorialDraftSchema.parse(row.content);
    if (
      content &&
      (content.catalogId !== record.catalogId ||
        content.sourceId !== record.sourceId ||
        digest(content) !== record.contentSha256)
    )
      fail("CONTROLLED_CONTENT_HASH_MISMATCH");
    if (
      content &&
      (content.media.length !== record.media.length ||
        content.media.some((media, index) => {
          const asset = record.media[index];
          return (
            media.mediaId !== asset.mediaId ||
            media.width !== asset.width ||
            media.height !== asset.height ||
            media.position !== asset.position ||
            media.isRepresentative !== asset.isRepresentative
          );
        }))
    )
      fail("CONTROLLED_CONTENT_HASH_MISMATCH");
    const mediaIds = new Set();
    for (const media of row.media) {
      if (
        !exact(media, [
          "mediaId",
          "file",
          "mimeType",
          "alt",
          "rights",
          "orderConfidence",
        ]) ||
        !record.media.some((asset) => asset.mediaId === media.mediaId) ||
        mediaIds.has(media.mediaId) ||
        (media.file !== null &&
          (typeof media.file !== "string" ||
            path.isAbsolute(media.file) ||
            media.file.split(path.sep).includes(".."))) ||
        !["image/jpeg", "image/png", "image/webp"].includes(media.mimeType) ||
        typeof media.alt !== "string" ||
        (media.rights !== null && typeof media.rights !== "string") ||
        ![null, "HIGH", "LOW"].includes(media.orderConfidence)
      )
        fail("CONTROLLED_INPUT_INVALID");
      mediaIds.add(media.mediaId);
    }
    records.set(row.recordId, { ...clone(row), content });
  }
  return { version: 1, root: input.root, records: [...records.values()] };
}

export function mediaIdentity(record, asset, mapping, raw) {
  const media = editorialUploadedMediaSchema.parse(
    Object.fromEntries(
      Object.keys(editorialUploadedMediaSchema.shape)
        .filter(
          (key) =>
            raw[key] !== undefined &&
            (raw[key] !== null ||
              (key !== "rights" && key !== "orderConfidence")),
        )
        .map((key) => [key, raw[key]]),
    ),
  );
  if (
    media.mediaId !== asset.mediaId ||
    media.catalogId !== record.catalogId ||
    media.sha256 !== asset.uploadedSha256 ||
    media.filesize !== asset.bytes ||
    media.width !== asset.width ||
    media.height !== asset.height ||
    media.mimeType !== mapping.mimeType ||
    media.alt !== mapping.alt ||
    (media.rights ?? null) !== mapping.rights ||
    (media.orderConfidence ?? null) !== mapping.orderConfidence
  )
    fail("NATIVE_MEDIA_IDENTITY_MISMATCH");
  return media;
}

export async function imageBytes(root, mapping, asset) {
  if (mapping.file === null) fail("CONTROLLED_MEDIA_FILE_MISSING");
  const directory = await realpath(root),
    file = path.join(directory, mapping.file),
    resolved = await realpath(file);
  if (!resolved.startsWith(directory + path.sep) || resolved !== file)
    fail("CONTROLLED_INPUT_PATH_REJECTED");
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await handle.stat();
    if (
      !info.isFile() ||
      info.size !== asset.bytes ||
      info.size > 40 * 1024 * 1024
    )
      fail("CONTROLLED_MEDIA_CHANGED");
    const bytes = await handle.readFile();
    const magic =
      mapping.mimeType === "image/png"
        ? bytes
            .subarray(0, 8)
            .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
        : mapping.mimeType === "image/jpeg"
          ? bytes[0] === 255 && bytes[1] === 216
          : bytes.subarray(0, 4).toString() === "RIFF" &&
            bytes.subarray(8, 12).toString() === "WEBP";
    if (
      !magic ||
      bytes.length !== asset.bytes ||
      hashBytes(bytes) !== asset.uploadedSha256
    )
      fail("CONTROLLED_MEDIA_CHANGED");
    return bytes;
  } finally {
    await handle.close();
  }
}

/** Real loopback HTTP requests; the fixture is synthetic, not a Payload server. */
export async function withLocalNativeAdapter(options, work) {
  const manifest = clone(validateManifest(options.manifest)),
    fixture = validateLocalFixture(manifest, options.fixture);
  const input = validateControlledInput(manifest, options.input);
  const configured = {
    maxAttempts: 2,
    concurrency: 4,
    chunkBytes: MEDIA_UPLOAD_CHUNK_BYTES,
  };
  const scopeSha256 = digest({
    executionKind: "local-http",
    manifest,
    input,
    fixture,
    limits: options.limits,
    responseByteLimit: options.responseByteLimit,
    uploadMode: options.uploadMode ?? "parallel-chunks-v1",
  });
  return withLocalHTTPCheckpointStore(
    options.directory,
    manifest,
    async ({
      checkpoint,
      inputMatches,
      persist: persistPhase,
      assertOwned,
      persistCompanion,
    }) => {
      if (!inputMatches) fail("CHECKPOINT_INPUT_CHANGED");
      await persistPhase(checkpoint);
      const file = path.join(options.directory, "local-native-journal.json");
      let journal;
      // One verified regeneration per source bundle per locked run; every entry is
      // still matched exactly. A new process always re-reads the pinned raw files.
      const conversions = new Map();
      const verifyConversion = async (reference) => {
        const key = digest({
          converter: reference.converter,
          sourceSpec: reference.sourceSpec,
          bundleSha256: reference.bundleSha256,
        });
        let bundle = conversions.get(key);
        if (!bundle) {
          const verified = await verifyHistoricalConversion(reference);
          bundle = verified.bundle;
          conversions.set(key, bundle);
        }
        const entry = bundle.entries.find(
          (e) => e.entryId === reference.entryId,
        );
        if (!entry || entry.entrySha256 !== reference.entrySha256)
          fail("HISTORICAL_CONVERSION_CHANGED");
        return { bundle, entry };
      };
      try {
        journal = await privateJSON(file, 16 * 1024 * 1024);
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
      if (journal) {
        if (
          !exact(journal, [
            "version",
            "executionKind",
            "scopeSha256",
            "responseByteLimit",
            "budget",
            "requests",
            "mediaProofs",
            "actions",
            "publishedObserved",
          ]) ||
          ![1, 2].includes(journal.version) ||
          journal.executionKind !== "local-http" ||
          journal.scopeSha256 !== scopeSha256 ||
          !Array.isArray(journal.requests) ||
          !journal.mediaProofs ||
          !journal.actions ||
          !exact(
            journal.publishedObserved,
            manifest.records.map((row) => row.recordId),
          ) ||
          Object.values(journal.publishedObserved).some(
            (value) => typeof value !== "boolean",
          ) ||
          journal.requests.length !== journal.budget.requests.length
        )
          fail("LOCAL_JOURNAL_SCOPE_CHANGED");
        journal.budget = openTransferBudget(
          journal.budget,
          scopeSha256,
          options.limits,
          configured,
          "local-http",
        );
        for (let index = 0; index < journal.requests.length; index++) {
          const row = journal.requests[index];
          if (journal.version === 1 && !Object.hasOwn(row, "receipt"))
            row.receipt = null;
          if (
            !exact(row, [
              "sequence",
              "logicalKey",
              "logicalAttempt",
              "requestSha256",
              "route",
              "routeClass",
              "method",
              "status",
              "httpStatus",
              "requestBodyBytes",
              "responseBodyBytes",
              "binaryBodyBytes",
              "responseSha256",
              "receipt",
              "drained",
            ]) ||
            row.sequence !== index + 1 ||
            row.requestSha256 !==
              journal.budget.requests[index].requestSha256 ||
            row.routeClass !== nativeRouteClass(row.route, row.method) ||
            !SHA.test(row.logicalKey) ||
            !positive(row.logicalAttempt) ||
            !["PENDING", "COMPLETE", "UNKNOWN"].includes(row.status) ||
            typeof row.drained !== "boolean" ||
            !["requestBodyBytes", "responseBodyBytes", "binaryBodyBytes"].every(
              (key) => Number.isSafeInteger(row[key]) && row[key] >= 0,
            ) ||
            (row.responseSha256 !== null && !SHA.test(row.responseSha256)) ||
            (row.httpStatus !== null &&
              (!Number.isSafeInteger(row.httpStatus) ||
                row.httpStatus < 100 ||
                row.httpStatus > 599))
          )
            fail("LOCAL_JOURNAL_INVALID");
          if (
            journal.version === 2 &&
            row.status === "COMPLETE" &&
            row.receipt === null
          )
            fail("LOCAL_JOURNAL_INVALID");
          if (row.receipt !== null) {
            const r = row.receipt,
              b = journal.budget.requests[index];
            if (
              !exact(r, [
                "version",
                "executionKind",
                "scopeSha256",
                "targetIdentitySha256",
                "requestSha256",
                "route",
                "method",
                "httpStatus",
                "transportStatus",
                "responseSha256",
                "resultSha256",
                "metadataSha256",
              ]) ||
              r.version !== 1 ||
              r.executionKind !== "local-http" ||
              r.scopeSha256 !== scopeSha256 ||
              r.targetIdentitySha256 !== targetIdentity(manifest) ||
              r.requestSha256 !== row.requestSha256 ||
              r.route !== row.route ||
              r.method !== row.method ||
              r.httpStatus !== row.httpStatus ||
              r.transportStatus !== row.status ||
              r.responseSha256 !== row.responseSha256 ||
              !SHA.test(r.resultSha256) ||
              (r.metadataSha256 !== null && !SHA.test(r.metadataSha256)) ||
              (row.status === "COMPLETE" &&
                (!row.drained ||
                  b.status !== "COMPLETE" ||
                  b.actualUploadBytes !== row.requestBodyBytes ||
                  b.actualDownloadBytes !== row.responseBodyBytes ||
                  b.evidenceSha256 !==
                    digest({
                      requestSha256: row.requestSha256,
                      status: row.httpStatus,
                      responseSha256: row.responseSha256,
                    })))
            )
              fail("LOCAL_JOURNAL_INVALID");
          }
        }
        for (const [mediaId, proof] of Object.entries(journal.mediaProofs)) {
          const record = manifest.records.find((row) =>
            row.media.some((asset) => asset.mediaId === mediaId),
          );
          const asset = record?.media.find((row) => row.mediaId === mediaId),
            mapping = input.records
              .find((row) => row.recordId === record?.recordId)
              ?.media.find((row) => row.mediaId === mediaId);
          if (
            !record ||
            proof.sourceSha256 !== asset.sourceSha256 ||
            proof.uploadedSha256 !== asset.uploadedSha256 ||
            !SHA.test(proof.evidenceSha256)
          )
            fail("LOCAL_JOURNAL_INVALID");
          mediaIdentity(record, asset, mapping, proof.media);
          if (
            proof.audit?.kind ===
            "HISTORICAL_FULL_BYTE_PROOF_WITH_CURRENT_NATIVE_METADATA"
          )
            await validateRegisteredMediaProof({
              proof,
              manifest,
              recordId: record.recordId,
              scopeSha256,
              requests: journal.requests,
              verifyConversion,
            });
          else {
            const { requestHash } = uploadProofInputs(record, asset, mapping),
              expected = {
                requestHash,
                nativeMedia: proof.media,
                validatedBytes: asset.bytes,
                validatedSha256: asset.uploadedSha256,
              };
            if (
              journal.version === 1 &&
              exact(proof, [
                "media",
                "sourceSha256",
                "uploadedSha256",
                "evidenceSha256",
              ])
            ) {
              if (proof.evidenceSha256 !== digest(expected))
                fail("LOCAL_JOURNAL_INVALID");
              // This verifies the legacy construction only, not a new wire audit.
            } else if (
              !exact(proof, [
                "media",
                "sourceSha256",
                "uploadedSha256",
                "evidenceSha256",
                "audit",
              ]) ||
              !exact(proof.audit, [
                "version",
                "kind",
                "requestHash",
                "validatedBytes",
                "validatedSha256",
                "reused",
                "nativeReceipt",
              ]) ||
              proof.audit.version !== 1 ||
              proof.audit.kind !== "NATIVE_UPLOAD" ||
              proof.audit.requestHash !== requestHash ||
              proof.audit.validatedBytes !== asset.bytes ||
              proof.audit.validatedSha256 !== asset.uploadedSha256 ||
              typeof proof.audit.reused !== "boolean" ||
              proof.evidenceSha256 !== registeredProofDigest(proof)
            )
              fail("LOCAL_JOURNAL_INVALID");
            else {
              const receipt = proof.audit.nativeReceipt,
                rows = journal.requests.filter(
                  (r) => r.requestSha256 === receipt?.requestSha256,
                ),
                row = rows[0];
              if (
                rows.length !== 1 ||
                row.status !== "COMPLETE" ||
                !row.drained ||
                row.httpStatus !== 200 ||
                row.route !== "/api/editorial/media-upload/complete" ||
                row.method !== "POST" ||
                !row.receipt ||
                digest(row.receipt) !== digest(receipt) ||
                receipt.resultSha256 !==
                  digest({
                    ok: true,
                    result: {
                      media: proof.media,
                      reused: proof.audit.reused,
                      validatedBytes: asset.bytes,
                      validatedSha256: asset.uploadedSha256,
                    },
                  })
              )
                fail("LOCAL_JOURNAL_INVALID");
            }
          }
        }
        for (const [key, action] of Object.entries(journal.actions)) {
          const record = manifest.records.find(
            (row) => `${row.recordId}-save-draft` === key,
          );
          if (
            !record ||
            !exact(action, [
              "id",
              "expectedRevision",
              "contentSha256",
              "status",
              "idempotencyKey",
              "result",
            ]) ||
            !positive(action.id) ||
            !positive(action.expectedRevision) ||
            action.contentSha256 !== record.contentSha256 ||
            !["PENDING", "UNKNOWN", "CONFIRMED"].includes(action.status) ||
            typeof action.idempotencyKey !== "string" ||
            !/^(local|workflow)-[a-f0-9]{64}$/.test(action.idempotencyKey) ||
            (action.result !== null &&
              (!exact(action.result, ["id", "revision", "fingerprint"]) ||
                action.result.id !== action.id ||
                action.result.revision !== action.expectedRevision + 1 ||
                !SHA.test(action.result.fingerprint)))
          )
            fail("LOCAL_JOURNAL_INVALID");
        }
      } else
        journal = {
          version: 2,
          executionKind: "local-http",
          scopeSha256,
          responseByteLimit: options.responseByteLimit,
          budget: createTransferBudget(
            scopeSha256,
            options.limits,
            configured,
            "local-http",
          ),
          requests: [],
          mediaProofs: {},
          actions: {},
          publishedObserved: Object.fromEntries(
            input.records.map((row) => [
              row.recordId,
              row.baselineStatus === "published",
            ]),
          ),
        };
      if (
        !positive(options.responseByteLimit) ||
        options.responseByteLimit > 1024 * 1024
      )
        fail("LOCAL_HTTP_ARGUMENTS_INVALID");
      let writes = Promise.resolve();
      const persist = () => {
        const snapshot = clone(journal);
        writes = writes.then(async () => {
          await assertOwned();
          await options.beforeJournalPersist?.(snapshot);
          await persistCompanion("local-native-journal.json", snapshot);
        });
        return writes;
      };
      await persist();
      const httpClient = createLocalNativeHTTP({
        manifest,
        fixture,
        journal,
        persist,
        assertAdmission: assertOwned,
        deadline: options.deadline,
        timeoutMs: options.timeoutMs,
      });
      let completion = Promise.resolve();
      const complete = (operation) => {
        const next = completion.then(operation);
        completion = next.catch(() => {});
        return next;
      };
      const request = async (route, method = "GET", body) => {
        const result = await httpClient.send(
          route,
          method,
          body,
          options.signal,
        );
        if (!result.ok)
          throw Object.assign(new Error(result.code), { code: result.code });
        return result.result;
      };
      const entry = (recordId) => {
        const record = manifest.records.find(
            (row) => row.recordId === recordId,
          ),
          mapping = input.records.find((row) => row.recordId === recordId);
        if (!record || !mapping) fail("ACTION_RECORD_NOT_IN_SCOPE");
        return { record, mapping, state: checkpoint.records[recordId] };
      };
      const protectedRecord = (record, state) =>
        record.disposition === "hold" ||
        Object.values(state.protections).some(Boolean);
      const readMedia = async (record, asset, mapping) => {
        const result = await request(
          `/api/media?where[mediaId][equals]=${asset.mediaId}&limit=1&depth=0`,
        );
        if (!Array.isArray(result.docs) || result.docs.length > 1)
          fail("NATIVE_MEDIA_IDENTITY_MISMATCH");
        return result.docs.length
          ? mediaIdentity(record, asset, mapping, result.docs[0])
          : null;
      };
      const readDraft = async (mapping, record) => {
        const result = await request("/api/editorial/read-draft", "POST", {
          id: mapping.nativeId,
        });
        if (
          result.ok !== true ||
          result.result?.id !== mapping.nativeId ||
          !positive(result.result.revision) ||
          !SHA.test(result.result.fingerprint)
        )
          fail("NATIVE_DRAFT_INVALID");
        const content = editorialDraftSchema.parse(result.result.content);
        if (
          content.catalogId !== record.catalogId ||
          content.sourceId !== record.sourceId
        )
          fail("NATIVE_DRAFT_INVALID");
        return { ...result.result, content };
      };
      const saveBody = (action, mapping) =>
        editorialSaveDraftSchema.parse({
          id: action.id,
          expectedRevision: action.expectedRevision,
          idempotencyKey: action.idempotencyKey,
          content: mapping.content,
        });
      const reconcileSave = async (action, record, mapping, draft) => {
        if (
          draft.id !== action.id ||
          draft.revision !== action.expectedRevision + 1 ||
          digest(draft.content) !== record.contentSha256
        )
          return false;
        if (action.status === "CONFIRMED")
          return action.result?.fingerprint === draft.fingerprint;
        const identity = saveReceiptIdentity(
          manifest.target.actorId,
          saveBody(action, mapping),
        );
        const response = await request(
          `/api/editorial-receipts?where[deduplicationKey][equals]=${identity.deduplicationKey}&limit=2&depth=0`,
        );
        if (
          !Array.isArray(response.docs) ||
          response.docs.length !== 1 ||
          response.totalDocs !== 1
        )
          return false;
        const receipt = response.docs[0];
        if (
          receipt.deduplicationKey !== identity.deduplicationKey ||
          receipt.requestFingerprint !== identity.requestFingerprint ||
          receipt.actor !== manifest.target.actorId ||
          receipt.operation !== "save-draft" ||
          receipt.status !== "completed" ||
          receipt.catalog !== action.id ||
          receipt.revision !== draft.revision ||
          receipt.fingerprint !== draft.fingerprint
        )
          return false;
        action.status = "CONFIRMED";
        action.result = {
          id: draft.id,
          revision: draft.revision,
          fingerprint: draft.fingerprint,
        };
        await persist();
        return true;
      };
      let verifiedPrincipal;
      const adapter = {
        kind: "local-http",
        metrics: httpClient.metrics,
        snapshot: httpClient.snapshot,
        async verifyPrincipal() {
          const handshake = await httpClient.handshake();
          if (!handshake.ok) fail(handshake.code);
          const result = await request("/api/users/me");
          verifiedPrincipal = {
            ...manifest.target,
            verified: true,
            actorId: result.user?.id,
            role: result.user?.role,
            scopeCatalogIds: result.user?.scopeCatalogIds ?? [],
          };
          verifyPrincipal(manifest, verifiedPrincipal);
          return clone(verifiedPrincipal);
        },
        async inspectRecord(recordId) {
          const { record, mapping, state } = entry(recordId);
          const draft = await readDraft(mapping, record);
          const main = await request(
            `/api/catalogs/${mapping.nativeId}?depth=0&draft=false`,
          );
          if (
            main.id !== mapping.nativeId ||
            main.catalogId !== record.catalogId ||
            main.sourceId !== record.sourceId ||
            !["draft", "published"].includes(main._status)
          )
            fail("NATIVE_MAIN_INVALID");
          if (main._status === "draft" && journal.publishedObserved[recordId])
            state.protections.withdrawn = true;
          if (main._status === "published")
            journal.publishedObserved[recordId] = true;
          await persist();
          await persistPhase(checkpoint);
          return { draft, main, protections: clone(state.protections) };
        },
        async uploadMedia(recordId, mediaId) {
          const { record, mapping, state } = entry(recordId);
          if (protectedRecord(record, state)) fail("PROTECTED_RECORD");
          const asset = record.media.find((row) => row.mediaId === mediaId),
            mediaMapping = mapping.media.find((row) => row.mediaId === mediaId);
          if (!asset || !mediaMapping) fail("CONTROLLED_INPUT_INVALID");
          await adapter.inspectRecord(recordId);
          if (protectedRecord(record, state)) fail("PROTECTED_RECORD");
          const existing = await readMedia(record, asset, mediaMapping);
          if (existing) {
            const proof = journal.mediaProofs[mediaId];
            if (proof) {
              if (
                digest(proof.media) !== digest(existing) ||
                proof.sourceSha256 !== asset.sourceSha256 ||
                proof.uploadedSha256 !== asset.uploadedSha256 ||
                !SHA.test(proof.evidenceSha256)
              )
                fail("REUSE_ONLY_PROOF_MISSING");
              return { media: existing, reused: true, binaryBodyBytes: 0 };
            }
            if (record.reuseOnly) fail("REUSE_ONLY_PROOF_MISSING");
          }
          if (record.reuseOnly) fail("REUSE_ONLY_PROOF_MISSING");
          const bytes = await imageBytes(input.root, mediaMapping, asset);
          const { body, requestHash } = uploadProofInputs(
            record,
            asset,
            mediaMapping,
          );
          let completeReceipt = null;
          const result = await stageMediaUpload({
            item: {
              requestHash,
              body,
              file: {
                sha256: asset.uploadedSha256,
                size: asset.bytes,
                mimeType: mediaMapping.mimeType,
              },
            },
            bytes,
            transferId: requestHash,
            send: async (...args) => {
              const response = await httpClient.send(...args);
              if (
                args[0] === "/api/editorial/media-upload/complete" &&
                response.ok
              )
                completeReceipt = response.nativeReceipt;
              return response;
            },
            complete,
            uploadMode: options.uploadMode ?? "parallel-chunks-v1",
            signal: options.signal,
            onProgress: options.onTransferProgress,
          });
          if (!result.ok) fail(result.code);
          const media = mediaIdentity(
            record,
            asset,
            mediaMapping,
            result.result,
          );
          const fresh = await readMedia(record, asset, mediaMapping);
          if (!fresh || digest(fresh) !== digest(media))
            fail("NATIVE_MEDIA_IDENTITY_MISMATCH");
          if (
            !completeReceipt ||
            completeReceipt.transportStatus !== "COMPLETE" ||
            completeReceipt.resultSha256 !==
              digest({
                ok: true,
                result: {
                  media,
                  reused: result.reused,
                  validatedBytes: result.validatedBytes,
                  validatedSha256: result.validatedSha256,
                },
              })
          )
            fail("NATIVE_MUTATION_PROOF_MISMATCH");
          journal.mediaProofs[mediaId] = {
            media,
            sourceSha256: asset.sourceSha256,
            uploadedSha256: asset.uploadedSha256,
            audit: {
              version: 1,
              kind: "NATIVE_UPLOAD",
              requestHash,
              validatedBytes: result.validatedBytes,
              validatedSha256: result.validatedSha256,
              reused: result.reused,
              nativeReceipt: completeReceipt,
            },
          };
          journal.mediaProofs[mediaId].evidenceSha256 = registeredProofDigest(
            journal.mediaProofs[mediaId],
          );
          await persist();
          return {
            media,
            reused: result.reused,
            validatedSha256: result.validatedSha256,
          };
        },
        async importRegisteredProof(
          recordId,
          { provenance, evidence, conversion = null },
        ) {
          const { record, mapping, state } = entry(recordId);
          if (protectedRecord(record, state)) fail("PROTECTED_RECORD");
          const asset = record.media.find(
            (item) => item.mediaId === evidence?.mediaId,
          );
          const mediaMapping = mapping.media.find(
            (item) => item.mediaId === evidence?.mediaId,
          );
          if (!asset || !mediaMapping) fail("HISTORICAL_MEDIA_PROOF_MISMATCH");
          await adapter.inspectRecord(recordId);
          if (protectedRecord(record, state)) fail("PROTECTED_RECORD");
          const response = await httpClient.send(
            `/api/media?where[mediaId][equals]=${asset.mediaId}&limit=1&depth=0`,
            "GET",
            undefined,
            options.signal,
          );
          if (!response.ok) fail(response.code);
          const conversionValidation = conversion
            ? await verifyConversion(conversion)
            : null;
          const proof = importRegisteredMediaProof({
            manifest,
            recordId,
            principal: verifiedPrincipal,
            protections: state.protections,
            provenance,
            evidence,
            freshResult: response.result,
            nativeReceipt: response.nativeReceipt,
            scopeSha256,
            conversion,
            conversionValidation,
          });
          mediaIdentity(record, asset, mediaMapping, proof.media);
          journal.mediaProofs[asset.mediaId] = proof;
          await persist();
          return {
            mediaId: asset.mediaId,
            imported: true,
            binaryBodyBytes: 0,
            evidenceSha256: proof.evidenceSha256,
          };
        },
        async saveRegisteredDraft(recordId, options = {}) {
          const { record, mapping, state } = entry(recordId);
          if (protectedRecord(record, state)) fail("PROTECTED_RECORD");
          for (const asset of record.media) {
            const mediaMapping = mapping.media.find(
              (item) => item.mediaId === asset.mediaId,
            );
            const media = await readMedia(record, asset, mediaMapping),
              proof = journal.mediaProofs[asset.mediaId];
            if (!media || !proof || digest(media) !== digest(proof.media))
              fail("REUSE_ONLY_PROOF_MISSING");
          }
          return adapter.saveDraft(recordId, options);
        },
        async saveDraft(
          recordId,
          { expectedBefore = null, idempotencyKey = null } = {},
        ) {
          const { record, mapping, state } = entry(recordId);
          if (!mapping.content || protectedRecord(record, state))
            fail("PROTECTED_OR_UNFROZEN_CONTENT");
          const observed = await adapter.inspectRecord(recordId);
          if (protectedRecord(record, state)) fail("PROTECTED_RECORD");
          for (const asset of record.media) {
            const mediaMapping = mapping.media.find(
              (row) => row.mediaId === asset.mediaId,
            );
            const media = await readMedia(record, asset, mediaMapping);
            const contentMedia = mapping.content.media.find(
              (row) => row.mediaId === asset.mediaId,
            );
            if (
              !media ||
              !contentMedia ||
              contentMedia.objectKey !== media.objectKey ||
              contentMedia.width !== asset.width ||
              contentMedia.height !== asset.height ||
              contentMedia.position !== asset.position ||
              contentMedia.isRepresentative !== asset.isRepresentative
            )
              fail("NATIVE_MEDIA_IDENTITY_MISMATCH");
          }
          const key = `${recordId}-save-draft`,
            existing = journal.actions[key];
          if (existing) {
            if (
              existing.contentSha256 !== record.contentSha256 ||
              existing.id !== mapping.nativeId
            )
              fail("ACTION_BINDING_CHANGED");
            if (await reconcileSave(existing, record, mapping, observed.draft))
              return clone(existing);
            fail("NATIVE_RECONCILIATION_PENDING");
          }
          if (
            expectedBefore &&
            (observed.draft.id !== expectedBefore.id ||
              observed.draft.revision !== expectedBefore.revision ||
              observed.draft.fingerprint !== expectedBefore.fingerprint ||
              digest(observed.draft.content) !== expectedBefore.contentSha256)
          )
            fail("NATIVE_PREFLIGHT_CHANGED");
          if (digest(observed.draft.content) === record.contentSha256)
            return { status: "ALREADY_CURRENT", result: observed.draft };
          const action = {
            id: mapping.nativeId,
            expectedRevision: observed.draft.revision,
            contentSha256: record.contentSha256,
            status: "PENDING",
            idempotencyKey:
              idempotencyKey ??
              `local-${digest({ scopeSha256, recordId, revision: observed.draft.revision, content: record.contentSha256 })}`,
            result: null,
          };
          journal.actions[key] = action;
          await persist();
          const body = saveBody(action, mapping);
          const result = await httpClient.send(
            "/api/editorial/save-draft",
            "POST",
            body,
            options.signal,
          );
          if (!result.ok) {
            action.status = "UNKNOWN";
            await persist();
            return clone(action);
          }
          const fresh = await readDraft(mapping, record);
          if (
            fresh.revision !== action.expectedRevision + 1 ||
            digest(fresh.content) !== record.contentSha256 ||
            fresh.fingerprint !== result.result?.result?.fingerprint
          )
            fail("NATIVE_MUTATION_PROOF_MISMATCH");
          action.status = "CONFIRMED";
          action.result = {
            id: fresh.id,
            revision: fresh.revision,
            fingerprint: fresh.fingerprint,
          };
          await persist();
          return clone(action);
        },
        async requestRelease(recordId, body) {
          const { record, state } = entry(recordId);
          await adapter.inspectRecord(recordId);
          if (protectedRecord(record, state)) fail("PROTECTED_RECORD");
          const result = await httpClient.send(
            "/api/editorial/request-catalog-release",
            "POST",
            body,
            options.signal,
          );
          return result.ok
            ? { state: "UNVERIFIED", code: "REAL_RELEASE_RESULT_NOT_BOUND" }
            : { state: "HOLD", code: result.code };
        },
        async runDraftWorkflow() {
          const inspectForWorkflow = async (record) => {
            const observed = await adapter.inspectRecord(record.recordId);
            const mapping = input.records.find(
              (row) => row.recordId === record.recordId,
            );
            const normalized = (value, status) => {
              const matches = digest(value.content) === record.contentSha256;
              return {
                id: value.id,
                revision: value.revision,
                status,
                catalogId: record.catalogId,
                sourceId: record.sourceId,
                fingerprint: value.fingerprint,
                contentSha256: digest(value.content),
                mediaSha256: matches
                  ? digest(record.media)
                  : digest(value.content.media),
              };
            };
            const proofs = [];
            for (const asset of record.media) {
              const mediaMapping = mapping.media.find(
                (row) => row.mediaId === asset.mediaId,
              );
              const media = await readMedia(record, asset, mediaMapping),
                proof = journal.mediaProofs[asset.mediaId];
              if (!media || !proof || digest(media) !== digest(proof.media))
                break;
              proofs.push(proof.evidenceSha256);
            }
            return {
              draft: normalized(observed.draft, "draft"),
              main: {
                id: observed.main.id,
                revision: observed.main.revision,
                status: observed.main._status,
                catalogId: record.catalogId,
                sourceId: record.sourceId,
                fingerprint: observed.main.fingerprint ?? digest(observed.main),
                contentSha256: digest(observed.main),
                mediaSha256: digest(observed.main.media ?? []),
              },
              protections: observed.protections,
              mediaEvidence:
                proofs.length === record.media.length
                  ? {
                      verified: true,
                      mediaSha256: digest(record.media),
                      evidenceSha256: digest(proofs),
                    }
                  : null,
            };
          };
          const bridge = {
            kind: "local-http",
            boundarySha256: digest(fixture),
            verifyPrincipal: async () => clone(verifiedPrincipal),
            getLatchedProtections: async (record) =>
              clone(checkpoint.records[record.recordId].protections),
            inspectRecord: inspectForWorkflow,
            saveRegisteredDraft: async ({ record, action }) => {
              const saved = await adapter.saveRegisteredDraft(record.recordId, {
                expectedBefore: action.binding.before.draft,
                idempotencyKey: action.operationKey,
              });
              if (
                saved.status !== "CONFIRMED" &&
                saved.status !== "ALREADY_CURRENT"
              )
                fail("NATIVE_RECONCILIATION_PENDING");
              const fresh = await inspectForWorkflow(record);
              return {
                native: fresh.draft,
                mediaEvidence: fresh.mediaEvidence,
              };
            },
            stageDraft: async ({ record, action }) => {
              for (const asset of record.media)
                await adapter.uploadMedia(record.recordId, asset.mediaId);
              const saved = await adapter.saveDraft(record.recordId, {
                expectedBefore: action.binding.before.draft,
                idempotencyKey: action.operationKey,
              });
              if (
                saved.status !== "CONFIRMED" &&
                saved.status !== "ALREADY_CURRENT"
              )
                fail("NATIVE_RECONCILIATION_PENDING");
              const fresh = await inspectForWorkflow(record);
              return {
                native: fresh.draft,
                mediaEvidence: fresh.mediaEvidence,
              };
            },
            reconcileAction: async ({
              record,
              kind,
              action: workflowAction,
            }) => {
              if (kind !== "stage-draft") return { outcome: "unknown" };
              const fresh = await inspectForWorkflow(record);
              const action = journal.actions[`${record.recordId}-save-draft`];
              if (action) {
                const mapping = input.records.find(
                  (row) => row.recordId === record.recordId,
                );
                const draft = await readDraft(mapping, record);
                if (
                  fresh.mediaEvidence &&
                  (await reconcileSave(action, record, mapping, draft))
                )
                  return {
                    outcome: "applied",
                    result: {
                      native: fresh.draft,
                      mediaEvidence: fresh.mediaEvidence,
                    },
                  };
              } else if (
                (!record.reuseOnly || fresh.mediaEvidence) &&
                digest(fresh.draft) ===
                  digest(workflowAction.binding.before.draft)
              )
                return { outcome: "resumable", requestIdentityVerified: true };
              return { outcome: "unknown" };
            },
          };
          return runLocalHTTPDraftWorkflow({
            manifest,
            checkpoint,
            executionKind: "local-http",
            localFixture: fixture,
            createAdapter: async () => bridge,
            deadline: options.deadline,
            signal: options.signal,
            persist: async (snapshot) => {
              Object.assign(checkpoint, clone(snapshot));
              await persistPhase(checkpoint);
            },
          });
        },
      };
      try {
        await adapter.verifyPrincipal();
        return await work(adapter);
      } finally {
        await httpClient.close();
        await writes;
        await persistPhase(checkpoint);
      }
    },
  );
}

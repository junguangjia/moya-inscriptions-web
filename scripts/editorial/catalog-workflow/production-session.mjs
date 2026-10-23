import path from "node:path";
import process from "node:process";
import { Buffer } from "node:buffer";
import { constants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import { createHash } from "node:crypto";
import { privateJSON } from "../../curation/adapter.mjs";
import {
  catalogDeliveryCapabilitiesSchema,
  editorialDraftSchema,
  editorialContentFromDocument,
  editorialSaveDraftSchema,
  MEDIA_UPLOAD_CHUNK_BYTES,
} from "../../../packages/contracts/dist/internal/editorial/index.js";
import { stageMediaUpload } from "../resumable-upload.mjs";
import { digest, fail, verifyPrincipal } from "./identity.mjs";
import {
  normalizeProductionAuthority,
  assertProductionCommand,
} from "./production-authority.mjs";
import { withNativeHTTPSCheckpointStore } from "./checkpoint-store.mjs";
import { openProductionTransportJournal } from "./payload-isolated-session.mjs";
import {
  createProductionNativeHTTP,
  definitivelyRejected,
} from "./local-native-http.mjs";
import {
  createCatalogDeliveryClient,
  openCatalogDeliveryJournal,
  frozenCatalogDeliveryBinding,
} from "./catalog-delivery-journal.mjs";
import {
  validateControlledInput,
  mediaIdentity,
  imageBytes,
  uploadProofInputs,
  saveReceiptIdentity,
} from "./local-native-adapter.mjs";
import {
  verifyHistoricalConversion,
  historicalConverterIdentity,
} from "./historical-proof-converter.mjs";
import {
  importRegisteredMediaProof,
  validateRegisteredMediaProof,
  registeredProofDigest,
  nativeCatalogMetadataProjection,
} from "./registered-media-proof.mjs";

const clone = (x) => JSON.parse(JSON.stringify(x));
const bytesHash = (x) => createHash("sha256").update(x).digest("hex");
const CAPABILITIES_ROUTE = "/api/editorial/catalog-delivery-capabilities";
const TERMINAL_INTENT_CODES = Object.freeze({
  cancelled: "DELIVERY_INTENT_CANCELLED",
  superseded: "DELIVERY_INTENT_SUPERSEDED",
  expired: "DELIVERY_INTENT_EXPIRED",
  withdrawn: "DELIVERY_INTENT_WITHDRAWN",
});
const positive = (x) => Number.isSafeInteger(x) && x > 0;
const hash = (x) => typeof x === "string" && /^[a-f0-9]{64}$/.test(x);
async function maybe(file) {
  try {
    return await privateJSON(file, 32 * 1024 * 1024);
  } catch (e) {
    if (e.code === "ENOENT") return null;
    throw e;
  }
}

/** One explicitly selected existing Native record. No generic create or implicit batch expansion. */
export async function withProductionCatalogSession(options, work) {
  const { manifest, command } = options;
  const binding = normalizeProductionAuthority(manifest, options.authority);
  assertProductionCommand(binding, command, manifest);
  const controlled = validateControlledInput(
    manifest,
    options.input.controlled,
  );
  const record = manifest.records[0],
    mapping = controlled.records[0];
  if (mapping.nativeId !== binding.nativeId || !mapping.content)
    fail("PRODUCTION_INPUT_INVALID");
  const before = options.input.expectedNative;
  if (
    !before ||
    Object.keys(before).sort().join() !==
      "contentSha256,fingerprint,id,revision" ||
    before.id !== binding.nativeId ||
    !positive(before.revision) ||
    !hash(before.fingerprint) ||
    !hash(before.contentSha256)
  )
    fail("PRODUCTION_INPUT_INVALID");
  const inputSha256 = digest(options.input);
  if (inputSha256 !== binding.inputSha256) fail("PRODUCTION_INPUT_CHANGED");
  return withNativeHTTPSCheckpointStore(
    options.directory,
    manifest,
    async ({
      inputMatches,
      assertOwned,
      persistCompanion,
      checkpoint,
      persist: persistCheckpoint,
    }) => {
      if (!inputMatches) fail("CHECKPOINT_INPUT_CHANGED");
      const journalFile = "production-native-journal.json",
        stateFile = "production-state.json";
      const limits = options.limits;
      const journal = openProductionTransportJournal({
        manifest,
        binding,
        limits,
        responseByteLimit: options.responseByteLimit,
        saved: await maybe(path.join(options.directory, journalFile)),
      });
      if (mapping.baselineStatus === "published")
        journal.publishedObserved = true;
      let state = await maybe(path.join(options.directory, stateFile));
      const expectedState = {
        version: 1,
        executionKind: "native-https",
        scopeSha256: journal.scopeSha256,
        inputSha256,
        proofs: {},
        save: null,
        withdraw: null,
        frozen: null,
      };
      if (
        state &&
        (Object.keys(state).sort().join() !==
          Object.keys(expectedState).sort().join() ||
          state.version !== 1 ||
          state.executionKind !== "native-https" ||
          state.scopeSha256 !== journal.scopeSha256 ||
          state.inputSha256 !== inputSha256 ||
          !state.proofs ||
          typeof state.proofs !== "object")
      )
        fail("PRODUCTION_STATE_CHANGED");
      state ??= expectedState;
      let writes = Promise.resolve(),
        delivery,
        deliveryJournal;
      const persist = (name, value) => {
        const snapshot = clone(value);
        writes = writes.then(async () => {
          await assertOwned();
          await persistCompanion(name, snapshot);
        });
        return writes;
      };
      const saveState = () => persist(stateFile, state);
      if (state.save) {
        const body = editorialSaveDraftSchema.parse(
          JSON.parse(state.save.bodyText),
        );
        const expectedKey = `production-${digest({ scope: journal.scopeSha256, action: "save", before, content: record.contentSha256 })}`;
        if (
          !["PENDING", "UNKNOWN", "CONFIRMED"].includes(state.save.status) ||
          JSON.stringify(body) !== state.save.bodyText ||
          body.id !== binding.nativeId ||
          body.expectedRevision !== before.revision ||
          body.idempotencyKey !== expectedKey ||
          digest(body.content) !== record.contentSha256
        )
          fail("PRODUCTION_SAVE_ACTION_CHANGED");
        const result = state.save.result;
        if (
          state.save.status === "CONFIRMED"
            ? !result ||
              Object.keys(result).sort().join() !==
                "contentSha256,fingerprint,id,revision" ||
              result.id !== body.id ||
              result.revision !== body.expectedRevision + 1 ||
              !hash(result.fingerprint) ||
              result.contentSha256 !== record.contentSha256
            : result !== null
        )
          fail("PRODUCTION_SAVE_ACTION_CHANGED");
      }
      if (
        state.withdraw &&
        (!["PENDING", "UNKNOWN", "CONFIRMED"].includes(state.withdraw.status) ||
          digest(state.withdraw.before) !== digest(before) ||
          state.withdraw.bodyText !==
            JSON.stringify({ revision: before.revision, _status: "draft" }))
      )
        fail("PRODUCTION_WITHDRAW_ACTION_CHANGED");
      const assertActive = async () => {
        await assertOwned();
        await options.assertBindingActive();
        if (
          digest(normalizeProductionAuthority(manifest, options.authority)) !==
          digest(binding)
        )
          fail("PRODUCTION_AUTHORITY_CHANGED");
      };
      const rowReceipt = (receipt, route, method, body, resultSha256) => {
        const rows = journal.requests.filter(
            (r) => r.requestSha256 === receipt?.requestSha256,
          ),
          row = rows[0];
        if (
          rows.length !== 1 ||
          row.status !== "COMPLETE" ||
          !row.drained ||
          row.httpStatus !== 200 ||
          row.route !== route ||
          row.method !== method ||
          digest(row.receipt) !== digest(receipt) ||
          receipt.resultSha256 !== resultSha256 ||
          (body !== undefined &&
            row.logicalKey !==
              digest({
                scope: journal.scopeSha256,
                route,
                method,
                bodySha256: bytesHash(
                  typeof body === "string" ? body : JSON.stringify(body),
                ),
              }))
        )
          fail("PRODUCTION_RECEIPT_MISMATCH");
      };
      // A Native write may be sent again only when the transport journal shows
      // that none of its attempts can have been applied: none was recorded, or
      // Native answered each one with a refusal.
      const unapplied = (route, method, bodyText) => {
        const logicalKey = digest({
          scope: journal.scopeSha256,
          route,
          method,
          bodySha256: bytesHash(bodyText),
        });
        return journal.requests
          .filter((row) => row.logicalKey === logicalKey)
          .every(definitivelyRejected);
      };
      const conversionCache = new Map();
      const verifyConversion = async (reference) => {
        const key = digest({
          converter: reference.converter,
          sourceSpec: reference.sourceSpec,
          bundleSha256: reference.bundleSha256,
        });
        if (!conversionCache.has(key))
          conversionCache.set(
            key,
            (await verifyHistoricalConversion(reference)).bundle,
          );
        const bundle = conversionCache.get(key),
          entry = bundle.entries.find((e) => e.entryId === reference.entryId);
        if (!entry || entry.entrySha256 !== reference.entrySha256)
          fail("HISTORICAL_CONVERSION_CHANGED");
        const historical = bundle.records.find(
          (r) => r.recordId === record.recordId,
        );
        if (
          !historical ||
          historical.catalogId !== record.catalogId ||
          historical.sourceId !== record.sourceId ||
          historical.uploadedDraft?.id !== binding.nativeId ||
          historical.latestKnownNative?.id !== binding.nativeId
        )
          fail("HISTORICAL_CATALOG_ID_CHANGED");
        return { bundle, entry };
      };
      const verifySourceFiles = async () => {
        if (!conversionCache.size) return;
        const converter = await historicalConverterIdentity();
        for (const bundle of conversionCache.values()) {
          if (digest(converter) !== digest(bundle.converter))
            fail("HISTORICAL_CONVERSION_CHANGED");
          for (const file of bundle.sourceSpec.files) {
            if ((await realpath(file.path)) !== file.path)
              fail("HISTORICAL_SOURCE_CHANGED");
            const handle = await open(
              file.path,
              constants.O_RDONLY | constants.O_NOFOLLOW,
            );
            try {
              const stat = await handle.stat();
              if (
                !stat.isFile() ||
                stat.uid !== process.getuid() ||
                stat.size !== file.bytes ||
                file.bytes > 2097152
              )
                fail("HISTORICAL_SOURCE_CHANGED");
              const bytes = Buffer.alloc(file.bytes + 1);
              let offset = 0;
              while (offset < bytes.length) {
                const { bytesRead } = await handle.read(
                  bytes,
                  offset,
                  bytes.length - offset,
                  offset,
                );
                if (!bytesRead) break;
                offset += bytesRead;
              }
              if (
                offset !== file.bytes ||
                bytesHash(bytes.subarray(0, offset)) !== file.sha256
              )
                fail("HISTORICAL_SOURCE_CHANGED");
            } finally {
              await handle.close();
            }
          }
        }
      };
      if (state.withdraw?.nativeReceipt)
        rowReceipt(
          state.withdraw.nativeReceipt,
          `/api/catalogs/${binding.nativeId}?draft=false&depth=0`,
          "PATCH",
          state.withdraw.bodyText,
          state.withdraw.nativeReceipt.resultSha256,
        );
      for (const [mediaId, proof] of Object.entries(state.proofs)) {
        const asset = record.media.find((a) => a.mediaId === mediaId),
          mediaMapping = mapping.media.find((a) => a.mediaId === mediaId);
        if (
          !asset ||
          !mediaMapping ||
          proof.sourceSha256 !== asset.sourceSha256 ||
          proof.uploadedSha256 !== asset.uploadedSha256 ||
          proof.evidenceSha256 !== registeredProofDigest(proof)
        )
          fail("PRODUCTION_MEDIA_PROOF_INVALID");
        mediaIdentity(record, asset, mediaMapping, proof.media);
        if (
          proof.audit?.kind ===
          "HISTORICAL_FULL_BYTE_PROOF_WITH_CURRENT_NATIVE_METADATA"
        ) {
          await validateRegisteredMediaProof({
            proof,
            manifest,
            recordId: record.recordId,
            scopeSha256: journal.scopeSha256,
            requests: journal.requests,
            verifyConversion,
          });
          const verified = await verifyConversion(proof.audit.conversion);
          if (
            verified.entry.objectKey !== null &&
            verified.entry.objectKey !== proof.media.objectKey
          )
            fail("OBJECT_KEY_UNOBSERVED");
        } else if (proof.audit?.kind === "NATIVE_UPLOAD") {
          const { requestHash } = uploadProofInputs(
              record,
              asset,
              mediaMapping,
            ),
            audit = proof.audit;
          if (
            audit.requestHash !== requestHash ||
            audit.validatedBytes !== asset.bytes ||
            audit.validatedSha256 !== asset.uploadedSha256 ||
            typeof audit.reused !== "boolean"
          )
            fail("PRODUCTION_MEDIA_PROOF_INVALID");
          rowReceipt(
            audit.nativeReceipt,
            "/api/editorial/media-upload/complete",
            "POST",
            undefined,
            digest({
              ok: true,
              result: {
                media: proof.media,
                reused: audit.reused,
                validatedBytes: audit.validatedBytes,
                validatedSha256: audit.validatedSha256,
              },
            }),
          );
        } else fail("PRODUCTION_MEDIA_PROOF_INVALID");
      }
      const uploads = new Set();
      const intentInScope = (id) =>
        typeof id === "string" &&
        Object.values(deliveryJournal?.actions ?? {}).some(
          (a) => a.result?.intentId === id,
        );
      const assertRoute = (route, method, body) => {
        if (
          method === "GET" &&
          route === `/api/catalogs/${binding.nativeId}?depth=0&draft=false`
        )
          return;
        if (
          method === "GET" &&
          record.media.some(
            (a) =>
              route ===
              `/api/media?where[mediaId][equals]=${a.mediaId}&limit=1&depth=0`,
          )
        )
          return;
        if (
          method === "POST" &&
          route === "/api/editorial/read-draft" &&
          body?.id === binding.nativeId &&
          Object.keys(body).length === 1
        )
          return;
        if (
          method === "POST" &&
          route === CAPABILITIES_ROUTE &&
          ["upload", "run", "publish"].includes(command) &&
          JSON.stringify(body) === "{}"
        )
          return;
        if (
          method === "GET" &&
          state.save &&
          route ===
            `/api/editorial-receipts?where[deduplicationKey][equals]=${saveReceiptIdentity(binding.actorId, JSON.parse(state.save.bodyText)).deduplicationKey}&limit=2&depth=0`
        )
          return;
        if (
          method === "POST" &&
          command === "run" &&
          route === "/api/editorial/save-draft" &&
          state.save?.bodyText === JSON.stringify(body)
        )
          return;
        if (
          method === "PATCH" &&
          command === "withdraw" &&
          binding.role === "owner" &&
          route === `/api/catalogs/${binding.nativeId}?draft=false&depth=0` &&
          state.withdraw?.bodyText === JSON.stringify(body)
        )
          return;
        if (method === "POST" && ["run", "publish"].includes(command)) {
          if (
            route === "/api/editorial/prepare-catalog-delivery" &&
            body?.id === binding.nativeId
          )
            return;
          if (
            /^\/api\/editorial\/(read-catalog-delivery|request-catalog-release|release-catalog-delivery|cancel-catalog-delivery)$/.test(
              route,
            ) &&
            intentInScope(body?.intentId)
          )
            return;
        }
        if (
          method === "POST" &&
          ["upload", "run"].includes(command) &&
          !record.reuseOnly
        ) {
          if (
            route === "/api/editorial/media-upload/start" &&
            body?.catalogId === record.catalogId &&
            record.media.some(
              (a) =>
                a.mediaId === body.mediaId &&
                a.uploadedSha256 === body.sha256 &&
                a.bytes === body.bytes,
            )
          )
            return;
          if (
            [
              "/api/editorial/media-upload/status",
              "/api/editorial/media-upload/complete",
            ].includes(route) &&
            uploads.has(body?.uploadId)
          )
            return;
          const match =
            /^\/api\/editorial\/media-upload\/(?:chunk|stream)\/([a-f0-9]{64})\/(0|[1-9]\d*)$/.exec(
              route,
            );
          if (match && uploads.has(match[1])) return;
        }
        fail("PRODUCTION_ROUTE_NOT_AUTHORIZED");
      };
      await persist(journalFile, journal);
      await saveState();
      const transport = createProductionNativeHTTP({
        ...options,
        manifest,
        binding,
        command,
        journal,
        assertAdmission: assertOwned,
        assertBindingActive: assertActive,
        assertRoute,
        beforeRequest: async ({ route, method }) => {
          if (
            method === "PATCH" ||
            (method === "POST" &&
              ![
                "/api/editorial/read-draft",
                "/api/editorial/read-catalog-delivery",
                "/api/editorial/media-upload/status",
                CAPABILITIES_ROUTE,
              ].includes(route))
          )
            await verifySourceFiles();
        },
        persist: () => persist(journalFile, journal),
      });
      let principal, currentCatalog;
      const request = async (route, method = "GET", body, signal, headers) => {
        const response = await transport.send(
          route,
          method,
          body,
          signal ?? options.signal,
          headers,
        );
        if (
          route === "/api/editorial/media-upload/start" &&
          response.ok &&
          hash(response.result?.result?.uploadId)
        )
          uploads.add(response.result.result.uploadId);
        return response;
      };
      const get = async (...args) => {
        const result = await request(...args);
        if (!result.ok) fail(result.code);
        return result.result;
      };
      // Asked once, before this command's first write (upload, draft save or
      // delivery intent): an Admin without the endpoints the command uses, or
      // a publication whose Backend cannot pin a recipe and prove readiness,
      // stops here with nothing written.
      const needsDelivery =
        command === "publish" ||
        (command === "run" && record.disposition === "publish");
      const needsUpload =
        ["upload", "run"].includes(command) && !record.reuseOnly;
      let capabilities = null;
      const preflight = async () => {
        if ((!needsDelivery && !needsUpload) || capabilities) return;
        const response = await request(CAPABILITIES_ROUTE, "POST", {});
        if (!response.ok)
          fail(
            response.httpStatus === 404
              ? "ADMIN_CAPABILITY_MISSING"
              : response.code,
          );
        const parsed = catalogDeliveryCapabilitiesSchema.safeParse(
          response.result?.result,
        );
        if (response.result?.ok !== true || !parsed.success)
          fail("ADMIN_CAPABILITY_INVALID");
        if (needsDelivery && parsed.data.delivery !== "AVAILABLE")
          fail(
            parsed.data.delivery === "NOT_CONFIGURED"
              ? "BACKEND_DELIVERY_NOT_CONFIGURED"
              : "BACKEND_DELIVERY_UNAVAILABLE",
          );
        capabilities = parsed.data;
      };
      const protect = () => {
        if (
          record.disposition === "hold" ||
          Object.values(record.protections).some(Boolean) ||
          Object.values(checkpoint.records[record.recordId].protections).some(
            Boolean,
          ) ||
          journal.withdrawnObserved
        )
          fail("PROTECTED_RECORD");
      };
      const inspect = async () => {
        const response = await request("/api/editorial/read-draft", "POST", {
          id: binding.nativeId,
        });
        if (!response.ok) fail(response.code);
        const result = response.result;
        currentCatalog = {
          projection: nativeCatalogMetadataProjection(result),
          nativeReceipt: response.nativeReceipt,
        };
        const raw = await get(
          `/api/catalogs/${binding.nativeId}?depth=0&draft=false`,
        );
        const draft = {
          id: result.result?.id,
          revision: result.result?.revision,
          fingerprint: result.result?.fingerprint,
          content: editorialDraftSchema.parse(result.result?.content),
        };
        const main = {
          id: raw.id,
          revision: raw.revision,
          status: raw._status,
          content: editorialDraftSchema.parse(
            editorialContentFromDocument(raw),
          ),
        };
        if (
          result.ok !== true ||
          draft.id !== binding.nativeId ||
          main.id !== draft.id ||
          !positive(draft.revision) ||
          !positive(main.revision) ||
          !hash(draft.fingerprint) ||
          !["draft", "published"].includes(main.status) ||
          [draft.content, main.content].some(
            (c) =>
              c.catalogId !== record.catalogId ||
              c.sourceId !== record.sourceId,
          )
        )
          fail("PRODUCTION_NATIVE_IDENTITY_CHANGED");
        if (main.status === "draft" && journal.publishedObserved)
          journal.withdrawnObserved = true;
        if (main.status === "published") journal.publishedObserved = true;
        if (journal.withdrawnObserved)
          checkpoint.records[record.recordId].protections.withdrawn = true;
        await persist(journalFile, journal);
        await persistCheckpoint(checkpoint);
        return {
          draft,
          main,
          protections: {
            ...checkpoint.records[record.recordId].protections,
            withdrawn:
              journal.withdrawnObserved ||
              checkpoint.records[record.recordId].protections.withdrawn,
          },
        };
      };
      const mediaRead = async (asset) => {
        const route = `/api/media?where[mediaId][equals]=${asset.mediaId}&limit=1&depth=0`;
        const response = await request(route);
        if (!response.ok) fail(response.code);
        const value = response.result;
        if (
          !Array.isArray(value.docs) ||
          value.docs.length > 1 ||
          value.totalDocs !== value.docs.length
        )
          fail("NATIVE_MEDIA_IDENTITY_MISMATCH");
        return {
          response,
          media: value.docs.length
            ? mediaIdentity(
                record,
                asset,
                mapping.media.find((m) => m.mediaId === asset.mediaId),
                value.docs[0],
              )
            : null,
        };
      };
      const ensureMedia = async () => {
        const initial = await inspect();
        protect();
        if (
          !state.save &&
          !state.frozen &&
          digest(baseline(initial.draft)) !==
            digest(options.input.expectedNative)
        )
          fail("NATIVE_PREFLIGHT_CHANGED");
        for (const asset of record.media) {
          await assertActive();
          const current = record.reuseOnly ? initial : await inspect();
          protect();
          if (
            !state.save &&
            !state.frozen &&
            digest(baseline(current.draft)) !==
              digest(options.input.expectedNative)
          )
            fail("NATIVE_PREFLIGHT_CHANGED");
          const mediaMapping = mapping.media.find(
            (m) => m.mediaId === asset.mediaId,
          );
          const { response, media } = await mediaRead(asset),
            old = state.proofs[asset.mediaId];
          if (old && media && digest(old.media) === digest(media)) continue;
          if (old) fail("PRODUCTION_MEDIA_PROOF_CHANGED");
          if (state.save || state.frozen) fail("REUSE_ONLY_PROOF_MISSING");
          const conversion = options.input.conversions?.find(
            (c) => c.mediaId === asset.mediaId,
          )?.reference;
          if (conversion) {
            const verified = await verifyConversion(conversion);
            const proof = importRegisteredMediaProof({
              manifest,
              recordId: record.recordId,
              principal,
              protections: checkpoint.records[record.recordId].protections,
              provenance: verified.bundle.provenance,
              evidence: verified.entry.evidence,
              freshResult: response.result,
              nativeReceipt: response.nativeReceipt,
              scopeSha256: journal.scopeSha256,
              conversion,
              conversionValidation: verified,
              currentCatalog,
            });
            if (
              verified.entry.objectKey !== null &&
              proof.media.objectKey !== verified.entry.objectKey
            )
              fail("HISTORICAL_CONVERSION_CHANGED");
            state.proofs[asset.mediaId] = proof;
            await saveState();
            continue;
          }
          if (record.reuseOnly) fail("REUSE_ONLY_PROOF_MISSING");
          await preflight();
          const bytes = await imageBytes(controlled.root, mediaMapping, asset),
            { body, requestHash } = uploadProofInputs(
              record,
              asset,
              mediaMapping,
            );
          let receipt;
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
              const r = await request(...args);
              if (args[0] === "/api/editorial/media-upload/complete" && r.ok)
                receipt = r.nativeReceipt;
              return r;
            },
            uploadMode: "parallel-chunks-v1",
            signal: options.signal,
          });
          if (!result.ok) fail(result.code);
          const uploaded = mediaIdentity(
              record,
              asset,
              mediaMapping,
              result.result,
            ),
            fresh = await mediaRead(asset);
          if (
            !fresh.media ||
            digest(fresh.media) !== digest(uploaded) ||
            result.validatedBytes !== asset.bytes ||
            result.validatedSha256 !== asset.uploadedSha256
          )
            fail("NATIVE_MUTATION_PROOF_MISMATCH");
          rowReceipt(
            receipt,
            "/api/editorial/media-upload/complete",
            "POST",
            undefined,
            digest({
              ok: true,
              result: {
                media: uploaded,
                reused: result.reused,
                validatedBytes: result.validatedBytes,
                validatedSha256: result.validatedSha256,
              },
            }),
          );
          const proof = {
            media: uploaded,
            sourceSha256: asset.sourceSha256,
            uploadedSha256: asset.uploadedSha256,
            audit: {
              version: 1,
              kind: "NATIVE_UPLOAD",
              requestHash,
              validatedBytes: result.validatedBytes,
              validatedSha256: result.validatedSha256,
              reused: result.reused,
              nativeReceipt: receipt,
            },
          };
          state.proofs[asset.mediaId] = {
            ...proof,
            evidenceSha256: registeredProofDigest(proof),
          };
          await saveState();
        }
      };
      const baseline = (draft) => ({
        id: draft.id,
        revision: draft.revision,
        fingerprint: draft.fingerprint,
        contentSha256: digest(draft.content),
      });
      const reconcileSavedDraft = async (d) => {
        const body = JSON.parse(state.save.bodyText);
        if (
          d.id !== body.id ||
          d.revision !== body.expectedRevision + 1 ||
          digest(d.content) !== record.contentSha256
        )
          fail("NATIVE_RECONCILIATION_PENDING");
        const identity = saveReceiptIdentity(binding.actorId, body);
        const r = await get(
            `/api/editorial-receipts?where[deduplicationKey][equals]=${identity.deduplicationKey}&limit=2&depth=0`,
          ),
          receipt = r.docs?.[0];
        if (
          r.totalDocs !== 1 ||
          r.docs.length !== 1 ||
          receipt.actor !== binding.actorId ||
          receipt.operation !== "save-draft" ||
          receipt.status !== "completed" ||
          receipt.catalog !== body.id ||
          receipt.revision !== d.revision ||
          receipt.fingerprint !== d.fingerprint ||
          receipt.deduplicationKey !== identity.deduplicationKey ||
          receipt.requestFingerprint !== identity.requestFingerprint
        )
          fail("NATIVE_RECONCILIATION_PENDING");
        state.save.status = "CONFIRMED";
        state.save.result = baseline(d);
        await saveState();
        return d;
      };
      const saveDraft = async () => {
        await verifySourceFiles();
        const current = await inspect();
        protect();
        for (const asset of record.media) {
          const fresh = await mediaRead(asset),
            proof = state.proofs[asset.mediaId];
          if (
            !proof ||
            !fresh.media ||
            digest(proof.media) !== digest(fresh.media)
          )
            fail("REUSE_ONLY_PROOF_MISSING");
        }
        if (
          state.save &&
          state.save.status !== "CONFIRMED" &&
          digest(baseline(current.draft)) ===
            digest(options.input.expectedNative) &&
          unapplied("/api/editorial/save-draft", "POST", state.save.bodyText)
        ) {
          // Rejected or never sent, and Native is unchanged: send it again.
          state.save = null;
          await saveState();
        }
        if (state.save) return reconcileSavedDraft(current.draft);
        if (
          digest(baseline(current.draft)) !==
          digest(options.input.expectedNative)
        )
          fail("NATIVE_PREFLIGHT_CHANGED");
        if (digest(current.draft.content) === record.contentSha256)
          return current.draft;
        await preflight();
        const body = editorialSaveDraftSchema.parse({
          id: binding.nativeId,
          expectedRevision: current.draft.revision,
          idempotencyKey: `production-${digest({ scope: journal.scopeSha256, action: "save", before: baseline(current.draft), content: record.contentSha256 })}`,
          content: mapping.content,
        });
        state.save = {
          bodyText: JSON.stringify(body),
          status: "PENDING",
          result: null,
        };
        await saveState();
        const response = await request(
          "/api/editorial/save-draft",
          "POST",
          body,
        );
        if (
          !response.ok &&
          unapplied("/api/editorial/save-draft", "POST", state.save.bodyText)
        ) {
          state.save = null;
          await saveState();
          fail(response.code);
        }
        state.save.status = "UNKNOWN";
        await saveState();
        if (!response.ok) fail("NATIVE_RECONCILIATION_PENDING");
        rowReceipt(
          response.nativeReceipt,
          "/api/editorial/save-draft",
          "POST",
          state.save.bodyText,
          digest(response.result),
        );
        return saveDraft();
      };
      const publish = async () => {
        if (record.disposition !== "publish") fail("DRAFT_ONLY");
        await verifySourceFiles();
        const current = await inspect();
        protect();
        if (!state.frozen && state.save)
          await reconcileSavedDraft(current.draft);
        if (
          !state.frozen &&
          digest(baseline(current.draft)) !==
            digest(
              state.save?.status === "CONFIRMED"
                ? state.save.result
                : options.input.expectedNative,
            )
        )
          fail("NATIVE_PREFLIGHT_CHANGED");
        if (digest(current.draft.content) !== record.contentSha256)
          fail("DELIVERY_FROZEN_B_MISMATCH");
        for (const asset of record.media) {
          const fresh = await mediaRead(asset),
            proof = state.proofs[asset.mediaId];
          if (
            !proof ||
            !fresh.media ||
            digest(proof.media) !== digest(fresh.media)
          )
            fail("REUSE_ONLY_PROOF_MISSING");
        }
        const computed = frozenCatalogDeliveryBinding(
          record,
          state.frozen
            ? {
                ...current.draft,
                revision: state.frozen.revision,
                fingerprint: state.frozen.fingerprint,
              }
            : current.draft,
          Object.values(state.proofs),
        );
        if (state.frozen && digest(computed) !== digest(state.frozen))
          fail("DELIVERY_FROZEN_B_MISMATCH");
        if (!state.frozen) {
          state.frozen = computed;
          await saveState();
        }
        const frozen = [state.frozen];
        deliveryJournal = openCatalogDeliveryJournal({
          manifest,
          binding,
          frozen,
          saved: await maybe(
            path.join(options.directory, "catalog-delivery-journal.json"),
          ),
        });
        for (const action of Object.values(deliveryJournal.actions))
          for (const attempt of action.attempts)
            if (attempt.status === "CONFIRMED")
              rowReceipt(
                attempt.nativeReceipt,
                action.route,
                "POST",
                action.bodyText,
                attempt.resultSha256,
              );
        const persistDelivery = async (snapshot) => {
          deliveryJournal = clone(snapshot);
          await persist("catalog-delivery-journal.json", snapshot);
        };
        delivery = createCatalogDeliveryClient({
          manifest,
          binding,
          frozen,
          journal: deliveryJournal,
          persist: persistDelivery,
          assertAdmission: assertActive,
          send: request,
          inspectRecord: inspect,
          verifyAccount: async () => {
            principal = await transport.verifyPrincipal();
            return principal;
          },
          validateTransportReceipt: async (receipt, r) => {
            const row = journal.requests.find(
              (a) => a.requestSha256 === receipt?.requestSha256,
            );
            if (
              !row ||
              row.logicalKey !==
                digest({
                  scope: journal.scopeSha256,
                  route: r.route,
                  method: r.method,
                  bodySha256: r.bodySha256,
                })
            )
              fail("PRODUCTION_RECEIPT_MISMATCH");
            rowReceipt(receipt, r.route, r.method, undefined, r.resultSha256);
          },
          deadline: options.deadline,
          signal: options.signal,
        });
        const action = async (operation, input) => {
          const prior =
            delivery.snapshot().actions[`${record.recordId}:${operation}`];
          if (prior) {
            input = JSON.parse(prior.bodyText);
            delete input.idempotencyKey;
          }
          const result = await delivery.execute(
            record.recordId,
            operation,
            input,
          );
          // An ended intent never becomes ready again, and this state
          // directory cannot open another one: report the end, not a wait.
          if (Object.hasOwn(TERMINAL_INTENT_CODES, result.result?.state ?? ""))
            fail(TERMINAL_INTENT_CODES[result.result.state]);
          if (
            result.status === "UNKNOWN" ||
            result.status === "HOLD" ||
            !result.result
          )
            fail("DELIVERY_RECONCILIATION_PENDING");
          if (
            result.result.state === "released" &&
            result.nativePublicationVerified !== true &&
            operation !== "read"
          )
            fail("NATIVE_PUBLICATION_UNVERIFIED");
          return result;
        };
        await preflight();
        let result = await action("prepare", {
          id: binding.nativeId,
          expectedRevision: state.frozen.revision,
          expectedFingerprint: state.frozen.fingerprint,
        });
        result = await action("read", { intentId: result.result.intentId });
        if (result.result.state === "prepared")
          result = await action("request", {
            intentId: result.result.intentId,
            expectedStateVersion: result.result.stateVersion,
            expectedManifestSha256: state.frozen.manifestSha256,
          });
        if (result.result.state === "released")
          return action("release", { intentId: result.result.intentId });
        result = await action("read", { intentId: result.result.intentId });
        if (
          result.result.readiness !== "READY" ||
          !result.result.publicCopyAuthorized
        )
          return {
            status: "WAITING_FOR_READY",
            result: result.result,
            anonymousDeliveryVerified: false,
          };
        return action("release", {
          intentId: result.result.intentId,
          expectedStateVersion: result.result.stateVersion,
          expectedRevision: state.frozen.revision,
          expectedFingerprint: state.frozen.fingerprint,
        });
      };
      const withdraw = async () => {
        const current = await inspect();
        if (binding.role !== "owner") fail("OWNER_AUTHORITY_REQUIRED");
        const d = current.draft,
          main = current.main,
          route = `/api/catalogs/${binding.nativeId}?draft=false&depth=0`;
        if (
          state.withdraw &&
          !state.withdraw.nativeReceipt &&
          main.status === "published" &&
          main.revision === state.withdraw.before.revision &&
          digest(baseline(d)) === digest(state.withdraw.before) &&
          digest(main.content) === state.withdraw.before.contentSha256 &&
          unapplied(route, "PATCH", state.withdraw.bodyText)
        ) {
          // Rejected or never sent, and still published: send it again.
          state.withdraw = null;
          await saveState();
        }
        if (state.withdraw) {
          const old = state.withdraw.before;
          if (
            main.status !== "draft" ||
            main.revision !== old.revision + 1 ||
            d.revision !== main.revision ||
            digest(d.content) !== old.contentSha256 ||
            digest(main.content) !== old.contentSha256 ||
            !hash(d.fingerprint)
          )
            fail("WITHDRAWAL_RECONCILIATION_PENDING");
          state.withdraw.status = state.withdraw.nativeReceipt
            ? "CONFIRMED"
            : "UNKNOWN";
          state.withdraw.result = { ...baseline(d), status: main.status };
          journal.withdrawnObserved = true;
          checkpoint.records[record.recordId].protections.withdrawn = true;
          await saveState();
          await persist(journalFile, journal);
          await persistCheckpoint(checkpoint);
          return {
            status: state.withdraw.nativeReceipt
              ? "NATIVE_WITHDRAWAL_CONFIRMED"
              : "NATIVE_DRAFT_OBSERVED_ACTION_UNKNOWN",
            native: state.withdraw.result,
            anonymousWithdrawalVerified: false,
          };
        }
        if (
          main.status !== "published" ||
          d.revision !== main.revision ||
          digest(d.content) !== record.contentSha256 ||
          digest(main.content) !== record.contentSha256 ||
          digest(baseline(d)) !== digest(options.input.expectedNative)
        )
          fail("WITHDRAWAL_PREFLIGHT_CHANGED");
        state.withdraw = {
          status: "PENDING",
          before: baseline(d),
          bodyText: JSON.stringify({
            revision: main.revision,
            _status: "draft",
          }),
          result: null,
          nativeReceipt: null,
        };
        await saveState();
        const response = await request(
          route,
          "PATCH",
          JSON.parse(state.withdraw.bodyText),
        );
        if (
          !response.ok &&
          unapplied(route, "PATCH", state.withdraw.bodyText)
        ) {
          state.withdraw = null;
          await saveState();
          fail(response.code);
        }
        state.withdraw.status = "UNKNOWN";
        await saveState();
        if (!response.ok) fail("WITHDRAWAL_RECONCILIATION_PENDING");
        rowReceipt(
          response.nativeReceipt,
          route,
          "PATCH",
          state.withdraw.bodyText,
          digest(response.result),
        );
        state.withdraw.nativeReceipt = response.nativeReceipt;
        await saveState();
        return withdraw();
      };
      try {
        principal = await transport.verifyPrincipal();
        verifyPrincipal(manifest, principal);
        return await work({
          ensureMedia,
          saveDraft,
          publish,
          withdraw,
          inspect,
          metrics: transport.metrics,
          snapshot: () => clone(state),
          principal,
        });
      } finally {
        await delivery?.close();
        await transport.close();
        await writes;
      }
    },
  );
}

export const productionLimits = (authority) => ({
  maxRequests: authority.caps.requests,
  maxUploadBytes: authority.caps.acceptedRequestBodyTotal,
  maxDownloadBytes: authority.caps.responseBodyTotal,
  maxAttempts: 2,
  concurrency: 4,
  chunkBytes: MEDIA_UPLOAD_CHUNK_BYTES,
});

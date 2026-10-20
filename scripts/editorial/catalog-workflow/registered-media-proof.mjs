import { createHash } from "node:crypto";
import {
  editorialDraftSchema,
  editorialUploadedMediaSchema,
} from "../../../packages/contracts/dist/internal/editorial/index.js";
import {
  digest,
  fail,
  targetIdentity,
  validateManifest,
  verifyPrincipal,
} from "./identity.mjs";
import { verifyHistoricalConversion } from "./historical-proof-converter.mjs";

const exact = (value, keys) =>
  value &&
  Object.getPrototypeOf(value) === Object.prototype &&
  Object.keys(value).length === keys.length &&
  keys.every((key) => Object.hasOwn(value, key));
const sha = (value) =>
  typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const positive = (value) => Number.isSafeInteger(value) && value > 0;

export function nativeMediaMetadataProjection(result) {
  if (
    !Array.isArray(result?.docs) ||
    result.docs.length !== 1 ||
    result.totalDocs !== 1
  )
    return null;
  const raw = result.docs[0];
  return editorialUploadedMediaSchema.parse(
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
}

export function nativeCatalogMetadataProjection(result) {
  const draft = result?.result;
  if (
    result?.ok !== true ||
    !positive(draft?.id) ||
    !positive(draft.revision) ||
    !sha(draft.fingerprint)
  )
    fail("NATIVE_CATALOG_METADATA_INVALID");
  const content = editorialDraftSchema.parse(draft.content);
  return {
    id: draft.id,
    revision: draft.revision,
    fingerprint: draft.fingerprint,
    catalogId: content.catalogId,
    sourceId: content.sourceId,
    contentSha256: digest(content),
  };
}

function currentCatalogMatches(
  current,
  manifest,
  record,
  scopeSha256,
  conversionValidation,
) {
  if (!record) fail("CURRENT_CATALOG_METADATA_PROOF_INVALID");
  const p = current?.projection,
    r = current?.nativeReceipt;
  const historical = conversionValidation?.bundle.records.find(
    (x) => x.recordId === record.recordId,
  );
  if (
    !exact(current, ["projection", "nativeReceipt"]) ||
    !exact(p, [
      "id",
      "revision",
      "fingerprint",
      "catalogId",
      "sourceId",
      "contentSha256",
    ]) ||
    p.id !== historical?.uploadedDraft.id ||
    p.id !== historical?.latestKnownNative.id ||
    !positive(p.revision) ||
    !sha(p.fingerprint) ||
    !sha(p.contentSha256) ||
    p.catalogId !== record.catalogId ||
    p.sourceId !== record.sourceId ||
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
      "observedAt",
    ]) ||
    r.version !== 1 ||
    r.executionKind !== "native-https" ||
    r.scopeSha256 !== scopeSha256 ||
    r.targetIdentitySha256 !== targetIdentity(manifest) ||
    r.route !== "/api/editorial/read-draft" ||
    r.method !== "POST" ||
    r.httpStatus !== 200 ||
    r.transportStatus !== "COMPLETE" ||
    ![r.requestSha256, r.responseSha256, r.resultSha256].every(sha) ||
    r.metadataSha256 !== digest(p) ||
    !Number.isFinite(Date.parse(r.observedAt))
  )
    fail("CURRENT_CATALOG_METADATA_PROOF_INVALID");
}

export const registeredProofDigest = (proof) =>
  digest({
    media: proof.media,
    sourceSha256: proof.sourceSha256,
    uploadedSha256: proof.uploadedSha256,
    audit: proof.audit,
  });

function conversionMatches(
  conversion,
  verified,
  provenance,
  evidence,
  recordId,
) {
  if (!conversion) return;
  if (
    !verified ||
    verified.bundle.bundleSha256 !== conversion.bundleSha256 ||
    verified.entry.entryId !== conversion.entryId ||
    verified.entry.entrySha256 !== conversion.entrySha256 ||
    verified.entry.recordId !== recordId ||
    digest(verified.entry.evidence) !== digest(evidence) ||
    digest(verified.bundle.provenance) !== digest(provenance) ||
    Object.values(verified.entry.protections).some(Boolean)
  )
    fail("HISTORICAL_CONVERSION_CHANGED");
}

/** Persisted imports must be re-bound to their exact owned request ledger row. */
export async function validateRegisteredMediaProof({
  proof,
  manifest,
  recordId,
  scopeSha256,
  requests,
  verifyConversion = verifyHistoricalConversion,
}) {
  const audit = proof?.audit;
  const production = manifest.target.instance === "production";
  if (
    !exact(proof, [
      "media",
      "sourceSha256",
      "uploadedSha256",
      "evidenceSha256",
      "audit",
    ]) ||
    !exact(audit, [
      "version",
      "kind",
      "provenance",
      "evidence",
      "nativeReceipt",
      "conversion",
      ...(production ? ["currentCatalog", "observedAt"] : []),
    ]) ||
    audit.version !== (production ? 2 : 1) ||
    audit.kind !== "HISTORICAL_FULL_BYTE_PROOF_WITH_CURRENT_NATIVE_METADATA" ||
    proof.evidenceSha256 !== registeredProofDigest(proof)
  )
    fail("HISTORICAL_AUDIT_INVALID");
  const verified = audit.conversion
    ? await verifyConversion(audit.conversion)
    : null;
  conversionMatches(
    audit.conversion,
    verified,
    audit.provenance,
    audit.evidence,
    recordId,
  );
  const rows = requests.filter(
      (r) => r.requestSha256 === audit.nativeReceipt.requestSha256,
    ),
    row = rows[0];
  if (
    rows.length !== 1 ||
    row.status !== "COMPLETE" ||
    !row.drained ||
    row.httpStatus !== 200 ||
    row.route !== audit.nativeReceipt.route ||
    row.method !== "GET" ||
    row.responseSha256 !== audit.nativeReceipt.responseSha256 ||
    !row.receipt ||
    digest(row.receipt) !== digest(audit.nativeReceipt)
  )
    fail("NATIVE_METADATA_RECEIPT_MISMATCH");
  if (production) {
    const current = audit.currentCatalog;
    currentCatalogMatches(
      current,
      manifest,
      manifest.records.find((r) => r.recordId === recordId),
      scopeSha256,
      verified,
    );
    const matches = requests.filter(
        (r) => r.requestSha256 === current.nativeReceipt.requestSha256,
      ),
      catalogRow = matches[0];
    if (
      matches.length !== 1 ||
      catalogRow.status !== "COMPLETE" ||
      !catalogRow.drained ||
      catalogRow.httpStatus !== 200 ||
      catalogRow.route !== "/api/editorial/read-draft" ||
      catalogRow.method !== "POST" ||
      catalogRow.responseSha256 !== current.nativeReceipt.responseSha256 ||
      digest(catalogRow.receipt) !== digest(current.nativeReceipt) ||
      catalogRow.logicalKey !==
        digest({
          scope: scopeSha256,
          route: "/api/editorial/read-draft",
          method: "POST",
          bodySha256: createHash("sha256")
            .update(JSON.stringify({ id: current.projection.id }))
            .digest("hex"),
        }) ||
      catalogRow.sequence >= row.sequence ||
      audit.observedAt !== audit.nativeReceipt.observedAt
    )
      fail("CURRENT_CATALOG_METADATA_PROOF_INVALID");
  }
  const rebuilt = importRegisteredMediaProof({
    manifest,
    recordId,
    principal: {
      ...manifest.target,
      verified: true,
      scopeCatalogIds: manifest.records.map((r) => r.catalogId),
    },
    protections: manifest.records.find((r) => r.recordId === recordId)
      ?.protections,
    provenance: audit.provenance,
    evidence: audit.evidence,
    scopeSha256,
    nativeReceipt: audit.nativeReceipt,
    conversion: audit.conversion,
    conversionValidation: verified,
    currentCatalog: audit.currentCatalog ?? null,
    // The ledger stores the result digest and safe projection at response time.
    // Reload never relabels this old receipt as a new Native observation.
    freshResult: { docs: [proof.media], totalDocs: 1 },
    reloading: true,
  });
  if (digest(rebuilt) !== digest(proof)) fail("HISTORICAL_AUDIT_INVALID");
  return proof;
}

/** Normalized historical evidence only. This never reads images or grants authority. */
export function importRegisteredMediaProof({
  manifest,
  recordId,
  principal,
  protections,
  provenance,
  evidence,
  freshResult,
  nativeReceipt,
  scopeSha256,
  conversion = null,
  conversionValidation = null,
  currentCatalog = null,
  reloading = false,
}) {
  validateManifest(manifest);
  verifyPrincipal(manifest, principal);
  const record = manifest.records.find((item) => item.recordId === recordId);
  if (
    !record ||
    record.disposition === "hold" ||
    !exact(protections, ["rightsHold", "explicitlyHidden", "withdrawn"]) ||
    Object.values(protections).some(
      (value) => typeof value !== "boolean" || value,
    ) ||
    Object.values(record.protections).some(Boolean)
  )
    fail("PROTECTED_RECORD");
  if (
    !exact(provenance, [
      "target",
      "runId",
      "catalogIds",
      "planSha256",
      "stateSha256",
      "proofSha256",
    ]) ||
    digest(provenance.target) !== digest(manifest.target) ||
    typeof provenance.runId !== "string" ||
    !/^[A-Za-z0-9_-]{1,128}$/.test(provenance.runId) ||
    !Array.isArray(provenance.catalogIds) ||
    provenance.catalogIds.some((id) => typeof id !== "string") ||
    new Set(provenance.catalogIds).size !== provenance.catalogIds.length ||
    !provenance.catalogIds.includes(record.catalogId) ||
    ![
      provenance.planSha256,
      provenance.stateSha256,
      provenance.proofSha256,
    ].every(sha)
  )
    fail("HISTORICAL_PROOF_SCOPE_CHANGED");
  if (manifest.target.instance !== "development" && !conversion)
    fail("HISTORICAL_CONVERSION_REQUIRED");
  conversionMatches(
    conversion,
    conversionValidation,
    provenance,
    evidence,
    recordId,
  );
  const asset = record.media.find((item) => item.mediaId === evidence?.mediaId);
  if (
    !asset ||
    !exact(evidence, [
      "catalogId",
      "sourceId",
      "mediaId",
      "nativeId",
      "sourceSha256",
      "uploadedSha256",
      "bytes",
      "width",
      "height",
      "position",
      "isRepresentative",
      "authenticatedFullByteReadback",
    ]) ||
    evidence.catalogId !== record.catalogId ||
    evidence.sourceId !== record.sourceId ||
    !positive(evidence.nativeId) ||
    evidence.authenticatedFullByteReadback !== true ||
    Object.keys(asset).some((key) => evidence[key] !== asset[key])
  )
    fail("HISTORICAL_MEDIA_PROOF_MISMATCH");
  if (
    !sha(scopeSha256) ||
    !exact(nativeReceipt, [
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
      ...(manifest.target.instance === "production" ? ["observedAt"] : []),
    ]) ||
    nativeReceipt.version !== 1 ||
    nativeReceipt.executionKind !==
      (manifest.target.instance === "production"
        ? "native-https"
        : "local-http") ||
    nativeReceipt.scopeSha256 !== scopeSha256 ||
    nativeReceipt.targetIdentitySha256 !== targetIdentity(manifest) ||
    nativeReceipt.route !==
      `/api/media?where[mediaId][equals]=${asset.mediaId}&limit=1&depth=0` ||
    nativeReceipt.method !== "GET" ||
    nativeReceipt.httpStatus !== 200 ||
    nativeReceipt.transportStatus !== "COMPLETE" ||
    ![
      nativeReceipt.requestSha256,
      nativeReceipt.responseSha256,
      nativeReceipt.resultSha256,
    ].every(sha) ||
    (!reloading && nativeReceipt.resultSha256 !== digest(freshResult))
  )
    fail("NATIVE_METADATA_RECEIPT_MISMATCH");
  if (
    !Array.isArray(freshResult.docs) ||
    freshResult.docs.length !== 1 ||
    freshResult.totalDocs !== 1
  )
    fail("NATIVE_MEDIA_IDENTITY_MISMATCH");
  const media = nativeMediaMetadataProjection(freshResult);
  if (nativeReceipt.metadataSha256 !== digest(media))
    fail("NATIVE_METADATA_RECEIPT_MISMATCH");
  if (
    media.id !== evidence.nativeId ||
    media.mediaId !== asset.mediaId ||
    media.catalogId !== record.catalogId ||
    media.sha256 !== asset.uploadedSha256 ||
    media.filesize !== asset.bytes ||
    media.width !== asset.width ||
    media.height !== asset.height
  )
    fail("NATIVE_MEDIA_IDENTITY_MISMATCH");
  const production = manifest.target.instance === "production";
  if (production) {
    currentCatalogMatches(
      currentCatalog,
      manifest,
      record,
      scopeSha256,
      conversionValidation,
    );
    if (!Number.isFinite(Date.parse(nativeReceipt.observedAt)))
      fail("NATIVE_METADATA_RECEIPT_MISMATCH");
    if (
      conversionValidation.entry.objectKey !== null &&
      conversionValidation.entry.objectKey !== media.objectKey
    )
      fail("HISTORICAL_CONVERSION_CHANGED");
  }
  const proof = {
    media,
    sourceSha256: asset.sourceSha256,
    uploadedSha256: asset.uploadedSha256,
    audit: {
      version: production ? 2 : 1,
      kind: "HISTORICAL_FULL_BYTE_PROOF_WITH_CURRENT_NATIVE_METADATA",
      provenance,
      evidence,
      nativeReceipt,
      conversion,
      ...(production
        ? { currentCatalog, observedAt: nativeReceipt.observedAt }
        : {}),
    },
  };
  return { ...proof, evidenceSha256: registeredProofDigest(proof) };
}

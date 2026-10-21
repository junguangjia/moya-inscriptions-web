import { createHash } from "node:crypto";
import { URL } from "node:url";
import { normalizeProductionAuthority } from "./production-authority.mjs";
import { CATALOG_DELIVERY_CONTRACT_SHA256 } from "./delivery-contract.mjs";
export { CATALOG_DELIVERY_CONTRACT_SHA256 } from "./delivery-contract.mjs";
import {
  prepareCatalogDeliverySchema,
  readCatalogDeliverySchema,
  requestCatalogReleaseSchema,
  releaseCatalogDeliverySchema,
  cancelCatalogDeliverySchema,
  catalogDeliveryResultSchema,
  catalogDeliveryManifestSchema,
  editorialDraftSchema,
} from "../../../packages/contracts/dist/internal/editorial/index.js";
import {
  digest,
  fail,
  targetIdentity,
  validateManifest,
  verifyPrincipal,
} from "./identity.mjs";

// Exact frozen r1 source contract, not an HTTP/Payload acceptance claim.
const SCHEMAS = {
  prepare: prepareCatalogDeliverySchema,
  read: readCatalogDeliverySchema,
  request: requestCatalogReleaseSchema,
  release: releaseCatalogDeliverySchema,
  cancel: cancelCatalogDeliverySchema,
};
const ROUTES = {
  prepare: "prepare-catalog-delivery",
  read: "read-catalog-delivery",
  request: "request-catalog-release",
  release: "release-catalog-delivery",
  cancel: "cancel-catalog-delivery",
};
const TERMINAL = new Set(["cancelled", "superseded", "expired", "withdrawn"]);
// Admin refuses these before it writes any intent; the operator needs the
// reason, not a pending reconciliation (the attempt itself stays UNKNOWN).
const PREPARE_REFUSALS = new Set(["CATALOG_DELIVERY_SOURCE_TOO_LARGE"]);
const sha = (s) => typeof s === "string" && /^[a-f0-9]{64}$/.test(s);
const positive = (n) => Number.isSafeInteger(n) && n > 0;
const clone = (o) => JSON.parse(JSON.stringify(o));
const bytesHash = (s) => createHash("sha256").update(s).digest("hex");
const exact = (o, keys) =>
  o &&
  Object.getPrototypeOf(o) === Object.prototype &&
  Object.keys(o).length === keys.length &&
  keys.every((k) => Object.hasOwn(o, k));

/** Safe binding only. This function does not open authFile or establish a session. */
export function normalizePayloadBridgeBinding(
  manifest,
  ready,
  now = Date.now(),
) {
  validateManifest(manifest);
  const origin = new URL(ready.origin);
  if (
    manifest.target.instance !== "development" ||
    manifest.records.length !== 1 ||
    origin.origin !== ready.origin ||
    ready.origin !== manifest.target.origin ||
    origin.protocol !== "http:" ||
    origin.hostname !== "127.0.0.1" ||
    !origin.port ||
    origin.username ||
    origin.password ||
    ready.status !== "READY" ||
    ready.version !== 1 ||
    ready.contractSha256 !== CATALOG_DELIVERY_CONTRACT_SHA256 ||
    ready.credentialMaterialInThisFile !== false ||
    !/^synthetic[-_a-z0-9]{1,96}$/i.test(ready.environmentMarker) ||
    ready.actorId !== manifest.target.actorId ||
    !positive(ready.fixtureCatalogDocumentId) ||
    ready.fixtureCatalogId !== manifest.records[0].catalogId ||
    !Number.isFinite(Date.parse(ready.expiresAt)) ||
    Date.parse(ready.expiresAt) <= now ||
    !Number.isFinite(Date.parse(ready.jwtExpiresAt)) ||
    Date.parse(ready.jwtExpiresAt) <= now ||
    ready.closedAt ||
    !ready.caps ||
    ready.caps.requests !== 96 ||
    ready.caps.requestBodyPerRequest !== 1048576 ||
    ready.caps.acceptedRequestBodyTotal !== 4194304 ||
    ready.caps.responseBodyTotal !== 2097152
  )
    fail("PAYLOAD_BRIDGE_BINDING_INVALID");
  return {
    version: 1,
    environmentMarker: ready.environmentMarker,
    origin: ready.origin,
    contractSha256: ready.contractSha256,
    expiresAt: ready.expiresAt,
    jwtExpiresAt: ready.jwtExpiresAt,
    actorId: ready.actorId,
    fixtureCatalogDocumentId: ready.fixtureCatalogDocumentId,
    fixtureCatalogId: ready.fixtureCatalogId,
    caps: clone(ready.caps),
  };
}

/** Uses Native uploaded SHA, not the pre-conversion RAW source SHA. */
export function frozenCatalogDeliveryBinding(record, draft, mediaProofs) {
  const content = editorialDraftSchema.parse(draft.content);
  if (
    !positive(draft.id) ||
    !positive(draft.revision) ||
    !sha(draft.fingerprint) ||
    content.catalogId !== record.catalogId ||
    content.sourceId !== record.sourceId ||
    digest(content) !== record.contentSha256 ||
    content.media.length !== record.media.length
  )
    fail("DELIVERY_FROZEN_B_MISMATCH");
  const media = content.media.map((m, index) => {
    const asset = record.media[index],
      proof = mediaProofs.find((p) => p.media.mediaId === m.mediaId);
    if (
      !proof ||
      m.mediaId !== asset.mediaId ||
      m.objectKey !== proof.media.objectKey ||
      proof.media.catalogId !== record.catalogId ||
      proof.media.sha256 !== asset.uploadedSha256 ||
      proof.uploadedSha256 !== asset.uploadedSha256 ||
      proof.sourceSha256 !== asset.sourceSha256 ||
      proof.media.filesize !== asset.bytes ||
      m.width !== asset.width ||
      m.height !== asset.height ||
      m.width !== proof.media.width ||
      m.height !== proof.media.height ||
      m.position !== asset.position ||
      m.isRepresentative !== asset.isRepresentative
    )
      fail("DELIVERY_FROZEN_B_MISMATCH");
    return { ...m, sourceSha256: proof.media.sha256 };
  });
  const parsed = catalogDeliveryManifestSchema.parse(media);
  return {
    recordId: record.recordId,
    id: draft.id,
    catalogId: record.catalogId,
    revision: draft.revision,
    fingerprint: draft.fingerprint,
    contentSha256: record.contentSha256,
    // The owning server uses ordered schema JSON, not canonical object hashing.
    manifestSha256: bytesHash(JSON.stringify(parsed)),
    mediaCount: parsed.length,
  };
}

function scope(manifest, binding, frozen) {
  validateManifest(manifest);
  const production = manifest.target.instance === "production";
  const normalized = production
    ? normalizeProductionAuthority(manifest, binding, -Infinity)
    : normalizePayloadBridgeBinding(
        manifest,
        { ...binding, status: "READY", credentialMaterialInThisFile: false },
        -Infinity,
      );
  if (digest(normalized) !== digest(binding)) fail("DELIVERY_SCOPE_INVALID");
  if (
    (!production && manifest.target.instance !== "development") ||
    binding.contractSha256 !== CATALOG_DELIVERY_CONTRACT_SHA256 ||
    binding.origin !== manifest.target.origin ||
    binding.actorId !== manifest.target.actorId ||
    !Array.isArray(frozen) ||
    frozen.length !== manifest.records.length
  )
    fail("DELIVERY_SCOPE_INVALID");
  const seen = new Set();
  for (const b of frozen) {
    const record = manifest.records.find((r) => r.recordId === b.recordId);
    if (
      !exact(b, [
        "recordId",
        "id",
        "catalogId",
        "revision",
        "fingerprint",
        "contentSha256",
        "manifestSha256",
        "mediaCount",
      ]) ||
      !record ||
      seen.has(b.recordId) ||
      b.catalogId !== record.catalogId ||
      b.contentSha256 !== record.contentSha256 ||
      b.mediaCount !== record.media.length ||
      !positive(b.id) ||
      !positive(b.revision) ||
      !sha(b.fingerprint) ||
      !sha(b.manifestSha256) ||
      (binding.fixtureCatalogDocumentId !== undefined &&
        b.id !== binding.fixtureCatalogDocumentId) ||
      (production && b.id !== binding.nativeId)
    )
      fail("DELIVERY_SCOPE_INVALID");
    seen.add(b.recordId);
  }
  return digest({
    contractSha256: CATALOG_DELIVERY_CONTRACT_SHA256,
    targetIdentitySha256: targetIdentity(manifest),
    binding,
    frozen,
  });
}

const keyFor = (scopeSha256, recordId, operation, input) =>
  `delivery-${digest({ scopeSha256, recordId, operation, input })}`;
function command(scopeSha256, recordId, operation, input) {
  const schema = SCHEMAS[operation];
  if (!schema || operation === "read" || Object.hasOwn(input, "idempotencyKey"))
    fail("DELIVERY_ACTION_INVALID");
  const body = schema.parse({
    ...input,
    idempotencyKey: keyFor(scopeSha256, recordId, operation, input),
  });
  const bodyText = JSON.stringify(body);
  return {
    recordId,
    operation,
    route: `/api/editorial/${ROUTES[operation]}`,
    method: "POST",
    bodyText,
    bodySha256: bytesHash(bodyText),
    attempts: [],
    status: "PENDING",
    result: null,
  };
}

function resultMatches(result, b) {
  if (
    result.id !== b.id ||
    result.catalogId !== b.catalogId ||
    result.revision !== b.revision ||
    result.fingerprint !== b.fingerprint ||
    result.manifestSha256 !== b.manifestSha256 ||
    result.mediaCount !== b.mediaCount
  )
    fail("DELIVERY_RESULT_SCOPE_CHANGED");
}

export function openCatalogDeliveryJournal({
  manifest,
  binding,
  frozen,
  saved = null,
}) {
  const scopeSha256 = scope(manifest, binding, frozen);
  if (!saved)
    return {
      version: 1,
      executionKind:
        manifest.target.instance === "production"
          ? "native-https"
          : "local-http",
      contractSha256: CATALOG_DELIVERY_CONTRACT_SHA256,
      scopeSha256,
      targetIdentitySha256: targetIdentity(manifest),
      binding: clone(binding),
      frozen: clone(frozen),
      actions: {},
      observations: [],
      nativeConfirmations: {},
      dispatchCount: 0,
    };
  if (
    !exact(saved, [
      "version",
      "executionKind",
      "contractSha256",
      "scopeSha256",
      "targetIdentitySha256",
      "binding",
      "frozen",
      "actions",
      "observations",
      "nativeConfirmations",
      "dispatchCount",
    ]) ||
    saved.version !== 1 ||
    saved.executionKind !==
      (manifest.target.instance === "production"
        ? "native-https"
        : "local-http") ||
    saved.contractSha256 !== CATALOG_DELIVERY_CONTRACT_SHA256 ||
    saved.scopeSha256 !== scopeSha256 ||
    saved.targetIdentitySha256 !== targetIdentity(manifest) ||
    digest(saved.binding) !== digest(binding) ||
    digest(saved.frozen) !== digest(frozen) ||
    !exact(saved.actions, Object.keys(saved.actions)) ||
    !Array.isArray(saved.observations) ||
    !exact(saved.nativeConfirmations, Object.keys(saved.nativeConfirmations)) ||
    !Number.isSafeInteger(saved.dispatchCount) ||
    saved.dispatchCount < 0 ||
    saved.dispatchCount > 96
  )
    fail("DELIVERY_JOURNAL_INVALID");
  let count = saved.observations.length;
  for (const [id, a] of Object.entries(saved.actions)) {
    const b = frozen.find((r) => r.recordId === a.recordId);
    if (
      !b ||
      !exact(a, [
        "recordId",
        "operation",
        "route",
        "method",
        "bodyText",
        "bodySha256",
        "attempts",
        "status",
        "result",
      ]) ||
      id !== `${a.recordId}:${a.operation}` ||
      !["PENDING", "UNKNOWN", "CONFIRMED"].includes(a.status) ||
      !Array.isArray(a.attempts) ||
      a.attempts.length < 1 ||
      a.attempts.length > 2
    )
      fail("DELIVERY_JOURNAL_INVALID");
    const parsed = SCHEMAS[a.operation]?.parse(JSON.parse(a.bodyText));
    if (!parsed) fail("DELIVERY_JOURNAL_INVALID");
    const input = Object.fromEntries(
      Object.entries(parsed).filter(([key]) => key !== "idempotencyKey"),
    );
    const expected = command(scopeSha256, a.recordId, a.operation, input);
    if (
      ["route", "method", "bodyText", "bodySha256"].some(
        (k) => a[k] !== expected[k],
      )
    )
      fail("DELIVERY_JOURNAL_INVALID");
    for (const [index, attempt] of a.attempts.entries()) {
      if (
        !exact(attempt, [
          "attempt",
          "status",
          "resultSha256",
          "nativeReceipt",
        ]) ||
        attempt.attempt !== index + 1 ||
        !["PENDING", "UNKNOWN", "CONFIRMED"].includes(attempt.status) ||
        (attempt.resultSha256 !== null && !sha(attempt.resultSha256))
      )
        fail("DELIVERY_JOURNAL_INVALID");
    }
    count += a.attempts.length;
    if (a.result !== null)
      resultMatches(catalogDeliveryResultSchema.parse(a.result), b);
    if (
      a.status === "CONFIRMED" &&
      (!a.result ||
        a.attempts.at(-1)?.status !== "CONFIRMED" ||
        a.attempts.at(-1).resultSha256 !==
          digest({ ok: true, result: a.result }))
    )
      fail("DELIVERY_JOURNAL_INVALID");
  }
  for (const o of saved.observations) {
    const b = frozen.find((r) => r.recordId === o.recordId);
    if (
      !b ||
      !exact(o, ["recordId", "intentId", "status", "result"]) ||
      !["PENDING", "UNKNOWN", "CONFIRMED"].includes(o.status)
    )
      fail("DELIVERY_JOURNAL_INVALID");
    readCatalogDeliverySchema.parse({ intentId: o.intentId });
    if (o.result !== null) {
      const r = catalogDeliveryResultSchema.parse(o.result);
      resultMatches(r, b);
      if (r.intentId !== o.intentId || o.status !== "CONFIRMED")
        fail("DELIVERY_JOURNAL_INVALID");
    } else if (o.status === "CONFIRMED") fail("DELIVERY_JOURNAL_INVALID");
  }
  for (const [recordId, confirmation] of Object.entries(
    saved.nativeConfirmations,
  )) {
    const b = frozen.find((r) => r.recordId === recordId);
    if (
      !b ||
      !exact(confirmation, [
        "id",
        "revision",
        "contentSha256",
        "status",
        "anonymousDeliveryVerified",
      ]) ||
      confirmation.id !== b.id ||
      confirmation.revision !== b.revision + 1 ||
      confirmation.contentSha256 !== b.contentSha256 ||
      confirmation.status !== "published" ||
      confirmation.anonymousDeliveryVerified !== false
    )
      fail("DELIVERY_JOURNAL_INVALID");
  }
  if (count !== saved.dispatchCount) fail("DELIVERY_JOURNAL_INVALID");
  return clone(saved);
}

/** Caller supplies the owned durable writer and a separately budgeted transport.
 * No network/session/storage is opened here. Production and CLI remain unbound.
 */
export function createCatalogDeliveryClient({
  manifest,
  binding,
  frozen,
  journal,
  persist,
  assertAdmission,
  send,
  inspectRecord,
  verifyAccount,
  validateTransportReceipt,
  deadline,
  signal,
  now = Date.now,
}) {
  const expected = openCatalogDeliveryJournal({
    manifest,
    binding,
    frozen,
    saved: journal,
  });
  if (
    digest(expected) !== digest(journal) ||
    typeof persist !== "function" ||
    typeof assertAdmission !== "function" ||
    typeof send !== "function" ||
    typeof inspectRecord !== "function" ||
    typeof verifyAccount !== "function" ||
    !Number.isFinite(deadline)
  )
    fail("DELIVERY_CLIENT_INVALID");
  let busy = false;
  const active = async () => {
    if (signal?.aborted) fail("WORKFLOW_CANCELLED");
    if (
      now() >=
      Math.min(
        deadline,
        Date.parse(binding.expiresAt),
        Date.parse(binding.credentialExpiresAt ?? binding.jwtExpiresAt),
      )
    )
      fail("WORKFLOW_DEADLINE_EXCEEDED");
    await assertAdmission();
    verifyPrincipal(manifest, await verifyAccount());
    if (
      signal?.aborted ||
      now() >=
        Math.min(
          deadline,
          Date.parse(binding.expiresAt),
          Date.parse(binding.credentialExpiresAt ?? binding.jwtExpiresAt),
        )
    )
      fail("WORKFLOW_DEADLINE_EXCEEDED");
  };
  const entry = (recordId) => {
    const record = manifest.records.find((r) => r.recordId === recordId),
      b = frozen.find((r) => r.recordId === recordId);
    if (!record || !b) fail("ACTION_RECORD_NOT_IN_SCOPE");
    return { record, b };
  };
  const observe = async (recordId, intentId) => {
    await active();
    if (journal.dispatchCount >= 96) fail("DELIVERY_REQUEST_LIMIT");
    const o = { recordId, intentId, status: "PENDING", result: null };
    const body = readCatalogDeliverySchema.parse({ intentId });
    journal.observations.push(o);
    journal.dispatchCount++;
    await persist(clone(journal));
    await active();
    let response;
    try {
      response = await send(
        "/api/editorial/read-catalog-delivery",
        "POST",
        body,
        signal,
      );
    } catch {
      response = { ok: false };
    }
    try {
      if (!response.ok || response.result?.ok !== true)
        fail("DELIVERY_READ_UNKNOWN");
      const r = catalogDeliveryResultSchema.parse(response.result.result);
      resultMatches(r, entry(recordId).b);
      if (r.intentId !== intentId) fail("DELIVERY_RESULT_SCOPE_CHANGED");
      const prior = knownIntent(recordId);
      if (
        prior &&
        (r.stateVersion < prior.stateVersion ||
          r.recipeManifestSha256 !== prior.recipeManifestSha256)
      )
        fail("DELIVERY_RESULT_SCOPE_CHANGED");
      o.result = r;
      o.status = "CONFIRMED";
    } catch {
      o.status = "UNKNOWN";
    }
    await persist(clone(journal));
    return o.result;
  };
  const knownIntent = (recordId) => {
    const results = [
      ...Object.values(journal.actions)
        .filter((a) => a.recordId === recordId)
        .map((a) => a.result),
      ...journal.observations
        .filter((o) => o.recordId === recordId)
        .map((o) => o.result),
    ].filter(Boolean);
    if (new Set(results.map((r) => r.intentId)).size > 1)
      fail("DELIVERY_INTENT_CHANGED");
    return results.sort((a, b) => b.stateVersion - a.stateVersion)[0] ?? null;
  };
  const inspect = async (recordId, allowProtected) => {
    const { record, b } = entry(recordId),
      current = await inspectRecord(recordId);
    if (
      !exact(current.protections, [
        "rightsHold",
        "explicitlyHidden",
        "withdrawn",
      ]) ||
      Object.values(current.protections).some((v) => typeof v !== "boolean")
    )
      fail("DELIVERY_NATIVE_INVALID");
    if (
      !allowProtected &&
      (record.disposition === "hold" ||
        Object.values(record.protections).some(Boolean) ||
        Object.values(current.protections).some(Boolean))
    )
      fail("PROTECTED_RECORD");
    if (
      current.draft.id !== b.id ||
      current.draft.content.catalogId !== record.catalogId ||
      current.draft.content.sourceId !== record.sourceId ||
      digest(editorialDraftSchema.parse(current.draft.content)) !==
        b.contentSha256
    )
      fail("DELIVERY_FROZEN_B_MISMATCH");
    return current;
  };
  const confirmNative = async (recordId, result) => {
    delete journal.nativeConfirmations[recordId];
    await persist(clone(journal));
    if (result.state !== "released") return;
    const { b, record } = entry(recordId),
      current = await inspect(recordId, false),
      main = current.main;
    if (
      current.draft.revision !== b.revision + 1 ||
      main?.id !== b.id ||
      main.revision !== b.revision + 1 ||
      main.status !== "published" ||
      main.content?.catalogId !== record.catalogId ||
      main.content.sourceId !== record.sourceId ||
      digest(editorialDraftSchema.parse(main.content)) !== b.contentSha256
    )
      return;
    journal.nativeConfirmations[recordId] = {
      id: b.id,
      revision: main.revision,
      contentSha256: b.contentSha256,
      status: "published",
      anonymousDeliveryVerified: false,
    };
    await persist(clone(journal));
  };
  const execute = async (recordId, operation, input) => {
    if (busy) fail("DELIVERY_CLIENT_BUSY");
    busy = true;
    try {
      await active();
      const { b } = entry(recordId);
      if (operation === "read") {
        const { intentId } = readCatalogDeliverySchema.parse(input);
        if (knownIntent(recordId)?.intentId !== intentId)
          fail("DELIVERY_INTENT_CHANGED");
        return {
          status: "OBSERVATION",
          result: await observe(recordId, intentId),
        };
      }
      const id = `${recordId}:${operation}`,
        proposed = command(journal.scopeSha256, recordId, operation, input),
        old = journal.actions[id];
      if (old && old.bodyText !== proposed.bodyText)
        fail("DELIVERY_ACTION_BINDING_CHANGED");
      const a = old ?? proposed,
        parsed = JSON.parse(a.bodyText);
      const current = await inspect(recordId, operation === "cancel");
      delete journal.nativeConfirmations[recordId];
      await persist(clone(journal));
      let observed = knownIntent(recordId);
      if (operation !== "prepare") {
        if (!observed || observed.intentId !== parsed.intentId)
          fail("DELIVERY_INTENT_CHANGED");
        observed = await observe(recordId, observed.intentId);
        if (!observed) return { status: "UNKNOWN", result: null };
        if (TERMINAL.has(observed.state))
          return { status: "HOLD", result: observed };
      }
      if (a.status === "CONFIRMED") {
        if (observed?.state === "released") {
          try {
            await confirmNative(recordId, observed);
          } catch {
            /* independent acceptance remains unverified */
          }
        }
        return {
          status: "RECEIPT_CONFIRMED",
          result: observed ?? a.result,
          nativePublicationVerified: !!journal.nativeConfirmations[recordId],
          anonymousDeliveryVerified: false,
        };
      }
      if (!old) {
        if (
          operation === "prepare" &&
          (parsed.id !== b.id ||
            parsed.expectedRevision !== b.revision ||
            parsed.expectedFingerprint !== b.fingerprint ||
            current.draft.revision !== b.revision ||
            current.draft.fingerprint !== b.fingerprint)
        )
          fail("DELIVERY_FROZEN_B_MISMATCH");
        if (
          operation !== "prepare" &&
          parsed.expectedStateVersion !== observed.stateVersion
        )
          fail("DELIVERY_STATE_CHANGED");
        if (
          operation === "request" &&
          (manifest.target.role !== "owner" ||
            parsed.expectedManifestSha256 !== b.manifestSha256 ||
            observed.state !== "prepared")
        )
          fail("DELIVERY_ACTION_INVALID");
        if (
          operation === "release" &&
          (parsed.expectedRevision !== b.revision ||
            (manifest.target.role === "automation" &&
              !positive(parsed.approvalId)) ||
            parsed.expectedFingerprint !== b.fingerprint ||
            current.draft.revision !== b.revision ||
            current.draft.fingerprint !== b.fingerprint ||
            observed.state !== "release_requested" ||
            !observed.publicCopyAuthorized ||
            observed.readiness !== "READY")
        )
          fail("DELIVERY_NOT_READY");
        if (
          operation === "cancel" &&
          !["prepared", "release_requested"].includes(observed.state)
        )
          fail("DELIVERY_ACTION_INVALID");
      }
      if (a.attempts.length >= 2 || journal.dispatchCount >= 96)
        return { status: "UNKNOWN", result: observed };
      journal.actions[id] = a;
      const attempt = {
        attempt: a.attempts.length + 1,
        status: "PENDING",
        resultSha256: null,
        nativeReceipt: null,
      };
      a.attempts.push(attempt);
      a.status = "PENDING";
      journal.dispatchCount++;
      await persist(clone(journal));
      await active();
      let response;
      try {
        response = await send(a.route, "POST", JSON.parse(a.bodyText), signal);
      } catch {
        response = { ok: false };
      }
      try {
        if (
          !response.ok ||
          !exact(response.result, ["ok", "result"]) ||
          response.result.ok !== true
        )
          fail("DELIVERY_RESPONSE_UNKNOWN");
        const result = catalogDeliveryResultSchema.parse(
          response.result.result,
        );
        resultMatches(result, b);
        if (operation !== "prepare" && result.intentId !== parsed.intentId)
          fail("DELIVERY_INTENT_CHANGED");
        const prior = knownIntent(recordId);
        if (
          prior &&
          (prior.intentId !== result.intentId ||
            result.stateVersion < prior.stateVersion ||
            result.recipeManifestSha256 !== prior.recipeManifestSha256)
        )
          fail("DELIVERY_RESULT_SCOPE_CHANGED");
        if (validateTransportReceipt) {
          await validateTransportReceipt(response.nativeReceipt, {
            route: a.route,
            method: a.method,
            bodySha256: a.bodySha256,
            resultSha256: digest(response.result),
          });
          attempt.nativeReceipt = clone(response.nativeReceipt);
        }
        attempt.resultSha256 = digest(response.result);
        attempt.status = "CONFIRMED";
        a.result = result;
        a.status = "CONFIRMED";
      } catch {
        attempt.status = "UNKNOWN";
        a.status = "UNKNOWN";
      }
      await persist(clone(journal));
      if (
        operation === "prepare" &&
        a.status !== "CONFIRMED" &&
        response?.ok === false &&
        PREPARE_REFUSALS.has(response.code)
      )
        fail(response.code);
      if (a.status === "CONFIRMED" && a.result.state === "released") {
        try {
          await confirmNative(recordId, a.result);
        } catch {
          /* Current Native acceptance remains separate and unverified. */
        }
      }
      return {
        status:
          a.status === "CONFIRMED"
            ? TERMINAL.has(a.result.state)
              ? "HOLD"
              : "RECEIPT_CONFIRMED"
            : "UNKNOWN",
        result: a.result,
        nativePublicationVerified: !!journal.nativeConfirmations[recordId],
        anonymousDeliveryVerified: false,
      };
    } finally {
      busy = false;
    }
  };
  const pending = new Set();
  let closed = false;
  return {
    execute: (...args) => {
      if (closed) fail("DELIVERY_CLIENT_CLOSED");
      const task = execute(...args);
      pending.add(task);
      task.then(
        () => pending.delete(task),
        () => pending.delete(task),
      );
      return task;
    },
    snapshot: () => clone(journal),
    close: async () => {
      closed = true;
      await Promise.allSettled([...pending]);
    },
  };
}

import { constants } from "node:fs";
import { open, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { Buffer } from "node:buffer";
import process from "node:process";
import { digest, fail } from "./identity.mjs";

const ROLES = [
  "plan",
  "state",
  "fullByteProof",
  "finalMetadata",
  "objectKeys",
  "publicationIntent",
  "withdrawal",
  "withdrawalVerification",
];
const RULES = [
  "raw-json-regular-owned-no-symlink-max-2MiB-each-8MiB-total",
  "plan-state-fullByteProof-sha-cross-reference-and-exact-identity-join",
  "legacy-target-origin-instance-actor-without-role-or-catalogIds",
  "current-target-includes-role-and-sorted-exact-catalogIds",
  "finalMetadata-run-is-final-native-metadata-validation-not-upload-run",
  "plan-order-and-cover-preserved-source-hash-distinct-from-uploaded-hash",
  "publication-hold-and-later-confirmed-withdrawal-latch-protections",
  "object-key-only-from-historical-observed-row-never-synthesized",
  "every-entry-needs-fresh-native-metadata-no-current-binary-or-authority",
  "relationship-sidecar-not-imported-no-native-relationship-or-training-claim",
];
const sha = (s) => typeof s === "string" && /^[a-f0-9]{64}$/.test(s);
const positive = (n) => Number.isSafeInteger(n) && n > 0;
const exact = (o, keys) =>
  o &&
  Object.getPrototypeOf(o) === Object.prototype &&
  Object.keys(o).length === keys.length &&
  keys.every((k) => Object.hasOwn(o, k));
const hashBytes = (b) => createHash("sha256").update(b).digest("hex");
const check = (ok) => {
  if (!ok) fail("HISTORICAL_SOURCE_INCONSISTENT");
};
const select = (o, keys) => Object.fromEntries(keys.map((k) => [k, o[k]]));
const snapshot = (o) =>
  select(o, ["id", "revision", "fingerprint", "contentSha256"]);
const gallery = (assets) =>
  assets.map((a) => select(a, ["mediaId", "position", "isRepresentative"]));

export async function historicalConverterIdentity() {
  return {
    id: "catalog-historical-small-json-proof",
    version: 1,
    rulesSha256: digest(RULES),
    sourceCodeSha256: hashBytes(await readFile(fileURLToPath(import.meta.url))),
  };
}

async function sources(spec) {
  if (
    !exact(spec, [
      "version",
      "target",
      "expectedRecords",
      "expectedMedia",
      "files",
    ]) ||
    spec.version !== 1 ||
    !positive(spec.expectedRecords) ||
    spec.expectedRecords > 2000 ||
    !positive(spec.expectedMedia) ||
    spec.expectedMedia > 2000 ||
    !exact(spec.target, ["origin", "instance", "actorId", "role"]) ||
    !["production", "development"].includes(spec.target.instance) ||
    !positive(spec.target.actorId) ||
    spec.target.role !== "owner" ||
    !Array.isArray(spec.files) ||
    spec.files.length !== ROLES.length
  )
    fail("HISTORICAL_SOURCE_SPEC_INVALID");
  let total = 0;
  const result = {},
    paths = new Set();
  for (const role of ROLES) {
    const rows = spec.files.filter((f) => f.role === role),
      f = rows[0];
    if (
      rows.length !== 1 ||
      !exact(f, ["role", "path", "sha256", "bytes"]) ||
      !path.isAbsolute(f.path) ||
      path.extname(f.path) !== ".json" ||
      paths.has(f.path) ||
      !sha(f.sha256) ||
      !positive(f.bytes) ||
      f.bytes > 2 * 1024 * 1024 ||
      (total += f.bytes) > 8 * 1024 * 1024
    )
      fail("HISTORICAL_SOURCE_SPEC_INVALID");
    paths.add(f.path);
    if ((await realpath(f.path)) !== f.path)
      fail("HISTORICAL_SOURCE_PATH_REJECTED");
    const handle = await open(
      f.path,
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    try {
      const stat = await handle.stat();
      if (
        !stat.isFile() ||
        stat.size !== f.bytes ||
        stat.uid !== process.getuid()
      )
        fail("HISTORICAL_SOURCE_CHANGED");
      // A growing file cannot turn this bounded reader into an unbounded readFile.
      const bytes = Buffer.alloc(f.bytes + 1);
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
        offset !== f.bytes ||
        hashBytes(bytes.subarray(0, offset)) !== f.sha256
      )
        fail("HISTORICAL_SOURCE_CHANGED");
      result[role] = JSON.parse(bytes.subarray(0, offset).toString("utf8"));
    } finally {
      await handle.close();
    }
  }
  return result;
}

function indexed(rows, key, count) {
  check(Array.isArray(rows) && rows.length === count);
  const map = new Map(rows.map((r) => [r[key], r]));
  check(map.size === rows.length && !map.has(undefined));
  return map;
}

/** Reads only the explicitly hash-pinned small JSON files, never image paths. */
export async function convertHistoricalProof(sourceSpec) {
  sourceSpec = JSON.parse(JSON.stringify(sourceSpec));
  const s = await sources(sourceSpec),
    file = (role) => sourceSpec.files.find((f) => f.role === role);
  const {
    plan,
    state,
    fullByteProof: full,
    finalMetadata: final,
    objectKeys: keys,
    publicationIntent: intent,
    withdrawal: withdrawn,
    withdrawalVerification: verified,
  } = s;
  const originalTarget = sourceSpec.target;
  const legacyIdentitySha256 = digest(
    select(originalTarget, ["origin", "instance", "actorId"]),
  );
  check(
    plan.version === 1 &&
      state.version === 1 &&
      full.version === 1 &&
      full.status === "PASS" &&
      plan.origin === originalTarget.origin &&
      plan.publication === false &&
      state.publication === false &&
      state.targetIdentity === legacyIdentitySha256 &&
      sha(plan.reviewSha256) &&
      state.reviewSha256 === plan.reviewSha256 &&
      state.planBytesSha256 === file("plan").sha256 &&
      full.uploadPlanSha256 === file("plan").sha256 &&
      full.uploadStateSha256 === file("state").sha256 &&
      final.readOnly === true &&
      final.backendWrites === 0 &&
      final.mediaBytesDownloaded === 0 &&
      typeof final.runId === "string" &&
      intent.origin === originalTarget.origin &&
      intent.actorId === originalTarget.actorId &&
      verified.status === "PASS" &&
      verified.readOnly === true &&
      verified.backendWrites === 0 &&
      verified.cloudWrites === 0,
  );
  check(
    intent.evidence?.uploadPlan?.sha256 === file("plan").sha256 &&
      intent.evidence.uploadState?.sha256 === file("state").sha256 &&
      intent.evidence.fullByteProofs?.sha256 === file("fullByteProof").sha256 &&
      intent.evidence.finalDraftReadback?.sha256 ===
        file("finalMetadata").sha256 &&
      withdrawn.inputDigests?.uploadPlan === file("plan").sha256 &&
      withdrawn.inputDigests.publicationIntent ===
        file("publicationIntent").sha256 &&
      verified.inputDigests?.plan === file("plan").sha256 &&
      verified.inputDigests.upload === file("state").sha256 &&
      verified.inputDigests.intent === file("publicationIntent").sha256 &&
      verified.inputDigests.readback === file("finalMetadata").sha256 &&
      verified.inputDigests.receipt === file("withdrawal").sha256 &&
      keys.inputDigests?.plan === file("plan").sha256 &&
      keys.inputDigests.execution === file("state").sha256 &&
      keys.inputDigests.withdrawal === file("withdrawal").sha256 &&
      keys.inputDigests.lastLiveVerification ===
        file("withdrawalVerification").sha256,
  );
  const planned = indexed(plan.records, "reviewId", sourceSpec.expectedRecords),
    finalRows = indexed(final.records, "reviewId", planned.size),
    intentRows = indexed(intent.records, "reviewId", planned.size),
    verifyRows = indexed(verified.records, "reviewId", planned.size),
    fullRows = indexed(full.proofs, "mediaId", sourceSpec.expectedMedia);
  check(Object.keys(state.records).length === planned.size);
  const nativeIds = new Set(),
    mediaIds = new Set(),
    assetIds = new Set(),
    identities = new Set();
  check(
    keys.status === "PASS" &&
      keys.owner?.verified === true &&
      keys.owner.id === originalTarget.actorId &&
      keys.owner.role === originalTarget.role &&
      keys.actualObjectKeyReadbackPerformed === true &&
      Array.isArray(keys.rows) &&
      Array.isArray(keys.checks) &&
      keys.rows.length === keys.checks.length,
  );
  const observedKeys = indexed(keys.rows, "mediaId", keys.rows.length),
    keyChecks = indexed(keys.checks, "mediaId", keys.rows.length);
  const records = [],
    entries = [];
  for (const [recordId, p] of planned) {
    const st = state.records[recordId],
      f = finalRows.get(recordId),
      i = intentRows.get(recordId),
      v = verifyRows.get(recordId);
    check(
      st?.reviewId === recordId &&
        st.status === "verified" &&
        st.phase === "verified" &&
        f.status === "PASS" &&
        [p.catalogId, p.sourceId].every(
          (id) => typeof id === "string" && !identities.has(id),
        ) &&
        p.catalogId !== p.sourceId &&
        positive(st.id) &&
        positive(st.revision) &&
        [f, i].every(
          (r) =>
            r.catalogId === p.catalogId &&
            r.sourceId === p.sourceId &&
            r.id === st.id,
        ) &&
        f.fingerprint === st.finalDraftProof?.fingerprint &&
        f.contentSha256 === st.finalDraftProof.contentSha256 &&
        (withdrawn.reviewId === recordId ||
          (i.fingerprint === f.fingerprint &&
            i.contentSha256 === f.contentSha256)) &&
        f.revision === st.revision &&
        i.revision >= st.revision &&
        st.finalDraftProof.id === st.id &&
        st.finalDraftProof.revision === st.revision &&
        sha(st.finalDraftProof.fingerprint) &&
        sha(st.finalDraftProof.contentSha256) &&
        st.finalDraftProof.authenticatedFullByteReadback === true &&
        Array.isArray(p.assets) &&
        p.assets.length > 0 &&
        Object.keys(st.verifiedAssets).length === p.assets.length &&
        digest(gallery(p.assets)) === digest(st.finalDraftProof.media) &&
        digest(f.media) === digest(st.finalDraftProof.media),
    );
    identities.add(p.catalogId);
    identities.add(p.sourceId);
    const protections = {
      rightsHold: i.action === "hold",
      explicitlyHidden: false,
      withdrawn: false,
    };
    let latestKnownNative = {
      ...snapshot(f),
      observationRole: "finalMetadata",
    };
    if (withdrawn.reviewId === recordId) {
      const w = withdrawn.withdrawnProof;
      check(
        withdrawn.status === "withdrawn" &&
          w?.nativeOwnerActorMatches === true &&
          w.status === "draft" &&
          w.id === st.id &&
          w.catalogId === p.catalogId &&
          w.sourceId === p.sourceId &&
          w.revision === withdrawn.expectedAfterRevision &&
          w.revision > st.revision &&
          v.revision === w.revision &&
          v.id === w.id &&
          v.fingerprint === w.fingerprint &&
          v.contentSha256 === w.contentSha256 &&
          v.status === `DRAFT_REVISION_${w.revision}_CONFIRMED` &&
          i.fingerprint === w.fingerprint &&
          i.contentSha256 === w.contentSha256 &&
          digest(w.media) === digest(gallery(p.assets)),
      );
      protections.withdrawn = true;
      latestKnownNative = {
        ...snapshot(w),
        observationRole: "withdrawalVerification",
      };
    } else
      check(
        v.id === st.id &&
          v.revision === st.revision &&
          v.fingerprint === f.fingerprint &&
          v.contentSha256 === f.contentSha256,
      );
    check(
      v.mediaCount === p.assets.length &&
        v.gallerySha256 === digest(gallery(p.assets)),
    );
    const record = {
      recordId,
      title: p.title ?? null,
      catalogId: p.catalogId,
      sourceId: p.sourceId,
      protections,
      uploadedDraft: snapshot(f),
      publicationIntentSnapshot: snapshot(i),
      latestKnownNative,
      historicalHoldReason: protections.rightsHold
        ? (i.holdReason ?? "Historical publication hold")
        : null,
    };
    records.push(record);
    for (const [index, a] of p.assets.entries()) {
      const proof = fullRows.get(a.mediaId),
        old = st.verifiedAssets[a.assetId];
      check(
        typeof a.assetId === "string" &&
          !assetIds.has(a.assetId) &&
          !mediaIds.has(a.mediaId) &&
          sha(a.sourceSha256) &&
          sha(a.sha256) &&
          [a.bytes, a.width, a.height].every(positive) &&
          Number.isSafeInteger(a.position) &&
          a.position >= 0 &&
          (index === 0 || p.assets[index - 1].position < a.position) &&
          typeof a.isRepresentative === "boolean" &&
          proof?.reviewId === recordId &&
          proof.assetId === a.assetId &&
          proof.mediaId === a.mediaId &&
          positive(proof.nativeId) &&
          !nativeIds.has(proof.nativeId) &&
          old?.mediaId === a.mediaId &&
          old.nativeId === proof.nativeId &&
          [old, proof].every(
            (r) =>
              r.sha256 === a.sha256 &&
              r.bytes === a.bytes &&
              r.width === a.width &&
              r.height === a.height &&
              r.authenticatedFullByteReadback === true,
          ),
      );
      assetIds.add(a.assetId);
      mediaIds.add(a.mediaId);
      nativeIds.add(proof.nativeId);
      const observation = observedKeys.get(a.mediaId),
        keyCheck = keyChecks.get(a.mediaId);
      let objectKeyObservation = null;
      if (observation) {
        check(
          keys.reviewId === recordId &&
            keys.catalogId === p.catalogId &&
            observation.id === proof.nativeId &&
            observation.filesize === a.bytes &&
            typeof observation.objectKey === "string" &&
            observation.objectKey.length > 0 &&
            observation.filename === old.filename &&
            keyCheck.id === observation.id &&
            keyCheck.identityBytesAndKey === true &&
            keyCheck.rowSha256 === digest(observation) &&
            sha(keyCheck.requestIdentitySha256),
        );
        objectKeyObservation = {
          ...select(observation, [
            "id",
            "mediaId",
            "filename",
            "prefix",
            "objectKey",
            "filesize",
          ]),
          observedAt: keys.observedAt,
          historicalOnly: true,
        };
      }
      const holds = ["FRESH_NATIVE_METADATA_REQUIRED"];
      if (!observation) holds.push("OBJECT_KEY_UNOBSERVED");
      if (protections.rightsHold) holds.push("RIGHTS_HOLD");
      if (protections.withdrawn) holds.push("WITHDRAWN");
      const evidence = {
        catalogId: p.catalogId,
        sourceId: p.sourceId,
        mediaId: a.mediaId,
        nativeId: proof.nativeId,
        sourceSha256: a.sourceSha256,
        uploadedSha256: a.sha256,
        bytes: a.bytes,
        width: a.width,
        height: a.height,
        position: a.position,
        isRepresentative: a.isRepresentative,
        authenticatedFullByteReadback: true,
      };
      const entry = {
        entryId: a.assetId,
        recordId,
        evidence,
        plannedMetadata: {
          mimeType: a.mimeType,
          alt: a.alt,
          rights: a.rights ?? null,
          orderConfidence: a.orderConfidence ?? null,
        },
        objectKeyObservation,
        objectKey: observation?.objectKey ?? null,
        protections,
        state: "HOLD",
        holds,
      };
      entries.push({ ...entry, entrySha256: digest(entry) });
    }
    check(p.assets.filter((a) => a.isRepresentative).length === 1);
  }
  check(
    entries.length === sourceSpec.expectedMedia &&
      mediaIds.size === fullRows.size &&
      [...observedKeys.keys()].every((id) => mediaIds.has(id)) &&
      planned.has(withdrawn.reviewId),
  );
  const catalogIds = records.map((r) => r.catalogId).sort();
  const bundle = {
    version: 1,
    converter: await historicalConverterIdentity(),
    sourceSpec,
    originalTarget: {
      target: originalTarget,
      legacyIdentitySha256,
      legacyIdentityAlgorithm: "canonical-origin-instance-actor-v1",
      scopedIdentitySha256: digest({ ...originalTarget, catalogIds }),
      scopedIdentityAlgorithm: "canonical-target-role-sorted-catalogIds-v1",
    },
    provenance: {
      target: originalTarget,
      runId: final.runId,
      catalogIds,
      planSha256: file("plan").sha256,
      stateSha256: file("state").sha256,
      proofSha256: file("fullByteProof").sha256,
    },
    runRole: "final-native-metadata-validation-run",
    records,
    entries,
    claims: {
      currentNativeVerified: false,
      binaryBytesTransferredThisConversion: 0,
      backendWrites: 0,
      relationSidecarBackendRegistered: false,
      trainingLabelEligibility: false,
    },
  };
  return { ...bundle, bundleSha256: digest(bundle) };
}

/** Reload verification is regeneration from the original bytes, not hash-shape checks. */
export async function verifyHistoricalConversion(reference) {
  if (
    !exact(reference, [
      "converter",
      "sourceSpec",
      "bundleSha256",
      "entryId",
      "entrySha256",
    ]) ||
    !sha(reference.bundleSha256) ||
    !sha(reference.entrySha256) ||
    digest(reference.converter) !== digest(await historicalConverterIdentity())
  )
    fail("HISTORICAL_CONVERTER_CHANGED");
  const bundle = await convertHistoricalProof(reference.sourceSpec);
  const entry = bundle.entries.find((e) => e.entryId === reference.entryId);
  if (
    bundle.bundleSha256 !== reference.bundleSha256 ||
    !entry ||
    entry.entrySha256 !== reference.entrySha256
  )
    fail("HISTORICAL_CONVERSION_CHANGED");
  return { bundle, entry };
}

export function historicalConversionReference(bundle, entryId) {
  const entry = bundle.entries.find((e) => e.entryId === entryId);
  if (!entry) fail("HISTORICAL_ENTRY_MISSING");
  return {
    converter: bundle.converter,
    sourceSpec: bundle.sourceSpec,
    bundleSha256: bundle.bundleSha256,
    entryId,
    entrySha256: entry.entrySha256,
  };
}

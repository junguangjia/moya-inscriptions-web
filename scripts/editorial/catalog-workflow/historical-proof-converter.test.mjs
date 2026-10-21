import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, writeFile, rm, symlink, realpath } from "node:fs/promises";
import { Buffer } from "node:buffer";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { digest, targetIdentity } from "./identity.mjs";
import {
  importRegisteredMediaProof,
  validateRegisteredMediaProof,
} from "./registered-media-proof.mjs";
import {
  convertHistoricalProof,
  historicalConversionReference,
  verifyHistoricalConversion,
} from "./historical-proof-converter.mjs";

const H = "a".repeat(64),
  F = "b".repeat(64),
  C = "c".repeat(64);
const clone = (o) => JSON.parse(JSON.stringify(o));
const project = (a) => ({
  mediaId: a.mediaId,
  position: a.position,
  isRepresentative: a.isRepresentative,
});
async function frozenSources(t, change = () => {}) {
  const root = await realpath(
    await mkdtemp(path.join(tmpdir(), "historical-small-proof-")),
  );
  t.after(() => rm(root, { recursive: true, force: true }));
  const target = {
    origin: "http://127.0.0.1:12345",
    instance: "development",
    actorId: 1,
    role: "owner",
  };
  const files = [],
    hashes = {};
  const save = async (role, value) => {
    const bytes = JSON.stringify(value),
      p = path.join(root, role + ".json");
    await writeFile(p, bytes, { mode: 0o600 });
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    hashes[role] = sha256;
    files.push({ role, path: p, bytes: Buffer.byteLength(bytes), sha256 });
  };
  const records = [1, 2, 3].map((n) => ({
    reviewId: `TEST-${n}`,
    catalogId: `catalog-${n}`,
    sourceId: `source-${n}`,
    assets: [
      {
        assetId: `asset-${n}`,
        mediaId: `media-${n}`,
        sourceSha256: H,
        sha256: F,
        bytes: 12,
        width: 2,
        height: 3,
        position: 0,
        isRepresentative: true,
        // Deliberately nonexistent: conversion must never open this image.
        file: path.join(root, "MUST-NOT-OPEN.jpg"),
        mimeType: "image/jpeg",
        alt: "Synthetic",
      },
    ],
  }));
  const plan = {
    version: 1,
    origin: target.origin,
    reviewSha256: H,
    publication: false,
    records,
  };
  await save("plan", plan);
  const state = {
    version: 1,
    planBytesSha256: hashes.plan,
    reviewSha256: H,
    publication: false,
    targetIdentity: digest({
      origin: target.origin,
      instance: target.instance,
      actorId: target.actorId,
    }),
    records: Object.fromEntries(
      records.map((r, j) => [
        r.reviewId,
        {
          reviewId: r.reviewId,
          status: "verified",
          phase: "verified",
          id: j + 1,
          revision: 4,
          verifiedAssets: {
            [r.assets[0].assetId]: {
              mediaId: r.assets[0].mediaId,
              nativeId: 20 + j,
              filename: `synthetic-${j}.jpg`,
              sha256: F,
              bytes: 12,
              width: 2,
              height: 3,
              authenticatedFullByteReadback: true,
            },
          },
          finalDraftProof: {
            id: j + 1,
            revision: 4,
            fingerprint: F,
            contentSha256: C,
            media: r.assets.map(project),
            authenticatedFullByteReadback: true,
          },
        },
      ]),
    ),
  };
  await save("state", state);
  const full = {
    version: 1,
    status: "PASS",
    uploadPlanSha256: hashes.plan,
    uploadStateSha256: hashes.state,
    proofs: records.map((r, j) => ({
      reviewId: r.reviewId,
      assetId: r.assets[0].assetId,
      mediaId: r.assets[0].mediaId,
      nativeId: 20 + j,
      sha256: F,
      bytes: 12,
      width: 2,
      height: 3,
      authenticatedFullByteReadback: true,
    })),
  };
  change(full);
  await save("fullByteProof", full);
  const final = {
    readOnly: true,
    backendWrites: 0,
    mediaBytesDownloaded: 0,
    runId: "synthetic-final-run",
    records: records.map((r, j) => ({
      ...r,
      id: j + 1,
      revision: 4,
      fingerprint: F,
      contentSha256: C,
      media: r.assets.map(project),
      status: "PASS",
    })),
  };
  await save("finalMetadata", final);
  const intent = {
    origin: target.origin,
    actorId: 1,
    evidence: Object.fromEntries(
      [
        ["uploadPlan", "plan"],
        ["uploadState", "state"],
        ["fullByteProofs", "fullByteProof"],
        ["finalDraftReadback", "finalMetadata"],
      ].map(([k, role]) => [k, { sha256: hashes[role] }]),
    ),
    records: final.records.map((r, j) => ({
      ...r,
      action: j === 1 ? "hold" : "publish",
      holdReason: j === 1 ? "Rights unresolved" : undefined,
      revision: j === 0 ? 5 : 4,
    })),
  };
  await save("publicationIntent", intent);
  const withdrawal = {
    reviewId: "TEST-1",
    status: "withdrawn",
    expectedAfterRevision: 7,
    inputDigests: {
      uploadPlan: hashes.plan,
      publicationIntent: hashes.publicationIntent,
    },
    withdrawnProof: {
      ...final.records[0],
      revision: 7,
      status: "draft",
      nativeOwnerActorMatches: true,
    },
  };
  await save("withdrawal", withdrawal);
  const verified = {
    status: "PASS",
    readOnly: true,
    backendWrites: 0,
    cloudWrites: 0,
    inputDigests: {
      plan: hashes.plan,
      upload: hashes.state,
      intent: hashes.publicationIntent,
      readback: hashes.finalMetadata,
      receipt: hashes.withdrawal,
    },
    records: final.records.map((r, j) => ({
      ...r,
      revision: j === 0 ? 7 : 4,
      mediaCount: 1,
      gallerySha256: digest(r.media),
      status:
        j === 0 ? "DRAFT_REVISION_7_CONFIRMED" : "FROZEN_LATEST_UNCHANGED",
    })),
  };
  await save("withdrawalVerification", verified);
  const row = {
    id: 20,
    mediaId: "media-1",
    filename: "synthetic-0.jpg",
    prefix: "editorial",
    objectKey: "editorial/synthetic-0.jpg",
    filesize: 12,
  };
  await save("objectKeys", {
    status: "PASS",
    reviewId: "TEST-1",
    catalogId: "catalog-1",
    owner: { id: 1, role: "owner", verified: true },
    actualObjectKeyReadbackPerformed: true,
    observedAt: "2099-01-01T00:00:00.000Z",
    rows: [row],
    checks: [
      {
        id: 20,
        mediaId: "media-1",
        identityBytesAndKey: true,
        rowSha256: digest(row),
        requestIdentitySha256: H,
      },
    ],
    inputDigests: {
      plan: hashes.plan,
      execution: hashes.state,
      withdrawal: hashes.withdrawal,
      lastLiveVerification: hashes.withdrawalVerification,
    },
  });
  return { version: 1, target, expectedRecords: 3, expectedMedia: 3, files };
}

test("converter preserves distinct historical snapshots and unknown keys without reading images", async (t) => {
  const spec = await frozenSources(t),
    b = await convertHistoricalProof(spec);
  assert.equal(b.entries.length, 3);
  assert.equal(b.entries.filter((e) => e.objectKey !== null).length, 1);
  assert.ok(
    b.entries.every(
      (e) =>
        e.state === "HOLD" &&
        e.holds.includes("FRESH_NATIVE_METADATA_REQUIRED"),
    ),
  );
  assert.equal(b.entries[2].objectKey, null);
  assert.ok(b.entries[2].holds.includes("OBJECT_KEY_UNOBSERVED"));
  assert.equal(b.records[0].uploadedDraft.revision, 4);
  assert.equal(b.records[0].publicationIntentSnapshot.revision, 5);
  assert.equal(b.records[0].latestKnownNative.revision, 7);
  assert.equal(b.records[0].protections.withdrawn, true);
  assert.equal(b.records[1].protections.rightsHold, true);
  assert.equal(b.claims.binaryBytesTransferredThisConversion, 0);
  assert.equal(b.claims.currentNativeVerified, false);
  assert.equal(b.runRole, "final-native-metadata-validation-run");
  assert.notEqual(
    b.originalTarget.legacyIdentitySha256,
    b.originalTarget.scopedIdentitySha256,
  );
  assert.deepEqual(await convertHistoricalProof(spec), b);
  const ref = historicalConversionReference(b, "asset-3");
  assert.equal(
    (await verifyHistoricalConversion(ref)).entry.entrySha256,
    b.entries[2].entrySha256,
  );
  const evidence = b.entries[2].evidence,
    asset = Object.fromEntries(
      [
        "mediaId",
        "sourceSha256",
        "uploadedSha256",
        "bytes",
        "width",
        "height",
        "position",
        "isRepresentative",
      ].map((k) => [k, evidence[k]]),
    );
  const manifest = {
    version: 1,
    batchId: "converter-test",
    target: spec.target,
    records: [
      {
        recordId: "TEST-3",
        catalogId: "catalog-3",
        sourceId: "source-3",
        contentSha256: C,
        disposition: "draft",
        reuseOnly: true,
        protections: b.records[2].protections,
        media: [asset],
      },
    ],
  };
  const media = {
    id: 22,
    mediaId: "media-3",
    catalogId: "catalog-3",
    objectKey: "editorial/synthetic-3.jpg",
    sha256: F,
    mimeType: "image/jpeg",
    filesize: 12,
    filename: "synthetic-3.jpg",
    width: 2,
    height: 3,
    alt: "Synthetic",
  };
  const result = { docs: [media], totalDocs: 1 },
    receipt = {
      version: 1,
      executionKind: "local-http",
      scopeSha256: H,
      targetIdentitySha256: targetIdentity(manifest),
      requestSha256: C,
      route: "/api/media?where[mediaId][equals]=media-3&limit=1&depth=0",
      method: "GET",
      httpStatus: 200,
      transportStatus: "COMPLETE",
      responseSha256: F,
      resultSha256: digest(result),
      metadataSha256: digest(media),
    };
  const proof = importRegisteredMediaProof({
    manifest,
    recordId: "TEST-3",
    principal: {
      ...spec.target,
      verified: true,
      scopeCatalogIds: ["catalog-3"],
    },
    protections: b.records[2].protections,
    provenance: b.provenance,
    evidence,
    freshResult: result,
    nativeReceipt: receipt,
    scopeSha256: H,
    conversion: ref,
    conversionValidation: await verifyHistoricalConversion(ref),
  });
  const args = {
    manifest,
    recordId: "TEST-3",
    proof,
    scopeSha256: H,
    requests: [{ ...receipt, status: "COMPLETE", drained: true, receipt }],
  };
  assert.deepEqual(await validateRegisteredMediaProof(args), proof);
  const altered = clone(ref);
  altered.entrySha256 = H;
  await assert.rejects(verifyHistoricalConversion(altered), {
    code: "HISTORICAL_CONVERSION_CHANGED",
  });
  const rules = clone(ref);
  rules.converter.rulesSha256 = H;
  await assert.rejects(verifyHistoricalConversion(rules), {
    code: "HISTORICAL_CONVERTER_CHANGED",
  });
  await writeFile(spec.files[0].path, "{}");
  await assert.rejects(verifyHistoricalConversion(ref), {
    code: "HISTORICAL_SOURCE_CHANGED",
  });
  await assert.rejects(validateRegisteredMediaProof(args), {
    code: "HISTORICAL_SOURCE_CHANGED",
  });
});

test("converter rejects full-proof identity, duplicate Native identity and source target drift", async (t) => {
  for (const mutate of [
    (f) => {
      f.proofs[0].width++;
    },
    (f) => {
      f.proofs[1].nativeId = f.proofs[0].nativeId;
    },
    (f) => {
      f.proofs[0].reviewId = "TEST-2";
    },
    (f) => {
      f.uploadStateSha256 = H;
    },
  ]) {
    const spec = await frozenSources(t, mutate);
    await assert.rejects(convertHistoricalProof(spec), {
      code: "HISTORICAL_SOURCE_INCONSISTENT",
    });
  }
  const spec = await frozenSources(t);
  spec.target.actorId = 2;
  await assert.rejects(convertHistoricalProof(spec), {
    code: "HISTORICAL_SOURCE_INCONSISTENT",
  });
});

test("only exact bounded regular JSON inputs are admitted", async (t) => {
  const spec = await frozenSources(t),
    changed = clone(spec);
  changed.files[0].bytes = 2 * 1024 * 1024 + 1;
  await assert.rejects(convertHistoricalProof(changed), {
    code: "HISTORICAL_SOURCE_SPEC_INVALID",
  });
  const linked = spec.files[0].path + ".linked.json";
  await symlink(spec.files[0].path, linked);
  spec.files[0].path = linked;
  await assert.rejects(convertHistoricalProof(spec), {
    code: "HISTORICAL_SOURCE_PATH_REJECTED",
  });
});

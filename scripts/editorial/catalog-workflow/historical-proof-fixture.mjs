// Small synthetic source archive reused by Production proof seam tests.
import { mkdtemp, writeFile, rm, realpath } from "node:fs/promises";
import { Buffer } from "node:buffer";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { digest } from "./identity.mjs";
const H = "a".repeat(64),
  F = "b".repeat(64),
  C = "c".repeat(64);
const project = (a) => ({
  mediaId: a.mediaId,
  position: a.position,
  isRepresentative: a.isRepresentative,
});
export async function frozenSources(t, change = () => {}, options = {}) {
  const root = await realpath(
    await mkdtemp(path.join(tmpdir(), "historical-small-proof-")),
  );
  t.after(() => rm(root, { recursive: true, force: true }));
  const target = options.target ?? {
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
  const observed = options.observedRecordIndex ?? 0;
  const row = {
    id: 20 + observed,
    mediaId: `media-${observed + 1}`,
    filename: `synthetic-${observed}.jpg`,
    prefix: "editorial",
    objectKey: `editorial/synthetic-${observed}.jpg`,
    filesize: 12,
  };
  await save("objectKeys", {
    status: "PASS",
    reviewId: `TEST-${observed + 1}`,
    catalogId: `catalog-${observed + 1}`,
    owner: { id: 1, role: "owner", verified: true },
    actualObjectKeyReadbackPerformed: true,
    observedAt: "2099-01-01T00:00:00.000Z",
    rows: [row],
    checks: [
      {
        id: 20 + observed,
        mediaId: `media-${observed + 1}`,
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

import assert from "node:assert/strict";
import test from "node:test";
import { digest, targetIdentity } from "./identity.mjs";
import { mediaIdentity } from "./local-native-adapter.mjs";
import { clone, fixture, hash, protection } from "./test-fixtures.mjs";
import {
  importRegisteredMediaProof,
  nativeMediaMetadataProjection,
  validateRegisteredMediaProof,
} from "./registered-media-proof.mjs";

function syntheticEvidence() {
  const manifest = fixture({ reuseOnly: true }),
    record = manifest.records[0],
    asset = record.media[0];
  const freshResult = {
    docs: [
      {
        id: 20,
        mediaId: asset.mediaId,
        catalogId: record.catalogId,
        objectKey: "editorial/synthetic.png",
        sha256: asset.uploadedSha256,
        mimeType: "image/png",
        filesize: asset.bytes,
        filename: "synthetic.png",
        width: asset.width,
        height: asset.height,
        alt: "Synthetic registered media",
        rights: null,
        orderConfidence: null,
        createdAt: "2099-01-01T00:00:00.000Z",
      },
    ],
    totalDocs: 1,
  };
  return {
    manifest,
    recordId: record.recordId,
    principal: {
      ...manifest.target,
      verified: true,
      scopeCatalogIds: [record.catalogId],
    },
    protections: protection(),
    scopeSha256: hash("d"),
    provenance: {
      target: clone(manifest.target),
      runId: "synthetic-old-run",
      catalogIds: [record.catalogId],
      planSha256: hash("a"),
      stateSha256: hash("b"),
      proofSha256: hash("c"),
    },
    evidence: {
      catalogId: record.catalogId,
      sourceId: record.sourceId,
      ...asset,
      nativeId: 20,
      authenticatedFullByteReadback: true,
    },
    freshResult,
    nativeReceipt: {
      version: 1,
      executionKind: "local-http",
      scopeSha256: hash("d"),
      targetIdentitySha256: targetIdentity(manifest),
      requestSha256: hash("e"),
      route: `/api/media?where[mediaId][equals]=${asset.mediaId}&limit=1&depth=0`,
      method: "GET",
      httpStatus: 200,
      transportStatus: "COMPLETE",
      responseSha256: hash("f"),
      resultSha256: digest(freshResult),
      metadataSha256: digest(nativeMediaMetadataProjection(freshResult)),
    },
  };
}
const throws = (fn, code) => assert.throws(fn, (error) => error.code === code);

test("Native optional null metadata is omitted while required and non-null fields stay strict", () => {
  const input = syntheticEvidence(),
    record = input.manifest.records[0],
    asset = record.media[0],
    raw = input.freshResult.docs[0],
    mapping = {
      mimeType: raw.mimeType,
      alt: raw.alt,
      rights: null,
      orderConfidence: null,
    },
    before = clone(input.freshResult),
    projected = nativeMediaMetadataProjection(input.freshResult);
  assert.equal(Object.hasOwn(projected, "rights"), false);
  assert.equal(Object.hasOwn(projected, "orderConfidence"), false);
  assert.deepEqual(mediaIdentity(record, asset, mapping, raw), projected);
  assert.deepEqual(importRegisteredMediaProof(input).media, projected);
  assert.deepEqual(input.freshResult, before);
  assert.equal(digest(input.freshResult), input.nativeReceipt.resultSha256);
  const omitted = clone(raw);
  delete omitted.rights;
  delete omitted.orderConfidence;
  assert.deepEqual(
    nativeMediaMetadataProjection({ docs: [omitted], totalDocs: 1 }),
    projected,
  );
  assert.deepEqual(mediaIdentity(record, asset, mapping, omitted), projected);
  const present = {
    ...raw,
    rights: "Synthetic rights",
    orderConfidence: "HIGH",
  };
  const preserved = nativeMediaMetadataProjection({
    docs: [present],
    totalDocs: 1,
  });
  assert.equal(preserved.rights, present.rights);
  assert.equal(preserved.orderConfidence, present.orderConfidence);
  assert.deepEqual(
    mediaIdentity(
      record,
      asset,
      {
        ...mapping,
        rights: present.rights,
        orderConfidence: present.orderConfidence,
      },
      present,
    ),
    preserved,
  );
  for (const patch of [
    { rights: 7 },
    { orderConfidence: "INVALID" },
    { id: null },
    { objectKey: null },
    { sha256: null },
    { width: null },
  ]) {
    const invalid = { ...raw, ...patch };
    assert.throws(() =>
      nativeMediaMetadataProjection({ docs: [invalid], totalDocs: 1 }),
    );
    assert.throws(() => mediaIdentity(record, asset, mapping, invalid));
  }
});

test("normalized historical proof binds current Native metadata without counting historical binary as current transfer", () => {
  const input = syntheticEvidence(),
    proof = importRegisteredMediaProof(input);
  assert.equal(proof.media.id, 20);
  assert.equal(proof.media.objectKey, "editorial/synthetic.png");
  assert.equal(proof.sourceSha256, input.evidence.sourceSha256);
  assert.match(proof.evidenceSha256, /^[a-f0-9]{64}$/);
  assert.equal(Object.hasOwn(proof, "binaryBodyBytes"), false);
  const second = syntheticEvidence();
  second.provenance.proofSha256 = hash("f");
  assert.notEqual(
    importRegisteredMediaProof(second).evidenceSha256,
    proof.evidenceSha256,
  );
});

test("historical Production/actor/origin evidence cannot become isolated evidence", () => {
  for (const patch of [
    { instance: "production", origin: "https://example.invalid" },
    { actorId: 2 },
    { origin: "http://127.0.0.1:54321" },
  ]) {
    const input = syntheticEvidence();
    Object.assign(input.provenance.target, patch);
    throws(
      () => importRegisteredMediaProof(input),
      "HISTORICAL_PROOF_SCOPE_CHANGED",
    );
  }
  const input = syntheticEvidence();
  input.principal.actorId = 2;
  throws(() => importRegisteredMediaProof(input), "PRINCIPAL_OR_SCOPE_CHANGED");
});

test("Native response and its request receipt must agree on target scope route and exact result", () => {
  const mutations = [
    (row) => {
      row.nativeReceipt.targetIdentitySha256 = hash("f");
    },
    (row) => {
      row.nativeReceipt.scopeSha256 = hash("f");
    },
    (row) => {
      row.nativeReceipt.route =
        "/api/media?where[mediaId][equals]=media-other&limit=1&depth=0";
    },
    (row) => {
      row.nativeReceipt.transportStatus = "UNKNOWN";
    },
    (row) => {
      row.freshResult.docs[0].objectKey = "editorial/different.png";
    },
    (row) => {
      row.nativeReceipt.resultSha256 = hash("f");
    },
  ];
  for (const mutate of mutations) {
    const input = syntheticEvidence();
    mutate(input);
    throws(
      () => importRegisteredMediaProof(input),
      "NATIVE_METADATA_RECEIPT_MISMATCH",
    );
  }
});

test("fresh Native identity/hash/dimensions must match the prior full-byte proof", () => {
  for (const patch of [
    { id: 21 },
    { sha256: hash("f") },
    { filesize: 101 },
    { width: 101 },
  ]) {
    const input = syntheticEvidence();
    Object.assign(input.freshResult.docs[0], patch);
    input.nativeReceipt.resultSha256 = digest(input.freshResult);
    input.nativeReceipt.metadataSha256 = digest(
      nativeMediaMetadataProjection(input.freshResult),
    );
    throws(
      () => importRegisteredMediaProof(input),
      "NATIVE_MEDIA_IDENTITY_MISMATCH",
    );
  }
  const missing = syntheticEvidence();
  delete missing.freshResult.docs[0].objectKey;
  missing.nativeReceipt.resultSha256 = digest(missing.freshResult);
  assert.throws(() => importRegisteredMediaProof(missing));
});

test("persisted import re-computes its audit and matches the exact owned receipt row", async () => {
  const input = syntheticEvidence(),
    proof = importRegisteredMediaProof(input);
  const args = {
    proof,
    manifest: input.manifest,
    recordId: input.recordId,
    scopeSha256: input.scopeSha256,
    requests: [
      {
        requestSha256: input.nativeReceipt.requestSha256,
        status: "COMPLETE",
        drained: true,
        httpStatus: 200,
        route: input.nativeReceipt.route,
        method: "GET",
        responseSha256: input.nativeReceipt.responseSha256,
        receipt: clone(input.nativeReceipt),
      },
    ],
  };
  assert.deepEqual(await validateRegisteredMediaProof(args), proof);
  const changed = clone(args);
  changed.proof.audit.provenance.proofSha256 = hash("e");
  await assert.rejects(validateRegisteredMediaProof(changed), {
    code: "HISTORICAL_AUDIT_INVALID",
  });
  for (const mutate of [
    (a) => {
      a.requests = [];
    },
    (a) => {
      a.requests.push(clone(a.requests[0]));
    },
    (a) => {
      a.requests[0].receipt.resultSha256 = hash("e");
    },
    (a) => {
      a.requests[0].status = "UNKNOWN";
    },
  ]) {
    const a = clone(args);
    mutate(a);
    await assert.rejects(validateRegisteredMediaProof(a), {
      code: "NATIVE_METADATA_RECEIPT_MISMATCH",
    });
  }
  const stripped = clone(args);
  delete stripped.proof.audit;
  await assert.rejects(validateRegisteredMediaProof(stripped), {
    code: "HISTORICAL_AUDIT_INVALID",
  });
});

test("full-byte evidence and current hold/withdrawal protection cannot be omitted", () => {
  const partial = syntheticEvidence();
  partial.evidence.authenticatedFullByteReadback = false;
  throws(
    () => importRegisteredMediaProof(partial),
    "HISTORICAL_MEDIA_PROOF_MISMATCH",
  );
  for (const key of ["rightsHold", "explicitlyHidden", "withdrawn"]) {
    const input = syntheticEvidence();
    input.protections[key] = true;
    throws(() => importRegisteredMediaProof(input), "PROTECTED_RECORD");
  }
});

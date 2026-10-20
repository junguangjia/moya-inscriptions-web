import assert from "node:assert/strict";
import test from "node:test";
import { digest } from "./identity.mjs";
import {
  createTransferBudget,
  markTransferDrained,
  openTransferBudget,
  reserveTransfer,
  reusableMediaProof,
  runBudgetedOfflineRequest,
  selectIntegrityVerification,
  settleTransfer,
  transferUsage,
} from "./transfer-budget.mjs";
import { clone, fixture, hash } from "./test-fixtures.mjs";

const limits = () => ({
  maxRequests: 4,
  maxUploadBytes: 200,
  maxDownloadBytes: 200,
  maxAttempts: 2,
  concurrency: 1,
  chunkBytes: 64,
});
const configured = () => ({ maxAttempts: 2, concurrency: 1, chunkBytes: 64 });
const ledger = () => createTransferBudget(hash("a"), limits(), configured());
const request = (key = "b") => ({
  requestSha256: hash(key),
  maximumUploadBytes: 100,
  maximumDownloadBytes: 100,
});
const observation = (patch = {}) => ({
  requestSha256: hash("b"),
  attempt: 1,
  status: "COMPLETE",
  actualUploadBytes: 100,
  actualDownloadBytes: 100,
  evidenceSha256: hash("e"),
  ...patch,
});
const throws = (fn, code) => assert.throws(fn, (e) => e.code === code);

test("successful identity rerun reuses proof and adds zero transfers or bytes", () => {
  const cp = ledger();
  reserveTransfer(cp, request());
  settleTransfer(cp, observation());
  const restored = openTransferBudget(cp, hash("a"), limits(), configured());
  const before = transferUsage(restored);
  for (let i = 0; i < 3; i++)
    assert.equal(reserveTransfer(restored, request()).status, "REUSE_VERIFIED");
  assert.deepEqual(transferUsage(restored), before);
  assert.equal(before.requests, 1);
});

test("request and byte admission reject before another reservation", () => {
  for (const key of ["maxRequests", "maxUploadBytes", "maxDownloadBytes"]) {
    const cap = limits();
    cap[key] = key === "maxRequests" ? 0 : 99;
    const cp = createTransferBudget(hash("a"), cap, configured());
    throws(() => reserveTransfer(cp, request()), "TRANSFER_BUDGET_EXCEEDED");
    assert.equal(cp.requests.length, 0);
  }
});

test("pending and unknown outcomes reserve full cost and cannot silently retry", () => {
  const cp = ledger();
  reserveTransfer(cp, request());
  throws(
    () => reserveTransfer(cp, request()),
    "TRANSFER_RECONCILIATION_REQUIRED",
  );
  settleTransfer(
    cp,
    observation({
      status: "UNKNOWN",
      actualUploadBytes: null,
      actualDownloadBytes: null,
      evidenceSha256: null,
    }),
  );
  const usage = transferUsage(cp);
  assert.equal(usage.chargedDownloadBytes, 100);
  assert.equal(usage.knownActualDownloadBytes, 0);
  assert.equal(usage.incompleteMeasurements, 1);
  throws(
    () => reserveTransfer(cp, request()),
    "TRANSFER_RECONCILIATION_REQUIRED",
  );
});

test("failed known requests retain actual bytes and retry limit is finite", () => {
  const cp = ledger();
  reserveTransfer(cp, request());
  settleTransfer(
    cp,
    observation({
      status: "FAILED",
      actualUploadBytes: 20,
      actualDownloadBytes: 5,
      evidenceSha256: null,
    }),
  );
  assert.equal(reserveTransfer(cp, request()).attempt, 2);
  settleTransfer(
    cp,
    observation({
      attempt: 2,
      status: "FAILED",
      actualUploadBytes: 20,
      actualDownloadBytes: 5,
      evidenceSha256: null,
    }),
  );
  throws(() => reserveTransfer(cp, request()), "TRANSFER_RETRY_LIMIT");
  assert.equal(transferUsage(cp).knownActualUploadBytes, 40);
});

test("unknown outcome cannot become an unproved zero-byte failure to release its reservation", () => {
  const cp = ledger();
  reserveTransfer(cp, request());
  settleTransfer(
    cp,
    observation({
      status: "UNKNOWN",
      actualUploadBytes: null,
      actualDownloadBytes: null,
      evidenceSha256: null,
    }),
  );
  throws(
    () =>
      settleTransfer(
        cp,
        observation({
          status: "FAILED",
          actualUploadBytes: 0,
          actualDownloadBytes: 0,
          evidenceSha256: null,
        }),
      ),
    "TRANSFER_OBSERVATION_INVALID",
  );
  assert.equal(transferUsage(cp).chargedUploadBytes, 100);
  assert.equal(transferUsage(cp).chargedDownloadBytes, 100);
  throws(
    () => reserveTransfer(cp, request()),
    "TRANSFER_RECONCILIATION_REQUIRED",
  );
});

test("confirmed connection close releases its slot while retaining unknown cost and retry protection", () => {
  const cp = ledger();
  reserveTransfer(cp, request());
  settleTransfer(
    cp,
    observation({
      status: "UNKNOWN",
      actualUploadBytes: 25,
      actualDownloadBytes: 1,
      evidenceSha256: null,
    }),
  );
  markTransferDrained(cp, hash("b"), hash("e"));
  assert.equal(transferUsage(cp).chargedUploadBytes, 100);
  assert.equal(transferUsage(cp).chargedDownloadBytes, 100);
  assert.equal(reserveTransfer(cp, request("c")).status, "PENDING");
  throws(
    () => reserveTransfer(cp, request()),
    "TRANSFER_RECONCILIATION_REQUIRED",
  );
});

test("local HTTP and offline fake ledgers cannot adopt each other's results", () => {
  const cp = createTransferBudget(
    hash("a"),
    limits(),
    configured(),
    "local-http",
  );
  throws(
    () => openTransferBudget(cp, hash("a"), limits(), configured()),
    "TRANSFER_BUDGET_SCOPE_CHANGED",
  );
  throws(
    () =>
      openTransferBudget(
        ledger(),
        hash("a"),
        limits(),
        configured(),
        "local-http",
      ),
    "TRANSFER_BUDGET_SCOPE_CHANGED",
  );
});

test("configured chunk, concurrency and attempt limits cannot be enlarged by caller", () => {
  for (const key of ["chunkBytes", "concurrency", "maxAttempts"]) {
    const cap = limits();
    cap[key]++;
    throws(
      () => createTransferBudget(hash("a"), cap, configured()),
      "TRANSFER_LIMITS_INVALID",
    );
  }
  const cp = ledger();
  reserveTransfer(cp, request());
  throws(() => reserveTransfer(cp, request("c")), "TRANSFER_CONCURRENCY_LIMIT");
});

test("actual overrun is retained and blocks every subsequent new request", () => {
  const cp = ledger();
  reserveTransfer(cp, request());
  const usage = settleTransfer(cp, observation({ actualDownloadBytes: 101 }));
  assert.equal(usage.knownActualDownloadBytes, 101);
  assert.equal(usage.overBudget, true);
  throws(() => reserveTransfer(cp, request("c")), "TRANSFER_BUDGET_EXCEEDED");
});

test("unknown connections retain concurrency and known partial bytes cannot decrease", () => {
  const cp = ledger();
  reserveTransfer(cp, request());
  settleTransfer(
    cp,
    observation({
      status: "UNKNOWN",
      actualUploadBytes: 25,
      actualDownloadBytes: 1,
      evidenceSha256: null,
    }),
  );
  throws(() => reserveTransfer(cp, request("c")), "TRANSFER_CONCURRENCY_LIMIT");
  throws(
    () => settleTransfer(cp, observation({ actualUploadBytes: 24 })),
    "TRANSFER_OBSERVATION_INVALID",
  );
  throws(
    () =>
      settleTransfer(
        cp,
        observation({ status: "UNKNOWN", actualUploadBytes: null }),
      ),
    "TRANSFER_OBSERVATION_INVALID",
  );
  assert.equal(transferUsage(cp).knownActualUploadBytes, 25);
  assert.equal(transferUsage(cp).chargedUploadBytes, 100);
  assert.equal(transferUsage(cp).chargedDownloadBytes, 100);
});

test("unknown checksum capability stops unless full integrity read has an explicit byte budget", () => {
  const expected = {
    scopeSha256: hash("a"),
    uploadedSha256: hash("b"),
    bytes: 100,
  };
  const capabilities = {
    existingProofMatched: false,
    serverChecksum: { status: "UNKNOWN" },
    sameRegionVerification: null,
    fullReadbackBudgetBytes: null,
  };
  throws(
    () => selectIntegrityVerification(expected, capabilities),
    "INTEGRITY_CAPABILITY_UNVERIFIED",
  );
  throws(
    () =>
      selectIntegrityVerification(expected, {
        ...capabilities,
        fullReadbackBudgetBytes: 99,
      }),
    "INTEGRITY_CAPABILITY_UNVERIFIED",
  );
  assert.equal(
    selectIntegrityVerification(expected, {
      ...capabilities,
      fullReadbackBudgetBytes: 100,
    }),
    "EXPLICITLY_BUDGETED_FULL_READBACK",
  );
  const checksum = {
    status: "VERIFIED",
    scopeSha256: hash("a"),
    algorithm: "SHA256",
    sha256: hash("b"),
    evidenceSha256: hash("e"),
  };
  assert.equal(
    selectIntegrityVerification(expected, {
      ...capabilities,
      serverChecksum: checksum,
    }),
    "SERVER_SHA256",
  );
  throws(
    () =>
      selectIntegrityVerification(expected, {
        ...capabilities,
        serverChecksum: { ...checksum, algorithm: "ETAG" },
      }),
    "INTEGRITY_CAPABILITY_UNVERIFIED",
  );
  throws(
    () =>
      selectIntegrityVerification(expected, {
        ...capabilities,
        serverChecksum: { ...checksum, scopeSha256: hash("f") },
      }),
    "INTEGRITY_CAPABILITY_UNVERIFIED",
  );
});

test("checkpoint scope, budget, request envelope and ledger corruption are rejected", () => {
  const cp = ledger();
  reserveTransfer(cp, request());
  throws(
    () => openTransferBudget(cp, hash("f"), limits(), configured()),
    "TRANSFER_BUDGET_SCOPE_CHANGED",
  );
  throws(
    () =>
      openTransferBudget(
        cp,
        hash("a"),
        { ...limits(), maxRequests: 5 },
        configured(),
      ),
    "TRANSFER_BUDGET_SCOPE_CHANGED",
  );
  throws(
    () => reserveTransfer(cp, { ...request(), maximumDownloadBytes: 1 }),
    "TRANSFER_REQUEST_CHANGED",
  );
  const corrupt = clone(cp);
  corrupt.requests[0].sessionToken = "SYNTHETIC_ONLY";
  throws(
    () => openTransferBudget(corrupt, hash("a"), limits(), configured()),
    "TRANSFER_LEDGER_INVALID",
  );
  const duplicate = clone(cp);
  duplicate.requests.push(clone(duplicate.requests[0]));
  throws(
    () => openTransferBudget(duplicate, hash("a"), limits(), configured()),
    "TRANSFER_LEDGER_INVALID",
  );
});

test("proof reuse requires exact source/output hashes, identity, bytes and dimensions", () => {
  const record = fixture().records[0],
    asset = record.media[0];
  const proof = {
    verified: true,
    catalogId: record.catalogId,
    sourceId: record.sourceId,
    ...asset,
    evidenceSha256: hash("e"),
  };
  proof.sourceBinding = {
    kind: "IMMUTABLE_SOURCE",
    verified: true,
    evidenceSha256: hash("e"),
    identitySha256: digest({
      catalogId: record.catalogId,
      sourceId: record.sourceId,
      mediaId: asset.mediaId,
      uploadedSha256: asset.uploadedSha256,
      bytes: asset.bytes,
      width: asset.width,
      height: asset.height,
    }),
  };
  assert.equal(reusableMediaProof(record, asset, proof), true);
  for (const key of [
    "catalogId",
    "sourceId",
    "mediaId",
    "sourceSha256",
    "uploadedSha256",
    "bytes",
    "width",
    "height",
    "evidenceSha256",
  ]) {
    const changed = {
      ...proof,
      [key]: typeof proof[key] === "number" ? proof[key] + 1 : "wrong",
    };
    assert.equal(reusableMediaProof(record, asset, changed), false);
  }
  assert.equal(
    reusableMediaProof(record, asset, { verified: true, bytes: asset.bytes }),
    false,
  );
  assert.equal(
    reusableMediaProof(record, asset, { ...proof, sourceBinding: null }),
    false,
  );
  const versioned = {
    ...proof,
    sourceBinding: {
      ...proof.sourceBinding,
      kind: "REMOTE_VERSION",
      versionSha256: hash("f"),
    },
  };
  assert.equal(reusableMediaProof(record, asset, versioned), false);
  const current = {
    verified: true,
    fresh: true,
    identitySha256: proof.sourceBinding.identitySha256,
    versionSha256: hash("f"),
    evidenceSha256: hash("e"),
  };
  assert.equal(reusableMediaProof(record, asset, versioned, current), true);
  assert.equal(
    reusableMediaProof(record, asset, versioned, { ...current, fresh: false }),
    false,
  );
  assert.equal(
    reusableMediaProof(record, asset, versioned, {
      ...current,
      versionSha256: hash("a"),
    }),
    false,
  );
});

test("reused binary proof transfers zero body bytes while metadata still consumes its request budget", () => {
  const cp = ledger();
  reserveTransfer(cp, request());
  settleTransfer(cp, observation());
  const initial = transferUsage(cp);
  reserveTransfer(cp, request());
  const repeated = transferUsage(cp);
  assert.equal(
    repeated.knownActualUploadBytes - initial.knownActualUploadBytes,
    0,
  );
  assert.equal(
    repeated.knownActualDownloadBytes - initial.knownActualDownloadBytes,
    0,
  );
  reserveTransfer(cp, {
    requestSha256: hash("c"),
    maximumUploadBytes: 0,
    maximumDownloadBytes: 32,
  });
  settleTransfer(
    cp,
    observation({
      requestSha256: hash("c"),
      actualUploadBytes: 0,
      actualDownloadBytes: 32,
    }),
  );
  assert.equal(transferUsage(cp).requests, initial.requests + 1);
  assert.equal(
    transferUsage(cp).knownActualDownloadBytes,
    initial.knownActualDownloadBytes + 32,
  );
});

test("budgeted fake port rejects over budget before dispatch and reuses success with zero body bytes", async () => {
  let dispatches = 0,
    persisted = null;
  const cp = ledger();
  const options = {
    executionKind: "offline-fake",
    ledger: cp,
    descriptor: request(),
    now: () => 0,
    deadline: 1,
    persist: async (value) => {
      persisted = value;
    },
    port: {
      kind: "offline-fake",
      dispatch: async () => {
        dispatches++;
        assert.equal(persisted.requests[0].status, "PENDING");
        return {
          status: "COMPLETE",
          actualUploadBytes: 100,
          actualDownloadBytes: 100,
          evidenceSha256: hash("e"),
        };
      },
    },
  };
  assert.equal((await runBudgetedOfflineRequest(options)).liveE2E, false);
  const prior = transferUsage(cp);
  assert.equal(
    (await runBudgetedOfflineRequest(options)).status,
    "REUSE_VERIFIED",
  );
  assert.equal(dispatches, 1);
  assert.deepEqual(transferUsage(cp), prior);
  const cap = limits();
  cap.maxRequests = 0;
  await assert.rejects(
    () =>
      runBudgetedOfflineRequest({
        ...options,
        ledger: createTransferBudget(hash("a"), cap, configured()),
      }),
    (e) => e.code === "TRANSFER_BUDGET_EXCEEDED",
  );
  assert.equal(dispatches, 1);
  await assert.rejects(
    () =>
      runBudgetedOfflineRequest({ ...options, executionKind: "production" }),
    (e) => e.code === "LIVE_ADAPTER_NOT_BOUND",
  );
  assert.equal(dispatches, 1);
});

test("budget pending persistence failure and expired deadline prevent fake dispatch", async () => {
  let dispatches = 0,
    now = 0;
  const options = {
    executionKind: "offline-fake",
    ledger: ledger(),
    descriptor: request(),
    now: () => now,
    deadline: 1,
    persist: async () => {
      throw new Error("SYNTHETIC_DISK_FAILURE");
    },
    port: {
      kind: "offline-fake",
      dispatch: async () => {
        dispatches++;
      },
    },
  };
  await assert.rejects(() => runBudgetedOfflineRequest(options));
  assert.equal(dispatches, 0);
  await assert.rejects(
    () =>
      runBudgetedOfflineRequest({
        ...options,
        ledger: ledger(),
        persist: async () => {
          now = 1;
        },
      }),
    (e) => e.code === "WORKFLOW_DEADLINE_EXCEEDED",
  );
  assert.equal(dispatches, 0);
});

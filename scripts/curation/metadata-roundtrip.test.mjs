import test from "node:test";
import { Buffer } from "node:buffer";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdtemp,
  writeFile,
  readFile,
  appendFile,
  chmod,
  symlink,
  unlink,
  open,
  link,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import process from "node:process";
import path from "node:path";
import { URL } from "node:url";
import { metadataRoundtrip } from "./metadata-roundtrip.mjs";
import {
  runBatch,
  createTransport,
  createMetadataTransport,
  prepareItems,
} from "../editorial/batch.mjs";
import {
  decodeCurationMetadata,
  deriveCurationMetadataCounts,
} from "../../packages/contracts/dist/internal/editorial/index.js";

const { Response, AbortController } = globalThis;

const sha = "a".repeat(64);
const fixture = (count = 83) => ({
  schemaVersion: "artvenn-curation-metadata/v1",
  sourceHashPolicy: "registry_recorded_not_reverified",
  publicationPacketSha256: sha,
  catalogId: "synthetic-catalog",
  sourceId: "synthetic-source",
  objectId: "object-1",
  draftBaseline: {
    id: 5,
    revision: 2,
    fingerprint: sha,
    status: "draft",
    displayMediaIds: ["media-0"],
    coverMediaId: "media-0",
  },
  review: { id: "review-1", revision: 1 },
  photos: Array.from({ length: count }, (_, position) => ({
    assetId: `asset-${position}`,
    nativeId: position + 1,
    mediaId: `media-${position}`,
    sourceSha256: sha,
    uploadedSha256: "b".repeat(64),
    derivativeVersion: "synthetic-v1",
    position,
    role: "detail",
    frame: {
      version: "artvenn-original-frame/v1",
      assetId: `asset-${position}`,
      sourceSha256: sha,
      width: 6000,
      height: 4000,
      exifOrientation: 1,
      coordinateSystem: "original_encoded_pixels_top_left",
      orientationApplied: false,
    },
    processing: { source: null, preview: null },
  })),
  sourceGroups: [
    {
      id: "source-group",
      assetIds: Array.from({ length: count }, (_, n) => `asset-${n}`),
      originalRecordSha256: sha,
      originalMemberCount: count,
      excludedCount: 0,
      provenance: { kind: "manual-selection" },
    },
  ],
  annotations: {
    current_annotations: [],
    annotation_revisions: [],
    annotation_decisions: [],
  },
  history: {
    proposals: [],
    decisions: [],
    reviewDecisions: [],
    annotationSnapshots: [],
    fieldProvenance: [],
    facts: [],
    relationships: [],
  },
  modelRuns: [],
});
const digest = (value) => createHash("sha256").update(value).digest("hex");
const response = (result, status = 200) =>
  new Response(JSON.stringify(result), {
    status,
    headers: { "Content-Type": "application/json" },
  });
async function files(value = fixture()) {
  const root = await mkdtemp(path.join(tmpdir(), "metadata-client-test-"));
  const metadataFile = path.join(root, "snapshot.json");
  const configFile = path.join(root, "config.json");
  const payloadJSON = JSON.stringify(value);
  await writeFile(metadataFile, payloadJSON, { mode: 0o600 });
  await writeFile(
    configFile,
    JSON.stringify({
      baseURL: "http://127.0.0.1:37891",
      apiKey: "synthetic-test-only",
      attempts: 1,
      budgetMs: 2000,
    }),
    { mode: 0o600 },
  );
  return {
    metadataFile,
    configFile,
    stateDirectory: path.join(root, "receipts"),
    payloadJSON,
  };
}
function server(payloadJSON, behavior = {}) {
  const routes = [];
  let commits = 0;
  let record;
  const fetchImpl = async (url, request) => {
    const route = new URL(url).pathname;
    routes.push(route);
    const body = JSON.parse(request.body);
    if (route.endsWith("save-curation-metadata")) {
      if (behavior.transient503) {
        behavior.transient503 = false;
        return response({ ok: false }, 503);
      }
      if (!record) {
        commits += 1;
        record = {
          id: 1,
          catalogId: "synthetic-catalog",
          payloadJSON,
          snapshotSha256: digest(payloadJSON),
          previousSha256: null,
          createdAt: "2026-10-13T00:00:00.000Z",
          current: true,
          counts: deriveCurationMetadataCounts(
            decodeCurationMetadata(payloadJSON),
          ),
        };
      }
      assert.equal(body.payloadJSON, payloadJSON);
      if (behavior.lostReply) {
        behavior.lostReply = false;
        throw new Error("synthetic lost reply");
      }
      if (behavior.aborted) {
        behavior.aborted.abort();
        throw new Error("synthetic interruption");
      }
      return response({
        ok: true,
        result: { ...record, replayed: commits === 1 },
      });
    }
    assert.equal(route, "/api/editorial/read-curation-metadata");
    if (behavior.failRead) {
      behavior.failRead = false;
      return response({ ok: false }, 503);
    }
    return response({
      ok: true,
      result: {
        ...record,
        ...(Object.hasOwn(behavior, "invalidCurrent")
          ? { current: behavior.invalidCurrent }
          : {}),
        ...(behavior.wrongIdentity ? { catalogId: "different-catalog" } : {}),
        ...(behavior.corruptRead ? { payloadJSON: `${payloadJSON} ` } : {}),
        ...(behavior.historical ? { current: false } : {}),
        ...(behavior.wrongCounts
          ? { counts: { ...record.counts, photos: 1 } }
          : {}),
      },
    });
  };
  return { fetchImpl, routes, commits: () => commits };
}

test("offline 83-photo validation leaves one display and makes zero requests", async () => {
  const input = await files();
  let calls = 0;
  const result = await metadataRoundtrip({
    ...input,
    fetchImpl: () => {
      calls += 1;
    },
  });
  assert.equal(result.status, "OFFLINE_VALIDATED");
  assert.equal(result.counts.photos, 83);
  assert.equal(calls, 0);
  assert.equal(
    JSON.parse(await readFile(input.metadataFile)).draftBaseline.displayMediaIds
      .length,
    1,
  );
});
test("commit and full readback, then duplicate reopening verifies again without duplicate commits", async () => {
  const input = await files();
  const remote = server(input.payloadJSON);
  const first = await metadataRoundtrip({
    ...input,
    execute: true,
    fetchImpl: remote.fetchImpl,
  });
  const second = await metadataRoundtrip({
    ...input,
    execute: true,
    fetchImpl: remote.fetchImpl,
  });
  assert.equal(first.status, "PERSISTED_AND_READBACK_VERIFIED");
  assert.equal(second.status, first.status);
  assert.equal(remote.commits(), 1);
  assert.equal(remote.routes.length, 4);
  assert.ok(
    remote.routes.every((route) => route.startsWith("/api/editorial/")),
  );
  assert.equal(first.independentMediaByteVerification, "NOT_RUN");
});
test("lost commit response recovers through the exact snapshot receipt on next attempt", async () => {
  const input = await files();
  const remote = server(input.payloadJSON, { lostReply: true });
  const first = await metadataRoundtrip({
    ...input,
    execute: true,
    fetchImpl: remote.fetchImpl,
  });
  assert.equal(first.status, "FAILED");
  const second = await metadataRoundtrip({
    ...input,
    execute: true,
    fetchImpl: remote.fetchImpl,
  });
  assert.equal(second.status, "PERSISTED_AND_READBACK_VERIFIED");
  assert.equal(remote.commits(), 1);
});
test("readback failure is not success and its committed artifact can be retried", async () => {
  const input = await files();
  const remote = server(input.payloadJSON, { failRead: true });
  const first = await metadataRoundtrip({
    ...input,
    execute: true,
    fetchImpl: remote.fetchImpl,
  });
  assert.equal(first.status, "FAILED");
  assert.equal(
    (
      await metadataRoundtrip({
        ...input,
        execute: true,
        fetchImpl: remote.fetchImpl,
      })
    ).status,
    "PERSISTED_AND_READBACK_VERIFIED",
  );
  assert.equal(remote.commits(), 1);
});
test("wrong bytes, counts or identity cannot be accepted as historical readback", async () => {
  for (const mode of ["corruptRead", "wrongCounts", "wrongIdentity"]) {
    const input = await files();
    const remote = server(input.payloadJSON, {
      [mode]: true,
      historical: true,
    });
    assert.equal(
      (
        await metadataRoundtrip({
          ...input,
          execute: true,
          fetchImpl: remote.fetchImpl,
        })
      ).status,
      "FAILED",
    );
  }
});
test("interrupt retains pending identity and exact replay restores completion", async () => {
  const input = await files();
  const controller = new AbortController();
  const remote = server(input.payloadJSON, { aborted: controller });
  const first = await metadataRoundtrip({
    ...input,
    execute: true,
    fetchImpl: remote.fetchImpl,
    signal: controller.signal,
  });
  assert.equal(first.status, "PENDING");
  const remote2 = server(input.payloadJSON);
  assert.equal(
    (
      await metadataRoundtrip({
        ...input,
        execute: true,
        fetchImpl: remote2.fetchImpl,
      })
    ).status,
    "PERSISTED_AND_READBACK_VERIFIED",
  );
});
test("truncated final journal row resumes from prior synced identity", async () => {
  const input = await files();
  const remote = server(input.payloadJSON, { lostReply: true });
  await metadataRoundtrip({
    ...input,
    execute: true,
    fetchImpl: remote.fetchImpl,
  });
  await appendFile(
    path.join(
      input.stateDirectory,
      `${digest(input.payloadJSON)}.receipt.jsonl`,
    ),
    '{"key":"snapshot","value":',
  );
  assert.equal(
    (
      await metadataRoundtrip({
        ...input,
        execute: true,
        fetchImpl: remote.fetchImpl,
      })
    ).status,
    "PERSISTED_AND_READBACK_VERIFIED",
  );
  assert.equal(remote.commits(), 1);
});
test("future different batch remains independently reusable and private/symlink inputs fail closed", async () => {
  const value = fixture(2);
  value.catalogId = "synthetic-new-catalog";
  const input = await files(value);
  assert.equal((await metadataRoundtrip(input)).counts.photos, 2);
  await chmod(input.metadataFile, 0o644);
  await assert.rejects(metadataRoundtrip(input), /PRIVATE_INPUT_REQUIRED/);
  await chmod(input.metadataFile, 0o600);
  const link = `${input.metadataFile}.link`;
  await symlink(input.metadataFile, link);
  await assert.rejects(
    metadataRoundtrip({ ...input, metadataFile: link }),
    /PRIVATE_INPUT_REQUIRED/,
  );
});

test("pre-aborted reopening cannot reuse old success without this invocation's readback", async () => {
  const input = await files();
  const remote = server(input.payloadJSON);
  await metadataRoundtrip({
    ...input,
    execute: true,
    fetchImpl: remote.fetchImpl,
  });
  const before = remote.routes.length;
  const controller = new AbortController();
  controller.abort();
  const cancelled = await metadataRoundtrip({
    ...input,
    execute: true,
    fetchImpl: remote.fetchImpl,
    signal: controller.signal,
  });
  assert.equal(remote.routes.length, before);
  assert.equal(cancelled.status, "PENDING");
  assert.equal(cancelled.succeeded, 0);
  assert.equal(cancelled.pending, 1);
  const rows = (
    await readFile(
      path.join(
        input.stateDirectory,
        `${digest(input.payloadJSON)}.receipt.jsonl`,
      ),
      "utf8",
    )
  )
    .trim()
    .split("\n")
    .map(JSON.parse);
  assert.equal(rows.at(-1).value.status, "pending");
  assert.equal(
    (
      await metadataRoundtrip({
        ...input,
        execute: true,
        fetchImpl: remote.fetchImpl,
      })
    ).status,
    "PERSISTED_AND_READBACK_VERIFIED",
  );
  assert.equal(remote.commits(), 1);
});

test("budget spent in preparation cannot count a prior metadata success", async () => {
  const input = await files();
  const remote = server(input.payloadJSON);
  await metadataRoundtrip({
    ...input,
    execute: true,
    fetchImpl: remote.fetchImpl,
  });
  const before = remote.routes.length;
  let ticks = 0;
  const result = await runBatch({
    manifest: {
      version: 1,
      batchId: `metadata-${digest(input.payloadJSON)}`,
      operation: "save-curation-metadata",
      items: [
        {
          key: "snapshot",
          metadataFile: input.metadataFile,
          expectedPreviousSha256: null,
        },
      ],
    },
    directory: path.dirname(input.metadataFile),
    receiptFile: path.join(
      input.stateDirectory,
      `${digest(input.payloadJSON)}.receipt.jsonl`,
    ),
    transport: createTransport(
      JSON.parse(await readFile(input.configFile, "utf8")),
      remote.fetchImpl,
    ),
    dryRun: false,
    budgetMs: 100,
    now: () => (ticks++ === 0 ? 0 : 1000),
  });
  assert.equal(remote.routes.length, before);
  assert.equal(result.succeeded, 0);
  assert.equal(result.pending, 1);
});

test("a forced child crash preserves pending identity and refuses its lock until verified local recovery", async () => {
  const input = await files();
  const marker = path.join(path.dirname(input.metadataFile), "request-started");
  const receipt = path.join(
    input.stateDirectory,
    `${digest(input.payloadJSON)}.receipt.jsonl`,
  );
  const lock = `${receipt}.lock`;
  const program = `
    import { metadataRoundtrip } from ${JSON.stringify(new URL("./metadata-roundtrip.mjs", import.meta.url).href)};
    import { writeFile } from 'node:fs/promises';
    import { setInterval } from 'node:timers';
    const keepAlive=setInterval(()=>{},1000);
    await metadataRoundtrip({...${JSON.stringify({ metadataFile: input.metadataFile, configFile: input.configFile, stateDirectory: input.stateDirectory })},execute:true,
      fetchImpl:async()=>{await writeFile(${JSON.stringify(marker)},'started',{mode:0o600});return new Promise(()=>{});}});
    clearInterval(keepAlive);
  `;
  const child = spawn(
    process.execPath,
    ["--input-type=module", "-e", program],
    { stdio: "ignore" },
  );
  const closed = once(child, "exit");
  try {
    let ready = false;
    for (let i = 0; i < 200; i += 1) {
      try {
        await readFile(marker);
        ready = true;
        break;
      } catch {
        await delay(10);
      }
    }
    assert.equal(ready, true);
    const lockedBytes = await readFile(lock);
    const pendingBytes = await readFile(receipt);
    assert.equal(JSON.parse(lockedBytes).pid, child.pid);
    const remote = server(input.payloadJSON);
    await assert.rejects(
      metadataRoundtrip({
        ...input,
        execute: true,
        fetchImpl: remote.fetchImpl,
      }),
      { code: "RECEIPT_LOCKED" },
    );
    assert.equal(remote.routes.length, 0);
    child.kill("SIGKILL");
    const [, signal] = await closed;
    assert.equal(signal, "SIGKILL");
    await assert.rejects(
      metadataRoundtrip({
        ...input,
        execute: true,
        fetchImpl: remote.fetchImpl,
      }),
      { code: "RECEIPT_LOCKED" },
    );
    assert.deepEqual(await readFile(lock), lockedBytes);
    assert.deepEqual(await readFile(receipt), pendingBytes);
    // Explicit test-owned recovery only after exact child exit was observed.
    // The product intentionally does not auto-delete unverifiable process locks.
    await unlink(lock);
    assert.equal(
      (
        await metadataRoundtrip({
          ...input,
          execute: true,
          fetchImpl: remote.fetchImpl,
        })
      ).status,
      "PERSISTED_AND_READBACK_VERIFIED",
    );
    assert.equal(remote.commits(), 1);
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
      await closed;
    }
  }
});

test("CLI exposes only a fixed lock category and leaves lock bytes unchanged", async () => {
  const input = await files();
  const remote = server(input.payloadJSON);
  await metadataRoundtrip({
    ...input,
    execute: true,
    fetchImpl: remote.fetchImpl,
  });
  const lock = path.join(
    input.stateDirectory,
    `${digest(input.payloadJSON)}.receipt.jsonl.lock`,
  );
  const bytes = '{"pid":1,"startedAt":"synthetic"}\n';
  await writeFile(lock, bytes, { mode: 0o600 });
  const child = spawn(
    process.execPath,
    [
      new URL("./metadata-roundtrip.mjs", import.meta.url).pathname,
      "--metadata",
      input.metadataFile,
      "--config",
      input.configFile,
      "--state",
      input.stateDirectory,
      "--execute",
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  let stdout = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  const [code] = await once(child, "exit");
  assert.equal(code, 1);
  assert.deepEqual(JSON.parse(stdout), {
    status: "FAILED",
    category: "RECEIPT_LOCKED",
  });
  assert.equal(await readFile(lock, "utf8"), bytes);
});

test("safe transient 503 follows configured bounded automatic retry without duplicate writes", async () => {
  const input = await files();
  const remote = server(input.payloadJSON, { transient503: true });
  const config = JSON.parse(await readFile(input.configFile, "utf8"));
  config.attempts = 3;
  await writeFile(input.configFile, JSON.stringify(config), { mode: 0o600 });
  const outcome = await metadataRoundtrip({
    ...input,
    execute: true,
    fetchImpl: remote.fetchImpl,
  });
  assert.equal(outcome.status, "PERSISTED_AND_READBACK_VERIFIED");
  assert.equal(remote.commits(), 1);
  assert.deepEqual(remote.routes, [
    "/api/editorial/save-curation-metadata",
    "/api/editorial/save-curation-metadata",
    "/api/editorial/read-curation-metadata",
  ]);
});

const latestReceipt = async (input) => {
  const text = await readFile(
    path.join(
      input.stateDirectory,
      `${digest(input.payloadJSON)}.receipt.jsonl`,
    ),
    "utf8",
  );
  return text.trim().split("\n").map(JSON.parse).at(-1).value;
};

test("exact historical readback is verified separately and reopening preserves the current proof", async () => {
  const input = await files();
  const behavior = {};
  const remote = server(input.payloadJSON, behavior);
  assert.equal(
    (
      await metadataRoundtrip({
        ...input,
        execute: true,
        fetchImpl: remote.fetchImpl,
      })
    ).status,
    "PERSISTED_AND_READBACK_VERIFIED",
  );
  const currentProof = (await latestReceipt(input)).result;
  behavior.historical = true;
  const historical = await metadataRoundtrip({
    ...input,
    execute: true,
    fetchImpl: remote.fetchImpl,
  });
  assert.equal(historical.status, "PERSISTED_HISTORICAL_READBACK_VERIFIED");
  assert.equal(historical.succeeded, 0);
  assert.equal(historical.historicalVerified, 1);
  assert.equal(historical.pending, 0);
  assert.equal(historical.failed, 0);
  const receipt = await latestReceipt(input);
  assert.equal(receipt.status, "historical");
  assert.equal(receipt.result.verifiedReadback, true);
  assert.equal(receipt.result.currentAtReadback, false);
  assert.deepEqual(receipt.priorCompletedResult, currentProof);
  const again = await metadataRoundtrip({
    ...input,
    execute: true,
    fetchImpl: remote.fetchImpl,
  });
  assert.equal(again.status, historical.status);
  assert.equal(again.succeeded, 0);
  assert.equal(remote.commits(), 1);
  assert.equal(remote.routes.length, 6);
  assert.deepEqual(
    (await latestReceipt(input)).priorCompletedResult,
    currentProof,
  );
  assert.equal(
    (await latestReceipt(input)).priorHistoricalResult.currentAtReadback,
    false,
  );
});

test("a lost commit reply followed by draft movement recovers verified historical evidence", async () => {
  const input = await files();
  const behavior = { lostReply: true };
  const remote = server(input.payloadJSON, behavior);
  assert.equal(
    (
      await metadataRoundtrip({
        ...input,
        execute: true,
        fetchImpl: remote.fetchImpl,
      })
    ).status,
    "FAILED",
  );
  behavior.historical = true;
  const historical = await metadataRoundtrip({
    ...input,
    execute: true,
    fetchImpl: remote.fetchImpl,
  });
  assert.equal(historical.status, "PERSISTED_HISTORICAL_READBACK_VERIFIED");
  assert.equal(historical.succeeded, 0);
  assert.equal(historical.historicalVerified, 1);
  assert.equal(remote.commits(), 1);
  assert.equal((await latestReceipt(input)).result.currentAtReadback, false);
});

test("malformed current flags cannot masquerade as historical verification", async () => {
  for (const invalidCurrent of [undefined, null, "false", 0]) {
    const input = await files();
    const remote = server(input.payloadJSON, { invalidCurrent });
    const outcome = await metadataRoundtrip({
      ...input,
      execute: true,
      fetchImpl: remote.fetchImpl,
    });
    assert.equal(outcome.status, "FAILED");
    assert.equal(outcome.succeeded, 0);
    assert.equal(outcome.historicalVerified, 0);
  }
});

test("pending retries retain earlier verified evidence through failure and repeated cancellation", async () => {
  const input = await files();
  const behavior = {};
  const remote = server(input.payloadJSON, behavior);
  await metadataRoundtrip({
    ...input,
    execute: true,
    fetchImpl: remote.fetchImpl,
  });
  const proof = (await latestReceipt(input)).result;
  behavior.corruptRead = true;
  assert.equal(
    (
      await metadataRoundtrip({
        ...input,
        execute: true,
        fetchImpl: remote.fetchImpl,
      })
    ).status,
    "FAILED",
  );
  assert.deepEqual((await latestReceipt(input)).priorCompletedResult, proof);
  const before = remote.routes.length;
  for (let repeat = 0; repeat < 2; repeat += 1) {
    const controller = new AbortController();
    controller.abort();
    const outcome = await metadataRoundtrip({
      ...input,
      execute: true,
      fetchImpl: remote.fetchImpl,
      signal: controller.signal,
    });
    assert.equal(outcome.status, "PENDING");
    assert.equal(outcome.succeeded, 0);
    assert.deepEqual((await latestReceipt(input)).priorCompletedResult, proof);
    assert.equal((await latestReceipt(input)).status, "pending");
  }
  assert.equal(remote.routes.length, before);
});

test("private snapshots with a stable second hard link remain readable", async () => {
  const input = await files();
  await link(input.metadataFile, `${input.metadataFile}.producer-orphan`);
  assert.equal((await metadataRoundtrip(input)).status, "OFFLINE_VALIDATED");
});

test("replacing an already opened private snapshot with a symlink fails closed", async (t) => {
  const input = await files();
  const replacement = `${input.metadataFile}.different`;
  await writeFile(replacement, JSON.stringify(fixture(2)), { mode: 0o600 });
  const sample = await open(input.metadataFile, "r");
  const prototype = Object.getPrototypeOf(sample);
  const originalRead = prototype.read;
  await sample.close();
  let replaced = false;
  t.mock.method(prototype, "read", async function (...args) {
    if (!replaced) {
      replaced = true;
      await unlink(input.metadataFile);
      await symlink(replacement, input.metadataFile);
    }
    return originalRead.apply(this, args);
  });
  await assert.rejects(metadataRoundtrip(input), /PRIVATE_INPUT_REQUIRED/);
  assert.equal(replaced, true);
});

test("a valid private replacement between wrapper validation and batch preparation is rejected", async (t) => {
  const input = await files();
  const originalOpen = fs.open;
  let replaced = false;
  t.mock.method(fs, "open", async (...args) => {
    const handle = await originalOpen(...args);
    if (args[0] === input.metadataFile && !replaced) {
      const originalClose = handle.close.bind(handle);
      handle.close = async () => {
        await originalClose();
        replaced = true;
        await writeFile(input.metadataFile, JSON.stringify(fixture(2)), {
          mode: 0o600,
        });
      };
    }
    return handle;
  });
  syncBuiltinESMExports();
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });
  await assert.rejects(
    metadataRoundtrip(input),
    /CURATION_METADATA_INPUT_CHANGED/,
  );
  assert.equal(replaced, true);
});

const professionalFixture = () => {
  const value = fixture(1);
  const payloadCanonicalJSON =
    '{"kind":"photo","schema_version":"artvenn-photo-annotation/v1","values":{"position_index":1.0,"representation":"stone"}}';
  value.annotations.annotation_revisions.push({
    id: "annotation-1",
    context_key: sha,
    object_id: value.objectId,
    asset_id: value.photos[0].assetId,
    logical_asset_id: "logical-1",
    source_sha256: sha,
    revision: 1,
    previous_id: null,
    payload: JSON.parse(payloadCanonicalJSON),
    payloadCanonicalJSON,
    payload_sha256: digest(payloadCanonicalJSON),
    changes: {},
    coordinate_frame: value.photos[0].frame,
    review_id: value.review.id,
    review_revision: value.review.revision,
    review_draft_sha256: sha,
    membership_sha256: sha,
    confirmation_event: sha,
    created: 0,
  });
  return value;
};

test("offline and direct batch preparation reject a forged inner annotation hash even with correct outer bytes", async () => {
  const value = professionalFixture();
  value.annotations.annotation_revisions[0].payload_sha256 = "c".repeat(64);
  const input = await files(value);
  let requests = 0;
  await assert.rejects(
    metadataRoundtrip({
      ...input,
      fetchImpl: () => {
        requests += 1;
      },
    }),
    /CURATION_METADATA_ANNOTATION_HASH_MISMATCH/,
  );
  await assert.rejects(
    prepareItems(
      {
        version: 1,
        batchId: `metadata-${digest(input.payloadJSON)}`,
        operation: "save-curation-metadata",
        items: [
          {
            key: "snapshot",
            metadataFile: input.metadataFile,
            expectedSnapshotSha256: digest(input.payloadJSON),
            expectedPreviousSha256: null,
          },
        ],
      },
      path.dirname(input.metadataFile),
    ),
    /CURATION_METADATA_ANNOTATION_HASH_MISMATCH/,
  );
  assert.equal(requests, 0);
});

test("offline validation preserves valid Python 1.0 annotation bytes and their exact inner hash", async () => {
  const input = await files(professionalFixture());
  const originalBytes = await readFile(input.metadataFile);
  const result = await metadataRoundtrip(input);
  assert.equal(result.status, "OFFLINE_VALIDATED");
  assert.equal(result.counts.annotationRevisions, 1);
  assert.deepEqual(await readFile(input.metadataFile), originalBytes);
});

const sessionConfig = ({
  actorId = 7,
  baseURL = "https://cms.example.invalid",
  sid = "synthetic-session-1",
  claims = {},
  changes = {},
} = {}) => {
  const now = Math.floor(Date.now() / 1000);
  const tokenClaims = {
    id: actorId,
    collection: "users",
    email: "synthetic@example.invalid",
    sid,
    iat: now,
    exp: now + 3600,
    ...claims,
  };
  const encode = (value) =>
    Buffer.from(JSON.stringify(value)).toString("base64url");
  return {
    instance: "production",
    targetVerified: true,
    syntheticOnly: false,
    baseURL,
    sessionToken: `${encode({ alg: "HS256", typ: "JWT" })}.${encode(tokenClaims)}.c3ludGhldGljLXNpZ25hdHVyZS1vbmx5`,
    actorId,
    sessionExpiresAt: new Date((now + 3600) * 1000).toISOString(),
    catalogIds: ["synthetic-catalog"],
    attempts: 1,
    budgetMs: 2000,
    ...changes,
  };
};
const saveSessionConfig = (input, config) =>
  writeFile(input.configFile, JSON.stringify(config), { mode: 0o600 });
const preparedMetadata = (input) => ({
  body: {
    payloadJSON: input.payloadJSON,
    snapshotSha256: digest(input.payloadJSON),
    expectedPreviousSha256: null,
  },
});

test("metadata-only Owner session uses JWT on exact save/read endpoints and leaves protected config unchanged", async () => {
  const input = await files();
  const config = sessionConfig();
  await saveSessionConfig(input, config);
  const configBytes = await readFile(input.configFile);
  const remote = server(input.payloadJSON);
  const headers = [];
  const result = await metadataRoundtrip({
    ...input,
    execute: true,
    fetchImpl: async (url, request) => {
      assert.equal(new URL(url).origin, config.baseURL);
      assert.equal(request.method, "POST");
      assert.equal(request.redirect, "error");
      headers.push(request.headers.Authorization);
      return remote.fetchImpl(url, request);
    },
  });
  assert.equal(result.status, "PERSISTED_AND_READBACK_VERIFIED");
  assert.deepEqual(headers, [
    `JWT ${config.sessionToken}`,
    `JWT ${config.sessionToken}`,
  ]);
  assert.deepEqual(remote.routes, [
    "/api/editorial/save-curation-metadata",
    "/api/editorial/read-curation-metadata",
  ]);
  assert.deepEqual(await readFile(input.configFile), configBytes);
  assert.throws(() => createTransport(config), { code: "CONFIG_AUTH_INVALID" });
});

test("metadata-only transport preserves existing API-key authentication and receipt scope", async () => {
  const input = await files();
  const config = JSON.parse(await readFile(input.configFile, "utf8"));
  const headers = [];
  const remote = server(input.payloadJSON);
  const transport = createMetadataTransport(config, async (url, request) => {
    headers.push(request.headers.Authorization);
    return remote.fetchImpl(url, request);
  });
  const result = await transport(
    "save-curation-metadata",
    preparedMetadata(input),
  );
  assert.equal(result.ok, true);
  assert.deepEqual(headers, [
    "users API-Key synthetic-test-only",
    "users API-Key synthetic-test-only",
  ]);
  assert.equal(
    transport.scopeFingerprint,
    createTransport(config).scopeFingerprint,
  );
});

test("session validation rejects expired, overlong, mixed and mismatched native identity before any request", () => {
  const now = Date.now();
  for (const config of [
    sessionConfig({
      changes: { sessionExpiresAt: new Date(now - 1000).toISOString() },
    }),
    sessionConfig({
      changes: { sessionExpiresAt: new Date(now + 3 * 3600_000).toISOString() },
    }),
    sessionConfig({ changes: { sessionExpiresAt: "not-a-date" } }),
    sessionConfig({ changes: { sessionToken: "" } }),
    sessionConfig({ changes: { sessionToken: "SYNTHETIC_MALFORMED_TOKEN" } }),
    sessionConfig({
      changes: {
        sessionToken: ["SYNTHETIC_HEADER", "\r\n", "SYNTHETIC_SUFFIX"].join(""),
      },
    }),
    sessionConfig({ changes: { apiKey: "synthetic-mixed" } }),
    sessionConfig({ changes: { apiKey: null } }),
    sessionConfig({ changes: { actorId: 0 } }),
    sessionConfig({ changes: { actorId: "7" } }),
    sessionConfig({ claims: { id: 8 } }),
    sessionConfig({ claims: { collection: "other-collection" } }),
    sessionConfig({ claims: { exp: Math.floor(now / 1000) - 1 } }),
    sessionConfig({ claims: { exp: Math.floor(now / 1000) + 3599 } }),
    sessionConfig({ claims: { exp: 1.5 } }),
    sessionConfig({ claims: { iat: undefined } }),
    sessionConfig({
      changes: { sessionToken: undefined, apiKey: "synthetic-role-switch" },
    }),
  ]) {
    let requests = 0;
    assert.throws(
      () =>
        createMetadataTransport(config, () => {
          requests += 1;
        }),
      { code: "PRODUCTION_LOGIN_REQUIRED" },
    );
    assert.equal(requests, 0);
  }
});

test("session target guards retain explicit verified Production and URL boundaries", () => {
  const syntheticUserinfo = new URL("https://cms.example.invalid");
  syntheticUserinfo.username = "SYNTHETIC_USER";
  syntheticUserinfo.password = "SYNTHETIC_PASSWORD_PLACEHOLDER";
  for (const changes of [
    { instance: "development" },
    { targetVerified: false },
    { syntheticOnly: true },
    { baseURL: "http://cms.example.invalid" },
    { baseURL: "https://127.0.0.1" },
    { baseURL: "https://localhost" },
    { baseURL: "https://[::1]" },
    { baseURL: syntheticUserinfo.href },
    { baseURL: "https://cms.example.invalid/api" },
    { baseURL: "https://cms.example.invalid?target=other" },
    { baseURL: "https://cms.example.invalid#other" },
  ])
    assert.throws(() => createMetadataTransport(sessionConfig({ changes })), {
      code: "PRODUCTION_TARGET_INVALID",
    });
});

test("metadata factories refuse draft, publication, upload and arbitrary operations with zero requests", async () => {
  const input = await files();
  for (const config of [
    sessionConfig(),
    JSON.parse(await readFile(input.configFile, "utf8")),
  ]) {
    let requests = 0;
    const transport = createMetadataTransport(config, () => {
      requests += 1;
    });
    for (const operation of [
      "save-draft",
      "publish-approved",
      "upload-media",
      "read-draft",
      "read-curation-metadata",
      "../users",
    ]) {
      await assert.rejects(transport(operation, preparedMetadata(input)), {
        code: "OPERATION_INVALID",
      });
    }
    assert.equal(requests, 0);
  }
});

test("same Owner renewed session resumes the exact receipt while a changed actor or origin cannot", async () => {
  const input = await files();
  const firstConfig = sessionConfig();
  await saveSessionConfig(input, firstConfig);
  const remote = server(input.payloadJSON, { lostReply: true });
  assert.equal(
    (
      await metadataRoundtrip({
        ...input,
        execute: true,
        fetchImpl: remote.fetchImpl,
      })
    ).status,
    "FAILED",
  );
  const renewed = sessionConfig({ sid: "synthetic-renewed-session" });
  assert.notEqual(renewed.sessionToken, firstConfig.sessionToken);
  assert.equal(
    createMetadataTransport(renewed).scopeFingerprint,
    createMetadataTransport(firstConfig).scopeFingerprint,
  );
  await saveSessionConfig(input, renewed);
  assert.equal(
    (
      await metadataRoundtrip({
        ...input,
        execute: true,
        fetchImpl: remote.fetchImpl,
      })
    ).status,
    "PERSISTED_AND_READBACK_VERIFIED",
  );
  assert.equal(remote.commits(), 1);
  const before = remote.routes.length;
  for (const changed of [
    sessionConfig({ actorId: 8 }),
    sessionConfig({ baseURL: "https://other-cms.example.invalid" }),
  ]) {
    await saveSessionConfig(input, changed);
    await assert.rejects(
      metadataRoundtrip({
        ...input,
        execute: true,
        fetchImpl: remote.fetchImpl,
      }),
      { code: "RECEIPT_SCOPE_MISMATCH" },
    );
  }
  assert.equal(remote.routes.length, before);
});

test("every session request checks expiry; an expired readback never claims success and renewal can reconcile", async (t) => {
  const input = await files();
  let now = Date.now();
  t.mock.method(Date, "now", () => now);
  const config = sessionConfig();
  await saveSessionConfig(input, config);
  const remote = server(input.payloadJSON);
  const first = await metadataRoundtrip({
    ...input,
    execute: true,
    fetchImpl: async (url, request) => {
      const result = await remote.fetchImpl(url, request);
      now = Date.parse(config.sessionExpiresAt) + 1;
      return result;
    },
  });
  assert.equal(first.status, "FAILED");
  assert.equal(first.succeeded, 0);
  assert.deepEqual(remote.routes, ["/api/editorial/save-curation-metadata"]);
  assert.equal((await latestReceipt(input)).code, "PRODUCTION_LOGIN_REQUIRED");
  const renewed = sessionConfig({ sid: "synthetic-renewed-after-expiry" });
  await saveSessionConfig(input, renewed);
  assert.equal(
    (
      await metadataRoundtrip({
        ...input,
        execute: true,
        fetchImpl: remote.fetchImpl,
      })
    ).status,
    "PERSISTED_AND_READBACK_VERIFIED",
  );
  assert.equal(remote.commits(), 1);
});

test("metadata session transport pins original origin and actor against later caller object changes", async () => {
  const input = await files();
  const config = sessionConfig();
  const originalToken = config.sessionToken;
  const scope = createMetadataTransport(config).scopeFingerprint;
  const remote = server(input.payloadJSON);
  const transport = createMetadataTransport(config, (url, request) => {
    assert.equal(new URL(url).origin, "https://cms.example.invalid");
    assert.equal(request.headers.Authorization, `JWT ${originalToken}`);
    return remote.fetchImpl(url, request);
  });
  Object.assign(
    config,
    sessionConfig({ actorId: 8, baseURL: "https://other-cms.example.invalid" }),
  );
  assert.equal(
    (await transport("save-curation-metadata", preparedMetadata(input))).ok,
    true,
  );
  assert.equal(transport.scopeFingerprint, scope);
});

async function spawnMetadataCLI(
  input,
  { clock, expireAfterSave = false } = {},
) {
  const marker = path.join(
    path.dirname(input.metadataFile),
    "cli-request-routes.json",
  );
  const cli = new URL("./metadata-roundtrip.mjs", import.meta.url);
  const program = `
    import { writeFile, readFile } from 'node:fs/promises';
    import { deriveCurationMetadataCounts, decodeCurationMetadata } from ${JSON.stringify(new URL("../../packages/contracts/dist/internal/editorial/index.js", import.meta.url).href)};
    const input=${JSON.stringify({ metadataFile: input.metadataFile, configFile: input.configFile, stateDirectory: input.stateDirectory })};
    const config=JSON.parse(await readFile(input.configFile,'utf8'));
    const payloadJSON=await readFile(input.metadataFile,'utf8');
    const counts=deriveCurationMetadataCounts(decodeCurationMetadata(payloadJSON));
    let clock=${JSON.stringify(clock ?? Date.now())};
    Date.now=()=>clock;
    const routes=[];
    await writeFile(${JSON.stringify(marker)},JSON.stringify(routes),{mode:0o600});
    globalThis.fetch=async (url,request)=>{
      const route=new URL(url).pathname;
      if (request.method!=='POST'||request.redirect!=='error'||!['/api/editorial/save-curation-metadata','/api/editorial/read-curation-metadata'].includes(route)) throw new Error('FIXED_ROUTE_REQUIRED');
      if(request.headers.Authorization!==('JWT '+config.sessionToken)) throw new Error('FIXED_AUTH_REQUIRED');
      routes.push(route);
      await writeFile(${JSON.stringify(marker)},JSON.stringify(routes),{mode:0o600});
      if(${JSON.stringify(expireAfterSave)}&&route.endsWith('save-curation-metadata')) clock=Date.parse(config.sessionExpiresAt)+1;
      const body=JSON.parse(request.body);
      return new Response(JSON.stringify({ok:true,result:{id:1,catalogId:'synthetic-catalog',payloadJSON,
        snapshotSha256:body.snapshotSha256,previousSha256:null,createdAt:'2026-10-13T00:00:00.000Z',current:true,counts}}),
        {status:200,headers:{'Content-Type':'application/json'}});
    };
    process.argv=[process.execPath,${JSON.stringify(cli.pathname)},'--metadata',input.metadataFile,'--config',input.configFile,'--state',input.stateDirectory,'--execute'];
    await import(${JSON.stringify(cli.href)});
  `;
  const child = spawn(
    process.execPath,
    ["--input-type=module", "-e", program],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const [code] = await once(child, "close");
  return {
    code,
    stdout,
    stderr,
    result: JSON.parse(stdout),
    routes: JSON.parse(await readFile(marker, "utf8")),
  };
}

test("CLI initial expired session returns only fixed login-required classification with zero requests", async () => {
  const input = await files();
  const config = sessionConfig({
    changes: { sessionExpiresAt: new Date(Date.now() - 1000).toISOString() },
  });
  await saveSessionConfig(input, config);
  const configBytes = await readFile(input.configFile);
  const result = await spawnMetadataCLI(input);
  assert.equal(result.code, 1);
  assert.deepEqual(result.result, {
    status: "FAILED",
    category: "PRODUCTION_LOGIN_REQUIRED",
  });
  assert.deepEqual(result.routes, []);
  assert.equal(result.stdout.includes(config.sessionToken), false);
  assert.equal(result.stderr.includes(config.sessionToken), false);
  assert.deepEqual(await readFile(input.configFile), configBytes);
});

test("CLI expiry between committed save and readback exposes fixed category and preserves earlier proof", async () => {
  const input = await files();
  const config = sessionConfig();
  await saveSessionConfig(input, config);
  const remote = server(input.payloadJSON);
  await metadataRoundtrip({
    ...input,
    execute: true,
    fetchImpl: remote.fetchImpl,
  });
  const proof = (await latestReceipt(input)).result;
  const configBytes = await readFile(input.configFile);
  const result = await spawnMetadataCLI(input, { expireAfterSave: true });
  assert.equal(result.code, 1);
  assert.equal(result.result.status, "FAILED");
  assert.equal(result.result.category, "PRODUCTION_LOGIN_REQUIRED");
  assert.equal(result.result.succeeded, 0);
  assert.equal(result.result.failed, 1);
  assert.deepEqual(result.routes, ["/api/editorial/save-curation-metadata"]);
  const receipt = await latestReceipt(input);
  assert.equal(receipt.code, "PRODUCTION_LOGIN_REQUIRED");
  assert.deepEqual(receipt.priorCompletedResult, proof);
  assert.equal(result.stdout.includes(config.sessionToken), false);
  assert.deepEqual(await readFile(input.configFile), configBytes);
});

test("CLI target errors remain generic rather than expanding the auth category whitelist", async () => {
  const input = await files();
  await saveSessionConfig(
    input,
    sessionConfig({ changes: { targetVerified: false } }),
  );
  const result = await spawnMetadataCLI(input);
  assert.equal(result.code, 1);
  assert.deepEqual(result.result, {
    status: "FAILED",
    category: "CURATION_METADATA_ROUNDTRIP_FAILED",
  });
  assert.deepEqual(result.routes, []);
});

test("metadata API-key remote errors cannot inject login-required category or raw error text", async () => {
  const input = await files();
  const result = await metadataRoundtrip({
    ...input,
    execute: true,
    fetchImpl: async () =>
      response(
        {
          ok: false,
          error: {
            code: "PRODUCTION_LOGIN_REQUIRED",
            message: "synthetic-raw-remote-error-must-not-appear",
          },
        },
        401,
      ),
  });
  assert.equal(result.status, "FAILED");
  assert.equal(Object.hasOwn(result, "category"), false);
  assert.equal(
    JSON.stringify(result).includes(
      "synthetic-raw-remote-error-must-not-appear",
    ),
    false,
  );
  assert.equal((await latestReceipt(input)).code, "FORBIDDEN");
});

test("legacy batch summary shape remains unchanged even for the same fixed failure code", async () => {
  const input = await files();
  const result = await runBatch({
    manifest: {
      version: 1,
      batchId: "legacy-category-shape",
      operation: "save-draft",
      items: [
        {
          key: "draft",
          content: {
            catalogId: "synthetic-catalog",
            sourceId: "synthetic-source",
            kind: "inscription",
            title: "Synthetic draft",
          },
        },
      ],
    },
    directory: path.dirname(input.metadataFile),
    receiptFile: path.join(
      input.stateDirectory,
      "legacy-summary-shape.receipt.jsonl",
    ),
    dryRun: false,
    transport: async () => ({
      ok: false,
      retryable: false,
      code: "PRODUCTION_LOGIN_REQUIRED",
    }),
  });
  assert.deepEqual(result, {
    dryRun: false,
    total: 1,
    succeeded: 0,
    failed: 1,
    pending: 0,
  });
});

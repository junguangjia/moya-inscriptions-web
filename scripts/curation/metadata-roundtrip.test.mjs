import test from "node:test";
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
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import process from "node:process";
import path from "node:path";
import { URL } from "node:url";
import { metadataRoundtrip } from "./metadata-roundtrip.mjs";
import { runBatch, createTransport } from "../editorial/batch.mjs";
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
test("wrong bytes, counts and historical response cannot claim current readback success", async () => {
  for (const mode of ["corruptRead", "wrongCounts", "historical"]) {
    const input = await files();
    const remote = server(input.payloadJSON, { [mode]: true });
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

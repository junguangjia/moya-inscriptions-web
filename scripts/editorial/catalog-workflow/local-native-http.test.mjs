import assert from "node:assert/strict";
import test from "node:test";
import process from "node:process";
import { spawn } from "node:child_process";
import { access, readFile, writeFile, unlink } from "node:fs/promises";
import path from "node:path";
import { Buffer } from "node:buffer";
import { NativeChunkBody } from "../native-stream-fetch.mjs";
import http from "node:http";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import { URL } from "node:url";
import { setTimeout } from "node:timers";
import { withLocalNativeAdapter } from "./local-native-adapter.mjs";
import { createLocalNativeHTTP } from "./local-native-http.mjs";
import { createTransferBudget } from "./transfer-budget.mjs";
import { localHTTPFixture } from "./local-http-fixture.mjs";
import { hash } from "./test-fixtures.mjs";

const { queueMicrotask } = globalThis;
const recordId = "SYNTHETIC-001",
  mediaId = "media-synthetic-1";
const rejects = (fn, code) =>
  assert.rejects(fn, (error) => error.code === code);

function registeredSyntheticMedia(f) {
  const record = f.manifest.records[0],
    asset = record.media[0];
  record.reuseOnly = true;
  f.input.records[0].media[0].file = null;
  f.state.media = {
    id: 20,
    mediaId: asset.mediaId,
    catalogId: record.catalogId,
    objectKey: f.input.records[0].content.media[0].objectKey,
    sha256: asset.uploadedSha256,
    mimeType: "image/png",
    filesize: asset.bytes,
    filename: "synthetic.png",
    width: 1,
    height: 1,
    alt: "Synthetic test",
  };
  return {
    provenance: {
      target: { ...f.manifest.target },
      runId: "synthetic-prior-run",
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
  };
}
async function journal(f) {
  return JSON.parse(
    await readFile(
      path.join(f.directory, "checkpoint/local-native-journal.json"),
      "utf8",
    ),
  );
}

test("real Native parallel chunks recover a lost acknowledgment and rerun transfers zero binary", async (t) => {
  const f = await localHTTPFixture({ dropChunk: true });
  t.after(() => f.close());
  f.enforceDurableAdmission();
  const options = { ...f.adapterOptions(), uploadMode: "parallel-chunks-v1" };
  await withLocalNativeAdapter(options, async (adapter) => {
    await adapter.uploadMedia(recordId, mediaId);
    assert.equal(adapter.metrics().activeRequests, 0);
  });
  const before = f.state.binaryBytes,
    first = await journal(f);
  assert.equal(before, f.bytes.length);
  assert.equal(f.state.byIndex[1], 1);
  assert.ok(f.state.requests.some((row) => row.route.endsWith("/status")));
  await withLocalNativeAdapter(
    { ...options, deadline: Date.now() + 30000 },
    async (adapter) => {
      const reused = await adapter.uploadMedia(recordId, mediaId);
      assert.equal(reused.reused, true);
    },
  );
  const repeated = await journal(f);
  assert.equal(f.state.binaryBytes, before);
  assert.equal(f.state.completes, 1);
  assert.ok(repeated.requests.length > first.requests.length);
  assert.equal(
    repeated.requests.reduce((sum, row) => sum + row.binaryBodyBytes, 0),
    f.bytes.length,
  );
  assert.deepEqual(f.state.errors, []);
  t.diagnostic(
    JSON.stringify({
      binaryBytes: before,
      requestsFirst: first.requests.length,
      requestsRepeated: repeated.requests.length - first.requests.length,
    }),
  );
});

test("actual Native stream capability uses measured stream writes", async (t) => {
  const f = await localHTTPFixture({ stream: true });
  t.after(() => f.close());
  f.enforceDurableAdmission();
  await withLocalNativeAdapter(f.adapterOptions(), (adapter) =>
    adapter.uploadMedia(recordId, mediaId),
  );
  const saved = await journal(f);
  assert.equal(f.state.binaryBytes, f.bytes.length);
  assert.equal(
    saved.requests.filter((row) => row.route.includes("/stream/")).length,
    1,
  );
  assert.equal(
    saved.requests.filter((row) => row.route.includes("/chunk/")).length,
    0,
  );
  assert.deepEqual(f.state.errors, []);
});

test("new upload audit cannot survive removal of its completed request ledger", async (t) => {
  const f = await localHTTPFixture();
  t.after(() => f.close());
  await withLocalNativeAdapter(f.adapterOptions(), (adapter) =>
    adapter.uploadMedia(recordId, mediaId),
  );
  const saved = await journal(f),
    before = f.state.requests.length;
  assert.equal(saved.mediaProofs[mediaId].audit.kind, "NATIVE_UPLOAD");
  saved.requests = [];
  saved.budget.requests = [];
  await writeFile(
    path.join(f.directory, "checkpoint/local-native-journal.json"),
    JSON.stringify(saved),
    { mode: 0o600 },
  );
  await rejects(
    () =>
      withLocalNativeAdapter(f.adapterOptions(), () =>
        assert.fail("unbound upload proof accepted"),
      ),
    "LOCAL_JOURNAL_INVALID",
  );
  assert.equal(f.state.requests.length, before);
});

test("draft workflow saves once and reconciles lost reply by exact Native receipt", async (t) => {
  const f = await localHTTPFixture({ dropSave: true });
  t.after(() => f.close());
  f.enforceDurableAdmission();
  await withLocalNativeAdapter(f.adapterOptions(), async (adapter) => {
    const result = await adapter.runDraftWorkflow();
    assert.equal(result.executionKind, "local-http");
  });
  const first = await journal(f);
  assert.equal(first.actions[`${recordId}-save-draft`].status, "UNKNOWN");
  for (let repeat = 0; repeat < 2; repeat++)
    await withLocalNativeAdapter(f.adapterOptions(), async (adapter) => {
      const result = await adapter.runDraftWorkflow();
      assert.equal(
        result.records[0].state,
        "WAITING_PRIVATE_PREPARATION_BINDING",
      );
    });
  assert.equal(f.state.saves, 1);
  assert.equal(f.state.draft.revision, 2);
  assert.equal(f.state.binaryBytes, f.bytes.length);
  assert.ok(
    f.state.requests.some((row) =>
      row.route.startsWith("/api/editorial-receipts?"),
    ),
  );
  assert.deepEqual(f.state.errors, []);
});

test("unattributed identical content cannot confirm a lost save or repeat POST", async (t) => {
  const f = await localHTTPFixture({ dropSave: true });
  t.after(() => f.close());
  await withLocalNativeAdapter(f.adapterOptions(), (adapter) =>
    adapter.runDraftWorkflow(),
  );
  f.state.receiptPatch = { requestFingerprint: hash("f") };
  await withLocalNativeAdapter(f.adapterOptions(), async (adapter) => {
    const result = await adapter.runDraftWorkflow();
    assert.equal(result.records[0].state, "DRAFT_OUTCOME_UNKNOWN");
  });
  assert.equal(f.state.saves, 1);
  assert.equal(f.state.binaryBytes, f.bytes.length);
  assert.equal(
    (await journal(f)).actions[`${recordId}-save-draft`].status,
    "UNKNOWN",
  );
});

test("registered-media proof import and metadata-only B save never enter upload staging", async (t) => {
  const f = await localHTTPFixture();
  t.after(() => f.close());
  f.enforceDurableAdmission();
  const imported = registeredSyntheticMedia(f);
  let staged = 0;
  await withLocalNativeAdapter(f.adapterOptions(), async (adapter) => {
    adapter.uploadMedia = async () => {
      staged++;
      throw new Error("SYNTHETIC_STAGING_FORBIDDEN");
    };
    assert.equal(
      (await adapter.importRegisteredProof(recordId, imported)).binaryBodyBytes,
      0,
    );
    const result = await adapter.runDraftWorkflow();
    assert.equal(
      result.records[0].state,
      "WAITING_PRIVATE_PREPARATION_BINDING",
    );
  });
  await withLocalNativeAdapter(f.adapterOptions(), async (adapter) => {
    const result = await adapter.runDraftWorkflow();
    assert.equal(
      result.records[0].state,
      "WAITING_PRIVATE_PREPARATION_BINDING",
    );
  });
  assert.equal(staged, 0);
  assert.equal(f.state.saves, 1);
  assert.equal(f.state.draft.revision, 2);
  assert.equal(f.state.binaryBytes, 0);
  assert.equal(
    f.state.requests.filter((row) => row.route.includes("/media-upload/"))
      .length,
    0,
  );
  assert.deepEqual(f.state.errors, []);
});

test("metadata-only lost save recovers by exact Native receipt without staging or repeated save", async (t) => {
  const f = await localHTTPFixture({ dropSave: true });
  t.after(() => f.close());
  f.enforceDurableAdmission();
  const imported = registeredSyntheticMedia(f);
  await withLocalNativeAdapter(f.adapterOptions(), async (adapter) => {
    await adapter.importRegisteredProof(recordId, imported);
    await adapter.runDraftWorkflow();
  });
  assert.equal(
    (await journal(f)).actions[`${recordId}-save-draft`].status,
    "UNKNOWN",
  );
  await withLocalNativeAdapter(f.adapterOptions(), async (adapter) => {
    const result = await adapter.runDraftWorkflow();
    assert.equal(
      result.records[0].state,
      "WAITING_PRIVATE_PREPARATION_BINDING",
    );
  });
  assert.equal(f.state.saves, 1);
  assert.equal(f.state.binaryBytes, 0);
  assert.equal(
    f.state.requests.filter((row) => row.route.includes("/media-upload/"))
      .length,
    0,
  );
  assert.ok(
    f.state.requests.some((row) =>
      row.route.startsWith("/api/editorial-receipts?"),
    ),
  );
});

test("reload rejects stripped or changed imported audit and detached response receipt before HTTP", async (t) => {
  const f = await localHTTPFixture();
  t.after(() => f.close());
  const imported = registeredSyntheticMedia(f);
  await withLocalNativeAdapter(f.adapterOptions(), (adapter) =>
    adapter.importRegisteredProof(recordId, imported),
  );
  const original = await journal(f),
    before = f.state.requests.length;
  const row = original.requests.find(
    (r) =>
      r.requestSha256 ===
      original.mediaProofs[mediaId].audit.nativeReceipt.requestSha256,
  );
  assert.equal(
    row.receipt.metadataSha256,
    original.mediaProofs[mediaId].audit.nativeReceipt.metadataSha256,
  );
  assert.equal(original.version, 2);
  for (const mutate of [
    (j) => {
      delete j.mediaProofs[mediaId].audit;
    },
    (j) => {
      j.mediaProofs[mediaId].audit.provenance.proofSha256 = hash("e");
    },
    (j) => {
      j.requests.find(
        (r) => r.requestSha256 === row.requestSha256,
      ).receipt.resultSha256 = hash("e");
    },
    (j) => {
      j.requests.find((r) => r.requestSha256 === row.requestSha256).receipt =
        null;
    },
  ]) {
    const changed = JSON.parse(JSON.stringify(original));
    mutate(changed);
    await writeFile(
      path.join(f.directory, "checkpoint/local-native-journal.json"),
      JSON.stringify(changed),
      { mode: 0o600 },
    );
    await assert.rejects(
      withLocalNativeAdapter(f.adapterOptions(), () =>
        assert.fail("corrupt journal reached callback"),
      ),
    );
    assert.equal(f.state.requests.length, before);
  }
  assert.equal(f.state.binaryBytes, 0);
});

test("registered-media import rejects a foreign Native ID or historical environment", async (t) => {
  for (const mode of ["nativeId", "environment"]) {
    const f = await localHTTPFixture();
    t.after(() => f.close());
    const imported = registeredSyntheticMedia(f);
    if (mode === "nativeId") imported.evidence.nativeId = 21;
    else
      Object.assign(imported.provenance.target, {
        instance: "production",
        origin: "https://example.invalid",
      });
    await withLocalNativeAdapter(f.adapterOptions(), async (adapter) => {
      await rejects(
        () => adapter.importRegisteredProof(recordId, imported),
        mode === "nativeId"
          ? "NATIVE_MEDIA_IDENTITY_MISMATCH"
          : "HISTORICAL_PROOF_SCOPE_CHANGED",
      );
      assert.deepEqual(adapter.snapshot().mediaProofs, {});
      const result = await adapter.runDraftWorkflow();
      assert.equal(result.records[0].state, "HOLD");
    });
    assert.equal(f.state.saves, 0);
    assert.equal(f.state.binaryBytes, 0);
  }
});

async function childRun(f, action) {
  const config = path.join(f.directory, "child-options.json");
  await writeFile(config, JSON.stringify(f.adapterOptions()), { mode: 0o600 });
  const moduleURL = new URL("./local-native-adapter.mjs", import.meta.url).href;
  const source = `import {readFile} from 'node:fs/promises'; import process from 'node:process'; import {withLocalNativeAdapter} from ${JSON.stringify(moduleURL)};
    const options=JSON.parse(await readFile(process.argv[1],'utf8')); options.deadline=Date.now()+30000;
    const controller=new AbortController(); options.signal=controller.signal;
    if(process.argv[2]==='interrupt') options.onTransferProgress=async event=>{if(event.acknowledgedBytes>=262144)controller.abort();};
    const result=await withLocalNativeAdapter(options, adapter=>{
      if(process.argv[2]==='metadata-before-save') adapter.saveRegisteredDraft=async()=>{throw new Error('SYNTHETIC_PRE_SAVE_INTERRUPTION');};
      return adapter.runDraftWorkflow();
    });
    process.stdout.write(JSON.stringify(result));`;
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["--input-type=module", "-e", source, config, action],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    let stdout = "",
      stderr = "";
    child.stdout.on("data", (part) => {
      stdout += part;
    });
    child.stderr.on("data", (part) => {
      stderr += part;
    });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code !== 0)
        reject(
          new Error(
            `Synthetic child failed (${code}): ${stderr.slice(0, 2000)}`,
          ),
        );
      else resolve(JSON.parse(stdout));
    });
  });
}

test("fresh Node processes resume only missing chunks and then reuse with zero binary", async (t) => {
  const f = await localHTTPFixture();
  t.after(() => f.close());
  f.enforceDurableAdmission();
  const first = await childRun(f, "interrupt");
  assert.equal(first.records[0].state, "DRAFT_OUTCOME_UNKNOWN");
  assert.equal(f.state.binaryBytes, 262144);
  assert.equal(f.state.saves, 0);
  const second = await childRun(f, "resume");
  assert.equal(second.records[0].state, "WAITING_PRIVATE_PREPARATION_BINDING");
  const afterResume = f.state.binaryBytes;
  assert.equal(afterResume, f.bytes.length);
  assert.ok(Object.values(f.state.byIndex).every((count) => count === 1));
  const third = await childRun(f, "repeat");
  assert.equal(third.records[0].state, "WAITING_PRIVATE_PREPARATION_BINDING");
  assert.equal(f.state.binaryBytes, afterResume);
  assert.equal(f.state.saves, 1);
  assert.deepEqual(f.state.errors, []);
  t.diagnostic(
    JSON.stringify({
      processes: 3,
      interruptedBinaryBytes: 262144,
      totalBinaryBytes: afterResume,
      repeatedBinaryBytes: 0,
      saves: f.state.saves,
    }),
  );
});

test("three processes recover a pre-save metadata interruption through only the original metadata port", async (t) => {
  const f = await localHTTPFixture();
  t.after(() => f.close());
  f.enforceDurableAdmission();
  const imported = registeredSyntheticMedia(f);
  await withLocalNativeAdapter(f.adapterOptions(), (adapter) =>
    adapter.importRegisteredProof(recordId, imported),
  );
  const first = await childRun(f, "metadata-before-save");
  assert.equal(first.records[0].state, "DRAFT_OUTCOME_UNKNOWN");
  assert.deepEqual((await journal(f)).actions, {});
  assert.equal(f.state.saves, 0);
  const originalKey =
    first.checkpoint.records[recordId].actions["stage-draft"].operationKey;
  const second = await childRun(f, "metadata-resume");
  assert.equal(second.records[0].state, "WAITING_PRIVATE_PREPARATION_BINDING");
  assert.equal(
    second.checkpoint.records[recordId].actions["stage-draft"].operationKey,
    originalKey,
  );
  const third = await childRun(f, "metadata-repeat");
  assert.equal(third.records[0].state, "WAITING_PRIVATE_PREPARATION_BINDING");
  assert.equal(f.state.saves, 1);
  assert.equal(f.state.binaryBytes, 0);
  assert.equal(
    f.state.requests.filter((row) => row.route.includes("/media-upload/"))
      .length,
    0,
  );
  assert.deepEqual(f.state.errors, []);
});

test("metadata-only pre-save version race or observed withdrawal stops before save", async (t) => {
  for (const mode of ["revision", "withdrawn"]) {
    const f = await localHTTPFixture();
    t.after(() => f.close());
    f.enforceDurableAdmission();
    const imported = registeredSyntheticMedia(f);
    if (mode === "withdrawn") {
      f.state.main._status = "published";
      f.input.records[0].baselineStatus = "published";
    }
    await withLocalNativeAdapter(f.adapterOptions(), async (adapter) => {
      await adapter.importRegisteredProof(recordId, imported);
      const original = adapter.saveRegisteredDraft;
      adapter.saveRegisteredDraft = async (...args) => {
        if (mode === "revision") f.state.draft.revision++;
        else f.state.main._status = "draft";
        return original(...args);
      };
      const result = await adapter.runDraftWorkflow();
      assert.equal(result.records[0].state, "DRAFT_OUTCOME_UNKNOWN");
      if (mode === "withdrawn")
        assert.equal(
          result.checkpoint.records[recordId].protections.withdrawn,
          true,
        );
    });
    assert.equal(f.state.saves, 0);
    assert.equal(f.state.binaryBytes, 0);
    assert.equal(
      f.state.requests.filter((row) => row.route.includes("/media-upload/"))
        .length,
      0,
    );
  }
});

test("journal persistence failure prevents the target HTTP request", async (t) => {
  const f = await localHTTPFixture();
  t.after(() => f.close());
  await assert.rejects(() =>
    withLocalNativeAdapter(
      {
        ...f.adapterOptions(),
        beforeJournalPersist: async (saved) => {
          if (
            saved.requests.some(
              (row) => row.route.endsWith("/start") && row.status === "PENDING",
            )
          )
            throw new Error("SYNTHETIC_DISK_FAILURE");
        },
      },
      (adapter) => adapter.uploadMedia(recordId, mediaId),
    ),
  );
  assert.equal(
    f.state.requests.filter((row) => row.route.endsWith("/start")).length,
    0,
  );
  assert.equal(f.state.binaryBytes, 0);
});

test("foreign lock replacement and escaped adapter cannot dispatch", async (t) => {
  const f = await localHTTPFixture();
  t.after(() => f.close());
  let before, escaped;
  await rejects(
    () =>
      withLocalNativeAdapter(f.adapterOptions(), async (adapter) => {
        before = f.state.requests.length;
        const file = path.join(
          f.directory,
          "checkpoint/.catalog-workflow.lock",
        );
        await unlink(file);
        await writeFile(file, "FOREIGN_SYNTHETIC_LOCK", { mode: 0o600 });
        await adapter.inspectRecord(recordId);
      }),
    "CHECKPOINT_STORE_LOCK_CHANGED",
  );
  assert.equal(f.state.requests.length, before);
  assert.equal(
    await readFile(
      path.join(f.directory, "checkpoint/.catalog-workflow.lock"),
      "utf8",
    ),
    "FOREIGN_SYNTHETIC_LOCK",
  );
  await unlink(path.join(f.directory, "checkpoint/.catalog-workflow.lock"));
  await withLocalNativeAdapter(f.adapterOptions(), (adapter) => {
    escaped = adapter;
  });
  before = f.state.requests.length;
  await rejects(() => escaped.inspectRecord(recordId), "LOCAL_HTTP_CLOSED");
  assert.equal(f.state.requests.length, before);
});

test("callback completion retains lock until unawaited HTTP drains and final accounting persists", async (t) => {
  const f = await localHTTPFixture();
  t.after(() => f.close());
  f.enforceDurableAdmission();
  let arrived,
    ended = false,
    terminalPersist = false,
    inFlight;
  const started = new Promise((resolve) => {
    arrived = resolve;
  });
  f.state.responseOverride = async (req, res) => {
    if (req.url !== "/api/editorial/read-draft") return false;
    res.write('{"ok":');
    arrived();
    return true;
  };
  const lockFile = path.join(f.directory, "checkpoint/.catalog-workflow.lock");
  const result = await withLocalNativeAdapter(
    {
      ...f.adapterOptions(),
      beforeJournalPersist: async (saved) => {
        if (
          ended &&
          saved.requests.some(
            (row) =>
              row.route === "/api/editorial/read-draft" &&
              row.status === "UNKNOWN" &&
              row.drained,
          )
        ) {
          await access(lockFile);
          terminalPersist = true;
        }
      },
    },
    async (adapter) => {
      inFlight = adapter.inspectRecord(recordId).catch((error) => error.code);
      await started;
      ended = true;
      return "SYNTHETIC_CALLBACK_COMPLETE";
    },
  );
  assert.equal(result, "SYNTHETIC_CALLBACK_COMPLETE");
  assert.equal(await inFlight, "TRANSPORT_UNCERTAIN");
  assert.equal(terminalPersist, true);
  const saved = await journal(f),
    request = saved.requests.at(-1),
    reservation = saved.budget.requests.at(-1);
  assert.equal(request.status, "UNKNOWN");
  assert.equal(request.drained, true);
  assert.equal(reservation.actualUploadBytes, request.requestBodyBytes);
  assert.equal(reservation.actualDownloadBytes, request.responseBodyBytes);
  assert.match(reservation.drainEvidenceSha256, /^[a-f0-9]{64}$/);
  await rejects(() => access(lockFile), "ENOENT");
});

test("actual main published to draft transition is latched and blocks uploads", async (t) => {
  const f = await localHTTPFixture();
  t.after(() => f.close());
  f.input.records[0].baselineStatus = "published";
  await withLocalNativeAdapter(f.adapterOptions(), async (adapter) => {
    await rejects(
      () => adapter.uploadMedia(recordId, mediaId),
      "PROTECTED_RECORD",
    );
  });
  assert.equal(f.state.binaryBytes, 0);
  assert.equal(f.state.saves, 0);
  const cp = JSON.parse(
    await readFile(
      path.join(f.directory, "checkpoint/catalog-workflow-checkpoint.json"),
      "utf8",
    ),
  );
  assert.equal(cp.records[recordId].protections.withdrawn, true);
});

test("reuse-only with missing proof and native identity drift perform zero upload", async (t) => {
  for (const mode of ["reuseOnly", "identity"]) {
    const f = await localHTTPFixture();
    t.after(() => f.close());
    if (mode === "reuseOnly") f.manifest.records[0].reuseOnly = true;
    else f.state.main.sourceId = "source-other";
    await withLocalNativeAdapter(f.adapterOptions(), async (adapter) => {
      await rejects(
        () => adapter.uploadMedia(recordId, mediaId),
        mode === "reuseOnly"
          ? "REUSE_ONLY_PROOF_MISSING"
          : "NATIVE_MAIN_INVALID",
      );
    });
    assert.equal(f.state.binaryBytes, 0);
    assert.equal(
      f.state.requests.filter((row) => row.route.endsWith("/start")).length,
      0,
    );
  }
});

test("503 release remains HOLD without Native publication fallback", async (t) => {
  const f = await localHTTPFixture();
  t.after(() => f.close());
  await withLocalNativeAdapter(f.adapterOptions(), async (adapter) => {
    const result = await adapter.requestRelease(recordId, {
      intentId: "SYNTHETIC",
    });
    assert.deepEqual(result, {
      state: "HOLD",
      code: "CATALOG_DELIVERY_NOT_CONFIGURED",
    });
  });
  assert.equal(
    f.state.requests.filter((row) => row.method === "PATCH").length,
    0,
  );
  assert.equal(f.state.saves, 0);
});

test("a prepare refused for an oversized source keeps its category, not a retry", async (t) => {
  const f = await localHTTPFixture();
  t.after(() => f.close());
  const { client } = lowLevel(f);
  t.after(() => client.close());
  assert.equal((await client.handshake()).ok, true);
  f.state.responseOverride = async (req, res) => {
    if (req.url !== "/api/editorial/prepare-catalog-delivery") return false;
    res.statusCode = 422;
    res.setHeader("content-type", "application/json");
    res.end(
      JSON.stringify({
        ok: false,
        error: { code: "CATALOG_DELIVERY_SOURCE_TOO_LARGE", fields: ["media"] },
      }),
    );
    return true;
  };
  const refused = await client.send(
    "/api/editorial/prepare-catalog-delivery",
    "POST",
    { id: 10, expectedRevision: 2, expectedFingerprint: hash("d") },
  );
  assert.equal(refused.ok, false);
  assert.equal(refused.code, "CATALOG_DELIVERY_SOURCE_TOO_LARGE");
  assert.equal(refused.retryable, false);
});

function lowLevel(f, responseByteLimit = 1024, overrides = {}) {
  const options = f.adapterOptions(),
    scopeSha256 = hash("a");
  const journal = {
    executionKind: "local-http",
    scopeSha256,
    responseByteLimit,
    budget: createTransferBudget(
      scopeSha256,
      options.limits,
      { maxAttempts: 2, concurrency: 4, chunkBytes: 131072 },
      "local-http",
    ),
    requests: [],
  };
  const client = createLocalNativeHTTP({
    manifest: f.manifest,
    fixture: f.boundary,
    journal,
    persist: async () => {},
    assertAdmission: async () => {},
    deadline: Date.now() + 30000,
    timeoutMs: 300,
    ...overrides,
  });
  return { client, journal };
}

test("oversized and partial response bytes remain measured and charged", async (t) => {
  const f = await localHTTPFixture();
  t.after(() => f.close());
  const { client, journal: saved } = lowLevel(f);
  t.after(() => client.close());
  assert.equal((await client.handshake()).ok, true);
  f.state.responseOverride = async (req, res) => {
    if (req.url !== "/api/users/me") return false;
    res.write(Buffer.alloc(16384, 65));
    res.end();
    return true;
  };
  assert.equal((await client.send("/api/users/me")).code, "RESPONSE_TOO_LARGE");
  const row = saved.requests.at(-1),
    ledger = saved.budget.requests.at(-1);
  assert.equal(row.responseBodyBytes, 16384);
  assert.equal(ledger.actualDownloadBytes, 16384);
  assert.equal(client.metrics().overBudget, true);
  const before = f.state.requests.length;
  assert.equal(
    (await client.send("/api/users/me")).code,
    "TRANSFER_BUDGET_EXCEEDED",
  );
  assert.equal(f.state.requests.length, before);
  const partial = lowLevel(f, 32768);
  t.after(() => partial.client.close());
  await partial.client.handshake();
  f.state.responseOverride = async (req, res) => {
    if (req.url !== "/api/users/me") return false;
    res.write(Buffer.alloc(4096, 65));
    setTimeout(() => res.destroy(), 30);
    return true;
  };
  assert.equal(
    (await partial.client.send("/api/users/me")).code,
    "TRANSPORT_UNCERTAIN",
  );
  assert.equal(partial.journal.requests.at(-1).responseBodyBytes, 4096);
  assert.equal(
    partial.journal.budget.requests.at(-1).actualDownloadBytes,
    4096,
  );
  assert.ok(partial.client.metrics().chargedDownloadBytes >= 32768);
});

test("close while reservation persistence is pending prevents dispatch", async (t) => {
  const f = await localHTTPFixture();
  t.after(() => f.close());
  let release, arrived;
  const waiting = new Promise((resolve) => {
    arrived = resolve;
  });
  const { client } = lowLevel(f, 1024, {
    persist: async () => {
      arrived();
      await new Promise((resolve) => {
        release = resolve;
      });
    },
  });
  const send = client.handshake();
  await waiting;
  const closing = client.close();
  release();
  await rejects(() => send, "LOCAL_HTTP_CLOSED");
  await closing;
  assert.equal(f.state.requests.length, 0);
});

test("null-body HTTP status is safely recorded as uncertainty", async (t) => {
  const f = await localHTTPFixture();
  t.after(() => f.close());
  const { client } = lowLevel(f);
  t.after(() => client.close());
  await client.handshake();
  f.state.responseOverride = async (req, res) => {
    if (req.url !== "/api/users/me") return false;
    res.statusCode = 204;
    res.end();
    return true;
  };
  assert.equal(
    (await client.send("/api/users/me")).code,
    "TRANSPORT_UNCERTAIN",
  );
  assert.equal(client.metrics().activeRequests, 0);
});

test("only exact chunk busy conflict permits the protocol's bounded continuation", async (t) => {
  const f = await localHTTPFixture();
  t.after(() => f.close());
  const { client } = lowLevel(f);
  t.after(() => client.close());
  await client.handshake();
  let code = "CONCURRENT_OPERATION_BUSY";
  f.state.responseOverride = async (req, res) => {
    if (!req.url.includes("/chunk/")) return false;
    for await (const part of req) assert.ok(part.length > 0);
    res.statusCode = 409;
    res.end(JSON.stringify({ ok: false, error: { code } }));
    return true;
  };
  const body = Buffer.from([1, 2, 3]),
    route = `/api/editorial/media-upload/chunk/${hash("a")}/0`;
  const headers = {
    "Content-Length": "3",
    "x-editorial-chunk-sha256":
      "039058c6f2c0cb492c533b0a4d14ef77cc0f78abccced5287d84a1a2011cfb81",
  };
  assert.equal(
    (
      await client.send(
        route,
        "POST",
        new NativeChunkBody(body, 0),
        undefined,
        headers,
      )
    ).retryable,
    true,
  );
  code = "REVISION_CONFLICT";
  assert.equal(
    (
      await client.send(
        route,
        "POST",
        new NativeChunkBody(body, 0),
        undefined,
        headers,
      )
    ).retryable,
    false,
  );
  assert.equal(
    (
      await client.send(
        route,
        "POST",
        new NativeChunkBody(body, 0),
        undefined,
        headers,
      )
    ).code,
    "NATIVE_REQUEST_ATTEMPT_LIMIT",
  );
  assert.equal(f.state.requests.filter((row) => row.route === route).length, 2);
});

test("late successful write callback is included after uncertain response drains", async (t) => {
  const f = await localHTTPFixture();
  t.after(() => f.close());
  const original = http.request;
  t.after(() => {
    http.request = original;
  });
  const { client, journal: saved } = lowLevel(f, 1024, {
    persist: async () => {
      if (saved.budget.requests.at(-1)?.status === "UNKNOWN")
        await new Promise((resolve) => setTimeout(resolve, 50));
    },
  });
  t.after(() => client.close());
  http.request = (address) => {
    const handshake = new URL(address).pathname === "/__catalog_fixture";
    const req = new EventEmitter();
    req.write = (bytes, callback) => {
      setTimeout(() => callback(), 25);
      return true;
    };
    req.destroy = () => {
      queueMicrotask(() => req.emit("close"));
      return req;
    };
    req.end = () =>
      queueMicrotask(() => {
        const incoming = Readable.from([
          Buffer.from(
            handshake
              ? JSON.stringify({
                  kind: "catalog-native-isolated-http-v1",
                  fixtureId: f.boundary.id,
                })
              : "not-json",
          ),
        ]);
        incoming.statusCode = 200;
        incoming.headers = { "x-catalog-fixture": f.boundary.id };
        req.emit("response", incoming);
        if (handshake) setTimeout(() => req.emit("close"), 5);
      });
    return req;
  };
  await client.handshake();
  assert.equal(
    (await client.send("/api/editorial/read-draft", "POST", { id: 10 })).code,
    "TRANSPORT_UNCERTAIN",
  );
  const row = saved.requests.at(-1),
    ledger = saved.budget.requests.at(-1);
  assert.equal(
    row.requestBodyBytes,
    Buffer.byteLength(JSON.stringify({ id: 10 })),
  );
  assert.equal(ledger.actualUploadBytes, row.requestBodyBytes);
  assert.equal(client.metrics().knownActualUploadBytes, row.requestBodyBytes);
  assert.equal(row.drained, true);
  assert.equal(client.metrics().activeRequests, 0);
});

test("a refused withdrawal leaves its single attempt; an admission refusal records none", async (t) => {
  const f = await localHTTPFixture();
  t.after(() => f.close());
  let refuseAdmission = false;
  const { client, journal } = lowLevel(f, 1024, {
    assertAdmission: async ({ route } = {}) => {
      if (refuseAdmission && route?.startsWith("/api/catalogs/"))
        throw Object.assign(new Error("SYNTHETIC_ADMISSION"), {
          code: "CHECKPOINT_STORE_LOCK_CHANGED",
        });
    },
  });
  t.after(() => client.close());
  await client.handshake();
  let status = 409;
  f.state.responseOverride = async (req, res) => {
    if (req.method !== "PATCH") return false;
    for await (const part of req) assert.ok(part.length > 0);
    res.statusCode = status;
    res.end(JSON.stringify({ errors: [{ message: "SYNTHETIC" }] }));
    return true;
  };
  const route = "/api/catalogs/10?draft=false&depth=0",
    body = { revision: 2, _status: "draft" };
  refuseAdmission = true;
  await rejects(
    () => client.send(route, "PATCH", body),
    "CHECKPOINT_STORE_LOCK_CHANGED",
  );
  assert.equal(journal.requests.filter((r) => r.route === route).length, 0);
  refuseAdmission = false;
  const refused = await client.send(route, "PATCH", body);
  assert.equal(refused.ok, false);
  assert.equal(refused.httpStatus, 409);
  // A 5xx may have been applied: it consumes the only attempt.
  status = 500;
  assert.equal((await client.send(route, "PATCH", body)).httpStatus, 500);
  assert.equal(
    (await client.send(route, "PATCH", body)).code,
    "NATIVE_REQUEST_ATTEMPT_LIMIT",
  );
  assert.equal(f.state.requests.filter((r) => r.method === "PATCH").length, 2);
});

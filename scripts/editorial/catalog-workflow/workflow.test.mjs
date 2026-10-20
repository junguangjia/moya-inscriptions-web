import assert from "node:assert/strict";
import test from "node:test";
import { digest } from "./identity.mjs";
import {
  beginAction,
  createCheckpoint,
  markPhase,
  openCheckpoint,
} from "./checkpoint.mjs";
import {
  recordOfflinePhase,
  recordOfflineWithdrawal,
  runOfflineDraftWorkflow,
  runOfflineNativeAction,
} from "./workflow.mjs";
import {
  clone,
  fixture,
  harness,
  hash,
  inspection,
  media,
  native,
  prepareFakeReceipt,
} from "./test-fixtures.mjs";

const id = "SYNTHETIC-001";
const state = (h) => h.durable.records[id];
const rejects = (fn, code) =>
  assert.rejects(fn, (error) => error.code === code);
async function ready(h = harness()) {
  await runOfflineDraftWorkflow(h.options());
  const receipt = prepareFakeReceipt(h.durable, h.manifest);
  return { h, receipt, before: clone(state(h).draft) };
}
const release = (h, before, receipt, patch = {}) =>
  runOfflineNativeAction(
    h.options({
      kind: "release-intent",
      recordId: id,
      before,
      privateReadyReceipt: receipt,
      ...patch,
    }),
  );

test("unsupported execution modes fail before adapter creation", async () => {
  const h = harness();
  await rejects(
    () => runOfflineDraftWorkflow(h.options({ executionKind: "production" })),
    "LIVE_ADAPTER_NOT_BOUND",
  );
  assert.equal(h.calls.factory, 0);
});

test("draft rerun reuses exact results; publication stays unbound", async () => {
  const h = harness();
  for (let run = 0; run < 2; run++) {
    const result = await runOfflineDraftWorkflow(h.options());
    assert.equal(result.liveE2E, false);
    assert.equal(state(h).state, "WAITING_PRIVATE_PREPARATION_BINDING");
  }
  assert.equal(h.calls.stage, 1);
  assert.equal(h.calls.native, 0);
  assert.equal(state(h).phases.asset.status, "NOT_RUN");
});

test("reuse-only missing and conflicting proofs never enter upload or staging", async () => {
  for (const mode of ["missing", "wrong-sha", "wrong-source"]) {
    const h = harness(fixture({ reuseOnly: true }));
    if (mode !== "missing") {
      h.remote = inspection(h.manifest, native(h.manifest));
      if (mode === "wrong-sha") h.remote.mediaEvidence.mediaSha256 = hash("f");
      else h.remote.draft.sourceId = "source-other";
    }
    await runOfflineDraftWorkflow(h.options());
    assert.equal(state(h).state, "HOLD");
    assert.equal(h.calls.stage, 0);
    assert.equal(h.calls.native, 0);
  }
});

test("reuse-only adopts existing exact registered Media without calling stage", async () => {
  const h = harness(fixture({ reuseOnly: true, disposition: "draft" }));
  h.remote = inspection(h.manifest, native(h.manifest));
  await runOfflineDraftWorkflow(h.options());
  assert.equal(state(h).state, "DRAFT_VERIFIED");
  assert.equal(h.calls.stage, 0);
});

test("reuse-only B content update uses its metadata-only port and never staging", async () => {
  const h = harness(fixture({ reuseOnly: true }));
  h.remote = inspection(
    h.manifest,
    native(h.manifest, { contentSha256: hash("f") }),
  );
  let saves = 0;
  h.adapter.saveRegisteredDraft = async ({ action }) => {
    saves++;
    assert.equal(action.binding.before.draft.revision, 2);
    h.remote.draft = native(h.manifest, { revision: 3 });
    return {
      native: clone(h.remote.draft),
      mediaEvidence: clone(h.remote.mediaEvidence),
    };
  };
  for (let repeat = 0; repeat < 2; repeat++)
    await runOfflineDraftWorkflow(h.options());
  assert.equal(saves, 1);
  assert.equal(h.calls.stage, 0);
  assert.equal(h.calls.native, 0);
  assert.equal(state(h).state, "WAITING_PRIVATE_PREPARATION_BINDING");
});

test("reuse-only missing proof cannot invoke its metadata-only save port", async () => {
  const h = harness(fixture({ reuseOnly: true }));
  let saves = 0;
  h.adapter.saveRegisteredDraft = async () => {
    saves++;
  };
  await runOfflineDraftWorkflow(h.options());
  assert.equal(saves, 0);
  assert.equal(h.calls.stage, 0);
  assert.equal(state(h).state, "HOLD");
});

test("reuse-only pending phase before save journal resumes only the original metadata port", async () => {
  const h = harness(fixture({ reuseOnly: true }));
  h.remote = inspection(
    h.manifest,
    native(h.manifest, { contentSha256: hash("f") }),
  );
  let saves = 0,
    originalKey;
  h.persistHook = async (value) => {
    const action = value.records[id].actions["stage-draft"];
    if (action?.attempts === 1)
      throw new Error("SYNTHETIC_EXIT_BEFORE_METADATA_SAVE");
    if (action) originalKey = action.operationKey;
  };
  h.adapter.saveRegisteredDraft = async ({ action }) => {
    saves++;
    assert.equal(action.operationKey, originalKey);
    h.remote.draft = native(h.manifest, { revision: 3 });
    return {
      native: clone(h.remote.draft),
      mediaEvidence: clone(h.remote.mediaEvidence),
    };
  };
  await rejects(
    () => runOfflineDraftWorkflow(h.options()),
    "CHECKPOINT_PERSIST_FAILED",
  );
  assert.equal(saves, 0);
  assert.equal(state(h).actions["stage-draft"].status, "PENDING");
  h.persistHook = null;
  h.reconcileHook = async () => ({
    outcome: "resumable",
    requestIdentityVerified: true,
  });
  await runOfflineDraftWorkflow(h.options());
  assert.equal(saves, 1);
  assert.equal(h.calls.stage, 0);
  assert.equal(state(h).state, "WAITING_PRIVATE_PREPARATION_BINDING");
});

test("draft lost response reconciles existing server result without another binary call", async () => {
  const h = harness();
  h.stageHook = async () => {
    h.remote.draft = native(h.manifest);
    h.remote.mediaEvidence = media(h.manifest);
    throw new Error("SYNTHETIC_PRIVATE_DIAGNOSTIC");
  };
  await runOfflineDraftWorkflow(h.options());
  assert.equal(state(h).actions["stage-draft"].status, "UNKNOWN");
  assert.equal(
    JSON.stringify(h.durable).includes("SYNTHETIC_PRIVATE_DIAGNOSTIC"),
    false,
  );
  await runOfflineDraftWorkflow(h.options());
  assert.equal(h.calls.stage, 1);
  assert.equal(h.calls.reconcile, 1);
  assert.equal(state(h).actions["stage-draft"].status, "VERIFIED");
});

test("existing draft update cannot switch Native id or skip its frozen CAS revision", async () => {
  for (const patch of [{ id: 99, revision: 1 }, { revision: 9 }]) {
    const h = harness();
    h.remote = inspection(
      h.manifest,
      native(h.manifest, { contentSha256: hash("f") }),
    );
    h.stageHook = async () => {
      h.remote.draft = native(h.manifest, patch);
      h.remote.mediaEvidence = media(h.manifest);
      return { native: h.remote.draft, mediaEvidence: h.remote.mediaEvidence };
    };
    await runOfflineDraftWorkflow(h.options());
    assert.equal(state(h).draft, null);
    assert.equal(state(h).actions["stage-draft"].code, "DRAFT_PROOF_MISMATCH");
    assert.equal(state(h).actions["stage-draft"].status, "UNKNOWN");
    await runOfflineDraftWorkflow(h.options());
    assert.equal(state(h).state, "HOLD");
    assert.equal(h.calls.stage, 1);
  }
});

test("only the existing non-reuse request can resume under its original identity", async () => {
  const h = harness();
  let firstKey;
  h.stageHook = async ({ action }) => {
    firstKey = action.operationKey;
    throw new Error("synthetic loss");
  };
  await runOfflineDraftWorkflow(h.options());
  h.reconcileHook = async () => ({
    outcome: "resumable",
    requestIdentityVerified: true,
  });
  h.stageHook = async ({ action }) => {
    assert.equal(action.operationKey, firstKey);
    h.remote.draft = native(h.manifest);
    h.remote.mediaEvidence = media(h.manifest);
    return { native: h.remote.draft, mediaEvidence: h.remote.mediaEvidence };
  };
  await runOfflineDraftWorkflow(h.options());
  assert.equal(h.calls.stage, 2);
  assert.equal(state(h).actions["stage-draft"].attempts, 2);
});

test("persisted uncertain reuse-only draft never resumes staging", async () => {
  const h = harness(fixture({ reuseOnly: true }));
  h.durable = createCheckpoint(h.manifest);
  beginAction(h.durable, id, "stage-draft", {
    contentSha256: h.manifest.records[0].contentSha256,
    mediaSha256: digest(h.manifest.records[0].media),
    before: inspection(h.manifest),
  });
  h.reconcileHook = async () => ({
    outcome: "resumable",
    requestIdentityVerified: true,
  });
  await runOfflineDraftWorkflow(h.options());
  assert.equal(h.calls.stage, 0);
  assert.equal(state(h).state, "DRAFT_OUTCOME_UNKNOWN");
});

for (const key of ["rightsHold", "explicitlyHidden", "withdrawn"]) {
  test(`${key} blocks release from manifest, checkpoint and fresh observation`, async () => {
    for (const location of ["manifest", "checkpoint", "fresh"]) {
      const { h, receipt, before } = await ready();
      if (location === "manifest")
        h.manifest.records[0].protections[key] = true;
      else if (location === "checkpoint") state(h).protections[key] = true;
      else h.remote.protections[key] = true;
      await release(h, before, receipt);
      assert.equal(h.calls.native, 0);
      assert.equal(state(h).protections[key], true);
      assert.equal(state(h).state, "HOLD");
    }
  });
}

test("full input drift holds before adapter creation and cannot reuse old success", async () => {
  for (const alter of [
    (row) => {
      row.sourceId = "source-changed";
    },
    (row) => {
      row.media[0].uploadedSha256 = hash("f");
    },
    (row) => {
      row.media[0].position = 3;
    },
    (row) => {
      row.disposition = "draft";
    },
    (row) => {
      row.reuseOnly = true;
    },
  ]) {
    const h = harness();
    await runOfflineDraftWorkflow(h.options());
    const factory = h.calls.factory;
    alter(h.manifest.records[0]);
    await runOfflineDraftWorkflow(h.options());
    assert.equal(state(h).code, "CHECKPOINT_INPUT_CHANGED");
    assert.equal(h.calls.factory, factory);
    assert.equal(h.calls.stage, 1);
  }
});

test("fresh authentication checks allow renewed credentials but reject account or scope drift", async () => {
  const h = harness();
  await runOfflineDraftWorkflow(h.options());
  h.principal.sessionToken = "SYNTHETIC_RENEWED_SESSION";
  await runOfflineDraftWorkflow(h.options());
  assert.equal(h.calls.stage, 1);
  for (const patch of [
    { actorId: 2 },
    { role: "automation" },
    { origin: "https://example.invalid" },
    { scopeCatalogIds: [] },
  ])
    await rejects(
      () =>
        runOfflineDraftWorkflow(
          h.options({
            createAdapter: async () => ({
              ...h.adapter,
              verifyPrincipal: async () => ({ ...h.principal, ...patch }),
            }),
          }),
        ),
      "PRINCIPAL_OR_SCOPE_CHANGED",
    );
  assert.equal(
    JSON.stringify(h.durable).includes("SYNTHETIC_RENEWED_SESSION"),
    false,
  );
});

test("Native lost answer after commit recovers read-only with one revision increment", async () => {
  const { h, receipt, before } = await ready();
  h.mutateHook = async () => {
    h.remote.main = {
      ...before,
      revision: before.revision + 1,
      status: "published",
    };
    throw Object.assign(new Error("SYNTHETIC_RAW_BODY"), {
      code: "SYNTHETIC_UNTRUSTED_CODE",
    });
  };
  await release(h, before, receipt);
  assert.equal(state(h).actions["release-intent"].status, "UNKNOWN");
  await release(h, before, receipt);
  assert.equal(h.calls.native, 1);
  assert.equal(h.calls.reconcile, 1);
  assert.equal(state(h).intent.revision, before.revision + 1);
  assert.equal(state(h).state, "NATIVE_RELEASE_CONFIRMED_NOT_DELIVERY");
  assert.equal(JSON.stringify(h.durable).includes("SYNTHETIC_RAW_BODY"), false);
  assert.equal(
    JSON.stringify(h.durable).includes("SYNTHETIC_UNTRUSTED_CODE"),
    false,
  );
});

test("a durable pending Native action with unchanged remote is never replayed", async () => {
  const { h, receipt, before } = await ready();
  h.persistHook = async (value) => {
    if (value.records[id].actions["release-intent"]?.attempts === 1)
      h.now = 1000;
  };
  await release(h, before, receipt);
  assert.equal(h.calls.native, 0);
  assert.equal(state(h).actions["release-intent"].status, "PENDING");
  h.persistHook = null;
  h.now = 0;
  await release(h, before, receipt);
  await release(h, before, receipt);
  assert.equal(h.calls.native, 0);
  assert.equal(state(h).state, "NATIVE_OUTCOME_UNKNOWN");
});

test("completion persistence failure after Native commit recovers from pending without replay", async () => {
  const { h, receipt, before } = await ready();
  h.persistHook = async (value) => {
    if (value.records[id].actions["release-intent"]?.status === "VERIFIED")
      throw new Error("synthetic disk failure");
  };
  await rejects(() => release(h, before, receipt), "CHECKPOINT_PERSIST_FAILED");
  assert.equal(state(h).actions["release-intent"].status, "PENDING");
  h.persistHook = null;
  await release(h, before, receipt);
  assert.equal(h.calls.native, 1);
  assert.equal(state(h).actions["release-intent"].status, "VERIFIED");
});

test("pending persistence failure prevents Native dispatch", async () => {
  const { h, receipt, before } = await ready();
  h.persistHook = async (value) => {
    if (value.records[id].actions["release-intent"])
      throw new Error("synthetic disk failure");
  };
  await rejects(() => release(h, before, receipt), "CHECKPOINT_PERSIST_FAILED");
  assert.equal(h.calls.native, 0);
  assert.equal(state(h).actions["release-intent"], undefined);
});

test("cancellation before pending dispatch prevents Native mutation", async () => {
  const { h, receipt, before } = await ready();
  const signal = { aborted: false };
  h.persistHook = async (value) => {
    if (value.records[id].actions["release-intent"]) signal.aborted = true;
  };
  await release(h, before, receipt, { signal });
  assert.equal(h.calls.native, 0);
  assert.equal(state(h).code, "WORKFLOW_CANCELLED");
});

test("missing private-ready evidence and failed asset cannot authorize Native release", async () => {
  for (const mode of ["missing", "failed", "stale", "unknown"]) {
    const { h, receipt, before } = await ready();
    if (mode === "failed")
      markPhase(state(h), "asset", "FAILED", hash("e"), "SOURCE_UNREADABLE");
    if (mode === "unknown")
      markPhase(state(h), "rendition", "UNKNOWN", null, "EVIDENCE_UNAVAILABLE");
    if (mode === "stale")
      receipt.nativeSha256 = digest({
        ...before,
        revision: before.revision - 1,
      });
    receipt.jobSucceeded = true;
    await release(h, before, mode === "missing" ? null : receipt);
    assert.equal(h.calls.native, 0);
    assert.equal(state(h).code, "PRIVATE_PREPARATION_NOT_BOUND");
  }
});

test("Owner authority and second preflight are checked before the single CAS", async () => {
  for (const mode of ["unverified", "changed", "hidden"]) {
    const { h, receipt, before } = await ready();
    h.authorizeHook = async () => {
      if (mode === "changed") h.remote.draft.revision++;
      if (mode === "hidden") h.remote.protections.explicitlyHidden = true;
      return {
        verified: mode !== "unverified",
        mode: "owner-native",
        nativeSha256: digest(before),
        referenceSha256: hash("f"),
      };
    };
    await release(h, before, receipt);
    assert.equal(h.calls.native, 0);
    assert.equal(state(h).state, "HOLD");
  }
});

test("definitive CAS rejection stays failed without a fresh-revision retry", async () => {
  const { h, receipt, before } = await ready();
  h.mutateHook = async () => {
    throw Object.assign(new Error("synthetic conflict"), {
      code: "REVISION_CONFLICT",
      definitivelyRejected: true,
    });
  };
  await release(h, before, receipt);
  await release(h, before, receipt);
  assert.equal(h.calls.native, 1);
  assert.equal(state(h).actions["release-intent"].status, "FAILED");
  assert.equal(h.calls.reconcile, 0);
});

test("cached release success cannot restore a freshly hidden or withdrawn record", async () => {
  const { h, receipt, before } = await ready();
  await release(h, before, receipt);
  h.remote.protections.explicitlyHidden = true;
  await release(h, before, receipt);
  assert.equal(state(h).state, "HOLD");
  assert.equal(h.calls.native, 1);
  assert.equal(state(h).protections.explicitlyHidden, true);
});

test("a different original revision cannot take over an existing action", async () => {
  const { h, receipt, before } = await ready();
  await release(h, before, receipt);
  await release(h, { ...before, revision: before.revision + 1 }, receipt);
  assert.equal(state(h).code, "ACTION_BINDING_CHANGED");
  assert.equal(h.calls.native, 1);
});

test("already-published release and already-draft withdrawal never increment revisions", async () => {
  for (const kind of ["release-intent", "withdraw-intent"]) {
    const { h, receipt, before } = await ready();
    const changed = {
      ...before,
      status: kind === "release-intent" ? "published" : "draft",
    };
    h.remote.draft = changed;
    h.remote.main = changed;
    await runOfflineNativeAction(
      h.options({
        kind,
        recordId: id,
        before: changed,
        privateReadyReceipt: receipt,
      }),
    );
    assert.equal(h.calls.native, 0);
    assert.equal(h.calls.authorize, 0);
    assert.equal(state(h).code, "CURRENT_NATIVE_STATE_CHANGED");
  }
});

test("reloaded Native pointers and phase evidence must match their verified action result", async () => {
  const { h, receipt, before } = await ready();
  await release(h, before, receipt);
  for (const pointer of ["draft", "intent"]) {
    const cp = clone(h.durable);
    cp.records[id][pointer].revision += 10;
    assert.throws(
      () => openCheckpoint(h.manifest, cp),
      (e) => e.code === "CHECKPOINT_INVALID",
    );
  }
  await runOfflineNativeAction(
    h.options({
      kind: "withdraw-intent",
      recordId: id,
      before: state(h).intent,
    }),
  );
  const cp = clone(h.durable);
  cp.records[id].withdrawn.revision += 10;
  assert.throws(
    () => openCheckpoint(h.manifest, cp),
    (e) => e.code === "CHECKPOINT_INVALID",
  );
});

test("old A public evidence is rejected for B and protected DTO evidence is rejected", async () => {
  const { h, receipt, before } = await ready();
  await release(h, before, receipt);
  const observation = {
    executionKind: "offline-fake",
    bindingSha256: digest({ ...state(h).intent, revision: 1 }),
    status: "VERIFIED",
    evidenceSha256: hash("e"),
  };
  assert.throws(
    () => recordOfflinePhase(h.durable, id, "DTO-edge", observation),
    (e) => e.code === "PHASE_EVIDENCE_SCOPE_MISMATCH",
  );
  observation.bindingSha256 = digest(state(h).intent);
  state(h).protections.withdrawn = true;
  assert.throws(
    () => recordOfflinePhase(h.durable, id, "DTO-edge", observation),
    (e) => e.code === "PROTECTED_RECORD_EVIDENCE_REJECTED",
  );
  assert.equal(state(h).phases["DTO-edge"].status, "NOT_RUN");
});

test("warmed withdrawal remains pending until origin, purge and every warmed target agree", async () => {
  const { h, receipt, before } = await ready();
  await release(h, before, receipt);
  const published = clone(state(h).intent);
  await runOfflineNativeAction(
    h.options({ kind: "withdraw-intent", recordId: id, before: published }),
  );
  assert.equal(h.calls.native, 2);
  const observation = {
    executionKind: "offline-fake",
    bindingSha256: digest(state(h).withdrawn),
    nativeDraft: true,
    listAbsent: true,
    detailAbsent: true,
    searchAbsent: true,
    originDenied: true,
    purgeConfirmed: false,
    warmedEdgeDenied: false,
    expectedWarmedTargets: 2,
    verifiedWarmedTargets: 0,
    evidenceSha256: hash("e"),
  };
  recordOfflineWithdrawal(h.durable, id, observation);
  assert.equal(state(h).state, "WITHDRAWAL_PENDING");
  observation.purgeConfirmed = true;
  observation.warmedEdgeDenied = true;
  observation.verifiedWarmedTargets = 1;
  recordOfflineWithdrawal(h.durable, id, observation);
  assert.equal(state(h).phases.withdrawal.status, "PENDING");
  observation.verifiedWarmedTargets = 2;
  recordOfflineWithdrawal(h.durable, id, observation);
  assert.equal(state(h).state, "WITHDRAWN_VERIFIED");
  assert.equal(h.calls.native, 2);
});

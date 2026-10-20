import assert from "node:assert/strict";
import test from "node:test";
import { digest } from "./identity.mjs";
import {
  beginAction,
  createCheckpoint,
  latchProtections,
  markPhase,
  openCheckpoint,
} from "./checkpoint.mjs";
import {
  clone,
  fixture,
  hash,
  inspection,
  native,
  protection,
} from "./test-fixtures.mjs";

const rejects = (fn, code) => assert.throws(fn, (error) => error.code === code);
function staged() {
  const manifest = fixture(),
    checkpoint = createCheckpoint(manifest),
    row = manifest.records[0];
  const binding = {
    contentSha256: row.contentSha256,
    mediaSha256: digest(row.media),
    before: inspection(manifest),
  };
  const action = beginAction(checkpoint, row.recordId, "stage-draft", binding);
  return { manifest, checkpoint, row, binding, action };
}

test("action binding is copied and deeply frozen before its identity is stored", () => {
  const { binding, action } = staged(),
    initial = digest(action.binding);
  binding.before.protections.rightsHold = true;
  binding.contentSha256 = hash("f");
  assert.equal(digest(action.binding), initial);
  assert.equal(action.bindingSha256, initial);
  assert.ok(Object.isFrozen(action.binding.before.protections));
  assert.throws(() => {
    action.binding.before.main = {};
  }, TypeError);
});

test("unknown binding fields cannot persist a token or signed address", () => {
  for (const place of ["root", "before", "protections"]) {
    const manifest = fixture(),
      checkpoint = createCheckpoint(manifest),
      row = manifest.records[0];
    const binding = {
      contentSha256: row.contentSha256,
      mediaSha256: digest(row.media),
      before: inspection(manifest),
    };
    const target =
      place === "root"
        ? binding
        : place === "before"
          ? binding.before
          : binding.before.protections;
    target.sessionToken = "SYNTHETIC_ONLY_NO_AUTHORIZATION";
    rejects(
      () => beginAction(checkpoint, row.recordId, "stage-draft", binding),
      "ACTION_BINDING_INVALID",
    );
    assert.equal(JSON.stringify(checkpoint).includes("SYNTHETIC_ONLY"), false);
  }
});

test("saved source identity is checked even when manifest digest is unchanged", () => {
  const { manifest, checkpoint, row } = staged();
  checkpoint.records[row.recordId].sourceId = "source-unrelated";
  rejects(() => openCheckpoint(manifest, checkpoint), "CHECKPOINT_INVALID");
  checkpoint.records[row.recordId].sourceId = 123;
  rejects(() => openCheckpoint(manifest, checkpoint), "CHECKPOINT_INVALID");
});

test("corrupted phase, history and evidence cannot be reloaded", () => {
  const original = staged();
  const changes = [
    (cp, state) => {
      state.phases.asset = {
        status: "VERIFIED",
        evidenceSha256: null,
        code: null,
      };
    },
    (cp, state) => {
      state.phases.asset.status = "VERIFIED";
      state.phases.asset.evidenceSha256 = hash("a");
    },
    (cp, state) => {
      state.history.push({
        phase: "asset",
        status: "VERIFIED",
        evidenceSha256: "bad",
        code: null,
      });
    },
    (cp, state) => {
      state.phases.asset.code = "UPSTREAM_RAW_TEXT";
    },
    (cp, state) => {
      state.draft = {
        ...native(original.manifest),
        unexpected: "SYNTHETIC_ONLY",
      };
    },
    (cp, state) => {
      state.intent = native(original.manifest);
    },
    (cp) => {
      cp.extra = true;
    },
  ];
  for (const alter of changes) {
    const cp = clone(original.checkpoint);
    alter(cp, cp.records[original.row.recordId]);
    assert.throws(() => openCheckpoint(original.manifest, cp));
  }
});

test("corrupted saved action identity, binding, outcome and result are rejected", () => {
  const original = staged();
  for (const alter of [
    (action) => {
      action.operationKey = "replacement";
    },
    (action) => {
      action.bindingSha256 = hash("f");
    },
    (action) => {
      action.binding.before.protections.withdrawn = true;
    },
    (action) => {
      action.status = "COMPLETE";
    },
    (action) => {
      action.attempts = -1;
    },
    (action) => {
      action.code = "RAW_UNTRUSTED_CODE";
    },
    (action) => {
      action.result = native(original.manifest);
    },
    (action) => {
      action.status = "VERIFIED";
    },
    (action) => {
      action.binding.url = "https://example.invalid/synthetic";
    },
  ]) {
    const cp = clone(original.checkpoint);
    alter(cp.records[original.row.recordId].actions["stage-draft"]);
    rejects(
      () => openCheckpoint(original.manifest, cp),
      "CHECKPOINT_ACTION_INVALID",
    );
  }
});

test("phase history is append-only for changed observations and reloads consistently", () => {
  const manifest = fixture(),
    cp = createCheckpoint(manifest),
    state = cp.records[manifest.records[0].recordId];
  markPhase(state, "asset", "PENDING", null, "PROCESSING_PENDING");
  markPhase(state, "asset", "PENDING", null, "PROCESSING_PENDING");
  markPhase(state, "asset", "FAILED", hash("f"), "SOURCE_UNREADABLE");
  assert.equal(state.history.length, 2);
  assert.equal(openCheckpoint(manifest, clone(cp)).inputMatches, true);
});

test("full input drift is not adopted and new protections are monotonic", () => {
  const manifest = fixture(),
    cp = createCheckpoint(manifest),
    changed = clone(manifest),
    id = manifest.records[0].recordId;
  changed.records[0].protections.rightsHold = true;
  const opened = openCheckpoint(changed, cp);
  assert.equal(opened.inputMatches, false);
  assert.equal(opened.checkpoint.records[id].protections.rightsHold, true);
  const restored = openCheckpoint(manifest, opened.checkpoint);
  assert.equal(restored.checkpoint.records[id].protections.rightsHold, true);
  latchProtections(restored.checkpoint.records[id], protection());
  assert.equal(restored.checkpoint.records[id].protections.rightsHold, true);
});

test("scope drift and undeclared record keys cannot take over a checkpoint", () => {
  const manifest = fixture(),
    cp = createCheckpoint(manifest),
    changed = clone(manifest);
  changed.target.actorId = 2;
  rejects(() => openCheckpoint(changed, cp), "CHECKPOINT_SCOPE_MISMATCH");
  const bad = clone(cp);
  bad.records.unselected = clone(Object.values(bad.records)[0]);
  rejects(() => openCheckpoint(manifest, bad), "CHECKPOINT_INVALID");
});

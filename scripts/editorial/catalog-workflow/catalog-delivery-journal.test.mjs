import assert from "node:assert/strict";
import test from "node:test";
import { editorialDraftSchema } from "../../../packages/contracts/dist/internal/editorial/index.js";
import { fixture, clone, hash, protection } from "./test-fixtures.mjs";
import { digest } from "./identity.mjs";
import {
  CATALOG_DELIVERY_CONTRACT_SHA256,
  normalizePayloadBridgeBinding,
  frozenCatalogDeliveryBinding,
  openCatalogDeliveryJournal,
  createCatalogDeliveryClient,
} from "./catalog-delivery-journal.mjs";

const UUID = "00000000-0000-4000-8000-000000000001";
const recordId = "SYNTHETIC-001";
export function deliveryFixture() {
  const manifest = fixture(),
    record = manifest.records[0],
    a = record.media[0];
  const content = editorialDraftSchema.parse({
    catalogId: record.catalogId,
    sourceId: record.sourceId,
    kind: "inscription",
    title: "Synthetic delivery B",
    summary: "Synthetic",
    periodLabel: "Synthetic",
    media: [
      {
        mediaId: a.mediaId,
        objectKey: "editorial/synthetic.png",
        width: a.width,
        height: a.height,
        alt: "Synthetic",
        position: a.position,
        isRepresentative: true,
      },
    ],
  });
  record.contentSha256 = digest(content);
  const ready = {
    version: 1,
    status: "READY",
    credentialMaterialInThisFile: false,
    environmentMarker: "synthetic-unit-fixture",
    origin: manifest.target.origin,
    actorId: 1,
    fixtureCatalogDocumentId: 10,
    fixtureCatalogId: record.catalogId,
    expiresAt: "2099-01-01T00:00:00.000Z",
    jwtExpiresAt: "2099-01-01T00:00:00.000Z",
    contractSha256: CATALOG_DELIVERY_CONTRACT_SHA256,
    caps: {
      requests: 96,
      requestBodyPerRequest: 1048576,
      acceptedRequestBodyTotal: 4194304,
      responseBodyTotal: 2097152,
    },
  };
  const binding = normalizePayloadBridgeBinding(manifest, ready);
  const draft = { id: 10, revision: 2, fingerprint: hash("d"), content },
    main = {
      id: 10,
      revision: 1,
      status: "published",
      content: { ...content, title: "Synthetic public A" },
    };
  const proof = {
    media: {
      mediaId: a.mediaId,
      objectKey: content.media[0].objectKey,
      catalogId: record.catalogId,
      sha256: a.uploadedSha256,
      filesize: a.bytes,
      width: a.width,
      height: a.height,
    },
    uploadedSha256: a.uploadedSha256,
    sourceSha256: a.sourceSha256,
  };
  const frozen = [frozenCatalogDeliveryBinding(record, draft, [proof])],
    b = frozen[0];
  const h = {
    manifest,
    binding,
    ready,
    frozen,
    draft,
    main,
    protections: protection(),
    saved: null,
    commands: [],
    reads: 0,
    receipts: new Map(),
    drop: null,
    result: null,
    admissionFailure: false,
    failureBeforePersist: false,
  };
  h.send = async (route, method, body) => {
    assert.equal(method, "POST");
    if (route.endsWith("read-catalog-delivery")) {
      h.reads++;
      return { ok: true, result: { ok: true, result: clone(h.result) } };
    }
    const operation = Object.entries({
      prepare: "prepare-catalog-delivery",
      request: "request-catalog-release",
      release: "release-catalog-delivery",
      cancel: "cancel-catalog-delivery",
    }).find(([, suffix]) => route.endsWith(suffix))[0];
    assert.equal(
      h.saved.actions[`${recordId}:${operation}`].attempts.at(-1).status,
      "PENDING",
    );
    h.commands.push({ operation, body: clone(body) });
    const replayed = h.receipts.has(body.idempotencyKey);
    if (!replayed) {
      h.receipts.set(body.idempotencyKey, JSON.stringify(body));
      if (operation === "prepare")
        h.result = {
          intentId: UUID,
          id: b.id,
          catalogId: b.catalogId,
          revision: b.revision,
          fingerprint: b.fingerprint,
          manifestSha256: b.manifestSha256,
          mediaCount: b.mediaCount,
          recipeManifestSha256: hash("e"),
          state: "prepared",
          stateVersion: 1,
          readiness: "PENDING",
          publicCopyAuthorized: false,
          expiresAt: binding.expiresAt,
          replayed: false,
        };
      else {
        h.result.stateVersion++;
        h.result.state = {
          request: "release_requested",
          release: "released",
          cancel: "cancelled",
        }[operation];
        if (operation === "request") {
          h.result.publicCopyAuthorized = true;
          h.result.readiness = "READY";
        }
        if (operation === "release") {
          h.draft.revision = b.revision + 1;
          h.main = { ...clone(h.draft), status: "published" };
        }
      }
    } else
      assert.equal(h.receipts.get(body.idempotencyKey), JSON.stringify(body));
    const result = { ...clone(h.result), replayed };
    if (h.drop === operation) {
      h.drop = null;
      return { ok: false, code: "TRANSPORT_UNCERTAIN" };
    }
    return { ok: true, result: { ok: true, result } };
  };
  h.client = () => {
    const journal = openCatalogDeliveryJournal({
      manifest,
      binding,
      frozen,
      saved: h.saved,
    });
    return createCatalogDeliveryClient({
      manifest,
      binding,
      frozen,
      journal,
      persist: async (s) => {
        if (h.failureBeforePersist) throw Error("SYNTHETIC_DISK_FAILURE");
        h.saved = clone(s);
      },
      assertAdmission: async () => {
        if (h.admissionFailure) throw Error("SYNTHETIC_LOCK_LOST");
      },
      send: h.send,
      verifyAccount: async () => ({
        ...manifest.target,
        verified: true,
        scopeCatalogIds: [record.catalogId],
      }),
      inspectRecord: async () => ({
        draft: clone(h.draft),
        main: clone(h.main),
        protections: clone(h.protections),
      }),
      deadline: Date.parse(binding.expiresAt),
    });
  };
  h.prepare = {
    id: b.id,
    expectedRevision: b.revision,
    expectedFingerprint: b.fingerprint,
  };
  h.request = () => ({
    intentId: UUID,
    expectedStateVersion: h.result.stateVersion,
    expectedManifestSha256: b.manifestSha256,
  });
  h.release = () => ({
    intentId: UUID,
    expectedStateVersion: h.result.stateVersion,
    expectedRevision: b.revision,
    expectedFingerprint: b.fingerprint,
  });
  return h;
}

test("all five r1 actions retain B identity, separate Native confirmation and never imply anonymous ready", async () => {
  const h = deliveryFixture(),
    client = h.client();
  const prepared = await client.execute(recordId, "prepare", h.prepare);
  assert.equal(prepared.status, "RECEIPT_CONFIRMED");
  assert.equal(h.main.content.title, "Synthetic public A");
  await client.execute(recordId, "read", { intentId: UUID });
  await client.execute(recordId, "request", h.request());
  const releaseInput = h.release(),
    released = await client.execute(recordId, "release", releaseInput);
  assert.equal(released.result.revision, 2);
  assert.equal(h.main.revision, 3);
  assert.equal(released.nativePublicationVerified, true);
  assert.equal(released.anonymousDeliveryVerified, false);
  assert.equal(new Set(h.commands.map((c) => c.body.idempotencyKey)).size, 3);
  const priorCalls = h.commands.length;
  h.draft.revision = 4;
  const later = await client.execute(recordId, "release", releaseInput);
  assert.equal(later.nativePublicationVerified, false);
  assert.equal(h.commands.length, priorCalls);
  await assert.rejects(
    client.execute(recordId, "cancel", {
      intentId: UUID,
      expectedStateVersion: h.result.stateVersion,
    }),
    { code: "DELIVERY_ACTION_INVALID" },
  );
  await client.close();
  assert.throws(() => client.execute(recordId, "read", { intentId: UUID }), {
    code: "DELIVERY_CLIENT_CLOSED",
  });
  const c = deliveryFixture(),
    cc = c.client();
  await cc.execute(recordId, "prepare", c.prepare);
  const cancelled = await cc.execute(recordId, "cancel", {
    intentId: UUID,
    expectedStateVersion: c.result.stateVersion,
  });
  assert.equal(cancelled.status, "HOLD");
  assert.equal(cancelled.result.state, "cancelled");
});

test("lost prepare/request/release replies reload and replay exact original key/body; read cannot attribute commands", async () => {
  const h = deliveryFixture();
  h.drop = "prepare";
  assert.equal(
    (await h.client().execute(recordId, "prepare", h.prepare)).status,
    "UNKNOWN",
  );
  assert.equal(h.saved.actions[`${recordId}:prepare`].result, null);
  const p = await h.client().execute(recordId, "prepare", h.prepare);
  assert.equal(p.result.replayed, true);
  const requestInput = h.request();
  h.drop = "request";
  assert.equal(
    (await h.client().execute(recordId, "request", requestInput)).status,
    "UNKNOWN",
  );
  assert.equal(h.saved.actions[`${recordId}:request`].status, "UNKNOWN");
  assert.equal(
    (await h.client().execute(recordId, "request", requestInput)).result
      .replayed,
    true,
  );
  const releaseInput = h.release();
  h.drop = "release";
  assert.equal(
    (await h.client().execute(recordId, "release", releaseInput)).status,
    "UNKNOWN",
  );
  const r = await h.client().execute(recordId, "release", releaseInput);
  assert.equal(r.result.replayed, true);
  assert.equal(r.nativePublicationVerified, true);
  for (const operation of ["prepare", "request", "release"]) {
    const rows = h.commands.filter((c) => c.operation === operation);
    assert.equal(rows.length, 2);
    assert.deepEqual(rows[0].body, rows[1].body);
  }
  assert.ok(h.reads >= 4);
});

test("terminal/held/unknown responses never cause new keys or Native publication fallback", async () => {
  const h = deliveryFixture();
  h.drop = "request";
  await h.client().execute(recordId, "prepare", h.prepare);
  const input = h.request();
  await h.client().execute(recordId, "request", input);
  h.result.state = "expired";
  h.result.stateVersion++;
  const calls = h.commands.length;
  const terminal = await h.client().execute(recordId, "request", input);
  assert.equal(terminal.status, "HOLD");
  assert.equal(h.commands.length, calls);
  assert.equal(h.saved.actions[`${recordId}:request`].status, "UNKNOWN");
  const protectedFixture = deliveryFixture();
  protectedFixture.protections.withdrawn = true;
  await assert.rejects(
    protectedFixture
      .client()
      .execute(recordId, "prepare", protectedFixture.prepare),
    { code: "PROTECTED_RECORD" },
  );
  assert.equal(protectedFixture.commands.length, 0);
  const unknown = deliveryFixture();
  unknown.send = async () => ({
    ok: false,
    code: "CATALOG_DELIVERY_NOT_CONFIGURED",
  });
  const u = unknown.client();
  assert.equal(
    (await u.execute(recordId, "prepare", unknown.prepare)).status,
    "UNKNOWN",
  );
  assert.equal(unknown.main.revision, 1);
  await assert.rejects(
    u.execute(recordId, "prepare", { ...unknown.prepare, expectedRevision: 3 }),
    { code: "DELIVERY_ACTION_BINDING_CHANGED" },
  );
});

test("durable admission, journal scope, original body and result digest are checked before dispatch", async () => {
  const h = deliveryFixture();
  h.failureBeforePersist = true;
  await assert.rejects(h.client().execute(recordId, "prepare", h.prepare));
  assert.equal(h.commands.length, 0);
  h.failureBeforePersist = false;
  await h.client().execute(recordId, "prepare", h.prepare);
  const original = clone(h.saved);
  h.saved.actions[`${recordId}:prepare`].bodySha256 = hash("f");
  assert.throws(h.client, { code: "DELIVERY_JOURNAL_INVALID" });
  h.saved = clone(original);
  h.saved.actions[`${recordId}:prepare`].result.manifestSha256 = hash("f");
  assert.throws(h.client, { code: "DELIVERY_RESULT_SCOPE_CHANGED" });
  h.saved = clone(original);
  h.binding.environmentMarker = "synthetic-other";
  assert.throws(h.client, { code: "DELIVERY_JOURNAL_INVALID" });
});

test("a prepare Admin refuses for an oversized source stops with that category", async () => {
  const h = deliveryFixture();
  h.send = async (route) => {
    assert.ok(route.endsWith("prepare-catalog-delivery"));
    h.commands.push({ route });
    return {
      ok: false,
      retryable: false,
      code: "CATALOG_DELIVERY_SOURCE_TOO_LARGE",
    };
  };
  await assert.rejects(h.client().execute(recordId, "prepare", h.prepare), {
    code: "CATALOG_DELIVERY_SOURCE_TOO_LARGE",
  });
  assert.equal(h.commands.length, 1);
  // The attempt is journaled conservatively; nothing was confirmed.
  const action = h.saved.actions[`${recordId}:prepare`];
  assert.equal(action.status, "UNKNOWN");
  assert.deepEqual(
    action.attempts.map((a) => a.status),
    ["UNKNOWN"],
  );
  // Any other refusal still reads as an unknown result to reconcile.
  const other = deliveryFixture();
  other.send = async () => ({ ok: false, code: "NATIVE_REQUEST_REJECTED" });
  assert.equal(
    (await other.client().execute(recordId, "prepare", other.prepare)).status,
    "UNKNOWN",
  );
});

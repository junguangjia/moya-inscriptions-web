import assert from "node:assert/strict";
import test from "node:test";
import https from "node:https";
import { Buffer } from "node:buffer";
import { URL } from "node:url";
import http from "node:http";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, writeFile, rm, realpath } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { fixture, hash } from "./test-fixtures.mjs";
import {
  editorialDraftSchema,
  MEDIA_UPLOAD_CHUNK_BYTES,
  catalogDeliveryManifestSchema,
} from "../../../packages/contracts/dist/internal/editorial/index.js";
import { digest } from "./identity.mjs";
import {
  CATALOG_DELIVERY_CONTRACT_SHA256,
  normalizePayloadBridgeBinding,
} from "./catalog-delivery-journal.mjs";
import { normalizeProductionAuthority } from "./production-authority.mjs";
import { createProductionNativeHTTP } from "./local-native-http.mjs";
import { openProductionTransportJournal } from "./payload-isolated-session.mjs";
import {
  productionLimits,
  withProductionCatalogSession,
} from "./production-session.mjs";
import { runCommand, commandFailure } from "./cli.mjs";
import { registeredProofDigest } from "./registered-media-proof.mjs";
import { frozenSources } from "./historical-proof-fixture.mjs";
import {
  convertHistoricalProof,
  historicalConversionReference,
} from "./historical-proof-converter.mjs";

const SYNTHETIC_HEADER = "users API-Key SYNTHETIC_ONLY_NOT_A_REAL_CREDENTIAL";
const { queueMicrotask } = globalThis;
const sha = (b) => createHash("sha256").update(b).digest("hex");
function setup() {
  const manifest = fixture();
  manifest.target = {
    instance: "production",
    origin: "https://cms.example.invalid",
    actorId: 1,
    role: "owner",
  };
  const record = manifest.records[0],
    asset = record.media[0];
  const bytes = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a9P8AAAAASUVORK5CYII=",
    "base64",
  );
  Object.assign(asset, {
    bytes: bytes.length,
    uploadedSha256: sha(bytes),
    width: 1,
    height: 1,
  });
  const content = editorialDraftSchema.parse({
    catalogId: record.catalogId,
    sourceId: record.sourceId,
    kind: "inscription",
    title: "Synthetic selected B",
    summary: "Synthetic",
    media: [
      {
        mediaId: asset.mediaId,
        objectKey: "editorial/synthetic-test.png",
        width: 1,
        height: 1,
        alt: "Synthetic",
        position: 0,
        isRepresentative: true,
      },
    ],
  });
  const old = { ...content, title: "Synthetic prior A" };
  record.contentSha256 = digest(content);
  const before = {
    id: 10,
    revision: 2,
    fingerprint: hash("d"),
    contentSha256: digest(old),
  };
  const authority = {
    version: 1,
    kind: "production-native",
    ...manifest.target,
    manifestSha256: digest(manifest),
    catalogId: record.catalogId,
    nativeId: 10,
    actions: ["upload", "run", "publish", "withdraw"],
    authorityReferenceSha256: hash("a"),
    serverDeploymentReference: hash("e"),
    contractSha256: CATALOG_DELIVERY_CONTRACT_SHA256,
    expiresAt: "2099-01-01T00:00:00.000Z",
    credentialExpiresAt: "2099-01-01T00:00:00.000Z",
    credentialSaved: true,
    permissionsConfirmed: true,
    serverDeploymentConfirmed: true,
    caps: {
      requests: 256,
      requestBodyPerRequest: 1048576,
      acceptedRequestBodyTotal: 4194304,
      responseBodyTotal: 16777216,
    },
  };
  const media = {
    id: 20,
    mediaId: asset.mediaId,
    catalogId: record.catalogId,
    objectKey: content.media[0].objectKey,
    sha256: asset.uploadedSha256,
    mimeType: "image/png",
    filesize: asset.bytes,
    filename: "synthetic-test.png",
    width: 1,
    height: 1,
    alt: "Synthetic",
  };
  const input = {
    version: 1,
    expectedNative: before,
    conversions: [],
    controlled: {
      version: 1,
      root: "/SYNTHETIC",
      records: [
        {
          recordId: record.recordId,
          nativeId: 10,
          baselineStatus: "published",
          content,
          media: [
            {
              mediaId: asset.mediaId,
              file: "test.png",
              mimeType: "image/png",
              alt: "Synthetic",
              rights: null,
              orderConfidence: null,
            },
          ],
        },
      ],
    },
  };
  authority.inputSha256 = digest(input);
  return { manifest, authority, input, content, old, media, bytes, before };
}

/** Only in-process HTTPS request-object substitution. Never opens a socket/server/bridge. */
function fakeHTTPS(t, handler) {
  const calls = [];
  t.mock.method(http, "request", () => {
    throw Error("HTTP_FALLBACK_FORBIDDEN");
  });
  t.mock.method(https, "request", (address, options) => {
    const url = new URL(address);
    assert.equal(url.origin, "https://cms.example.invalid");
    assert.notEqual(options.rejectUnauthorized, false);
    assert.equal(options.headers["x-catalog-fixture"], undefined);
    const req = new EventEmitter(),
      chunks = [];
    let closed = false;
    const close = () => {
      if (!closed) {
        closed = true;
        req.emit("close");
      }
    };
    req.write = (b, cb) => {
      chunks.push(Buffer.from(b));
      queueMicrotask(() => cb?.());
      return true;
    };
    req.destroy = () => {
      queueMicrotask(close);
      return req;
    };
    req.end = () =>
      queueMicrotask(() => {
        const bodyBytes = Buffer.concat(chunks),
          route = url.pathname + url.search;
        const body =
          options.headers["Content-Type"] === "application/octet-stream" ||
          options.headers["content-type"] === "application/octet-stream"
            ? bodyBytes
            : bodyBytes.length
              ? JSON.parse(bodyBytes)
              : undefined;
        const call = { route, method: options.method, body };
        calls.push(call);
        const result = handler(call);
        if (result.drop) {
          req.emit("error", Error("SYNTHETIC_DROP"));
          close();
          return;
        }
        const incoming = Readable.from([
          Buffer.from(JSON.stringify(result.json)),
        ]);
        incoming.statusCode = result.status ?? 200;
        incoming.headers = result.headers ?? {};
        incoming.once("end", () => queueMicrotask(close));
        req.emit("response", incoming);
      });
    return req;
  });
  return calls;
}
async function directory(t) {
  const d = await realpath(
    await mkdtemp(path.join(os.tmpdir(), "catalog-production-seam-")),
  );
  t.after(() => rm(d, { recursive: true, force: true }));
  return d;
}
function options(f, directory, command = "run") {
  return {
    ...f,
    directory,
    command,
    assertBindingActive: async () => {},
    authorization: async () => SYNTHETIC_HEADER,
    limits: productionLimits(f.authority),
    responseByteLimit: 65536,
    deadline: Date.now() + 10000,
    timeoutMs: 1000,
  };
}

test("production authority refuses unconfirmed credentials/deployment/actions and fixture targets before provider dispatch", async (t) => {
  const f = setup();
  let reads = 0;
  for (const key of [
    "credentialSaved",
    "permissionsConfirmed",
    "serverDeploymentConfirmed",
  ]) {
    await assert.rejects(
      () =>
        withProductionCatalogSession(
          {
            ...options(f, "/SYNTHETIC_UNOPENED"),
            authority: { ...f.authority, [key]: false },
            authorization: async () => {
              reads++;
              return SYNTHETIC_HEADER;
            },
          },
          () => {},
        ),
      { code: "PRODUCTION_AUTHORITY_NOT_CONFIRMED" },
    );
  }
  assert.equal(reads, 0);
  assert.equal(
    commandFailure("publish", { code: "TRANSPORT_UNCERTAIN" }).networkRequests,
    null,
  );
  assert.equal(
    commandFailure("freeze", { code: "CLI_ARGUMENTS_INVALID" }).networkRequests,
    0,
  );
  for (const actions of [["run"], ["run", "publish"], ["run", "upload"]])
    await assert.rejects(
      () =>
        withProductionCatalogSession(
          {
            ...options(f, "/SYNTHETIC_UNOPENED"),
            authority: { ...f.authority, actions },
            authorization: async () => {
              reads++;
              return SYNTHETIC_HEADER;
            },
          },
          () => {},
        ),
      { code: "PRODUCTION_ACTION_NOT_AUTHORIZED" },
    );
  await assert.rejects(
    () =>
      withProductionCatalogSession(
        {
          ...options(f, "/SYNTHETIC_UNOPENED"),
          input: { ...f.input, expectedNative: { ...f.before, revision: 7 } },
          authorization: async () => {
            reads++;
            return SYNTHETIC_HEADER;
          },
        },
        () => {},
      ),
    { code: "PRODUCTION_INPUT_CHANGED" },
  );
  assert.equal(reads, 0);
  assert.throws(() =>
    normalizeProductionAuthority(
      {
        ...f.manifest,
        target: { ...f.manifest.target, origin: "http://cms.example.invalid" },
      },
      f.authority,
    ),
  );
  assert.throws(() => normalizePayloadBridgeBinding(f.manifest, f.authority));
  const d = await directory(t);
  const p = path.join(d, "manifest.json"),
    a = path.join(d, "authority.json");
  await writeFile(p, JSON.stringify(f.manifest), { mode: 0o600 });
  await writeFile(
    a,
    JSON.stringify({ ...f.authority, credentialSaved: false }),
    { mode: 0o600 },
  );
  await assert.rejects(
    () =>
      runCommand([
        "run",
        "--manifest",
        p,
        "--input",
        "/SYNTHETIC_MISSING",
        "--authority",
        a,
        "--credential-file",
        "/SYNTHETIC_NEVER_READ",
        "--state-dir",
        path.join(d, "state"),
      ]),
    { code: "PRODUCTION_AUTHORITY_NOT_CONFIRMED" },
  );
});

test("HTTPS principal, credential refresh and admission stay bound; persist failure sends zero requests", async (t) => {
  const f = setup(),
    binding = normalizeProductionAuthority(f.manifest, f.authority),
    limits = productionLimits(binding);
  const calls = fakeHTTPS(t, () => ({
    json: {
      user: { id: 1, role: "owner", collection: "users", scopeCatalogIds: [] },
    },
  }));
  let header = SYNTHETIC_HEADER;
  const journal = openProductionTransportJournal({
    manifest: f.manifest,
    binding,
    limits,
    responseByteLimit: 65536,
  });
  const client = createProductionNativeHTTP({
    ...options(f, "/SYNTHETIC"),
    binding,
    journal,
    persist: async () => {},
    assertAdmission: async () => {},
    assertRoute: () => {},
    authorization: async () => header,
  });
  assert.equal(
    (await client.verifyPrincipal()).scopeBasis,
    "VERIFIED_OWNER_GLOBAL",
  );
  header = "users API-Key SYNTHETIC_CHANGED_NOT_A_REAL_CREDENTIAL";
  await assert.rejects(
    () => client.send("/api/editorial/read-draft", "POST", { id: 10 }),
    { code: "PRODUCTION_CREDENTIAL_REVERIFY_REQUIRED" },
  );
  assert.equal(calls.length, 1);
  await client.close();
  const secondJournal = openProductionTransportJournal({
    manifest: f.manifest,
    binding,
    limits,
    responseByteLimit: 65536,
  });
  const blocked = createProductionNativeHTTP({
    ...options(f, "/SYNTHETIC"),
    binding,
    journal: secondJournal,
    persist: async () => {
      throw Error("SYNTHETIC_PERSIST_FAILURE");
    },
    assertAdmission: async () => {},
    assertRoute: () => {},
  });
  await assert.rejects(() => blocked.verifyPrincipal(), {
    code: "CHECKPOINT_PERSIST_FAILED",
  });
  assert.equal(calls.length, 1);
  await blocked.close();
  assert.equal(
    JSON.stringify(journal).includes("NOT_A_REAL_CREDENTIAL"),
    false,
  );
});

test("real HTTPS code path with a request-object seam stages once, publishes frozen B and reenters without another release or binary", async (t) => {
  const f = setup(),
    d = await directory(t);
  f.input.controlled.root = d;
  f.authority.inputSha256 = digest(f.input);
  await writeFile(path.join(d, "test.png"), f.bytes);
  let draft = {
      id: 10,
      revision: 2,
      fingerprint: f.before.fingerprint,
      content: f.old,
    },
    main = { id: 10, revision: 2, _status: "published", ...f.old },
    uploaded = false,
    received = false,
    intent = null,
    saveReceipt,
    receiptAvailable = true;
  const uploadId = hash("a");
  const session = () => ({
    uploadId,
    state: received ? "ready" : "uploading",
    chunkBytes: MEDIA_UPLOAD_CHUNK_BYTES,
    chunkCount: 1,
    receivedIndices: received ? [0] : [],
    expiresAt: "2099-01-01T00:00:00.000Z",
  });
  const calls = fakeHTTPS(t, ({ route, body }) => {
    if (route === "/api/users/me")
      return {
        json: {
          user: {
            id: 1,
            role: "owner",
            collection: "users",
            scopeCatalogIds: [],
          },
        },
      };
    if (route === "/api/editorial/read-draft")
      return { json: { ok: true, result: draft } };
    if (route.startsWith("/api/catalogs/")) return { json: main };
    if (route.startsWith("/api/media?"))
      return {
        json: { docs: uploaded ? [f.media] : [], totalDocs: uploaded ? 1 : 0 },
      };
    if (
      route.endsWith("media-upload/start") ||
      route.endsWith("media-upload/status")
    )
      return { json: { ok: true, result: session() } };
    if (route.includes("media-upload/chunk/")) {
      received = true;
      return {
        json: {
          ok: true,
          result: { uploadId, index: 0, bytes: body.length, sha256: sha(body) },
        },
      };
    }
    if (route.endsWith("media-upload/complete")) {
      uploaded = true;
      return {
        json: {
          ok: true,
          result: {
            media: f.media,
            reused: false,
            validatedBytes: f.bytes.length,
            validatedSha256: sha(f.bytes),
          },
        },
      };
    }
    if (route.endsWith("save-draft")) {
      draft = {
        id: 10,
        revision: 3,
        fingerprint: hash("e"),
        content: body.content,
      };
      saveReceipt = body;
      return {
        json: {
          ok: true,
          result: { id: 10, revision: 3, fingerprint: draft.fingerprint },
        },
      };
    }
    if (route.startsWith("/api/editorial-receipts?")) {
      // The actual ordered server receipt identity is independently derived by the client.
      return {
        json: {
          docs: receiptAvailable ? [receiptFor(saveReceipt, draft)] : [],
          totalDocs: receiptAvailable ? 1 : 0,
        },
      };
    }
    if (route.endsWith("prepare-catalog-delivery")) {
      intent = {
        intentId: "00000000-0000-4000-8000-000000000001",
        id: 10,
        catalogId: f.content.catalogId,
        revision: 3,
        fingerprint: hash("e"),
        manifestSha256: sha(
          JSON.stringify(
            catalogDeliveryManifestSchema.parse(
              f.content.media.map((m) => ({
                ...m,
                sourceSha256: f.manifest.records[0].media[0].uploadedSha256,
              })),
            ),
          ),
        ),
        mediaCount: 1,
        recipeManifestSha256: hash("b"),
        state: "prepared",
        stateVersion: 1,
        readiness: "PENDING",
        publicCopyAuthorized: false,
        expiresAt: "2099-01-01T00:00:00.000Z",
        replayed: false,
      };
      return { json: { ok: true, result: intent } };
    }
    if (route.endsWith("request-catalog-release")) {
      intent = {
        ...intent,
        state: "release_requested",
        stateVersion: 2,
        readiness: "READY",
        publicCopyAuthorized: true,
      };
      return { json: { ok: true, result: intent } };
    }
    if (route.endsWith("read-catalog-delivery"))
      return { json: { ok: true, result: intent } };
    if (route.endsWith("release-catalog-delivery")) {
      intent = { ...intent, state: "released", stateVersion: 3 };
      return { json: { ok: true, result: intent } };
    }
    if (route === "/api/editorial/catalog-delivery-capabilities")
      return { json: { ok: true, result: { delivery: "AVAILABLE" } } };
    if (route === "/api/editorial/catalog-render-backlog")
      return { json: { ok: true, result: renderBacklog() } };
    throw Error("UNEXPECTED_SYNTHETIC_ROUTE:" + route);
  });
  const stateDir = path.join(d, "state");
  await withProductionCatalogSession(options(f, stateDir), async (client) => {
    await client.ensureMedia();
    await client.saveDraft();
  });
  receiptAvailable = false;
  await assert.rejects(
    () =>
      withProductionCatalogSession(options(f, stateDir, "publish"), (client) =>
        client.publish(),
      ),
    { code: "NATIVE_RECONCILIATION_PENDING" },
  );
  assert.equal(
    calls.some((c) => c.route.endsWith("prepare-catalog-delivery")),
    false,
  );
  receiptAvailable = true;
  const run = () =>
    withProductionCatalogSession(options(f, stateDir), async (client) => {
      if (!client.snapshot().frozen) {
        await client.ensureMedia();
        await client.saveDraft();
      }
      return client.publish();
    });
  await assert.rejects(run, { code: "NATIVE_PUBLICATION_UNVERIFIED" });
  draft = { ...draft, revision: 4, fingerprint: hash("f") };
  main = { id: 10, revision: 4, _status: "published", ...f.content };
  const first = await run();
  assert.equal(first.nativePublicationVerified, true);
  const binary = calls.filter((c) => c.route.includes("/chunk/")).length;
  const second = await run();
  assert.equal(second.nativePublicationVerified, true);
  assert.equal(
    calls.filter((c) => c.route.endsWith("release-catalog-delivery")).length,
    1,
  );
  assert.equal(calls.filter((c) => c.route.includes("/chunk/")).length, binary);
  assert.equal(
    JSON.stringify(
      JSON.parse(
        await readFile(path.join(stateDir, "production-native-journal.json")),
      ),
    ).includes("NOT_A_REAL_CREDENTIAL"),
    false,
  );
  const statePath = path.join(stateDir, "production-state.json"),
    stored = JSON.parse(await readFile(statePath));
  const proof = stored.proofs[f.manifest.records[0].media[0].mediaId];
  const original = JSON.parse(JSON.stringify(stored));
  proof.sourceSha256 = hash("f");
  proof.evidenceSha256 = registeredProofDigest(proof);
  await writeFile(statePath, JSON.stringify(stored), { mode: 0o600 });
  const beforeInvalidReload = calls.length;
  await assert.rejects(run, { code: "PRODUCTION_MEDIA_PROOF_INVALID" });
  assert.equal(calls.length, beforeInvalidReload);
  original.save.result.revision = 7;
  await writeFile(statePath, JSON.stringify(original), { mode: 0o600 });
  await assert.rejects(run, { code: "PRODUCTION_SAVE_ACTION_CHANGED" });
  assert.equal(calls.length, beforeInvalidReload);
});

/** The Admin's render-backlog answer (catalog-scale-v1 I9): counted per tier
 * by the last sync pass, a minute ago unless given, with the base renders
 * queued and running now. */
function renderBacklog(
  tiers = { t0: 0, t1: 0, t2: 0, t3: 0, t4: 0 },
  queued = 0,
  running = 0,
  countedMinutesAgo = 1,
  preparedSince = 0,
) {
  return {
    tiers,
    countedAt:
      tiers === null
        ? null
        : new Date(Date.now() - countedMinutesAgo * 60_000).toISOString(),
    queued,
    running,
    preparedSince,
  };
}

function receiptFor(body, draft) {
  const fields = Object.keys(body.content);
  // body is schema-ordered and carries exactly the parsed editorial fields.
  return {
    deduplicationKey: sha(JSON.stringify([1, body.idempotencyKey])),
    requestFingerprint: sha(
      JSON.stringify({
        operation: "save-draft",
        ...body,
        content: Object.fromEntries(fields.map((k) => [k, body.content[k]])),
      }),
    ),
    actor: 1,
    operation: "save-draft",
    status: "completed",
    catalog: body.id,
    revision: draft.revision,
    fingerprint: draft.fingerprint,
  };
}

test("withdrawal persists fresh Native revision/status/content/fingerprint and never repeats the PATCH", async (t) => {
  const f = setup(),
    d = await directory(t);
  let revision = 2,
    status = "published";
  f.input.expectedNative.contentSha256 = digest(f.content);
  f.authority.inputSha256 = digest(f.input);
  const calls = fakeHTTPS(t, ({ route, method }) => {
    if (route === "/api/users/me")
      return { json: { user: { id: 1, role: "owner" } } };
    if (route === "/api/editorial/read-draft")
      return {
        json: {
          ok: true,
          result: {
            id: 10,
            revision,
            fingerprint: revision === 2 ? hash("d") : hash("e"),
            content: f.content,
          },
        },
      };
    if (method === "PATCH") {
      revision++;
      status = "draft";
      return { json: { doc: { id: 10, revision, _status: status } } };
    }
    return { json: { id: 10, revision, _status: status, ...f.content } };
  });
  const run = () =>
    withProductionCatalogSession(
      options(f, path.join(d, "state"), "withdraw"),
      (client) => client.withdraw(),
    );
  for (let i = 0; i < 2; i++) {
    const result = await run();
    assert.equal(result.native.revision, 3);
    assert.equal(result.native.status, "draft");
    assert.equal(result.native.contentSha256, digest(f.content));
    assert.equal(result.native.fingerprint, hash("e"));
    assert.equal(result.anonymousWithdrawalVerified, false);
  }
  assert.equal(calls.filter((c) => c.method === "PATCH").length, 1);
});

test("held and reuse-only media cannot reach upload/save/release routes", async (t) => {
  const f = setup(),
    d = await directory(t);
  f.manifest.records[0].reuseOnly = true;
  f.input.expectedNative.contentSha256 = digest(f.content);
  f.authority.inputSha256 = digest(f.input);
  f.authority.manifestSha256 = digest(f.manifest);
  const calls = fakeHTTPS(t, ({ route }) => {
    if (route === "/api/users/me")
      return { json: { user: { id: 1, role: "owner" } } };
    if (route === "/api/editorial/read-draft")
      return {
        json: {
          ok: true,
          result: {
            id: 10,
            revision: 2,
            fingerprint: hash("d"),
            content: f.content,
          },
        },
      };
    if (route.startsWith("/api/media?"))
      return { json: { docs: [f.media], totalDocs: 1 } };
    return {
      json: { id: 10, revision: 2, _status: "published", ...f.content },
    };
  });
  await assert.rejects(
    () =>
      withProductionCatalogSession(
        options(f, path.join(d, "reuse")),
        (client) => client.ensureMedia(),
      ),
    { code: "REUSE_ONLY_PROOF_MISSING" },
  );
  f.manifest.records[0].protections.rightsHold = true;
  f.authority.manifestSha256 = digest(f.manifest);
  await assert.rejects(
    () =>
      withProductionCatalogSession(options(f, path.join(d, "held")), (client) =>
        client.ensureMedia(),
      ),
    { code: "PROTECTED_RECORD" },
  );
  assert.equal(
    calls.some(
      (c) =>
        c.route.includes("media-upload") ||
        c.route.endsWith("save-draft") ||
        c.route.endsWith("release-catalog-delivery"),
    ),
    false,
  );
});

test("first adoption rejects same-content revision drift and a previously published baseline latches hidden state", async (t) => {
  const f = setup(),
    d = await directory(t);
  f.input.expectedNative.contentSha256 = digest(f.content);
  f.authority.inputSha256 = digest(f.input);
  let revision = 7,
    status = "published";
  const calls = fakeHTTPS(t, ({ route }) => {
    if (route === "/api/users/me")
      return { json: { user: { id: 1, role: "owner" } } };
    if (route === "/api/editorial/read-draft")
      return {
        json: {
          ok: true,
          result: {
            id: 10,
            revision,
            fingerprint: revision === 2 ? hash("d") : hash("e"),
            content: f.content,
          },
        },
      };
    return { json: { id: 10, revision, _status: status, ...f.content } };
  });
  await assert.rejects(
    () =>
      withProductionCatalogSession(
        options(f, path.join(d, "drift"), "publish"),
        (client) => client.publish(),
      ),
    { code: "NATIVE_PREFLIGHT_CHANGED" },
  );
  revision = 2;
  status = "draft";
  await assert.rejects(
    () =>
      withProductionCatalogSession(
        options(f, path.join(d, "hidden"), "publish"),
        (client) => client.publish(),
      ),
    { code: "PROTECTED_RECORD" },
  );
  assert.equal(
    calls.some(
      (c) =>
        c.method === "PATCH" || c.route.endsWith("prepare-catalog-delivery"),
    ),
    false,
  );
  const draftManifest = {
    ...f.manifest,
    records: [{ ...f.manifest.records[0], disposition: "draft" }],
  };
  const authority = { ...f.authority, manifestSha256: digest(draftManifest) };
  const before = calls.length;
  await assert.rejects(
    () =>
      withProductionCatalogSession(
        {
          ...options(f, path.join(d, "draft"), "publish"),
          manifest: draftManifest,
          authority,
        },
        () => {},
      ),
    { code: "DRAFT_ONLY" },
  );
  assert.equal(calls.length, before);
});

test("historical Production reuse binds original Catalog ID and fresh key receipts without rewriting old unknown facts", async (t) => {
  for (const scenario of ["wrong-catalog-id", "fresh-key", "changed-source"])
    await t.test(scenario, async (t) => {
      const f = setup(),
        d = await directory(t);
      const spec = await frozenSources(t, undefined, {
        target: f.manifest.target,
        observedRecordIndex: scenario === "fresh-key" ? 0 : 2,
      });
      const bundle = await convertHistoricalProof(spec),
        entry = bundle.entries.find((e) => e.recordId === "TEST-3"),
        e = entry.evidence;
      const nativeId = scenario === "wrong-catalog-id" ? 4 : 3;
      const content = editorialDraftSchema.parse({
        catalogId: e.catalogId,
        sourceId: e.sourceId,
        kind: "inscription",
        title: "Synthetic historical B",
        summary: "Synthetic",
        media: [
          {
            mediaId: e.mediaId,
            objectKey: "editorial/synthetic-2.jpg",
            width: e.width,
            height: e.height,
            position: 0,
            isRepresentative: true,
            alt: "Synthetic",
          },
        ],
      });
      f.manifest.records = [
        {
          recordId: "TEST-3",
          catalogId: e.catalogId,
          sourceId: e.sourceId,
          contentSha256: digest(content),
          disposition: "publish",
          reuseOnly: true,
          protections: entry.protections,
          media: [
            {
              mediaId: e.mediaId,
              sourceSha256: e.sourceSha256,
              uploadedSha256: e.uploadedSha256,
              bytes: e.bytes,
              width: e.width,
              height: e.height,
              position: 0,
              isRepresentative: true,
            },
          ],
        },
      ];
      f.input = {
        version: 1,
        expectedNative: {
          id: nativeId,
          revision: 4,
          fingerprint: hash("c"),
          contentSha256: digest(content),
        },
        conversions: [
          {
            mediaId: e.mediaId,
            reference: historicalConversionReference(bundle, entry.entryId),
          },
        ],
        controlled: {
          version: 1,
          root: d,
          records: [
            {
              recordId: "TEST-3",
              nativeId,
              baselineStatus: "published",
              content,
              media: [
                {
                  mediaId: e.mediaId,
                  file: null,
                  mimeType: "image/jpeg",
                  alt: "Synthetic",
                  rights: null,
                  orderConfidence: null,
                },
              ],
            },
          ],
        },
      };
      Object.assign(f.authority, {
        nativeId,
        catalogId: e.catalogId,
        manifestSha256: digest(f.manifest),
        inputSha256: digest(f.input),
      });
      const media = {
        id: e.nativeId,
        mediaId: e.mediaId,
        catalogId: e.catalogId,
        objectKey: "editorial/synthetic-2.jpg",
        sha256: e.uploadedSha256,
        filesize: e.bytes,
        width: e.width,
        height: e.height,
        filename: "synthetic-2.jpg",
        mimeType: "image/jpeg",
        alt: "Synthetic",
      };
      let hasCurrentKey = scenario !== "fresh-key";
      const calls = fakeHTTPS(t, ({ route }) => {
        if (route === "/api/users/me")
          return { json: { user: { id: 1, role: "owner" } } };
        if (route === "/api/editorial/read-draft")
          return {
            json: {
              ok: true,
              result: {
                id: nativeId,
                revision: 4,
                fingerprint: hash("c"),
                content,
              },
            },
          };
        if (route.startsWith("/api/media?"))
          return {
            json: {
              docs: [
                { ...media, objectKey: hasCurrentKey ? media.objectKey : "" },
              ],
              totalDocs: 1,
            },
          };
        if (route.startsWith("/api/catalogs/"))
          return {
            json: {
              id: nativeId,
              revision: 4,
              _status: "published",
              ...content,
            },
          };
        throw Error("SYNTHETIC_MUTATION_MUST_NOT_DISPATCH");
      });
      if (scenario === "fresh-key") {
        assert.equal(entry.objectKey, null);
        const run = () =>
          withProductionCatalogSession(
            options(f, path.join(d, "state")),
            async (client) => {
              await client.ensureMedia();
              return client.snapshot().proofs[e.mediaId];
            },
          );
        await assert.rejects(run, { code: "TRANSPORT_UNCERTAIN" });
        hasCurrentKey = true;
        for (let i = 0; i < 2; i++) {
          const proof = await run();
          assert.equal(proof.audit.version, 2);
          assert.equal(proof.media.objectKey, media.objectKey);
          assert.equal(
            proof.audit.currentCatalog.projection.sourceId,
            e.sourceId,
          );
          assert.equal(
            proof.audit.observedAt,
            proof.audit.nativeReceipt.observedAt,
          );
          assert.equal(entry.objectKey, null);
        }
        const statePath = path.join(d, "state", "production-state.json"),
          stored = JSON.parse(await readFile(statePath));
        stored.proofs[e.mediaId].audit.currentCatalog.projection.sourceId =
          "source-other";
        stored.proofs[e.mediaId].evidenceSha256 = registeredProofDigest(
          stored.proofs[e.mediaId],
        );
        await writeFile(statePath, JSON.stringify(stored), { mode: 0o600 });
        const before = calls.length;
        await assert.rejects(run, {
          code: "CURRENT_CATALOG_METADATA_PROOF_INVALID",
        });
        assert.equal(calls.length, before);
      } else
        await assert.rejects(
          () =>
            withProductionCatalogSession(
              options(f, path.join(d, "state")),
              async (client) => {
                await client.ensureMedia();
                assert.equal(scenario, "changed-source");
                await writeFile(
                  spec.files.find((f) => f.role === "plan").path,
                  "{}",
                  { mode: 0o600 },
                );
                await client.publish();
              },
            ),
          {
            code: {
              "wrong-catalog-id": "HISTORICAL_CATALOG_ID_CHANGED",
              "changed-source": "HISTORICAL_SOURCE_CHANGED",
            }[scenario],
          },
        );
      assert.equal(
        calls.some(
          (c) =>
            c.route.includes("media-upload") ||
            c.route.endsWith("save-draft") ||
            c.route.endsWith("prepare-catalog-delivery") ||
            c.route.endsWith("release-catalog-delivery"),
        ),
        false,
      );
    });
});

/** The answers of the staged-publication test above, as one reusable Native
 * with per-test overrides. Still only the in-process request-object seam.
 */
function syntheticNative(t, f, override = () => undefined) {
  const { id, revision } = f.before;
  const n = {
    draft: { id, revision, fingerprint: f.before.fingerprint, content: f.old },
    main: { id, revision, _status: "published", ...f.old },
    // A reuse-only record's media is already in Native.
    uploaded: f.manifest.records[0].reuseOnly === true,
    received: false,
    intent: null,
    saveReceipt: null,
    // What the Admin's render-backlog proxy answers: drained by default.
    backlog: renderBacklog(),
  };
  const uploadId = hash("a");
  const session = () => ({
    uploadId,
    state: n.received ? "ready" : "uploading",
    chunkBytes: MEDIA_UPLOAD_CHUNK_BYTES,
    chunkCount: 1,
    receivedIndices: n.received ? [0] : [],
    expiresAt: "2099-01-01T00:00:00.000Z",
  });
  n.calls = fakeHTTPS(t, (call) => {
    const answer = override(call, n);
    if (answer) return answer;
    const { route, body, method } = call;
    if (route === "/api/users/me")
      return {
        json: {
          user: {
            id: 1,
            role: "owner",
            collection: "users",
            scopeCatalogIds: [],
          },
        },
      };
    if (route === "/api/editorial/read-draft")
      return { json: { ok: true, result: n.draft } };
    if (route.startsWith("/api/catalogs/") && method === "PATCH") {
      n.main = { ...n.main, revision: n.main.revision + 1, _status: "draft" };
      n.draft = {
        ...n.draft,
        revision: n.main.revision,
        fingerprint: hash("e"),
      };
      return { json: { doc: n.main } };
    }
    if (route.startsWith("/api/catalogs/")) return { json: n.main };
    if (route.startsWith("/api/media?"))
      return {
        json: {
          docs: n.uploaded ? [f.media] : [],
          totalDocs: n.uploaded ? 1 : 0,
        },
      };
    if (
      route.endsWith("media-upload/start") ||
      route.endsWith("media-upload/status")
    )
      return { json: { ok: true, result: session() } };
    if (route.includes("media-upload/chunk/")) {
      n.received = true;
      return {
        json: {
          ok: true,
          result: { uploadId, index: 0, bytes: body.length, sha256: sha(body) },
        },
      };
    }
    if (route.endsWith("media-upload/complete")) {
      n.uploaded = true;
      return {
        json: {
          ok: true,
          result: {
            media: f.media,
            reused: false,
            validatedBytes: f.bytes.length,
            validatedSha256: sha(f.bytes),
          },
        },
      };
    }
    if (route.endsWith("save-draft")) {
      n.draft = {
        id,
        revision: n.draft.revision + 1,
        fingerprint: hash("e"),
        content: body.content,
      };
      n.saveReceipt = body;
      return {
        json: {
          ok: true,
          result: {
            id,
            revision: n.draft.revision,
            fingerprint: n.draft.fingerprint,
          },
        },
      };
    }
    if (route.startsWith("/api/editorial-receipts?"))
      return {
        json: { docs: [receiptFor(n.saveReceipt, n.draft)], totalDocs: 1 },
      };
    if (route.endsWith("prepare-catalog-delivery")) {
      n.intent = {
        intentId: "00000000-0000-4000-8000-000000000001",
        id,
        catalogId: f.content.catalogId,
        revision: n.draft.revision,
        fingerprint: n.draft.fingerprint,
        manifestSha256: sha(
          JSON.stringify(
            catalogDeliveryManifestSchema.parse(
              f.content.media.map((m) => ({
                ...m,
                sourceSha256: f.manifest.records[0].media[0].uploadedSha256,
              })),
            ),
          ),
        ),
        mediaCount: 1,
        recipeManifestSha256: hash("b"),
        state: "prepared",
        stateVersion: 1,
        readiness: "PENDING",
        publicCopyAuthorized: false,
        expiresAt: "2099-01-01T00:00:00.000Z",
        replayed: false,
      };
      return { json: { ok: true, result: n.intent } };
    }
    if (route.endsWith("request-catalog-release")) {
      n.intent = { ...n.intent, state: "release_requested", stateVersion: 2 };
      return { json: { ok: true, result: n.intent } };
    }
    if (route.endsWith("read-catalog-delivery"))
      return { json: { ok: true, result: n.intent } };
    if (route === "/api/editorial/catalog-delivery-capabilities")
      return { json: { ok: true, result: { delivery: "AVAILABLE" } } };
    if (route === "/api/editorial/catalog-render-backlog")
      return { json: { ok: true, result: n.backlog } };
    throw Error("UNEXPECTED_SYNTHETIC_ROUTE:" + route);
  });
  return n;
}
async function stagedRun(t, f) {
  const d = await directory(t);
  f.input.controlled.root = d;
  f.authority.inputSha256 = digest(f.input);
  await writeFile(path.join(d, "test.png"), f.bytes);
  const stateDir = path.join(d, "state");
  return (command = "run", extra = {}) =>
    withProductionCatalogSession(
      { ...options(f, stateDir, command), ...extra },
      // The production CLI's dispatch (production-cli.mjs).
      async (client) => {
        if (command === "withdraw") return client.withdraw();
        const fresh = !client.snapshot().frozen;
        if (command === "upload" || (command === "run" && fresh))
          await client.ensureMedia();
        if (command === "upload") return client.snapshot().proofs;
        if (command === "run" && fresh) await client.saveDraft();
        return client.publish();
      },
    );
}
const writes = (calls) =>
  calls.filter(
    (c) =>
      c.method === "PATCH" ||
      /media-upload\/(start|chunk|stream|complete)|save-draft|(prepare|request|release|cancel)-catalog/.test(
        c.route,
      ),
  );
const count = (calls, suffix) =>
  calls.filter((c) => c.route.endsWith(suffix)).length;
/** An Admin from before the delivery release: Payload's own 404 for every
 * route it does not serve, and the old endpoints still answering.
 */
const oldAdmin = ({ route }) => {
  if (/catalog-delivery|catalog-release|media-upload/.test(route))
    return { status: 404, json: { message: `Route not found "${route}"` } };
};
const backendNotConfigured = ({ route }) => {
  if (route === "/api/editorial/catalog-delivery-capabilities")
    return { json: { ok: true, result: { delivery: "NOT_CONFIGURED" } } };
};

/** DEP-4's reuse-only record (TEST-3 of the historical fixture): its media
 * proof is imported from Production evidence without any write. With
 * `edited`, the live draft holds an earlier text, so `run` first writes at
 * save-draft; otherwise the draft is already B and `publish` first writes at
 * prepare-catalog-delivery.
 */
async function reuseOnlySetup(t, { edited = true } = {}) {
  const f = setup();
  const spec = await frozenSources(t, undefined, {
    target: f.manifest.target,
    observedRecordIndex: 2,
  });
  const bundle = await convertHistoricalProof(spec),
    entry = bundle.entries.find((x) => x.recordId === "TEST-3"),
    e = entry.evidence,
    nativeId = 3,
    objectKey = "editorial/synthetic-2.jpg";
  f.content = editorialDraftSchema.parse({
    catalogId: e.catalogId,
    sourceId: e.sourceId,
    kind: "inscription",
    title: "Synthetic historical B",
    summary: "Synthetic",
    media: [
      {
        mediaId: e.mediaId,
        objectKey,
        width: e.width,
        height: e.height,
        position: 0,
        isRepresentative: true,
        alt: "Synthetic",
      },
    ],
  });
  f.old = edited
    ? { ...f.content, title: "Synthetic historical A" }
    : f.content;
  f.before = {
    id: nativeId,
    revision: 4,
    fingerprint: hash("c"),
    contentSha256: digest(f.old),
  };
  f.media = {
    id: e.nativeId,
    mediaId: e.mediaId,
    catalogId: e.catalogId,
    objectKey,
    sha256: e.uploadedSha256,
    filesize: e.bytes,
    width: e.width,
    height: e.height,
    filename: "synthetic-2.jpg",
    mimeType: "image/jpeg",
    alt: "Synthetic",
  };
  f.manifest.records = [
    {
      recordId: "TEST-3",
      catalogId: e.catalogId,
      sourceId: e.sourceId,
      contentSha256: digest(f.content),
      disposition: "publish",
      reuseOnly: true,
      protections: entry.protections,
      media: [
        {
          mediaId: e.mediaId,
          sourceSha256: e.sourceSha256,
          uploadedSha256: e.uploadedSha256,
          bytes: e.bytes,
          width: e.width,
          height: e.height,
          position: 0,
          isRepresentative: true,
        },
      ],
    },
  ];
  f.input = {
    version: 1,
    expectedNative: f.before,
    conversions: [
      {
        mediaId: e.mediaId,
        reference: historicalConversionReference(bundle, entry.entryId),
      },
    ],
    controlled: {
      version: 1,
      root: "/SYNTHETIC",
      records: [
        {
          recordId: "TEST-3",
          nativeId,
          baselineStatus: "published",
          content: f.content,
          media: [
            {
              mediaId: e.mediaId,
              file: null,
              mimeType: "image/jpeg",
              alt: "Synthetic",
              rights: null,
              orderConfidence: null,
            },
          ],
        },
      ],
    },
  };
  Object.assign(f.authority, {
    nativeId,
    catalogId: e.catalogId,
    manifestSha256: digest(f.manifest),
  });
  return f;
}

test("an intent that ended reports its terminal category, never WAITING_FOR_READY", async (t) => {
  for (const ended of ["expired", "cancelled", "superseded", "withdrawn"])
    await t.test(ended, async (t) => {
      const f = setup();
      const native = syntheticNative(t, f, ({ route }, n) => {
        // The intent ends between prepare and the first read.
        if (route.endsWith("read-catalog-delivery"))
          return {
            json: {
              ok: true,
              result: { ...n.intent, state: ended, stateVersion: 2 },
            },
          };
      });
      const run = await stagedRun(t, f);
      const code = `DELIVERY_INTENT_${ended.toUpperCase()}`;
      await assert.rejects(run, { code });
      // The same state directory keeps reporting the end without new writes.
      const before = writes(native.calls).length;
      await assert.rejects(() => run("publish"), { code });
      assert.equal(writes(native.calls).length, before);
      assert.equal(
        native.calls.some((c) => c.route.endsWith("request-catalog-release")),
        false,
      );
    });
});

test("a withdrawal Native refused is sent again from the same state directory", async (t) => {
  const f = setup();
  f.input.expectedNative.contentSha256 = digest(f.content);
  let refuse = true;
  const native = syntheticNative(t, f, ({ method }) => {
    if (method === "PATCH" && refuse) {
      refuse = false;
      return {
        status: 409,
        json: { errors: [{ message: "CONCURRENT_OPERATION_BUSY" }] },
      };
    }
  });
  native.draft.content = f.content;
  native.main = { id: 10, revision: 2, _status: "published", ...f.content };
  const run = await stagedRun(t, f);
  await assert.rejects(() => run("withdraw"), { code: "REVISION_CONFLICT" });
  const result = await run("withdraw");
  assert.equal(result.status, "NATIVE_WITHDRAWAL_CONFIRMED");
  assert.equal(result.native.status, "draft");
  assert.equal(native.calls.filter((c) => c.method === "PATCH").length, 2);
  // Confirmed: a later run reconciles and never sends a third PATCH.
  await run("withdraw");
  assert.equal(native.calls.filter((c) => c.method === "PATCH").length, 2);
});

test("a withdrawal refused before dispatch records no attempt and is sent on the next run", async (t) => {
  const f = setup();
  f.input.expectedNative.contentSha256 = digest(f.content);
  let armed = false,
    tripped = false;
  const native = syntheticNative(t, f, ({ route, method }) => {
    if (method === "GET" && route.startsWith("/api/catalogs/") && !tripped)
      armed = true;
  });
  native.draft.content = f.content;
  native.main = { id: 10, revision: 2, _status: "published", ...f.content };
  const run = await stagedRun(t, f);
  const assertBindingActive = async () => {
    if (armed && !tripped) {
      tripped = true;
      throw Object.assign(new Error("SYNTHETIC_BINDING_RECHECK"), {
        code: "PRODUCTION_INPUT_CHANGED",
      });
    }
  };
  await assert.rejects(() => run("withdraw", { assertBindingActive }), {
    code: "PRODUCTION_INPUT_CHANGED",
  });
  assert.equal(native.calls.filter((c) => c.method === "PATCH").length, 0);
  const result = await run("withdraw", { assertBindingActive });
  assert.equal(result.status, "NATIVE_WITHDRAWAL_CONFIRMED");
  assert.equal(native.calls.filter((c) => c.method === "PATCH").length, 1);
});

test("a draft save Native refused is sent again from the same state directory", async (t) => {
  const f = setup();
  let refuse = true;
  const native = syntheticNative(t, f, ({ route }) => {
    if (route.endsWith("save-draft") && refuse) {
      refuse = false;
      return {
        status: 409,
        json: { ok: false, error: { code: "CONCURRENT_OPERATION_BUSY" } },
      };
    }
  });
  const run = await stagedRun(t, f);
  await assert.rejects(run, { code: "CONCURRENT_OPERATION_BUSY" });
  assert.equal(native.draft.revision, 2);
  const outcome = await run();
  assert.equal(outcome.status, "WAITING_FOR_READY");
  assert.equal(
    native.calls.filter((c) => c.route.endsWith("save-draft")).length,
    2,
  );
  assert.equal(native.draft.revision, 3);
});

test("run and upload stop before the first upload when the Admin lacks the delivery endpoints", async (t) => {
  const f = setup();
  const native = syntheticNative(t, f, oldAdmin);
  const run = await stagedRun(t, f);
  await assert.rejects(run, { code: "ADMIN_CAPABILITY_MISSING" });
  await assert.rejects(() => run("upload"), {
    code: "ADMIN_CAPABILITY_MISSING",
  });
  assert.deepEqual(writes(native.calls), []);
  assert.equal(native.draft.revision, 2);
});

test("a publication stops before any write when the Backend cannot pin a recipe or prove readiness", async (t) => {
  for (const [delivery, code] of [
    ["NOT_CONFIGURED", "BACKEND_DELIVERY_NOT_CONFIGURED"],
    ["UNAVAILABLE", "BACKEND_DELIVERY_UNAVAILABLE"],
  ])
    await t.test(delivery, async (t) => {
      const f = setup();
      const native = syntheticNative(t, f, ({ route }) => {
        if (route === "/api/editorial/catalog-delivery-capabilities")
          return { json: { ok: true, result: { delivery } } };
      });
      const run = await stagedRun(t, f);
      await assert.rejects(run, { code });
      assert.deepEqual(writes(native.calls), []);
      // An upload alone needs no Backend: it proceeds past the same probe.
      const uploaded = await withProductionCatalogSession(
        options(f, path.join(f.input.controlled.root, "upload"), "upload"),
        async (client) => {
          await client.ensureMedia();
          return client.snapshot().proofs;
        },
      );
      assert.equal(Object.keys(uploaded).length, 1);
      assert.equal(
        writes(native.calls).every((c) => c.route.includes("media-upload")),
        true,
      );
    });
});

test("a reuse-only run stops before its draft save, and publish before its intent, when delivery is absent", async (t) => {
  for (const [name, absent, code] of [
    ["old Admin", oldAdmin, "ADMIN_CAPABILITY_MISSING"],
    [
      "Backend not configured",
      backendNotConfigured,
      "BACKEND_DELIVERY_NOT_CONFIGURED",
    ],
  ])
    await t.test(name, async (t) => {
      await t.test("run of a text-only edit", async (t) => {
        const f = await reuseOnlySetup(t);
        const native = syntheticNative(t, f, absent);
        const run = await stagedRun(t, f);
        await assert.rejects(run, { code });
        // The media proof was imported without any write; the save is the
        // first write and it was never sent.
        assert.equal(count(native.calls, "catalog-delivery-capabilities"), 1);
        assert.equal(count(native.calls, "save-draft"), 0);
        assert.deepEqual(writes(native.calls), []);
        assert.equal(native.draft.revision, 4);
        assert.equal(native.draft.content.title, "Synthetic historical A");
      });
      await t.test("publish of a saved draft", async (t) => {
        const f = await reuseOnlySetup(t, { edited: false });
        const native = syntheticNative(t, f, absent);
        const run = await stagedRun(t, f);
        assert.equal(Object.keys(await run("upload")).length, 1);
        assert.deepEqual(
          native.calls.filter(
            (c) => c.method !== "GET" && !/read-draft$/.test(c.route),
          ),
          [],
        );
        await assert.rejects(() => run("publish"), { code });
        assert.equal(count(native.calls, "catalog-delivery-capabilities"), 1);
        assert.equal(count(native.calls, "prepare-catalog-delivery"), 0);
        assert.deepEqual(writes(native.calls), []);
      });
    });
});

test("a draft save refused before dispatch records no attempt and is sent on the next run", async (t) => {
  const f = await reuseOnlySetup(t);
  let armed = false,
    tripped = false;
  const native = syntheticNative(t, f, ({ route }) => {
    // The capability probe is the last request before the draft save.
    if (route === "/api/editorial/catalog-delivery-capabilities" && !tripped)
      armed = true;
  });
  const run = await stagedRun(t, f);
  const assertBindingActive = async () => {
    if (armed && !tripped) {
      tripped = true;
      throw Object.assign(new Error("SYNTHETIC_BINDING_RECHECK"), {
        code: "PRODUCTION_INPUT_CHANGED",
      });
    }
  };
  await assert.rejects(() => run("run", { assertBindingActive }), {
    code: "PRODUCTION_INPUT_CHANGED",
  });
  assert.equal(tripped, true);
  assert.equal(count(native.calls, "save-draft"), 0);
  assert.equal(native.draft.revision, 4);
  const outcome = await run("run", { assertBindingActive });
  assert.equal(outcome.status, "WAITING_FOR_READY");
  assert.equal(count(native.calls, "save-draft"), 1);
  assert.equal(native.draft.revision, 5);
});

/* catalog-scale-v1 I9 (Owner decision D5): the waves. A new prepare is sent
 * only while the render backlog ahead of it drains within 12 hours at the
 * render rate (7 images a minute unless configured), read through the Admin
 * proxy after the capability preflight. */
const CAPABILITIES = "/api/editorial/catalog-delivery-capabilities";
const RENDER_BACKLOG = "/api/editorial/catalog-render-backlog";
const PREPARE = "/api/editorial/prepare-catalog-delivery";
/** One session's requests: its preflight precedes its backlog read, which
 * precedes its prepare, and no write precedes the preflight. */
const assertWaveOrder = (calls, { prepared }) => {
  const routes = calls.map((c) => c.route),
    capability = routes.indexOf(CAPABILITIES),
    backlog = routes.indexOf(RENDER_BACKLOG),
    firstWrite = calls.findIndex((c) => writes([c]).length === 1);
  assert.ok(capability >= 0 && capability < backlog);
  assert.equal(routes.filter((r) => r === RENDER_BACKLOG).length, 1);
  assert.equal(firstWrite === -1 || firstWrite > capability, true);
  assert.equal(routes.indexOf(PREPARE) > backlog, prepared);
  assert.equal(routes.includes(PREPARE), prepared);
};

test("a new wave is prepared only while the render backlog drains within 12 hours, after the capability preflight", async (t) => {
  const f = setup();
  const native = syntheticNative(t, f);
  // 12 hours at 7 a minute are 5,040 images ahead of the wave; a recipe
  // re-render not queued yet (t4) runs after it and is not counted.
  native.backlog = renderBacklog(
    { t0: 40, t1: 1_000, t2: 4_000, t3: 1, t4: 90_000 },
    300,
    1,
  );
  const run = await stagedRun(t, f);
  const waiting = await run();
  assert.deepEqual(waiting, {
    status: "WAITING_FOR_RENDER_BACKLOG",
    renderBacklog: {
      images: 5_041,
      imagesPerMinute: 7,
      drainMinutes: 721,
      maxDrainMinutes: 720,
      countedAt: native.backlog.countedAt,
    },
    anonymousDeliveryVerified: false,
  });
  assertWaveOrder(native.calls, { prepared: false });
  // Counts only: no origin, record, image, key or credential.
  const text = JSON.stringify(waiting);
  for (const secret of [
    "example.invalid",
    "editorial/",
    "SYNTHETIC",
    f.manifest.records[0].catalogId,
    f.manifest.records[0].media[0].mediaId,
  ])
    assert.equal(text.includes(secret), false, secret);
  // A caller runs `publish` again while it waits (no sooner than a sync pass:
  // each run spends the state directory's request budget). Each run reads
  // the backlog afresh, with no attempt limit, and prepares nothing.
  for (let i = 0; i < 3; i++) assert.deepEqual(await run("publish"), waiting);
  assert.equal(count(native.calls, "catalog-render-backlog"), 4);
  assert.equal(count(native.calls, "prepare-catalog-delivery"), 0);
  // The draft was saved and frozen; the same state directory prepares the
  // wave once the backlog is down to the limit.
  native.backlog = renderBacklog(
    { t0: 40, t1: 1_000, t2: 4_000, t3: 0, t4: 90_000 },
    300,
    1,
  );
  const from = native.calls.length;
  const outcome = await run("publish");
  assert.equal(outcome.status, "WAITING_FOR_READY");
  assertWaveOrder(native.calls.slice(from), { prepared: true });
  assert.equal(count(native.calls, "save-draft"), 1);
});

test("the base renders queued and running count when more than the tiers last counted", async (t) => {
  const f = setup();
  const native = syntheticNative(t, f);
  native.backlog = renderBacklog(
    { t0: 0, t1: 0, t2: 0, t3: 0, t4: 20_000 },
    5_040,
    1,
  );
  const run = await stagedRun(t, f);
  assert.equal((await run()).renderBacklog.images, 5_041);
  assert.equal(count(native.calls, "prepare-catalog-delivery"), 0);
  native.backlog = renderBacklog(
    { t0: 0, t1: 0, t2: 0, t3: 0, t4: 20_000 },
    5_039,
    1,
  );
  assert.equal((await run("publish")).status, "WAITING_FOR_READY");
  assert.equal(count(native.calls, "prepare-catalog-delivery"), 1);
});

test("the images prepared since the last count hold the next wave back, so one batch inside a sync interval is paced on all of it", async (t) => {
  const f = setup();
  const native = syntheticNative(t, f);
  // 4,900 counted and 141 prepared by earlier sessions since: 5,041 ahead.
  const tiers = { t0: 0, t1: 0, t2: 4_900, t3: 0, t4: 0 };
  native.backlog = renderBacklog(tiers, 300, 1, 1, 141);
  const run = await stagedRun(t, f);
  const waiting = await run();
  assert.equal(waiting.status, "WAITING_FOR_RENDER_BACKLOG");
  assert.equal(waiting.renderBacklog.images, 5_041);
  // Also on top of the queued and running renders when they are more.
  native.backlog = renderBacklog(
    { t0: 0, t1: 0, t2: 0, t3: 0, t4: 0 },
    5_000,
    1,
    1,
    40,
  );
  assert.equal((await run("publish")).renderBacklog.images, 5_041);
  assert.equal(count(native.calls, "prepare-catalog-delivery"), 0);
  native.backlog = renderBacklog(tiers, 300, 1, 1, 140);
  assert.equal((await run("publish")).status, "WAITING_FOR_READY");
  assert.equal(count(native.calls, "prepare-catalog-delivery"), 1);
});

test("an Admin answer without the prepared-since count stops the wave before its prepare", async (t) => {
  const f = setup();
  const older = renderBacklog();
  delete older.preparedSince;
  const native = syntheticNative(t, f, ({ route }) =>
    route === RENDER_BACKLOG
      ? { json: { ok: true, result: older } }
      : undefined,
  );
  const run = await stagedRun(t, f);
  await assert.rejects(run, { code: "RENDER_BACKLOG_INVALID" });
  assert.equal(count(native.calls, "prepare-catalog-delivery"), 0);
});

test("the render rate is configurable, and an invalid one stops before any request", async (t) => {
  const f = setup();
  const native = syntheticNative(t, f);
  native.backlog = renderBacklog({ t0: 0, t1: 0, t2: 10_080, t3: 1, t4: 0 });
  const run = await stagedRun(t, f);
  for (const renderImagesPerMinute of [
    0,
    -7,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    61,
    "7",
  ])
    await assert.rejects(
      () => run("run", { renderImagesPerMinute }),
      { code: "RENDER_PACING_INVALID" },
      String(renderImagesPerMinute),
    );
  assert.deepEqual(native.calls, []);
  const waiting = await run("run", { renderImagesPerMinute: 14 });
  assert.deepEqual(waiting.renderBacklog, {
    images: 10_081,
    imagesPerMinute: 14,
    drainMinutes: 721,
    maxDrainMinutes: 720,
    countedAt: native.backlog.countedAt,
  });
  assert.equal(
    (await run("publish", { renderImagesPerMinute: 14.01 })).status,
    "WAITING_FOR_READY",
  );
  assert.equal(count(native.calls, "prepare-catalog-delivery"), 1);
});

test("a backlog the Admin cannot report, or one never counted, stops the wave before its prepare", async (t) => {
  for (const [name, answer, code] of [
    [
      "never counted",
      { json: { ok: true, result: renderBacklog(null, 0, 0) } },
      "RENDER_BACKLOG_NOT_COUNTED",
    ],
    [
      "an Admin without the proxy",
      { status: 404, json: { message: "Route not found" } },
      "ADMIN_RENDER_BACKLOG_MISSING",
    ],
    [
      "a Backend without the route",
      {
        status: 503,
        json: {
          ok: false,
          error: { code: "CATALOG_RENDER_BACKLOG_NOT_CONFIGURED", fields: [] },
        },
      },
      "CATALOG_RENDER_BACKLOG_NOT_CONFIGURED",
    ],
    [
      "an unavailable Backend",
      {
        status: 503,
        json: {
          ok: false,
          error: { code: "CATALOG_RENDER_BACKLOG_UNAVAILABLE", fields: [] },
        },
      },
      "CATALOG_RENDER_BACKLOG_UNAVAILABLE",
    ],
    [
      "an answer that is not the contract",
      {
        json: {
          ok: true,
          result: { ...renderBacklog(), assetIds: ["synthetic"] },
        },
      },
      "RENDER_BACKLOG_INVALID",
    ],
    [
      "a refused read",
      { status: 403, json: { ok: false, error: { code: "FORBIDDEN" } } },
      "NATIVE_REQUEST_REJECTED",
    ],
  ])
    await t.test(name, async (t) => {
      const f = setup();
      const native = syntheticNative(t, f, ({ route }) =>
        route === RENDER_BACKLOG ? answer : undefined,
      );
      const run = await stagedRun(t, f);
      await assert.rejects(run, { code });
      assert.equal(count(native.calls, "catalog-render-backlog"), 1);
      assert.equal(count(native.calls, "prepare-catalog-delivery"), 0);
    });
});

test("a count with a tier that is not a whole number, or a tier this build does not know, reaches the gate as never counted and stops the wave before its prepare", async (t) => {
  // The App's own reader (built), so the gate sees what the Backend answers
  // for such a row: never as 0, which would let the wave through.
  const { readCatalogRenderBacklog } =
    await import("../../../services/community-postgres/dist/index.js");
  const low = { t0: 0, t1: 0, t2: 100, t3: 0, t4: 0 };
  const missing = { ...low };
  delete missing.t4;
  for (const [name, recorded] of [
    ["a negative tier", { ...low, t1: -1 }],
    ["a fractional tier", { ...low, t2: 0.5 }],
    ["a tier as text", { ...low, t3: "0" }],
    ["a missing tier", missing],
    // A newer worker's tier: dropping it would undercount the backlog.
    ["a tier this build does not know", { ...low, t5: 500 }],
  ])
    await t.test(name, async (t) => {
      const read = await readCatalogRenderBacklog({
        query: async () => ({
          rows: [
            {
              render_backlog: recorded,
              render_backlog_at: new Date(Date.now() - 60_000),
              queued: 0,
              running: 0,
            },
          ],
        }),
      });
      // As the Backend serializes it and the Admin passes it on: nothing is
      // prepared since a count it does not have.
      const result = { ...JSON.parse(JSON.stringify(read)), preparedSince: 0 };
      const f = setup();
      const native = syntheticNative(t, f, ({ route }) =>
        route === RENDER_BACKLOG ? { json: { ok: true, result } } : undefined,
      );
      const run = await stagedRun(t, f);
      await assert.rejects(run, { code: "RENDER_BACKLOG_NOT_COUNTED" });
      assert.equal(count(native.calls, "catalog-render-backlog"), 1);
      assert.equal(count(native.calls, "prepare-catalog-delivery"), 0);
    });
});

test("a backlog counted over an hour ago, or ahead of this clock beyond skew, stops the wave before its prepare", async (t) => {
  // The worker stopped counting while its last count stays under the limit,
  // and the queue (capped at 300) cannot show what built up since.
  const low = { t0: 0, t1: 0, t2: 100, t3: 0, t4: 0 };
  for (const [name, minutesAgo] of [
    ["counted 61 minutes ago", 61],
    ["counted three days ago", 3 * 24 * 60],
    ["counted 10 minutes ahead", -10],
  ])
    await t.test(name, async (t) => {
      const f = setup();
      const native = syntheticNative(t, f);
      native.backlog = renderBacklog(low, 300, 1, minutesAgo);
      const run = await stagedRun(t, f);
      await assert.rejects(run, (error) => {
        assert.equal(error.code, "RENDER_BACKLOG_STALE");
        assert.equal(error.message, "RENDER_BACKLOG_STALE");
        return true;
      });
      assert.equal(count(native.calls, "catalog-render-backlog"), 1);
      assert.equal(count(native.calls, "prepare-catalog-delivery"), 0);
      // Counted again, the same state directory prepares the wave.
      native.backlog = renderBacklog(low, 300, 1);
      assert.equal((await run("publish")).status, "WAITING_FOR_READY");
      assert.equal(count(native.calls, "prepare-catalog-delivery"), 1);
    });
  for (const [name, minutesAgo] of [
    ["counted 59 minutes ago", 59],
    ["counted 4 minutes ahead (clock skew)", -4],
  ])
    await t.test(name, async (t) => {
      const f = setup();
      const native = syntheticNative(t, f);
      native.backlog = renderBacklog(low, 300, 1, minutesAgo);
      const run = await stagedRun(t, f);
      assert.equal((await run()).status, "WAITING_FOR_READY");
      assertWaveOrder(native.calls, { prepared: true });
    });
});

test("a wave whose prepare was already sent is not paced again", async (t) => {
  const f = setup();
  const native = syntheticNative(t, f);
  const run = await stagedRun(t, f);
  assert.equal((await run()).status, "WAITING_FOR_READY");
  assert.equal(count(native.calls, "catalog-render-backlog"), 1);
  // The backlog grew behind the prepared wave: its later runs still read,
  // request and release it, and never ask for the backlog again.
  native.backlog = renderBacklog({ t0: 0, t1: 0, t2: 50_000, t3: 0, t4: 0 });
  assert.equal((await run("publish")).status, "WAITING_FOR_READY");
  assert.equal(count(native.calls, "catalog-render-backlog"), 1);
  assert.equal(count(native.calls, "prepare-catalog-delivery"), 1);
  assert.equal(count(native.calls, "request-catalog-release"), 1);
});

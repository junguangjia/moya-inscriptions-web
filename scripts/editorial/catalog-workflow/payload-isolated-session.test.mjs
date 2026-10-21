import assert from "node:assert/strict";
import test from "node:test";
import http from "node:http";
import { mkdtemp, writeFile, readFile, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fixture, hash } from "./test-fixtures.mjs";
import { digest } from "./identity.mjs";
import {
  editorialDraftSchema,
  EDITORIAL_STATEFUL_FIELDS,
  catalogFilterMetadataSchema,
} from "../../../packages/contracts/dist/internal/editorial/index.js";
import {
  CATALOG_DELIVERY_CONTRACT_SHA256,
  frozenCatalogDeliveryBinding,
} from "./catalog-delivery-journal.mjs";
import { runPayloadIsolatedCommand } from "./payload-isolated-cli.mjs";

// Real Node HTTP but deliberately NOT Payload/PG. This checks the r2-shaped
// client boundary and protected provider path, not platform implementation.
test("r2-shaped HTTP boundary reopens durable prepare/cancel state with zero image routes", async (t) => {
  const root = await realpath(
    await mkdtemp(path.join(tmpdir(), "payload-protocol-test-")),
  );
  const manifest = fixture(),
    record = manifest.records[0],
    asset = record.media[0];
  const content = editorialDraftSchema.parse({
    catalogId: record.catalogId,
    sourceId: record.sourceId,
    kind: "inscription",
    title: "Synthetic B",
    summary: "Synthetic",
    ...Object.fromEntries(
      EDITORIAL_STATEFUL_FIELDS.map((k) => [k, { state: "UNSUPPLIED" }]),
    ),
    sourceCitations: [
      { label: "Synthetic archive", citation: "Synthetic reference" },
    ],
    media: [
      {
        mediaId: asset.mediaId,
        objectKey: "editorial/synthetic.png",
        width: asset.width,
        height: asset.height,
        position: 0,
        isRepresentative: true,
        alt: "Synthetic",
      },
    ],
  });
  record.contentSha256 = digest(content);
  const draft = { id: 10, revision: 2, fingerprint: hash("d"), content };
  const media = {
    id: 20,
    mediaId: asset.mediaId,
    catalogId: record.catalogId,
    objectKey: content.media[0].objectKey,
    filename: "synthetic.png",
    filesize: asset.bytes,
    width: asset.width,
    height: asset.height,
    mimeType: "image/png",
    sha256: asset.uploadedSha256,
    alt: "Synthetic",
  };
  const frozen = frozenCatalogDeliveryBinding(record, draft, [
    {
      media,
      sourceSha256: asset.sourceSha256,
      uploadedSha256: asset.uploadedSha256,
    },
  ]);
  const routes = [],
    receipts = new Map();
  let intent = null;
  const session = "SYNTHETIC_FIXTURE_ONLY_NOT_VALID_12345";
  const server = http.createServer(async (req, res) => {
    try {
      assert.equal(req.headers.authorization, `JWT ${session}`);
      assert.equal(req.headers["x-catalog-fixture"], undefined);
      assert.match(req.headers["x-catalog-request-sha256"], /^[a-f0-9]{64}$/);
      routes.push(req.url);
      const chunks = [];
      for await (const part of req) chunks.push(part);
      const { Buffer } = await import("node:buffer");
      const raw = Buffer.concat(chunks).toString(),
        body = raw ? JSON.parse(raw) : null;
      let result;
      if (req.url === "/api/users/me")
        result = { user: { id: 1, role: "owner" } };
      else if (req.url === "/api/editorial/read-draft")
        result = { ok: true, result: draft };
      else if (req.url === "/api/catalogs/10?depth=0&draft=false")
        result = {
          ...content,
          ...Object.fromEntries(
            EDITORIAL_STATEFUL_FIELDS.map((k) => [
              k,
              { ...content[k], value: null },
            ]),
          ),
          periodLabel: null,
          ownerNote: null,
          media: content.media.map((m, index) => ({
            ...m,
            id: `payload-row-${index}`,
          })),
          sourceCitations: content.sourceCitations.map((c) => ({
            ...c,
            id: "citation-row",
            appliesTo: [],
          })),
          filterMetadata: catalogFilterMetadataSchema.parse({}),
          title: "Synthetic A",
          id: 10,
          revision: 1,
          _status: "published",
        };
      else if (req.url.startsWith("/api/media?"))
        result = { docs: [media], totalDocs: 1 };
      else if (req.url === "/api/editorial/read-catalog-delivery")
        result = { ok: true, result: { ...intent, replayed: false } };
      else if (
        [
          "/api/editorial/prepare-catalog-delivery",
          "/api/editorial/cancel-catalog-delivery",
        ].includes(req.url)
      ) {
        const replayed = receipts.has(body.idempotencyKey);
        if (!replayed) {
          receipts.set(body.idempotencyKey, raw);
          if (req.url.includes("prepare"))
            intent = {
              intentId: "00000000-0000-4000-8000-000000000001",
              id: 10,
              catalogId: record.catalogId,
              revision: 2,
              fingerprint: draft.fingerprint,
              manifestSha256: frozen.manifestSha256,
              mediaCount: 1,
              recipeManifestSha256: hash("e"),
              state: "prepared",
              stateVersion: 1,
              readiness: "PENDING",
              publicCopyAuthorized: false,
              expiresAt: "2099-01-01T00:00:00.000Z",
              replayed: false,
            };
          else {
            intent.state = "cancelled";
            intent.stateVersion++;
          }
        } else assert.equal(receipts.get(body.idempotencyKey), raw);
        result = { ok: true, result: { ...intent, replayed } };
      } else throw Error("SYNTHETIC_ROUTE_UNEXPECTED");
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(result));
    } catch {
      res.writeHead(500);
      res.end(JSON.stringify({ ok: false }));
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  manifest.target.origin = origin;
  const expiresAt = new Date(Date.now() + 60000).toISOString(),
    authFile = path.join(root, "application-auth.private.json");
  const ready = {
    version: 1,
    status: "READY",
    credentialMaterialInThisFile: false,
    environmentMarker: "synthetic-node-protocol-only",
    origin,
    contractSha256: CATALOG_DELIVERY_CONTRACT_SHA256,
    expiresAt,
    jwtExpiresAt: expiresAt,
    actorId: 1,
    fixtureCatalogDocumentId: 10,
    fixtureCatalogId: record.catalogId,
    authFile,
    caps: {
      requests: 96,
      requestBodyPerRequest: 1048576,
      acceptedRequestBodyTotal: 4194304,
      responseBodyTotal: 2097152,
    },
  };
  const save = (p, value) =>
    writeFile(p, JSON.stringify(value), { mode: 0o600 });
  await save(path.join(root, "ready.json"), ready);
  await save(authFile, {
    version: 1,
    environmentMarker: ready.environmentMarker,
    origin,
    scheme: "JWT",
    session,
    expiresAt,
    jwtExpiresAt: expiresAt,
  });
  await save(path.join(root, "input.json"), {
    version: 1,
    manifest,
    nativeDraft: draft,
  });
  const run = (action) =>
    runPayloadIsolatedCommand([
      "--ready",
      path.join(root, "ready.json"),
      "--input",
      path.join(root, "input.json"),
      "--checkpoint",
      path.join(root, "checkpoint"),
      "--action",
      action,
      "--report",
      path.join(root, `${action}-report.json`),
    ]);
  const first = await run("prepare");
  assert.equal(first.outcome.status, "RECEIPT_CONFIRMED");
  const second = await run("cancel");
  assert.equal(second.outcome.status, "HOLD");
  assert.equal(second.outcome.result.state, "cancelled");
  assert.equal(second.transport.binaryBodyBytes, 0);
  assert.equal(second.anonymousDeliveryVerified, false);
  assert.equal(
    second.payloadImplementationAcceptance,
    "REQUIRES_PLATFORM_EVIDENCE",
  );
  assert.equal(
    routes.some((r) => /file|upload|receipt|__catalog_fixture/.test(r)),
    false,
  );
  const journal = JSON.parse(
    await readFile(
      path.join(root, "checkpoint/payload-native-journal.json"),
      "utf8",
    ),
  );
  assert.equal(journal.requests.length, routes.length);
  assert.equal(journal.transportKind, "payload-isolated");
  assert.equal(JSON.stringify(journal).includes(session), false);
  await save(path.join(root, "closed.json"), {
    closedAt: new Date().toISOString(),
  });
  const count = routes.length;
  await assert.rejects(run("read"), { code: "PAYLOAD_FIXTURE_CLOSED" });
  assert.equal(routes.length, count);
});

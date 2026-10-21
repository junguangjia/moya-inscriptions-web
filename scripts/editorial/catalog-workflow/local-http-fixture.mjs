/** Synthetic loopback server. Not Payload, PostgreSQL, COS, or publication E2E. */
import assert from "node:assert/strict";
import http from "node:http";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { URL } from "node:url";
import {
  editorialDraftSchema,
  editorialSaveDraftSchema,
  EDITORIAL_FIELD_NAMES,
  editorialMediaUploadStartSchema,
  editorialMediaUploadSessionSchema,
  editorialMediaUploadSessionRequestSchema,
  editorialMediaUploadCompleteResultSchema,
  MEDIA_UPLOAD_CHUNK_BYTES,
} from "../../../packages/contracts/dist/internal/editorial/index.js";
import { fixture, clone } from "./test-fixtures.mjs";
import { digest } from "./identity.mjs";

const sha = (value) => createHash("sha256").update(value).digest("hex");
export async function localHTTPFixture(options = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), "catalog-native-http-"));
  const bytes = Buffer.alloc(
    options.bytes ?? 6 * MEDIA_UPLOAD_CHUNK_BYTES + 17,
    37,
  );
  // A synthetic PNG with trailing padding; this server validates hashes, not image decoding.
  Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2nksAAAAASUVORK5CYII=",
    "base64",
  ).copy(bytes);
  await writeFile(path.join(directory, "synthetic.png"), bytes, {
    mode: 0o600,
  });
  const manifest = fixture();
  const record = manifest.records[0],
    asset = record.media[0];
  Object.assign(asset, {
    sourceSha256: sha(bytes),
    uploadedSha256: sha(bytes),
    bytes: bytes.length,
    width: 1,
    height: 1,
  });
  const content = editorialDraftSchema.parse({
    catalogId: record.catalogId,
    sourceId: record.sourceId,
    kind: "inscription",
    title: "Synthetic replacement",
    summary: "Synthetic test",
    periodLabel: "Synthetic",
    media: [
      {
        mediaId: asset.mediaId,
        objectKey: `editorial/${asset.mediaId}.png`,
        width: 1,
        height: 1,
        alt: "Synthetic test",
        position: 0,
        isRepresentative: true,
      },
    ],
  });
  record.contentSha256 = digest(content);
  const input = {
    version: 1,
    root: directory,
    records: [
      {
        recordId: record.recordId,
        nativeId: 10,
        baselineStatus: "draft",
        content,
        media: [
          {
            mediaId: asset.mediaId,
            file: "synthetic.png",
            mimeType: "image/png",
            alt: "Synthetic test",
            rights: null,
            orderConfidence: null,
          },
        ],
      },
    ],
  };
  const before = editorialDraftSchema.parse({
    ...content,
    title: "Synthetic original",
    media: [],
  });
  const state = {
    requests: [],
    binaryBytes: 0,
    byIndex: {},
    sessions: new Map(),
    media: null,
    receipts: [],
    draft: {
      id: 10,
      revision: 1,
      fingerprint: digest(before),
      content: before,
    },
    main: { id: 10, revision: 1, _status: "draft", ...before },
    user: { id: 1, role: "owner", scopeCatalogIds: [record.catalogId] },
    saves: 0,
    completes: 0,
    errors: [],
    droppedChunk: false,
    droppedSave: false,
    receiptPatch: null,
    admission: null,
    responseOverride: null,
  };
  const fixtureId = sha("synthetic-native-http-fixture-v1");
  const sessionResult = (session) =>
    editorialMediaUploadSessionSchema.parse({
      uploadId: session.uploadId,
      state: session.complete
        ? "complete"
        : session.chunks.size === session.count
          ? "ready"
          : "uploading",
      chunkBytes: MEDIA_UPLOAD_CHUNK_BYTES,
      chunkCount: session.count,
      receivedIndices: [...session.chunks.keys()].sort((a, b) => a - b),
      expiresAt: "2099-01-01T00:00:00.000Z",
    });
  const server = http.createServer(async (req, res) => {
    res.setHeader("x-catalog-fixture", fixtureId);
    const reply = (value, status = 200) => {
      res.statusCode = status;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(value));
    };
    try {
      state.requests.push({ route: req.url, method: req.method });
      const chunks = [];
      for await (const part of req) chunks.push(part);
      const body = Buffer.concat(chunks);
      await state.admission?.(req, body);
      if (state.responseOverride && (await state.responseOverride(req, res)))
        return;
      if (req.url === "/__catalog_fixture") {
        reply({ kind: "catalog-native-isolated-http-v1", fixtureId });
        return;
      }
      assert.equal(
        req.headers.authorization,
        "users API-Key SYNTHETIC_LOCAL_ONLY",
      );
      assert.equal(req.headers["x-catalog-fixture"], fixtureId);
      const json =
        body.length && req.headers["content-type"] === "application/json"
          ? JSON.parse(body.toString())
          : null;
      if (req.url === "/api/users/me") {
        reply({ user: state.user });
        return;
      }
      if (req.url.startsWith("/api/media?")) {
        reply({
          docs: state.media
            ? [{ ...state.media, createdAt: "2099-01-01T00:00:00.000Z" }]
            : [],
          totalDocs: state.media ? 1 : 0,
        });
        return;
      }
      if (req.url.startsWith("/api/catalogs/")) {
        assert.equal(req.method, "GET");
        reply(state.main);
        return;
      }
      if (req.url === "/api/editorial/read-draft") {
        assert.equal(json.id, 10);
        reply({ ok: true, result: state.draft });
        return;
      }
      if (req.url.startsWith("/api/editorial-receipts?")) {
        const key = new URL(req.url, "http://127.0.0.1").searchParams.get(
          "where[deduplicationKey][equals]",
        );
        const docs = state.receipts
          .filter((row) => row.deduplicationKey === key)
          .map((row) => ({ ...row, ...state.receiptPatch }));
        reply({ docs, totalDocs: docs.length });
        return;
      }
      if (req.url === "/api/editorial/save-draft") {
        const parsed = editorialSaveDraftSchema.parse(json);
        assert.equal(parsed.expectedRevision, state.draft.revision);
        assert.equal(parsed.id, 10);
        state.saves++;
        const patch = Object.fromEntries(
          EDITORIAL_FIELD_NAMES.filter((key) =>
            Object.hasOwn(json.content, key),
          ).map((key) => [key, parsed.content[key]]),
        );
        state.draft = {
          id: 10,
          revision: state.draft.revision + 1,
          fingerprint: digest(parsed.content),
          content: parsed.content,
        };
        state.receipts.push({
          deduplicationKey: sha(
            JSON.stringify([state.user.id, parsed.idempotencyKey]),
          ),
          requestFingerprint: sha(
            JSON.stringify({
              operation: "save-draft",
              ...parsed,
              content: patch,
            }),
          ),
          actor: state.user.id,
          operation: "save-draft",
          status: "completed",
          catalog: 10,
          revision: state.draft.revision,
          fingerprint: state.draft.fingerprint,
        });
        if (options.dropSave && !state.droppedSave) {
          state.droppedSave = true;
          res.destroy();
          return;
        }
        reply({
          ok: true,
          result: {
            id: 10,
            revision: state.draft.revision,
            fingerprint: state.draft.fingerprint,
            replayed: false,
          },
        });
        return;
      }
      if (req.url === "/api/editorial/request-catalog-release") {
        reply(
          {
            ok: false,
            error: { code: "CATALOG_DELIVERY_NOT_CONFIGURED", fields: [] },
          },
          503,
        );
        return;
      }
      if (req.url === "/api/editorial/media-upload/start") {
        const start = editorialMediaUploadStartSchema.parse(json);
        const uploadId = sha(JSON.stringify(start));
        if (!state.sessions.has(uploadId))
          state.sessions.set(uploadId, {
            start,
            uploadId,
            chunks: new Map(),
            count: Math.ceil(start.bytes / MEDIA_UPLOAD_CHUNK_BYTES),
            complete: false,
          });
        if (options.stream) res.setHeader("x-editorial-upload-stream", "1");
        reply({
          ok: true,
          result: sessionResult(state.sessions.get(uploadId)),
        });
        return;
      }
      if (req.url === "/api/editorial/media-upload/status") {
        const { uploadId } =
          editorialMediaUploadSessionRequestSchema.parse(json);
        reply({
          ok: true,
          result: sessionResult(state.sessions.get(uploadId)),
        });
        return;
      }
      const binary =
        /^\/api\/editorial\/media-upload\/(chunk|stream)\/([a-f0-9]{64})\/(\d+)$/.exec(
          req.url,
        );
      if (binary) {
        const [, kind, uploadId, number] = binary,
          session = state.sessions.get(uploadId);
        const index =
          kind === "chunk"
            ? Number(number)
            : Number(number) / MEDIA_UPLOAD_CHUNK_BYTES;
        assert.equal(Number.isSafeInteger(index), true);
        assert.equal(
          sha(body),
          req.headers[
            kind === "chunk"
              ? "x-editorial-chunk-sha256"
              : "x-editorial-stream-sha256"
          ],
        );
        state.binaryBytes += body.length;
        for (
          let offset = 0;
          offset < body.length;
          offset += MEDIA_UPLOAD_CHUNK_BYTES
        ) {
          const current = index + offset / MEDIA_UPLOAD_CHUNK_BYTES;
          state.byIndex[current] = (state.byIndex[current] ?? 0) + 1;
          session.chunks.set(
            current,
            body.subarray(offset, offset + MEDIA_UPLOAD_CHUNK_BYTES),
          );
        }
        if (options.dropChunk && index === 1 && !state.droppedChunk) {
          state.droppedChunk = true;
          res.destroy();
          return;
        }
        reply({
          ok: true,
          result:
            kind === "stream"
              ? sessionResult(session)
              : { uploadId, index, bytes: body.length, sha256: sha(body) },
        });
        return;
      }
      if (req.url === "/api/editorial/media-upload/complete") {
        const { uploadId } =
            editorialMediaUploadSessionRequestSchema.parse(json),
          session = state.sessions.get(uploadId);
        const uploaded = Buffer.concat(
          [...session.chunks.entries()]
            .sort(([a], [b]) => a - b)
            .map(([, value]) => value),
        );
        assert.equal(uploaded.length, bytes.length);
        assert.equal(sha(uploaded), asset.uploadedSha256);
        const reused = session.complete;
        if (!reused) state.completes++;
        session.complete = true;
        state.media = {
          id: 20,
          mediaId: asset.mediaId,
          catalogId: record.catalogId,
          objectKey: content.media[0].objectKey,
          sha256: asset.uploadedSha256,
          mimeType: "image/png",
          filesize: asset.bytes,
          filename: "synthetic.png",
          width: 1,
          height: 1,
          alt: "Synthetic test",
        };
        reply({
          ok: true,
          result: editorialMediaUploadCompleteResultSchema.parse({
            media: state.media,
            reused,
            validatedBytes: asset.bytes,
            validatedSha256: asset.uploadedSha256,
          }),
        });
        return;
      }
      throw new Error("SYNTHETIC_UNEXPECTED_ROUTE");
    } catch (error) {
      state.errors.push(error.code ?? error.message);
      if (!res.destroyed)
        reply({ ok: false, error: { code: "SYNTHETIC_FIXTURE_FAILURE" } }, 500);
    }
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  manifest.target.origin = `http://127.0.0.1:${server.address().port}`;
  const fixtureBoundary = { origin: manifest.target.origin, id: fixtureId };
  const adapterOptions = () => ({
    manifest: clone(manifest),
    input: clone(input),
    fixture: clone(fixtureBoundary),
    directory: path.join(directory, "checkpoint"),
    deadline: Date.now() + 30000,
    timeoutMs: 1000,
    limits: {
      maxRequests: 250,
      maxUploadBytes: 8 * 1024 * 1024,
      maxDownloadBytes: 4 * 1024 * 1024,
      maxAttempts: 2,
      concurrency: 4,
      chunkBytes: MEDIA_UPLOAD_CHUNK_BYTES,
    },
    responseByteLimit: 16384,
    uploadMode: "auto",
  });
  return {
    directory,
    bytes,
    manifest,
    input,
    boundary: fixtureBoundary,
    state,
    adapterOptions,
    enforceDurableAdmission() {
      state.admission = async (req, body) => {
        const journal = JSON.parse(
          await readFile(
            path.join(directory, "checkpoint/local-native-journal.json"),
            "utf8",
          ),
        );
        const requestId = req.headers["x-catalog-request-sha256"];
        const row = journal.requests.find(
          (item) => item.requestSha256 === requestId,
        );
        assert.ok(row);
        assert.equal(row.status, "PENDING");
        assert.equal(row.route, req.url);
        assert.equal(row.method, req.method);
        assert.equal(
          row.logicalKey,
          digest({
            scope: journal.scopeSha256,
            method: req.method,
            route: req.url,
            bodySha256: sha(body),
          }),
        );
        assert.equal(
          requestId,
          digest({
            logicalKey: row.logicalKey,
            sequence: row.sequence,
            logicalAttempt: row.logicalAttempt,
          }),
        );
        const reservation = journal.budget.requests[row.sequence - 1];
        assert.equal(reservation.requestSha256, requestId);
        assert.equal(reservation.status, "PENDING");
        assert.equal(reservation.maximumUploadBytes, body.length);
        assert.equal(
          reservation.maximumDownloadBytes,
          journal.responseByteLimit,
        );
        assert.equal(journal.requests.length, journal.budget.requests.length);
      };
    },
    async close() {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
      await rm(directory, { recursive: true, force: true });
    },
  };
}

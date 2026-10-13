import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  decodeCurationMetadata,
  editorialDraftSchema,
} from "@moya/contracts/internal/editorial";
import { APIError, Forbidden, NotFound, type PayloadRequest } from "payload";
import {
  readCurationMetadata,
  saveCurationMetadata,
  contentFingerprint,
} from "admin/editorial";

const sha = (value: string) =>
  createHash("sha256").update(value, "utf8").digest("hex");
const sourceSha = "a".repeat(64);
const uploadedSha = "b".repeat(64);

const fixture = () => {
  const content = editorialDraftSchema.parse({
    catalogId: "synthetic-metadata",
    sourceId: "synthetic-source",
    kind: "inscription",
    title: "Synthetic metadata",
    media: [
      {
        mediaId: "synthetic-media-0",
        objectKey: "synthetic/example.jpg",
        width: 100,
        height: 100,
        alt: "Synthetic",
        position: 24,
        isRepresentative: true,
      },
    ],
  });
  const document = { ...content, id: 5, revision: 2, _status: "draft" };
  const photos = Array.from({ length: 83 }, (_, position) => ({
    assetId: `asset-${position}`,
    nativeId: position + 1,
    mediaId: `synthetic-media-${position}`,
    sourceSha256: sourceSha,
    uploadedSha256: uploadedSha,
    derivativeVersion: "derivation/v1",
    position,
    role: "detail",
    frame: {
      version: "artvenn-original-frame/v1",
      assetId: `asset-${position}`,
      sourceSha256: sourceSha,
      coordinateSystem: "unavailable",
      orientationApplied: false,
    },
    processing: { source: null, preview: null },
  }));
  const snapshot = {
    schemaVersion: "artvenn-curation-metadata/v1",
    sourceHashPolicy: "registry_recorded_not_reverified",
    publicationPacketSha256: sourceSha,
    catalogId: content.catalogId,
    sourceId: content.sourceId,
    objectId: "object-1",
    review: { id: "review-1", revision: 15 },
    draftBaseline: {
      id: document.id,
      revision: document.revision,
      fingerprint: contentFingerprint(document),
      status: "draft",
      displayMediaIds: ["synthetic-media-0"],
      coverMediaId: "synthetic-media-0",
    },
    photos,
    sourceGroups: [
      {
        id: "group-1",
        assetIds: photos.map((photo) => photo.assetId),
        originalRecordSha256: sourceSha,
        originalMemberCount: 83,
        excludedCount: 0,
        provenance: {},
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
      facts: [{ field: "note", value: "字𠮷" }],
      relationships: [],
    },
    modelRuns: [],
  };
  const payloadJSON = JSON.stringify(snapshot, null, 2);
  return {
    document,
    snapshot,
    command: {
      payloadJSON,
      snapshotSha256: sha(payloadJSON),
      expectedPreviousSha256: null as string | null,
    },
  };
};

const harness = () => {
  const value = fixture();
  const receipts: Record<string, unknown>[] = [];
  let before: Record<string, unknown>[] = [];
  let failAfterCreate = false;
  let headOverride:
    { metadata_sha256: string; metadata_version: number } | undefined;
  let actor = {
    collection: "users",
    id: 1,
    role: "owner",
    scopeCatalogIds: [value.document.catalogId],
  };
  const execute = vi.fn(async () => {
    const latest: Record<string, unknown> | undefined =
      headOverride ??
      [...receipts].sort(
        (a, b) => Number(b.metadataVersion) - Number(a.metadataVersion),
      )[0];
    return {
      rows: latest
        ? [
            {
              metadata_sha256: latest.metadata_sha256 ?? latest.metadataSha256,
              metadata_version:
                latest.metadata_version ?? latest.metadataVersion,
            },
          ]
        : [],
    };
  });
  const db = {
    sessions: { test: { db: { execute } } },
    beginTransaction: vi.fn(async () => {
      before = structuredClone(receipts);
      return "test";
    }),
    commitTransaction: vi.fn(async () => undefined),
    rollbackTransaction: vi.fn(async () => {
      receipts.splice(0, receipts.length, ...before);
    }),
  };
  const payload = {
    db,
    findByID: vi.fn(async () => value.document),
    find: vi.fn(
      async ({
        collection,
        where,
      }: {
        collection: string;
        where: { and?: Record<string, { equals?: unknown }>[] };
      }) => {
        if (collection === "catalogs") return { docs: [value.document] };
        if (collection === "media")
          return {
            docs: value.snapshot.photos.map((photo) => ({
              id: photo.nativeId,
              mediaId: photo.mediaId,
              catalogId: value.document.catalogId,
              sha256: photo.uploadedSha256,
            })),
          };
        const match = where.and?.find((filter) => filter.metadataSha256)
          ?.metadataSha256?.equals;
        return {
          docs: receipts.filter(
            (receipt) =>
              receipt.metadataSha256 === match &&
              (actor.role === "owner" || receipt.actor === actor.id),
          ),
        };
      },
    ),
    create: vi.fn(
      async ({
        collection,
        data,
      }: {
        collection: string;
        data: Record<string, unknown>;
      }) => {
        expect(collection).toBe("editorial-receipts");
        const row = {
          ...data,
          id: receipts.length + 1,
          createdAt: "2026-10-13T00:00:00.000Z",
        };
        receipts.push(row);
        if (failAfterCreate) {
          failAfterCreate = false;
          throw new Error("Synthetic interrupted write");
        }
        return row;
      },
    ),
    update: vi.fn(),
  };
  return {
    ...value,
    receipts,
    payload,
    db,
    execute,
    req: () => ({ payload, user: actor }) as unknown as PayloadRequest,
    interrupt: () => {
      failAfterCreate = true;
    },
    setActor: (next: typeof actor) => {
      actor = next;
    },
    setHead: (head: typeof headOverride) => {
      headOverride = head;
    },
  };
};

describe("curation metadata ledger service", () => {
  it("returns a retryable 503 for the first transient Catalog lookup, then saves the same command once", async () => {
    const h = harness();
    h.payload.findByID.mockRejectedValueOnce(
      new Error("Synthetic connection temporarily unavailable"),
    );
    await expect(
      saveCurationMetadata(h.req(), h.command),
    ).rejects.toMatchObject({
      code: "CURATION_METADATA_STORAGE_UNAVAILABLE",
      status: 503,
      message: "CURATION_METADATA_STORAGE_UNAVAILABLE",
    });
    expect(h.receipts).toHaveLength(0);
    expect(h.db.beginTransaction).not.toHaveBeenCalled();
    expect(await saveCurationMetadata(h.req(), h.command)).toMatchObject({
      current: true,
      replayed: false,
    });
    expect(h.receipts).toHaveLength(1);
    expect(h.payload.create).toHaveBeenCalledTimes(1);
  });

  it("classifies a transient in-transaction Catalog read as 503 and safely retries after rollback", async () => {
    const h = harness();
    h.payload.findByID
      .mockResolvedValueOnce(h.document)
      .mockRejectedValueOnce(
        new Error("Synthetic transaction read interrupted"),
      );
    await expect(
      saveCurationMetadata(h.req(), h.command),
    ).rejects.toMatchObject({
      code: "CURATION_METADATA_STORAGE_UNAVAILABLE",
      status: 503,
    });
    expect(h.db.rollbackTransaction).toHaveBeenCalledTimes(1);
    expect(h.receipts).toHaveLength(0);
    expect(await saveCurationMetadata(h.req(), h.command)).toMatchObject({
      current: true,
      replayed: false,
    });
    expect(h.receipts).toHaveLength(1);
  });

  it("classifies the first read API lookup failure as 503 without creating another receipt", async () => {
    const h = harness();
    await saveCurationMetadata(h.req(), h.command);
    h.payload.find.mockRejectedValueOnce(
      new Error("Synthetic lookup unavailable"),
    );
    await expect(
      readCurationMetadata(h.req(), { catalogId: h.document.catalogId }),
    ).rejects.toMatchObject({
      code: "CURATION_METADATA_STORAGE_UNAVAILABLE",
      status: 503,
    });
    expect(
      await readCurationMetadata(h.req(), { catalogId: h.document.catalogId }),
    ).toMatchObject({
      current: true,
      snapshotSha256: h.command.snapshotSha256,
    });
    expect(h.receipts).toHaveLength(1);
    expect(h.payload.create).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["Payload NotFound", new NotFound()],
    ["Payload Forbidden", new Forbidden()],
    ["authoritative API 404", new APIError("Synthetic unavailable", 404)],
    ["authoritative API 403", new APIError("Synthetic denied", 403)],
  ])(
    "keeps %s non-retryable and performs no ledger write",
    async (_name, error) => {
      void _name;
      const h = harness();
      h.payload.findByID.mockRejectedValueOnce(error);
      await expect(
        saveCurationMetadata(h.req(), h.command),
      ).rejects.toMatchObject({ code: "RECORD_UNAVAILABLE", status: 404 });
      expect(h.payload.findByID).toHaveBeenCalledTimes(1);
      expect(h.db.beginTransaction).not.toHaveBeenCalled();
      expect(h.receipts).toHaveLength(0);
      expect(h.payload.create).not.toHaveBeenCalled();
    },
  );

  it("does not mistake an arbitrary error name for Payload NotFound", async () => {
    const h = harness();
    const error = new Error("Synthetic temporary failure");
    error.name = "NotFound";
    h.payload.findByID.mockRejectedValueOnce(error);
    await expect(
      saveCurationMetadata(h.req(), h.command),
    ).rejects.toMatchObject({
      code: "CURATION_METADATA_STORAGE_UNAVAILABLE",
      status: 503,
    });
    expect(h.receipts).toHaveLength(0);
  });

  it("retains the exact UTF-8 JSON for 83 photos and never writes Catalog or Media", async () => {
    const h = harness();
    const original = structuredClone(h.document);
    const saved = await saveCurationMetadata(h.req(), h.command);
    expect(saved).toMatchObject({
      current: true,
      replayed: false,
      payloadJSON: h.command.payloadJSON,
      snapshotSha256: h.command.snapshotSha256,
      counts: { photos: 83 },
    });
    expect(
      await readCurationMetadata(h.req(), { catalogId: h.document.catalogId }),
    ).toMatchObject({
      current: true,
      payloadJSON: saved.payloadJSON,
      snapshotSha256: saved.snapshotSha256,
      counts: saved.counts,
    });
    expect(h.document).toEqual(original);
    expect(h.payload.update).not.toHaveBeenCalled();
    expect(h.payload.create).toHaveBeenCalledTimes(1);
    expect(h.receipts[0]!.metadataJson).toBe(h.command.payloadJSON);
  });

  it("recovers a committed response loss without duplicating the ledger and reports a moved baseline", async () => {
    const h = harness();
    await saveCurationMetadata(h.req(), h.command); // Client loses this response.
    expect(await saveCurationMetadata(h.req(), h.command)).toMatchObject({
      replayed: true,
      current: true,
    });
    h.document.revision++;
    expect(await saveCurationMetadata(h.req(), h.command)).toMatchObject({
      replayed: true,
      current: false,
    });
    expect(h.receipts).toHaveLength(1);
  });

  it("rolls back an interrupted insert and permits the same request to retry", async () => {
    const h = harness();
    h.interrupt();
    await expect(
      saveCurationMetadata(h.req(), h.command),
    ).rejects.toMatchObject({ code: "CURATION_METADATA_STORAGE_UNAVAILABLE" });
    expect(h.receipts).toHaveLength(0);
    expect(h.db.rollbackTransaction).toHaveBeenCalledTimes(1);
    expect(await saveCurationMetadata(h.req(), h.command)).toMatchObject({
      current: true,
      replayed: false,
    });
    expect(h.receipts).toHaveLength(1);
  });

  it("checks global CAS and cannot call an actor-visible historical row current", async () => {
    const h = harness();
    h.setActor({
      collection: "users",
      id: 2,
      role: "automation",
      scopeCatalogIds: [h.document.catalogId],
    });
    await saveCurationMetadata(h.req(), h.command);
    h.setHead({ metadata_sha256: "c".repeat(64), metadata_version: 2 });
    expect(
      await readCurationMetadata(h.req(), {
        catalogId: h.document.catalogId,
        snapshotSha256: h.command.snapshotSha256,
      }),
    ).toMatchObject({ current: false });
    await expect(
      readCurationMetadata(h.req(), { catalogId: h.document.catalogId }),
    ).rejects.toMatchObject({ code: "CURATION_METADATA_NOT_AVAILABLE" });
    const payloadJSON = h.command.payloadJSON.replace("字𠮷", "字𠮷二");
    await expect(
      saveCurationMetadata(h.req(), {
        payloadJSON,
        snapshotSha256: sha(payloadJSON),
        expectedPreviousSha256: h.command.snapshotSha256,
      }),
    ).rejects.toMatchObject({ code: "CURATION_METADATA_REVISION_CONFLICT" });
    expect(h.receipts).toHaveLength(1);
  });

  it("denies inaccessible identical content rather than creating another actor's copy", async () => {
    const h = harness();
    await saveCurationMetadata(h.req(), h.command);
    h.setActor({
      collection: "users",
      id: 2,
      role: "automation",
      scopeCatalogIds: [h.document.catalogId],
    });
    await expect(
      saveCurationMetadata(h.req(), h.command),
    ).rejects.toMatchObject({ code: "CURATION_METADATA_NOT_AVAILABLE" });
    expect(h.receipts).toHaveLength(1);
  });

  it("rejects incorrect content SHA and out-of-scope actors before any ledger writes", async () => {
    const h = harness();
    await expect(
      saveCurationMetadata(h.req(), {
        ...h.command,
        snapshotSha256: "c".repeat(64),
      }),
    ).rejects.toMatchObject({ code: "CURATION_METADATA_HASH_MISMATCH" });
    h.setActor({
      collection: "users",
      id: 2,
      role: "automation",
      scopeCatalogIds: [],
    });
    await expect(
      saveCurationMetadata(h.req(), h.command),
    ).rejects.toMatchObject({ code: "CURATION_METADATA_SCOPE_DENIED" });
    expect(h.payload.create).not.toHaveBeenCalled();
  });

  it("rejects a wrong native Media binding and detects corrupted stored text", async () => {
    const wrong = harness();
    wrong.snapshot.photos[0]!.uploadedSha256 = "c".repeat(64);
    await expect(
      saveCurationMetadata(wrong.req(), wrong.command),
    ).rejects.toMatchObject({ code: "CURATION_METADATA_MEDIA_CONFLICT" });
    expect(wrong.payload.create).not.toHaveBeenCalled();
    const h = harness();
    await saveCurationMetadata(h.req(), h.command);
    h.receipts[0]!.metadataJson = String(h.receipts[0]!.metadataJson) + " ";
    await expect(
      readCurationMetadata(h.req(), { catalogId: h.document.catalogId }),
    ).rejects.toMatchObject({ code: "CURATION_METADATA_INTEGRITY_FAILED" });
  });

  it("preserves original Python decimal hash spelling and rejects an altered canonical payload", async () => {
    const h = harness();
    const snapshot = decodeCurationMetadata(h.command.payloadJSON);
    const payloadCanonicalJSON =
      '{"kind":"photo","schema_version":"artvenn-photo-annotation/v1","values":{"position_index":1.0}}';
    snapshot.annotations.annotation_revisions.push({
      id: "annotation-1",
      context_key: sourceSha,
      object_id: snapshot.objectId,
      asset_id: snapshot.photos[0]!.assetId,
      logical_asset_id: snapshot.photos[0]!.assetId,
      source_sha256: sourceSha,
      revision: 1,
      previous_id: null,
      payload: {
        schema_version: "artvenn-photo-annotation/v1",
        kind: "photo",
        values: { position_index: 1 },
      },
      payloadCanonicalJSON,
      payload_sha256: sha(payloadCanonicalJSON),
      changes: { position_index: 1 },
      coordinate_frame: snapshot.photos[0]!.frame,
      review_id: snapshot.review.id,
      review_revision: snapshot.review.revision,
      review_draft_sha256: sourceSha,
      membership_sha256: sourceSha,
      confirmation_event: sourceSha,
      created: 0,
    });
    const payloadJSON = JSON.stringify(snapshot);
    expect(
      await saveCurationMetadata(h.req(), {
        payloadJSON,
        snapshotSha256: sha(payloadJSON),
        expectedPreviousSha256: null,
      }),
    ).toMatchObject({ current: true, payloadJSON });
    snapshot.annotations.annotation_revisions[0]!.payloadCanonicalJSON =
      payloadCanonicalJSON.replace("1.0", "2.0");
    snapshot.annotations.annotation_revisions[0]!.payload_sha256 = sha(
      String(
        snapshot.annotations.annotation_revisions[0]!.payloadCanonicalJSON,
      ),
    );
    const altered = JSON.stringify(snapshot);
    await expect(
      saveCurationMetadata(h.req(), {
        payloadJSON: altered,
        snapshotSha256: sha(altered),
        expectedPreviousSha256: sha(payloadJSON),
      }),
    ).rejects.toMatchObject({
      code: "CONTENT_INVALID",
    });
    // Semantically identical text with changed bytes must also preserve the
    // original stored checksum; this reaches the server's byte-hash guard.
    snapshot.annotations.annotation_revisions[0]!.payloadCanonicalJSON =
      payloadCanonicalJSON + " ";
    snapshot.annotations.annotation_revisions[0]!.payload_sha256 =
      sha(payloadCanonicalJSON);
    const alteredBytes = JSON.stringify(snapshot);
    await expect(
      saveCurationMetadata(h.req(), {
        payloadJSON: alteredBytes,
        snapshotSha256: sha(alteredBytes),
        expectedPreviousSha256: sha(payloadJSON),
      }),
    ).rejects.toMatchObject({
      code: "CURATION_METADATA_ANNOTATION_HASH_MISMATCH",
    });
    expect(h.receipts).toHaveLength(1);
  });
});

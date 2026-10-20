import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { URL } from "node:url";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  createLocalReq,
  createPayloadRequest,
  getPayload,
  type Payload,
  type TypedUser,
} from "payload";
import { decodeCurationMetadata } from "@moya/contracts/internal/editorial";
import config from "admin/config";
import {
  readCurationMetadata,
  readDraft,
  saveCurationMetadata,
  saveDraft,
} from "admin/editorial";

if (
  process.env.CMS_ENVIRONMENT !== "synthetic" ||
  !process.env.CMS_DATABASE_URL
)
  throw new Error("An isolated synthetic CMS database is required");

const automationKey = randomUUID();
const ownerPassword = randomUUID();
const { Request } = globalThis;
const run = randomUUID();
const ownerEmail = `curation-owner-${run}@example.invalid`;
const catalogId = `synthetic-curation-${run}`;
const sourceId = `synthetic-source-${run}`;
const digest = (text: string) =>
  createHash("sha256").update(text, "utf8").digest("hex");
const sourceSha = digest(
  "Synthetic original identity; no image bytes are read",
);
const uploadedSha = digest("Synthetic registered derivative identity");
let payload: Payload;
let owner: TypedUser;
let automation: TypedUser;
let outsider: TypedUser;
let snapshot: ReturnType<typeof decodeCurationMetadata>;
let command: {
  payloadJSON: string;
  snapshotSha256: string;
  expectedPreviousSha256: string | null;
};
const reqFor = (user: TypedUser | null) =>
  createLocalReq(user ? { user } : {}, payload);

beforeAll(async () => {
  payload = await getPayload({ config });
  owner = await payload.create({
    collection: "users",
    overrideAccess: true,
    data: {
      email: ownerEmail,
      password: ownerPassword,
      role: "owner",
    },
  });
  const account = async (label: string, scopeCatalogIds: string[]) =>
    payload.create({
      collection: "users",
      overrideAccess: false,
      req: await reqFor(owner),
      user: owner,
      data: {
        email: `curation-${label}-${run}@example.invalid`,
        password: randomUUID(),
        role: "automation",
        scopeCatalogIds,
        ...(label === "automation"
          ? { enableAPIKey: true, apiKey: automationKey }
          : {}),
      },
    });
  automation = await account("automation", [catalogId]);
  outsider = await account("outsider", [`outside-${run}`]);
  const initial = await saveDraft(await reqFor(automation), {
    idempotencyKey: `curation-${run}:create`,
    content: {
      catalogId,
      sourceId,
      kind: "inscription",
      title: "Synthetic curation metadata",
      media: [],
    },
  });
  // Register synthetic identities only. This fixture never opens image files,
  // downloads objects, or claims stored-byte proof.
  const media = [];
  for (let position = 0; position < 83; position++) {
    media.push(
      await payload.create({
        collection: "media",
        overrideAccess: false,
        req: await reqFor(owner),
        user: owner,
        data: {
          mediaId: `synthetic-media-${run}-${position}`,
          catalogId,
          origin: "existing",
          objectKey: `synthetic/${run}/metadata-${run}-${position}.jpg`,
          sha256: uploadedSha,
          alt: "Synthetic existing identity",
          mimeType: "image/jpeg",
          filesize: 1,
          width: 100,
          height: 100,
        },
      }),
    );
  }
  const cover = media[24]!;
  const saved = await saveDraft(await reqFor(automation), {
    id: initial.id,
    expectedRevision: initial.revision,
    idempotencyKey: `curation-${run}:display`,
    content: {
      catalogId,
      sourceId,
      kind: "inscription",
      title: "Synthetic curation metadata",
      media: [
        {
          mediaId: cover.mediaId,
          objectKey: cover.objectKey,
          width: cover.width,
          height: cover.height,
          alt: cover.alt,
          position: 24,
          isRepresentative: true,
        },
      ],
    },
  });
  const photos = media.map((item, position) => ({
    assetId: `asset-${position}`,
    nativeId: item.id,
    mediaId: item.mediaId,
    sourceSha256: sourceSha,
    uploadedSha256: uploadedSha,
    derivativeVersion: "synthetic-derivation/v1",
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
  const annotationPayload = {
    kind: "photo",
    schema_version: "artvenn-photo-annotation/v1",
    values: { representation: "stone" },
  };
  const payloadSha = digest(JSON.stringify(annotationPayload));
  const confirmation = digest("Synthetic explicit confirmation");
  const revisions = photos.map((photo) => ({
    id: `annotation-${photo.position}`,
    context_key: digest(`context-${photo.position}`),
    object_id: "object-1",
    asset_id: photo.assetId,
    logical_asset_id: photo.assetId,
    source_sha256: sourceSha,
    revision: 1,
    previous_id: null,
    payload: annotationPayload,
    payload_sha256: payloadSha,
    changes: { representation: "stone" },
    coordinate_frame: photo.frame,
    review_id: "review-1",
    review_revision: 15,
    review_draft_sha256: confirmation,
    membership_sha256: confirmation,
    confirmation_event: confirmation,
    created: 0.125,
  }));
  const decisions = revisions.map((revision) => ({
    id: `annotation-decision-${revision.id}`,
    revision_id: revision.id,
    status: "human_confirmed",
    payload_sha256: payloadSha,
    confirmation_event: confirmation,
    membership_decision_id: "membership-1",
    reviewer: "synthetic-local-reviewer",
    created: 0.125,
    provenance: {
      kind: "explicit_local_confirmation",
      reviewId: "review-1",
      reviewRevision: 15,
      draftSha256: confirmation,
      actorSource: "native_membership_reviewer",
      nativeApprovalScope: "membership_and_legacy_role_only",
    },
  }));
  snapshot = decodeCurationMetadata(
    JSON.stringify({
      schemaVersion: "artvenn-curation-metadata/v1",
      sourceHashPolicy: "registry_recorded_not_reverified",
      publicationPacketSha256: confirmation,
      catalogId,
      sourceId,
      objectId: "object-1",
      draftBaseline: {
        id: saved.id,
        revision: saved.revision,
        fingerprint: saved.fingerprint,
        status: "draft",
        displayMediaIds: [cover.mediaId],
        coverMediaId: cover.mediaId,
      },
      review: { id: "review-1", revision: 15 },
      photos,
      sourceGroups: [
        {
          id: "group-1",
          assetIds: photos.map((photo) => photo.assetId),
          originalRecordSha256: confirmation,
          originalMemberCount: 83,
          excludedCount: 0,
          provenance: {},
        },
      ],
      annotations: {
        annotation_revisions: revisions,
        annotation_decisions: decisions,
        current_annotations: revisions.map((revision, index) => ({
          revision_id: revision.id,
          decision_id: decisions[index]!.id,
          object_id: "object-1",
          asset_id: revision.asset_id,
        })),
      },
      history: {
        proposals: [
          {
            id: "proposal-1",
            batch_id: "batch-1",
            subject: "object-1",
            kind: "group",
            field: null,
            value: photos.map((photo) => photo.assetId),
            evidence: photos.map((photo) => photo.assetId),
            input_hash: confirmation,
            model_revision: "synthetic-model/v1",
            prompt_version: "synthetic-review/v1",
            created: 0.125,
            version: 1,
          },
        ],
        decisions: [
          {
            id: "membership-1",
            proposal_id: "proposal-1",
            task_key: "task-1",
            annotation_id: 1,
            annotation_hash: confirmation,
            status: "accepted",
            value: [],
            reviewer: "synthetic-local-reviewer",
            created: 0.125,
          },
        ],
        reviewDecisions: [],
        annotationSnapshots: [],
        fieldProvenance: [],
        facts: [{ field: "note", value: "字𠮷" }],
        relationships: [],
      },
      modelRuns: [],
    }),
  );
  const payloadJSON = JSON.stringify(snapshot, null, 2).replaceAll(
    "0.125",
    "0.125000",
  );
  command = {
    payloadJSON,
    snapshotSha256: digest(payloadJSON),
    expectedPreviousSha256: null,
  };
}, 30_000);

afterAll(async () => {
  await payload?.destroy();
});

describe.sequential("native CMS append-only curation metadata", () => {
  it("commits the complete 83-photo artifact without changing the Draft or native media", async () => {
    const before = await readDraft(await reqFor(automation), {
      id: snapshot.draftBaseline.id,
    });
    const versions = await payload.countVersions({
      collection: "catalogs",
      where: { parent: { equals: before.id } },
    });
    const mediaBefore = await payload.find({
      collection: "media",
      where: { catalogId: { equals: catalogId } },
      limit: 100,
      pagination: false,
      depth: 0,
      req: await reqFor(owner),
      overrideAccess: false,
    });
    // This real artifact must exercise Payload's field validation beyond its
    // default 40,000-character text limit, not only a mocked ledger write.
    expect(command.payloadJSON.length).toBeGreaterThan(40_000);
    const saved = await saveCurationMetadata(await reqFor(automation), command);
    expect(saved).toMatchObject({
      current: true,
      replayed: false,
      payloadJSON: command.payloadJSON,
      snapshotSha256: command.snapshotSha256,
      counts: {
        photos: 83,
        currentAnnotations: 83,
        annotationRevisions: 83,
        annotationDecisions: 83,
      },
    });
    expect(
      await readCurationMetadata(await reqFor(automation), { catalogId }),
    ).toMatchObject({
      current: true,
      payloadJSON: command.payloadJSON,
      snapshotSha256: command.snapshotSha256,
    });
    expect(
      await saveCurationMetadata(await reqFor(automation), command),
    ).toMatchObject({ replayed: true, id: saved.id });
    expect(
      (
        await payload.count({
          collection: "editorial-receipts",
          where: {
            metadataSha256: { equals: command.snapshotSha256 },
          },
          req: await reqFor(owner),
          overrideAccess: false,
        })
      ).totalDocs,
    ).toBe(1);
    expect(
      await readDraft(await reqFor(automation), { id: before.id }),
    ).toEqual(before);
    expect(
      (
        await payload.countVersions({
          collection: "catalogs",
          where: { parent: { equals: before.id } },
        })
      ).totalDocs,
    ).toBe(versions.totalDocs);
    expect(
      (
        await payload.find({
          collection: "media",
          where: { catalogId: { equals: catalogId } },
          limit: 100,
          pagination: false,
          depth: 0,
          req: await reqFor(owner),
          overrideAccess: false,
        })
      ).docs,
    ).toEqual(mediaBefore.docs);
  });

  it("authenticates native metadata JSON endpoints and returns full no-store content without image requests", async () => {
    const login = await payload.login({
      collection: "users",
      data: { email: ownerEmail, password: ownerPassword },
    });
    if (!login.token) throw new Error("Synthetic authentication required");
    const nativeCall = async (
      name: string,
      body: unknown,
      authenticated = true,
    ) => {
      const req = await createPayloadRequest({
        config,
        request: new Request(`http://127.0.0.1/api/editorial/${name}`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(authenticated ? { Authorization: `JWT ${login.token}` } : {}),
          },
          body: JSON.stringify(body),
        }),
      });
      const endpoint = payload.config.endpoints.find(
        (candidate) =>
          candidate.path === `/editorial/${name}` &&
          candidate.method === "post",
      );
      if (!endpoint) throw new Error("Synthetic endpoint required");
      return endpoint.handler(req);
    };
    const saved = await nativeCall("save-curation-metadata", command);
    expect(saved.status).toBe(200);
    expect(saved.headers.get("Cache-Control")).toBe("no-store");
    const acknowledged = await saved.json();
    expect(acknowledged).toMatchObject({
      ok: true,
      result: { replayed: true, snapshotSha256: command.snapshotSha256 },
    });
    const read = await nativeCall("read-curation-metadata", { catalogId });
    expect(read.status).toBe(200);
    expect(read.headers.get("Cache-Control")).toBe("no-store");
    const stored = await read.json();
    expect(stored).toMatchObject({
      ok: true,
      result: { current: true, payloadJSON: command.payloadJSON },
    });
    expect(digest(stored.result.payloadJSON)).toBe(command.snapshotSha256);
    expect(
      (await nativeCall("read-curation-metadata", { catalogId }, false)).status,
    ).toBe(403);
    const oversized = await nativeCall("read-curation-metadata", {
      catalogId,
      padding: "x".repeat(4096),
    });
    expect(oversized.status).toBe(413);
  });

  it("runs the workstation metadata SDK through authenticated native API handlers and reopens its journal", async () => {
    const directory = await mkdtemp(join(tmpdir(), "curation-sdk-native-"));
    const metadataFile = join(directory, "snapshot.json");
    const configFile = join(directory, "config.json");
    await writeFile(metadataFile, command.payloadJSON, { mode: 0o600 });
    await writeFile(
      configFile,
      JSON.stringify({
        baseURL: "http://127.0.0.1:39109",
        apiKey: automationKey,
        attempts: 3,
      }),
      { mode: 0o600 },
    );
    const routes: string[] = [];
    const nativeFetch: typeof fetch = async (input, options) => {
      const request = new Request(input, options);
      const req = await createPayloadRequest({ config, request });
      const route = new URL(request.url).pathname.replace(/^\/api/, "");
      routes.push(route);
      const endpoint = payload.config.endpoints.find(
        (candidate) => candidate.path === route && candidate.method === "post",
      );
      if (!endpoint) throw new Error("Synthetic metadata endpoint required");
      return endpoint.handler(req);
    };
    const { metadataRoundtrip } = (await import(
      new URL("../../scripts/curation/metadata-roundtrip.mjs", import.meta.url)
        .href
    )) as {
      metadataRoundtrip(options: {
        metadataFile: string;
        configFile: string;
        stateDirectory: string;
        execute: boolean;
        fetchImpl: typeof fetch;
      }): Promise<Record<string, unknown>>;
    };
    try {
      const transient = vi
        .spyOn(payload, "findByID")
        .mockRejectedValueOnce(
          new Error("Synthetic temporary database unavailable"),
        );
      const inputs = {
        metadataFile,
        configFile,
        stateDirectory: join(directory, "state"),
        execute: true,
        fetchImpl: nativeFetch,
      };
      expect(await metadataRoundtrip(inputs)).toMatchObject({
        status: "PERSISTED_AND_READBACK_VERIFIED",
        succeeded: 1,
        independentMediaByteVerification: "NOT_RUN",
      });
      expect(await metadataRoundtrip(inputs)).toMatchObject({
        status: "PERSISTED_AND_READBACK_VERIFIED",
        succeeded: 1,
      });
      transient.mockRestore();
      expect(routes).toEqual([
        "/editorial/save-curation-metadata",
        "/editorial/save-curation-metadata",
        "/editorial/read-curation-metadata",
        "/editorial/save-curation-metadata",
        "/editorial/read-curation-metadata",
      ]);
      expect(
        (
          await payload.count({
            collection: "editorial-receipts",
            where: { metadataSha256: { equals: command.snapshotSha256 } },
            req: await reqFor(owner),
            overrideAccess: false,
          })
        ).totalDocs,
      ).toBe(1);
      expect(
        (
          await readDraft(await reqFor(automation), {
            id: snapshot.draftBaseline.id,
          })
        ).content.media,
      ).toHaveLength(1);
    } finally {
      vi.restoreAllMocks();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("uses an existing native Owner JWT for metadata-only SDK readback and journal reopen", async () => {
    const login = await payload.login({
      collection: "users",
      data: { email: ownerEmail, password: ownerPassword },
    });
    if (!login.token || !login.user || !Number.isFinite(login.exp))
      throw new Error("Synthetic Owner JWT authentication required");
    const actorId = Number(login.user.id);
    const expiry = Math.min(login.exp! * 1000, Date.now() + 2 * 60 * 60 * 1000);
    expect(actorId).toBe(Number(owner.id));
    expect(Number.isSafeInteger(actorId) && actorId > 0).toBe(true);
    expect(expiry).toBeGreaterThan(Date.now());
    const origin = "https://synthetic-editorial.example.invalid";
    const directory = await mkdtemp(join(tmpdir(), "curation-sdk-owner-jwt-"));
    const metadataFile = join(directory, "snapshot.json");
    const configFile = join(directory, "config.json");
    const stateDirectory = join(directory, "owner-jwt-state");
    try {
      // Production-shaped existing session; every request is injected into the
      // isolated native Payload handler. No network or real configuration.
      await writeFile(metadataFile, command.payloadJSON, { mode: 0o600 });
      await writeFile(
        configFile,
        JSON.stringify({
          baseURL: origin,
          instance: "production",
          targetVerified: true,
          syntheticOnly: false,
          sessionToken: login.token,
          actorId,
          sessionExpiresAt: new Date(expiry).toISOString(),
          attempts: 1,
        }),
        { mode: 0o600 },
      );
      const before = await readDraft(await reqFor(owner), {
        id: snapshot.draftBaseline.id,
      });
      const versions = await payload.countVersions({
        collection: "catalogs",
        where: { parent: { equals: before.id } },
      });
      const mediaQuery = {
        collection: "media" as const,
        where: { catalogId: { equals: catalogId } },
        limit: 100,
        pagination: false,
        depth: 0,
        sort: "id",
        overrideAccess: false,
      };
      const mediaBefore = await payload.find({
        ...mediaQuery,
        req: await reqFor(owner),
      });
      const routes: string[] = [];
      const nativeFetch: typeof fetch = async (input, options) => {
        const request = new Request(input, options);
        const url = new URL(request.url);
        if (
          url.origin !== origin ||
          request.method !== "POST" ||
          ![
            "/api/editorial/save-curation-metadata",
            "/api/editorial/read-curation-metadata",
          ].includes(url.pathname) ||
          options?.redirect !== "error" ||
          request.headers.get("Authorization") !== `JWT ${login.token}`
        )
          throw new Error("Synthetic metadata-only Owner JWT request required");
        const req = await createPayloadRequest({ config, request });
        if (req.user?.collection !== "users")
          throw new Error("Synthetic native Owner user required");
        expect(req.user.id).toBe(owner.id);
        expect(req.user.role).toBe("owner");
        const route = url.pathname.replace(/^\/api/, "");
        routes.push(route);
        const endpoint = payload.config.endpoints.find(
          (candidate) =>
            candidate.path === route && candidate.method === "post",
        );
        if (!endpoint) throw new Error("Synthetic metadata endpoint required");
        const response = await endpoint.handler(req);
        expect(response.status).toBe(200);
        expect(response.headers.get("Cache-Control")).toBe("no-store");
        const stored = await response.clone().json();
        expect(stored).toMatchObject({
          ok: true,
          result: {
            current: true,
            payloadJSON: command.payloadJSON,
            snapshotSha256: command.snapshotSha256,
            counts: {
              photos: 83,
              currentAnnotations: 83,
              annotationRevisions: 83,
              annotationDecisions: 83,
            },
          },
        });
        expect(digest(stored.result.payloadJSON)).toBe(command.snapshotSha256);
        return response;
      };
      const { metadataRoundtrip } = (await import(
        new URL(
          "../../scripts/curation/metadata-roundtrip.mjs",
          import.meta.url,
        ).href
      )) as {
        metadataRoundtrip(options: {
          metadataFile: string;
          configFile: string;
          stateDirectory: string;
          execute: boolean;
          fetchImpl: typeof fetch;
        }): Promise<Record<string, unknown>>;
      };
      const inputs = {
        metadataFile,
        configFile,
        stateDirectory,
        execute: true,
        fetchImpl: nativeFetch,
      };
      for (let attempt = 0; attempt < 2; attempt++)
        expect(await metadataRoundtrip(inputs)).toMatchObject({
          status: "PERSISTED_AND_READBACK_VERIFIED",
          succeeded: 1,
          failed: 0,
          pending: 0,
          independentMediaByteVerification: "NOT_RUN",
        });
      expect(routes).toEqual([
        "/editorial/save-curation-metadata",
        "/editorial/read-curation-metadata",
        "/editorial/save-curation-metadata",
        "/editorial/read-curation-metadata",
      ]);
      const journal = await readFile(
        join(stateDirectory, `${command.snapshotSha256}.receipt.jsonl`),
        "utf8",
      );
      expect(journal.includes(login.token)).toBe(false);
      expect(
        JSON.parse(journal.trim().split("\n").at(-1)!).value,
      ).toMatchObject({
        status: "succeeded",
        result: {
          snapshotSha256: command.snapshotSha256,
          verifiedReadback: true,
          currentAtReadback: true,
        },
      });
      expect(
        (
          await payload.count({
            collection: "editorial-receipts",
            where: { metadataSha256: { equals: command.snapshotSha256 } },
            req: await reqFor(owner),
            overrideAccess: false,
          })
        ).totalDocs,
      ).toBe(1);
      expect(await readDraft(await reqFor(owner), { id: before.id })).toEqual(
        before,
      );
      expect(
        (
          await payload.countVersions({
            collection: "catalogs",
            where: { parent: { equals: before.id } },
          })
        ).totalDocs,
      ).toBe(versions.totalDocs);
      expect(
        (await payload.find({ ...mediaQuery, req: await reqFor(owner) })).docs,
      ).toEqual(mediaBefore.docs);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("checks the global latest version while retaining the existing actor-only payload access", async () => {
    const payloadJSON = command.payloadJSON.replace("字𠮷", "字𠮷二");
    const second = {
      payloadJSON,
      snapshotSha256: digest(payloadJSON),
      expectedPreviousSha256: command.snapshotSha256,
    };
    expect(
      await saveCurationMetadata(await reqFor(owner), second),
    ).toMatchObject({ current: true });
    expect(
      await readCurationMetadata(await reqFor(automation), {
        catalogId,
        snapshotSha256: command.snapshotSha256,
      }),
    ).toMatchObject({ current: false });
    await expect(
      readCurationMetadata(await reqFor(automation), { catalogId }),
    ).rejects.toMatchObject({ code: "CURATION_METADATA_NOT_AVAILABLE" });
    await expect(
      saveCurationMetadata(await reqFor(automation), second),
    ).rejects.toMatchObject({ code: "CURATION_METADATA_NOT_AVAILABLE" });
    await expect(
      readCurationMetadata(await reqFor(outsider), { catalogId }),
    ).rejects.toMatchObject({ code: "CURATION_METADATA_SCOPE_DENIED" });
    await expect(
      readCurationMetadata(await reqFor(null), { catalogId }),
    ).rejects.toMatchObject({ code: "AUTHORIZATION_REQUIRED" });
    await expect(
      payload.create({
        collection: "editorial-receipts",
        overrideAccess: false,
        req: await reqFor(owner),
        data: {
          deduplicationKey: `forged-${run}`,
          requestFingerprint: sourceSha,
          actor: owner.id,
          operation: "save-curation-metadata",
          status: "completed",
          metadataJson: payloadJSON,
        },
      }),
    ).rejects.toThrow();
  });

  it("has valid SQL-owned partial indexes and rejects a duplicate content row", async () => {
    const result = await payload.db.pool.query(
      `SELECT i.relname, x.indisunique, x.indisvalid,
      pg_get_expr(x.indpred, x.indrelid) AS predicate FROM pg_index x
      JOIN pg_class i ON i.oid=x.indexrelid WHERE i.relname=ANY($1)`,
      [
        [
          "editorial_receipts_metadata_content_idx",
          "editorial_receipts_metadata_version_idx",
        ],
      ],
    );
    expect(result.rows).toHaveLength(2);
    for (const row of result.rows) {
      expect(row.indisunique).toBe(true);
      expect(row.indisvalid).toBe(true);
      expect(row.predicate).toContain("IS NOT NULL");
    }
    const client = await payload.db.pool.connect();
    try {
      await client.query("BEGIN");
      await expect(
        client.query(
          `INSERT INTO editorial_receipts
        (deduplication_key,request_fingerprint,actor_id,operation,status,catalog_id,
         metadata_catalog_id,metadata_sha256,metadata_version)
        VALUES($1,$2,$3,'save-curation-metadata','completed',$4,$5,$6,99)`,
          [
            `duplicate-${run}`,
            sourceSha,
            owner.id,
            snapshot.draftBaseline.id,
            catalogId,
            command.snapshotSha256,
          ],
        ),
      ).rejects.toMatchObject({
        code: "23505",
        constraint: "editorial_receipts_metadata_content_idx",
      });
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
  });
});

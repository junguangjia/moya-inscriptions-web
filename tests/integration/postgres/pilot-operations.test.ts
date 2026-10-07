import { randomBytes } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import https, { request as requestHttps } from "node:https";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  applyPilotImport,
  assertPilotDatabase,
  pilotScopeSha256,
  pilotSha256,
  preparePilotImport,
  syncPilotMedia,
} from "@moya/catalog-importer";
import {
  createPostgresPool,
  parsePostgresConfig,
  runMigrations,
} from "@moya/catalog-postgres";
import { runCommunityMigrations } from "@moya/community-postgres";
import { prepareProductionBackend } from "@moya/backend-production";
import { startBackendProcess } from "@moya/backend-runtime";
import { CATALOG_IMPORT_V2_CSV_SPEC } from "@moya/contracts/internal/catalog-import";
import {
  catalogDetailSchema,
  catalogPageSchema,
} from "@moya/contracts/schemas";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import { assertSyntheticTestDatabaseUrl } from "./synthetic-test-database.js";

import type {
  CatalogImportApplicationResult,
  PilotApprovalDocument,
  PilotMedia,
  PilotMediaTransport,
  PilotScope,
} from "@moya/catalog-importer";

// Creating a dedicated database is intentionally opt-in. A normal PostgreSQL
// regression run does not gain new administrative authority from an env name.
const enabled = process.env.PILOT_TEST_ALLOW_CREATE_DATABASE === "1";
const databaseUrl = process.env.TEST_DATABASE_URL;
const expectedSystemIdentifier = process.env.PILOT_TEST_SYSTEM_IDENTIFIER;
const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));

describe.skipIf(!enabled)(
  "Pilot operations on a dedicated synthetic database",
  () => {
    let administration: ReturnType<typeof createPostgresPool> | undefined;
    let pool: ReturnType<typeof createPostgresPool> | undefined;
    let directory: string | undefined;
    let databaseCreated = false;
    const database = `pilot_ops_${process.pid}_${randomBytes(6).toString("hex")}`;
    let scope: PilotScope;
    let approval: PilotApprovalDocument;
    let prepared: Awaited<ReturnType<typeof preparePilotImport>>;
    let applied: CatalogImportApplicationResult;
    let rows: PilotMedia[];
    let manifestFile: string;
    let bundleDirectory: string;
    let photoRoot: string;

    const requirePool = () => {
      if (pool === undefined)
        throw new Error("Synthetic database was not created");
      return pool;
    };

    beforeAll(async () => {
      if (!databaseUrl || !expectedSystemIdentifier) {
        throw new Error(
          "Explicit TEST_DATABASE_URL and verified PILOT_TEST_SYSTEM_IDENTIFIER are required",
        );
      }
      // Refuse yoyi_dev or any unmarked database before the administration pool exists.
      assertSyntheticTestDatabaseUrl(databaseUrl);
      const endpoint = new URL(databaseUrl);
      if (
        !["127.0.0.1", "localhost", "[::1]"].includes(endpoint.hostname) ||
        endpoint.search !== "" ||
        endpoint.hash !== ""
      ) {
        throw new Error(
          "Synthetic Pilot tests require an explicitly verified loopback instance without URL query overrides or fragments",
        );
      }
      administration = createPostgresPool(
        parsePostgresConfig({ DATABASE_URL: databaseUrl }),
      );
      const actualSystem = await administration.query(
        "SELECT system_identifier::text AS id FROM pg_control_system()",
      );
      expect(actualSystem.rows[0]?.id).toBe(expectedSystemIdentifier);
      // Only this unpredictable, test-owned database is ever created or dropped.
      expect(database).toMatch(/^pilot_ops_[0-9]+_[a-f0-9]{12}$/);
      await administration.query(`CREATE DATABASE ${database}`);
      databaseCreated = true;
      const isolated = new URL(databaseUrl);
      isolated.pathname = `/${database}`;
      pool = createPostgresPool(
        parsePostgresConfig({ DATABASE_URL: isolated.toString() }),
      );
      await runMigrations(
        pool,
        path.join(repositoryRoot, "database/migrations"),
      );
      // The production composition also verifies the community ledger read-only.
      await runCommunityMigrations(
        pool,
        path.join(repositoryRoot, "database/community-migrations"),
      );
      const identity =
        await pool.query(`SELECT current_database() AS database, current_user AS "user",
      (SELECT oid::text FROM pg_database WHERE datname=current_database()) AS "databaseOid",
      inet_server_addr()::text AS "serverAddress", inet_server_port() AS "serverPort",
      current_setting('server_version_num') AS "versionNum"`);
      directory = await mkdtemp(
        path.join(tmpdir(), "pilot-postgres-synthetic-"),
      );
      bundleDirectory = path.join(directory, "bundle");
      photoRoot = path.join(directory, "photos");
      manifestFile = path.join(directory, "media.json");
      await mkdir(bundleDirectory);
      await mkdir(photoRoot);
      const catalogs = [8, 8, 4].map((mediaCount, index) => ({
        catalogImportId: `synthetic-pilot-${index}`,
        sourceId: `synthetic-pilot-source-${index}`,
        mediaCount,
      }));
      const photo = Buffer.alloc(30);
      photo.write("RIFF", 0);
      photo.writeUInt32LE(photo.length - 8, 4);
      photo.write("WEBPVP8X", 8);
      photo.writeUInt32LE(10, 16);
      let number = 0;
      rows = catalogs.flatMap((catalog, group) =>
        Array.from({ length: catalog.mediaCount }, (_, position) => {
          const mediaId = `media_${(++number).toString(16).padStart(32, "0")}`;
          const sha256 = pilotSha256(photo);
          return {
            catalogImportId: catalog.catalogImportId,
            sourceId: catalog.sourceId,
            mediaId,
            objectKey: `display/v1/${mediaId}/${sha256}.webp`,
            relativePath: `synthetic-${number}.webp`,
            sha256,
            sizeBytes: photo.length,
            width: 1,
            height: 1,
            position,
            isRepresentative: position === (group === 2 ? 2 : 0),
            altText: `Synthetic media ${number}`,
            orderConfidence: group === 2 ? ("LOW" as const) : ("HIGH" as const),
          };
        }),
      );
      await Promise.all(
        rows.map((row) =>
          writeFile(path.join(photoRoot, row.relativePath), photo),
        ),
      );
      const manifest = JSON.stringify({ rows });
      await writeFile(manifestFile, manifest);
      scope = {
        purpose: "LOCAL_NON_PRODUCTION_PILOT",
        operationId: "synthetic-persistent-pilot",
        target: {
          host: endpoint.hostname,
          port: Number(endpoint.port || 5432),
          ...identity.rows[0],
          systemIdentifier: expectedSystemIdentifier,
        },
        catalogs,
        mediaManifestSha256: pilotSha256(manifest),
        cos: {
          bucket: "synthetic-pilot-123456",
          region: "ap-test",
          mediaOrigin: "https://synthetic-media.invalid",
        },
      };
      const tables: Record<string, Record<string, string>[]> = {
        "00_manifest.csv": [{ importContractVersion: "catalog-import/v2" }],
        "catalog.csv": catalogs.map((row, index) => ({
          catalogImportId: row.catalogImportId,
          sourceId: row.sourceId,
          title: `Synthetic Pilot ${index}`,
          catalogKind: index === 2 ? "calligraphy" : "inscription",
          summary: `Synthetic summary ${index}`,
          description: "Synthetic persisted description",
          descriptionState: "VALUE",
          contributorsAction: "PRESERVE",
          publicCitationsAction: "PRESERVE",
        })),
        "aliases.csv": [],
        "contributors.csv": [],
        "public_citations.csv": [],
        "provenance.csv": catalogs.map((row) => ({
          catalogImportId: row.catalogImportId,
          sourceId: row.sourceId,
        })),
      };
      for (const [file, headers] of Object.entries(
        CATALOG_IMPORT_V2_CSV_SPEC.files,
      )) {
        await writeFile(
          path.join(bundleDirectory, file),
          [
            headers.join(","),
            ...tables[file]!.map((row) =>
              headers.map((header) => row[header] ?? "").join(","),
            ),
            "",
          ].join("\n"),
        );
      }
      prepared = await preparePilotImport(pool, bundleDirectory, scope);
      expect(prepared.dryRun.applyReady).toBe(true);
      approval = {
        purpose: "PERSISTENT_NON_PRODUCTION_PILOT",
        nonProduction: true,
        publicationApproval: false,
        ownerInstructionReference:
          "synthetic test authorization, no live Pilot input",
        operationId: scope.operationId,
        targetScopeSha256: pilotScopeSha256(scope),
        mediaManifestSha256: scope.mediaManifestSha256,
        approval: {
          importContractVersion: "catalog-import/v2",
          state: "APPROVED",
          canonicalInputSha256: prepared.canonicalInputSha256,
          dryRunResultSha256: prepared.dryRun.dryRunResultSha256,
          approvedFindingIds: prepared.dryRun.findings
            .filter((finding) => finding.approvable)
            .map((finding) => finding.findingId),
          decidedBy: "synthetic test fixture",
          decidedAt: "2026-01-01T00:00:00.000Z",
        },
      };
      applied = await applyPilotImport(
        pool,
        bundleDirectory,
        scope,
        prepared.dryRun,
        approval,
        {
          allocateCatalogId: ({ catalogImportId }) =>
            `catalog-${catalogImportId}`,
        },
      );
      expect(applied.status).toBe("APPLIED");
    });

    beforeEach(async () => {
      await requirePool().query("DELETE FROM catalog_media");
    });

    afterAll(async () => {
      await pool?.end();
      if (databaseCreated)
        await administration?.query(`DROP DATABASE ${database}`);
      await administration?.end();
      if (directory) await rm(directory, { recursive: true, force: true });
    });

    const transport = () => {
      const objects = new Map<string, Buffer>();
      const ensureObject = vi.fn<PilotMediaTransport["ensureObject"]>(
        async (objectKey, bytes) => {
          const existing = objects.get(objectKey);
          if (existing && !existing.equals(bytes))
            throw new Error("Synthetic remote conflict; no overwrite");
          if (!existing) objects.set(objectKey, Buffer.from(bytes));
          const actual = objects.get(objectKey)!;
          return {
            objectKey,
            sha256: pilotSha256(actual),
            sizeBytes: actual.length,
            outcome: existing ? "reused" : "uploaded",
            verifiedAt: "2026-01-01T00:00:00.000Z",
          };
        },
      );
      return { objects, ensureObject };
    };

    it("replays without allocating and verifies actual target identity before accepting replay", async () => {
      const allocator = {
        allocateCatalogId: vi.fn(() => "must-not-allocate-on-replay"),
      };
      const replay = await applyPilotImport(
        requirePool(),
        bundleDirectory,
        scope,
        prepared.dryRun,
        approval,
        allocator,
      );
      expect(replay).toEqual({ ...applied, status: "ALREADY_APPLIED" });
      expect(allocator.allocateCatalogId).not.toHaveBeenCalled();
      const changed: PilotScope = {
        ...scope,
        target: { ...scope.target, databaseOid: "0" },
      };
      const reBound = {
        ...approval,
        targetScopeSha256: pilotScopeSha256(changed),
      };
      await expect(
        applyPilotImport(
          requirePool(),
          bundleDirectory,
          changed,
          prepared.dryRun,
          reBound,
          allocator,
        ),
      ).rejects.toThrow(/identity mismatch/);
      expect(allocator.allocateCatalogId).not.toHaveBeenCalled();
      const changedCos: PilotScope = {
        ...scope,
        cos: { ...scope.cos, bucket: "other-synthetic-123456" },
      };
      await expect(
        applyPilotImport(
          requirePool(),
          bundleDirectory,
          changedCos,
          prepared.dryRun,
          {
            ...approval,
            targetScopeSha256: pilotScopeSha256(changedCos),
          },
          allocator,
        ),
      ).rejects.toThrow(/target|scope/i);
      const counts = await requirePool().query(
        "SELECT (SELECT count(*)::int FROM catalog_entries) AS catalogs, (SELECT count(*)::int FROM catalog_import_operations) AS operations",
      );
      expect(counts.rows[0]).toEqual({ catalogs: 3, operations: 1 });
    });

    it("keeps verified upload after registration failure and retries without duplicate media", async () => {
      const storage = transport();
      await requirePool()
        .query(`CREATE FUNCTION synthetic_fail_first_media() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.media_id='media_00000000000000000000000000000001' THEN RAISE EXCEPTION 'synthetic registration failure'; END IF;
      RETURN NEW; END $$`);
      await requirePool().query(
        "CREATE TRIGGER synthetic_registration_failure BEFORE INSERT ON catalog_media FOR EACH ROW EXECUTE FUNCTION synthetic_fail_first_media()",
      );
      const input = {
        pool: requirePool(),
        scope,
        approval,
        manifestFile,
        photoRoot,
        transport: storage,
      };
      try {
        const first = await syncPilotMedia(input);
        expect(first[0]).toMatchObject({
          upload: "uploaded",
          registration: "failed",
          stage: "registration",
          errorCode: "REGISTRATION_FAILED",
        });
        expect(JSON.stringify(first)).not.toContain(
          "synthetic registration failure",
        );
        expect(
          first.filter((result) => result.registration === "created"),
        ).toHaveLength(19);
        expect(storage.objects.size).toBe(20);
        expect(
          (
            await requirePool().query(
              "SELECT count(*)::int AS total FROM catalog_media",
            )
          ).rows[0].total,
        ).toBe(19);
      } finally {
        await requirePool().query(
          "DROP TRIGGER synthetic_registration_failure ON catalog_media",
        );
        await requirePool().query("DROP FUNCTION synthetic_fail_first_media()");
      }
      const retry = await syncPilotMedia(input);
      expect(retry.every((result) => result.upload === "reused")).toBe(true);
      expect(retry[0]).toMatchObject({ registration: "created" });
      expect(
        retry.filter((result) => result.registration === "reused"),
      ).toHaveLength(19);
      const replay = await syncPilotMedia(input);
      expect(replay.every((result) => result.registration === "reused")).toBe(
        true,
      );
      expect(
        (
          await requirePool().query(
            "SELECT count(*)::int AS total FROM catalog_media",
          )
        ).rows[0].total,
      ).toBe(20);
    });

    it("does not register a cloud conflict or overwrite the conflicting remote bytes", async () => {
      const storage = transport();
      const first = rows[0]!;
      const conflict = Buffer.from(
        "synthetic existing object with different bytes",
      );
      storage.objects.set(first.objectKey, conflict);
      const results = await syncPilotMedia({
        pool: requirePool(),
        scope,
        approval,
        manifestFile,
        photoRoot,
        transport: storage,
      });
      expect(results[0]).toMatchObject({
        upload: "unverified",
        registration: "failed",
        stage: "verification",
        errorCode: "REMOTE_VERIFICATION_FAILED",
      });
      expect(JSON.stringify(results)).not.toContain(
        "Synthetic remote conflict",
      );
      expect(storage.objects.get(first.objectKey)).toEqual(conflict);
      const persisted = await requirePool().query(
        "SELECT media_id FROM catalog_media WHERE media_id=$1",
        [first.mediaId],
      );
      expect(persisted.rows).toEqual([]);
      expect(
        results.filter((result) => result.registration === "created"),
      ).toHaveLength(19);
    });

    it("rejects false remote verification and leaves the database without that media", async () => {
      const storage = transport();
      const falseVerification: PilotMediaTransport = {
        async ensureObject(key, bytes) {
          return {
            ...(await storage.ensureObject(key, bytes)),
            sha256: "f".repeat(64),
          };
        },
      };
      const results = await syncPilotMedia({
        pool: requirePool(),
        scope,
        approval,
        manifestFile,
        photoRoot,
        transport: falseVerification,
      });
      expect(results.every((result) => result.registration === "failed")).toBe(
        true,
      );
      expect(
        results.every(
          (result) =>
            result.stage === "verification" &&
            result.errorCode === "REMOTE_VERIFICATION_FAILED",
        ),
      ).toBe(true);
      expect(
        (
          await requirePool().query(
            "SELECT count(*)::int AS total FROM catalog_media",
          )
        ).rows[0].total,
      ).toBe(0);
      const client = await requirePool().connect();
      try {
        await assertPilotDatabase(client, scope);
      } finally {
        client.release();
      }
    });

    it("rejects a manifest-external row on a Pilot Catalog before any upload", async () => {
      const storage = transport();
      const catalogId = applied.catalogIdMap[0]!.catalogId;
      await requirePool().query(
        "INSERT INTO catalog_media(media_id,catalog_id,position,is_representative,kind,alt_text,width,height,object_key) VALUES($1,$2,99,false,'image','Synthetic pre-existing media',1,1,'display/v1/synthetic-unrelated.webp')",
        ["media_ffffffffffffffffffffffffffffffff", catalogId],
      );
      await expect(
        syncPilotMedia({
          pool: requirePool(),
          scope,
          approval,
          manifestFile,
          photoRoot,
          transport: storage,
        }),
      ).rejects.toThrow("Existing Pilot media conflicts with frozen scope");
      expect(storage.ensureObject).not.toHaveBeenCalled();
      const existing = await requirePool().query(
        "SELECT media_id,position FROM catalog_media",
      );
      expect(existing.rows).toEqual([
        { media_id: "media_ffffffffffffffffffffffffffffffff", position: 99 },
      ]);
    });

    it("rejects an object key already registered to another Catalog before any upload", async () => {
      const storage = transport();
      const otherId = "catalog-synthetic-outside-scope";
      await requirePool().query(
        "INSERT INTO catalog_entries(catalog_id,kind,title) VALUES($1,'inscription','Synthetic outside scope')",
        [otherId],
      );
      try {
        await requirePool().query(
          "INSERT INTO catalog_media(media_id,catalog_id,position,is_representative,kind,alt_text,width,height,object_key) VALUES($1,$2,0,true,'image','Synthetic conflicting key',1,1,$3)",
          [
            "media_eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
            otherId,
            rows[0]!.objectKey,
          ],
        );
        await expect(
          syncPilotMedia({
            pool: requirePool(),
            scope,
            approval,
            manifestFile,
            photoRoot,
            transport: storage,
          }),
        ).rejects.toThrow("Existing Pilot media conflicts with frozen scope");
        expect(storage.ensureObject).not.toHaveBeenCalled();
        const persisted = await requirePool().query(
          "SELECT catalog_id,object_key FROM catalog_media",
        );
        expect(persisted.rows).toEqual([
          { catalog_id: otherId, object_key: rows[0]!.objectKey },
        ]);
      } finally {
        await requirePool().query(
          "DELETE FROM catalog_entries WHERE catalog_id=$1",
          [otherId],
        );
      }
    });

    it("reads persisted Pilot media through the actual production composition and HTTP boundary", async () => {
      if (!directory || !databaseUrl)
        throw new Error("Synthetic input fixture missing");
      const storage = transport();
      const registrations = await syncPilotMedia({
        pool: requirePool(),
        scope,
        approval,
        manifestFile,
        photoRoot,
        transport: storage,
      });
      expect(
        registrations.every((result) => result.registration === "created"),
      ).toBe(true);
      const scopeFile = path.join(directory, "runtime-scope.json");
      await writeFile(scopeFile, JSON.stringify(scope));
      const isolated = new URL(databaseUrl);
      isolated.pathname = `/${database}`;
      const originalSecret = "synthetic-cos-secret-never-used-outside-test";
      const refreshedSecret =
        "synthetic-refreshed-cos-secret-never-used-outside-test";
      const environment = {
        NODE_ENV: "production",
        HOST: "127.0.0.1",
        PORT: "3001",
        PRODUCT_ACCESS_MODE: "public",
        DATABASE_URL: isolated.toString(),
        APP_DATABASE_URL: isolated.toString(),
        MOYA_PILOT_SCOPE_FILE: scopeFile,
        MOYA_PILOT_MEDIA_FILE: manifestFile,
        COS_SECRET_ID: "synthetic_signing_id",
        COS_SECRET_KEY: originalSecret,
      };
      // Resolver composition signs locally. No synthetic COS request may escape
      // this test; the only actual HTTP requests below use its own loopback port.
      const unexpectedCloudRequest = vi
        .spyOn(https, "request")
        .mockImplementation(() => {
          throw new Error(
            "Cloud requests are forbidden in this synthetic composition test",
          );
        });
      syncBuiltinESMExports();
      let backend: Awaited<ReturnType<typeof startBackendProcess>> | undefined;
      try {
        expect(requestHttps).toBe(unexpectedCloudRequest);
        const runtime = await prepareProductionBackend(environment);
        backend = await startBackendProcess({
          closeResources: runtime.closeResources,
          listen: { host: "127.0.0.1", port: 0 },
          requestListener: runtime.requestListener,
        });
        const origin = `http://127.0.0.1:${backend.address.port}`;
        const listResponse = await fetch(
          `${origin}/v1/catalog?page=1&pageSize=100`,
        );
        expect(listResponse.status).toBe(200);
        expect(listResponse.headers.get("cache-control")).toBe("no-store");
        const page = catalogPageSchema.parse(await listResponse.json());
        expect(page.total).toBe(3);
        expect(page.items.map((item) => item.id).sort()).toEqual(
          applied.catalogIdMap.map((item) => item.catalogId).sort(),
        );
        const firstSignatures = new Map<string, string>();
        const privateFields = new Set([
          "objectKey",
          "object_key",
          "sourceId",
          "source_id",
          "bucket",
          "region",
          "relativePath",
          "secretId",
          "secretKey",
          "password",
        ]);
        const assertPublicFields = (value: unknown): void => {
          if (Array.isArray(value)) {
            value.forEach(assertPublicFields);
            return;
          }
          if (value && typeof value === "object") {
            for (const [key, nested] of Object.entries(value)) {
              expect(privateFields.has(key)).toBe(false);
              assertPublicFields(nested);
            }
          }
        };
        for (const mapping of applied.catalogIdMap) {
          const expectedRows = rows
            .filter((row) => row.catalogImportId === mapping.catalogImportId)
            .sort((a, b) => a.position - b.position);
          const detailResponse = await fetch(
            `${origin}/v1/catalog/${mapping.catalogId}`,
          );
          expect(detailResponse.status).toBe(200);
          expect(detailResponse.headers.get("cache-control")).toBe("no-store");
          const wireText = await detailResponse.text();
          const wire: unknown = JSON.parse(wireText);
          assertPublicFields(wire);
          expect(wireText).not.toContain(originalSecret);
          expect(wireText).not.toContain(refreshedSecret);
          for (const catalog of scope.catalogs)
            expect(wireText).not.toContain(catalog.sourceId);
          const detail = catalogDetailSchema.parse(wire);
          expect(detail.id).toBe(mapping.catalogId);
          expect(detail.description).toBe("Synthetic persisted description");
          expect(detail.media.map((media) => media.id)).toEqual(
            expectedRows.map((row) => row.mediaId),
          );
          expect(detail.representativeMedia?.id).toBe(
            expectedRows.find((row) => row.isRepresentative)?.mediaId,
          );
          expect(
            page.items.find((item) => item.id === detail.id)
              ?.representativeMedia?.id,
          ).toBe(detail.representativeMedia?.id);
          for (const [index, media] of detail.media.entries()) {
            const expected = expectedRows[index]!;
            expect(media).toMatchObject({
              kind: "image",
              alt: expected.altText,
              width: 1,
              height: 1,
            });
            const image = new URL(media.src);
            expect(image.origin).toBe(scope.cos.mediaOrigin);
            // Object keys are allowed inside a derived URL, never as a private
            // DTO field or as storage-provider configuration in the response.
            expect(decodeURIComponent(image.pathname)).toBe(
              `/${expected.objectKey}`,
            );
            expect(image.searchParams.get("q-sign-algorithm")).toBe("sha1");
            const signature = image.searchParams.get("q-signature");
            expect(signature).toMatch(/^[a-f0-9]{40}$/);
            firstSignatures.set(media.id, signature!);
            const [startsAt, expiresAt] = image.searchParams
              .get("q-sign-time")!
              .split(";")
              .map(Number);
            const now = Math.floor(Date.now() / 1000);
            expect(startsAt).toBeLessThanOrEqual(now);
            expect(expiresAt).toBeGreaterThan(now);
            expect(expiresAt! - startsAt!).toBeLessThanOrEqual(600);
          }
        }
        expect(firstSignatures.size).toBe(20);
        // A second HTTP read must resolve again, rather than return a stored or
        // cached URL. Rotating only this fixture's synthetic signer is deterministic.
        environment.COS_SECRET_KEY = refreshedSecret;
        for (const mapping of applied.catalogIdMap) {
          const response = await fetch(
            `${origin}/v1/catalog/${mapping.catalogId}`,
          );
          expect(response.status).toBe(200);
          expect(response.headers.get("cache-control")).toBe("no-store");
          const refreshed = catalogDetailSchema.parse(await response.json());
          for (const media of refreshed.media) {
            expect(new URL(media.src).searchParams.get("q-signature")).not.toBe(
              firstSignatures.get(media.id),
            );
          }
        }
        expect(unexpectedCloudRequest).not.toHaveBeenCalled();
      } finally {
        await backend?.shutdown();
        unexpectedCloudRequest.mockRestore();
        syncBuiltinESMExports();
      }
    });
  },
);

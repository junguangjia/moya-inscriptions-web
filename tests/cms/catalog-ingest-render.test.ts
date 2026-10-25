import { createHash, randomUUID } from "node:crypto";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
} from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  currentCatalogRecipePolicy,
  readCatalogSourceSnapshot,
} from "@moya/backend-production/internal/catalog-delivery";
import { LocalCatalogSourceReader } from "@moya/backend-production/internal/catalog-source";
import {
  createCatalogRenderer,
  createCatalogSync,
} from "@moya/backend-production/internal/publishing-catalog";
import { createPublishingJobHandlers } from "@moya/backend-production/internal/publishing-job-handlers";
import { FilesystemPublishingMediaStore } from "@moya/backend-production/internal/publishing-media-store";
import {
  currentRecipe,
  plannedStillSize,
} from "@moya/backend-production/internal/publishing-processing";
import {
  createSandboxRunner,
  defaultSandboxAppDist,
} from "@moya/backend-production/internal/publishing-sandbox";
import { PublishingWorker } from "@moya/backend-production/internal/publishing-worker";
import {
  handleOperatorRequest,
  type OperatorRouteDependencies,
} from "@moya/backend-runtime/internal/community-operator";
import {
  createPostgresPool,
  parsePostgresConfig,
} from "@moya/catalog-postgres";
import {
  PostgresWorkPublishingAdapter,
  runCommunityMigrations,
} from "@moya/community-postgres";
import {
  EDITORIAL_STATEFUL_FIELDS,
  MAX_MEDIA_UPLOAD_BYTES,
  editorialDraftSchema,
  editorialMediaIngestCompleteResultSchema,
  editorialMediaIngestStartResultSchema,
} from "@moya/contracts/internal/editorial";
import {
  createLocalReq,
  getPayload,
  handleEndpoints,
  type TypedUser,
} from "payload";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { saveDraft } from "admin/editorial";
import { selectedMediaSnapshot } from "admin/media-snapshot";

import { assertSyntheticTestDatabaseUrl } from "../integration/postgres/synthetic-test-database.js";

/*
 * catalog-scale-v1 increment 2, slice S5b (I-AC7): one Catalog original over
 * 40 MiB through the Development chain, from ingest to recorded renditions.
 * Opt-in (CATALOG_INGEST_RENDER_E2E=1), never in CI: besides the synthetic
 * CMS target every CMS test uses, it needs a disposable synthetic App
 * database (CATALOG_INGEST_RENDER_E2E_APP_DATABASE_URL, migrated here),
 * Docker and the local media sandbox image (`pnpm dev:media-sandbox`).
 * docs/development/catalog-scale-bench.md has the command.
 *
 * 1. Ingest into the Development store (CMS_CATALOG_INGEST=on,
 *    CMS_STORAGE_MODE=local): start and complete go through the Codex
 *    library's Admin client (scripts/editorial/direct-ingest.mjs) to the
 *    composed routes. The library sends original bytes only to an https COS
 *    host, and refuses the Development store's loopback PUT URL, so this test
 *    sends that one PUT itself, with exactly the signed headers.
 * 2. Prepare through the real Admin route, with the current recipe policy
 *    from a loopback operator boundary running the real operator handler.
 * 3. One worker Catalog sync reads the CMS's published and private prepare
 *    views into the App database. The snapshot is narrowed to this record,
 *    so other CMS tests' rows in the shared task database stay out.
 * 4. The publishing worker claims the catalog_render job and renders in the
 *    real sandbox container from the Development media directory, after the
 *    Development source reader checks the bytes against the key's SHA-256.
 */

const enabled =
  process.env.CATALOG_INGEST_RENDER_E2E === "1" &&
  Boolean(process.env.CMS_DATABASE_URL);
const IMAGE =
  process.env.CATALOG_INGEST_RENDER_E2E_IMAGE ??
  "yoyi-work-publishing-media-tools:v2";
/** The Development store's PUT origin; requests never leave this process. */
const ADMIN_ORIGIN = "http://127.0.0.1:3002";
const migrationsDirectory = path.join(
  fileURLToPath(new URL("../../", import.meta.url)),
  "database",
  "community-migrations",
);

const run = randomUUID();
const catalogId = `synthetic-ingest-render-${run}`;
const mediaId = `ingest-render-${run}`;
const sha256 = (value: string | Uint8Array) =>
  createHash("sha256").update(value).digest("hex");

type Fetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;
type Send = (
  route: string,
  method: string,
  body: unknown,
) => Promise<{
  ok: boolean;
  httpStatus?: number;
  code?: string;
  result?: { ok?: boolean; result?: unknown };
}>;

/**
 * A synthetic 9,504 x 6,336 JPEG over 40 MiB: banded texture plus seeded
 * noise at quality 95 with full-resolution chroma.
 */
const largeOriginal = async () => {
  const width = 9_504;
  const height = 6_336;
  const pixels = Buffer.alloc(width * height * 3);
  let state = 0x2545f491;
  let offset = 0;
  for (let y = 0; y < height; y += 1)
    for (let x = 0; x < width; x += 1) {
      state ^= state << 13;
      state ^= state >>> 17;
      state ^= state << 5;
      const value =
        110 +
        60 * Math.sin(x / 37) * Math.cos(y / 41) +
        ((state >>> 0) / 4294967296 - 0.5) * 192;
      for (let channel = 0; channel < 3; channel += 1)
        pixels[offset++] = Math.max(0, Math.min(255, value + channel * 9));
    }
  const bytes = await sharp(pixels, { raw: { width, height, channels: 3 } })
    .jpeg({ quality: 95, chromaSubsampling: "4:4:4" })
    .toBuffer();
  return { bytes, width, height };
};

describe.skipIf(!enabled)(
  "Development e2e: ingest over 40 MiB, prepare, sync and sandbox render (S5b)",
  () => {
    let payload: Awaited<ReturnType<typeof getPayload>>;
    let config: Awaited<typeof import("admin/config")>["default"];
    let owner: TypedUser;
    let ownerSession: string;
    let appPool: ReturnType<typeof createPostgresPool>;
    let base: string;
    let closeOperator: () => Promise<void>;

    beforeAll(async () => {
      if (
        process.env.CMS_ENVIRONMENT !== "synthetic" ||
        process.env.CMS_STORAGE_MODE !== "local" ||
        !process.env.CMS_MEDIA_DIR
      )
        throw new Error("Task-owned synthetic local CMS required");
      const appUrl = process.env.CATALOG_INGEST_RENDER_E2E_APP_DATABASE_URL;
      if (!appUrl)
        throw new Error("CATALOG_INGEST_RENDER_E2E_APP_DATABASE_URL required");
      assertSyntheticTestDatabaseUrl(
        appUrl,
        "CATALOG_INGEST_RENDER_E2E_APP_DATABASE_URL",
      );
      // The real operator handler pins the current recipe policy on prepare.
      const credential = randomUUID();
      const server = createServer((request, response) => {
        void handleOperatorRequest(
          request,
          response,
          new URL(request.url!, "http://127.0.0.1").pathname,
          {
            moderationService: {},
            operatorCredential: credential,
            catalogRecipePolicy: async () => currentCatalogRecipePolicy(),
          } as unknown as OperatorRouteDependencies,
        );
      });
      await new Promise<void>((resolve) =>
        server.listen(0, "127.0.0.1", resolve),
      );
      const address = server.address();
      if (!address || typeof address === "string")
        throw new Error("Synthetic operator address missing");
      closeOperator = () =>
        new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        );
      vi.stubEnv(
        "COMMUNITY_OPERATOR_BASE_URL",
        `http://127.0.0.1:${address.port}`,
      );
      vi.stubEnv("COMMUNITY_OPERATOR_TOKEN", credential);
      vi.stubEnv("CMS_CATALOG_INGEST", "on");
      vi.stubEnv("CMS_CATALOG_INGEST_UPLOAD_ENDPOINT", ADMIN_ORIGIN);
      config = (await import("admin/config")).default;
      payload = await getPayload({ config });
      const password = randomUUID();
      owner = await payload.create({
        collection: "users",
        overrideAccess: true,
        data: {
          email: `ingest-render-owner-${run}@example.invalid`,
          password,
          role: "owner",
        },
      });
      ownerSession = (
        await payload.login({
          collection: "users",
          data: { email: owner.email, password },
        })
      ).token!;
      appPool = createPostgresPool(
        parsePostgresConfig({ DATABASE_URL: appUrl }),
      );
      await runCommunityMigrations(appPool, migrationsDirectory);
      base = await realpath(
        await mkdtemp(path.join(tmpdir(), "catalog-ingest-render-")),
      );
      await chmod(base, 0o700);
    }, 300_000);

    afterAll(async () => {
      await payload?.destroy();
      await appPool?.end();
      await closeOperator?.();
      vi.unstubAllEnvs();
      if (base) await rm(base, { recursive: true, force: true });
    });

    it("renders an ingested 9,504 x 6,336 original over 40 MiB to every Catalog rendition", async () => {
      const reqFor = () => createLocalReq({ user: owner }, payload);
      const { bytes, width, height } = await largeOriginal();
      expect(bytes.length).toBeGreaterThan(MAX_MEDIA_UPLOAD_BYTES);
      const digest = sha256(bytes);

      // 1. Ingest: the library's Admin client against the composed routes.
      const library = (await import(
        new URL("../../scripts/editorial/direct-ingest.mjs", import.meta.url)
          .href
      )) as {
        createAdminSend: (
          config: Record<string, unknown>,
          options: { fetchImpl: Fetch },
        ) => Send;
        createCosClient: (options: { hostSuffix: string }) => {
          putObject: (request: {
            url: string;
            headers: Record<string, string>;
            body: Uint8Array;
          }) => Promise<{ ok: boolean; code?: string }>;
        };
      };
      const adminRequests: string[] = [];
      const send = library.createAdminSend(
        { baseURL: ADMIN_ORIGIN, sessionToken: ownerSession },
        {
          fetchImpl: async (input, init = {}) => {
            const route = new URL(String(input)).pathname;
            adminRequests.push(route);
            const response = await handleEndpoints({
              config,
              request: new Request(`${ADMIN_ORIGIN}${route}`, {
                method: init.method ?? "POST",
                headers: new Headers(init.headers),
                body: typeof init.body === "string" ? init.body : "",
              }),
            });
            return new Response(await response.text(), {
              status: response.status,
              headers: { "content-type": "application/json" },
            });
          },
        },
      );
      const intent = {
        transferId: sha256(`transfer:${run}`),
        catalogId,
        mediaId,
        sha256: digest,
        bytes: bytes.length,
        mimeType: "image/jpeg" as const,
        md5Base64: createHash("md5").update(bytes).digest("base64"),
        alt: "Synthetic ingested original",
        rights: "Synthetic fixture",
        orderConfidence: "HIGH" as const,
        width,
        height,
      };
      const started = await send(
        "/api/editorial/media-ingest/start",
        "POST",
        intent,
      );
      expect(started.ok, started.code).toBe(true);
      const grant = editorialMediaIngestStartResultSchema.parse(
        started.result?.result,
      );
      if (grant.state !== "upload") throw new Error("Expected an upload");
      // Exactly the signed headers (L2: no staging tag).
      const signed = Object.fromEntries(
        Object.entries(grant.upload.headers).filter(
          (entry): entry is [string, string] => entry[1] !== undefined,
        ),
      );
      const target = new URL(grant.upload.url);
      expect(target.origin).toBe(ADMIN_ORIGIN);
      expect(target.pathname).toBe(
        `/api/editorial/media-ingest/dev-put/${grant.ingestId}`,
      );
      // The library's COS client never sends original bytes to this URL.
      expect(
        await library
          .createCosClient({ hostSuffix: "cos.dev.example.test" })
          .putObject({
            url: grant.upload.url,
            headers: signed,
            body: bytes,
          }),
      ).toEqual({ ok: false, status: 0, code: "COS_TARGET_REFUSED" });
      const put = await handleEndpoints({
        config,
        request: new Request(grant.upload.url, {
          method: "PUT",
          headers: signed,
          body: new Uint8Array(bytes),
        }),
      });
      expect(put.status).toBe(200);
      const completed = await send(
        "/api/editorial/media-ingest/complete",
        "POST",
        { intent },
      );
      expect(completed.ok, completed.code).toBe(true);
      const registered = editorialMediaIngestCompleteResultSchema.parse(
        completed.result?.result,
      );
      expect(registered).toMatchObject({
        reused: false,
        width,
        height,
        media: {
          mediaId,
          catalogId,
          sha256: digest,
          filesize: bytes.length,
          width,
          height,
          objectKey: `editorial/${sha256(catalogId)}/${sha256(mediaId)}-${digest}.jpg`,
        },
      });
      expect(adminRequests).toEqual([
        "/api/editorial/media-ingest/start",
        "/api/editorial/media-ingest/complete",
      ]);
      const filename = registered.media.objectKey.split("/").at(-1)!;
      expect(
        sha256(await readFile(path.join(process.env.CMS_MEDIA_DIR!, filename))),
      ).toBe(digest);

      // 2. A published record, a draft that adds the original, and prepare.
      const content = editorialDraftSchema.parse({
        catalogId,
        sourceId: `${catalogId}-source`,
        kind: "calligraphy",
        title: "Synthetic ingest render A",
        summary: "Synthetic summary",
        ...Object.fromEntries(
          EDITORIAL_STATEFUL_FIELDS.map((name) => [
            name,
            { state: "UNSUPPLIED" },
          ]),
        ),
        media: [],
      });
      const saved = await saveDraft(await reqFor(), {
        idempotencyKey: `${catalogId}:A`,
        content,
      });
      const primary = await payload.update({
        collection: "catalogs",
        id: saved.id,
        req: await reqFor(),
        overrideAccess: false,
        data: { revision: saved.revision, _status: "published" },
      });
      const media = (
        await payload.find({
          collection: "media",
          where: { mediaId: { equals: mediaId } },
          req: await reqFor(),
          overrideAccess: false,
          limit: 1,
        })
      ).docs[0]!;
      const draft = await saveDraft(await reqFor(), {
        id: saved.id,
        expectedRevision: Number(primary.revision),
        idempotencyKey: `${catalogId}:B`,
        content: {
          ...content,
          title: "Synthetic ingest render B",
          media: [selectedMediaSnapshot({ ...media }, catalogId, [])!],
        },
      });
      const prepared = await handleEndpoints({
        config,
        request: new Request(
          `${ADMIN_ORIGIN}/api/editorial/prepare-catalog-delivery`,
          {
            method: "POST",
            headers: {
              "content-type": "application/json",
              authorization: `JWT ${ownerSession}`,
            },
            body: JSON.stringify({
              id: draft.id,
              expectedRevision: draft.revision,
              expectedFingerprint: draft.fingerprint,
              idempotencyKey: `${catalogId}:prepare`,
            }),
          },
        ),
      });
      expect(prepared.status).toBe(200);
      const intentResult = (
        (await prepared.json()) as { result: Record<string, unknown> }
      ).result;
      expect(intentResult).toMatchObject({
        state: "prepared",
        mediaCount: 1,
        readiness: "PENDING",
        recipeManifestSha256: currentCatalogRecipePolicy().recipeManifestSha256,
      });

      // 3. One worker Catalog sync, narrowed to this record.
      const works = new PostgresWorkPublishingAdapter(appPool, {
        publication: { allowPublish: () => true, isPublic: () => true },
      });
      const cms = payload.db.pool as unknown as Parameters<
        typeof readCatalogSourceSnapshot
      >[0];
      const syncLog = { info: vi.fn(), error: vi.fn() };
      await createCatalogSync({
        listSources: () => Promise.resolve([]),
        readSnapshot: async () => {
          const snapshot = await readCatalogSourceSnapshot(cms, cms);
          if (snapshot === null) return null;
          return {
            ...snapshot,
            sources: snapshot.sources.filter(
              (source) => source.mediaId === mediaId,
            ),
            publishedSources: snapshot.publishedSources.filter(
              (source) => source.mediaId === mediaId,
            ),
            preparations: (snapshot.preparations ?? []).filter(
              (preparation) => preparation.catalogId === catalogId,
            ),
          };
        },
        port: works,
        logger: syncLog,
      }).run(new Date());
      expect(syncLog.error).not.toHaveBeenCalled();
      const asset = (
        await appPool.query<{ id: string; source_sha256: string }>(
          "SELECT id, source_sha256 FROM community.catalog_media_assets WHERE media_id = $1",
          [mediaId],
        )
      ).rows;
      expect(asset).toEqual([
        { id: expect.any(String), source_sha256: digest },
      ]);
      const assetId = asset[0]!.id;

      // 4. The worker renders in the sandbox container and records the set.
      const directories = ["store", "work"].map((name) =>
        path.join(base, name),
      );
      for (const directory of directories)
        await mkdir(directory, { mode: 0o700 });
      const [storeDirectory, workDirectory] = directories as [string, string];
      const store = await FilesystemPublishingMediaStore.open(storeDirectory, {
        temporaryRoots: [],
      });
      const silent = {
        info: () => undefined,
        warn: () => undefined,
        error: () => undefined,
      };
      const renderErrors: string[] = [];
      const worker = new PublishingWorker({
        port: works,
        handlers: createPublishingJobHandlers({
          port: works,
          store,
          catalog: {
            port: works,
            renderer: createCatalogRenderer({
              store,
              sandbox: await createSandboxRunner({
                image: IMAGE,
                workDirectory,
                appDist: defaultSandboxAppDist().appDist,
                temporaryRoots: [],
              }),
              source: new LocalCatalogSourceReader(process.env.CMS_MEDIA_DIR!),
              logger: { error: (line) => renderErrors.push(line) },
            }),
          },
          logger: silent,
        }),
        owner: `catalog-ingest-render-${run}`,
        kinds: ["catalog_render"],
        maintenance: false,
        concurrency: 1,
        pollIntervalMs: 200,
        logger: silent,
      });
      worker.start();
      try {
        await vi.waitFor(
          async () => {
            const jobs = (
              await appPool.query<{ state: string; last_error_code: string }>(
                "SELECT state, last_error_code FROM community.publishing_jobs WHERE kind = 'catalog_render' AND subject_id = $1",
                [assetId],
              )
            ).rows;
            expect(jobs).toEqual([
              { state: "succeeded", last_error_code: null },
            ]);
          },
          { timeout: 240_000, interval: 500 },
        );
      } finally {
        await worker.stop();
      }
      expect(renderErrors).toEqual([]);

      const facts = (
        await appPool.query<{
          state: string;
          failure_code: string | null;
          master_sha256: string;
          master_width: number;
          master_height: number;
        }>(
          "SELECT state, failure_code, master_sha256, master_width, master_height FROM community.catalog_media_assets WHERE id = $1",
          [assetId],
        )
      ).rows;
      // The worker hashed the staged source against the key: no
      // source_hash_mismatch, and the master is the ingested original.
      expect(facts).toEqual([
        {
          state: "ready",
          failure_code: null,
          master_sha256: digest,
          master_width: width,
          master_height: height,
        },
      ]);
      const renditions = (
        await appPool.query<{
          role: "thumb" | "cover" | "display" | "viewer";
          state: string;
          width: number;
          height: number;
          recipe_version: number;
          recipe_digest: string;
          storage_key: string;
        }>(
          `SELECT r.role, r.state, r.width, r.height, r.recipe_version, r.recipe_digest, b.storage_key
           FROM community.media_renditions r JOIN community.media_blobs b ON b.id = r.blob_id
           WHERE r.catalog_asset_id = $1 ORDER BY r.role`,
          [assetId],
        )
      ).rows;
      expect(renditions.map(({ role }) => role)).toEqual([
        "cover",
        "display",
        "thumb",
        "viewer",
      ]);
      for (const rendition of renditions) {
        const size = plannedStillSize(
          rendition.role,
          { width, height },
          "catalog",
        )!;
        const recipe = currentRecipe(rendition.role);
        expect(rendition).toMatchObject({
          state: "ready",
          width: size.width,
          height: size.height,
          recipe_version: recipe.version,
          recipe_digest: recipe.digest,
        });
        const read = await store.openRead(rendition.storage_key);
        expect(read?.status).toBe("ok");
        if (read?.status === "ok") await read.close();
      }
    }, 600_000);
  },
);

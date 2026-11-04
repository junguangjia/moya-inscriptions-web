import { randomBytes, randomUUID } from "node:crypto";
import { chmod, mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { OperatorRouteDependencies } from "@moya/backend-runtime/internal/community-operator";
import type { createPostgresPool } from "@moya/catalog-postgres";
import type {
  AdminExecuteData,
  AdminMcpEnvelope,
} from "@moya/contracts/internal/admin-mcp";
import type { PostgresAdapter } from "@payloadcms/db-postgres";
import type { Payload, TypedUser } from "payload";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { assertSyntheticTestDatabaseUrl } from "../integration/postgres/synthetic-test-database.js";
import type { serveRoutes } from "./admin-mcp-wire.js";

/*
 * Matrix rows "Prepare, request-release", "Release delivery" and "Publish record with
 * new images": a record with one new image goes out under an AI key, over real JSON-RPC,
 * with nothing about it stood in for. The readiness answer comes from the real
 * Backend functions over the real App database. One worker sync reads the CMS views,
 * the real worker renders in the sandbox container, and the real publication worker
 * copies to the Development filesystem provider. Only release answers ok:true.
 *
 * Opt-in (ADMIN_MCP_DELIVERY_E2E=1), never in CI: besides the synthetic CMS target
 * every CMS test uses, it needs Docker, the local media sandbox image
 * (`pnpm dev:media-sandbox`) and a disposable empty App database, migrated here
 * (ADMIN_MCP_DELIVERY_E2E_APP_DATABASE_URL).
 */

const enabled = process.env.ADMIN_MCP_DELIVERY_E2E === "1";
const IMAGE =
  process.env.ADMIN_MCP_DELIVERY_E2E_IMAGE ??
  "yoyi-work-publishing-media-tools:v2";
const migrationsDirectory = path.join(
  fileURLToPath(new URL("../../", import.meta.url)),
  "database",
  "community-migrations",
);

const run = randomUUID();
const catalogId = `delivery-e2e-${run}`;
const mediaId = `delivery-e2e-media-${run}`;

// Loaded only when the file runs, so a skipped one costs either CMS step nothing.
const loadModules = async () => ({
  ...(await import("@moya/backend-production/internal/catalog-delivery")),
  ...(await import("@moya/backend-production/internal/catalog-source")),
  ...(await import("@moya/backend-production/internal/publication")),
  ...(await import("@moya/backend-production/internal/publishing-catalog")),
  ...(await import("@moya/backend-production/internal/publishing-job-handlers")),
  ...(await import("@moya/backend-production/internal/publishing-media-store")),
  ...(await import("@moya/backend-production/internal/publishing-sandbox")),
  ...(await import("@moya/backend-production/internal/publishing-worker")),
  ...(await import("@moya/backend-runtime/internal/community-operator")),
  ...(await import("@moya/catalog-postgres")),
  ...(await import("@moya/community-postgres")),
  ...(await import("@moya/contracts/internal/admin-mcp")),
  ...(await import("@payloadcms/db-postgres")),
  ...(await import("payload")),
  sharp: (await import("sharp")).default,
  ...(await import("admin/editorial")),
  ...(await import("admin/media-snapshot")),
  ...(await import("./admin-mcp-wire.js")),
});
let modules: Awaited<ReturnType<typeof loadModules>>;

type Answer = AdminMcpEnvelope & { data: AdminExecuteData };
type Intent = {
  intentId: string;
  state: string;
  stateVersion: number;
  manifestSha256: string;
  readiness: string;
};

describe.skipIf(!enabled)(
  "a record with a new image goes out under an AI key, with a real render",
  () => {
    let payload: Payload;
    let owner: TypedUser;
    let client: Client;
    let server: Awaited<ReturnType<typeof serveRoutes>>;
    let operator: Server;
    let appPool: ReturnType<typeof createPostgresPool>;
    let base: string;

    beforeAll(async () => {
      modules = await loadModules();
      const {
        connectClient,
        createCatalogPublishedRenditions,
        createCatalogReadiness,
        createCatalogRenderBacklog,
        createPostgresPool,
        currentCatalogRecipePolicy,
        getPayload,
        handleOperatorRequest,
        parsePostgresConfig,
        runCommunityMigrations,
        serveRoutes,
      } = modules;
      const appUrl = process.env.ADMIN_MCP_DELIVERY_E2E_APP_DATABASE_URL;
      if (
        process.env.CMS_ENVIRONMENT !== "synthetic" ||
        process.env.CMS_STORAGE_MODE !== "local" ||
        !process.env.CMS_MEDIA_DIR ||
        !appUrl
      )
        throw new Error("A synthetic local CMS and App database are required");
      assertSyntheticTestDatabaseUrl(
        appUrl,
        "ADMIN_MCP_DELIVERY_E2E_APP_DATABASE_URL",
      );
      appPool = createPostgresPool(
        parsePostgresConfig({ DATABASE_URL: appUrl }),
      );
      await runCommunityMigrations(appPool, migrationsDirectory);
      base = await realpath(
        await mkdtemp(path.join(tmpdir(), "admin-mcp-delivery-")),
      );
      await chmod(base, 0o700);

      const config = await (await import("admin/config")).default;
      payload = await getPayload({ config });
      const cms = payload.db.pool as unknown as Parameters<
        typeof createCatalogReadiness
      >[0];
      const credential = randomUUID();
      operator = createServer((request, response) => {
        void handleOperatorRequest(
          request,
          response,
          new URL(request.url!, "http://127.0.0.1").pathname,
          {
            moderationService: {},
            operatorCredential: credential,
            catalogRecipePolicy: async () => currentCatalogRecipePolicy(),
            catalogDeliveryReadiness: createCatalogReadiness(cms, appPool),
            catalogPublishedRenditions:
              createCatalogPublishedRenditions(appPool),
            catalogRenderBacklog: createCatalogRenderBacklog(appPool),
          } as unknown as OperatorRouteDependencies,
        );
      });
      await new Promise<void>((resolve) =>
        operator.listen(0, "127.0.0.1", resolve),
      );
      vi.stubEnv(
        "COMMUNITY_OPERATOR_BASE_URL",
        `http://127.0.0.1:${(operator.address() as AddressInfo).port}`,
      );
      vi.stubEnv("COMMUNITY_OPERATOR_TOKEN", credential);

      const account = (role: "owner" | "ai_operator") =>
        payload.create({
          collection: "users",
          overrideAccess: true,
          data: {
            email: `delivery-e2e-${role}-${run}@example.invalid`,
            password: randomBytes(24).toString("hex"),
            role,
            scopeCatalogIds: [],
          } as never,
        });
      owner = await account("owner");
      const aiUser = await account("ai_operator");
      const secret = randomBytes(32).toString("hex");
      await payload.create({
        collection: "payload-mcp-api-keys",
        overrideAccess: true,
        data: {
          user: aiUser.id,
          label: "synthetic-delivery-e2e",
          enableAPIKey: true,
          apiKey: secret,
          toolProfile: "operate",
        } as never,
      });
      server = await serveRoutes(config);
      client = (
        await connectClient(server.endpoint, {
          authorization: ["Bearer", secret].join(" "),
        })
      ).client;
    }, 300_000);

    afterAll(async () => {
      await client?.close();
      await server?.close();
      await payload?.destroy();
      await appPool?.end();
      if (operator) {
        operator.closeAllConnections();
        await new Promise((resolve) => operator.close(resolve));
      }
      vi.unstubAllEnvs();
      if (base) await rm(base, { recursive: true, force: true });
    });

    const execute = async (op: string, input: Record<string, unknown>) => {
      const result = await client.callTool({
        name: "admin_execute",
        arguments: { requestId: randomUUID(), op, input },
      });
      return modules.adminMcpEnvelopeSchema.parse(
        result.structuredContent,
      ) as Answer;
    };
    const read = async (op: string, input: Record<string, unknown>) => {
      const result = await client.callTool({
        name: "admin_read",
        arguments: { op, input },
      });
      return modules.adminMcpEnvelopeSchema.parse(result.structuredContent);
    };
    const intentOf = (answer: Answer) =>
      answer.data.results![0] as unknown as Intent;

    it("prepares, renders, requests, copies and releases, and only the release answers ok:true", async () => {
      const {
        createCatalogPublicationAuthority,
        createCatalogRenderer,
        createCatalogSync,
        createLocalReq,
        createPublicationWorkers,
        createPublishingJobHandlers,
        createSandboxRunner,
        defaultSandboxAppDist,
        FilesystemPublishingMediaStore,
        LocalCatalogSourceReader,
        parsePublicationConfig,
        PostgresMediaPublicationAdapter,
        PostgresWorkPublishingAdapter,
        PublishingWorker,
        readCatalogSourceSnapshot,
        saveDraft,
        selectedMediaSnapshot,
        sharp,
        sql,
        syntheticCatalogDraft,
      } = modules;
      const req = () => createLocalReq({ user: owner }, payload);
      const bytes = await sharp({
        create: {
          width: 1_600,
          height: 1_200,
          channels: 3,
          background: { r: 120, g: 110, b: 90 },
        },
      })
        .png()
        .toBuffer();
      const media = await payload.create({
        collection: "media",
        req: await req(),
        overrideAccess: false,
        data: {
          mediaId,
          catalogId,
          origin: "upload",
          objectKey: "",
          sha256: "",
          alt: "Synthetic original",
          rights: "Synthetic fixture",
          orderConfidence: "HIGH",
        },
        file: {
          name: "synthetic.png",
          data: bytes,
          mimetype: "image/png",
          size: bytes.length,
        },
      });
      const draft = await saveDraft(await req(), {
        idempotencyKey: `${run}:draft`,
        content: {
          ...syntheticCatalogDraft(catalogId, `${catalogId}-source`),
          media: [selectedMediaSnapshot({ ...media }, catalogId, [])!],
        },
      });

      const works = new PostgresWorkPublishingAdapter(appPool, {
        publication: { allowPublish: () => true, isPublic: () => true },
      });
      const cms = payload.db.pool as unknown as Parameters<
        typeof readCatalogSourceSnapshot
      >[0];
      const syncLog = { info: vi.fn(), error: vi.fn() };
      const sync = createCatalogSync({
        listSources: () => Promise.resolve([]),
        readSnapshot: async () => {
          const snapshot = await readCatalogSourceSnapshot(cms, cms);
          if (snapshot === null) return null;
          // Other CMS tests' rows in the shared task database stay out.
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
      });

      // Delivery is connected, and a publish cannot get past images with no renditions.
      expect(
        await read("editorial.catalog-delivery-capabilities", {}),
      ).toMatchObject({ ok: true, data: { delivery: "AVAILABLE" } });
      expect(
        await execute("catalog.publish", {
          id: draft.id,
          expected: {
            revision: draft.revision,
            fingerprint: draft.fingerprint,
          },
        }),
      ).toMatchObject({
        ok: false,
        code: "CATALOG_DELIVERY_PREPARATION_REQUIRED",
      });

      const prepared = await execute("editorial.prepare-catalog-delivery", {
        id: draft.id,
        expectedRevision: draft.revision,
        expectedFingerprint: draft.fingerprint,
      });
      expect(prepared).toMatchObject({
        ok: false,
        code: "QUEUED",
        state: "prepared",
      });
      const intent = intentOf(prepared);
      const readiness = async () =>
        (
          (
            await read("editorial.read-catalog-delivery", {
              intentId: intent.intentId,
            })
          ).data as Intent
        ).readiness;
      expect(await readiness()).toBe("PENDING");

      // The real worker, rendering in the sandbox container.
      const directories = ["store", "work", "published"].map((name) =>
        path.join(base, name),
      );
      for (const directory of directories)
        await mkdir(directory, { mode: 0o700 });
      const [storeDirectory, workDirectory, publishedDirectory] =
        directories as [string, string, string];
      const store = await FilesystemPublishingMediaStore.open(storeDirectory, {
        temporaryRoots: [],
      });
      const silent = {
        info: () => undefined,
        warn: () => undefined,
        error: () => undefined,
      };
      const renderErrors: string[] = [];
      const renderer = new PublishingWorker({
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
        owner: `admin-mcp-delivery-${run}`,
        kinds: ["catalog_render"],
        maintenance: false,
        concurrency: 1,
        pollIntervalMs: 200,
        logger: silent,
      });
      const publicationConfig = parsePublicationConfig(
        {
          MEDIA_PUBLICATION: "on",
          MEDIA_PUBLISHED_ORIGIN: "http://127.0.0.1:9",
          MEDIA_PUBLISHED_LOCAL_ROOT: publishedDirectory,
        },
        "development",
        "public",
      );
      const publicationPort = new PostgresMediaPublicationAdapter(appPool, {
        allowPublish: () => true,
        isPublic: () => true,
        catalogAuthority: createCatalogPublicationAuthority(cms, cms, appPool),
      });
      const publishers = createPublicationWorkers({
        config: publicationConfig,
        port: publicationPort,
        queue: works,
        source: store,
        logger: silent,
      });
      renderer.start();
      for (const worker of publishers) worker.start();
      try {
        await sync.run(new Date());
        const asset = async () =>
          (
            await appPool.query<{ id: string; state: string }>(
              "SELECT id, state FROM community.catalog_media_assets WHERE media_id = $1",
              [mediaId],
            )
          ).rows[0];
        await vi.waitFor(
          async () => expect((await asset())?.state).toBe("ready"),
          { timeout: 120_000, interval: 500 },
        );
        expect(renderErrors).toEqual([]);
        // Rendered and not asked for: nothing is public, and a release is refused.
        expect(await readiness()).toBe("PENDING");
        expect(
          await execute("editorial.release-catalog-delivery", {
            intentId: intent.intentId,
            expectedStateVersion: intent.stateVersion,
            expectedRevision: draft.revision,
            expectedFingerprint: draft.fingerprint,
          }),
        ).toMatchObject({ ok: false, code: "CATALOG_RELEASE_NOT_REQUESTED" });

        const requested = await execute("editorial.request-catalog-release", {
          intentId: intent.intentId,
          expectedStateVersion: intent.stateVersion,
          expectedManifestSha256: intent.manifestSha256,
        });
        expect(requested).toMatchObject({
          ok: false,
          code: "QUEUED",
          state: "release_requested",
        });
        const release = {
          intentId: intent.intentId,
          expectedStateVersion: intentOf(requested).stateVersion,
          expectedRevision: draft.revision,
          expectedFingerprint: draft.fingerprint,
        };
        // Asked for, and the copies are not out yet.
        expect(
          await execute("editorial.release-catalog-delivery", release),
        ).toMatchObject({
          ok: false,
          code: "CATALOG_DELIVERY_PENDING",
          retryable: true,
        });

        await vi.waitFor(
          async () => {
            await sync.run(new Date());
            expect(await readiness()).toBe("READY");
          },
          { timeout: 120_000, interval: 2_000 },
        );
        expect(syncLog.error).not.toHaveBeenCalled();

        const released = await execute(
          "editorial.release-catalog-delivery",
          release,
        );
        expect(released).toMatchObject({ ok: true, code: "OK" });
        expect(intentOf(released).state).toBe("released");
        const live = await payload.findByID({
          collection: "catalogs",
          id: draft.id,
          draft: false,
          depth: 0,
        });
        expect(live._status).toBe("published");
        const { drizzle } = payload.db as unknown as Pick<
          PostgresAdapter,
          "drizzle"
        >;
        const { rows } = await drizzle.execute(
          sql`SELECT 1 FROM catalog_entries WHERE catalog_id = ${catalogId}`,
        );
        expect(rows).toHaveLength(1);
      } finally {
        await renderer.stop();
        for (const worker of publishers) await worker.stop();
      }
    }, 420_000);
  },
);

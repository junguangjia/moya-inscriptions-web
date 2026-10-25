import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// The local template (infra/env/local.env.example) names the media directory
// relative to the Admin workspace, where `pnpm dev:all` and
// `payload migrate` start Admin. Loading the config must accept that value
// and must not depend on the directory, or its parent, existing yet.
const adminDirectory = fileURLToPath(
  new URL("../../../apps/admin/", import.meta.url),
);
const relative = `../../.local/synthetic-media-dir-${randomUUID()}/media`;
const expected = path.resolve(adminDirectory, relative);
const startDirectory = process.cwd();

describe("Admin config with the template's relative CMS_MEDIA_DIR", () => {
  beforeAll(() => {
    vi.stubEnv("CMS_SECRET", "synthetic-config-load-secret");
    vi.stubEnv(
      "CMS_DATABASE_URL",
      "postgresql://synthetic@127.0.0.1:1/moya_synthetic_test",
    );
    vi.stubEnv("CMS_ENVIRONMENT", "synthetic");
    vi.stubEnv("CMS_STORAGE_MODE", "local");
    vi.stubEnv("CMS_MEDIA_DIR", relative);
    process.chdir(adminDirectory);
  });
  afterAll(() => {
    process.chdir(startDirectory);
    vi.unstubAllEnvs();
  });

  it("loads, resolves the directory once from the workspace and defers the upload store", async () => {
    const config = await (await import("admin/config")).default;
    expect(existsSync(path.dirname(expected))).toBe(false);
    const media = config.collections.find(({ slug }) => slug === "media");
    expect(media?.upload && media.upload.staticDir).toBe(expected);
    expect(config.endpoints).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: "/editorial/media-upload/start",
          method: "post",
        }),
      ]),
    );
  }, 60_000);
});

// catalog-scale-v1 increment 2: the Catalog ingest routes exist only with
// CMS_CATALOG_INGEST=on (the gate is the array), loading needs none of the
// ingest settings, and the dev-only PUT route is composed only for the
// Development store, never for a production configuration.
describe("Admin config's Catalog ingest routes", () => {
  const ingestRoutes = async (environment: Record<string, string>) => {
    vi.resetModules();
    vi.stubEnv("CMS_SECRET", "synthetic-config-load-secret");
    vi.stubEnv(
      "CMS_DATABASE_URL",
      "postgresql://synthetic@127.0.0.1:1/moya_synthetic_test",
    );
    vi.stubEnv("CMS_ENVIRONMENT", "synthetic");
    vi.stubEnv("CMS_STORAGE_MODE", "local");
    vi.stubEnv(
      "CMS_MEDIA_DIR",
      path.resolve(adminDirectory, relative.replace(/media$/, "ingest-media")),
    );
    for (const [name, value] of Object.entries(environment))
      vi.stubEnv(name, value);
    const config = await (await import("admin/config")).default;
    return config.endpoints
      .filter(({ path: route }) => route.startsWith("/editorial/media-ingest/"))
      .map(({ method, path: route }) => `${method} ${route}`)
      .sort();
  };
  const cos = {
    CMS_STORAGE_MODE: "cos",
    CMS_COS_ENDPOINT: "https://cos.admin.example.test",
    CMS_COS_REGION: "synthetic-region",
    CMS_COS_BUCKET: "synthetic-ingest-1250000000",
    CMS_COS_ACCESS_KEY_ID: "synthetic-access-key",
    CMS_COS_SECRET_ACCESS_KEY: "synthetic-secret-key",
  };
  const ingest = [
    "post /editorial/media-ingest/abandon",
    "post /editorial/media-ingest/complete",
    "post /editorial/media-ingest/start",
    "post /editorial/media-ingest/verify",
  ];
  afterAll(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("composes none while the switch is absent, blank or off", async () => {
    expect(await ingestRoutes({})).toEqual([]);
    expect(await ingestRoutes({ CMS_CATALOG_INGEST: "" })).toEqual([]);
    expect(await ingestRoutes({ CMS_CATALOG_INGEST: "off" })).toEqual([]);
  }, 60_000);

  it("composes the routes and, for the Development store only, the dev PUT", async () => {
    expect(await ingestRoutes({ CMS_CATALOG_INGEST: "on" })).toEqual([
      ...ingest,
      "put /editorial/media-ingest/dev-put/:ingestId",
    ]);
    expect(await ingestRoutes({ ...cos, CMS_CATALOG_INGEST: "on" })).toEqual(
      ingest,
    );
    expect(
      await ingestRoutes({
        ...cos,
        CMS_CATALOG_INGEST: "on",
        CMS_ENVIRONMENT: "production",
      }),
    ).toEqual(ingest);
    expect(
      await ingestRoutes({
        CMS_CATALOG_INGEST: "on",
        CMS_ENVIRONMENT: "production",
      }),
    ).toEqual(ingest);
  }, 60_000);

  it("refuses to load with an unknown switch value", async () => {
    await expect(ingestRoutes({ CMS_CATALOG_INGEST: "yes" })).rejects.toThrow(
      "CMS_CATALOG_INGEST_INVALID",
    );
  }, 60_000);

  it("loads with CMS_CATALOG_DIRECT_PUBLISH absent, blank, off or on and refuses any other value", async () => {
    for (const value of ["", "off", "on"])
      expect(
        await ingestRoutes({
          CMS_CATALOG_INGEST: "off",
          CMS_CATALOG_DIRECT_PUBLISH: value,
        }),
      ).toEqual([]);
    await expect(
      ingestRoutes({
        CMS_CATALOG_INGEST: "off",
        CMS_CATALOG_DIRECT_PUBLISH: "ON",
      }),
    ).rejects.toThrow("CMS_CATALOG_DIRECT_PUBLISH_INVALID");
  }, 60_000);
});

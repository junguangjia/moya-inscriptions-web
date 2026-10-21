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

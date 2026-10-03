import { randomBytes } from "node:crypto";
import { createPostgresPool } from "@moya/catalog-postgres";
import {
  platformCatalogIdAllocator,
  prepareProductionBackend,
} from "@moya/backend-production";
import { afterEach, describe, expect, it, vi } from "vitest";

const productionEnvironment = {
  HOST: "127.0.0.1",
  NODE_ENV: "production",
  PORT: "3001",
} as const;

describe("production backend composition", () => {
  it("allocates platform-owned CatalogIds without SourceId input", () => {
    const first = platformCatalogIdAllocator.allocateCatalogId();
    const second = platformCatalogIdAllocator.allocateCatalogId();

    expect(first).toMatch(
      /^catalog-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(second).not.toBe(first);
  });

  it("requires production mode before database initialization", async () => {
    await expect(
      prepareProductionBackend({
        ...productionEnvironment,
        NODE_ENV: "test",
      }),
    ).rejects.toThrow("NODE_ENV must be production");
  });

  it("fails safely when DATABASE_URL is missing or invalid", async () => {
    await expect(
      prepareProductionBackend(productionEnvironment),
    ).rejects.toThrow("DATABASE_URL is required");
    await expect(
      prepareProductionBackend({
        ...productionEnvironment,
        DATABASE_URL: "postgresql://secret@private-host",
      }),
    ).rejects.toThrow("DATABASE_URL must be a valid PostgreSQL URL");
  });

  it("requires the separate Community App role before opening any pool", async () => {
    const withCatalog = {
      ...productionEnvironment,
      DATABASE_URL:
        "postgresql://public_reader:synthetic@db.example.invalid:5432/yoyi?sslmode=verify-full",
    };
    await expect(prepareProductionBackend(withCatalog)).rejects.toThrow(
      "APP_DATABASE_URL is required",
    );
    await expect(
      prepareProductionBackend({
        ...withCatalog,
        APP_DATABASE_URL: "postgresql://secret@private-host",
      }),
    ).rejects.toThrow("APP_DATABASE_URL must be a valid PostgreSQL URL");
  });

  it("requires distinct local Backend, Admin and App roles on the loopback yoyi_dev database", async () => {
    const development = {
      HOST: "127.0.0.1",
      NODE_ENV: "development",
      PORT: "3001",
      MOYA_CONTENT_SOURCE: "payload",
      DATABASE_URL: "postgresql://public_role@127.0.0.1:54330/yoyi_dev",
      CMS_DATABASE_URL: "postgresql://cms_role@127.0.0.1:54330/yoyi_dev",
    } as const;
    for (const APP_DATABASE_URL of [
      "postgresql://public_role@127.0.0.1:54330/yoyi_dev",
      "postgresql://app_role@127.0.0.1:54330/other_db",
      "postgresql://app_role@db.example.invalid:5432/yoyi_dev",
      "postgresql://app_role@127.0.0.1:54331/yoyi_dev",
    ])
      await expect(
        prepareProductionBackend({ ...development, APP_DATABASE_URL }),
      ).rejects.toThrow("same loopback yoyi_dev database with different users");
  });
});

// Observe the first persistence boundary. These configuration cases may never
// open a connection, launch media tools or contact a delivery provider.
vi.mock("@moya/catalog-postgres", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@moya/catalog-postgres")>();
  return {
    ...actual,
    createPostgresPool: vi.fn(() => {
      throw Error("UNEXPECTED_POOL_INITIALIZATION");
    }),
  };
});
afterEach(() => {
  vi.clearAllMocks();
});

const enabledAuthEnvironment = () => ({
  ...productionEnvironment,
  AUTH_PUBLIC_ENABLED: "true",
  AUTH_EMAIL_PROVIDER: "tencent-ses",
  AUTH_PHONE_PROVIDER: "disabled",
  AUTH_KEY_VERSION: "1",
  AUTH_LOOKUP_KEY: randomBytes(32).toString("base64"),
  AUTH_ENCRYPTION_KEY: randomBytes(32).toString("base64"),
  AUTH_OTP_KEY: randomBytes(32).toString("base64"),
  TENCENT_SES_ENDPOINT: "https://ses.tencentcloudapi.com",
  TENCENT_SES_REGION: "ap-guangzhou",
  TENCENT_SES_SECRET_ID: randomBytes(16).toString("hex"),
  TENCENT_SES_SECRET_KEY: randomBytes(32).toString("base64"),
  TENCENT_SES_FROM: "synthetic@example.invalid",
  TENCENT_SES_TEMPLATE_ID: "42",
});

describe("Production auth source admission before pools", () => {
  it.each([
    undefined,
    "",
    "SYNTHETIC_TOO_SHORT",
    "x".repeat(129),
    "x".repeat(43) + " ",
  ])(
    "refuses missing/malformed relay proof configuration %#",
    async (credential) => {
      await expect(
        prepareProductionBackend({
          ...enabledAuthEnvironment(),
          AUTH_SOURCE_RELAY_TOKEN: credential,
        }),
      ).rejects.toThrow("AUTH_SOURCE_RELAY_TOKEN");
      expect(createPostgresPool).not.toHaveBeenCalled();
    },
  );
  it("refuses reusing the Owner credential for public auth source forwarding", async () => {
    const credential = randomBytes(32).toString("base64url");
    await expect(
      prepareProductionBackend({
        ...enabledAuthEnvironment(),
        AUTH_SOURCE_RELAY_TOKEN: credential,
        COMMUNITY_OPERATOR_TOKEN: credential,
      }),
    ).rejects.toThrow("must be separate from Owner authority");
    expect(createPostgresPool).not.toHaveBeenCalled();
  });
  it("accepts distinct dedicated relay/Owner configuration and proceeds only to the next configuration gate", async () => {
    await expect(
      prepareProductionBackend({
        ...enabledAuthEnvironment(),
        AUTH_SOURCE_RELAY_TOKEN: randomBytes(32).toString("base64url"),
        COMMUNITY_OPERATOR_TOKEN: randomBytes(32).toString("base64url"),
      }),
    ).rejects.toThrow("DATABASE_URL is required");
    expect(createPostgresPool).not.toHaveBeenCalled();
  });
  it("does not require forwarding credentials while public auth is disabled", async () => {
    await expect(
      prepareProductionBackend({
        ...productionEnvironment,
        AUTH_PUBLIC_ENABLED: "false",
      }),
    ).rejects.toThrow("DATABASE_URL is required");
    expect(createPostgresPool).not.toHaveBeenCalled();
  });
});

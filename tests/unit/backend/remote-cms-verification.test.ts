import { createHash } from "node:crypto";
import { chmod, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { rootCertificates } from "node:tls";
import {
  cmsDatabasePool,
  cmsRemoteSyntheticTarget,
} from "admin/runtime-settings";
import { afterEach, describe, expect, it, vi } from "vitest";

const runner = (await import(
  new URL("../../../scripts/editorial/verify-cms.mjs", import.meta.url).href
)) as {
  syntheticDatabase(
    value: string,
    environment?: Record<string, string>,
  ): string;
  protectedRemoteSyntheticSettings(
    environment: Record<string, string>,
  ): Record<string, string>;
  verifyRemoteSyntheticDatabase(
    environment: Record<string, string>,
    query: (sql: string) => Promise<{ rows: Record<string, unknown>[] }>,
  ): Promise<unknown>;
  createVerificationSession(
    database: string,
    prefix: string,
  ): Promise<{
    env: Record<string, string>;
    directory: string;
    dispose(): Promise<void>;
  }>;
};

const directories: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function fixture(serverVersionNum = 180006) {
  const directory = await mkdtemp(path.join(tmpdir(), "remote-cms-synthetic-"));
  directories.push(directory);
  const caFile = path.join(directory, "public-ca.pem");
  const ca = rootCertificates[0]!;
  await writeFile(caFile, ca, { mode: 0o600 });
  const target = {
    version: 1,
    kind: "p2-r2b-remote-synthetic",
    host: "192.0.2.44",
    port: 5432,
    database: "p2r2b_cms_test_0123456789",
    user: "p2r2b_test_0123456789",
    databaseOid: "12345",
    serverVersionNum,
    caSha256: createHash("sha256").update(ca).digest("hex"),
  };
  const database = `postgresql://${target.user}@${target.host}:${target.port}/${target.database}?sslmode=verify-full`;
  const environment: Record<string, string> = {
    CMS_TEST_CONFIG_FILE: path.join(directory, "synthetic.env"),
    MOYA_CONTENT_SOURCE: "payload",
    CMS_ENVIRONMENT: "synthetic",
    CMS_STORAGE_MODE: "local",
    CMS_DATABASE_URL: database,
    CMS_TEST_DATABASE_URL: database,
    CMS_DATABASE_SSL_CA_FILE: caFile,
    CMS_TEST_REMOTE_TARGET_JSON: JSON.stringify(target),
  };
  const save = () =>
    writeFile(
      environment.CMS_TEST_CONFIG_FILE!,
      Object.entries(environment)
        .filter(([name]) => name !== "CMS_TEST_CONFIG_FILE")
        .map(([name, value]) => `${name}='${value}'`)
        .join("\n") + "\n",
      { mode: 0o600 },
    );
  await save();
  return { directory, environment, target, ca, save };
}

describe("explicit remote synthetic CMS verification", () => {
  it("preserves the default loopback boundary without an explicit protected target", () => {
    const database = "postgresql://synthetic@127.0.0.1/synthetic";
    expect(runner.syntheticDatabase(database, {})).toBe(database);
    expect(() =>
      runner.syntheticDatabase(
        "postgresql://synthetic@192.0.2.44/synthetic",
        {},
      ),
    ).toThrow("LOOPBACK");
    vi.stubEnv("CMS_ENVIRONMENT", "synthetic");
    vi.stubEnv("CMS_TEST_REMOTE_TARGET_JSON", undefined);
    vi.stubEnv(
      "CMS_DATABASE_URL",
      "postgresql://synthetic@192.0.2.44/synthetic?sslmode=verify-full",
    );
    expect(() => cmsDatabasePool()).toThrow("loopback database");
  });

  it("requires the exact protected EnvironmentFile, its permissions and matching process values", async () => {
    const { environment } = await fixture();
    expect(
      runner.syntheticDatabase(environment.CMS_DATABASE_URL!, environment),
    ).toBe(environment.CMS_DATABASE_URL);
    expect(() =>
      runner.protectedRemoteSyntheticSettings({
        ...environment,
        CMS_TEST_REMOTE_TARGET_JSON: "{}",
      }),
    ).toThrow("PROTECTED_CONFIG");
    await chmod(environment.CMS_TEST_CONFIG_FILE!, 0o644);
    expect(() => runner.protectedRemoteSyntheticSettings(environment)).toThrow(
      "PROTECTED_CONFIG",
    );
    await chmod(environment.CMS_TEST_CONFIG_FILE!, 0o600);
    const link = environment.CMS_TEST_CONFIG_FILE + ".link";
    await symlink(environment.CMS_TEST_CONFIG_FILE!, link);
    expect(() =>
      runner.protectedRemoteSyntheticSettings({
        ...environment,
        CMS_TEST_CONFIG_FILE: link,
      }),
    ).toThrow("PROTECTED_CONFIG");
  });

  it.each([
    ["host", "192.0.2.45"],
    ["port", 5433],
    ["database", "p2r2b_cms_test_other"],
    ["user", "p2r2b_test_other"],
    ["serverVersionNum", 180004],
    ["serverVersionNum", 160014],
    ["serverVersionNum", 170006],
    ["caSha256", "0".repeat(64)],
  ])(
    "rejects a mismatched or unapproved record field: %s",
    async (field, value) => {
      const { environment, target } = await fixture();
      expect(() =>
        cmsRemoteSyntheticTarget({
          ...environment,
          CMS_TEST_REMOTE_TARGET_JSON: JSON.stringify({
            ...target,
            [field]: value,
          }),
        }),
      ).toThrow("TARGET_INVALID");
    },
  );

  it.each([
    "",
    "?sslmode=disable",
    "?sslmode=require",
    "?sslmode=verify-ca",
    "?sslmode=verify-full&host=192.0.2.45",
    "?sslmode=verify-full&sslmode=disable",
  ])("rejects TLS downgrade or URL overrides: %s", async (query) => {
    const { environment, save } = await fixture();
    const value = environment.CMS_DATABASE_URL!.split("?")[0] + query;
    environment.CMS_DATABASE_URL = value;
    environment.CMS_TEST_DATABASE_URL = value;
    await save();
    expect(() => runner.syntheticDatabase(value, environment)).toThrow(
      "TARGET_INVALID",
    );
    expect(() => cmsRemoteSyntheticTarget(environment)).toThrow(
      "TARGET_INVALID",
    );
  });

  it("propagates only the approved CA and target into both Payload and URL-only test clients", async () => {
    const { environment, target, ca } = await fixture();
    for (const [name, value] of Object.entries(environment))
      vi.stubEnv(name, value);
    vi.stubEnv("CMS_UNRELATED_SETTING", "must-not-propagate");
    vi.stubEnv("NODE_EXTRA_CA_CERTS", "/synthetic/unrelated-ca.pem");
    const session = await runner.createVerificationSession(
      environment.CMS_DATABASE_URL!,
      "remote-cms-session-",
    );
    directories.push(session.directory);
    try {
      expect(session.env.CMS_DATABASE_SSL_CA_FILE).toBe(
        environment.CMS_DATABASE_SSL_CA_FILE,
      );
      expect(session.env.NODE_EXTRA_CA_CERTS).toBe(
        environment.CMS_DATABASE_SSL_CA_FILE,
      );
      expect(session.env.CMS_TEST_REMOTE_TARGET_JSON).toBe(
        JSON.stringify(target),
      );
      expect(session.env.CMS_UNRELATED_SETTING).toBeUndefined();
      expect(cmsDatabasePool().ssl).toMatchObject({
        rejectUnauthorized: true,
        ca,
      });
    } finally {
      await session.dispose();
    }
  });

  it("requires exact live identity, version, TLS and an empty target before any migration", async () => {
    const { environment, target } = await fixture();
    const identity = {
      database: target.database,
      username: target.user,
      database_oid: target.databaseOid,
      version_num: "180006",
      server_version: "18.6",
      tls: true,
      user_objects: 0,
      custom_schemas: 0,
      other_extensions: 0,
      large_objects: 0,
    };
    const query = vi.fn(async (sql: string) => {
      expect(sql).not.toMatch(
        /\b(?:CREATE|ALTER|DROP|TRUNCATE|INSERT|UPDATE|DELETE)\b/i,
      );
      return { rows: [identity] };
    });
    await expect(
      runner.verifyRemoteSyntheticDatabase(environment, query),
    ).resolves.toEqual({ versionNum: 180006, tls: true, empty: true });
    expect(query).toHaveBeenCalledOnce();
    for (const changed of [
      { database: "another_database" },
      { username: "another_test_user" },
      { database_oid: "99999" },
      { version_num: "180004" },
      { server_version: "18.4" },
      { tls: false },
      { user_objects: 1 },
      { custom_schemas: 1 },
      { other_extensions: 1 },
      { large_objects: 1 },
    ])
      await expect(
        runner.verifyRemoteSyntheticDatabase(environment, async () => ({
          rows: [{ ...identity, ...changed }],
        })),
      ).rejects.toThrow("PREFLIGHT_FAILED");
  });

  it("accepts the approved PostgreSQL 16 build only with its exact live version", async () => {
    const { environment, target } = await fixture(160015);
    expect(cmsRemoteSyntheticTarget(environment).serverVersionNum).toBe(160015);
    const identity = {
      database: target.database,
      username: target.user,
      database_oid: target.databaseOid,
      version_num: "160015",
      server_version: "16.15",
      tls: true,
      user_objects: 0,
      custom_schemas: 0,
      other_extensions: 0,
      large_objects: 0,
    };
    await expect(
      runner.verifyRemoteSyntheticDatabase(environment, async () => ({
        rows: [identity],
      })),
    ).resolves.toEqual({ versionNum: 160015, tls: true, empty: true });
    for (const changed of [
      { version_num: "180006" },
      { server_version: "16.1" },
      { server_version: "16.150" },
      { server_version: "18.6" },
    ])
      await expect(
        runner.verifyRemoteSyntheticDatabase(environment, async () => ({
          rows: [{ ...identity, ...changed }],
        })),
      ).rejects.toThrow("PREFLIGHT_FAILED");
  });
});

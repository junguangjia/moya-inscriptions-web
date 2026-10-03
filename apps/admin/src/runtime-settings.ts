import { createHash } from "node:crypto";
import {
  constants,
  closeSync,
  fstatSync,
  openSync,
  readFileSync,
} from "node:fs";
import {
  parsePostgresConfig,
  type PostgresConfig,
} from "@moya/catalog-postgres";

/** Explicit remote verification exception; ordinary targets retain their guard. */
export function cmsRemoteSyntheticTarget(
  environment: Readonly<Record<string, string | undefined>> = process.env,
) {
  const fail = (): never => {
    throw new Error("REMOTE_SYNTHETIC_TARGET_INVALID");
  };
  if (
    environment.CMS_ENVIRONMENT !== "synthetic" ||
    environment.MOYA_CONTENT_SOURCE !== "payload" ||
    environment.CMS_STORAGE_MODE !== "local" ||
    !environment.CMS_TEST_REMOTE_TARGET_JSON ||
    environment.CMS_DATABASE_URL !== environment.CMS_TEST_DATABASE_URL
  )
    fail();
  let file: number | undefined;
  try {
    const target: unknown = JSON.parse(
      environment.CMS_TEST_REMOTE_TARGET_JSON!,
    );
    if (!target || typeof target !== "object" || Array.isArray(target)) fail();
    const record = target as Record<string, unknown>;
    if (
      Object.keys(record).sort().join(",") !==
        "caSha256,database,databaseOid,host,kind,port,serverVersionNum,user,version" ||
      record.version !== 1 ||
      record.kind !== "p2-r2b-remote-synthetic" ||
      record.serverVersionNum !== 180006 ||
      typeof record.host !== "string" ||
      !record.host ||
      !Number.isSafeInteger(record.port) ||
      Number(record.port) < 1 ||
      Number(record.port) > 65535 ||
      typeof record.database !== "string" ||
      !/^[a-z][a-z0-9_]{0,62}$/.test(record.database) ||
      !record.database.includes("cms_test") ||
      typeof record.user !== "string" ||
      !/^[a-z][a-z0-9_]{0,62}$/.test(record.user) ||
      !record.user.includes("test") ||
      typeof record.databaseOid !== "string" ||
      !/^[1-9][0-9]*$/.test(record.databaseOid) ||
      typeof record.caSha256 !== "string" ||
      !/^[a-f0-9]{64}$/.test(record.caSha256)
    )
      fail();
    const url = new URL(environment.CMS_DATABASE_URL!);
    if (
      !["postgres:", "postgresql:"].includes(url.protocol) ||
      ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ||
      url.hostname !== record.host ||
      Number(url.port || "5432") !== record.port ||
      decodeURIComponent(url.pathname.slice(1)) !== record.database ||
      decodeURIComponent(url.username) !== record.user ||
      url.hash ||
      url.search !== "?sslmode=verify-full" ||
      !environment.CMS_DATABASE_SSL_CA_FILE
    )
      fail();
    file = openSync(
      environment.CMS_DATABASE_SSL_CA_FILE!,
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    const info = fstatSync(file);
    if (!info.isFile() || info.size > 1024 * 1024) fail();
    const ca = readFileSync(file);
    if (createHash("sha256").update(ca).digest("hex") !== record.caSha256)
      fail();
    return {
      host: record.host as string,
      port: record.port as number,
      database: record.database as string,
      user: record.user as string,
      databaseOid: record.databaseOid as string,
      serverVersionNum: record.serverVersionNum as number,
    };
  } catch {
    return fail();
  } finally {
    if (file !== undefined) closeSync(file);
  }
}

export const requiredSetting = (name: string): string => {
  const value = process.env[name];
  if (!value) throw new Error(`Missing CMS setting: ${name}`);
  return value;
};
export const cmsDatabasePool = (): PostgresConfig => {
  const value = requiredSetting("CMS_DATABASE_URL");
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Invalid CMS database configuration");
  }
  if (!["postgres:", "postgresql:"].includes(url.protocol))
    throw new Error("Invalid CMS database protocol");
  if (process.env.CMS_ENVIRONMENT === "synthetic") {
    if (process.env.CMS_TEST_REMOTE_TARGET_JSON !== undefined)
      cmsRemoteSyntheticTarget();
    else if (
      !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ||
      [...url.searchParams].some(
        ([key, entry]) => key !== "sslmode" || entry !== "disable",
      )
    )
      throw new Error("Synthetic CMS requires a loopback database");
  }
  try {
    return parsePostgresConfig({
      DATABASE_URL: value,
      DATABASE_POOL_MAX: "5",
      DATABASE_IDLE_TIMEOUT_MS: process.env.DATABASE_IDLE_TIMEOUT_MS,
      DATABASE_SSL_CA_FILE: process.env.CMS_DATABASE_SSL_CA_FILE,
    });
  } catch {
    throw new Error("Invalid CMS database configuration");
  }
};

export const cmsDatabase = (): string => cmsDatabasePool().connectionString;

/** Fixed diagnostics only: never forward Pino args, messages, paths or values. */
export const cmsRuntimeLogFields = (args: readonly unknown[]) => {
  const allowedNames = new Set([
    "TypeError",
    "ReferenceError",
    "RangeError",
    "Error",
    "APIError",
    "ValidationError",
  ]);
  let error: unknown;
  for (const value of args) {
    if (!value || typeof value !== "object") continue;
    if (value instanceof Error) {
      error = value;
      break;
    }
    if ("err" in value && value.err && typeof value.err === "object") {
      error = value.err;
      break;
    }
    if ("error" in value && value.error && typeof value.error === "object") {
      error = value.error;
      break;
    }
  }
  const frames: { file: string; line: number; column: number }[] = [];
  let errorName: string | undefined;
  if (error && typeof error === "object") {
    if (
      "name" in error &&
      typeof error.name === "string" &&
      allowedNames.has(error.name)
    )
      errorName = error.name;
    if ("stack" in error && typeof error.stack === "string") {
      const framePattern =
        /[/\\]([A-Za-z0-9_.-]+\.(?:[cm]?[jt]sx?)):(\d+):(\d+)\)?(?:\n|$)/g;
      for (const frame of error.stack.matchAll(framePattern)) {
        frames.push({
          file: frame[1]!,
          line: Number(frame[2]),
          column: Number(frame[3]),
        });
        if (frames.length === 5) break;
      }
    }
  }
  return {
    category: "CMS_RUNTIME_EVENT",
    ...(errorName ? { errorName } : {}),
    ...(frames.length ? { frames } : {}),
  };
};

/** Validate the deploy-time CMS boundary before initializing the adapter. */
export const assertCmsProductionEnvironment = (
  environment: Readonly<Record<string, string | undefined>> = process.env,
): void => {
  if (
    environment.NODE_ENV !== "production" ||
    environment.CMS_ENVIRONMENT === "synthetic"
  )
    return;
  for (const name of [
    "CMS_SECRET",
    "CMS_DATABASE_URL",
    "CMS_MEDIA_DIR",
    "CMS_PUBLIC_URL",
    "CMS_PREVIEW_WEB_URL",
  ])
    if (!environment[name]?.trim())
      throw new Error(`Missing CMS setting: ${name}`);
  if (environment.MOYA_CONTENT_SOURCE !== "payload")
    throw new Error("Production CMS requires MOYA_CONTENT_SOURCE=payload");
  if (environment.CMS_STORAGE_MODE !== "cos")
    throw new Error("Production CMS requires CMS_STORAGE_MODE=cos");
  for (const name of ["CMS_PUBLIC_URL", "CMS_PREVIEW_WEB_URL"]) {
    let url: URL;
    try {
      url = new URL(environment[name]!);
    } catch {
      throw new Error("Invalid production CMS URL configuration");
    }
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.pathname !== "/" ||
      url.search ||
      url.hash
    )
      throw new Error("Invalid production CMS URL configuration");
  }
};

/** Validate before loading Payload or opening its privileged setup connection. */
export const assertInitialOwnerDatabaseTLS = (
  environment: Readonly<Record<string, string | undefined>> = process.env,
): void => {
  try {
    const url = new URL(environment.CMS_DATABASE_URL ?? "");
    if (url.searchParams.getAll("sslmode").join(",") !== "verify-full")
      throw new Error();
    const config = parsePostgresConfig({
      DATABASE_URL: environment.CMS_DATABASE_URL,
      DATABASE_SSL_CA_FILE: environment.CMS_DATABASE_SSL_CA_FILE,
    });
    if (!config.ssl) throw new Error();
  } catch {
    throw new Error("INITIAL_OWNER_DATABASE_TLS_REFUSED");
  }
};

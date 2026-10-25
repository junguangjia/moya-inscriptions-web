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

// Exact TencentDB builds approved as remote synthetic targets: the PostgreSQL
// 16 minimum supported Production major and the PostgreSQL 18 one.
const REMOTE_SYNTHETIC_SERVER_VERSIONS: readonly unknown[] = [160015, 180006];

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
      !REMOTE_SYNTHETIC_SERVER_VERSIONS.includes(record.serverVersionNum) ||
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

// Fixed, content-free event names a caller may log as `{ category }`; any
// other category is reported as the generic runtime event.
const CMS_EVENT_CATEGORIES: ReadonlySet<unknown> = new Set([
  "EDITORIAL_MEDIA_INGEST_FAILED",
  "EDITORIAL_MEDIA_INGEST_CONFIGURATION_INVALID",
  "EDITORIAL_MEDIA_INGEST_FINAL_INVALID",
  "EDITORIAL_MEDIA_INGEST_ORPHAN",
  "EDITORIAL_MEDIA_INGEST_STAGING_DELETE_FAILED",
]);

/** Fixed diagnostics only: never forward Pino args, messages, paths or values. */
export const cmsRuntimeLogFields = (args: readonly unknown[]) => {
  const event = args.find(
    (value): value is { category: string } =>
      !!value &&
      typeof value === "object" &&
      "category" in value &&
      CMS_EVENT_CATEGORIES.has(value.category),
  );
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
    category: event?.category ?? "CMS_RUNTIME_EVENT",
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

type Environment = Readonly<Record<string, string | undefined>>;

/**
 * CMS_CATALOG_INGEST gates the Catalog ingest routes at config load: absent,
 * empty (a blanked switch) or `off` composes none (they answer 404), `on`
 * composes them, and any other value refuses to load (design-ingest J), which
 * stops the Admin and `payload migrate` alike. Nothing else about ingest is
 * read here.
 */
export const catalogIngestEnabled = (
  environment: Environment = process.env,
): boolean => {
  const value = environment.CMS_CATALOG_INGEST;
  if (value === undefined || value === "" || value === "off") return false;
  if (value === "on") return true;
  throw new Error("CMS_CATALOG_INGEST_INVALID");
};

/**
 * CMS_CATALOG_DIRECT_PUBLISH lets a Catalog record with editorial originals
 * publish without the delivery preparation the release path proves, until
 * Admin has prepare and release controls: absent, empty or `off` keeps that
 * guard, `on` publishes at once (the worker renders the published images and
 * the public answer leaves them out until it has), and any other value refuses
 * to load, which stops the Admin and `payload migrate` alike.
 */
export const catalogDirectPublishEnabled = (
  environment: Environment = process.env,
): boolean => {
  const value = environment.CMS_CATALOG_DIRECT_PUBLISH;
  if (value === undefined || value === "" || value === "off") return false;
  if (value === "on") return true;
  throw new Error("CMS_CATALOG_DIRECT_PUBLISH_INVALID");
};

/** The Development ingest store: local storage outside a production environment. */
export const catalogIngestDevelopmentStore = (
  environment: Environment = process.env,
): boolean =>
  (environment.CMS_STORAGE_MODE ?? "local") === "local" &&
  environment.CMS_ENVIRONMENT !== "production";

export type CatalogIngestSettings = Readonly<{
  storage:
    | {
        mode: "cos";
        endpoint: URL;
        region: string;
        bucket: string;
        accessKeyId: string;
        secretAccessKey: string;
      }
    | { mode: "local" };
  /** The origin the uploader PUTs to; a staging signature binds its host. */
  uploadEndpoint: URL;
  /**
   * D9: `on` reads and hashes staging on the server (an intranet COS host);
   * `off` checks the MD5 ETag, the header and the tail only, and leaves the
   * SHA-256 check to the worker's render.
   */
  serverSha256: boolean;
  /** D8: `on` is lifecycle L1 (tagged staging); `off` is L2 (no tag). */
  stagingTag: boolean;
}>;

/**
 * The ingest settings, read on the first ingest request only, so neither
 * Admin start nor `payload migrate` depends on them. An error names the
 * setting, never its value.
 */
export const catalogIngestSettings = (
  environment: Environment = process.env,
): CatalogIngestSettings => {
  const invalid = (name: string): never => {
    throw new Error(`CMS_CATALOG_INGEST_SETTING_INVALID:${name}`);
  };
  const toggle = (name: string, fallback: boolean) => {
    const value = environment[name];
    if (value === undefined) return fallback;
    if (value !== "on" && value !== "off") invalid(name);
    return value === "on";
  };
  const text = (name: string) => {
    const value = environment[name];
    if (!value || value.trim() !== value || /[\s\0]/.test(value)) invalid(name);
    return value!;
  };
  const origin = (name: string, local: boolean) => {
    let url: URL;
    try {
      url = new URL(text(name));
    } catch {
      return invalid(name);
    }
    if (
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.pathname !== "/" ||
      !(
        url.protocol === "https:" ||
        (local &&
          url.protocol === "http:" &&
          ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname))
      )
    )
      invalid(name);
    return url;
  };
  const mode = environment.CMS_STORAGE_MODE ?? "local";
  if (mode === "local" && !catalogIngestDevelopmentStore(environment))
    invalid("CMS_STORAGE_MODE");
  if (mode !== "local" && mode !== "cos") invalid("CMS_STORAGE_MODE");
  return {
    storage:
      mode === "cos"
        ? {
            mode,
            endpoint: origin("CMS_COS_ENDPOINT", false),
            region: text("CMS_COS_REGION"),
            bucket: text("CMS_COS_BUCKET"),
            accessKeyId: text("CMS_COS_ACCESS_KEY_ID"),
            secretAccessKey: text("CMS_COS_SECRET_ACCESS_KEY"),
          }
        : { mode: "local" },
    uploadEndpoint: origin(
      "CMS_CATALOG_INGEST_UPLOAD_ENDPOINT",
      mode === "local",
    ),
    serverSha256: toggle("CMS_CATALOG_INGEST_SERVER_SHA256", true),
    stagingTag: toggle("CMS_CATALOG_INGEST_STAGING_TAG", false),
  };
};

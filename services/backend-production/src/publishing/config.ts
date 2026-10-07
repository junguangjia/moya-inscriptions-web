import { realpath } from "node:fs/promises";
import path from "node:path";

import {
  assertPublishingCosOptions,
  CosPublishingMediaStore,
} from "../storage/publishing-cos-store.js";
import { createPublishingCosTransport } from "../storage/publishing-cos-transport.js";

import {
  FilesystemPublishingMediaStore,
  PUBLISHING_MEDIA_TEMPORARY_ROOTS,
  assertPrivateMediaDirectory,
} from "../storage/publishing-media-store.js";
import { createPublishingMediaProcessor } from "./processing/media-processor.js";
import {
  createSandboxRunner,
  defaultSandboxAppDist,
} from "./sandbox/sandbox-runner.js";

import type {
  ProcessorInput,
  ProcessorOutcome,
} from "./processing/media-processor.js";
import type { SandboxRunner, SandboxSpawn } from "./sandbox/sandbox-runner.js";
import type { PublishingCosStoreOptions } from "../storage/publishing-cos-store.js";
import type { PublishingCosTransport } from "../storage/publishing-cos-transport.js";
import type { CosCredentials } from "../storage/cos-read.js";

/*
 * Development configuration of private work publishing media (design §3.5,
 * §9.6). Publishing uploads and processing exist only when the store
 * directory, the local media sandbox image and the sandbox work directory are
 * all configured; with none of them the Backend still starts, publishing media
 * answers 503 and the worker concurrency key is not read. A partial or
 * malformed configuration fails startup with a message that names the key and
 * never echoes its value.
 *
 * The sandbox work directory is a third required key beside the two that
 * design §9.6 names: sandbox jobs need a private, bind-mountable directory
 * that must not overlap the store, and no safe default location exists.
 *
 * `WORK_MEDIA_WORKER` (unified media pipeline, increment 1) selects where
 * media processing runs: `embedded` hosts the processing worker in the
 * Backend (Development default), `external` leaves it to the separate media
 * worker process, so the Backend opens only the store (Production default;
 * `embedded` is refused in Production).
 */

export const WORK_MEDIA_WORKER = "WORK_MEDIA_WORKER";
export const WORK_MEDIA_STORE_DIR = "WORK_MEDIA_STORE_DIR";
export const WORK_MEDIA_TOOLS_IMAGE = "WORK_MEDIA_TOOLS_IMAGE";
export const WORK_MEDIA_WORK_DIR = "WORK_MEDIA_WORK_DIR";
export const WORK_MEDIA_WORKER_CONCURRENCY = "WORK_MEDIA_WORKER_CONCURRENCY";

export const PUBLISHING_WORKER_CONCURRENCY_DEFAULT = 1;
export const PUBLISHING_WORKER_CONCURRENCY_MAX = 4;

export interface PublishingMediaConfig {
  /** Absolute normalized private directory for committed and staged blobs. */
  readonly storeDirectory: string;
  /** Local media sandbox image with an explicit tag or digest; never pulled. */
  readonly toolsImage: string;
  /** Absolute normalized private directory for sandbox jobs. */
  readonly workDirectory: string;
  /** Jobs leased and run at once by one worker, 1..4. */
  readonly workerConcurrency: number;
}

type Environment = Readonly<Record<string, string | undefined>>;

const MAX_DIRECTORY_LENGTH = 1024;
/** Characters that cannot be bind-mounted safely (the runner refuses them too). */
const MOUNT_UNSAFE = /[,"\n\r\0]/;
/** `name[:tag][@sha256:digest]` (or `sha256:<id>`), as the sandbox runner accepts it. */
const IMAGE_PATTERN =
  /^[a-z0-9][a-z0-9._/-]{0,127}(?::[A-Za-z0-9._-]{1,128})?(?:@sha256:[0-9a-f]{64})?$/;
const IMAGE_TAG_OR_DIGEST = /(?::[A-Za-z0-9._-]{1,128}|@sha256:[0-9a-f]{64})$/;

const configured = (environment: Environment, key: string): string | null => {
  const value = environment[key];
  return value === undefined || value === "" ? null : value;
};

export type MediaWorkerMode = "embedded" | "external";

/**
 * Where media processing runs. Production defaults to `external` and refuses
 * `embedded`, so a Production Backend never hosts the sandbox runner.
 */
export const parseMediaWorkerMode = (
  environment: Environment,
  nodeEnv: "production" | "development",
): MediaWorkerMode => {
  const value = configured(environment, WORK_MEDIA_WORKER);
  if (value === null) {
    return nodeEnv === "production" ? "external" : "embedded";
  }
  if (value !== "embedded" && value !== "external") {
    throw new Error(`${WORK_MEDIA_WORKER} must be embedded or external`);
  }
  if (value === "embedded" && nodeEnv === "production") {
    throw new Error(`${WORK_MEDIA_WORKER}=embedded is refused in production`);
  }
  return value;
};

const isWithin = (candidate: string, root: string): boolean =>
  candidate === root || candidate.startsWith(`${root}${path.sep}`);

const overlaps = (first: string, second: string): boolean =>
  isWithin(first, second) || isWithin(second, first);

const parseDirectory = (key: string, value: string): string => {
  if (
    value.length > MAX_DIRECTORY_LENGTH ||
    !path.isAbsolute(value) ||
    path.normalize(value) !== value ||
    value.endsWith(path.sep) ||
    value === path.parse(value).root ||
    MOUNT_UNSAFE.test(value)
  ) {
    throw new Error(`${key} must be an absolute normalized directory path`);
  }
  if (PUBLISHING_MEDIA_TEMPORARY_ROOTS.some((root) => isWithin(value, root))) {
    throw new Error(`${key} must not be under temporary storage`);
  }
  return value;
};

const parseConcurrency = (value: string | null): number => {
  if (value === null) return PUBLISHING_WORKER_CONCURRENCY_DEFAULT;
  const concurrency = /^[1-9]$/.test(value) ? Number(value) : Number.NaN;
  if (!(concurrency <= PUBLISHING_WORKER_CONCURRENCY_MAX)) {
    throw new Error(
      `${WORK_MEDIA_WORKER_CONCURRENCY} must be an integer from 1 to ${PUBLISHING_WORKER_CONCURRENCY_MAX}`,
    );
  }
  return concurrency;
};

/**
 * Reads the publishing media keys. `null` when none of the three required
 * keys is set (publishing media disabled; the concurrency key is then
 * ignored). Directory existence, ownership and permissions are checked when
 * the store opens.
 */
export const parsePublishingMediaConfig = (
  environment: Environment,
): PublishingMediaConfig | null => {
  const storeValue = configured(environment, WORK_MEDIA_STORE_DIR);
  const imageValue = configured(environment, WORK_MEDIA_TOOLS_IMAGE);
  const workValue = configured(environment, WORK_MEDIA_WORK_DIR);
  if (storeValue === null && imageValue === null && workValue === null) {
    return null;
  }
  if (storeValue === null || imageValue === null || workValue === null) {
    throw new Error(
      `${WORK_MEDIA_STORE_DIR}, ${WORK_MEDIA_TOOLS_IMAGE} and ${WORK_MEDIA_WORK_DIR} must be configured together`,
    );
  }
  const workerConcurrency = parseConcurrency(
    configured(environment, WORK_MEDIA_WORKER_CONCURRENCY),
  );
  const storeDirectory = parseDirectory(WORK_MEDIA_STORE_DIR, storeValue);
  const workDirectory = parseDirectory(WORK_MEDIA_WORK_DIR, workValue);
  if (overlaps(storeDirectory, workDirectory)) {
    throw new Error(
      `${WORK_MEDIA_STORE_DIR} and ${WORK_MEDIA_WORK_DIR} must be separate directories`,
    );
  }
  if (
    !IMAGE_PATTERN.test(imageValue) ||
    !IMAGE_TAG_OR_DIGEST.test(imageValue)
  ) {
    throw new Error(
      `${WORK_MEDIA_TOOLS_IMAGE} must be a local image reference with an explicit tag or digest`,
    );
  }
  return {
    storeDirectory,
    toolsImage: imageValue,
    workDirectory,
    workerConcurrency,
  };
};

/**
 * Reads only the Development store directory (a Backend whose media worker
 * runs separately); `null` when it is not set. The sandbox keys are ignored.
 */
export const parsePublishingStoreDirectory = (
  environment: Environment,
): string | null => {
  const value = configured(environment, WORK_MEDIA_STORE_DIR);
  return value === null ? null : parseDirectory(WORK_MEDIA_STORE_DIR, value);
};

export type PublishingMediaStoreRuntime = Pick<
  FilesystemPublishingMediaStore,
  "writeStream" | "openRead" | "remove" | "listBlobs" | "sweepStaging"
>;

export interface PublishingMediaRuntime {
  readonly store: PublishingMediaStoreRuntime;
  /** The media sandbox runner (one container per processing job). */
  readonly sandbox: SandboxRunner;
  readonly processor: {
    process(input: ProcessorInput): Promise<ProcessorOutcome>;
  };
}

/** Test and acceptance seams of the sandbox runner; never read from env. */
export interface SandboxRuntimeOptions {
  /** The release `dist` mounted into the container (default: this package's). */
  readonly appDist?: string;
  /**
   * The renderer's source tree that Development compares `appDist` with
   * (default: this package's `src` when `appDist` is not overridden).
   * Ignored in Production, where the release build is authoritative.
   */
  readonly sourceDirectory?: string;
  readonly spawn?: SandboxSpawn;
}

export interface OpenPublishingMediaOptions extends SandboxRuntimeOptions {
  /**
   * Directories owned by other namespaces (for example the Payload media
   * directory). Publishing media must neither contain nor live inside them.
   */
  readonly foreignDirectories?: readonly (string | undefined)[];
  /** Test seam forwarded to the directory checks. */
  readonly temporaryRoots?: readonly string[];
}

/** Directory check messages are content-free; they never contain the path. */
const invalidDirectory =
  (key: string) =>
  (error: unknown): never => {
    const reason =
      error instanceof Error ? error.message : "Directory check failed";
    throw new Error(`${key} is invalid: ${reason}`);
  };

const realOrResolved = async (directory: string): Promise<string> => {
  const resolved = path.resolve(directory);
  try {
    return await realpath(resolved);
  } catch {
    return resolved;
  }
};

export interface ProductionPublishingStoreConfig extends PublishingCosStoreOptions {
  readonly credentials: () => Promise<CosCredentials>;
  readonly requestTimeoutMs: number;
}

export interface ProductionPublishingMediaConfig extends ProductionPublishingStoreConfig {
  readonly toolsImage: string;
  readonly workDirectory: string;
  readonly workerConcurrency: number;
}

/** Required, fail-closed Production store configuration (COS keys only).
 * Separate credentials keep UGC write/delete authority independent of
 * Catalog and Payload credentials. Parsing makes no cloud request.
 */
export function parseProductionPublishingStoreConfig(
  environment: Environment,
): ProductionPublishingStoreConfig {
  const required = (key: string) => {
    const value = environment[key];
    if (!value || value.trim() !== value || /[\r\n\0]/.test(value))
      throw new Error(`${key} is missing or invalid`);
    return value;
  };
  if (environment.WORK_MEDIA_STORE_DIR)
    throw new Error(
      "WORK_MEDIA_STORE_DIR must be absent for Production COS publishing",
    );
  const options = {
    bucket: required("WORK_MEDIA_COS_BUCKET"),
    region: required("WORK_MEDIA_COS_REGION"),
    prefix: required("WORK_MEDIA_COS_PREFIX"),
  };
  assertPublishingCosOptions(options);
  const secretId = required("WORK_MEDIA_COS_SECRET_ID");
  const secretKey = required("WORK_MEDIA_COS_SECRET_KEY");
  if (!/^[A-Za-z0-9_-]+$/.test(secretId))
    throw new Error("WORK_MEDIA_COS_SECRET_ID is invalid");
  const integer = (key: string) => {
    const value = required(key);
    if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value)))
      throw new Error(`${key} is invalid`);
    return Number(value);
  };
  const securityToken =
    environment.WORK_MEDIA_COS_SECURITY_TOKEN === undefined
      ? undefined
      : required("WORK_MEDIA_COS_SECURITY_TOKEN");
  const expiresAt = securityToken
    ? integer("WORK_MEDIA_COS_CREDENTIAL_EXPIRES_AT")
    : undefined;
  if (
    !securityToken &&
    environment.WORK_MEDIA_COS_CREDENTIAL_EXPIRES_AT !== undefined
  )
    throw new Error(
      "WORK_MEDIA_COS_SECURITY_TOKEN is required with credential expiry",
    );
  if (
    expiresAt !== undefined &&
    expiresAt <= Math.floor(Date.now() / 1000) + 30
  )
    throw new Error(
      "WORK_MEDIA_COS_CREDENTIAL_EXPIRES_AT has insufficient validity",
    );
  const timeout =
    environment.WORK_MEDIA_COS_REQUEST_TIMEOUT_MS === undefined
      ? 30_000
      : integer("WORK_MEDIA_COS_REQUEST_TIMEOUT_MS");
  if (timeout > 120_000)
    throw new Error("WORK_MEDIA_COS_REQUEST_TIMEOUT_MS must be at most 120000");
  return {
    ...options,
    credentials: async () => ({
      secretId,
      secretKey,
      ...(securityToken ? { securityToken, expiresAt: expiresAt! } : {}),
    }),
    requestTimeoutMs: timeout,
  };
}

/** The media worker's Production configuration: the store plus the sandbox
 * image, its private work directory and the job concurrency.
 */
export function parseProductionPublishingMediaConfig(
  environment: Environment,
): ProductionPublishingMediaConfig {
  const store = parseProductionPublishingStoreConfig(environment);
  const toolsImage = environment[WORK_MEDIA_TOOLS_IMAGE];
  if (!toolsImage || toolsImage.trim() !== toolsImage)
    throw new Error(`${WORK_MEDIA_TOOLS_IMAGE} is missing or invalid`);
  if (!IMAGE_PATTERN.test(toolsImage) || !IMAGE_TAG_OR_DIGEST.test(toolsImage))
    throw new Error(
      `${WORK_MEDIA_TOOLS_IMAGE} must be a local image reference with an explicit tag or digest`,
    );
  const workDirectory = environment[WORK_MEDIA_WORK_DIR];
  if (!workDirectory || workDirectory.trim() !== workDirectory)
    throw new Error(`${WORK_MEDIA_WORK_DIR} is missing or invalid`);
  return {
    ...store,
    toolsImage,
    workDirectory: parseDirectory(WORK_MEDIA_WORK_DIR, workDirectory),
    workerConcurrency: parseConcurrency(
      configured(environment, WORK_MEDIA_WORKER_CONCURRENCY),
    ),
  };
}

const assertStoreConfig = (config: ProductionPublishingStoreConfig) => {
  assertPublishingCosOptions(config);
  if (
    !Number.isSafeInteger(config.requestTimeoutMs) ||
    config.requestTimeoutMs < 1 ||
    config.requestTimeoutMs > 120_000
  )
    throw new Error("WORK_MEDIA_COS_REQUEST_TIMEOUT_MS is invalid");
};

/** Opens only the Production COS store (a Backend with an external worker). */
export function openProductionPublishingStore(
  config: ProductionPublishingStoreConfig,
  options: { readonly transport?: PublishingCosTransport } = {},
): CosPublishingMediaStore {
  assertStoreConfig(config);
  return new CosPublishingMediaStore(
    config,
    options.transport ?? createPublishingCosTransport(config),
  );
}

/** Opens only the Development filesystem store (a Backend with an external worker). */
export const openPublishingStore = async (
  storeDirectory: string,
  options: OpenPublishingMediaOptions = {},
): Promise<FilesystemPublishingMediaStore> => {
  const directoryOptions = options.temporaryRoots
    ? { temporaryRoots: options.temporaryRoots }
    : {};
  const storeReal = await assertPrivateMediaDirectory(
    storeDirectory,
    directoryOptions,
  ).catch(invalidDirectory(WORK_MEDIA_STORE_DIR));
  for (const foreign of options.foreignDirectories ?? []) {
    if (foreign === undefined || foreign === "") continue;
    if (overlaps(storeReal, await realOrResolved(foreign)))
      throw new Error(
        "Publishing media directories must be separate from other media namespaces",
      );
  }
  return FilesystemPublishingMediaStore.open(
    storeDirectory,
    directoryOptions,
  ).catch(invalidDirectory(WORK_MEDIA_STORE_DIR));
};

/**
 * The sandbox runner over a validated work directory. Performs no Docker
 * call. Only Development compares the renderer build with its sources (a
 * stale `dist` is refused with an actionable message); a Production release
 * runs exactly the build it ships, whatever the file times of a source tree
 * beside it.
 */
const openSandbox = (
  image: string,
  workDirectory: string,
  options: OpenPublishingMediaOptions,
  runtime: "development" | "production",
): Promise<SandboxRunner> => {
  const defaults = defaultSandboxAppDist();
  const sourceDirectory =
    runtime === "production"
      ? undefined
      : (options.sourceDirectory ??
        (options.appDist === undefined ? defaults.sourceDirectory : undefined));
  return createSandboxRunner({
    image,
    workDirectory,
    appDist: options.appDist ?? defaults.appDist,
    ...(sourceDirectory === undefined ? {} : { sourceDirectory }),
    ...(options.spawn ? { spawn: options.spawn } : {}),
    ...(options.temporaryRoots
      ? { temporaryRoots: options.temporaryRoots }
      : {}),
  });
};

/** The media worker's Production runtime: COS store, sandbox and processor. */
export async function openProductionPublishingMedia(
  config: ProductionPublishingMediaConfig,
  options: OpenPublishingMediaOptions & {
    readonly transport?: PublishingCosTransport;
  } = {},
): Promise<PublishingMediaRuntime> {
  assertStoreConfig(config);
  parseConcurrency(String(config.workerConcurrency));
  const directoryOptions = options.temporaryRoots
    ? { temporaryRoots: options.temporaryRoots }
    : {};
  const workReal = await assertPrivateMediaDirectory(
    config.workDirectory,
    directoryOptions,
  ).catch(invalidDirectory(WORK_MEDIA_WORK_DIR));
  for (const foreign of options.foreignDirectories ?? []) {
    if (foreign && overlaps(workReal, await realOrResolved(foreign)))
      throw new Error(
        "Publishing media directories must be separate from other media namespaces",
      );
  }
  const store = openProductionPublishingStore(config, options);
  const sandbox = await openSandbox(
    config.toolsImage,
    workReal,
    options,
    "production",
  );
  return {
    store,
    sandbox,
    processor: createPublishingMediaProcessor({ store, sandbox }),
  };
}

/**
 * Validates both private directories (existing, owner-only, outside temporary
 * storage and Git working trees, not nested in each other or in a foreign
 * namespace), then opens the filesystem store, the media sandbox runner and
 * the processor over them. Performs no Docker call.
 */
export const openPublishingMedia = async (
  config: PublishingMediaConfig,
  options: OpenPublishingMediaOptions = {},
): Promise<PublishingMediaRuntime> => {
  const directoryOptions = options.temporaryRoots
    ? { temporaryRoots: options.temporaryRoots }
    : {};
  const storeReal = await assertPrivateMediaDirectory(
    config.storeDirectory,
    directoryOptions,
  ).catch(invalidDirectory(WORK_MEDIA_STORE_DIR));
  const workReal = await assertPrivateMediaDirectory(
    config.workDirectory,
    directoryOptions,
  ).catch(invalidDirectory(WORK_MEDIA_WORK_DIR));
  if (overlaps(storeReal, workReal)) {
    throw new Error(
      `${WORK_MEDIA_STORE_DIR} and ${WORK_MEDIA_WORK_DIR} must be separate directories`,
    );
  }
  for (const foreign of options.foreignDirectories ?? []) {
    if (foreign === undefined || foreign === "") continue;
    const foreignReal = await realOrResolved(foreign);
    if (overlaps(storeReal, foreignReal) || overlaps(workReal, foreignReal)) {
      throw new Error(
        "Publishing media directories must be separate from other media namespaces",
      );
    }
  }
  const store = await FilesystemPublishingMediaStore.open(
    config.storeDirectory,
    directoryOptions,
  ).catch(invalidDirectory(WORK_MEDIA_STORE_DIR));
  const sandbox = await openSandbox(
    config.toolsImage,
    config.workDirectory,
    options,
    "development",
  ).catch(invalidDirectory(WORK_MEDIA_WORK_DIR));
  return {
    store,
    sandbox,
    processor: createPublishingMediaProcessor({ store, sandbox }),
  };
};

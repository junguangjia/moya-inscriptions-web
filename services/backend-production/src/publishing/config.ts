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
import { createMediaToolsRunner } from "./processing/media-tools.js";

import type {
  ProcessorInput,
  ProcessorOutcome,
} from "./processing/media-processor.js";
import type { MediaToolsRunner } from "./processing/media-tools.js";
import type { PublishingCosStoreOptions } from "../storage/publishing-cos-store.js";
import type { PublishingCosTransport } from "../storage/publishing-cos-transport.js";
import type { CosCredentials } from "../storage/cos-read.js";

/*
 * Development configuration of private work publishing media (design §3.5,
 * §9.6). Publishing uploads and processing exist only when the store
 * directory, the local media tools image and the tools work directory are all
 * configured; with none of them the Backend still starts, publishing media
 * answers 503 and the worker concurrency key is not read. A partial or
 * malformed configuration fails startup with a message that names the key and
 * never echoes its value.
 *
 * The tools work directory is a third required key beside the two that design
 * §9.6 names: sandboxed tool jobs need a private, bind-mountable directory
 * that must not overlap the store, and no safe default location exists.
 */

export const WORK_MEDIA_STORE_DIR = "WORK_MEDIA_STORE_DIR";
export const WORK_MEDIA_TOOLS_IMAGE = "WORK_MEDIA_TOOLS_IMAGE";
export const WORK_MEDIA_WORK_DIR = "WORK_MEDIA_WORK_DIR";
export const WORK_MEDIA_WORKER_CONCURRENCY = "WORK_MEDIA_WORKER_CONCURRENCY";

export const PUBLISHING_WORKER_CONCURRENCY_DEFAULT = 1;
export const PUBLISHING_WORKER_CONCURRENCY_MAX = 4;

export interface PublishingMediaConfig {
  /** Absolute normalized private directory for committed and staged blobs. */
  readonly storeDirectory: string;
  /** Local media tools image with an explicit tag or digest; never pulled. */
  readonly toolsImage: string;
  /** Absolute normalized private directory for sandboxed tool jobs. */
  readonly workDirectory: string;
  /** Jobs leased and run at once by one worker, 1..4. */
  readonly workerConcurrency: number;
}

type Environment = Readonly<Record<string, string | undefined>>;

const MAX_DIRECTORY_LENGTH = 1024;
/** Characters that cannot be bind-mounted safely (the runner refuses them too). */
const MOUNT_UNSAFE = /[,"\n\r\0]/;
/** `name[:tag][@sha256:digest]`, as the media tools runner accepts it. */
const IMAGE_PATTERN =
  /^[a-z0-9][a-z0-9._/-]{0,127}(?::[A-Za-z0-9._-]{1,128})?(?:@sha256:[0-9a-f]{64})?$/;
const IMAGE_TAG_OR_DIGEST = /(?::[A-Za-z0-9._-]{1,128}|@sha256:[0-9a-f]{64})$/;

const configured = (environment: Environment, key: string): string | null => {
  const value = environment[key];
  return value === undefined || value === "" ? null : value;
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

export interface PublishingMediaRuntime {
  readonly store: Pick<
    FilesystemPublishingMediaStore,
    "writeStream" | "openRead" | "remove" | "listBlobs" | "sweepStaging"
  >;
  readonly runner: MediaToolsRunner;
  readonly processor: {
    process(input: ProcessorInput): Promise<ProcessorOutcome>;
  };
}

export interface OpenPublishingMediaOptions {
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

export interface ProductionPublishingMediaConfig extends PublishingCosStoreOptions {
  readonly credentials: () => Promise<CosCredentials>;
  readonly requestTimeoutMs: number;
  readonly toolsImage: string;
  readonly workDirectory: string;
  readonly workerConcurrency: number;
}

/** Required, fail-closed Production configuration. Separate credentials keep
 * UGC write/delete authority independent of Catalog and Payload credentials.
 * Neither parsing nor opening this factory makes a cloud or Docker request.
 */
export function parseProductionPublishingMediaConfig(
  environment: Environment,
): ProductionPublishingMediaConfig {
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
  const toolsImage = required(WORK_MEDIA_TOOLS_IMAGE);
  if (!IMAGE_PATTERN.test(toolsImage) || !IMAGE_TAG_OR_DIGEST.test(toolsImage))
    throw new Error(
      `${WORK_MEDIA_TOOLS_IMAGE} must be a local image reference with an explicit tag or digest`,
    );
  return {
    ...options,
    credentials: async () => ({
      secretId,
      secretKey,
      ...(securityToken ? { securityToken, expiresAt: expiresAt! } : {}),
    }),
    requestTimeoutMs: timeout,
    toolsImage,
    workDirectory: parseDirectory(
      WORK_MEDIA_WORK_DIR,
      required(WORK_MEDIA_WORK_DIR),
    ),
    workerConcurrency: parseConcurrency(
      configured(environment, WORK_MEDIA_WORKER_CONCURRENCY),
    ),
  };
}

export async function openProductionPublishingMedia(
  config: ProductionPublishingMediaConfig,
  options: OpenPublishingMediaOptions & {
    readonly transport?: PublishingCosTransport;
  } = {},
): Promise<PublishingMediaRuntime> {
  assertPublishingCosOptions(config);
  if (
    !Number.isSafeInteger(config.requestTimeoutMs) ||
    config.requestTimeoutMs < 1 ||
    config.requestTimeoutMs > 120_000
  )
    throw new Error("WORK_MEDIA_COS_REQUEST_TIMEOUT_MS is invalid");
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
  const store = new CosPublishingMediaStore(
    config,
    options.transport ?? createPublishingCosTransport(config),
  );
  const runner = await createMediaToolsRunner({
    image: config.toolsImage,
    workDirectory: workReal,
    ...directoryOptions,
  });
  return {
    store,
    runner,
    processor: createPublishingMediaProcessor({ store, runner }),
  };
}

/**
 * Validates both private directories (existing, owner-only, outside temporary
 * storage and Git working trees, not nested in each other or in a foreign
 * namespace), then opens the filesystem store, the sandboxed tools runner and
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
  const runner = await createMediaToolsRunner({
    image: config.toolsImage,
    workDirectory: config.workDirectory,
    ...directoryOptions,
  }).catch(invalidDirectory(WORK_MEDIA_WORK_DIR));
  return {
    store,
    runner,
    processor: createPublishingMediaProcessor({ store, runner }),
  };
};

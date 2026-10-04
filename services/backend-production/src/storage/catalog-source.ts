import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, open } from "node:fs/promises";
import path from "node:path";

import {
  PublishingCosResponseError,
  createPublishingCosTransport,
} from "./publishing-cos-transport.js";

import type COS from "cos-nodejs-sdk-v5";
import type { CosCredentials } from "./cos-read.js";
import type { PublishingCosTransport } from "./publishing-cos-transport.js";

/*
 * Server-side reads of published Catalog source objects for the media worker
 * (unified media pipeline, increment 1). Production reads with the existing
 * Catalog read identity (`COS_*`) through the COS API endpoint of the bucket's
 * region, never the public media domain: ranged GETs bound to the first
 * response's ETag, streamed into the job input while hashing. Development
 * reads the local Payload media directory. Only the two approved key forms
 * are ever read; each embeds the SHA-256 the bytes must have. Errors are
 * content-free codes.
 */

export type CatalogSourceErrorCode =
  /**
   * Missing, forbidden or not an approved key: retried within the job's
   * attempts, then the asset fails until the Catalog sync's delayed retry.
   */
  | "source_unreadable"
  | "source_too_large"
  | "source_hash_mismatch"
  /** Transient (network, changed during the read): retried. */
  | "unavailable"
  | "aborted";

export class CatalogSourceError extends Error {
  constructor(readonly code: CatalogSourceErrorCode) {
    super(`Catalog source read failed: ${code}`);
    this.name = "CatalogSourceError";
  }
}

/** Rejections of a source (the asset fails); every other code is retried. */
export const CATALOG_SOURCE_REJECTIONS: ReadonlySet<CatalogSourceErrorCode> =
  new Set(["source_unreadable", "source_too_large", "source_hash_mismatch"]);

export interface CatalogSourceReadOptions {
  readonly expectedSha256: string;
  readonly maxBytes: number;
  readonly signal?: AbortSignal;
}

export interface CatalogSourceReader {
  /**
   * Copies the object into `targetPath` (new file, 0644) and verifies its
   * size bound and SHA-256. Resolves the byte size and hash.
   */
  read(
    objectKey: string,
    targetPath: string,
    options: CatalogSourceReadOptions,
  ): Promise<{ readonly byteSize: number; readonly sha256: string }>;
}

const DISPLAY_KEY = /^display\/v1\/media_[a-f0-9]{32}\/([a-f0-9]{64})\.webp$/;
const EDITORIAL_KEY =
  /^editorial\/[a-f0-9]{64}\/([a-f0-9]{64}-([a-f0-9]{64})\.(?:jpg|png|webp))$/;
const SHA256 = /^[0-9a-f]{64}$/;
const READ_BYTES = 1024 * 1024;

/** True for the two approved Catalog object key forms. */
export const isApprovedCatalogObjectKey = (key: string): boolean =>
  DISPLAY_KEY.test(key) || EDITORIAL_KEY.test(key);

/** The byte SHA-256 an approved key embeds, or null. */
export const catalogKeySha256 = (key: string): string | null =>
  DISPLAY_KEY.exec(key)?.[1] ?? EDITORIAL_KEY.exec(key)?.[2] ?? null;

const assertRead = (objectKey: string, options: CatalogSourceReadOptions) => {
  if (
    !SHA256.test(options.expectedSha256) ||
    !Number.isSafeInteger(options.maxBytes) ||
    options.maxBytes < 1
  )
    throw new TypeError("Invalid Catalog source read");
  if (catalogKeySha256(objectKey) !== options.expectedSha256) {
    throw new CatalogSourceError("source_unreadable");
  }
};

/** Writes chunks to a new 0644 file while hashing; verifies size and hash. */
async function copyInto(
  targetPath: string,
  chunks: AsyncIterable<Uint8Array>,
  options: CatalogSourceReadOptions,
) {
  const handle = await open(targetPath, "wx", 0o644);
  const hash = createHash("sha256");
  let byteSize = 0;
  try {
    for await (const chunk of chunks) {
      if (options.signal?.aborted) throw new CatalogSourceError("aborted");
      byteSize += chunk.byteLength;
      if (byteSize > options.maxBytes) {
        throw new CatalogSourceError("source_too_large");
      }
      hash.update(chunk);
      await handle.write(chunk);
    }
  } finally {
    await handle.close().catch(() => undefined);
  }
  await chmod(targetPath, 0o644);
  const sha256 = hash.digest("hex");
  if (byteSize < 1 || sha256 !== options.expectedSha256) {
    throw new CatalogSourceError("source_hash_mismatch");
  }
  return { byteSize, sha256 };
}

const statusOf = (error: unknown): number | null =>
  error instanceof PublishingCosResponseError ? error.statusCode : null;

/** Production reader: the Catalog read identity over the COS API endpoint. */
export class CosCatalogSourceReader implements CatalogSourceReader {
  constructor(
    private readonly options: {
      readonly bucket: string;
      readonly region: string;
    },
    private readonly transport: PublishingCosTransport,
  ) {
    if (
      !/^[a-z0-9][a-z0-9-]{1,49}-[0-9]{5,20}$/.test(options.bucket) ||
      !/^[a-z]{2}-[a-z]+(?:-[a-z]+)?$/.test(options.region)
    )
      throw new Error("COS bucket or region invalid");
  }

  async read(
    objectKey: string,
    targetPath: string,
    options: CatalogSourceReadOptions,
  ) {
    assertRead(objectKey, options);
    const base = {
      Bucket: this.options.bucket,
      Region: this.options.region,
      Key: objectKey,
      DataType: "buffer",
    };
    const transport = this.transport;
    const request = async (start: number, end: number, etag: string | null) => {
      try {
        return await transport.request<COS.GetObjectResult>(
          "getObject",
          {
            ...base,
            Range: `bytes=${start}-${end}`,
            ...(etag === null ? {} : { IfMatch: etag }),
          },
          options.signal,
          end - start + 1,
        );
      } catch (error) {
        if (options.signal?.aborted) throw new CatalogSourceError("aborted");
        const status = statusOf(error);
        if (status === 403 || status === 404 || status === 416) {
          throw new CatalogSourceError("source_unreadable");
        }
        throw new CatalogSourceError("unavailable");
      }
    };
    const first = await request(0, READ_BYTES - 1, null);
    const range = /^bytes 0-(\d+)\/(\d+)$/.exec(
      String(first.headers?.["content-range"] ?? ""),
    );
    const etag = first.headers?.etag;
    if (
      first.statusCode !== 206 ||
      range === null ||
      typeof etag !== "string" ||
      etag === "" ||
      /[\r\n]/.test(etag)
    )
      throw new CatalogSourceError("unavailable");
    const total = Number(range[2]);
    if (!Number.isSafeInteger(total) || total < 1) {
      throw new CatalogSourceError("source_unreadable");
    }
    if (total > options.maxBytes) {
      throw new CatalogSourceError("source_too_large");
    }
    if (
      Number(range[1]) !== Math.min(READ_BYTES, total) - 1 ||
      first.rawBody.length !== Math.min(READ_BYTES, total)
    )
      throw new CatalogSourceError("unavailable");
    return copyInto(
      targetPath,
      (async function* () {
        yield first.rawBody;
        for (let start = READ_BYTES; start < total; start += READ_BYTES) {
          const end = Math.min(start + READ_BYTES, total) - 1;
          const part = await request(start, end, etag);
          if (
            part.statusCode !== 206 ||
            part.headers?.["content-range"] !==
              `bytes ${start}-${end}/${total}` ||
            part.rawBody.length !== end - start + 1
          )
            throw new CatalogSourceError("unavailable");
          yield part.rawBody;
        }
      })(),
      options,
    ).catch((error: unknown) => {
      throw error instanceof CatalogSourceError
        ? error
        : new CatalogSourceError("unavailable");
    });
  }
}

/**
 * Development reader: approved editorial keys resolve to the file of the same
 * name in the local Payload media directory (no links, regular files only).
 * Pilot `display/v1/` keys have no local file and are unreadable.
 */
export class LocalCatalogSourceReader implements CatalogSourceReader {
  constructor(private readonly mediaDirectory: string) {
    if (!path.isAbsolute(mediaDirectory)) {
      throw new Error("CMS_MEDIA_DIR must resolve to an absolute directory");
    }
  }

  async read(
    objectKey: string,
    targetPath: string,
    options: CatalogSourceReadOptions,
  ) {
    assertRead(objectKey, options);
    const name = EDITORIAL_KEY.exec(objectKey)?.[1];
    if (name === undefined) throw new CatalogSourceError("source_unreadable");
    const sourcePath = path.join(this.mediaDirectory, name);
    const info = await lstat(sourcePath).catch(() => null);
    if (!info?.isFile()) throw new CatalogSourceError("source_unreadable");
    if (info.size > options.maxBytes) {
      throw new CatalogSourceError("source_too_large");
    }
    let handle;
    try {
      handle = await open(
        sourcePath,
        constants.O_RDONLY | constants.O_NOFOLLOW,
      );
    } catch {
      throw new CatalogSourceError("source_unreadable");
    }
    try {
      return await copyInto(
        targetPath,
        handle.createReadStream({
          autoClose: false,
          highWaterMark: READ_BYTES,
        }),
        options,
      );
    } finally {
      await handle.close().catch(() => undefined);
    }
  }
}

export interface CatalogSourceConfig {
  readonly bucket: string;
  readonly region: string;
  readonly credentials: () => Promise<CosCredentials>;
  readonly requestTimeoutMs: number;
}

type Environment = Readonly<Record<string, string | undefined>>;

const CATALOG_COS_KEYS = [
  "COS_BUCKET",
  "COS_REGION",
  "COS_SECRET_ID",
  "COS_SECRET_KEY",
] as const;

/**
 * The Catalog read identity for source reads (`COS_*`, the same keys the
 * Backend signs Catalog URLs with). `null` when none of the four required
 * keys is set (Catalog processing off); a partial or malformed value fails
 * with a message that names the key and never echoes its value.
 */
export function parseCatalogSourceConfig(
  environment: Environment,
): CatalogSourceConfig | null {
  if (CATALOG_COS_KEYS.every((key) => !environment[key])) return null;
  const required = (key: string): string => {
    const value = environment[key];
    if (!value || value.trim() !== value || /[\r\n\0]/.test(value))
      throw new Error(
        `Catalog source configuration missing or invalid: ${key}`,
      );
    return value;
  };
  const integer = (key: string): number => {
    const value = required(key);
    if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value)))
      throw new Error(`Catalog source configuration invalid: ${key}`);
    return Number(value);
  };
  const bucket = required("COS_BUCKET");
  const region = required("COS_REGION");
  const secretId = required("COS_SECRET_ID");
  const secretKey = required("COS_SECRET_KEY");
  if (!/^[A-Za-z0-9_-]+$/.test(secretId))
    throw new Error("Catalog source configuration invalid: COS_SECRET_ID");
  const temporary =
    environment.COS_SECURITY_TOKEN === undefined
      ? {}
      : {
          securityToken: required("COS_SECURITY_TOKEN"),
          expiresAt: integer("COS_CREDENTIAL_EXPIRES_AT"),
        };
  const requestTimeoutMs =
    environment.COS_REQUEST_TIMEOUT_MS === undefined
      ? 30_000
      : integer("COS_REQUEST_TIMEOUT_MS");
  if (requestTimeoutMs > 120_000)
    throw new Error(
      "Catalog source configuration invalid: COS_REQUEST_TIMEOUT_MS",
    );
  return {
    bucket,
    region,
    credentials: async () => ({ secretId, secretKey, ...temporary }),
    requestTimeoutMs,
  };
}

/** Opens the Production reader; no cloud request is made here. */
export const openCosCatalogSourceReader = (
  config: CatalogSourceConfig,
  transport?: PublishingCosTransport,
): CosCatalogSourceReader =>
  new CosCatalogSourceReader(
    config,
    transport ?? createPublishingCosTransport(config),
  );

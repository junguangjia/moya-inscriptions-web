import { createHash, randomBytes, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  link,
  lstat,
  mkdir,
  open,
  opendir,
  readdir,
  realpath,
  unlink,
} from "node:fs/promises";
import path from "node:path";

import type { FileHandle } from "node:fs/promises";
import type { Readable } from "node:stream";

import { PublishingMediaStoreError } from "./publishing-media-error.js";
export { PublishingMediaStoreError } from "./publishing-media-error.js";
export type { PublishingMediaStoreErrorCode } from "./publishing-media-error.js";
const SYSTEM_CODE_PATTERN = /^E[A-Z0-9]{1,31}$/;

/** Keeps store errors content-free: raw filesystem errors carry host paths. */
const storeFailure = (error: unknown): PublishingMediaStoreError => {
  if (error instanceof PublishingMediaStoreError) return error;
  const code = errorCode(error) ?? "";
  return new PublishingMediaStoreError(
    "unavailable",
    SYSTEM_CODE_PATTERN.test(code) ? code : null,
  );
};

export interface PublishingMediaStoreBlobEntry {
  readonly storageKey: string;
  readonly byteSize: number;
  readonly modifiedAt: Date;
}

export type PublishingMediaStorePurpose =
  "original" | "standard_master" | "derivative";

export type PublishingMediaStoreContentType =
  | "image/jpeg"
  | "image/png"
  | "image/webp"
  | "image/heic"
  | "image/heif"
  | "video/quicktime"
  | "video/mp4";

export type PublishingMediaStoreRange =
  | { readonly start: number; readonly end?: number }
  | { readonly suffixLength: number };

export type PublishingMediaStoreRead =
  | {
      readonly status: "ok";
      readonly byteSize: number;
      readonly start: number;
      readonly end: number;
      readonly contentLength: number;
      readonly body: Readable;
      close(): Promise<void>;
    }
  | { readonly status: "range_not_satisfiable"; readonly byteSize: number };

export interface PrivateMediaDirectoryOptions {
  /**
   * Temporary-storage roots the directory must not be under. Defaults to
   * {@link PUBLISHING_MEDIA_TEMPORARY_ROOTS}; only unit tests narrow it.
   */
  readonly temporaryRoots?: readonly string[];
}

/** Temporary storage never holds retained publishing bytes or tool jobs. */
export const PUBLISHING_MEDIA_TEMPORARY_ROOTS: readonly string[] = [
  "/tmp",
  "/private/tmp",
  "/var/folders",
  "/private/var/folders",
];

/** Sanitized storage key shape (also enforced by `media_blobs`). */
export const PUBLISHING_BLOB_KEY_PATTERN =
  /^blobs\/([0-9a-f]{2})\/([0-9a-f]{2})\/([0-9a-f]{32})$/;
const STAGING_NAME_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.part$/;
export const OWNER_ID_PATTERN = /^\S{1,128}$/;
export const PURPOSES = new Set<string>([
  "original",
  "standard_master",
  "derivative",
]);
export const CONTENT_TYPES = new Set<string>([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/heic",
  "image/heif",
  "video/quicktime",
  "video/mp4",
]);
/** Sanity bound for a single blob; business limits are stricter. */
export const MAX_BLOB_BYTES = 4 * 1024 * 1024 * 1024;
const READ_HIGH_WATER_MARK = 256 * 1024;
/** Staging files removed per sweep call; call again while the limit is hit. */
export const PUBLISHING_STAGING_SWEEP_LIMIT = 1000;
/** Largest `listBlobs` page. */
export const PUBLISHING_BLOB_LIST_LIMIT = 1000;
const HEX2_PATTERN = /^[0-9a-f]{2}$/;
const HEX32_PATTERN = /^[0-9a-f]{32}$/;

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String((error as { code: unknown }).code)
    : undefined;
}

const isWithin = (candidate: string, root: string) =>
  candidate === root || candidate.startsWith(`${root}${path.sep}`);

const pathExists = async (candidate: string): Promise<boolean> => {
  let code: string | undefined;
  try {
    await lstat(candidate);
    return true;
  } catch (error) {
    code = errorCode(error);
  }
  if (code === "ENOENT" || code === "ENOTDIR") return false;
  // Fail closed without echoing the configured path.
  throw new Error("Publishing media directory ancestry cannot be verified");
};

const assertOwnerOnly = (info: { uid: number; mode: number }) => {
  const uid = process.getuid?.();
  if ((uid !== undefined && info.uid !== uid) || (info.mode & 0o077) !== 0) {
    throw new Error(
      "Publishing media directory must be owned by the current user with owner-only permissions",
    );
  }
};

/**
 * Validates a configured private media directory and returns its real path:
 * absolute and normalized, an existing non-symlink directory owned by the
 * current user with owner-only permissions, outside temporary storage and
 * outside any directory tree that contains a `.git` entry.
 */
export async function assertPrivateMediaDirectory(
  directory: string,
  options: PrivateMediaDirectoryOptions = {},
): Promise<string> {
  if (
    typeof directory !== "string" ||
    directory.length > 1024 ||
    !path.isAbsolute(directory) ||
    path.normalize(directory) !== directory ||
    (directory.endsWith(path.sep) && directory !== path.sep) ||
    directory === path.parse(directory).root
  ) {
    throw new Error(
      "Publishing media directory must be an absolute normalized path",
    );
  }
  let info;
  try {
    info = await lstat(directory);
  } catch {
    throw new Error("Publishing media directory must exist");
  }
  if (!info.isDirectory()) {
    throw new Error("Publishing media directory must be a real directory");
  }
  const real = await realpath(directory);
  const temporaryRoots =
    options.temporaryRoots ?? PUBLISHING_MEDIA_TEMPORARY_ROOTS;
  if (
    temporaryRoots.some(
      (root) => isWithin(directory, root) || isWithin(real, root),
    )
  ) {
    throw new Error(
      "Publishing media directory must not be under temporary storage",
    );
  }
  assertOwnerOnly(info);
  let current = real;
  for (;;) {
    if (await pathExists(path.join(current, ".git"))) {
      throw new Error(
        "Publishing media directory must not be inside a Git working tree",
      );
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return real;
}

const ensurePrivateSubdirectory = async (directory: string) => {
  try {
    await mkdir(directory, { mode: 0o700 });
  } catch (error) {
    if (errorCode(error) !== "EEXIST") throw error;
  }
  const info = await lstat(directory);
  if (!info.isDirectory()) {
    throw new Error("Publishing media subdirectory must be a real directory");
  }
  assertOwnerOnly(info);
};

const syncDirectory = async (directory: string) => {
  let handle: FileHandle | undefined;
  try {
    handle = await open(directory, constants.O_RDONLY);
    await handle.sync();
  } catch (error) {
    const code = errorCode(error);
    if (code !== "EINVAL" && code !== "EISDIR" && code !== "EPERM") throw error;
  } finally {
    await handle?.close();
  }
};

const writeAll = async (handle: FileHandle, chunk: Uint8Array) => {
  let offset = 0;
  while (offset < chunk.byteLength) {
    const { bytesWritten } = await handle.write(
      chunk,
      offset,
      chunk.byteLength - offset,
    );
    offset += bytesWritten;
  }
};

/** Pulls chunks until done, stopping promptly when `signal` aborts. */
export const consume = async (
  source: AsyncIterable<Uint8Array>,
  signal: AbortSignal | undefined,
  onChunk: (chunk: Uint8Array) => Promise<void>,
) => {
  const iterator = source[Symbol.asyncIterator]();
  const pull = (): Promise<IteratorResult<Uint8Array>> => {
    if (!signal) return iterator.next();
    return new Promise((resolve, reject) => {
      const onAbort = () => reject(new PublishingMediaStoreError("aborted"));
      signal.addEventListener("abort", onAbort, { once: true });
      iterator.next().then(
        (result) => {
          signal.removeEventListener("abort", onAbort);
          resolve(result);
        },
        (error: unknown) => {
          signal.removeEventListener("abort", onAbort);
          reject(error);
        },
      );
    });
  };
  try {
    for (;;) {
      if (signal?.aborted) throw new PublishingMediaStoreError("aborted");
      const next = await pull();
      if (next.done) return;
      if (!(next.value instanceof Uint8Array)) {
        throw new PublishingMediaStoreError("invalid_argument");
      }
      await onChunk(next.value);
    }
  } catch (error) {
    // Release the producer; a pending read is not awaited.
    void Promise.resolve()
      .then(() => iterator.return?.())
      .catch(() => undefined);
    throw error;
  }
};

export const resolveRange = (
  range: PublishingMediaStoreRange | undefined,
  byteSize: number,
): { start: number; end: number } | null => {
  const integer = (value: unknown): value is number =>
    typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
  if (range === undefined) return { start: 0, end: byteSize - 1 };
  if ("suffixLength" in range) {
    if (!integer(range.suffixLength)) {
      throw new PublishingMediaStoreError("invalid_argument");
    }
    if (range.suffixLength === 0) return null;
    return {
      start: Math.max(0, byteSize - range.suffixLength),
      end: byteSize - 1,
    };
  }
  if (
    !integer(range.start) ||
    (range.end !== undefined &&
      (!integer(range.end) || range.end < range.start))
  ) {
    throw new PublishingMediaStoreError("invalid_argument");
  }
  if (range.start >= byteSize) return null;
  return {
    start: range.start,
    end: Math.min(range.end ?? byteSize - 1, byteSize - 1),
  };
};

/**
 * Development filesystem adapter for private publishing bytes. Layout:
 * `<root>/blobs/aa/bb/<32hex>` for committed blobs and
 * `<root>/staging/<uuid>.part` for in-flight writes. Keys are generated here
 * and are never derived from user input.
 */
export class FilesystemPublishingMediaStore {
  /** Staging file names of writes in progress in this process. */
  private readonly inFlight = new Set<string>();

  private constructor(private readonly root: string) {}

  static async open(
    rootDirectory: string,
    options: PrivateMediaDirectoryOptions = {},
  ): Promise<FilesystemPublishingMediaStore> {
    const root = await assertPrivateMediaDirectory(rootDirectory, options);
    await ensurePrivateSubdirectory(path.join(root, "blobs"));
    await ensurePrivateSubdirectory(path.join(root, "staging"));
    return new FilesystemPublishingMediaStore(root);
  }

  async writeStream(
    ownerId: string,
    purpose: PublishingMediaStorePurpose,
    contentType: PublishingMediaStoreContentType,
    maxBytes: number,
    source: AsyncIterable<Uint8Array>,
    options: {
      readonly signal?: AbortSignal;
      readonly requireExactSize?: boolean;
    } = {},
  ): Promise<{ storageKey: string; byteSize: number; sha256: string }> {
    if (
      typeof ownerId !== "string" ||
      !OWNER_ID_PATTERN.test(ownerId) ||
      !PURPOSES.has(purpose) ||
      !CONTENT_TYPES.has(contentType) ||
      !Number.isSafeInteger(maxBytes) ||
      maxBytes < 1 ||
      maxBytes > MAX_BLOB_BYTES ||
      source === null ||
      typeof source !== "object" ||
      typeof source[Symbol.asyncIterator] !== "function"
    ) {
      throw new PublishingMediaStoreError("invalid_argument");
    }
    if (options.signal?.aborted) throw new PublishingMediaStoreError("aborted");
    const stagingDirectory = path.join(this.root, "staging");
    const stagingName = `${randomUUID()}.part`;
    const stagingPath = path.join(stagingDirectory, stagingName);
    this.inFlight.add(stagingName);
    let handle: FileHandle | undefined;
    try {
      handle = await open(stagingPath, "wx", 0o600);
      const hash = createHash("sha256");
      let byteSize = 0;
      const writer = handle;
      await consume(source, options.signal, async (chunk) => {
        byteSize += chunk.byteLength;
        if (byteSize > maxBytes) {
          throw new PublishingMediaStoreError("size_limit_exceeded");
        }
        hash.update(chunk);
        await writeAll(writer, chunk);
      });
      if (byteSize === 0) throw new PublishingMediaStoreError("empty_content");
      if (options.requireExactSize && byteSize !== maxBytes) {
        throw new PublishingMediaStoreError("size_mismatch");
      }
      if (options.signal?.aborted) {
        throw new PublishingMediaStoreError("aborted");
      }
      await handle.sync();
      await handle.close();
      handle = undefined;
      const storageKey = await this.linkIntoPlace(stagingPath);
      // The blob is durable; a leftover staging link is swept later.
      await unlink(stagingPath).catch(() => undefined);
      await syncDirectory(stagingDirectory).catch(() => undefined);
      return { storageKey, byteSize, sha256: hash.digest("hex") };
    } catch (error) {
      await handle?.close().catch(() => undefined);
      await unlink(stagingPath).catch(() => undefined);
      throw storeFailure(error);
    } finally {
      this.inFlight.delete(stagingName);
    }
  }

  async openRead(
    storageKey: string,
    range?: PublishingMediaStoreRange,
  ): Promise<PublishingMediaStoreRead | null> {
    const filePath = this.blobPath(storageKey);
    let handle: FileHandle | undefined;
    try {
      if (!(await this.blobDirectoriesExist(storageKey))) return null;
      try {
        handle = await open(
          filePath,
          constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
        );
      } catch (error) {
        const code = errorCode(error);
        if (code === "ENOENT") return null;
        if (code === "ELOOP" || code === "EMLINK") {
          throw new PublishingMediaStoreError("not_regular_file");
        }
        throw error;
      }
      const info = await handle.stat();
      if (!info.isFile()) {
        throw new PublishingMediaStoreError("not_regular_file");
      }
      const byteSize = info.size;
      const resolved = byteSize > 0 ? resolveRange(range, byteSize) : null;
      if (!resolved) {
        await handle.close();
        return { status: "range_not_satisfiable", byteSize };
      }
      const body = handle.createReadStream({
        start: resolved.start,
        end: resolved.end,
        autoClose: true,
        highWaterMark: READ_HIGH_WATER_MARK,
      });
      return {
        status: "ok",
        byteSize,
        start: resolved.start,
        end: resolved.end,
        contentLength: resolved.end - resolved.start + 1,
        body,
        close: () =>
          new Promise<void>((resolve) => {
            if (body.closed) return resolve();
            body.once("close", () => resolve());
            body.destroy();
          }),
      };
    } catch (error) {
      await handle?.close().catch(() => undefined);
      throw storeFailure(error);
    }
  }

  async remove(storageKey: string): Promise<void> {
    const filePath = this.blobPath(storageKey);
    try {
      if (!(await this.blobDirectoriesExist(storageKey))) return;
      try {
        await unlink(filePath);
      } catch (error) {
        if (errorCode(error) === "ENOENT") return;
        throw error;
      }
      await syncDirectory(path.dirname(filePath));
    } catch (error) {
      throw storeFailure(error);
    }
  }

  /**
   * Lists committed blobs in ascending key order after `after`, at most
   * `limit` per page. Entries that are not regular files are skipped.
   */
  async listBlobs(options: {
    readonly after?: string | null;
    readonly limit: number;
  }): Promise<{
    entries: PublishingMediaStoreBlobEntry[];
    nextAfter: string | null;
  }> {
    const after = options.after ?? null;
    if (
      !Number.isSafeInteger(options.limit) ||
      options.limit < 1 ||
      options.limit > PUBLISHING_BLOB_LIST_LIMIT
    ) {
      throw new PublishingMediaStoreError("invalid_argument");
    }
    if (after !== null) this.blobPath(after);
    const [, afterFirst = "", afterSecond = ""] = after?.split("/") ?? [];
    const entries: PublishingMediaStoreBlobEntry[] = [];
    try {
      const blobs = path.join(this.root, "blobs");
      for (const first of await sortedDirectories(blobs, HEX2_PATTERN)) {
        if (first < afterFirst) continue;
        const firstPath = path.join(blobs, first);
        for (const second of await sortedDirectories(firstPath, HEX2_PATTERN)) {
          if (first === afterFirst && second < afterSecond) continue;
          const secondPath = path.join(firstPath, second);
          const names = (await readdir(secondPath))
            .filter(
              (name) =>
                HEX32_PATTERN.test(name) &&
                name.slice(0, 2) === first &&
                name.slice(2, 4) === second,
            )
            .sort();
          for (const name of names) {
            const storageKey = `blobs/${first}/${second}/${name}`;
            if (after !== null && storageKey <= after) continue;
            const info = await lstat(path.join(secondPath, name)).catch(
              (error: unknown) => {
                if (errorCode(error) === "ENOENT") return null;
                throw error;
              },
            );
            if (!info?.isFile()) continue;
            entries.push({
              storageKey,
              byteSize: info.size,
              modifiedAt: new Date(info.mtimeMs),
            });
            if (entries.length === options.limit) {
              return { entries, nextAfter: storageKey };
            }
          }
        }
      }
    } catch (error) {
      throw storeFailure(error);
    }
    return { entries, nextAfter: null };
  }

  /**
   * Removes abandoned staging files last modified before `olderThan`, at
   * most {@link PUBLISHING_STAGING_SWEEP_LIMIT} per call. Writes in progress
   * in this process are never removed; the cutoff must exceed the longest
   * upload stall allowed elsewhere.
   */
  async sweepStaging(olderThan: Date): Promise<{ removed: number }> {
    const cutoff = olderThan.getTime();
    if (!Number.isFinite(cutoff)) {
      throw new PublishingMediaStoreError("invalid_argument");
    }
    const stagingDirectory = path.join(this.root, "staging");
    let removed = 0;
    try {
      for await (const entry of await opendir(stagingDirectory)) {
        if (removed >= PUBLISHING_STAGING_SWEEP_LIMIT) break;
        if (
          !STAGING_NAME_PATTERN.test(entry.name) ||
          this.inFlight.has(entry.name)
        ) {
          continue;
        }
        const entryPath = path.join(stagingDirectory, entry.name);
        try {
          const info = await lstat(entryPath);
          if (!info.isFile() || info.mtimeMs >= cutoff) continue;
          await unlink(entryPath);
          removed += 1;
        } catch (error) {
          if (errorCode(error) !== "ENOENT") throw error;
        }
      }
      if (removed > 0) await syncDirectory(stagingDirectory);
    } catch (error) {
      throw storeFailure(error);
    }
    return { removed };
  }

  private blobPath(storageKey: string): string {
    const match =
      typeof storageKey === "string"
        ? PUBLISHING_BLOB_KEY_PATTERN.exec(storageKey)
        : null;
    if (
      !match ||
      match[3]!.slice(0, 2) !== match[1] ||
      match[3]!.slice(2, 4) !== match[2]
    ) {
      throw new PublishingMediaStoreError("invalid_key");
    }
    return path.join(this.root, "blobs", match[1]!, match[2]!, match[3]!);
  }

  /** Intermediate key directories must be real directories, never links. */
  private async blobDirectoriesExist(storageKey: string): Promise<boolean> {
    const [, first, second] = storageKey.split("/");
    const blobs = path.join(this.root, "blobs");
    for (const directory of [
      path.join(blobs, first!),
      path.join(blobs, first!, second!),
    ]) {
      try {
        const info = await lstat(directory);
        if (!info.isDirectory()) {
          throw new PublishingMediaStoreError("not_regular_file");
        }
      } catch (error) {
        if (errorCode(error) === "ENOENT") return false;
        throw error;
      }
    }
    return true;
  }

  private async linkIntoPlace(stagingPath: string): Promise<string> {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const hex = randomBytes(16).toString("hex");
      const storageKey = `blobs/${hex.slice(0, 2)}/${hex.slice(2, 4)}/${hex}`;
      const target = this.blobPath(storageKey);
      const directory = path.dirname(target);
      const created = await mkdir(directory, { recursive: true, mode: 0o700 });
      if (!(await this.blobDirectoriesExist(storageKey))) {
        throw new PublishingMediaStoreError("unavailable");
      }
      try {
        // link() never replaces an existing entry (EEXIST).
        await link(stagingPath, target);
      } catch (error) {
        if (errorCode(error) === "EEXIST") continue;
        throw error;
      }
      try {
        await syncDirectory(directory);
        if (created !== undefined) {
          await syncDirectory(path.dirname(directory));
          await syncDirectory(path.join(this.root, "blobs"));
        }
      } catch (error) {
        await unlink(target).catch(() => undefined);
        throw error;
      }
      return storageKey;
    }
    throw new PublishingMediaStoreError("unavailable");
  }
}

/** Sorted names of real (non-link) subdirectories matching `pattern`. */
async function sortedDirectories(
  directory: string,
  pattern: RegExp,
): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isDirectory() && pattern.test(entry.name))
    .map((entry) => entry.name)
    .sort();
}

// Existing module boundary: no package-export or composition changes required.
export {
  CosPublishingMediaStore,
  PUBLISHING_COS_PART_BYTES,
  PUBLISHING_COS_READ_BYTES,
} from "./publishing-cos-store.js";
export {
  createPublishingCosTransport,
  PublishingCosResponseError,
} from "./publishing-cos-transport.js";
export type {
  PublishingCosTransport,
  PublishingCosMethod,
} from "./publishing-cos-transport.js";

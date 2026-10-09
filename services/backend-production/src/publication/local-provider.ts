import { createHash, randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { link, lstat, mkdir, open, realpath, unlink } from "node:fs/promises";
import { isAbsolute, join } from "node:path";

import { allowsPublication } from "./config.js";
import {
  validatePublishedKey,
  validatePublishedOrigin,
  validatePublishedUnit,
  validatePurgeTarget,
} from "./keys.js";
import {
  PublicationProviderError,
  assertPublicationSignal,
  publicationPlanMonth,
} from "./provider.js";
import type { PublicationConfig } from "./config.js";
import type { PublicationProvider } from "./provider.js";

const missing = (error: unknown): boolean =>
  typeof error === "object" &&
  error !== null &&
  "code" in error &&
  error.code === "ENOENT";

/** Development filesystem implementation. No server or public listener is
 * created here. Only validated v1 derivative paths can be read or removed.
 */
export function createLocalPublicationProvider(
  config: PublicationConfig,
): PublicationProvider {
  if (
    config.nodeEnv !== "development" ||
    !config.localRoot ||
    !isAbsolute(config.localRoot) ||
    !config.origin
  )
    throw new PublicationProviderError("invalid");
  const root = config.localRoot;
  const origin = validatePublishedOrigin(config.origin, true);
  const localHost = new URL(origin).hostname;
  if (!["localhost", "127.0.0.1", "[::1]"].includes(localHost))
    throw new PublicationProviderError("invalid");
  let resolvedRoot: Promise<string> | undefined;
  const rootPath = () =>
    (resolvedRoot ??= (async () => {
      await mkdir(root, { recursive: true, mode: 0o700 });
      if ((await lstat(root)).isSymbolicLink())
        throw new PublicationProviderError("invalid");
      return realpath(root);
    })());
  const path = async (key: string, create: boolean): Promise<string> => {
    validatePublishedKey(key);
    const segments = key.split("/");
    let directory = await rootPath();
    for (const segment of segments.slice(0, -1)) {
      directory = join(directory, segment);
      if (create)
        await mkdir(directory, { mode: 0o700 }).catch((error) => {
          if (!(
            typeof error === "object" &&
            error !== null &&
            "code" in error &&
            error.code === "EEXIST"
          ))
            throw error;
        });
      const stat = await lstat(directory);
      if (!stat.isDirectory() || stat.isSymbolicLink())
        throw new PublicationProviderError("invalid");
    }
    return join(directory, segments.at(-1)!);
  };
  const guarded = async <T>(
    operation: () => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> => {
    assertPublicationSignal(signal);
    try {
      return await operation();
    } catch (error) {
      if (signal?.aborted) throw new PublicationProviderError("aborted");
      if (error instanceof PublicationProviderError) throw error;
      throw new PublicationProviderError("unavailable");
    }
  };
  const head: PublicationProvider["head"] = async (key, signal) => {
    validatePublishedKey(key);
    return guarded(async () => {
      try {
        const handle = await open(
          await path(key, false),
          constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
        );
        try {
          const info = await handle.stat();
          if (!info.isFile() || info.size < 1 || info.size > 5 * 1024 ** 3)
            throw new PublicationProviderError("integrity");
          const md5 = createHash("md5");
          let bytes = 0;
          const stream = handle.createReadStream({
            autoClose: false,
            ...(signal ? { signal } : {}),
          });
          try {
            for await (const chunk of stream) {
              assertPublicationSignal(signal);
              if (
                !Buffer.isBuffer(chunk) ||
                (bytes += chunk.byteLength) > info.size
              )
                throw new PublicationProviderError("integrity");
              md5.update(chunk);
            }
          } finally {
            stream.destroy();
          }
          if (bytes !== info.size)
            throw new PublicationProviderError("integrity");
          return { byteSize: bytes, etag: md5.digest("hex") };
        } finally {
          await handle.close();
        }
      } catch (error) {
        if (missing(error)) return undefined;
        throw error;
      }
    }, signal);
  };
  return {
    head,
    async write(unit, source, signal) {
      if (!allowsPublication(config))
        throw new PublicationProviderError("disabled");
      validatePublishedUnit(unit);
      return guarded(async () => {
        const finalPath = await path(unit.objectKey, true);
        const temporary = `${finalPath}.${randomBytes(16).toString("hex")}.partial`;
        const handle = await open(temporary, "wx", 0o600);
        const md5 = createHash("md5");
        let bytes = 0;
        try {
          for await (const chunk of source) {
            assertPublicationSignal(signal);
            if (
              !(chunk instanceof Uint8Array) ||
              (bytes += chunk.byteLength) > unit.byteSize
            )
              throw new PublicationProviderError("integrity");
            md5.update(chunk);
            let offset = 0;
            while (offset < chunk.byteLength) {
              const written = await handle.write(
                chunk,
                offset,
                chunk.byteLength - offset,
              );
              if (written.bytesWritten < 1)
                throw new PublicationProviderError("unavailable");
              offset += written.bytesWritten;
            }
          }
          if (bytes !== unit.byteSize)
            throw new PublicationProviderError("integrity");
          assertPublicationSignal(signal);
          await handle.sync();
          // Atomic creation, never overwrite an existing immutable generation.
          await link(temporary, finalPath);
          return { byteSize: bytes, etag: md5.digest("hex") };
        } finally {
          await handle.close();
          await unlink(temporary).catch((error) => {
            if (!missing(error))
              throw new PublicationProviderError("unavailable");
          });
        }
      }, signal);
    },
    async remove(key, signal) {
      validatePublishedKey(key);
      return guarded(async () => {
        try {
          await unlink(await path(key, false));
        } catch (error) {
          if (!missing(error)) throw error;
        }
      }, signal);
    },
    async purge(targets, type, signal) {
      if (
        !targets.length ||
        targets.length > 100 ||
        new Set(targets).size !== targets.length
      )
        throw new PublicationProviderError("invalid");
      for (const target of targets) validatePurgeTarget(origin, target, type);
      return guarded(
        async () => `local-${randomBytes(16).toString("hex")}`,
        signal,
      );
    },
    async purgeStatus(jobId, signal) {
      if (!/^local-[0-9a-f]{32}$/u.test(jobId))
        throw new PublicationProviderError("invalid");
      // This local provider has no edge cache; filesystem denial is verified by
      // verifyGone. This result is synthetic, never Production CDN acceptance.
      return guarded(async () => "succeeded" as const, signal);
    },
    async verifyGone(target, signal) {
      validatePurgeTarget(origin, target, "file");
      return guarded(
        async () =>
          (await head(new URL(target).pathname.slice(1), signal)) === undefined,
        signal,
      );
    },
    async monthlyRequests(now, signal) {
      return guarded(
        async () => ({
          start: publicationPlanMonth(now),
          end: now,
          requests: 0,
          warning: false,
        }),
        signal,
      );
    },
  };
}

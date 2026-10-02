import { createHash, randomBytes } from "node:crypto";
import { Readable } from "node:stream";

import {
  CONTENT_TYPES,
  MAX_BLOB_BYTES,
  OWNER_ID_PATTERN,
  PURPOSES,
  PUBLISHING_BLOB_KEY_PATTERN,
  PublishingMediaStoreError,
  consume,
  resolveRange,
} from "./publishing-media-store.js";
import { PublishingCosResponseError } from "./publishing-cos-transport.js";

import type COS from "cos-nodejs-sdk-v5";
import type { PublishingCosTransport } from "./publishing-cos-transport.js";
import type {
  PublishingMediaStoreContentType,
  PublishingMediaStorePurpose,
  PublishingMediaStoreRange,
  PublishingMediaStoreRead,
} from "./publishing-media-store.js";

export const PUBLISHING_COS_PART_BYTES = 8 * 1024 * 1024;
export const PUBLISHING_COS_READ_BYTES = 1024 * 1024;
const failure = () => new PublishingMediaStoreError("unavailable");
const missing = (error: unknown) =>
  error instanceof PublishingCosResponseError && error.statusCode === 404;
const safeError = (error: unknown) =>
  error instanceof PublishingMediaStoreError ? error : failure();
const validKey = (key: string) => {
  const match =
    typeof key === "string" && PUBLISHING_BLOB_KEY_PATTERN.exec(key);
  return Boolean(match && match[3]!.startsWith(`${match[1]}${match[2]}`));
};
const header = (result: COS.GeneralResult, key: string) =>
  result.headers?.[key];
const size = (value: unknown): number => {
  if (typeof value !== "string" || !/^[1-9]\d*$/.test(value)) throw failure();
  const bytes = Number(value);
  if (!Number.isSafeInteger(bytes) || bytes > MAX_BLOB_BYTES) throw failure();
  return bytes;
};
const truncated = (value: unknown): boolean => {
  if (value === "true") return true;
  if (value === "false") return false;
  throw failure();
};

export interface PublishingCosStoreOptions {
  readonly bucket: string;
  readonly region: string;
  /** Dedicated, exclusive namespace; never a Catalog/Admin prefix. */
  readonly prefix: string;
}

export function assertPublishingCosOptions(
  options: PublishingCosStoreOptions,
): void {
  if (!/^[a-z0-9][a-z0-9-]{1,49}-[0-9]{5,20}$/.test(options.bucket))
    throw new Error("WORK_MEDIA_COS_BUCKET is invalid");
  if (!/^[a-z]{2}-[a-z]+(?:-[a-z]+)?$/.test(options.region))
    throw new Error("WORK_MEDIA_COS_REGION is invalid");
  // A tenant/deployment suffix is mandatory. Catalog, editorial and Admin
  // namespaces cannot be configured accidentally, even in a shared bucket.
  if (!/^ugc\/publishing\/[a-z0-9][a-z0-9-]{0,62}\/$/.test(options.prefix))
    throw new Error(
      "WORK_MEDIA_COS_PREFIX must be an exclusive ugc/publishing/<namespace>/ prefix",
    );
}

/** Private COS adapter. Multipart parts are invisible until exact-size/hash
 * validation succeeds and CompleteMultipartUpload acknowledges the commit.
 * DB keys remain opaque and provider-independent. No public URL is produced.
 */
export class CosPublishingMediaStore {
  private readonly inFlight = new Set<string>();
  private sweepCursor: { key: string; upload: string } | undefined;
  constructor(
    private readonly options: PublishingCosStoreOptions,
    private readonly transport: PublishingCosTransport,
  ) {
    assertPublishingCosOptions(options);
  }

  private base() {
    return { Bucket: this.options.bucket, Region: this.options.region };
  }
  private key(storageKey: string) {
    if (!validKey(storageKey))
      throw new PublishingMediaStoreError("invalid_key");
    return this.options.prefix + storageKey;
  }
  private logical(key: string) {
    if (!key.startsWith(this.options.prefix)) throw failure();
    const logical = key.slice(this.options.prefix.length);
    if (!validKey(logical)) throw failure();
    return logical;
  }
  private async unversioned(signal?: AbortSignal) {
    const result = await this.transport.request<COS.GetBucketVersioningResult>(
      "getBucketVersioning",
      this.base(),
      signal,
    );
    const xml = result.rawBody
      .toString("utf8")
      .replace(/^\s*<\?xml[^?]*\?>\s*/, "")
      .trim();
    // Missing/malformed XML is not proof. Suspended is also rejected: COS's
    // forbid-overwrite does not protect versioned buckets.
    if (
      !/^<VersioningConfiguration\s*(?:xmlns=["']http:\/\/cos\.myqcloud\.com\/doc\/2006-03-01\/["']\s*)?(?:\/>|>\s*<\/VersioningConfiguration>)$/.test(
        xml,
      )
    )
      throw failure();
  }
  private async head(key: string, signal?: AbortSignal) {
    try {
      return await this.transport.request<COS.HeadObjectResult>(
        "headObject",
        { ...this.base(), Key: key },
        signal,
      );
    } catch (error) {
      if (missing(error)) return null;
      throw error;
    }
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
      !source ||
      typeof source[Symbol.asyncIterator] !== "function"
    )
      throw new PublishingMediaStoreError("invalid_argument");
    if (options.signal?.aborted) throw new PublishingMediaStoreError("aborted");
    const hex = randomBytes(16).toString("hex");
    const storageKey = `blobs/${hex.slice(0, 2)}/${hex.slice(2, 4)}/${hex}`;
    const Key = this.key(storageKey);
    const identity = randomBytes(16).toString("hex");
    let uploadId: string | undefined;
    let completing = false;
    this.inFlight.add(Key);
    try {
      await this.unversioned(options.signal);
      if (await this.head(Key, options.signal)) throw failure();
      const init = await this.transport.request<COS.MultipartInitResult>(
        "multipartInit",
        {
          ...this.base(),
          Key,
          ContentType: contentType,
          ACL: "private",
          CacheControl: "private, no-store",
          Headers: {
            "x-cos-forbid-overwrite": "true",
            "x-cos-meta-publishing-upload": identity,
          },
        },
        options.signal,
      );
      if (!init.UploadId || init.UploadId.length > 2048) throw failure();
      uploadId = init.UploadId;
      const parts: { PartNumber: number; ETag: string }[] = [];
      const hash = createHash("sha256");
      let byteSize = 0;
      let buffer = Buffer.allocUnsafe(PUBLISHING_COS_PART_BYTES);
      let filled = 0;
      const upload = async () => {
        const body = buffer.subarray(0, filled);
        const md5 = createHash("md5").update(body).digest();
        const part = await this.transport.request<COS.MultipartUploadResult>(
          "multipartUpload",
          {
            ...this.base(),
            Key,
            UploadId: uploadId,
            PartNumber: parts.length + 1,
            Body: body,
            ContentLength: filled,
            Headers: { "Content-MD5": md5.toString("base64") },
          },
          options.signal,
        );
        if (
          part.ETag?.replaceAll('"', "").toLowerCase() !== md5.toString("hex")
        )
          throw failure();
        parts.push({ PartNumber: parts.length + 1, ETag: part.ETag });
        filled = 0;
      };
      await consume(source, options.signal, async (chunk) => {
        byteSize += chunk.byteLength;
        if (byteSize > maxBytes)
          throw new PublishingMediaStoreError("size_limit_exceeded");
        hash.update(chunk);
        for (let offset = 0; offset < chunk.byteLength;) {
          const length = Math.min(
            buffer.length - filled,
            chunk.byteLength - offset,
          );
          buffer.set(chunk.subarray(offset, offset + length), filled);
          filled += length;
          offset += length;
          if (filled === buffer.length) await upload();
        }
      });
      if (!byteSize) throw new PublishingMediaStoreError("empty_content");
      if (options.requireExactSize && byteSize !== maxBytes)
        throw new PublishingMediaStoreError("size_mismatch");
      if (filled) await upload();
      buffer = Buffer.alloc(0);
      if (options.signal?.aborted)
        throw new PublishingMediaStoreError("aborted");
      completing = true;
      await this.transport.request<COS.MultipartCompleteResult>(
        "multipartComplete",
        {
          ...this.base(),
          Key,
          UploadId: uploadId,
          Parts: parts,
          Headers: { "x-cos-forbid-overwrite": "true" },
        },
        options.signal,
      );
      const committed = await this.head(Key, options.signal);
      if (
        !committed ||
        header(committed, "x-cos-meta-publishing-upload") !== identity ||
        size(header(committed, "content-length")) !== byteSize
      )
        throw failure();
      return { storageKey, byteSize, sha256: hash.digest("hex") };
    } catch (error) {
      const cleanup = new AbortController();
      const deadline = setTimeout(() => cleanup.abort(), 1000);
      try {
        if (uploadId)
          await this.abort(Key, uploadId, cleanup.signal).catch(
            () => undefined,
          );
        // A lost completion response may have committed. Delete only our own
        // object, never the colliding object from a 409. Unknown outcomes remain
        // unrecorded and are handled by the existing age-gated reconciliation.
        if (completing) {
          await (async () => {
            const committed = await this.head(Key, cleanup.signal);
            if (
              committed &&
              header(committed, "x-cos-meta-publishing-upload") === identity
            )
              await this.remove(storageKey, cleanup.signal);
          })().catch(() => undefined);
        }
      } finally {
        clearTimeout(deadline);
      }
      throw safeError(error);
    } finally {
      this.inFlight.delete(Key);
    }
  }

  async openRead(
    storageKey: string,
    range?: PublishingMediaStoreRange,
  ): Promise<PublishingMediaStoreRead | null> {
    const Key = this.key(storageKey);
    try {
      const object = await this.head(Key);
      if (!object) return null;
      const byteSize = size(header(object, "content-length"));
      const resolved = resolveRange(range, byteSize);
      if (!resolved) return { status: "range_not_satisfiable", byteSize };
      const etag = header(object, "etag");
      if (typeof etag !== "string" || !etag || /[\r\n]/.test(etag))
        throw failure();
      const controller = new AbortController();
      const transport = this.transport;
      const base = this.base();
      const body = Readable.from(
        (async function* () {
          try {
            for (
              let start = resolved.start;
              start <= resolved.end;
              start += PUBLISHING_COS_READ_BYTES
            ) {
              const end = Math.min(
                start + PUBLISHING_COS_READ_BYTES - 1,
                resolved.end,
              );
              const response = await transport.request<COS.GetObjectResult>(
                "getObject",
                {
                  ...base,
                  Key,
                  Range: `bytes=${start}-${end}`,
                  IfMatch: etag,
                  DataType: "buffer",
                },
                controller.signal,
                end - start + 1,
              );
              if (
                response.statusCode !== 206 ||
                header(response, "content-range") !==
                  `bytes ${start}-${end}/${byteSize}` ||
                response.rawBody.length !== end - start + 1
              )
                throw failure();
              yield response.rawBody;
            }
          } catch (error) {
            throw safeError(error);
          } finally {
            controller.abort();
          }
        })(),
        { objectMode: false, highWaterMark: PUBLISHING_COS_READ_BYTES },
      );
      // Readable.from waits for a pending iterator before emitting close.
      // Abort at destruction entry so downstream pipeline cancellation also
      // cancels an outstanding network request immediately.
      const destroy = body._destroy;
      body._destroy = (error, callback) => {
        controller.abort();
        destroy.call(body, error, callback);
      };
      return {
        status: "ok",
        byteSize,
        ...resolved,
        contentLength: resolved.end - resolved.start + 1,
        body,
        close: async () => {
          controller.abort();
          body.destroy();
        },
      };
    } catch (error) {
      throw safeError(error);
    }
  }

  async remove(storageKey: string, signal?: AbortSignal): Promise<void> {
    const Key = this.key(storageKey);
    if (signal?.aborted) throw new PublishingMediaStoreError("aborted");
    try {
      await this.unversioned(signal);
      if (signal?.aborted) throw new PublishingMediaStoreError("aborted");
      await this.transport.request(
        "deleteObject",
        { ...this.base(), Key },
        signal,
      );
    } catch (error) {
      if (!missing(error)) throw safeError(error);
    }
  }

  async listBlobs(options: {
    readonly after?: string | null;
    readonly limit: number;
    readonly signal?: AbortSignal;
  }) {
    if (
      !Number.isSafeInteger(options.limit) ||
      options.limit < 1 ||
      options.limit > 1000
    )
      throw new PublishingMediaStoreError("invalid_argument");
    const after = options.after == null ? undefined : this.key(options.after);
    if (options.signal?.aborted) throw new PublishingMediaStoreError("aborted");
    try {
      const page = await this.transport.request<COS.GetBucketResult>(
        "getBucket",
        {
          ...this.base(),
          Prefix: this.options.prefix + "blobs/",
          MaxKeys: options.limit,
          ...(after ? { Marker: after } : {}),
        },
        options.signal,
      );
      if (options.signal?.aborted)
        throw new PublishingMediaStoreError("aborted");
      if (!Array.isArray(page.Contents) || page.Contents.length > options.limit)
        throw failure();
      let previous = after ?? "";
      const entries = page.Contents.map((entry) => {
        const storageKey = this.logical(entry.Key);
        if (entry.Key <= previous) throw failure();
        previous = entry.Key;
        const modifiedAt = new Date(entry.LastModified);
        if (!Number.isFinite(modifiedAt.getTime())) throw failure();
        return { storageKey, byteSize: size(entry.Size), modifiedAt };
      });
      const more = truncated(page.IsTruncated);
      if (more && !entries.length) throw failure();
      // COS can omit NextMarker without Delimiter. Last returned key is the
      // exclusive cursor; never trust a provider marker outside our namespace.
      return { entries, nextAfter: more ? entries.at(-1)!.storageKey : null };
    } catch (error) {
      throw safeError(error);
    }
  }

  private async abort(Key: string, UploadId: string, signal?: AbortSignal) {
    try {
      await this.transport.request(
        "multipartAbort",
        { ...this.base(), Key, UploadId },
        signal,
      );
    } catch (error) {
      if (!missing(error)) throw error;
    }
  }

  /** One bounded page per call; cursor progresses even past young/active jobs.
   * Recent parts are conservatively retained; in-flight uploads in this
   * process are never swept. This namespace requires one active Backend
   * process (including during restart), matching the current runtime. Unknown
   * init responses are recovered by this same namespace-confined listing.
   */
  async sweepStaging(
    olderThan: Date,
    signal?: AbortSignal,
  ): Promise<{ removed: number }> {
    if (!Number.isFinite(olderThan.getTime()))
      throw new PublishingMediaStoreError("invalid_argument");
    try {
      const page = await this.transport.request<COS.MultipartListResult>(
        "multipartList",
        {
          ...this.base(),
          Prefix: this.options.prefix + "blobs/",
          Delimiter: "",
          MaxUploads: 1000,
          ...(this.sweepCursor
            ? {
                KeyMarker: this.sweepCursor.key,
                UploadIdMarker: this.sweepCursor.upload,
              }
            : {}),
        },
        signal,
      );
      if (!Array.isArray(page.Upload) || page.Upload.length > 1000)
        throw failure();
      const more = truncated(page.IsTruncated);
      if (more) {
        this.logical(page.NextKeyMarker);
        if (
          !page.NextUploadIdMarker ||
          !page.Upload.length ||
          (this.sweepCursor &&
            (page.NextKeyMarker < this.sweepCursor.key ||
              (page.NextKeyMarker === this.sweepCursor.key &&
                page.NextUploadIdMarker <= this.sweepCursor.upload))) ||
          page.NextKeyMarker !== page.Upload.at(-1)!.Key ||
          page.NextUploadIdMarker !== page.Upload.at(-1)!.UploadId
        )
          throw failure();
      }
      let removed = 0;
      for (const upload of page.Upload) {
        if (signal?.aborted) throw new PublishingMediaStoreError("aborted");
        this.logical(upload.Key);
        const created = new Date(upload.Initiated).getTime();
        if (!Number.isFinite(created) || !upload.UploadId) throw failure();
        if (this.inFlight.has(upload.Key) || created >= olderThan.getTime())
          continue;
        let parts;
        try {
          parts = await this.transport.request<COS.MultipartListPartResult>(
            "multipartListPart",
            {
              ...this.base(),
              Key: upload.Key,
              UploadId: upload.UploadId,
              MaxParts: 1000,
            },
            signal,
          );
        } catch (error) {
          if (missing(error)) continue;
          throw error;
        }
        if (
          truncated(parts.IsTruncated) ||
          !Array.isArray(parts.Part) ||
          parts.Part.length > 1000
        )
          throw failure();
        if (
          parts.Part.some(
            (part) => !Number.isFinite(new Date(part.LastModified).getTime()),
          )
        )
          throw failure();
        if (
          parts.Part.some(
            (part) =>
              new Date(part.LastModified).getTime() >= olderThan.getTime(),
          )
        )
          continue;
        await this.abort(upload.Key, upload.UploadId, signal);
        removed += 1;
      }
      this.sweepCursor = more
        ? { key: page.NextKeyMarker, upload: page.NextUploadIdMarker }
        : undefined;
      return { removed };
    } catch (error) {
      throw safeError(error);
    }
  }
}

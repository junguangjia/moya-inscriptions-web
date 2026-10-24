import {
  createHash,
  createHmac,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import { constants, realpathSync } from "node:fs";
import {
  chmod,
  link,
  lstat,
  mkdir,
  open,
  realpath,
  unlink,
  type FileHandle,
} from "node:fs/promises";
import path from "node:path";
import {
  CopyObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import {
  CATALOG_INGEST_STAGING_TAGGING,
  CATALOG_ORIGINAL_MAX_BYTES,
} from "@moya/contracts/internal/editorial";

/*
 * Private storage for Catalog ingest (catalog-scale-v1 increment 2). The
 * uploader holds no credential: it may write one random-looking staging key
 * under catalog-ingest/v1/ for at most 300 s through a URL the Admin signs.
 * Only the Admin reads staging back, copies verified bytes to their
 * content-addressed editorial/ key and deletes staging. Keys, URLs and
 * provider errors never leave this module in an error or a log.
 */

export const INGEST_URL_TTL_SECONDS = 300;
/** Every verification read is one ranged GET of at most this many bytes. */
export const INGEST_READ_BYTES = 1024 * 1024;
const STAGING_KEY = /^catalog-ingest\/v1\/([a-f0-9]{2})\/([a-f0-9]{64})$/;
// The worker's EDITORIAL_KEY (services/backend-production catalog-source.ts).
const FINAL_KEY =
  /^editorial\/[a-f0-9]{64}\/([a-f0-9]{64}-[a-f0-9]{64}\.(?:jpg|png|webp))$/;
const MIME_TYPES = ["image/jpeg", "image/png", "image/webp"] as const;
const MD5_BASE64 = /^[A-Za-z0-9+/]{21}[AQgw]==$/;

export type IngestUploadHeaders = {
  "content-length": string;
  "content-type": (typeof MIME_TYPES)[number];
  "x-cos-forbid-overwrite": "true";
  "content-md5": string;
  "x-cos-tagging"?: typeof CATALOG_INGEST_STAGING_TAGGING;
};
const REQUIRED_HEADERS = [
  "content-length",
  "content-type",
  "x-cos-forbid-overwrite",
  "content-md5",
] as const;

/** The headers start signs and the uploader sends, exactly; L1 adds the tag. */
export const stagingUploadHeaders = (
  object: Readonly<{
    bytes: number;
    mimeType: IngestUploadHeaders["content-type"];
    md5Base64: string;
  }>,
  stagingTag: boolean,
): IngestUploadHeaders => ({
  "content-length": String(object.bytes),
  "content-type": object.mimeType,
  "x-cos-forbid-overwrite": "true",
  "content-md5": object.md5Base64,
  ...(stagingTag ? { "x-cos-tagging": CATALOG_INGEST_STAGING_TAGGING } : {}),
});

export type StoredObject = Readonly<{
  bytes: number;
  /** As storage returned it, quotes included. */
  etag: string;
  crc64: string | null;
  tagCount: number;
  /**
   * The stored Content-Type ("" when COS returned none); null only from the
   * Development store, which keeps no object metadata.
   */
  contentType: string | null;
  /**
   * Whatever a signed staging PUT never sets: a Content-Encoding,
   * -Disposition or -Language, Cache-Control or Expires, user metadata, a
   * storage class other than standard, or encryption other than SSE-COS
   * (AES256). A server-side copy keeps the source's (directive COPY).
   */
  extraAttributes: boolean;
}>;

export class IngestStorageError extends Error {
  constructor(
    /** "changed": the pinned object is gone or different; "unavailable": transient. */
    readonly code: "changed" | "unavailable",
  ) {
    super(`Catalog ingest storage failed: ${code}`);
    this.name = "IngestStorageError";
  }
}

export interface IngestStorage {
  /** Lifecycle L1: the staging PUT carries the staging tag and the copy drops it. */
  readonly stagingTag: boolean;
  signUpload(
    stagingKey: string,
    headers: IngestUploadHeaders,
    now: Date,
  ): Promise<{ url: string; expiresAt: Date }>;
  head(key: string, signal: AbortSignal): Promise<StoredObject | null>;
  /** One inclusive range, pinned to the object HEAD returned. */
  read(
    key: string,
    start: number,
    end: number,
    object: StoredObject,
    signal: AbortSignal,
  ): Promise<Uint8Array>;
  /** Never replaces: "exists" when the final key is already taken. */
  copy(
    stagingKey: string,
    finalKey: string,
    source: StoredObject,
    signal: AbortSignal,
  ): Promise<"copied" | "exists">;
  /** Staging keys only; absent is success. The Admin cannot delete editorial/. */
  remove(stagingKey: string, signal: AbortSignal): Promise<void>;
}

export const stagingKeyFor = (ingestId: string): string => {
  if (!/^[a-f0-9]{64}$/.test(ingestId))
    throw new IngestStorageError("unavailable");
  return `catalog-ingest/v1/${ingestId.slice(0, 2)}/${ingestId}`;
};
const stagingId = (key: string): string => {
  const found = STAGING_KEY.exec(key);
  if (!found || found[2]!.slice(0, 2) !== found[1])
    throw new IngestStorageError("unavailable");
  return found[2]!;
};
const finalName = (key: string): string => {
  const found = FINAL_KEY.exec(key);
  if (!found) throw new IngestStorageError("unavailable");
  return found[1]!;
};
const assertKnownKey = (key: string) => {
  if (!STAGING_KEY.test(key)) finalName(key);
};

/** Exactly the signed header set; refuses any other or any malformed value. */
function assertUploadHeaders(
  headers: Record<string, string>,
): asserts headers is IngestUploadHeaders {
  const names = Object.keys(headers);
  const length = headers["content-length"];
  if (
    names.some(
      (name) =>
        !(REQUIRED_HEADERS as readonly string[]).includes(name) &&
        name !== "x-cos-tagging",
    ) ||
    REQUIRED_HEADERS.some((name) => typeof headers[name] !== "string") ||
    !/^[1-9][0-9]{0,9}$/.test(length ?? "") ||
    Number(length) > CATALOG_ORIGINAL_MAX_BYTES ||
    !(MIME_TYPES as readonly string[]).includes(headers["content-type"]!) ||
    headers["x-cos-forbid-overwrite"] !== "true" ||
    !MD5_BASE64.test(headers["content-md5"]!) ||
    (names.includes("x-cos-tagging") &&
      headers["x-cos-tagging"] !== CATALOG_INGEST_STAGING_TAGGING)
  )
    throw new Error("INGEST_SIGNER_REFUSED");
}

// Query parameters a signed staging PUT may carry; anything else is refused.
const SIGNED_QUERY = new Set([
  "X-Amz-Algorithm",
  "X-Amz-Content-Sha256",
  "X-Amz-Credential",
  "X-Amz-Date",
  "X-Amz-Expires",
  "X-Amz-SignedHeaders",
  "X-Amz-Signature",
  "x-id",
]);

/**
 * The only presigner in the Admin. Signs one PUT of one staging key for at
 * most 300 s, binding host, content-length, content-type, content-md5,
 * x-cos-forbid-overwrite and, under L1, x-cos-tagging; refuses any other key,
 * method, header or lifetime, and refuses its own output unless the URL
 * carries exactly that signed set and no checksum, copy-source or ACL
 * parameter. The URL never enters a log, error or database row.
 */
export async function signStagingPut(
  target: { client: S3Client; bucket: string; uploadEndpoint: URL },
  request: {
    method: string;
    key: string;
    headers: Record<string, string>;
    expiresIn: number;
    signingDate: Date;
  },
): Promise<string> {
  const refused = () => new Error("INGEST_SIGNER_REFUSED");
  if (
    request.method !== "PUT" ||
    !Number.isSafeInteger(request.expiresIn) ||
    request.expiresIn < 1 ||
    request.expiresIn > INGEST_URL_TTL_SECONDS ||
    !Number.isFinite(request.signingDate.getTime())
  )
    throw refused();
  try {
    stagingId(request.key);
  } catch {
    throw refused();
  }
  const headers = { ...request.headers };
  assertUploadHeaders(headers);
  const command = new PutObjectCommand({
    Bucket: target.bucket,
    Key: request.key,
    ContentLength: Number(headers["content-length"]),
    ContentType: headers["content-type"],
    ContentMD5: headers["content-md5"],
  });
  addRequestHeaders(command, {
    "x-cos-forbid-overwrite": "true",
    ...(headers["x-cos-tagging"] === undefined
      ? {}
      : { "x-cos-tagging": headers["x-cos-tagging"] }),
  });
  const url = new URL(
    await getSignedUrl(target.client, command, {
      expiresIn: request.expiresIn,
      signingDate: request.signingDate,
      // The presigner leaves content-type unsigned by default; bind it.
      signableHeaders: new Set(["content-type"]),
    }),
  );
  const signed = [...Object.keys(headers), "host"].sort().join(";");
  if (
    url.protocol !== target.uploadEndpoint.protocol ||
    url.host !== `${target.bucket}.${target.uploadEndpoint.host}` ||
    url.pathname !== `/${request.key}` ||
    url.username ||
    url.password ||
    url.hash ||
    [...url.searchParams.keys()].some((name) => !SIGNED_QUERY.has(name)) ||
    new Set(url.searchParams.keys()).size !== [...url.searchParams].length ||
    url.searchParams.get("X-Amz-SignedHeaders") !== signed ||
    url.searchParams.get("X-Amz-Expires") !== String(request.expiresIn) ||
    url.searchParams.get("X-Amz-Content-Sha256") !== "UNSIGNED-PAYLOAD"
  )
    throw refused();
  return url.href;
}

type Middleware = (
  next: (args: { request: unknown }) => Promise<{ response: unknown }>,
) => (args: { request: unknown }) => Promise<{ response: unknown }>;
type MiddlewareStack = {
  add(
    middleware: Middleware,
    options: { step: "build" | "deserialize"; name: string },
  ): void;
};
const stackOf = (command: { middlewareStack: unknown }) =>
  command.middlewareStack as MiddlewareStack;

/** COS headers with no S3 field, added to the request before it is signed. */
function addRequestHeaders(
  command: { middlewareStack: unknown },
  headers: Record<string, string>,
) {
  stackOf(command).add(
    (next) => async (args) => {
      const request = args.request as { headers?: Record<string, string> };
      if (!request.headers) throw new IngestStorageError("unavailable");
      Object.assign(request.headers, headers);
      return next(args);
    },
    { step: "build", name: "moyaCatalogIngestHeaders" },
  );
}

/** The raw response headers the S3 output omits (CRC64, tag count). */
function captureResponseHeaders(command: { middlewareStack: unknown }) {
  const captured: { headers: Record<string, string | undefined> } = {
    headers: {},
  };
  stackOf(command).add(
    (next) => async (args) => {
      const result = await next(args);
      const response = result.response as {
        headers?: Record<string, string>;
      };
      captured.headers = response?.headers ?? {};
      return result;
    },
    { step: "deserialize", name: "moyaCatalogIngestResponse" },
  );
  return captured;
}

const statusOf = (error: unknown): number | undefined =>
  (error as { $metadata?: { httpStatusCode?: number } } | null)?.$metadata
    ?.httpStatusCode;
const tagCountOf = (headers: Record<string, string | undefined>) => {
  const value =
    headers["x-cos-tagging-count"] ?? headers["x-amz-tagging-count"];
  if (value === undefined) return 0;
  return /^[0-9]{1,4}$/.test(value) ? Number(value) : Number.NaN;
};
/** Response headers of a HEAD that a signed staging PUT never causes. */
const EXTRA_HEADERS = [
  "content-encoding",
  "content-disposition",
  "content-language",
  "cache-control",
  "expires",
  "x-cos-server-side-encryption-customer-algorithm",
  "x-amz-server-side-encryption-customer-algorithm",
  "x-cos-server-side-encryption-cos-kms-key-id",
  "x-amz-server-side-encryption-aws-kms-key-id",
  "x-cos-website-redirect-location",
  "x-amz-website-redirect-location",
];
const extraAttributesOf = (headers: Record<string, string | undefined>) => {
  const value = (name: string) => headers[name];
  const named = (name: string) => {
    const found = value(name);
    return found !== undefined && found !== "";
  };
  const storageClass =
    value("x-cos-storage-class") ?? value("x-amz-storage-class");
  const encryption =
    value("x-cos-server-side-encryption") ??
    value("x-amz-server-side-encryption");
  return (
    EXTRA_HEADERS.some(named) ||
    Object.keys(headers).some((name) => /^x-(?:cos|amz)-meta-/.test(name)) ||
    (storageClass !== undefined && storageClass.toUpperCase() !== "STANDARD") ||
    (encryption !== undefined && encryption !== "AES256")
  );
};

export type CosIngestSettings = {
  /** The Admin's COS API origin (CMS_COS_ENDPOINT): verification and copy. */
  endpoint: URL;
  /** The public COS API origin the uploader reaches; signatures bind its host. */
  uploadEndpoint: URL;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  stagingTag: boolean;
};

const clientOptions = (settings: Omit<CosIngestSettings, "stagingTag">) =>
  ({
    region: settings.region,
    credentials: {
      accessKeyId: settings.accessKeyId,
      secretAccessKey: settings.secretAccessKey,
    },
    // Virtual-hosted addressing, as the media adapter (storage.ts).
    forcePathStyle: false,
    requestChecksumCalculation: "WHEN_REQUIRED",
    responseChecksumValidation: "WHEN_REQUIRED",
  }) as const;

/** The signing target of the upload endpoint; its client never sends a request. */
export const stagingSigner = (
  settings: Omit<CosIngestSettings, "stagingTag">,
) => ({
  client: new S3Client({
    ...clientOptions(settings),
    endpoint: settings.uploadEndpoint.origin,
    maxAttempts: 1,
  }),
  bucket: settings.bucket,
  uploadEndpoint: settings.uploadEndpoint,
});

/**
 * The Admin's server-side copy: the same bucket, pinned to the verified
 * ETag, never replacing (forbid-overwrite).
 */
const copyCommand = (
  bucket: string,
  sourceKey: string,
  targetKey: string,
  etag: string,
  stagingTag: boolean,
) => {
  const command = new CopyObjectCommand({
    Bucket: bucket,
    Key: targetKey,
    CopySource: `${bucket}/${sourceKey}`,
    CopySourceIfMatch: etag,
    // Keep the Content-Type the staging PUT signed; setting it on a copy is
    // ignored unless metadata is replaced.
    MetadataDirective: "COPY",
    // L1: the final object carries no tag, so the staging Expiration rule
    // can never match it.
    ...(stagingTag ? { TaggingDirective: "REPLACE" as const } : {}),
  });
  addRequestHeaders(command, { "x-cos-forbid-overwrite": "true" });
  return command;
};

class CosIngestStorage implements IngestStorage {
  readonly stagingTag: boolean;
  readonly #bucket: string;
  readonly #client: S3Client;
  readonly #signer: ReturnType<typeof stagingSigner>;

  constructor(settings: CosIngestSettings) {
    this.stagingTag = settings.stagingTag;
    this.#bucket = settings.bucket;
    this.#client = new S3Client({
      ...clientOptions(settings),
      endpoint: settings.endpoint.origin,
      maxAttempts: 3,
    });
    this.#signer = stagingSigner(settings);
  }

  async signUpload(
    stagingKey: string,
    headers: IngestUploadHeaders,
    now: Date,
  ) {
    const signingDate = new Date(Math.floor(now.getTime() / 1000) * 1000);
    const url = await signStagingPut(this.#signer, {
      method: "PUT",
      key: stagingKey,
      headers: { ...headers },
      expiresIn: INGEST_URL_TTL_SECONDS,
      signingDate,
    });
    return {
      url,
      expiresAt: new Date(
        signingDate.getTime() + INGEST_URL_TTL_SECONDS * 1000,
      ),
    };
  }

  async head(key: string, signal: AbortSignal): Promise<StoredObject | null> {
    assertKnownKey(key);
    const command = new HeadObjectCommand({
      Bucket: this.#bucket,
      Key: key,
    });
    const captured = captureResponseHeaders(command);
    let output;
    try {
      output = await this.#client.send(command, { abortSignal: signal });
    } catch (error) {
      if (statusOf(error) === 404) return null;
      throw new IngestStorageError("unavailable");
    }
    const bytes = output.ContentLength;
    const etag = output.ETag;
    const crc64 = captured.headers["x-cos-hash-crc64ecma"];
    const tagCount = tagCountOf(captured.headers);
    if (
      !Number.isSafeInteger(bytes) ||
      bytes! < 0 ||
      typeof etag !== "string" ||
      !etag ||
      etag.length > 256 ||
      /[\r\n]/.test(etag) ||
      Number.isNaN(tagCount)
    )
      throw new IngestStorageError("unavailable");
    return {
      bytes: bytes!,
      etag,
      crc64: crc64 && /^[0-9]{1,20}$/.test(crc64) ? crc64 : null,
      tagCount,
      contentType: output.ContentType ?? "",
      extraAttributes: extraAttributesOf(captured.headers),
    };
  }

  async read(
    key: string,
    start: number,
    end: number,
    object: StoredObject,
    signal: AbortSignal,
  ): Promise<Uint8Array> {
    assertKnownKey(key);
    if (
      !Number.isSafeInteger(start) ||
      !Number.isSafeInteger(end) ||
      start < 0 ||
      end < start ||
      end >= object.bytes ||
      end - start + 1 > INGEST_READ_BYTES
    )
      throw new IngestStorageError("unavailable");
    let bytes: Uint8Array | undefined;
    let range: string | undefined;
    try {
      const output = await this.#client.send(
        new GetObjectCommand({
          Bucket: this.#bucket,
          Key: key,
          Range: `bytes=${start}-${end}`,
          IfMatch: object.etag,
        }),
        { abortSignal: signal },
      );
      range = output.ContentRange;
      bytes = await output.Body?.transformToByteArray();
    } catch (error) {
      const status = statusOf(error);
      if (status === 404 || status === 412 || status === 416)
        throw new IngestStorageError("changed");
      throw new IngestStorageError("unavailable");
    }
    if (range !== `bytes ${start}-${end}/${object.bytes}`)
      throw new IngestStorageError("changed");
    if (!bytes || bytes.length !== end - start + 1)
      throw new IngestStorageError("unavailable");
    return bytes;
  }

  async copy(
    stagingKey: string,
    finalKey: string,
    source: StoredObject,
    signal: AbortSignal,
  ): Promise<"copied" | "exists"> {
    stagingId(stagingKey);
    finalName(finalKey);
    try {
      await this.#client.send(
        copyCommand(
          this.#bucket,
          stagingKey,
          finalKey,
          source.etag,
          this.stagingTag,
        ),
        { abortSignal: signal },
      );
    } catch (error) {
      const status = statusOf(error);
      if (status === 409) return "exists";
      if (status === 404 || status === 412)
        throw new IngestStorageError("changed");
      throw new IngestStorageError("unavailable");
    }
    return "copied";
  }

  async remove(stagingKey: string, signal: AbortSignal): Promise<void> {
    stagingId(stagingKey);
    try {
      await this.#client.send(
        new DeleteObjectCommand({
          Bucket: this.#bucket,
          Key: stagingKey,
        }),
        { abortSignal: signal },
      );
    } catch (error) {
      if (statusOf(error) === 404) return;
      throw new IngestStorageError("unavailable");
    }
  }
}

/** Builds no connection; the first request opens one. */
export const createCosIngestStorage = (
  settings: CosIngestSettings,
): IngestStorage => new CosIngestStorage(settings);

/**
 * The requests of the staging dry run (ingest-probes.ts), built by the same
 * code as the Admin's own: the staging PUT URL by signStagingPut, the copy by
 * copyCommand and HEAD by the ingest storage's parser. Staging keys only:
 * nothing here reads, copies to or deletes an editorial/ key.
 */
export type IngestProbeStorage = {
  /** expiresIn: the Admin's 300 s, or seconds for the slow-PUT probe. */
  signPut(
    stagingKey: string,
    headers: IngestUploadHeaders,
    now: Date,
    expiresIn: number,
  ): Promise<string>;
  head(stagingKey: string, signal: AbortSignal): Promise<StoredObject | null>;
  /** The Admin's copy between two staging keys: the HTTP status, 0 if none. */
  copy(
    sourceKey: string,
    targetKey: string,
    etag: string,
    stagingTag: boolean,
    signal: AbortSignal,
  ): Promise<number>;
  remove(stagingKey: string, signal: AbortSignal): Promise<void>;
};

export const createCosIngestProbeStorage = (
  settings: Omit<CosIngestSettings, "stagingTag">,
): IngestProbeStorage => {
  const storage = new CosIngestStorage({ ...settings, stagingTag: false });
  const signer = stagingSigner(settings);
  const client = new S3Client({
    ...clientOptions(settings),
    endpoint: settings.endpoint.origin,
    // One request per probe: a retry would hide the status it records.
    maxAttempts: 1,
  });
  return {
    signPut: (stagingKey, headers, now, expiresIn) =>
      signStagingPut(signer, {
        method: "PUT",
        key: stagingKey,
        headers: { ...headers },
        expiresIn,
        signingDate: new Date(Math.floor(now.getTime() / 1000) * 1000),
      }),
    head: async (stagingKey, signal) => {
      stagingId(stagingKey);
      return storage.head(stagingKey, signal);
    },
    copy: async (sourceKey, targetKey, etag, stagingTag, signal) => {
      stagingId(sourceKey);
      stagingId(targetKey);
      try {
        await client.send(
          copyCommand(settings.bucket, sourceKey, targetKey, etag, stagingTag),
          { abortSignal: signal },
        );
        return 200;
      } catch (error) {
        return statusOf(error) ?? 0;
      }
    },
    remove: (stagingKey, signal) => storage.remove(stagingKey, signal),
  };
};

const missing = (error: unknown) =>
  (error as { code?: string } | null)?.code === "ENOENT";
const exists = (error: unknown) =>
  (error as { code?: string } | null)?.code === "EEXIST";

export type DevelopmentPutResult =
  | { status: 200; etag: string }
  | { status: 400 | 403 | 404 | 408 | 409 | 413; code: string };

/**
 * Development store (CMS_STORAGE_MODE=local outside production). Staging
 * lives beside, never inside, the served media directory; forbid-overwrite is
 * emulated with O_EXCL and link(), and a verified copy lands at
 * <CMS_MEDIA_DIR>/<filename>, exactly where the worker's
 * LocalCatalogSourceReader reads an editorial key. The upload URL is the
 * dev-only PUT route, authorized by an HMAC over the same signed headers.
 */
export class LocalIngestStorage implements IngestStorage {
  readonly stagingTag: boolean;
  readonly #root: string;
  readonly #media: string;
  readonly #uploadEndpoint: URL;
  readonly #tokenKey: Buffer;
  readonly #etags = new Map<string, string>();

  constructor(options: {
    stagingDirectory: string;
    mediaDirectory: string;
    uploadEndpoint: URL;
    tokenKey: Buffer;
    stagingTag: boolean;
  }) {
    const unsafe = () => new IngestStorageError("unavailable");
    if (
      path.resolve(options.stagingDirectory) !== options.stagingDirectory ||
      path.resolve(options.mediaDirectory) !== options.mediaDirectory ||
      options.tokenKey.length < 32
    )
      throw unsafe();
    // Canonical parents (macOS /var -> /private/var), keeping the final
    // components for the no-follow checks, as the relay's store does.
    const canonical = (directory: string) => {
      try {
        return path.join(
          realpathSync.native(path.dirname(directory)),
          path.basename(directory),
        );
      } catch {
        throw unsafe();
      }
    };
    this.#root = canonical(options.stagingDirectory);
    this.#media = canonical(options.mediaDirectory);
    if (
      this.#root === this.#media ||
      this.#root.startsWith(this.#media + path.sep) ||
      this.#media.startsWith(this.#root + path.sep)
    )
      throw unsafe();
    this.#uploadEndpoint = options.uploadEndpoint;
    this.#tokenKey = options.tokenKey;
    this.stagingTag = options.stagingTag;
  }

  async #ready() {
    try {
      await mkdir(this.#root, { mode: 0o700 });
    } catch (error) {
      if (!exists(error)) throw new IngestStorageError("unavailable");
    }
    const info = await lstat(this.#root);
    if (
      !info.isDirectory() ||
      info.isSymbolicLink() ||
      (typeof process.getuid === "function" && info.uid !== process.getuid()) ||
      (info.mode & 0o777) !== 0o700 ||
      (await realpath(this.#root)) !== this.#root
    )
      throw new IngestStorageError("unavailable");
  }

  #path(key: string) {
    return STAGING_KEY.test(key)
      ? path.join(this.#root, stagingId(key))
      : path.join(this.#media, finalName(key));
  }

  #token(ingestId: string, expires: number, headers: Record<string, string>) {
    return createHmac("sha256", this.#tokenKey)
      .update(
        JSON.stringify([
          "moya-catalog-ingest-dev-put-v1",
          ingestId,
          expires,
          ...REQUIRED_HEADERS.map((name) => headers[name] ?? null),
          headers["x-cos-tagging"] ?? null,
        ]),
      )
      .digest();
  }

  async signUpload(
    stagingKey: string,
    headers: IngestUploadHeaders,
    now: Date,
  ) {
    const ingestId = stagingId(stagingKey);
    assertUploadHeaders({ ...headers });
    const expires = Math.floor(now.getTime() / 1000) + INGEST_URL_TTL_SECONDS;
    const url = new URL(
      `/api/editorial/media-ingest/dev-put/${ingestId}`,
      this.#uploadEndpoint.origin,
    );
    url.searchParams.set("expires", String(expires));
    url.searchParams.set("length", headers["content-length"]);
    url.searchParams.set(
      "token",
      this.#token(ingestId, expires, { ...headers }).toString("hex"),
    );
    return { url: url.href, expiresAt: new Date(expires * 1000) };
  }

  /** The dev PUT route: the URL's token is its only authority. */
  async acceptUpload(
    ingestId: unknown,
    request: Request,
    now = Date.now(),
  ): Promise<DevelopmentPutResult> {
    if (typeof ingestId !== "string" || !/^[a-f0-9]{64}$/.test(ingestId))
      return { status: 404, code: "INGEST_NOT_FOUND" };
    const query = new URL(request.url).searchParams;
    const expires = query.get("expires") ?? "";
    const token = query.get("token") ?? "";
    // Checked when the request starts, as a presigned URL is.
    if (
      !/^[1-9][0-9]{0,11}$/.test(expires) ||
      query.get("length") !== request.headers.get("content-length") ||
      !/^[a-f0-9]{64}$/.test(token) ||
      Number(expires) * 1000 < now
    )
      return { status: 403, code: "INGEST_UPLOAD_FORBIDDEN" };
    if (request.headers.has("authorization") || request.headers.has("cookie"))
      return { status: 400, code: "INGEST_UPLOAD_AUTHORIZATION_INVALID" };
    const headers: Record<string, string> = {};
    for (const name of [...REQUIRED_HEADERS, "x-cos-tagging"]) {
      const value = request.headers.get(name);
      if (value !== null) headers[name] = value;
    }
    const expected = this.#token(ingestId, Number(expires), headers);
    if (
      !timingSafeEqual(expected, Buffer.from(token, "hex")) ||
      // An unsigned COS or S3 header (copy-source, ACL, metadata) is refused.
      [...request.headers.keys()].some(
        (name) =>
          /^x-(?:cos|amz)-/i.test(name) &&
          !["x-cos-forbid-overwrite", "x-cos-tagging"].includes(
            name.toLowerCase(),
          ),
      )
    )
      return { status: 403, code: "INGEST_UPLOAD_FORBIDDEN" };
    const length = Number(headers["content-length"]);
    if (!request.body) return { status: 400, code: "INGEST_UPLOAD_INVALID" };
    await this.#ready();
    const temporary = path.join(this.#root, `.put-${randomUUID()}.tmp`);
    const handle = await open(
      temporary,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW,
      0o600,
    );
    const reader = request.body.getReader();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      void reader.cancel().catch(() => undefined);
    }, INGEST_URL_TTL_SECONDS * 1000);
    try {
      const md5 = createHash("md5");
      let received = 0;
      try {
        for (;;) {
          const next = await reader.read();
          if (next.done) break;
          received += next.value.byteLength;
          if (received > length)
            return { status: 413, code: "INGEST_UPLOAD_TOO_LARGE" };
          md5.update(next.value);
          await handle.write(next.value);
        }
      } catch {
        return { status: 408, code: "INGEST_UPLOAD_ABORTED" };
      }
      if (timedOut) return { status: 408, code: "INGEST_UPLOAD_ABORTED" };
      const digest = md5.digest();
      if (
        received !== length ||
        digest.toString("base64") !== headers["content-md5"]
      )
        return { status: 400, code: "INGEST_UPLOAD_DIGEST_INVALID" };
      await handle.sync();
      await handle.close();
      try {
        await link(temporary, path.join(this.#root, ingestId));
      } catch (error) {
        if (exists(error)) return { status: 409, code: "INGEST_UPLOAD_EXISTS" };
        throw new IngestStorageError("unavailable");
      }
      return { status: 200, etag: `"${digest.toString("hex")}"` };
    } finally {
      clearTimeout(timer);
      void reader.cancel().catch(() => undefined);
      await handle.close().catch(() => undefined);
      await unlink(temporary).catch(() => undefined);
    }
  }

  async #open(key: string, maximum: number) {
    const file = this.#path(key);
    let before;
    try {
      before = await lstat(file);
    } catch (error) {
      if (missing(error)) return null;
      throw new IngestStorageError("unavailable");
    }
    if (!before.isFile() || before.isSymbolicLink() || before.size > maximum)
      throw new IngestStorageError("unavailable");
    let handle: FileHandle;
    try {
      handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    } catch (error) {
      if (missing(error)) return null;
      throw new IngestStorageError("unavailable");
    }
    const info = await handle.stat();
    if (info.ino !== before.ino || info.dev !== before.dev) {
      await handle.close();
      throw new IngestStorageError("changed");
    }
    // Staging and final files are never rewritten in place, so the identity
    // pins the bytes; the ETag is their MD5, as COS reports a single PUT's.
    const identity = `${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}:${info.ctimeMs}`;
    let etag = this.#etags.get(identity);
    if (etag === undefined) {
      const md5 = createHash("md5");
      const buffer = Buffer.alloc(INGEST_READ_BYTES);
      for (let offset = 0; offset < info.size;) {
        const { bytesRead } = await handle.read(
          buffer,
          0,
          Math.min(buffer.length, info.size - offset),
          offset,
        );
        if (bytesRead === 0) {
          await handle.close();
          throw new IngestStorageError("changed");
        }
        md5.update(buffer.subarray(0, bytesRead));
        offset += bytesRead;
      }
      etag = `"${md5.digest("hex")}"`;
      if (this.#etags.size >= 256)
        this.#etags.delete(this.#etags.keys().next().value!);
      this.#etags.set(identity, etag);
    }
    return { handle, bytes: info.size, etag };
  }

  async head(key: string): Promise<StoredObject | null> {
    const opened = await this.#open(key, Number.MAX_SAFE_INTEGER);
    if (!opened) return null;
    await opened.handle.close();
    return {
      bytes: opened.bytes,
      etag: opened.etag,
      crc64: null,
      tagCount: STAGING_KEY.test(key) && this.stagingTag ? 1 : 0,
      contentType: null,
      extraAttributes: false,
    };
  }

  async #pinned(key: string, object: StoredObject) {
    const opened = await this.#open(key, object.bytes);
    if (!opened) throw new IngestStorageError("changed");
    if (opened.bytes !== object.bytes || opened.etag !== object.etag) {
      await opened.handle.close();
      throw new IngestStorageError("changed");
    }
    return opened.handle;
  }

  async read(
    key: string,
    start: number,
    end: number,
    object: StoredObject,
  ): Promise<Uint8Array> {
    if (
      !Number.isSafeInteger(start) ||
      !Number.isSafeInteger(end) ||
      start < 0 ||
      end < start ||
      end >= object.bytes ||
      end - start + 1 > INGEST_READ_BYTES
    )
      throw new IngestStorageError("unavailable");
    const handle = await this.#pinned(key, object);
    try {
      const bytes = Buffer.alloc(end - start + 1);
      const { bytesRead } = await handle.read(bytes, 0, bytes.length, start);
      if (bytesRead !== bytes.length) throw new IngestStorageError("changed");
      return bytes;
    } finally {
      await handle.close();
    }
  }

  async copy(
    stagingKey: string,
    finalKey: string,
    source: StoredObject,
  ): Promise<"copied" | "exists"> {
    stagingId(stagingKey);
    const target = path.join(this.#media, finalName(finalKey));
    const handle = await this.#pinned(stagingKey, source);
    await this.#ready();
    const temporary = path.join(this.#root, `.copy-${randomUUID()}.tmp`);
    try {
      const output = await open(
        temporary,
        constants.O_WRONLY |
          constants.O_CREAT |
          constants.O_EXCL |
          constants.O_NOFOLLOW,
        0o600,
      );
      try {
        const buffer = Buffer.alloc(INGEST_READ_BYTES);
        for (let offset = 0; offset < source.bytes;) {
          const { bytesRead } = await handle.read(
            buffer,
            0,
            Math.min(buffer.length, source.bytes - offset),
            offset,
          );
          if (bytesRead === 0) throw new IngestStorageError("changed");
          await output.write(buffer.subarray(0, bytesRead));
          offset += bytesRead;
        }
        await output.sync();
      } finally {
        await output.close();
      }
      // The same mode the native local upload leaves.
      await chmod(temporary, 0o644);
      await mkdir(this.#media, { recursive: true });
      try {
        // Atomic and never replacing: forbid-overwrite.
        await link(temporary, target);
      } catch (error) {
        if (exists(error)) return "exists";
        throw new IngestStorageError("unavailable");
      }
      return "copied";
    } finally {
      await handle.close();
      await unlink(temporary).catch(() => undefined);
    }
  }

  async remove(stagingKey: string): Promise<void> {
    try {
      await unlink(path.join(this.#root, stagingId(stagingKey)));
    } catch (error) {
      if (!missing(error)) throw new IngestStorageError("unavailable");
    }
  }
}

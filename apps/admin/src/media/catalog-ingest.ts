import { createHash, createHmac, hkdfSync } from "node:crypto";
import {
  APIError,
  Forbidden,
  type Endpoint,
  type PayloadRequest,
} from "payload";
import {
  CATALOG_ORIGINAL_MAX_BYTES,
  editorialMediaIngestAbandonResultSchema,
  editorialMediaIngestCompleteResultSchema,
  editorialMediaIngestRequestSchema,
  editorialMediaIngestStartResultSchema,
  editorialMediaIngestStartSchema,
  editorialMediaIngestVerifyRequestSchema,
  editorialMediaIngestVerifyResultSchema,
  editorialRegisteredMediaSchema,
  type EditorialMediaIngestCompleteResult,
  type EditorialMediaIngestStart,
  type EditorialRegisteredMedia,
} from "@moya/contracts/internal/editorial";
import {
  canEditCatalog,
  catalogScope,
  isOwner,
  requireActor,
} from "../editorial/access";
import { EditorialError, safeEditorialFailure } from "../editorial/errors";
import {
  lockEditorialKey,
  withEditorialTransaction,
} from "../editorial/transaction";
import {
  catalogIngestDevelopmentStore,
  catalogIngestSettings,
} from "../runtime-settings";
import {
  editorialObjectKey,
  withVerifiedIngest,
  type VerifiedIngest,
} from "./collection";
import {
  ImageProbeError,
  ImageStructureProbe,
  imageTailComplete,
  type ImageProbeFacts,
} from "./image-header";
import { createIngestDevPutEndpoint } from "./ingest-dev-put";
import {
  INGEST_READ_BYTES,
  IngestStorageError,
  LocalIngestStorage,
  createCosIngestStorage,
  stagingKeyFor,
  stagingUploadHeaders,
  type IngestStorage,
  type StoredObject,
} from "./ingest-storage";

/*
 * Catalog ingest (catalog-scale-v1 increment 2): Catalog originals reach the
 * private bucket without passing EdgeOne, the main site or the CVM uplink,
 * and with no client readback.
 *
 * start signs one staging PUT; complete recomputes everything from the
 * stored bytes and trusts no ticket: under a per-mediaId mutex it re-reads
 * staging in 1 MiB ranged GETs pinned with If-Match, hashes and probes it,
 * copies it to its content-addressed editorial/ key (If-Match,
 * forbid-overwrite) and only then registers the media record from what it
 * read, holding no database connection during any storage request. The
 * routes exist only with CMS_CATALOG_INGEST=on, and nothing is built until
 * the first request. Ingest is stateless: ids are HMAC-derived and the
 * budgets and mutexes live in this single Admin process.
 */

/** Inside nginx's 60 s proxy_read_timeout; the client retries an uncertain reply. */
const DEADLINE_MS = 45_000;
const MAX_RUNNING = 2;
const MAX_IN_FLIGHT = MAX_RUNNING + 8;
const MAX_OUTSTANDING = 32;
const HOUR_MS = 60 * 60 * 1000;
const MAX_ACTOR_HOURLY_BYTES = 4 * 1024 ** 3;
// The global hourly bound, in actor bounds: 12 GiB.
const HOURLY_ACTORS = 3;
// Bounds the in-memory window itself; far above any paced batch.
const MAX_HOURLY_ENTRIES = 20_000;
// MD5/ETag-only mode: how far a header may sit from the start of the file.
const HEADER_READ_LIMIT = 16 * 1024 * 1024;
const TAIL_BYTES = 16;
const MAX_JSON_BYTES = 32 * 1024;
const PRIVATE_HEADERS = {
  "Cache-Control": "private, no-store",
  Vary: "Cookie, Authorization",
};
// Native media hook codes that are safe to return as they are.
const nativeMediaCodes = new Set([
  "MEDIA_INPUT_INVALID",
  "MEDIA_TRANSFORM_DISABLED",
  "MEDIA_IDENTITY_INVALID",
  "MEDIA_FORBIDDEN",
  "MEDIA_IDENTITY_EXISTS",
  "MEDIA_ORIGIN_INVALID",
  "MEDIA_FILE_INVALID",
  "MEDIA_IDENTITY_IMMUTABLE",
  "MEDIA_OBJECT_KEY_MISMATCH",
  "MEDIA_OBJECT_KEY_REQUIRES_ADAPTER_EXTENSION",
]);

function fail(code: string, status = 400): never {
  throw new EditorialError(code, status);
}

type Schema<T> = {
  safeParse: (
    value: unknown,
  ) => { success: true; data: T } | { success: false };
};
const parse = <T>(schema: Schema<T>, value: unknown): T => {
  const result = schema.safeParse(value);
  if (!result.success) fail("INGEST_INPUT_INVALID");
  return result.data;
};
const output = <T>(schema: Schema<T>, value: unknown): T => {
  const result = schema.safeParse(value);
  if (!result.success) fail("INGEST_RESULT_INVALID", 500);
  return result.data;
};

/** The strict JSON body of every ingest route: 32 KiB at most. */
async function readJson(req: PayloadRequest): Promise<unknown> {
  if (
    !/^application\/json(?:;\s*charset=utf-8)?$/i.test(
      req.headers.get("content-type") ?? "",
    )
  )
    fail("INGEST_CONTENT_TYPE_INVALID");
  const advertised = req.headers.get("content-length");
  if (
    advertised !== null &&
    (!/^\d+$/.test(advertised) || Number(advertised) > MAX_JSON_BYTES)
  )
    fail("INGEST_BODY_TOO_LARGE", 413);
  if (!req.body) fail("INGEST_BODY_REQUIRED");
  const reader = req.body.getReader();
  const timer = setTimeout(
    () => void reader.cancel().catch(() => undefined),
    30_000,
  );
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      let next: ReadableStreamReadResult<Uint8Array>;
      try {
        next = await reader.read();
      } catch {
        fail("INGEST_BODY_ABORTED", 408);
      }
      if (next.done) break;
      size += next.value.byteLength;
      if (size > MAX_JSON_BYTES) fail("INGEST_BODY_TOO_LARGE", 413);
      chunks.push(next.value);
    }
  } finally {
    clearTimeout(timer);
    void reader.cancel().catch(() => undefined);
  }
  if (advertised !== null && size !== Number(advertised))
    fail("INGEST_BODY_SIZE_MISMATCH");
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch {
    return fail("INGEST_JSON_INVALID");
  }
}

/** Every field of the intent, in a fixed order; actor-bound. */
const ingestIdFor = (
  key: Buffer,
  actorId: string,
  intent: EditorialMediaIngestStart,
) =>
  createHmac("sha256", key)
    .update(
      JSON.stringify([
        "moya-catalog-ingest-v1",
        actorId,
        intent.transferId,
        intent.catalogId,
        intent.mediaId,
        intent.sha256,
        intent.bytes,
        intent.mimeType,
        intent.md5Base64,
        intent.width ?? null,
        intent.height ?? null,
        intent.alt,
        intent.rights ?? null,
        intent.orderConfidence ?? null,
      ]),
    )
    .digest("hex");

/** A registered record's projection; any record it cannot describe conflicts. */
const projection = (document: unknown): EditorialRegisteredMedia => {
  const record = document as Record<string, unknown>;
  const value: Record<string, unknown> = {};
  for (const field of [
    "id",
    "mediaId",
    "catalogId",
    "objectKey",
    "sha256",
    "mimeType",
    "filesize",
    "filename",
    "width",
    "height",
    "alt",
    "rights",
    "orderConfidence",
  ])
    if (record[field] !== undefined && record[field] !== null)
      value[field] = record[field];
  const parsed = editorialRegisteredMediaSchema.safeParse(value);
  if (!parsed.success) fail("MEDIA_IDENTITY_CONFLICT", 409);
  return parsed.data;
};

const matchesIntent = (
  media: EditorialRegisteredMedia,
  intent: EditorialMediaIngestStart,
) =>
  media.mediaId === intent.mediaId &&
  media.catalogId === intent.catalogId &&
  media.sha256 === intent.sha256 &&
  media.filesize === intent.bytes &&
  media.mimeType === intent.mimeType &&
  media.alt === intent.alt &&
  media.rights === intent.rights &&
  media.orderConfidence === intent.orderConfidence &&
  (intent.width === undefined || media.width === intent.width) &&
  (intent.height === undefined || media.height === intent.height);

/**
 * The scoped record for this intent (overrideAccess false: another
 * catalog's projection is never read), else an unscoped boolean existence
 * check, the same oracle the native hook already exposes.
 */
async function registered(
  req: PayloadRequest,
  intent: EditorialMediaIngestStart,
): Promise<EditorialRegisteredMedia | null> {
  const found = await req.payload.find({
    collection: "media",
    where: { mediaId: { equals: intent.mediaId } },
    limit: 1,
    depth: 0,
    overrideAccess: false,
    req,
    user: req.user,
  });
  if (found.docs[0]) {
    const media = projection(found.docs[0]);
    if (!matchesIntent(media, intent)) fail("MEDIA_IDENTITY_CONFLICT", 409);
    return media;
  }
  const other = await req.payload.find({
    collection: "media",
    where: { mediaId: { equals: intent.mediaId } },
    select: { mediaId: true },
    limit: 1,
    depth: 0,
    overrideAccess: true,
    req,
  });
  if (other.docs.length) fail("MEDIA_IDENTITY_EXISTS", 409);
  return null;
}

/** Whether any record, in any catalog, already holds this object key. */
const keyRegistered = async (req: PayloadRequest, objectKey: string) =>
  (
    await req.payload.find({
      collection: "media",
      where: { objectKey: { equals: objectKey } },
      select: { objectKey: true },
      limit: 1,
      depth: 0,
      overrideAccess: true,
      req,
    })
  ).docs.length > 0;

const reusedResult = (
  media: EditorialRegisteredMedia,
): EditorialMediaIngestCompleteResult =>
  output(editorialMediaIngestCompleteResultSchema, {
    media,
    reused: true,
    validatedBytes: media.filesize,
    validatedSha256: media.sha256,
    validatedMd5: null,
    width: media.width,
    height: media.height,
  });

/** The server deadline of one request; every storage call is aborted at it. */
class Deadline {
  readonly #controller = new AbortController();
  readonly #timer: ReturnType<typeof setTimeout>;
  constructor(milliseconds: number) {
    this.#timer = setTimeout(() => this.#controller.abort(), milliseconds);
  }
  get signal(): AbortSignal {
    return this.#controller.signal;
  }
  check(): void {
    if (this.#controller.signal.aborted) fail("INGEST_DEADLINE_EXCEEDED", 504);
  }
  async wait<T>(promise: Promise<T>): Promise<T> {
    this.check();
    let onAbort = () => {};
    try {
      return await Promise.race([
        promise,
        new Promise<never>((_, reject) => {
          onAbort = () =>
            reject(new EditorialError("INGEST_DEADLINE_EXCEEDED", 504));
          this.signal.addEventListener("abort", onAbort, { once: true });
        }),
      ]);
    } finally {
      this.signal.removeEventListener("abort", onAbort);
    }
  }
  /** One storage request; provider failures stay content-free. */
  async io<T>(work: (signal: AbortSignal) => Promise<T>): Promise<T> {
    this.check();
    try {
      return await work(this.signal);
    } catch (error) {
      this.check();
      if (error instanceof IngestStorageError)
        fail("INGEST_STORAGE_UNAVAILABLE", 503);
      throw error;
    }
  }
  dispose(): void {
    clearTimeout(this.#timer);
  }
}

/** One holder per mediaId at a time, across complete steps (a) to (h) and abandon. */
class KeyedMutex {
  readonly #tails = new Map<string, Promise<void>>();
  async run<T>(
    key: string,
    deadline: Deadline,
    work: () => Promise<T>,
  ): Promise<T> {
    const previous = this.#tails.get(key) ?? Promise.resolve();
    let release = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    // A waiter that gives up still queues its successors behind the holder:
    // the entry goes only once the queue up to it has drained.
    const tail = previous.then(() => held);
    this.#tails.set(key, tail);
    void tail.then(() => {
      if (this.#tails.get(key) === tail) this.#tails.delete(key);
    });
    try {
      await deadline.wait(previous);
      return await work();
    } finally {
      release();
    }
  }
}

/** At most 2 completes and verifies run and 8 wait; beyond that, 429. */
class CompletionGate {
  #inFlight = 0;
  #running = 0;
  readonly #waiting: (() => void)[] = [];
  admit(): () => void {
    if (this.#inFlight >= MAX_IN_FLIGHT) fail("INGEST_BUSY", 429);
    this.#inFlight++;
    let left = false;
    return () => {
      if (!left) this.#inFlight--;
      left = true;
    };
  }
  async slot<T>(deadline: Deadline, work: () => Promise<T>): Promise<T> {
    if (this.#running < MAX_RUNNING) this.#running++;
    else {
      let grant = () => {};
      const granted = new Promise<void>((resolve) => {
        grant = resolve;
      });
      this.#waiting.push(grant);
      try {
        await deadline.wait(granted);
      } catch (error) {
        const index = this.#waiting.indexOf(grant);
        if (index >= 0) this.#waiting.splice(index, 1);
        // Granted at the moment the deadline fired: pass the slot on.
        else this.#release();
        throw error;
      }
    }
    try {
      return await work();
    } finally {
      this.#release();
    }
  }
  #release() {
    const next = this.#waiting.shift();
    if (next) next();
    else this.#running--;
  }
}

/** Bytes per rolling hour, per actor and in total. */
class HourlyBytes {
  #entries: {
    at: number;
    actorId: string;
    key: string | null;
    bytes: number;
  }[] = [];
  constructor(readonly actorLimit: number) {}
  /** key null: never deduplicated (a read, not a signed object). */
  charge(
    actorId: string,
    key: string | null,
    bytes: number,
    now: number,
  ): void {
    this.#entries = this.#entries.filter((entry) => entry.at > now - HOUR_MS);
    // A repeated start re-signs the same key: one object, charged once.
    if (key !== null && this.#entries.some((entry) => entry.key === key))
      return;
    let actorBytes = bytes;
    let total = bytes;
    for (const entry of this.#entries) {
      total += entry.bytes;
      if (entry.actorId === actorId) actorBytes += entry.bytes;
    }
    if (
      actorBytes > this.actorLimit ||
      total > this.actorLimit * HOURLY_ACTORS ||
      this.#entries.length >= MAX_HOURLY_ENTRIES
    )
      fail("INGEST_QUOTA_EXCEEDED", 429);
    this.#entries.push({ at: now, actorId, key, bytes });
  }
  /**
   * A settled ingest's staging object is gone, so its next start signs a new
   * PUT: that start is charged again, and this one's bytes stay counted.
   */
  release(key: string): void {
    for (const entry of this.#entries) if (entry.key === key) entry.key = null;
  }
}

/**
 * Signed-but-unfinished ingests per actor; complete, a content refusal and
 * abandon settle one, and an unsettled one lapses after an hour.
 */
class Outstanding {
  readonly #actors = new Map<string, Map<string, number>>();
  /** Refuses over the bound; the returned commit records the ingest. */
  reserve(actorId: string, ingestId: string, now: number): () => void {
    const own = this.#actors.get(actorId) ?? new Map<string, number>();
    for (const [id, lapse] of own) if (lapse <= now) own.delete(id);
    if (!own.has(ingestId) && own.size >= MAX_OUTSTANDING)
      fail("INGEST_QUOTA_EXCEEDED", 429);
    return () => {
      own.set(ingestId, now + HOUR_MS);
      this.#actors.set(actorId, own);
    };
  }
  settle(actorId: string, ingestId: string): void {
    const own = this.#actors.get(actorId);
    own?.delete(ingestId);
    if (own?.size === 0) this.#actors.delete(actorId);
  }
}

/** A content refusal: staging is deleted and the reply is 422. */
class Refusal extends Error {
  constructor(
    readonly code: "INGEST_HASH_MISMATCH" | "INGEST_CONTENT_INVALID",
  ) {
    super(code);
    this.name = "Refusal";
  }
}

type Facts = Readonly<{
  bytes: number;
  sha256: string;
  md5Base64: string;
  width: number;
  height: number;
}>;

const etagHex = (etag: string) => etag.replace(/^"(.*)"$/, "$1").toLowerCase();
const md5Hex = (base64: string) =>
  Buffer.from(base64, "base64").toString("hex");

/**
 * Reads one stored object and derives its facts. With the server SHA-256
 * (D9, intranet) every byte is hashed and probed; otherwise the MD5 ETag
 * stands for the bytes, the header is probed from a prefix and the tail is
 * checked, and the worker's render-time check verifies the SHA-256.
 */
async function inspect(
  storage: IngestStorage,
  key: string,
  object: StoredObject,
  intent: EditorialMediaIngestStart,
  fullRead: boolean,
  deadline: Deadline,
): Promise<Facts> {
  const probe = new ImageStructureProbe(intent.mimeType, {
    declaredWidth: intent.width,
    declaredHeight: intent.height,
  });
  const refuseContent = (error: unknown): never => {
    if (error instanceof ImageProbeError)
      throw new Refusal("INGEST_CONTENT_INVALID");
    throw error;
  };
  const feed = (chunk: Uint8Array) => {
    try {
      probe.update(chunk);
    } catch (error) {
      refuseContent(error);
    }
  };
  const finish = (): ImageProbeFacts => {
    try {
      return probe.finish();
    } catch (error) {
      return refuseContent(error);
    }
  };
  const range = (start: number, end: number) =>
    deadline.io((signal) => storage.read(key, start, end, object, signal));
  if (!fullRead) {
    if (etagHex(object.etag) !== md5Hex(intent.md5Base64))
      throw new Refusal("INGEST_HASH_MISMATCH");
    let offset = 0;
    while (!probe.header && offset < object.bytes) {
      if (offset >= HEADER_READ_LIMIT)
        throw new Refusal("INGEST_CONTENT_INVALID");
      const end = Math.min(offset + INGEST_READ_BYTES, object.bytes) - 1;
      feed(await range(offset, end));
      offset = end + 1;
    }
    let size: ImageProbeFacts;
    if (offset >= object.bytes) size = finish();
    else {
      const tail = await range(
        Math.max(0, object.bytes - TAIL_BYTES),
        object.bytes - 1,
      );
      if (!imageTailComplete(intent.mimeType, tail, object.bytes, probe))
        throw new Refusal("INGEST_CONTENT_INVALID");
      size = probe.header!;
    }
    return {
      bytes: object.bytes,
      sha256: intent.sha256,
      md5Base64: intent.md5Base64,
      width: size.width,
      height: size.height,
    };
  }
  const sha256 = createHash("sha256");
  const md5 = createHash("md5");
  for (let offset = 0; offset < object.bytes;) {
    const end = Math.min(offset + INGEST_READ_BYTES, object.bytes) - 1;
    const chunk = await range(offset, end);
    sha256.update(chunk);
    md5.update(chunk);
    feed(chunk);
    offset = end + 1;
  }
  const size = finish();
  const facts = {
    bytes: object.bytes,
    sha256: sha256.digest("hex"),
    md5Base64: md5.digest("base64"),
    width: size.width,
    height: size.height,
  };
  if (facts.sha256 !== intent.sha256 || facts.md5Base64 !== intent.md5Base64)
    throw new Refusal("INGEST_HASH_MISMATCH");
  return facts;
}

type Context = Readonly<{
  storage: IngestStorage;
  ingestKey: Buffer;
  serverSha256: boolean;
}>;

/**
 * The Catalog ingest routes. payload.config.ts composes them only with
 * CMS_CATALOG_INGEST=on; the dev-only PUT route is added only for the
 * Development store. Settings and clients are read on the first request.
 */
export function createCatalogIngestEndpoints(options: {
  mediaDirectory: string;
  stagingDirectory: string;
  environment?: Readonly<Record<string, string | undefined>>;
  /** Tests only shorten it. */
  deadlineMs?: number;
  /** Tests only lower it: the per-actor hourly bytes (the global is 3 ×). */
  actorHourlyBytes?: number;
}): Endpoint[] {
  const environment = options.environment ?? process.env;
  const deadlineMs = options.deadlineMs ?? DEADLINE_MS;
  const actorHourlyBytes = options.actorHourlyBytes ?? MAX_ACTOR_HOURLY_BYTES;
  const mutex = new KeyedMutex();
  const gate = new CompletionGate();
  const outstanding = new Outstanding();
  // Signed (declared) bytes, the bytes complete reads, and verify's reads.
  const ingestBytes = new HourlyBytes(actorHourlyBytes);
  const readBytes = new HourlyBytes(actorHourlyBytes);
  const verifyBytes = new HourlyBytes(actorHourlyBytes);
  let verifications = 0;
  let context: Context | undefined;
  const ready = (req: PayloadRequest): Context => {
    if (context) return context;
    try {
      const settings = catalogIngestSettings(environment);
      const secret = environment.CMS_SECRET;
      if (!secret) throw new Error("CMS_SECRET");
      const derive = (info: string) =>
        Buffer.from(hkdfSync("sha256", secret, Buffer.alloc(0), info, 32));
      context = {
        storage:
          settings.storage.mode === "cos"
            ? createCosIngestStorage({
                ...settings.storage,
                uploadEndpoint: settings.uploadEndpoint,
                stagingTag: settings.stagingTag,
              })
            : new LocalIngestStorage({
                stagingDirectory: options.stagingDirectory,
                mediaDirectory: options.mediaDirectory,
                uploadEndpoint: settings.uploadEndpoint,
                tokenKey: derive("moya-catalog-ingest-dev-put-v1"),
                stagingTag: settings.stagingTag,
              }),
        ingestKey: derive("moya-catalog-ingest-v1"),
        serverSha256: settings.serverSha256,
      };
      return context;
    } catch {
      return configurationInvalid(req);
    }
  };
  /** Admission, then the mediaId mutex (if any), then a run slot. */
  const admitted = async <T>(
    deadline: Deadline,
    mediaId: string | null,
    work: () => Promise<T>,
  ): Promise<T> => {
    const leave = gate.admit();
    try {
      const run = () => gate.slot(deadline, work);
      return mediaId === null
        ? await run()
        : await mutex.run(mediaId, deadline, run);
    } finally {
      leave();
    }
  };
  /** Complete, a content refusal or abandon: the staging key is gone. */
  const settle = (actorId: string, ingestId: string) => {
    outstanding.settle(actorId, ingestId);
    ingestBytes.release(ingestId);
  };
  function configurationInvalid(req: PayloadRequest): never {
    req.payload.logger.error({
      category: "EDITORIAL_MEDIA_INGEST_CONFIGURATION_INVALID",
    });
    return fail("INGEST_CONFIGURATION_INVALID", 503);
  }
  function finalInvalid(req: PayloadRequest): never {
    req.payload.logger.error({
      category: "EDITORIAL_MEDIA_INGEST_FINAL_INVALID",
    });
    return fail("INGEST_FINAL_INVALID", 500);
  }

  async function complete(
    req: PayloadRequest,
    { storage, serverSha256 }: Context,
    intent: EditorialMediaIngestStart,
    staging: string,
    deadline: Deadline,
    /** Charges the actor's hourly read bytes before an object is read. */
    chargeRead: (bytes: number) => void,
  ): Promise<EditorialMediaIngestCompleteResult> {
    // (h) Best effort, after a registration or a reuse: removing a missing
    // key is success, and abandon and the staging lifecycle are the
    // backstops.
    const removeStaging = async () => {
      try {
        await deadline.io((signal) => storage.remove(staging, signal));
      } catch {
        req.payload.logger.warn({
          category: "EDITORIAL_MEDIA_INGEST_STAGING_DELETE_FAILED",
        });
      }
    };
    // (a) A short transaction under the relay's own media lock; nothing is
    // read, copied or written for a registered or conflicting mediaId. A
    // reuse (another path registered it) never copies the caller's own
    // staging object, so it is removed before the answer.
    const prior = await withEditorialTransaction(req, async () => {
      await lockEditorialKey(req, `media-upload-media:${intent.mediaId}`);
      return registered(req, intent);
    });
    if (prior) {
      await removeStaging();
      return reusedResult(prior);
    }
    const target = editorialObjectKey(
      intent.catalogId,
      intent.mediaId,
      intent.sha256,
      intent.mimeType,
    );
    const head = (key: string) =>
      deadline.io((signal) => storage.head(key, signal));
    const refuse = async (code: string): Promise<never> => {
      await deadline.io((signal) => storage.remove(staging, signal));
      return fail(code, 422);
    };
    // Exactly what a signed staging PUT stores: its Content-Type, no other
    // metadata, storage class or encryption, and only the signed tag.
    const plain = (object: StoredObject, tags: number) =>
      (object.contentType === null || object.contentType === intent.mimeType) &&
      !object.extraAttributes &&
      object.tagCount === tags;
    // What inspect may read: every byte, or a header prefix and the tail.
    const charge = (object: StoredObject, fullRead: boolean) =>
      chargeRead(
        fullRead
          ? object.bytes
          : Math.min(object.bytes, HEADER_READ_LIMIT + TAIL_BYTES),
      );
    let facts: Facts | null = null;
    for (let attempt = 0; attempt < 2 && !facts; attempt++) {
      // (b) A final object (an earlier copy, or a crash between copy and
      // create) is fully re-verified, never trusted by its length.
      const existing = await head(target.objectKey);
      if (existing) {
        if (existing.bytes !== intent.bytes || !plain(existing, 0))
          finalInvalid(req);
        charge(existing, serverSha256);
        facts = await inspect(
          storage,
          target.objectKey,
          existing,
          intent,
          serverSha256,
          deadline,
        ).catch((error: unknown) =>
          error instanceof Refusal ? finalInvalid(req) : Promise.reject(error),
        );
        break;
      }
      // (c)
      const source = await head(staging);
      if (!source) fail("INGEST_NOT_UPLOADED", 409);
      // L1: staging must show its signed tag, or storage that reports no
      // tags would make the final object's tag check pass vacuously.
      if (storage.stagingTag && source.tagCount === 0)
        configurationInvalid(req);
      if (source.bytes !== intent.bytes) await refuse("INGEST_SIZE_MISMATCH");
      // Anything else the PUT stored (an unsigned tag, metadata, storage
      // class or encryption) is refused here: the copy would carry it onto
      // an original the Admin cannot delete, under a key every retry reuses.
      if (!plain(source, storage.stagingTag ? 1 : 0))
        await refuse("INGEST_STAGING_INVALID");
      // (d), (e)
      charge(source, serverSha256);
      const verified = await inspect(
        storage,
        staging,
        source,
        intent,
        serverSha256,
        deadline,
      ).catch((error: unknown) =>
        error instanceof Refusal ? refuse(error.code) : Promise.reject(error),
      );
      // (f) Same bucket, pinned to the verified ETag, never replacing.
      const copied = await deadline.io((signal) =>
        storage.copy(staging, target.objectKey, source, signal),
      );
      if (copied === "exists") continue;
      const result = await head(target.objectKey);
      if (!result || result.bytes !== intent.bytes || !plain(result, 0))
        finalInvalid(req);
      if (
        result.etag !== source.etag &&
        (result.crc64 === null || result.crc64 !== source.crc64)
      ) {
        // Neither ETag nor CRC64 equality: re-hash the final object once.
        charge(result, true);
        await inspect(
          storage,
          target.objectKey,
          result,
          intent,
          true,
          deadline,
        ).catch((error: unknown) =>
          error instanceof Refusal ? finalInvalid(req) : Promise.reject(error),
        );
      }
      facts = verified;
    }
    if (!facts) fail("INGEST_STORAGE_UNAVAILABLE", 503);
    const verifiedFacts = facts;
    deadline.check();
    // (g) Lock again and re-check: another path may have won meanwhile.
    const outcome = await withEditorialTransaction(req, async () => {
      await lockEditorialKey(req, `media-upload-media:${intent.mediaId}`);
      let winner: EditorialRegisteredMedia | null;
      try {
        winner = await registered(req, intent);
      } catch (error) {
        // The verified final object stays (the Admin cannot delete
        // editorial/); it is an orphan only if no record holds its key.
        if (
          error instanceof EditorialError &&
          error.status === 409 &&
          !(await keyRegistered(req, target.objectKey))
        )
          req.payload.logger.warn({
            category: "EDITORIAL_MEDIA_INGEST_ORPHAN",
          });
        throw error;
      }
      if (winner) return reusedResult(winner);
      deadline.check();
      // The storage adapter would PutObject over the final key without
      // forbid-overwrite if a file reached it.
      if (
        req.file !== undefined ||
        req.context?._payloadCloudStorage !== undefined
      )
        fail("INGEST_FILE_PRESENT", 500);
      const marker: VerifiedIngest = {
        catalogId: intent.catalogId,
        mediaId: intent.mediaId,
        origin: "upload",
        objectKey: target.objectKey,
        prefix: target.prefix,
        filename: target.filename,
        sha256: verifiedFacts.sha256,
        filesize: verifiedFacts.bytes,
        mimeType: intent.mimeType,
        width: verifiedFacts.width,
        height: verifiedFacts.height,
        alt: intent.alt,
        ...(intent.rights === undefined ? {} : { rights: intent.rights }),
        ...(intent.orderConfidence === undefined
          ? {}
          : { orderConfidence: intent.orderConfidence }),
      };
      const document = await withVerifiedIngest(req, marker, () =>
        req.payload.create({
          collection: "media",
          overrideAccess: false,
          req,
          user: req.user,
          depth: 0,
          data: { ...marker },
        }),
      );
      const media = projection(document);
      if (
        !matchesIntent(media, intent) ||
        media.objectKey !== target.objectKey ||
        media.width !== verifiedFacts.width ||
        media.height !== verifiedFacts.height
      )
        fail("INGEST_READBACK_MISMATCH", 500);
      return output(editorialMediaIngestCompleteResultSchema, {
        media,
        reused: false,
        validatedBytes: verifiedFacts.bytes,
        validatedSha256: verifiedFacts.sha256,
        validatedMd5: verifiedFacts.md5Base64,
        width: verifiedFacts.width,
        height: verifiedFacts.height,
      });
    });
    // (h)
    await removeStaging();
    return outcome;
  }

  const endpoint = (
    route: string,
    operation: (req: PayloadRequest, context: Context) => Promise<unknown>,
  ): Endpoint => ({
    path: `/editorial/media-ingest/${route}`,
    method: "post",
    handler: async (req) => {
      try {
        // Authenticate before reading a body or building a client.
        requireActor(req);
        return Response.json(
          { ok: true, result: await operation(req, ready(req)) },
          { headers: PRIVATE_HEADERS },
        );
      } catch (error) {
        const safeError =
          error instanceof Forbidden
            ? // A scoped read the actor's Catalog scope does not allow.
              new EditorialError("INGEST_FORBIDDEN", 403)
            : error instanceof APIError &&
                !(error instanceof EditorialError) &&
                nativeMediaCodes.has(error.message)
              ? new EditorialError(error.message, error.status)
              : error;
        if (!(safeError instanceof EditorialError))
          req.payload.logger.error({
            category: "EDITORIAL_MEDIA_INGEST_FAILED",
          });
        return Response.json(safeEditorialFailure(safeError), {
          status: safeError instanceof EditorialError ? safeError.status : 500,
          headers: PRIVATE_HEADERS,
        });
      }
    },
  });

  const routes: Endpoint[] = [
    endpoint("start", async (req, context) => {
      const intent = parse(
        editorialMediaIngestStartSchema,
        await readJson(req),
      );
      const actorId = String(requireActor(req).id);
      if (!canEditCatalog(req, intent.catalogId)) fail("INGEST_FORBIDDEN", 403);
      const media = await registered(req, intent);
      if (media)
        return output(editorialMediaIngestStartResultSchema, {
          state: "registered",
          media,
        });
      // A repeated start re-signs the same staging key.
      const ingestId = ingestIdFor(context.ingestKey, actorId, intent);
      const now = Date.now();
      const headers = stagingUploadHeaders(intent, context.storage.stagingTag);
      const upload = await context.storage
        .signUpload(stagingKeyFor(ingestId), headers, new Date(now))
        .catch(() => fail("INGEST_SIGNER_UNAVAILABLE", 503));
      const admit = outstanding.reserve(actorId, ingestId, now);
      ingestBytes.charge(actorId, ingestId, intent.bytes, now);
      admit();
      return output(editorialMediaIngestStartResultSchema, {
        state: "upload",
        ingestId,
        upload: {
          method: "PUT",
          url: upload.url,
          headers,
          expiresAt: upload.expiresAt.toISOString(),
        },
      });
    }),
    endpoint("complete", async (req, context) => {
      const { intent } = parse(
        editorialMediaIngestRequestSchema,
        await readJson(req),
      );
      const actorId = String(requireActor(req).id);
      if (!canEditCatalog(req, intent.catalogId)) fail("INGEST_FORBIDDEN", 403);
      const ingestId = ingestIdFor(context.ingestKey, actorId, intent);
      const deadline = new Deadline(deadlineMs);
      try {
        const result = await admitted(deadline, intent.mediaId, () =>
          complete(
            req,
            context,
            intent,
            stagingKeyFor(ingestId),
            deadline,
            (bytes) => readBytes.charge(actorId, null, bytes, Date.now()),
          ),
        );
        settle(actorId, ingestId);
        return result;
      } catch (error) {
        if (error instanceof EditorialError && error.status === 422)
          settle(actorId, ingestId);
        throw error;
      } finally {
        deadline.dispose();
      }
    }),
    endpoint("abandon", async (req, context) => {
      const { intent } = parse(
        editorialMediaIngestRequestSchema,
        await readJson(req),
      );
      const actorId = String(requireActor(req).id);
      if (!canEditCatalog(req, intent.catalogId)) fail("INGEST_FORBIDDEN", 403);
      // Only the caller's own derived key; never during another holder's
      // verification and copy of this mediaId. HEAD first, so the answer
      // says whether anything was removed: a caller that is not the batch's
      // actor finds its own key empty and is told so, not "abandoned".
      const ingestId = ingestIdFor(context.ingestKey, actorId, intent);
      const stagingKey = stagingKeyFor(ingestId);
      const deadline = new Deadline(deadlineMs);
      let staged: boolean;
      try {
        staged = await mutex.run(intent.mediaId, deadline, async () => {
          let found = false;
          let failure: unknown = null;
          try {
            found =
              (await deadline.io((signal) =>
                context.storage.head(stagingKey, signal),
              )) !== null;
          } catch (error) {
            failure = error;
          }
          // Removed either way, a PUT landing after the HEAD included; a HEAD
          // that failed does not keep the object, but leaves no answer.
          await deadline.io((signal) =>
            context.storage.remove(stagingKey, signal),
          );
          if (failure !== null) throw failure;
          return found;
        });
      } finally {
        deadline.dispose();
      }
      settle(actorId, ingestId);
      return output(editorialMediaIngestAbandonResultSchema, {
        ingestId,
        state: staged ? "abandoned" : "absent",
      });
    }),
    endpoint("verify", async (req, context) => {
      const { mediaId } = parse(
        editorialMediaIngestVerifyRequestSchema,
        await readJson(req),
      );
      const actorId = String(requireActor(req).id);
      // An automation actor without a Catalog scope reads no media at all.
      if (!isOwner(req) && catalogScope(req).length === 0)
        fail("INGEST_FORBIDDEN", 403);
      // D9: without server reads, the SHA-256 check stays with the worker.
      if (!context.serverSha256) fail("INGEST_SERVER_HASH_DISABLED", 409);
      const found = await req.payload.find({
        collection: "media",
        where: { mediaId: { equals: mediaId } },
        limit: 1,
        depth: 0,
        overrideAccess: false,
        req,
        user: req.user,
      });
      if (!found.docs[0]) fail("MEDIA_NOT_FOUND", 404);
      const media = projection(found.docs[0]);
      if (
        editorialObjectKey(
          media.catalogId,
          media.mediaId,
          media.sha256,
          media.mimeType,
        ).objectKey !== media.objectKey
      )
        fail("INGEST_VERIFY_UNSUPPORTED", 409);
      verifyBytes.charge(
        actorId,
        String(++verifications),
        media.filesize,
        Date.now(),
      );
      const deadline = new Deadline(deadlineMs);
      try {
        return await admitted(deadline, null, async () => {
          const object = await deadline.io((signal) =>
            context.storage.head(media.objectKey, signal),
          );
          if (
            !object ||
            object.bytes < 1 ||
            object.bytes > CATALOG_ORIGINAL_MAX_BYTES
          )
            return output(editorialMediaIngestVerifyResultSchema, {
              media,
              intact: false,
              validatedBytes: object?.bytes ?? 0,
              validatedSha256: null,
            });
          const sha256 = createHash("sha256");
          for (let offset = 0; offset < object.bytes;) {
            const end = Math.min(offset + INGEST_READ_BYTES, object.bytes) - 1;
            sha256.update(
              await deadline.io((signal) =>
                context.storage.read(
                  media.objectKey,
                  offset,
                  end,
                  object,
                  signal,
                ),
              ),
            );
            offset = end + 1;
          }
          const digest = sha256.digest("hex");
          return output(editorialMediaIngestVerifyResultSchema, {
            media,
            intact: object.bytes === media.filesize && digest === media.sha256,
            validatedBytes: object.bytes,
            validatedSha256: digest,
          });
        });
      } finally {
        deadline.dispose();
      }
    }),
  ];
  if (catalogIngestDevelopmentStore(environment))
    routes.push(
      createIngestDevPutEndpoint((req) => {
        const { storage } = ready(req);
        if (!(storage instanceof LocalIngestStorage))
          fail("INGEST_NOT_FOUND", 404);
        return storage;
      }),
    );
  return routes;
}

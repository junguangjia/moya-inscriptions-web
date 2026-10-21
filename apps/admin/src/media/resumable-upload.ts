import { createHash, randomUUID } from "node:crypto";
import { constants, realpathSync } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  rename,
  rmdir,
  unlink,
} from "node:fs/promises";
import path from "node:path";
import { APIError, type Endpoint, type PayloadRequest } from "payload";
import {
  MEDIA_UPLOAD_CHUNK_BYTES,
  MEDIA_UPLOAD_STREAM_VERSION,
  MAX_MEDIA_UPLOAD_BYTES,
  editorialMediaUploadStartSchema,
  editorialMediaUploadSessionRequestSchema,
  editorialMediaUploadSessionSchema,
  editorialMediaUploadChunkResultSchema,
  editorialMediaUploadCompleteResultSchema,
  editorialUploadedMediaSchema,
  type EditorialMediaUploadStart,
  type EditorialMediaUploadSession,
  type EditorialMediaUploadCompleteResult,
  type EditorialUploadedMedia,
} from "@moya/contracts/internal/editorial";
import { canEditCatalog, requireActor } from "../editorial/access";
import { requestFingerprint } from "../editorial/content";
import { EditorialError, safeEditorialFailure } from "../editorial/errors";
import {
  lockEditorialKey,
  withEditorialTransaction,
} from "../editorial/transaction";

const SESSION_TTL = 24 * 60 * 60 * 1000;
const MAX_SESSIONS = 128;
const MAX_RETAINED_SESSIONS = 512;
const TERMINAL_RECONCILIATION_TTL = 15 * 60 * 1000;
const MAX_ACTOR_SESSIONS = 64;
const MAX_RESERVED_BYTES = 2 * 1024 * 1024 * 1024;
const MAX_ACTOR_RESERVED_BYTES = 512 * 1024 * 1024;
const STREAM_IDLE_MS = 30_000;
const STREAM_MAX_MS = 300_000;
const digest = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");
const keyDigest = (value: string) =>
  createHash("sha256").update(value).digest("hex");
const hex = (value: unknown): value is string =>
  typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
function fail(code: string, status = 400): never {
  throw new EditorialError(code, status);
}
function currentUid(): number {
  if (typeof process.getuid !== "function") fail("UPLOAD_STORAGE_UNSAFE", 503);
  return process.getuid();
}
const nativeMediaCodes = new Set([
  "MEDIA_DELETE_DISABLED",
  "MEDIA_INPUT_INVALID",
  "MEDIA_TRANSFORM_DISABLED",
  "MEDIA_REPLACEMENT_DISABLED",
  "MEDIA_IDENTITY_INVALID",
  "MEDIA_FORBIDDEN",
  "MEDIA_IDENTITY_EXISTS",
  "MEDIA_REGISTRATION_FORBIDDEN",
  "MEDIA_REGISTRATION_INVALID",
  "MEDIA_OBJECT_KEY_REQUIRES_ADAPTER_EXTENSION",
  "MEDIA_ORIGIN_INVALID",
  "MEDIA_FILE_INVALID",
  "MEDIA_ORIGINAL_BYTES_CONFIGURATION_REQUIRED",
  "MEDIA_IDENTITY_IMMUTABLE",
  "MEDIA_OBJECT_KEY_MISMATCH",
]);
const missing = (error: unknown) =>
  (error as { code?: string })?.code === "ENOENT";
type Manifest = {
  version: 1;
  uploadId: string;
  actorId: string;
  intent: EditorialMediaUploadStart;
  createdAt: number;
  expiresAt: number;
};
type InstalledFile = {
  file: string;
  inode: number;
  device: number;
  bytes: number;
  sha256: string;
};
const idFor = (actorId: string, intent: EditorialMediaUploadStart) =>
  requestFingerprint({ version: "editorial-upload-v1", actorId, intent });

/** Private session bytes only. This directory must never be a served media subtree. */
export class EditorialUploadStore {
  readonly root: string;
  constructor(directory: string, mediaDirectory: string) {
    if (
      path.resolve(directory) !== directory ||
      path.resolve(mediaDirectory) !== mediaDirectory
    )
      fail("UPLOAD_DIRECTORY_INVALID", 503);
    // Canonicalize parent aliases such as macOS /var -> /private/var while
    // preserving the final staging component for the no-follow ownership checks.
    try {
      this.root = path.join(
        realpathSync.native(path.dirname(directory)),
        path.basename(directory),
      );
    } catch {
      fail("UPLOAD_STORAGE_UNSAFE", 503);
    }
    let media: string;
    try {
      media = realpathSync.native(mediaDirectory);
    } catch (error) {
      if (!missing(error)) fail("UPLOAD_STORAGE_UNSAFE", 503);
      try {
        media = path.join(
          realpathSync.native(path.dirname(mediaDirectory)),
          path.basename(mediaDirectory),
        );
      } catch {
        fail("UPLOAD_STORAGE_UNSAFE", 503);
      }
    }
    if (
      this.root === media ||
      this.root.startsWith(media + path.sep) ||
      media.startsWith(this.root + path.sep)
    )
      fail("UPLOAD_DIRECTORY_INVALID", 503);
  }
  private async directory(directory: string) {
    const info = await lstat(directory);
    if (
      !info.isDirectory() ||
      info.isSymbolicLink() ||
      info.uid !== currentUid() ||
      (info.mode & 0o777) !== 0o700 ||
      (await realpath(directory)) !== directory
    )
      fail("UPLOAD_STORAGE_UNSAFE", 503);
  }
  async ready() {
    try {
      await mkdir(this.root, { mode: 0o700 });
    } catch (error) {
      if ((error as { code?: string }).code !== "EEXIST") throw error;
    }
    await this.directory(this.root);
  }
  sessionPath(uploadId: string) {
    if (!hex(uploadId)) fail("UPLOAD_ID_INVALID");
    return path.join(this.root, uploadId);
  }
  private async read(file: string, maximum: number) {
    const before = await lstat(file);
    const safe = (info: typeof before) =>
      info.isFile() &&
      !info.isSymbolicLink() &&
      info.uid === currentUid() &&
      info.nlink === 1 &&
      (info.mode & 0o777) === 0o600 &&
      info.size <= maximum;
    if (!safe(before) || (await realpath(file)) !== file)
      fail("UPLOAD_STORAGE_UNSAFE", 503);
    const handle = await open(
      file,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    try {
      const current = await handle.stat();
      if (
        !safe(current) ||
        current.ino !== before.ino ||
        current.dev !== before.dev ||
        current.size !== before.size
      )
        fail("UPLOAD_STORAGE_UNSAFE", 503);
      const bytes = await handle.readFile();
      const after = await handle.stat();
      if (
        !safe(after) ||
        bytes.length !== current.size ||
        after.size !== current.size ||
        after.mtimeMs !== current.mtimeMs ||
        after.ctimeMs !== current.ctimeMs
      )
        fail("UPLOAD_SOURCE_CHANGED", 409);
      return bytes;
    } finally {
      await handle.close();
    }
  }
  private async sync(directory: string) {
    const handle = await open(
      directory,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  }
  /** Every caller holds the session's database advisory lock. Never replaces a conflict. */
  private async install(
    directory: string,
    name: string,
    bytes: Buffer,
    onInstalled?: (item: InstalledFile) => void,
  ) {
    await this.directory(directory);
    const target = path.join(directory, name);
    try {
      const existing = await this.read(target, bytes.length);
      if (!existing.equals(bytes)) fail("UPLOAD_CHUNK_CONFLICT", 409);
      return null;
    } catch (error) {
      if (!missing(error)) throw error;
    }
    const temporary = path.join(directory, name + "." + randomUUID() + ".tmp");
    const handle = await open(
      temporary,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW,
      0o600,
    );
    let inode: number;
    let device: number;
    try {
      try {
        const identity = await handle.stat();
        inode = identity.ino;
        device = identity.dev;
        await handle.writeFile(bytes);
        await handle.sync();
      } finally {
        await handle.close();
      }
      // The advisory lock excludes every protocol writer, including another Admin process.
      // If a target already exists it is compared above; rename only installs an absent target.
      await rename(temporary, target);
      const installed = {
        file: target,
        inode,
        device,
        bytes: bytes.length,
        sha256: digest(bytes),
      };
      // Track ownership before directory fsync, so a known-invalid span also
      // rolls back this exact new file if durability fails after its rename.
      onInstalled?.(installed);
      await this.sync(directory);
      return installed;
    } finally {
      await unlink(temporary).catch((error: unknown) => {
        if (!missing(error)) throw error;
      });
    }
  }
  async manifest(uploadId: string): Promise<Manifest> {
    await this.ready();
    const directory = this.sessionPath(uploadId);
    try {
      await this.directory(directory);
    } catch (error) {
      if (missing(error)) fail("UPLOAD_NOT_FOUND", 404);
      throw error;
    }
    let raw: unknown;
    try {
      raw = JSON.parse(
        (
          await this.read(path.join(directory, "manifest.json"), 32 * 1024)
        ).toString("utf8"),
      );
    } catch (error) {
      if (error instanceof SyntaxError) fail("UPLOAD_STORAGE_UNSAFE", 503);
      throw error;
    }
    if (!raw || typeof raw !== "object" || Array.isArray(raw))
      fail("UPLOAD_STORAGE_UNSAFE", 503);
    const value = raw as Manifest;
    const parsed = editorialMediaUploadStartSchema.safeParse(value.intent);
    if (
      Object.keys(value).sort().join(",") !==
        "actorId,createdAt,expiresAt,intent,uploadId,version" ||
      value.version !== 1 ||
      value.uploadId !== uploadId ||
      typeof value.actorId !== "string" ||
      !value.actorId ||
      !parsed.success ||
      !Number.isSafeInteger(value.createdAt) ||
      value.createdAt < 0 ||
      !Number.isSafeInteger(value.expiresAt) ||
      value.expiresAt > 8_640_000_000_000_000 ||
      value.expiresAt - value.createdAt !== SESSION_TTL ||
      idFor(value.actorId, parsed.data) !== uploadId
    )
      fail("UPLOAD_STORAGE_UNSAFE", 503);
    return { ...value, intent: parsed.data };
  }
  async authorize(req: PayloadRequest, uploadId: string) {
    const actor = requireActor(req);
    const manifest = await this.manifest(uploadId);
    if (
      manifest.actorId !== String(actor.id) ||
      !canEditCatalog(req, manifest.intent.catalogId)
    )
      fail("UPLOAD_FORBIDDEN", 403);
    if (manifest.expiresAt <= Date.now()) fail("UPLOAD_EXPIRED", 410);
    return manifest;
  }
  private chunkName(index: number) {
    return `chunk-${index}.bin`;
  }
  private expectedBytes(manifest: Manifest, index: number) {
    const count = Math.ceil(manifest.intent.bytes / MEDIA_UPLOAD_CHUNK_BYTES);
    if (!Number.isSafeInteger(index) || index < 0 || index >= count)
      fail("UPLOAD_CHUNK_INDEX_INVALID");
    return Math.min(
      MEDIA_UPLOAD_CHUNK_BYTES,
      manifest.intent.bytes - index * MEDIA_UPLOAD_CHUNK_BYTES,
    );
  }
  private async inventory(manifest: Manifest) {
    const directory = this.sessionPath(manifest.uploadId);
    await this.directory(directory);
    const names = await readdir(directory);
    const count = Math.ceil(manifest.intent.bytes / MEDIA_UPLOAD_CHUNK_BYTES);
    if (
      names.length > count * 2 + 8 ||
      names.some((name) => {
        const chunk =
          /^chunk-(0|[1-9]\d{0,2})\.bin(?:\.[a-f0-9-]{36}\.tmp)?$/.exec(name);
        return chunk
          ? Number(chunk[1]) >= count
          : name !== "manifest.json" &&
              name !== "complete.json" &&
              !/^(?:manifest\.json|complete\.json)\.[a-f0-9-]{36}\.tmp$/.test(
                name,
              );
      })
    )
      fail("UPLOAD_STORAGE_UNSAFE", 503);
    return names;
  }
  async status(manifest: Manifest): Promise<EditorialMediaUploadSession> {
    const names = await this.inventory(manifest);
    const receivedIndices: number[] = [];
    for (const name of names) {
      const found = /^chunk-(0|[1-9]\d{0,2})\.bin$/.exec(name);
      if (!found) continue;
      const index = Number(found[1]),
        expected = this.expectedBytes(manifest, index);
      if (
        (
          await this.read(
            path.join(this.sessionPath(manifest.uploadId), name),
            expected,
          )
        ).length !== expected
      )
        fail("UPLOAD_CHUNK_INVALID", 409);
      receivedIndices.push(index);
    }
    receivedIndices.sort((a, b) => a - b);
    const chunkCount = Math.ceil(
      manifest.intent.bytes / MEDIA_UPLOAD_CHUNK_BYTES,
    );
    let complete = false;
    if (names.includes("complete.json")) {
      const parsed = editorialMediaUploadCompleteResultSchema.safeParse(
        JSON.parse(
          (
            await this.read(
              path.join(this.sessionPath(manifest.uploadId), "complete.json"),
              32 * 1024,
            )
          ).toString("utf8"),
        ),
      );
      if (
        !parsed.success ||
        receivedIndices.length !== chunkCount ||
        parsed.data.validatedBytes !== manifest.intent.bytes ||
        parsed.data.validatedSha256 !== manifest.intent.sha256 ||
        !matchesIntent(parsed.data.media, manifest.intent)
      )
        fail("UPLOAD_STORAGE_UNSAFE", 503);
      complete = true;
    }
    return editorialMediaUploadSessionSchema.parse({
      uploadId: manifest.uploadId,
      state: complete
        ? "complete"
        : receivedIndices.length === chunkCount
          ? "ready"
          : "uploading",
      chunkBytes: MEDIA_UPLOAD_CHUNK_BYTES,
      chunkCount,
      receivedIndices,
      expiresAt: new Date(manifest.expiresAt).toISOString(),
    });
  }
  async create(
    actorId: string,
    intent: EditorialMediaUploadStart,
  ): Promise<Manifest> {
    await this.ready();
    const uploadId = idFor(actorId, intent),
      directory = this.sessionPath(uploadId);
    try {
      return await this.manifest(uploadId);
    } catch (error) {
      if (!(
        error instanceof EditorialError && error.code === "UPLOAD_NOT_FOUND"
      ))
        throw error;
    }
    const createdAt = Date.now();
    const manifest: Manifest = {
      version: 1,
      uploadId,
      actorId,
      intent,
      createdAt,
      expiresAt: createdAt + SESSION_TTL,
    };
    const temporary = path.join(
      this.root,
      `.initializing-${uploadId}-${randomUUID()}`,
    );
    await mkdir(temporary, { mode: 0o700 });
    await this.install(
      temporary,
      "manifest.json",
      Buffer.from(JSON.stringify(manifest)),
    );
    // Publish only a durable, initialized session. Allocation lock excludes all starters.
    await rename(temporary, directory);
    await this.sync(this.root);
    return manifest;
  }
  async writeChunk(
    manifest: Manifest,
    index: number,
    bytes: Buffer,
    onInstalled?: (item: InstalledFile) => void,
  ) {
    if (bytes.length !== this.expectedBytes(manifest, index))
      fail("UPLOAD_CHUNK_SIZE_MISMATCH");
    return this.install(
      this.sessionPath(manifest.uploadId),
      this.chunkName(index),
      bytes,
      onInstalled,
    );
  }
  /** Caller holds the same session lock used by legacy chunks and finalization. */
  private async rollbackSpan(manifest: Manifest, created: InstalledFile[]) {
    const directory = this.sessionPath(manifest.uploadId);
    await this.directory(directory);
    for (const item of created) {
      if (
        path.dirname(item.file) !== directory ||
        !/^chunk-(0|[1-9]\d{0,2})\.bin$/.test(path.basename(item.file))
      )
        fail("UPLOAD_STORAGE_UNSAFE", 503);
      const info = await lstat(item.file);
      const bytes = await this.read(item.file, item.bytes);
      const current = await lstat(item.file);
      if (
        !info.isFile() ||
        info.isSymbolicLink() ||
        info.ino !== item.inode ||
        info.dev !== item.device ||
        info.uid !== currentUid() ||
        info.nlink !== 1 ||
        (info.mode & 0o777) !== 0o600 ||
        info.size !== item.bytes ||
        current.ino !== item.inode ||
        current.dev !== item.device ||
        current.size !== item.bytes ||
        current.mtimeMs !== info.mtimeMs ||
        current.ctimeMs !== info.ctimeMs ||
        digest(bytes) !== item.sha256
      )
        fail("UPLOAD_SOURCE_CHANGED", 409);
      // Exact new files only; pre-existing chunks are never put in this list.
      await unlink(item.file);
    }
    if (created.length) await this.sync(directory);
  }
  async writeStream(
    manifest: Manifest,
    offset: number,
    length: number,
    expectedHash: string,
    req: PayloadRequest,
  ) {
    const end = offset + length;
    if (
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      offset % MEDIA_UPLOAD_CHUNK_BYTES !== 0 ||
      !Number.isSafeInteger(length) ||
      length < 1 ||
      length > MAX_MEDIA_UPLOAD_BYTES ||
      end > manifest.intent.bytes ||
      (end !== manifest.intent.bytes && end % MEDIA_UPLOAD_CHUNK_BYTES !== 0) ||
      !hex(expectedHash)
    )
      fail("UPLOAD_STREAM_RANGE_INVALID");
    const created: InstalledFile[] = [];
    try {
      const receivedHash = await streamBody(
        req,
        length,
        async (index, bytes) => {
          await this.writeChunk(
            manifest,
            offset / MEDIA_UPLOAD_CHUNK_BYTES + index,
            bytes,
            (installed) => created.push(installed),
          );
        },
      );
      if (receivedHash !== expectedHash) fail("UPLOAD_STREAM_HASH_MISMATCH");
    } catch (error) {
      // A lost/aborted connection retains only whole durable chunks for resume.
      // A known invalid span must not become an acknowledged corrupt prefix.
      if (!(
        error instanceof EditorialError && error.code === "UPLOAD_BODY_ABORTED"
      ))
        await this.rollbackSpan(manifest, created);
      throw error;
    }
  }
  async assembled(manifest: Manifest) {
    await this.inventory(manifest);
    const chunks: Buffer[] = [];
    for (
      let index = 0;
      index < Math.ceil(manifest.intent.bytes / MEDIA_UPLOAD_CHUNK_BYTES);
      index++
    ) {
      const expected = this.expectedBytes(manifest, index);
      const bytes = await this.read(
        path.join(this.sessionPath(manifest.uploadId), this.chunkName(index)),
        expected,
      );
      if (bytes.length !== expected) fail("UPLOAD_CHUNK_SIZE_MISMATCH", 409);
      chunks.push(bytes);
    }
    const bytes = Buffer.concat(chunks);
    if (
      bytes.length !== manifest.intent.bytes ||
      bytes.length > MAX_MEDIA_UPLOAD_BYTES ||
      digest(bytes) !== manifest.intent.sha256
    )
      fail("UPLOAD_FILE_HASH_MISMATCH", 409);
    return bytes;
  }
  async completed(
    manifest: Manifest,
    result: EditorialMediaUploadCompleteResult,
  ) {
    // Checkpoint is advisory. Native media identity is always re-read on complete.
    await this.install(
      this.sessionPath(manifest.uploadId),
      "complete.json",
      Buffer.from(JSON.stringify({ ...result, reused: false })),
    );
  }
  /** Terminal checkpoints are minted only after full staged SHA and native success. */
  async retention(manifest: Manifest) {
    const file = path.join(
      this.sessionPath(manifest.uploadId),
      "complete.json",
    );
    let before;
    try {
      before = await lstat(file);
    } catch (error) {
      if (missing(error))
        return { terminal: false, reclaimAt: manifest.expiresAt };
      throw error;
    }
    let raw: unknown;
    try {
      raw = JSON.parse((await this.read(file, 32 * 1024)).toString("utf8"));
    } catch (error) {
      if (error instanceof SyntaxError) fail("UPLOAD_STORAGE_UNSAFE", 503);
      throw error;
    }
    const result = editorialMediaUploadCompleteResultSchema.safeParse(raw);
    const after = await lstat(file);
    if (
      !result.success ||
      result.data.reused !== false ||
      result.data.validatedBytes !== manifest.intent.bytes ||
      result.data.validatedSha256 !== manifest.intent.sha256 ||
      !matchesIntent(result.data.media, manifest.intent) ||
      !Number.isFinite(before.mtimeMs) ||
      before.mtimeMs <= 0 ||
      after.ino !== before.ino ||
      after.dev !== before.dev ||
      after.size !== before.size ||
      after.mtimeMs !== before.mtimeMs ||
      after.ctimeMs !== before.ctimeMs
    )
      fail("UPLOAD_STORAGE_UNSAFE", 503);
    return {
      terminal: true,
      // Replays do not rewrite the immutable checkpoint or extend its grace.
      reclaimAt: Math.min(
        manifest.expiresAt,
        before.mtimeMs + TERMINAL_RECONCILIATION_TTL,
      ),
    };
  }
  async allocations(): Promise<Manifest[]> {
    await this.ready();
    const names = await readdir(this.root);
    if (
      names.length > MAX_RETAINED_SESSIONS + 8 ||
      names.some(
        (name) =>
          !hex(name) &&
          !/^\.initializing-[a-f0-9]{64}-[a-f0-9-]{36}$/.test(name),
      )
    )
      fail("UPLOAD_STORAGE_UNSAFE", 503);
    const manifests: Manifest[] = [];
    for (const name of names) {
      if (hex(name)) {
        manifests.push(await this.manifest(name));
        continue;
      }
      // All callers hold the allocation advisory lock. No live initializer can
      // own one of these directories; an interrupted unpublished start is safe to discard.
      const directory = path.join(this.root, name);
      await this.directory(directory);
      const files = await readdir(directory);
      if (
        files.length > 2 ||
        files.some(
          (file) =>
            file !== "manifest.json" &&
            !/^manifest\.json\.[a-f0-9-]{36}\.tmp$/.test(file),
        )
      )
        fail("UPLOAD_STORAGE_UNSAFE", 503);
      for (const file of files) {
        await this.read(path.join(directory, file), 32 * 1024);
        await unlink(path.join(directory, file));
      }
      await this.sync(directory);
      await rmdir(directory);
      await this.sync(this.root);
    }
    return manifests;
  }
  async removeExpired(manifest: Manifest) {
    if ((await this.retention(manifest)).reclaimAt > Date.now()) return;
    const directory = this.sessionPath(manifest.uploadId),
      names = await this.inventory(manifest);
    // Only recognized, expired or terminal-after-grace private session files; never native media/COS.
    for (const name of names) {
      await this.read(
        path.join(directory, name),
        name.endsWith(".bin") || name.includes(".bin.")
          ? MEDIA_UPLOAD_CHUNK_BYTES
          : 32 * 1024,
      );
      await unlink(path.join(directory, name));
    }
    await this.sync(directory);
    await rmdir(directory);
    await this.sync(this.root);
  }
}

async function body(req: PayloadRequest, maximum: number): Promise<Buffer> {
  if (!req.body) fail("UPLOAD_BODY_REQUIRED");
  const advertised = req.headers.get("content-length");
  if (
    advertised !== null &&
    (!/^\d+$/.test(advertised) || Number(advertised) > maximum)
  )
    fail("UPLOAD_BODY_TOO_LARGE", 413);
  const reader = req.body.getReader();
  const chunks: Buffer[] = [];
  let size = 0;
  const controller = new AbortController();
  const abort = () => controller.abort();
  req.signal?.addEventListener("abort", abort, { once: true });
  if (req.signal?.aborted) abort();
  const timer = setTimeout(abort, 30_000);
  let rejectAbort: (error: EditorialError) => void = () => {};
  const aborted = new Promise<never>((_, reject) => {
    rejectAbort = reject;
  });
  const stop = () =>
    rejectAbort(new EditorialError("UPLOAD_BODY_ABORTED", 408));
  controller.signal.addEventListener("abort", stop, { once: true });
  if (controller.signal.aborted) stop();
  try {
    for (;;) {
      const chunk = await Promise.race([reader.read(), aborted]);
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > maximum) fail("UPLOAD_BODY_TOO_LARGE", 413);
      chunks.push(Buffer.from(chunk.value));
    }
    if (advertised !== null && size !== Number(advertised))
      fail("UPLOAD_BODY_SIZE_MISMATCH");
    return Buffer.concat(chunks);
  } finally {
    clearTimeout(timer);
    req.signal?.removeEventListener("abort", abort);
    controller.signal.removeEventListener("abort", stop);
    void reader.cancel().catch(() => undefined);
    try {
      reader.releaseLock();
    } catch {
      /* pending canceled read */
    }
  }
}
/** Read one exact span, buffering only one legacy-sized durable chunk at a time. */
async function streamBody(
  req: PayloadRequest,
  length: number,
  consume: (index: number, bytes: Buffer) => Promise<void>,
): Promise<string> {
  if (!req.body) fail("UPLOAD_BODY_REQUIRED");
  const reader = req.body.getReader();
  const controller = new AbortController();
  const abort = () => controller.abort();
  req.signal?.addEventListener("abort", abort, { once: true });
  if (req.signal?.aborted) abort();
  const deadline = Date.now() + STREAM_MAX_MS;
  const maximumTimer = setTimeout(abort, STREAM_MAX_MS);
  let idleTimer = setTimeout(abort, STREAM_IDLE_MS);
  let rejectAbort: (error: EditorialError) => void = () => {};
  const aborted = new Promise<never>((_, reject) => {
    rejectAbort = reject;
  });
  // Abort can arrive while an atomic disk commit is completing. Keep its
  // rejection handled, then observe it before consuming or acknowledging more.
  void aborted.catch(() => undefined);
  const stop = () =>
    rejectAbort(new EditorialError("UPLOAD_BODY_ABORTED", 408));
  controller.signal.addEventListener("abort", stop, { once: true });
  if (controller.signal.aborted) stop();
  const hasher = createHash("sha256");
  let received = 0;
  let index = 0;
  let chunk = Buffer.alloc(Math.min(MEDIA_UPLOAD_CHUNK_BYTES, length));
  let filled = 0;
  const check = () => {
    if (controller.signal.aborted || Date.now() >= deadline)
      fail("UPLOAD_BODY_ABORTED", 408);
  };
  try {
    for (;;) {
      check();
      let next: ReadableStreamReadResult<Uint8Array>;
      try {
        next = await Promise.race([reader.read(), aborted]);
      } catch {
        fail("UPLOAD_BODY_ABORTED", 408);
      }
      check();
      if (next.done) break;
      if (next.value.byteLength > length - received)
        fail("UPLOAD_BODY_TOO_LARGE", 413);
      if (next.value.byteLength) {
        clearTimeout(idleTimer);
        idleTimer = setTimeout(abort, STREAM_IDLE_MS);
      }
      hasher.update(next.value);
      let cursor = 0;
      while (cursor < next.value.byteLength) {
        check();
        const take = Math.min(
          chunk.length - filled,
          next.value.byteLength - cursor,
        );
        chunk.set(next.value.subarray(cursor, cursor + take), filled);
        filled += take;
        cursor += take;
        received += take;
        if (filled === chunk.length) {
          await consume(index++, chunk);
          check();
          filled = 0;
          if (received < length)
            chunk = Buffer.alloc(
              Math.min(MEDIA_UPLOAD_CHUNK_BYTES, length - received),
            );
        }
      }
    }
    check();
    if (received !== length || filled !== 0) fail("UPLOAD_BODY_SIZE_MISMATCH");
    return hasher.digest("hex");
  } finally {
    clearTimeout(maximumTimer);
    clearTimeout(idleTimer);
    req.signal?.removeEventListener("abort", abort);
    controller.signal.removeEventListener("abort", stop);
    void reader.cancel().catch(() => undefined);
    try {
      reader.releaseLock();
    } catch {
      /* pending canceled read */
    }
  }
}
async function json(req: PayloadRequest) {
  if (
    !/^application\/json(?:;\s*charset=utf-8)?$/i.test(
      req.headers.get("content-type") ?? "",
    )
  )
    fail("UPLOAD_CONTENT_TYPE_INVALID");
  try {
    return JSON.parse((await body(req, 32 * 1024)).toString("utf8")) as unknown;
  } catch (error) {
    if (error instanceof SyntaxError) fail("UPLOAD_JSON_INVALID");
    throw error;
  }
}
const parse = <T>(
  schema: {
    safeParse: (
      value: unknown,
    ) => { success: true; data: T } | { success: false };
  },
  input: unknown,
): T => {
  const result = schema.safeParse(input);
  if (!result.success) fail("UPLOAD_INPUT_INVALID");
  return result.data;
};
const sessionLock = (req: PayloadRequest, uploadId: string) =>
  lockEditorialKey(req, `media-upload-session:${uploadId}`);
let completing: Promise<unknown> = Promise.resolve();
let pendingCompletes = 0;
const completeQueue = async <T>(work: () => Promise<T>): Promise<T> => {
  if (pendingCompletes >= 8) fail("UPLOAD_COMPLETION_BUSY", 429);
  pendingCompletes++;
  const result = completing.then(work);
  completing = result.then(
    () => undefined,
    () => undefined,
  );
  try {
    return await result;
  } finally {
    pendingCompletes--;
  }
};
const mediaProjection = (
  document: Record<string, unknown>,
): EditorialUploadedMedia => {
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
    if (document[field] !== undefined && document[field] !== null)
      value[field] = document[field];
  return parse(editorialUploadedMediaSchema, value);
};
const matchesIntent = (
  media: EditorialUploadedMedia,
  intent: EditorialMediaUploadStart,
) =>
  media.mediaId === intent.mediaId &&
  media.catalogId === intent.catalogId &&
  media.sha256 === intent.sha256 &&
  media.filesize === intent.bytes &&
  media.mimeType === intent.mimeType &&
  media.alt === intent.alt &&
  media.rights === intent.rights &&
  media.orderConfidence === intent.orderConfidence;

/** Reuses native Actor/catalog access, transaction locks, media hooks and storage. */
export function createResumableMediaEndpoints(options: {
  directory: string;
  mediaDirectory: string;
}): Endpoint[] {
  const store = new EditorialUploadStore(
    options.directory,
    options.mediaDirectory,
  );
  const endpoint = (
    route: string,
    operation: (req: PayloadRequest) => Promise<unknown>,
  ): Endpoint => ({
    path: `/editorial/media-upload/${route}`,
    method: "post",
    handler: async (req) => {
      try {
        requireActor(req);
        return Response.json(
          { ok: true, result: await operation(req) },
          {
            headers: {
              "Cache-Control": "private, no-store",
              Vary: "Cookie, Authorization",
              "X-Editorial-Upload-Stream": MEDIA_UPLOAD_STREAM_VERSION,
            },
          },
        );
      } catch (error) {
        const safeError =
          error instanceof APIError && nativeMediaCodes.has(error.message)
            ? new EditorialError(error.message, error.status)
            : error;
        if (!(safeError instanceof EditorialError))
          req.payload.logger.error({
            category: "EDITORIAL_MEDIA_UPLOAD_FAILED",
          });
        return Response.json(safeEditorialFailure(safeError), {
          status: safeError instanceof EditorialError ? safeError.status : 500,
          headers: {
            "Cache-Control": "private, no-store",
            Vary: "Cookie, Authorization",
          },
        });
      }
    },
  });
  return [
    endpoint("start", async (req) => {
      const intent = parse(editorialMediaUploadStartSchema, await json(req));
      const actor = requireActor(req);
      if (!canEditCatalog(req, intent.catalogId)) fail("UPLOAD_FORBIDDEN", 403);
      return withEditorialTransaction(req, async () => {
        await lockEditorialKey(req, "media-upload-allocation");
        const uploadId = idFor(String(actor.id), intent);
        let allocations = await store.allocations();
        const retention = await Promise.all(
          allocations.map(async (manifest) => ({
            manifest,
            ...(await store.retention(manifest)),
          })),
        );
        for (const { manifest: expired } of retention
          .filter((entry) => entry.reclaimAt <= Date.now())
          .slice(0, 8)) {
          await lockEditorialKey(
            req,
            `media-upload-media:${expired.intent.mediaId}`,
          );
          await sessionLock(req, expired.uploadId);
          await store.removeExpired(expired);
        }
        allocations = await store.allocations();
        const existing = allocations.find(
          (manifest) => manifest.uploadId === uploadId,
        );
        if (existing) {
          await sessionLock(req, uploadId);
          return store.status(await store.authorize(req, uploadId));
        }
        const reservations = await Promise.all(
          allocations.map(async (manifest) => ({
            manifest,
            ...(await store.retention(manifest)),
          })),
        );
        const active = reservations
          .filter((entry) => !entry.terminal)
          .map((entry) => entry.manifest);
        const owned = active.filter(
          (manifest) => manifest.actorId === String(actor.id),
        );
        if (
          allocations.length >= MAX_RETAINED_SESSIONS ||
          active.length >= MAX_SESSIONS ||
          owned.length >= MAX_ACTOR_SESSIONS ||
          allocations.reduce(
            (sum, manifest) => sum + manifest.intent.bytes,
            0,
          ) +
            intent.bytes >
            MAX_RESERVED_BYTES ||
          owned.reduce((sum, manifest) => sum + manifest.intent.bytes, 0) +
            intent.bytes >
            MAX_ACTOR_RESERVED_BYTES
        )
          fail("UPLOAD_QUOTA_EXCEEDED", 429);
        await sessionLock(req, uploadId);
        const manifest = await store.create(String(actor.id), intent);
        return store.status(manifest);
      });
    }),
    endpoint("status", async (req) => {
      const { uploadId } = parse(
        editorialMediaUploadSessionRequestSchema,
        await json(req),
      );
      await store.authorize(req, uploadId);
      return withEditorialTransaction(req, async () => {
        await sessionLock(req, uploadId);
        return store.status(await store.authorize(req, uploadId));
      });
    }),
    endpoint("chunk/:uploadId/:index", async (req) => {
      const uploadId = req.routeParams?.uploadId,
        indexText = req.routeParams?.index;
      if (
        !hex(uploadId) ||
        typeof indexText !== "string" ||
        !/^(?:0|[1-9]\d{0,2})$/.test(indexText)
      )
        fail("UPLOAD_INPUT_INVALID");
      const index = Number(indexText);
      await store.authorize(req, uploadId);
      if (req.headers.get("content-type") !== "application/octet-stream")
        fail("UPLOAD_CONTENT_TYPE_INVALID");
      const expectedHash = req.headers.get("x-editorial-chunk-sha256");
      if (!hex(expectedHash)) fail("UPLOAD_CHUNK_HASH_REQUIRED");
      const bytes = await body(req, MEDIA_UPLOAD_CHUNK_BYTES);
      if (digest(bytes) !== expectedHash) fail("UPLOAD_CHUNK_HASH_MISMATCH");
      return withEditorialTransaction(req, async () => {
        await sessionLock(req, uploadId);
        const manifest = await store.authorize(req, uploadId);
        await store.writeChunk(manifest, index, bytes);
        return parse(editorialMediaUploadChunkResultSchema, {
          uploadId,
          index,
          bytes: bytes.length,
          sha256: expectedHash,
        });
      });
    }),
    endpoint("stream/:uploadId/:offset", async (req) => {
      const uploadId = req.routeParams?.uploadId;
      const offsetText = req.routeParams?.offset;
      const advertised = req.headers.get("content-length");
      const expectedHash = req.headers.get("x-editorial-stream-sha256");
      if (
        !hex(uploadId) ||
        typeof offsetText !== "string" ||
        !/^(?:0|[1-9]\d{0,7})$/.test(offsetText)
      )
        fail("UPLOAD_INPUT_INVALID");
      if (req.headers.get("content-type") !== "application/octet-stream")
        fail("UPLOAD_CONTENT_TYPE_INVALID");
      if (!advertised || !/^[1-9]\d*$/.test(advertised))
        fail("UPLOAD_BODY_SIZE_MISMATCH");
      if (!hex(expectedHash)) fail("UPLOAD_STREAM_HASH_REQUIRED");
      // The same mutation lock prevents legacy chunk/status/complete writers
      // from trusting a span until its final hash is known. Their existing 5 s
      // lock timeout returns BUSY rather than waiting for this bounded request.
      await store.authorize(req, uploadId);
      return withEditorialTransaction(req, async () => {
        await sessionLock(req, uploadId);
        const manifest = await store.authorize(req, uploadId);
        await store.writeStream(
          manifest,
          Number(offsetText),
          Number(advertised),
          expectedHash,
          req,
        );
        return store.status(await store.authorize(req, uploadId));
      });
    }),
    endpoint("complete", async (req) => {
      const { uploadId } = parse(
        editorialMediaUploadSessionRequestSchema,
        await json(req),
      );
      const authorized = await store.authorize(req, uploadId);
      return completeQueue(async () => {
        if (req.signal?.aborted) fail("UPLOAD_BODY_ABORTED", 408);
        let manifest: Manifest;
        const result = await withEditorialTransaction(req, async () => {
          // MediaId is global. Do not include actor in this serialization key.
          await lockEditorialKey(
            req,
            `media-upload-media:${authorized.intent.mediaId}`,
          );
          await sessionLock(req, uploadId);
          manifest = await store.authorize(req, uploadId);
          const bytes = await store.assembled(manifest);
          const intent = manifest.intent;
          const found = await req.payload.find({
            collection: "media",
            where: { mediaId: { equals: intent.mediaId } },
            limit: 1,
            depth: 0,
            overrideAccess: false,
            req,
            user: req.user,
          });
          let media: EditorialUploadedMedia;
          let reused = false;
          if (found.docs[0]) {
            media = mediaProjection(
              found.docs[0] as unknown as Record<string, unknown>,
            );
            if (!matchesIntent(media, intent))
              fail("MEDIA_IDENTITY_CONFLICT", 409);
            reused = true;
          } else {
            if (intent.existingOnly)
              fail("MEDIA_UPLOAD_EXISTING_REQUIRED", 409);
            const document = await req.payload.create({
              collection: "media",
              overrideAccess: false,
              req,
              user: req.user,
              depth: 0,
              data: {
                catalogId: intent.catalogId,
                mediaId: intent.mediaId,
                origin: "upload",
                sha256: intent.sha256,
                objectKey: `editorial/${keyDigest(intent.catalogId)}/${keyDigest(intent.mediaId)}-${intent.sha256}.${intent.mimeType === "image/jpeg" ? "jpg" : intent.mimeType.split("/")[1]}`,
                alt: intent.alt,
                ...(intent.rights === undefined
                  ? {}
                  : { rights: intent.rights }),
                ...(intent.orderConfidence === undefined
                  ? {}
                  : { orderConfidence: intent.orderConfidence }),
              },
              file: {
                data: bytes,
                size: bytes.length,
                mimetype: intent.mimeType,
                name: `upload.${intent.mimeType === "image/jpeg" ? "jpg" : intent.mimeType.split("/")[1]}`,
              },
            });
            media = mediaProjection(
              document as unknown as Record<string, unknown>,
            );
            if (!matchesIntent(media, intent))
              fail("MEDIA_NATIVE_READBACK_MISMATCH", 500);
          }
          return parse(editorialMediaUploadCompleteResultSchema, {
            media,
            reused,
            validatedBytes: bytes.length,
            validatedSha256: digest(bytes),
          });
        });
        // Native create committed first. A lost reply/checkpoint is recovered by MediaId.
        await withEditorialTransaction(req, async () => {
          await sessionLock(req, uploadId);
          await store.completed(await store.authorize(req, uploadId), result);
        });
        return result;
      });
    }),
  ];
}

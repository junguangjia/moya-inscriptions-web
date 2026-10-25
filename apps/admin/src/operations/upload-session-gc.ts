/** Private upload buffers only. No canonical media, database rows or COS objects are deleted. */
import { createHash, randomUUID } from "node:crypto";
import { constants, type Stats } from "node:fs";
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
import {
  MEDIA_UPLOAD_CHUNK_BYTES,
  editorialMediaUploadStartSchema,
  editorialMediaUploadCompleteResultSchema,
  type EditorialMediaUploadStart,
  type EditorialUploadedMedia,
} from "@moya/contracts/internal/editorial";

export const UPLOAD_SESSION_TTL = 24 * 60 * 60 * 1000;
export const UPLOAD_COMPLETION_GRACE = 15 * 60 * 1000;
const MAX_ENTRIES = 520;
const JOURNAL = "gc-intent.json";
const hex = (value: string) => /^[a-f0-9]{64}$/.test(value);
const missing = (error: unknown) =>
  (error as NodeJS.ErrnoException)?.code === "ENOENT";
export class UploadSessionGcError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, status = 503) {
    super(code);
    this.code = code;
    this.status = status;
  }
}
function fail(): never {
  throw new UploadSessionGcError("UPLOAD_STORAGE_UNSAFE");
}
export type UploadSessionManifest = {
  version: 1;
  uploadId: string;
  actorId: string;
  intent: EditorialMediaUploadStart;
  createdAt: number;
  expiresAt: number;
};
export const uploadSessionId = (
  actorId: string,
  intent: EditorialMediaUploadStart,
) =>
  createHash("sha256")
    .update(JSON.stringify({ version: "editorial-upload-v1", actorId, intent }))
    .digest("hex");
export const uploadIntentMatches = (
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
export function parseUploadSessionManifest(
  raw: unknown,
  uploadId: string,
): UploadSessionManifest {
  if (!raw || typeof raw !== "object" || Array.isArray(raw) || !hex(uploadId))
    fail();
  const value = raw as UploadSessionManifest;
  const intent = editorialMediaUploadStartSchema.safeParse(value.intent);
  if (
    Object.keys(value).sort().join(",") !==
      "actorId,createdAt,expiresAt,intent,uploadId,version" ||
    value.version !== 1 ||
    value.uploadId !== uploadId ||
    typeof value.actorId !== "string" ||
    !value.actorId ||
    !intent.success ||
    !Number.isSafeInteger(value.createdAt) ||
    value.createdAt < 0 ||
    !Number.isSafeInteger(value.expiresAt) ||
    value.expiresAt > 8_640_000_000_000_000 ||
    value.expiresAt - value.createdAt !== UPLOAD_SESSION_TTL ||
    uploadSessionId(value.actorId, intent.data) !== uploadId
  )
    fail();
  return { ...value, intent: intent.data };
}
function uid() {
  if (!process.getuid) fail();
  return process.getuid();
}
async function directory(file: string) {
  const info = await lstat(file);
  if (
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    info.uid !== uid() ||
    (info.mode & 0o777) !== 0o700 ||
    (await realpath(file)) !== file
  )
    fail();
  return info;
}
function regular(info: Stats, maximum: number) {
  if (
    !info.isFile() ||
    info.isSymbolicLink() ||
    info.uid !== uid() ||
    info.nlink !== 1 ||
    (info.mode & 0o777) !== 0o600 ||
    info.size > maximum
  )
    fail();
}
function same(a: Stats, b: Stats) {
  return (
    a.dev === b.dev &&
    a.ino === b.ino &&
    a.size === b.size &&
    a.mtimeMs === b.mtimeMs &&
    a.ctimeMs === b.ctimeMs
  );
}
async function inspect(file: string, maximum: number) {
  const before = await lstat(file);
  regular(before, maximum);
  if ((await realpath(file)) !== file) fail();
  const handle = await open(
    file,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const after = await handle.stat();
    regular(after, maximum);
    if (!same(before, after)) fail();
    return after;
  } finally {
    await handle.close();
  }
}
async function json(file: string, maximum = 32 * 1024): Promise<unknown> {
  const before = await inspect(file, maximum);
  const handle = await open(
    file,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    if (!same(before, await handle.stat())) fail();
    const bytes = await handle.readFile();
    if (bytes.length !== before.size || !same(before, await handle.stat()))
      fail();
    try {
      return JSON.parse(bytes.toString("utf8"));
    } catch {
      return fail();
    }
  } finally {
    await handle.close();
  }
}
async function sync(file: string) {
  const handle = await open(
    file,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}
export async function readUploadSessionManifest(
  root: string,
  uploadId: string,
) {
  if (!hex(uploadId)) fail();
  await directory(path.join(root, uploadId));
  return parseUploadSessionManifest(
    await json(path.join(root, uploadId, "manifest.json")),
    uploadId,
  );
}
export async function readUploadSessionRetention(
  root: string,
  manifest: UploadSessionManifest,
) {
  const file = path.join(root, manifest.uploadId, "complete.json");
  let before: Stats;
  try {
    before = await inspect(file, 32 * 1024);
  } catch (error) {
    if (missing(error))
      return { terminal: false, reclaimAt: manifest.expiresAt };
    throw error;
  }
  const result = editorialMediaUploadCompleteResultSchema.safeParse(
    await json(file),
  );
  if (
    !result.success ||
    result.data.reused !== false ||
    result.data.validatedBytes !== manifest.intent.bytes ||
    result.data.validatedSha256 !== manifest.intent.sha256 ||
    !uploadIntentMatches(result.data.media, manifest.intent) ||
    !Number.isFinite(before.mtimeMs) ||
    before.mtimeMs <= 0 ||
    !same(before, await lstat(file))
  )
    fail();
  return {
    terminal: true,
    reclaimAt: Math.min(
      manifest.expiresAt,
      before.mtimeMs + UPLOAD_COMPLETION_GRACE,
    ),
  };
}
function fileMaximum(name: string, manifest: UploadSessionManifest) {
  const count = Math.ceil(manifest.intent.bytes / MEDIA_UPLOAD_CHUNK_BYTES);
  const chunk = /^chunk-(0|[1-9]\d{0,2})\.bin(?:\.[a-f0-9-]{36}\.tmp)?$/.exec(
    name,
  );
  if (chunk) {
    if (Number(chunk[1]) >= count) fail();
    return MEDIA_UPLOAD_CHUNK_BYTES;
  }
  if (
    name === "manifest.json" ||
    name === "complete.json" ||
    /^(?:manifest\.json|complete\.json)\.[a-f0-9-]{36}\.tmp$/.test(name)
  )
    return 32 * 1024;
  return fail();
}
async function inventory(
  folder: string,
  manifest: UploadSessionManifest,
  journal = false,
) {
  const names = await readdir(/* turbopackIgnore: true */ folder);
  if (
    names.length >
    Math.ceil(manifest.intent.bytes / MEDIA_UPLOAD_CHUNK_BYTES) * 2 +
      8 +
      (journal ? 1 : 0)
  )
    fail();
  const files = new Map<string, Stats>();
  for (const name of names) {
    if (journal && name === JOURNAL) continue;
    files.set(
      name,
      await inspect(path.join(folder, name), fileMaximum(name, manifest)),
    );
  }
  return files;
}
export type UploadGcOptions = {
  root: string;
  mediaDirectory: string;
  execute: boolean;
  deadline?: number;
  maxSessions?: number;
  maxBytes?: number;
  stopped?: () => boolean;
  /** Tests interrupt at actual durable boundaries; production does not install a hook. */
  checkpoint?: (phase: string) => Promise<void>;
};
function active(options: UploadGcOptions) {
  if (options.stopped?.() || Date.now() >= (options.deadline ?? Infinity))
    throw new UploadSessionGcError("UPLOAD_GC_STOPPED");
}
async function roots(options: UploadGcOptions) {
  if (
    !path.isAbsolute(options.root) ||
    path.resolve(options.root) !== options.root ||
    !path.isAbsolute(options.mediaDirectory) ||
    path.resolve(options.mediaDirectory) !== options.mediaDirectory
  )
    fail();
  const parent = path.dirname(options.root);
  if ((await realpath(parent)) !== parent) fail();
  const media = await realpath(options.mediaDirectory).catch(
    (error: unknown) => {
      if (missing(error)) return options.mediaDirectory;
      throw error;
    },
  );
  const quarantine = options.root + "-gc";
  if (
    [options.root, quarantine].some(
      (buffer) =>
        buffer === media ||
        buffer.startsWith(media + path.sep) ||
        media.startsWith(buffer + path.sep),
    )
  )
    fail();
  const source = await directory(options.root);
  if (options.execute)
    await mkdir(quarantine, { mode: 0o700 }).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    });
  try {
    if ((await directory(quarantine)).dev !== source.dev) fail();
  } catch (error) {
    if (!missing(error) || options.execute) throw error;
  }
  return quarantine;
}
type Intent = {
  version: 1;
  manifest: UploadSessionManifest;
  reclaimAt: number;
  device: number;
  inode: number;
};
async function writeIntent(folder: string, value: Intent) {
  // A temporary intent is recognizable only inside the private sibling, never in the allocator root.
  const temporary = path.join(folder, `.gc-${randomUUID()}.tmp`);
  const handle = await open(
    temporary,
    constants.O_WRONLY |
      constants.O_CREAT |
      constants.O_EXCL |
      constants.O_NOFOLLOW,
    0o600,
  );
  try {
    await handle.writeFile(JSON.stringify(value));
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary, path.join(folder, JOURNAL));
  await sync(folder);
}
async function intentFor(
  folder: string,
  uploadId: string,
): Promise<Intent | undefined> {
  let raw: unknown;
  try {
    raw = await json(path.join(folder, JOURNAL));
  } catch (error) {
    if (missing(error)) return undefined;
    throw error;
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) fail();
  const value = raw as Intent;
  const info = await directory(folder);
  if (
    Object.keys(value).sort().join(",") !==
      "device,inode,manifest,reclaimAt,version" ||
    value.version !== 1 ||
    !Number.isSafeInteger(value.reclaimAt) ||
    value.reclaimAt > Date.now() ||
    value.reclaimAt < 0 ||
    value.device !== info.dev ||
    value.inode !== info.ino
  )
    fail();
  const manifest = parseUploadSessionManifest(value.manifest, uploadId);
  if (value.reclaimAt > manifest.expiresAt) fail();
  return { ...value, manifest };
}
async function reap(
  folder: string,
  manifest: UploadSessionManifest,
  options: UploadGcOptions,
) {
  // Recognized intent temporaries from a killed write may be removed; all other unknown names refuse the run.
  const originalNames = await readdir(/* turbopackIgnore: true */ folder);
  if (
    originalNames.length >
    Math.ceil(manifest.intent.bytes / MEDIA_UPLOAD_CHUNK_BYTES) * 2 + 16
  )
    fail();
  for (const name of originalNames) {
    active(options);
    await inspect(
      path.join(folder, name),
      name === JOURNAL || /^\.gc-[a-f0-9-]{36}\.tmp$/.test(name)
        ? 32 * 1024
        : fileMaximum(name, manifest),
    );
  }
  for (const name of originalNames)
    if (/^\.gc-[a-f0-9-]{36}\.tmp$/.test(name)) {
      await inspect(path.join(folder, name), 32 * 1024);
      active(options);
      await unlink(path.join(folder, name));
    }
  const files = await inventory(folder, manifest, true);
  const ordered = [...files.keys()].sort(
    (a, b) => Number(a === "manifest.json") - Number(b === "manifest.json"),
  );
  for (const name of ordered) {
    active(options);
    const file = path.join(folder, name);
    const current = await inspect(file, fileMaximum(name, manifest));
    if (!same(files.get(name)!, current)) fail();
    active(options);
    await unlink(file);
    await options.checkpoint?.("unlinked");
  }
  await sync(folder);
  active(options);
  await inspect(path.join(folder, JOURNAL), 32 * 1024);
  await unlink(path.join(folder, JOURNAL));
  await options.checkpoint?.("intent-unlinked");
  await sync(folder);
  await rmdir(folder);
  await sync(path.dirname(folder));
}
/** Caller holds allocation, then global media identity, then session transaction advisory locks. */
export async function retireExpiredUploadSession(
  options: UploadGcOptions,
  manifest: UploadSessionManifest,
) {
  active(options);
  const quarantine = await roots(options);
  const current = await readUploadSessionManifest(
    options.root,
    manifest.uploadId,
  );
  if (JSON.stringify(current) !== JSON.stringify(manifest)) fail();
  const retention = await readUploadSessionRetention(options.root, current);
  if (retention.reclaimAt > Date.now()) return { removed: false, bytes: 0 };
  const source = path.join(options.root, current.uploadId),
    target = path.join(quarantine, current.uploadId);
  const info = await directory(source),
    files = await inventory(source, current);
  const bytes = [...files.values()].reduce((sum, file) => sum + file.size, 0);
  if (bytes > (options.maxBytes ?? 256 * 1024 * 1024))
    return { removed: false, bytes: 0 };
  if (!options.execute) return { removed: true, bytes };
  try {
    await lstat(target);
    fail();
  } catch (error) {
    if (!missing(error)) throw error;
  }
  active(options);
  await options.checkpoint?.("before-rename");
  active(options);
  await rename(source, target);
  await sync(options.root);
  await sync(quarantine);
  await options.checkpoint?.("claimed");
  await writeIntent(target, {
    version: 1,
    manifest: current,
    reclaimAt: Math.floor(retention.reclaimAt),
    device: info.dev,
    inode: info.ino,
  });
  await options.checkpoint?.("intent-written");
  await reap(target, current, options);
  return { removed: true, bytes };
}
export type UploadGcLocks = {
  allocation: <T>(work: () => Promise<T>) => Promise<T>;
  session: <T>(
    manifest: UploadSessionManifest,
    work: () => Promise<T>,
  ) => Promise<T>;
};
/** Independent maintenance and request cleanup share retention, validation and the same rename/delete path. */
export async function pruneUploadSessions(
  options: UploadGcOptions,
  locks: UploadGcLocks,
) {
  const maxSessions = options.maxSessions ?? 8,
    maxBytes = options.maxBytes ?? 256 * 1024 * 1024;
  if (
    !Number.isSafeInteger(maxSessions) ||
    maxSessions < 1 ||
    maxSessions > 8 ||
    !Number.isSafeInteger(maxBytes) ||
    maxBytes < 1 ||
    maxBytes > 256 * 1024 * 1024
  )
    fail();
  return locks.allocation(async () => {
    active(options);
    let quarantine: string;
    try {
      quarantine = await roots(options);
    } catch (error) {
      if (missing(error)) return { sessions: 0, bytes: 0 };
      throw error;
    }
    let sessions = 0,
      bytes = 0;
    const recovered = await readdir(
      /* turbopackIgnore: true */ quarantine,
    ).catch((error: unknown) => {
      if (missing(error)) return [] as string[];
      throw error;
    });
    const sourceNames = await readdir(/* turbopackIgnore: true */ options.root);
    if (
      recovered.length > MAX_ENTRIES ||
      recovered.some((name) => !hex(name)) ||
      sourceNames.length > MAX_ENTRIES ||
      sourceNames.some(
        (name) =>
          !hex(name) &&
          !/^\.initializing-[a-f0-9]{64}-[a-f0-9-]{36}$/.test(name),
      )
    )
      fail();
    for (const name of recovered) {
      active(options);
      if (sessions >= maxSessions) break;
      const folder = path.join(quarantine, name);
      await directory(folder);
      const names = await readdir(/* turbopackIgnore: true */ folder);
      if (!names.length) {
        if (options.execute) {
          await rmdir(folder);
          await sync(quarantine);
        }
        sessions++;
        continue;
      }
      const intent = await intentFor(folder, name);
      const manifest =
        intent?.manifest ?? (await readUploadSessionManifest(quarantine, name));
      await locks.session(manifest, async () => {
        const reclaimAt =
          intent?.reclaimAt ??
          (await readUploadSessionRetention(quarantine, manifest)).reclaimAt;
        if (reclaimAt > Date.now()) fail();
        // Preflight the entire remainder before deleting any file, even on a recovered run.
        const allNames = await readdir(/* turbopackIgnore: true */ folder);
        if (
          allNames.length >
          Math.ceil(manifest.intent.bytes / MEDIA_UPLOAD_CHUNK_BYTES) * 2 + 16
        )
          fail();
        const remainder = allNames.filter(
          (file) => !/^\.gc-[a-f0-9-]{36}\.tmp$/.test(file),
        );
        for (const file of remainder) {
          active(options);
          if (file !== JOURNAL)
            await inspect(path.join(folder, file), fileMaximum(file, manifest));
        }
        const amount = [
          ...(await inventoryAfterIntentTemps(folder, manifest)).values(),
        ].reduce((sum, info) => sum + info.size, 0);
        if (bytes + amount > maxBytes) return;
        if (options.execute) {
          if (!intent) {
            const info = await directory(folder);
            await writeIntent(folder, {
              version: 1,
              manifest,
              reclaimAt: Math.floor(reclaimAt),
              device: info.dev,
              inode: info.ino,
            });
          }
          await reap(folder, manifest, options);
        }
        sessions++;
        bytes += amount;
      });
    }
    for (const name of sourceNames) {
      active(options);
      if (sessions >= maxSessions || bytes >= maxBytes) break;
      if (!hex(name)) continue; // Old allocator owns unpublished initializers, including their recovery.
      const manifest = await readUploadSessionManifest(options.root, name);
      await locks.session(manifest, async () => {
        const result = await retireExpiredUploadSession(
          { ...options, maxBytes: maxBytes - bytes },
          manifest,
        );
        if (result.removed) {
          sessions++;
          bytes += result.bytes;
        }
      });
    }
    return { sessions, bytes };
  });
}
async function inventoryAfterIntentTemps(
  folder: string,
  manifest: UploadSessionManifest,
) {
  const files = new Map<string, Stats>();
  for (const name of await readdir(/* turbopackIgnore: true */ folder)) {
    if (name === JOURNAL || /^\.gc-[a-f0-9-]{36}\.tmp$/.test(name)) continue;
    files.set(
      name,
      await inspect(path.join(folder, name), fileMaximum(name, manifest)),
    );
  }
  return files;
}

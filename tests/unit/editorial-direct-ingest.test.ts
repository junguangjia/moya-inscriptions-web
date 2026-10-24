import { spawn } from "node:child_process";
import { createHash, randomBytes, randomFillSync } from "node:crypto";
import { constants, renameSync, symlinkSync, unlinkSync } from "node:fs";
import {
  chmod,
  copyFile,
  type FileHandle,
  mkdir,
  mkdtemp,
  open,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";

import {
  editorialMediaIngestStartSchema,
  editorialMediaUploadStartSchema,
} from "@moya/contracts/internal/editorial";
import { afterEach, describe, expect, it, vi } from "vitest";

/*
 * catalog-scale-v1 increment 2, slice S4a: the Codex ingest library and CLI
 * against a loopback fake Admin and an injected fake COS. Original bytes go
 * only to the COS host, nothing is read back, every uncertain answer is
 * retried safely, and no URL, key, host, credential or response body ever
 * reaches output or the state file. Synthetic values only; .test hosts.
 */

type Json = Record<string, unknown>;
type Outcome = Json & { ok: boolean; code?: string; retryable?: boolean };
type Summary = Json & {
  total: number;
  registered: number;
  failed: number;
  pending: number;
  newlyRegistered: number;
  reused: number;
  relayFallbacks: number;
  abandoned: number;
  privacy: string;
  codes: Record<string, number>;
};
type Send = ((...args: unknown[]) => Promise<Outcome>) & {
  scopeFingerprint?: string;
};
type CosClient = {
  putObject: (request: Json) => Promise<Outcome & { status: number }>;
  checkPrivate: (request: Json) => Promise<string>;
};
type Manifest = { version: number; batchId: string; items: Json[] };
type RunOptions = {
  manifest: Manifest;
  directory: string;
  stateFile?: string;
  send?: Send;
  cos?: CosClient;
  cosHostSuffix?: string;
  dryRun?: boolean;
  concurrency?: number;
  completeConcurrency?: number;
  attempts?: number;
  budgetMs?: number;
  retryDelayMs?: number;
  now?: () => number;
  signal?: AbortSignal;
  stateCompactBytes?: number;
};
const ingest = (await import(
  new URL("../../scripts/editorial/direct-ingest.mjs", import.meta.url).href
)) as {
  runDirectIngest: (options: RunOptions) => Promise<Summary>;
  abandonIngest: (options: RunOptions) => Promise<Json>;
  createAdminSend: (
    config: Json,
    options?: { fetchImpl?: typeof fetch },
  ) => Send;
  createCosClient: (options: {
    hostSuffix: string;
    fetchImpl?: typeof fetch;
  }) => CosClient;
  validateIngestManifest: (manifest: unknown) => Manifest;
  runbookLines: (result: Json) => string[];
  STATE_LIMITS: {
    maxItems: number;
    maxStateBytes: number;
    compactAfterBytes: number;
  };
  openOriginal: (
    realParent: string,
    name: string,
    options?: {
      openFile?: (file: string, flags: number) => Promise<FileHandle>;
      /** undefined: the CLI's own flags. */
      flags?: number | undefined;
    },
  ) => Promise<{
    handle: FileHandle;
    info: Awaited<ReturnType<FileHandle["stat"]>>;
  }>;
};
const upload = (await import(
  new URL("../../scripts/editorial/resumable-upload.mjs", import.meta.url).href
)) as {
  stagingUploadTarget: (
    value: string,
    suffix: string,
    ingestId?: string,
  ) => URL | null;
  normalizeCosHostSuffix: (value: unknown) => string | null;
  stageMediaUpload: (options: Json) => Promise<Outcome>;
};

const SCRIPT = new URL(
  "../../scripts/editorial/direct-ingest.mjs",
  import.meta.url,
).pathname;
const SUFFIX = "cos.example.test";
const MiB = 1024 * 1024;
const sha256 = (value: string | Uint8Array) =>
  createHash("sha256").update(value).digest("hex");
const md5 = (value: Uint8Array) =>
  createHash("md5").update(value).digest("base64");

/** Values that must never reach output or state, generated per test run. */
function secretsFor() {
  return {
    token: `synthetic-${randomBytes(20).toString("hex")}`,
    /** A second actor's credential (another automation identity). */
    otherToken: `synthetic-other-${randomBytes(20).toString("hex")}`,
    bucket: `bucket${randomBytes(6).toString("hex")}`,
    accessKey: `AKID${randomBytes(16).toString("hex")}`,
    signature: randomBytes(20).toString("hex"),
    marker: `marker${randomBytes(8).toString("hex")}`,
  };
}
type Secrets = ReturnType<typeof secretsFor>;

function expectRedacted(text: string, secrets: Secrets) {
  for (const value of [
    secrets.token,
    secrets.bucket,
    secrets.accessKey,
    secrets.signature,
    secrets.marker,
    SUFFIX,
    "catalog-ingest/",
    "editorial/",
    "q-signature",
    "https://",
    "http://",
    "127.0.0.1",
  ])
    expect(text).not.toContain(value);
}

/** A synthetic JPEG-shaped original: SOI, random body, EOI. */
function original(size: number) {
  const bytes = Buffer.alloc(size);
  randomFillSync(bytes);
  bytes.set([0xff, 0xd8, 0xff, 0xe0]);
  bytes.set([0xff, 0xd9], size - 2);
  return bytes;
}

type AdminOptions = {
  ingest?: boolean;
  /**
   * Per complete call: fail before any work, lose the reply after it, or wait
   * out the mediaId lock (409 CONCURRENT_OPERATION_BUSY, nothing changed).
   */
  completeFaults?: ("before" | "after" | "busy" | undefined)[];
  startFaults?: number;
  /** Every start (after startFaults) is refused with this status and code. */
  startRefusal?: { status: number; code: string };
  completeCode?: { status: number; code: string; keepStaging?: boolean };
  abandonFaults?: number;
  mutateGrant?: (grant: Json) => void;
  md5Override?: string;
  expiresInMs?: number;
  completeDelayMs?: number;
};

/**
 * A loopback fake of the Admin: the media-ingest routes over a shared fake
 * bucket, and the relay's start/chunk/complete for the 40 MiB fallback.
 * Error bodies carry a marker the client must never print.
 */
async function startAdmin(
  bucket: Map<string, Buffer>,
  secrets: Secrets,
  options: AdminOptions = {},
) {
  const docs = new Map<string, Json>();
  const sessions = new Map<string, { intent: Json; chunks: Buffer[] }>();
  const requests: { route: string; method: string; bytes: number }[] = [];
  let nextId = 1,
    activeCompletes = 0,
    maxCompletes = 0,
    completeCalls = 0,
    startCalls = 0,
    abandonCalls = 0;
  const reply = (status: number, json: Json) => ({ status, json });
  const refuse = (status: number, code: string) =>
    reply(status, {
      ok: false,
      error: { code, fields: [] },
      message: `${secrets.marker} https://${secrets.bucket}.${SUFFIX}/editorial/x`,
    });
  // As the Admin derives it: from the caller's actor and the intent.
  let actor = "actor";
  const ingestId = (intent: Json) => sha256(JSON.stringify([actor, intent]));
  const stagingKey = (intent: Json) => {
    const id = ingestId(intent);
    return `catalog-ingest/v1/${id.slice(0, 2)}/${id}`;
  };
  const register = (intent: Json, bytes: Buffer) => {
    const extension = intent.mimeType === "image/jpeg" ? "jpg" : "png";
    const filename = `${sha256(String(intent.mediaId))}-${sha256(bytes)}.${extension}`;
    const objectKey = `editorial/${sha256(String(intent.catalogId))}/${filename}`;
    bucket.set(objectKey, bytes);
    const media: Json = {
      id: nextId++,
      mediaId: intent.mediaId,
      catalogId: intent.catalogId,
      objectKey,
      sha256: sha256(bytes),
      mimeType: intent.mimeType,
      filesize: bytes.length,
      filename,
      width: intent.width ?? 640,
      height: intent.height ?? 480,
      alt: intent.alt,
      ...(intent.rights === undefined ? {} : { rights: intent.rights }),
      ...(intent.orderConfidence === undefined
        ? {}
        : { orderConfidence: intent.orderConfidence }),
    };
    docs.set(String(intent.mediaId), media);
    return media;
  };
  const matches = (media: Json, intent: Json) =>
    media.catalogId === intent.catalogId &&
    media.sha256 === intent.sha256 &&
    media.filesize === intent.bytes &&
    media.alt === intent.alt;
  const handle = async (route: string, body: Buffer, headers: Json) => {
    if (headers.authorization === `users API-Key ${secrets.token}`)
      actor = "actor";
    else if (headers.authorization === `users API-Key ${secrets.otherToken}`)
      actor = "other";
    else return refuse(401, "UNAUTHORIZED");
    if (route.startsWith("/api/editorial/media-ingest/")) {
      if (options.ingest === false) return refuse(404, "NOT_FOUND");
      const parsed = JSON.parse(body.toString("utf8")) as Json;
      const intent = (
        route.endsWith("/start") ? parsed : parsed.intent
      ) as Json;
      if (!editorialMediaIngestStartSchema.safeParse(intent).success)
        return refuse(400, "UPLOAD_INPUT_INVALID");
      const existing = docs.get(String(intent.mediaId));
      const key = stagingKey(intent);
      if (route.endsWith("/start")) {
        startCalls++;
        if (startCalls <= (options.startFaults ?? 0))
          return refuse(500, "OPERATION_FAILED");
        if (options.startRefusal)
          return refuse(options.startRefusal.status, options.startRefusal.code);
        if (existing)
          return matches(existing, intent)
            ? reply(200, {
                ok: true,
                result: { state: "registered", media: existing },
              })
            : refuse(409, "MEDIA_IDENTITY_CONFLICT");
        const id = ingestId(intent);
        const grant = {
          state: "upload",
          ingestId: id,
          upload: {
            method: "PUT",
            url: `https://${secrets.bucket}.${SUFFIX}/${key}?q-sign-algorithm=sha1&q-ak=${secrets.accessKey}&q-signature=${secrets.signature}`,
            headers: {
              "content-length": String(intent.bytes),
              "content-type": intent.mimeType,
              "x-cos-forbid-overwrite": "true",
              "content-md5": intent.md5Base64,
            },
            expiresAt: new Date(
              Date.now() + (options.expiresInMs ?? 300_000),
            ).toISOString(),
          },
        };
        options.mutateGrant?.(grant);
        return reply(200, { ok: true, result: grant });
      }
      if (route.endsWith("/abandon")) {
        if (++abandonCalls <= (options.abandonFaults ?? 0))
          return refuse(500, "OPERATION_FAILED");
        const state = bucket.has(key) ? "abandoned" : "absent";
        bucket.delete(key);
        return reply(200, {
          ok: true,
          result: { ingestId: ingestId(intent), state },
        });
      }
      // complete
      const fault = options.completeFaults?.[completeCalls];
      completeCalls++;
      if (fault === "before") return refuse(502, "OPERATION_FAILED");
      if (fault === "busy") return refuse(409, "CONCURRENT_OPERATION_BUSY");
      activeCompletes++;
      maxCompletes = Math.max(maxCompletes, activeCompletes);
      try {
        if (options.completeDelayMs)
          await new Promise((resolve) =>
            setTimeout(resolve, options.completeDelayMs),
          );
        if (existing) {
          if (!matches(existing, intent))
            return refuse(409, "MEDIA_IDENTITY_CONFLICT");
          // As the Admin: a reuse removes the caller's own staging object.
          bucket.delete(key);
          return reply(200, {
            ok: true,
            result: {
              media: existing,
              reused: true,
              validatedBytes: existing.filesize,
              validatedSha256: existing.sha256,
              validatedMd5: null,
              width: existing.width,
              height: existing.height,
            },
          });
        }
        const staged = bucket.get(key);
        if (!staged) return refuse(409, "INGEST_NOT_UPLOADED");
        if (options.completeCode) {
          if (!options.completeCode.keepStaging) bucket.delete(key);
          return refuse(options.completeCode.status, options.completeCode.code);
        }
        if (staged.length !== intent.bytes) {
          bucket.delete(key);
          return refuse(422, "INGEST_SIZE_MISMATCH");
        }
        if (sha256(staged) !== intent.sha256) {
          bucket.delete(key);
          return refuse(422, "INGEST_HASH_MISMATCH");
        }
        const media = register(intent, staged);
        bucket.delete(key);
        if (fault === "after") return refuse(504, "GATEWAY_TIMEOUT");
        return reply(200, {
          ok: true,
          result: {
            media,
            reused: false,
            validatedBytes: media.filesize,
            validatedSha256: media.sha256,
            validatedMd5: options.md5Override ?? md5(staged),
            width: media.width,
            height: media.height,
          },
        });
      } finally {
        activeCompletes--;
      }
    }
    // The relay, for the fallback within 40 MiB.
    if (route === "/api/editorial/media-upload/start") {
      const intent = JSON.parse(body.toString("utf8")) as Json;
      if (!editorialMediaUploadStartSchema.safeParse(intent).success)
        return refuse(400, "UPLOAD_INPUT_INVALID");
      const uploadId = sha256(JSON.stringify(["relay", intent]));
      sessions.set(uploadId, { intent, chunks: [] });
      return reply(200, {
        ok: true,
        result: {
          uploadId,
          state: "uploading",
          chunkBytes: 128 * 1024,
          chunkCount: Math.ceil(Number(intent.bytes) / (128 * 1024)),
          receivedIndices: [],
          expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
        },
      });
    }
    const chunk =
      /^\/api\/editorial\/media-upload\/chunk\/([a-f0-9]{64})\/(\d+)$/.exec(
        route,
      );
    if (chunk) {
      const session = sessions.get(String(chunk[1]));
      if (!session) return refuse(404, "UPLOAD_NOT_FOUND");
      session.chunks[Number(chunk[2])] = body;
      return reply(200, {
        ok: true,
        result: {
          uploadId: chunk[1],
          index: Number(chunk[2]),
          bytes: body.length,
          sha256: sha256(body),
        },
      });
    }
    if (route === "/api/editorial/media-upload/complete") {
      const { uploadId } = JSON.parse(body.toString("utf8")) as Json;
      const session = sessions.get(String(uploadId));
      if (!session) return refuse(404, "UPLOAD_NOT_FOUND");
      const bytes = Buffer.concat(session.chunks);
      if (sha256(bytes) !== session.intent.sha256)
        return refuse(422, "UPLOAD_FILE_HASH_MISMATCH");
      const media = register(session.intent, bytes);
      return reply(200, {
        ok: true,
        result: {
          media,
          reused: false,
          validatedBytes: bytes.length,
          validatedSha256: media.sha256,
        },
      });
    }
    return refuse(404, "NOT_FOUND");
  };
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on("data", (part: Buffer) => chunks.push(part));
    req.on("end", () => {
      const body = Buffer.concat(chunks);
      const route = req.url ?? "";
      requests.push({ route, method: req.method ?? "", bytes: body.length });
      void handle(route, body, req.headers as Json).then(({ status, json }) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(json));
      });
    });
  });
  await new Promise<void>((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve()),
  );
  const { port } = server.address() as AddressInfo;
  return {
    origin: `http://127.0.0.1:${port}`,
    docs,
    requests,
    stats: () => ({ maxCompletes, completeCalls, startCalls }),
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

type CosOptions = {
  putStatuses?: number[];
  corruptFirst?: boolean;
  privacyStatus?: number;
  redirect?: boolean;
  putDelayMs?: number;
  loseFirstReply?: boolean;
};

/** An injected fetch that is the COS bucket: staging PUTs and anonymous GETs. */
function fakeCos(
  bucket: Map<string, Buffer>,
  secrets: Secrets,
  options: CosOptions = {},
) {
  const requests: {
    method: string;
    host: string;
    path: string;
    headers: Record<string, string>;
    redirect: unknown;
    bytes: number;
  }[] = [];
  const statuses: number[] = [];
  let active = 0,
    maxActive = 0,
    corrupted = false,
    lost = false;
  const fetchImpl = (async (input: string | URL, init: RequestInit = {}) => {
    const url = new URL(String(input));
    const headers = Object.fromEntries(new Headers(init.headers));
    const body = init.body ? Buffer.from(init.body as Uint8Array) : undefined;
    requests.push({
      method: String(init.method),
      host: url.hostname,
      path: url.pathname,
      headers,
      redirect: init.redirect,
      bytes: body?.length ?? 0,
    });
    // fetch with redirect "error" rejects a redirect as a network error.
    if (options.redirect) throw new TypeError("fetch failed");
    const errorBody = `<Error><Key>${url.pathname}</Key><Message>${secrets.marker}</Message></Error>`;
    if (init.method === "GET")
      return new Response(
        (options.privacyStatus ?? 403) === 206 ? "x" : errorBody,
        { status: options.privacyStatus ?? 403 },
      );
    active++;
    maxActive = Math.max(maxActive, active);
    try {
      if (options.putDelayMs)
        await new Promise((resolve) => setTimeout(resolve, options.putDelayMs));
      const answer = (status: number) => {
        statuses.push(status);
        return new Response(status === 200 ? null : errorBody, { status });
      };
      const forced = options.putStatuses?.shift();
      if (forced !== undefined && forced !== 200) return answer(forced);
      const key = url.pathname.slice(1);
      if (!body || md5(body) !== headers["content-md5"]) return answer(400);
      if (headers["x-cos-forbid-overwrite"] === "true" && bucket.has(key))
        return answer(409);
      let stored = body;
      if (options.corruptFirst && !corrupted) {
        corrupted = true;
        stored = Buffer.from(body);
        stored[10] = (stored[10] ?? 0) ^ 0xff;
      }
      bucket.set(key, stored);
      if (options.loseFirstReply && !lost) {
        lost = true;
        statuses.push(0);
        throw new TypeError("fetch failed");
      }
      return answer(200);
    } finally {
      active--;
    }
  }) as typeof fetch;
  return { fetchImpl, requests, statuses, maxActive: () => maxActive };
}

const directories: string[] = [];
const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(closers.splice(0).map((close) => close()));
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

type ItemSpec = { key: string; size: number; json?: Json };
async function setup(
  items: ItemSpec[],
  adminOptions: AdminOptions = {},
  cosOptions: CosOptions = {},
) {
  const directory = await mkdtemp(join(tmpdir(), "direct-ingest-"));
  directories.push(directory);
  const secrets = secretsFor();
  const bucket = new Map<string, Buffer>();
  const admin = await startAdmin(bucket, secrets, adminOptions);
  closers.push(admin.close);
  const cos = fakeCos(bucket, secrets, cosOptions);
  const manifest: Manifest = {
    version: 1,
    batchId: "synthetic-ingest-batch",
    items: [],
  };
  for (const { key, size, json } of items) {
    const bytes = original(size);
    await writeFile(join(directory, `${key}.jpg`), bytes);
    manifest.items.push({
      key,
      file: `${key}.jpg`,
      mimeType: "image/jpeg",
      catalogId: "synthetic-ingest-catalog",
      mediaId: `synthetic-ingest-${key}`,
      sha256: sha256(bytes),
      bytes: size,
      width: 9504,
      height: 6336,
      alt: "合成测试原图",
      ...json,
    });
  }
  const send = ingest.createAdminSend({
    baseURL: admin.origin,
    apiKey: secrets.token,
  });
  const client = ingest.createCosClient({
    hostSuffix: SUFFIX,
    fetchImpl: cos.fetchImpl,
  });
  const stateFile = join(directory, "private", "state.jsonl");
  const run = (options: Partial<RunOptions> = {}) =>
    ingest.runDirectIngest({
      manifest,
      directory,
      stateFile,
      send,
      cos: client,
      cosHostSuffix: SUFFIX,
      dryRun: false,
      retryDelayMs: 0,
      ...options,
    });
  return {
    directory,
    secrets,
    bucket,
    admin,
    cos,
    manifest,
    send,
    client,
    stateFile,
    run,
  };
}
const adminRoutes = (context: Awaited<ReturnType<typeof setup>>) =>
  context.admin.requests.map((request) => request.route);
const cosPuts = (context: Awaited<ReturnType<typeof setup>>) =>
  context.cos.requests.filter((request) => request.method === "PUT");
const stagedKeys = (context: Awaited<ReturnType<typeof setup>>) =>
  [...context.bucket.keys()].filter((key) => key.startsWith("catalog-ingest/"))
    .length;
/** The state file's rows, the last of each key winning. */
const stateRows = async (context: Awaited<ReturnType<typeof setup>>) =>
  new Map(
    (await readFile(context.stateFile, "utf8"))
      .trim()
      .split("\n")
      .slice(1)
      .map((line) => JSON.parse(line) as { key: string; value: Json })
      .map(({ key, value }) => [key, value]),
  );
const INGEST = {
  start: "/api/editorial/media-ingest/start",
  complete: "/api/editorial/media-ingest/complete",
  abandon: "/api/editorial/media-ingest/abandon",
};
/** The item registered by another path (the relay, another credential). */
const registeredFor = (item: Json): Json => {
  const filename = `${sha256(String(item.mediaId))}-${String(item.sha256)}.jpg`;
  return {
    id: 900,
    mediaId: item.mediaId,
    catalogId: item.catalogId,
    objectKey: `editorial/${sha256(String(item.catalogId))}/${filename}`,
    sha256: item.sha256,
    mimeType: item.mimeType,
    filesize: item.bytes,
    filename,
    width: item.width,
    height: item.height,
    alt: item.alt,
  };
};

describe(
  "Catalog original ingest client (direct-cos-v1)",
  { timeout: 60_000 },
  () => {
    it("ingests an original over 40 MiB with two small Admin requests and one PUT straight to COS", async () => {
      const context = await setup([{ key: "large", size: 41 * MiB + 7 }]);
      const writes: string[] = [];
      for (const stream of [process.stdout, process.stderr])
        vi.spyOn(stream, "write").mockImplementation((chunk) => {
          writes.push(String(chunk));
          return true;
        });
      for (const method of ["log", "info", "warn", "error", "debug"] as const)
        vi.spyOn(console, method).mockImplementation((...args) => {
          writes.push(args.map(String).join(" "));
        });
      const summary = await context.run();
      vi.restoreAllMocks();

      expect(summary).toMatchObject({
        total: 1,
        registered: 1,
        failed: 0,
        pending: 0,
        newlyRegistered: 1,
        reused: 0,
        relayFallbacks: 0,
        privacy: "private",
      });
      // toMatchObject treats {} as "any object"; no code at all is expected.
      expect(summary.codes).toEqual({});
      // Two control requests, under 16 KB in all; no readback of any kind.
      expect(adminRoutes(context)).toEqual([
        "/api/editorial/media-ingest/start",
        "/api/editorial/media-ingest/complete",
      ]);
      expect(
        context.admin.requests.reduce((total, r) => total + r.bytes, 0),
      ).toBeLessThan(16 * 1024);
      expect(
        adminRoutes(context).some((route) => route.includes("/api/media")),
      ).toBe(false);
      // The bytes went once to the bucket host with exactly the signed headers.
      const put = cosPuts(context)[0]!;
      expect(cosPuts(context)).toHaveLength(1);
      expect(put.host).toBe(`${context.secrets.bucket}.${SUFFIX}`);
      expect(put.bytes).toBe(41 * MiB + 7);
      expect(put.redirect).toBe("error");
      expect(Object.keys(put.headers).sort()).toEqual([
        "content-length",
        "content-md5",
        "content-type",
        "x-cos-forbid-overwrite",
      ]);
      // One anonymous Range 0-0 privacy GET of the final key, same bucket host.
      const gets = context.cos.requests.filter((r) => r.method === "GET");
      expect(gets).toHaveLength(1);
      expect(gets[0]?.headers).toEqual({ range: "bytes=0-0" });
      expect(gets[0]?.path).toMatch(
        /^\/editorial\/[a-f0-9]{64}\/[a-f0-9]{64}-[a-f0-9]{64}\.jpg$/,
      );
      for (const request of context.cos.requests) {
        expect(request.headers.authorization).toBeUndefined();
        expect(request.headers.cookie).toBeUndefined();
      }
      const media = context.admin.docs.get("synthetic-ingest-large");
      expect(media).toMatchObject({
        filesize: 41 * MiB + 7,
        width: 9504,
        height: 6336,
        sha256: context.manifest.items[0]?.sha256,
      });
      expect(context.bucket.has(String(media?.objectKey))).toBe(true);
      // Nothing printed and nothing private in the state file.
      expectRedacted(writes.join("\n"), context.secrets);
      const state = await readFile(context.stateFile, "utf8");
      expectRedacted(state, context.secrets);
      expect((await stat(context.stateFile)).mode & 0o077).toBe(0);
      expect(state).toContain('"status":"registered"');
    });

    it("skips registered items on a later run without any request", async () => {
      const context = await setup([{ key: "one", size: 4096 }]);
      await context.run();
      const before = context.admin.requests.length;
      const summary = await context.run();
      expect(summary).toMatchObject({ registered: 1, newlyRegistered: 0 });
      expect(context.admin.requests).toHaveLength(before);
      expect(summary.privacy).toBe("not-needed");
    });

    it("resumes a staged item from the state file with start and complete but no second PUT", async () => {
      const context = await setup([{ key: "staged", size: 8192 }], {
        completeFaults: ["before", "before", "before", "before"],
      });
      const first = await context.run({ attempts: 1 });
      expect(first).toMatchObject({
        pending: 1,
        registered: 0,
        codes: { ADMIN_UNAVAILABLE: 1 },
      });
      expect(cosPuts(context)).toHaveLength(1);
      const state = await readFile(context.stateFile, "utf8");
      expect(state).toContain('"staged":true');

      const requestsBefore = context.admin.requests.length;
      const second = await context.run();
      expect(second).toMatchObject({ registered: 1, pending: 0 });
      expect(cosPuts(context)).toHaveLength(1);
      expect(
        context.admin.requests.slice(requestsBefore).map((r) => r.route),
      ).toEqual([
        "/api/editorial/media-ingest/start",
        "/api/editorial/media-ingest/complete",
      ]);
    });

    it("treats a 409 from the staging PUT as staged and goes to complete", async () => {
      // The first PUT lands but its reply is lost; the re-signed second PUT is
      // refused by forbid-overwrite, which proves the bytes are staged.
      const context = await setup(
        [{ key: "landed", size: 4096 }],
        {},
        { loseFirstReply: true },
      );
      const summary = await context.run();
      expect(summary).toMatchObject({ registered: 1, newlyRegistered: 1 });
      expect(context.cos.statuses).toEqual([0, 409]);
      expect(adminRoutes(context)).toEqual([
        "/api/editorial/media-ingest/start",
        "/api/editorial/media-ingest/start",
        "/api/editorial/media-ingest/complete",
      ]);
      expect(context.admin.docs.size).toBe(1);
    });

    it("re-signs after a 403 and before a nearly expired URL", async () => {
      const forbidden = await setup(
        [{ key: "expired", size: 4096 }],
        {},
        { putStatuses: [403] },
      );
      expect(await forbidden.run()).toMatchObject({ registered: 1 });
      expect(cosPuts(forbidden)).toHaveLength(2);
      expect(forbidden.admin.stats().startCalls).toBe(2);

      const expiring = await setup([{ key: "expiring", size: 4096 }], {
        expiresInMs: 10_000,
      });
      expect(await expiring.run()).toMatchObject({ registered: 1 });
      // The first URL had under 15 s left: a fresh one was signed, one PUT sent.
      expect(expiring.admin.stats().startCalls).toBe(2);
      expect(cosPuts(expiring)).toHaveLength(1);
    });

    it("re-signs inside the put slot, so a library caller's wait for a shared slot never sends an expired URL", async () => {
      // A shared one-slot limiter for two items, and PUTs that take 400 s of
      // a fake clock: the second item gets the slot after its first URL's
      // 300 s have passed.
      let clock = Date.now();
      const expiries = new Map<string, number>();
      let grants = 0;
      const context = await setup(
        [
          { key: "first", size: 4096 },
          { key: "second", size: 4096 },
        ],
        {
          mutateGrant: (grant) => {
            const upload = grant.upload as Json;
            const id = String(++grants);
            upload.url = `${String(upload.url)}&q-key-time=${id}`;
            upload.expiresAt = new Date(clock + 300_000).toISOString();
            expiries.set(id, clock + 300_000);
          },
        },
      );
      const statuses: number[] = [];
      let busy = false;
      const waiting: (() => void)[] = [];
      const put = async (work: () => Promise<unknown>) => {
        if (busy) await new Promise<void>((resolve) => waiting.push(resolve));
        busy = true;
        try {
          return await work();
        } finally {
          busy = false;
          waiting.shift()?.();
        }
      };
      const putObject = async (request: Json) => {
        // The first PUT lasts until the other item waits for the slot.
        for (let tick = 0; !statuses.length && !waiting.length; tick++) {
          if (tick > 500) throw new Error("the other item never waited");
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        const id = new URL(String(request.url)).searchParams.get("q-key-time");
        // As COS answers a PUT whose signature has expired.
        if (clock >= (expiries.get(String(id)) ?? 0)) {
          statuses.push(403);
          return { ok: false, status: 403 };
        }
        const response = await context.client.putObject(request);
        clock += 400_000;
        statuses.push(response.status);
        return response;
      };
      const results = await Promise.all(
        context.manifest.items.map(async (item) =>
          upload.stageMediaUpload({
            item: {
              requestHash: sha256(String(item.key)),
              body: {
                catalogId: item.catalogId,
                mediaId: item.mediaId,
                alt: item.alt,
              },
              file: {
                sha256: item.sha256,
                size: item.bytes,
                mimeType: item.mimeType,
                width: item.width,
                height: item.height,
              },
            },
            bytes: await readFile(
              join(context.directory, `${String(item.key)}.jpg`),
            ),
            transferId: sha256(`transfer-${String(item.key)}`),
            send: context.send,
            uploadMode: "direct-cos-v1",
            putObject,
            put,
            cosHostSuffix: SUFFIX,
            retryDelayMs: 0,
            now: () => clock,
          }),
        ),
      );
      expect(results).toMatchObject([{ ok: true }, { ok: true }]);
      // One PUT each, both on a live signature; the second item re-signed
      // once it held the slot.
      expect(statuses).toEqual([200, 200]);
      expect(context.admin.stats().startCalls).toBe(3);
    });

    it("retries a 502 or a lost 504 reply of complete as uncertain and registers once", async () => {
      const context = await setup([{ key: "uncertain", size: 4096 }], {
        completeFaults: ["before", "after"],
      });
      const summary = await context.run();
      // The lost reply registered the doc; the third complete reuses it.
      expect(summary).toMatchObject({ registered: 1, reused: 1 });
      expect(context.admin.stats().completeCalls).toBe(3);
      expect(context.admin.docs.size).toBe(1);
      expect(
        [...context.bucket.keys()].filter((key) =>
          key.startsWith("editorial/"),
        ),
      ).toHaveLength(1);
      expect(cosPuts(context)).toHaveLength(1);
    });

    it("retries a complete that waited out the relay's media lock, and never abandons for it", async () => {
      const context = await setup([{ key: "busy", size: 4096 }], {
        completeFaults: ["busy", "busy"],
      });
      const summary = await context.run();
      expect(summary).toMatchObject({
        registered: 1,
        failed: 0,
        abandoned: 0,
        codes: {},
      });
      expect(adminRoutes(context)).toEqual([
        INGEST.start,
        INGEST.complete,
        INGEST.complete,
        INGEST.complete,
      ]);
      expect(cosPuts(context)).toHaveLength(1);

      // Busy is retryable for the ingest complete and abandon (and the
      // relay's chunks) only; any other route keeps a 409 final.
      const busy = vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              ok: false,
              error: { code: "CONCURRENT_OPERATION_BUSY" },
            }),
            { status: 409 },
          ),
      );
      const send = ingest.createAdminSend(
        { baseURL: "https://admin.example.test", apiKey: "synthetic-api-key" },
        { fetchImpl: busy as unknown as typeof fetch },
      );
      for (const [route, retryable] of [
        [INGEST.complete, true],
        [INGEST.abandon, true],
        [INGEST.start, false],
        ["/api/editorial/media-upload/complete", false],
      ] as const)
        expect(await send(route, "POST", {}, undefined), route).toMatchObject({
          ok: false,
          code: "CONCURRENT_OPERATION_BUSY",
          retryable,
        });
    });

    it("records each PUT's time and status and each complete's time, and summarizes the canary in numbers only", async () => {
      // Four originals over 40 MiB and one under; the first PUT of two of
      // the large ones fails (a 503, then a lost reply that stored nothing).
      let clock = 1_000_000;
      const context = await setup(
        [
          { key: "large-1", size: 41 * MiB },
          { key: "large-2", size: 41 * MiB },
          { key: "large-3", size: 41 * MiB },
          { key: "large-4", size: 41 * MiB },
          { key: "small", size: 4096 },
        ],
        { completeFaults: ["busy"] },
        { putStatuses: [503, 200, 0, 200, 200, 200, 200] },
      );
      const summary = await context.run({
        concurrency: 1,
        completeConcurrency: 1,
        now: () => (clock += 250),
      });
      expect(summary).toMatchObject({ registered: 5, failed: 0 });
      expect(summary.metrics).toEqual({
        putAttempts: 7,
        failedPuts: 2,
        largePuts: 4,
        largePutsFailedOnce: 2,
        // 41 MiB in 250 ms; 4 KiB in 250 ms.
        putMiBps: { p50: 164, min: 0.02, max: 164 },
        putMs: { p50: 250, min: 250, max: 250 },
        completeMs: { p50: 250, min: 250, max: 250 },
      });
      // Per image, in the private state file: numbers only.
      const rows = (await readFile(context.stateFile, "utf8"))
        .trim()
        .split("\n")
        .slice(1)
        .map((line) => JSON.parse(line) as { key: string; value: Json });
      const last = new Map(rows.map(({ key, value }) => [key, value]));
      expect(last.get("large-1")).toMatchObject({
        status: "registered",
        metrics: {
          bytes: 41 * MiB,
          puts: [
            { ms: 250, status: 503 },
            { ms: 250, status: 200 },
          ],
          completes: [250],
        },
      });
      expect(last.get("large-2")).toMatchObject({
        metrics: {
          puts: [
            { ms: 250, status: 0 },
            { ms: 250, status: 200 },
          ],
        },
      });
      expect(last.get("small")).toMatchObject({
        metrics: { bytes: 4096, puts: [{ ms: 250, status: 200 }] },
      });
      expectRedacted(JSON.stringify(summary), context.secrets);
      expectRedacted(
        await readFile(context.stateFile, "utf8"),
        context.secrets,
      );
    });

    it("puts again once after the server found a hash mismatch and deleted staging", async () => {
      const context = await setup(
        [{ key: "corrupt", size: 4096 }],
        {},
        { corruptFirst: true },
      );
      expect(await context.run()).toMatchObject({ registered: 1 });
      expect(cosPuts(context)).toHaveLength(2);
      expect(context.admin.stats().startCalls).toBe(2);
    });

    it("abandons the staging key on a terminal refusal and reports a fixed code", async () => {
      const context = await setup([{ key: "animated", size: 4096 }], {
        completeCode: { status: 422, code: "INGEST_CONTENT_INVALID" },
      });
      const summary = await context.run();
      // complete already removed the refused staging object, so the abandon
      // that follows removes nothing and says so.
      expect(summary).toMatchObject({
        failed: 1,
        abandoned: 0,
        codes: { INGEST_CONTENT_INVALID: 1 },
      });
      expect(adminRoutes(context)).toEqual([
        "/api/editorial/media-ingest/start",
        "/api/editorial/media-ingest/complete",
        "/api/editorial/media-ingest/abandon",
      ]);
      expect(context.admin.docs.size).toBe(0);
      expect(
        [...context.bucket.keys()].some((key) =>
          key.startsWith("catalog-ingest/"),
        ),
      ).toBe(false);
      expectRedacted(JSON.stringify(summary), context.secrets);
    });

    it("fails and abandons once when complete finds an invalid final object, without retrying it", async () => {
      // 500 is retryable for every other code; re-verifying a bad final
      // object again would re-hash up to 128 MiB for the same answer.
      const context = await setup([{ key: "final", size: 4096 }], {
        completeCode: {
          status: 500,
          code: "INGEST_FINAL_INVALID",
          keepStaging: true,
        },
      });
      const summary = await context.run();
      expect(summary).toMatchObject({
        failed: 1,
        pending: 0,
        abandoned: 1,
        codes: { INGEST_FINAL_INVALID: 1 },
      });
      expect(context.admin.stats().completeCalls).toBe(1);
      expect(adminRoutes(context)).toEqual([
        INGEST.start,
        INGEST.complete,
        INGEST.abandon,
      ]);
      expect(stagedKeys(context)).toBe(0);
      expect(await readFile(context.stateFile, "utf8")).toMatch(
        /"status":"failed"[^\n]*\n$/,
      );
    });

    it("gives up after three refused PUTs, abandons the staging key and fails the item", async () => {
      const context = await setup(
        [{ key: "forbidden", size: 4096 }],
        {},
        { putStatuses: [403, 403, 403] },
      );
      const summary = await context.run();
      // No PUT stored anything: the abandon answers absent, not abandoned.
      expect(summary).toMatchObject({
        failed: 1,
        pending: 0,
        abandoned: 0,
        codes: { MEDIA_INGEST_PUT_FORBIDDEN: 1 },
      });
      // Each 403 re-signs; the third is final, so no further attempt runs.
      expect(cosPuts(context)).toHaveLength(3);
      expect(context.admin.stats().startCalls).toBe(3);
      expect(
        adminRoutes(context).filter((route) => route === INGEST.abandon),
      ).toHaveLength(1);
    });

    it("abandons a staged item when a resumed start refuses it terminally", async () => {
      const context = await setup([{ key: "resumed", size: 8192 }], {
        completeFaults: ["before", "before", "before", "before"],
      });
      expect(await context.run({ attempts: 1 })).toMatchObject({
        pending: 1,
      });
      expect(stagedKeys(context)).toBe(1);
      // Another path registered the mediaId with other metadata meanwhile.
      context.admin.docs.set("synthetic-ingest-resumed", {
        mediaId: "synthetic-ingest-resumed",
        catalogId: "another-synthetic-catalog",
      });
      const before = context.admin.requests.length;
      expect(await context.run()).toMatchObject({
        failed: 1,
        pending: 0,
        abandoned: 1,
        codes: { MEDIA_IDENTITY_CONFLICT: 1 },
      });
      expect(
        context.admin.requests.slice(before).map((request) => request.route),
      ).toEqual([INGEST.start, INGEST.abandon]);
      expect(cosPuts(context)).toHaveLength(1);
      expect(stagedKeys(context)).toBe(0);
    });

    it("abandons its own staged bytes when start finds the mediaId registered meanwhile, on resume and on a re-sign", async () => {
      // Nothing PUT: start's reuse sends nothing else.
      const fresh = await setup([{ key: "fresh", size: 4096 }]);
      fresh.admin.docs.set(
        "synthetic-ingest-fresh",
        registeredFor(fresh.manifest.items[0]!),
      );
      expect(await fresh.run()).toMatchObject({ registered: 1, reused: 1 });
      expect(adminRoutes(fresh)).toEqual([INGEST.start]);
      expect(fresh.cos.requests).toHaveLength(0);

      // Resumed: an earlier run staged the bytes, then another path
      // registered the same original.
      const resumed = await setup([{ key: "meanwhile", size: 8192 }], {
        completeFaults: ["before", "before", "before", "before"],
      });
      expect(await resumed.run({ attempts: 1 })).toMatchObject({
        pending: 1,
      });
      expect(stagedKeys(resumed)).toBe(1);
      resumed.admin.docs.set(
        "synthetic-ingest-meanwhile",
        registeredFor(resumed.manifest.items[0]!),
      );
      const before = resumed.admin.requests.length;
      expect(await resumed.run()).toMatchObject({
        registered: 1,
        reused: 1,
        failed: 0,
        pending: 0,
      });
      expect(
        resumed.admin.requests.slice(before).map((request) => request.route),
      ).toEqual([INGEST.start, INGEST.abandon]);
      expect(cosPuts(resumed)).toHaveLength(1);
      expect(stagedKeys(resumed)).toBe(0);

      // Re-signed: the first PUT landed but its reply was lost, and the
      // mediaId was registered before the re-sign.
      let registerOnce = () => {};
      const resigned = await setup(
        [{ key: "resigned", size: 4096 }],
        { mutateGrant: () => registerOnce() },
        { loseFirstReply: true },
      );
      registerOnce = () => {
        registerOnce = () => {};
        resigned.admin.docs.set(
          "synthetic-ingest-resigned",
          registeredFor(resigned.manifest.items[0]!),
        );
      };
      expect(await resigned.run()).toMatchObject({
        registered: 1,
        reused: 1,
        failed: 0,
      });
      expect(resigned.cos.statuses).toEqual([0]);
      expect(adminRoutes(resigned)).toEqual([
        INGEST.start,
        INGEST.start,
        INGEST.abandon,
      ]);
      expect(stagedKeys(resigned)).toBe(0);
    });

    /**
     * A first run whose three PUTs all answered 503: no answer confirmed a
     * PUT, so the row says staged: false, but it records the grant's staging
     * id, and one PUT did land (put in the bucket here by hand).
     */
    const unconfirmedPut = async (adminOptions: AdminOptions = {}) => {
      const context = await setup(
        [{ key: "landed", size: 4096 }],
        adminOptions,
        { putStatuses: [503, 503, 503] },
      );
      expect(await context.run({ attempts: 1 })).toMatchObject({
        pending: 1,
        codes: { MEDIA_INGEST_PUT_UNCERTAIN: 1 },
      });
      expect((await stateRows(context)).get("landed")).toMatchObject({
        staged: false,
        stagingDigest: expect.any(String),
      });
      context.bucket.set(
        cosPuts(context)[0]!.path.slice(1),
        await readFile(join(context.directory, "landed.jpg")),
      );
      expect(stagedKeys(context)).toBe(1);
      return context;
    };

    it("abandons the staging key of a recorded but unconfirmed PUT when start finds the mediaId registered meanwhile", async () => {
      const context = await unconfirmedPut();
      const item = context.manifest.items[0]!;
      context.admin.docs.set(String(item.mediaId), registeredFor(item));
      const before = context.admin.requests.length;
      expect(await context.run()).toMatchObject({
        registered: 1,
        reused: 1,
        failed: 0,
        pending: 0,
      });
      expect(
        context.admin.requests.slice(before).map((request) => request.route),
      ).toEqual([INGEST.start, INGEST.abandon]);
      expect(cosPuts(context)).toHaveLength(3);
      // The registered row drops its staging record, and --abandon skips
      // registered rows: this abandon is the only one that object gets.
      expect(stagedKeys(context)).toBe(0);
    });

    it("abandons the staging key of a recorded but unconfirmed PUT when a resumed start refuses the item terminally", async () => {
      const adminOptions: AdminOptions = {};
      const context = await unconfirmedPut(adminOptions);
      adminOptions.startRefusal = { status: 400, code: "INGEST_INPUT_INVALID" };
      const before = context.admin.requests.length;
      expect(await context.run()).toMatchObject({
        failed: 1,
        pending: 0,
        abandoned: 1,
        codes: { INGEST_INPUT_INVALID: 1 },
      });
      expect(
        context.admin.requests.slice(before).map((request) => request.route),
      ).toEqual([INGEST.start, INGEST.abandon]);
      expect(cosPuts(context)).toHaveLength(3);
      expect(stagedKeys(context)).toBe(0);
      // The key is empty now, so the row no longer binds an actor.
      const row = (await stateRows(context)).get("landed")!;
      expect(row).toMatchObject({ status: "failed", staged: false });
      expect(row).not.toHaveProperty("stagingDigest");
    });

    it("admits no new item after the Admin's ingest quota refuses one", async () => {
      const context = await setup(
        Array.from({ length: 3 }, (_, index) => ({
          key: `quota-${index}`,
          size: 4096,
        })),
        { startRefusal: { status: 429, code: "INGEST_QUOTA_EXCEEDED" } },
      );
      const summary = await context.run({ concurrency: 1 });
      // The refused item stays pending; the others never start (no row).
      expect(summary).toMatchObject({
        registered: 0,
        failed: 0,
        pending: 3,
        codes: { INGEST_QUOTA_EXCEEDED: 1 },
      });
      // Only the first item's bounded start retries reach the Admin.
      expect(context.admin.stats().startCalls).toBe(3);
      expect(context.cos.requests).toHaveLength(0);
    });

    it("does not PUT or abandon when start refuses the identity", async () => {
      const context = await setup([{ key: "conflict", size: 4096 }]);
      context.admin.docs.set("synthetic-ingest-conflict", {
        mediaId: "synthetic-ingest-conflict",
        catalogId: "another-synthetic-catalog",
      });
      expect(await context.run()).toMatchObject({
        failed: 1,
        codes: { MEDIA_IDENTITY_CONFLICT: 1 },
      });
      expect(adminRoutes(context)).toEqual([
        "/api/editorial/media-ingest/start",
      ]);
      expect(context.cos.requests).toHaveLength(0);
    });

    it("refuses a signed URL outside the COS host suffix, staging path or https", async () => {
      const mutations: [string, (grant: Json) => void][] = [
        [
          "foreign host",
          (grant) => {
            const upload = grant.upload as Json;
            upload.url = String(upload.url).replace(SUFFIX, "elsewhere.test");
          },
        ],
        [
          "suffix lookalike",
          (grant) => {
            const upload = grant.upload as Json;
            upload.url = String(upload.url).replace(`.${SUFFIX}`, `-${SUFFIX}`);
          },
        ],
        [
          "final prefix",
          (grant) => {
            const upload = grant.upload as Json;
            upload.url = String(upload.url).replace(
              "/catalog-ingest/v1/",
              "/editorial/v1/",
            );
          },
        ],
        [
          "another ingest",
          (grant) => {
            grant.ingestId = "f".repeat(64);
          },
        ],
        [
          "plain http",
          (grant) => {
            const upload = grant.upload as Json;
            upload.url = String(upload.url).replace("https:", "http:");
          },
        ],
        [
          "credentials",
          (grant) => {
            const upload = grant.upload as Json;
            upload.url = String(upload.url).replace("https://", "https://u:p@");
          },
        ],
        [
          "extra header",
          (grant) => {
            const upload = grant.upload as Json;
            (upload.headers as Json).authorization = "synthetic";
          },
        ],
      ];
      for (const [, mutateGrant] of mutations) {
        const context = await setup([{ key: "refused", size: 4096 }], {
          mutateGrant,
        });
        const summary = await context.run();
        expect(summary).toMatchObject({
          failed: 1,
          codes: { MEDIA_UPLOAD_RESPONSE_INVALID: 1 },
        });
        expect(context.cos.requests).toHaveLength(0);
        expectRedacted(JSON.stringify(summary), context.secrets);
      }
    });

    it("guards the COS client itself: target, headers and redirects", async () => {
      const secrets = secretsFor();
      const fetchImpl = vi.fn(async () => new Response(null, { status: 200 }));
      const client = ingest.createCosClient({
        hostSuffix: SUFFIX,
        fetchImpl: fetchImpl as unknown as typeof fetch,
      });
      const id = "ab" + "c".repeat(62);
      const url = `https://${secrets.bucket}.${SUFFIX}/catalog-ingest/v1/ab/${id}?q-signature=${secrets.signature}`;
      const body = Buffer.from("synthetic");
      const headers = {
        "content-length": String(body.length),
        "content-type": "image/jpeg",
        "x-cos-forbid-overwrite": "true",
        "content-md5": md5(body),
      };
      expect(
        await client.putObject({
          url: url.replace("/ab/", "/cd/"),
          headers,
          body,
        }),
      ).toMatchObject({ code: "COS_TARGET_REFUSED" });
      for (const extra of [
        { authorization: "synthetic" },
        { cookie: "synthetic" },
        { "x-cos-copy-source": "synthetic" },
        { "x-amz-acl": "public-read" },
      ])
        expect(
          await client.putObject({
            url,
            headers: { ...headers, ...extra },
            body,
          }),
        ).toMatchObject({ code: "COS_HEADERS_REFUSED" });
      expect(
        await client.putObject({
          url,
          headers: { ...headers, "content-length": "1" },
          body,
        }),
      ).toMatchObject({ code: "COS_HEADERS_REFUSED" });
      const { "x-cos-forbid-overwrite": forbid, ...overwriting } = headers;
      void forbid;
      expect(
        await client.putObject({ url, headers: overwriting, body }),
      ).toMatchObject({ code: "COS_HEADERS_REFUSED" });
      expect(fetchImpl).not.toHaveBeenCalled();
      expect(await client.putObject({ url, headers, body })).toEqual({
        ok: true,
        status: 200,
      });
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      const [, init] = fetchImpl.mock.calls[0] as unknown as [
        string,
        RequestInit,
      ];
      expect(init).toMatchObject({ method: "PUT", redirect: "error" });
      expect(init.headers).toEqual(headers);
      // The privacy GET only goes to an approved final key at the same origin.
      expect(
        await client.checkPrivate({ url, objectKey: "catalog-ingest/v1/x" }),
      ).toBe("uncertain");
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      expect(upload.normalizeCosHostSuffix("127.0.0.1")).toBeNull();
      expect(upload.normalizeCosHostSuffix("test")).toBeNull();
      expect(upload.normalizeCosHostSuffix(".COS.Example.Test")).toBe(SUFFIX);
      expect(
        upload.stagingUploadTarget(
          url.replace("https://", "https://x."),
          SUFFIX,
        ),
      ).not.toBeNull();
      expect(upload.stagingUploadTarget(`${url}#x`, SUFFIX)).toBeNull();
      expect(
        upload.stagingUploadTarget(
          url.replace(`.${SUFFIX}`, `.${SUFFIX}:8443`),
          SUFFIX,
        ),
      ).toBeNull();
    });

    it("leaves a PUT whose redirect was refused pending, never following it", async () => {
      const context = await setup(
        [{ key: "redirected", size: 4096 }],
        {},
        { redirect: true },
      );
      const summary = await context.run({ attempts: 1 });
      expect(summary).toMatchObject({
        pending: 1,
        codes: { MEDIA_INGEST_PUT_UNCERTAIN: 1 },
      });
      expect(cosPuts(context)).toHaveLength(3);
      for (const request of context.cos.requests) {
        expect(request.redirect).toBe("error");
        expect(request.host).toBe(`${context.secrets.bucket}.${SUFFIX}`);
      }
    });

    it("falls back to the relay only for files within 40 MiB while the routes are absent", async () => {
      const context = await setup(
        [
          { key: "small", size: 300 * 1024 },
          { key: "large", size: 40 * MiB + 1 },
        ],
        { ingest: false },
      );
      const summary = await context.run();
      expect(summary).toMatchObject({
        registered: 1,
        failed: 1,
        relayFallbacks: 1,
        privacy: "relay-only",
        codes: { MEDIA_INGEST_UNAVAILABLE: 1 },
      });
      expect(context.cos.requests).toHaveLength(0);
      expect(context.admin.docs.has("synthetic-ingest-small")).toBe(true);
      expect(context.admin.docs.has("synthetic-ingest-large")).toBe(false);
      const state = await readFile(context.stateFile, "utf8");
      expect(state).toContain('"transport":"relay"');
    });

    it("never takes the relay once a PUT began: an Admin restarted with the switch off keeps the staged item for the next run or --abandon", async () => {
      const relayRoutes = (context: Awaited<ReturnType<typeof setup>>) =>
        adminRoutes(context).filter((route) =>
          route.startsWith("/api/editorial/media-upload/"),
        );
      for (const finish of ["run", "abandon"] as const) {
        // The Admin restarts with the switch off once it granted the PUT.
        const adminOptions: AdminOptions = {};
        adminOptions.mutateGrant = () => {
          adminOptions.ingest = false;
        };
        const context = await setup(
          [{ key: "restarted", size: 300 * 1024 }],
          adminOptions,
        );
        expect(await context.run(), finish).toMatchObject({
          registered: 0,
          failed: 1,
          relayFallbacks: 0,
          codes: { MEDIA_INGEST_UNAVAILABLE: 1 },
        });
        expect(cosPuts(context), finish).toHaveLength(1);
        expect(relayRoutes(context), finish).toEqual([]);
        expect(context.admin.docs.size, finish).toBe(0);
        expect(stagedKeys(context), finish).toBe(1);
        expect(
          (await stateRows(context)).get("restarted"),
          finish,
        ).toMatchObject({
          status: "failed",
          staged: true,
          stagingDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
        });
        // A second run while it is off still keeps the record.
        expect(await context.run(), finish).toMatchObject({
          failed: 1,
          relayFallbacks: 0,
          codes: { MEDIA_INGEST_UNAVAILABLE: 1 },
        });
        expect(relayRoutes(context), finish).toEqual([]);
        // The switch is on again.
        delete adminOptions.mutateGrant;
        adminOptions.ingest = true;
        if (finish === "run") {
          expect(await context.run()).toMatchObject({
            registered: 1,
            failed: 0,
            codes: {},
          });
          // From the staged bytes: no second PUT.
          expect(cosPuts(context)).toHaveLength(1);
        } else
          expect(
            await ingest.abandonIngest({
              manifest: context.manifest,
              directory: context.directory,
              stateFile: context.stateFile,
              send: context.send,
            }),
          ).toMatchObject({ abandoned: 1, codes: {} });
        expect(stagedKeys(context), finish).toBe(0);
      }
    });

    it("never takes the relay for an item whose earlier PUT may have landed, and --abandon then finds its object", async () => {
      const adminOptions: AdminOptions = {};
      const context = await setup(
        [{ key: "uncertain", size: 4096 }],
        adminOptions,
        { putStatuses: [503, 503, 503] },
      );
      expect(await context.run({ attempts: 1 })).toMatchObject({
        pending: 1,
        codes: { MEDIA_INGEST_PUT_UNCERTAIN: 1 },
      });
      const row = (await stateRows(context)).get("uncertain");
      expect(row).toMatchObject({
        staged: false,
        stagingDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
      });
      // One of the uncertain PUTs did land after all.
      const put = cosPuts(context)[0]!;
      context.bucket.set(
        put.path.slice(1),
        await readFile(join(context.directory, "uncertain.jpg")),
      );
      adminOptions.ingest = false;
      const before = context.admin.requests.length;
      expect(await context.run()).toMatchObject({
        registered: 0,
        failed: 1,
        relayFallbacks: 0,
        codes: { MEDIA_INGEST_UNAVAILABLE: 1 },
      });
      expect(
        context.admin.requests.slice(before).map((request) => request.route),
      ).toEqual([INGEST.start]);
      expect((await stateRows(context)).get("uncertain")).toMatchObject({
        stagingDigest: row?.stagingDigest,
      });
      adminOptions.ingest = true;
      expect(
        await ingest.abandonIngest({
          manifest: context.manifest,
          directory: context.directory,
          stateFile: context.stateFile,
          send: context.send,
        }),
      ).toMatchObject({ abandoned: 1, codes: {} });
      expect(stagedKeys(context)).toBe(0);
    });

    it("stops the run and reports a final original that answers anonymously", async () => {
      const context = await setup(
        [
          { key: "first", size: 4096 },
          { key: "second", size: 4096 },
        ],
        {},
        { privacyStatus: 206 },
      );
      const summary = await context.run({ concurrency: 1 });
      expect(summary.privacy).toBe("public");
      expect(summary.registered).toBe(1);
      expect(summary.pending).toBe(1);
      expect(
        context.cos.requests.filter((r) => r.method === "GET"),
      ).toHaveLength(1);
    });

    it("stops admitting items on any privacy answer but private, after three tries while uncertain", async () => {
      // 404: a private object never answers it anonymously; a 500 leaves the
      // answer uncertain.
      for (const [privacyStatus, privacy, gets] of [
        [404, "unexpected", 1],
        [500, "uncertain", 3],
      ] as const) {
        const context = await setup(
          [
            { key: "first", size: 4096 },
            { key: "second", size: 4096 },
          ],
          {},
          { privacyStatus },
        );
        const summary = await context.run({ concurrency: 1 });
        expect(summary, privacy).toMatchObject({
          privacy,
          registered: 1,
          pending: 1,
        });
        expect(
          context.cos.requests.filter((r) => r.method === "GET"),
          privacy,
        ).toHaveLength(gets);
        // The second item never started: one start, one PUT, no row.
        expect(context.admin.stats().startCalls, privacy).toBe(1);
        expect(cosPuts(context), privacy).toHaveLength(1);
        const rows = await stateRows(context);
        expect(rows.has("second"), privacy).toBe(false);
        expect(rows.get("#privacy"), privacy).toEqual({
          status: privacy,
          checkedAt: expect.any(String),
        });
      }
    });

    it("refuses to start or resume while the state records a public or unexpected answer, before any request", async () => {
      for (const [privacyStatus, privacy] of [
        [206, "public"],
        [404, "unexpected"],
      ] as const) {
        const context = await setup(
          [
            { key: "first", size: 4096 },
            { key: "second", size: 4096 },
          ],
          {},
          { privacyStatus },
        );
        expect(await context.run({ concurrency: 1 })).toMatchObject({
          privacy,
          pending: 1,
        });
        const admin = context.admin.requests.length,
          cos = context.cos.requests.length,
          state = await readFile(context.stateFile, "utf8");
        await expect(context.run(), privacy).rejects.toMatchObject({
          code: "PRIVACY_STOPPED",
        });
        expect(context.admin.requests, privacy).toHaveLength(admin);
        expect(context.cos.requests, privacy).toHaveLength(cos);
        expect(await readFile(context.stateFile, "utf8"), privacy).toBe(state);
        // --abandon registers nothing, so it still runs on that state.
        expect(
          await ingest.abandonIngest({
            manifest: context.manifest,
            directory: context.directory,
            stateFile: context.stateFile,
            send: context.send,
          }),
          privacy,
        ).toMatchObject({ abandon: true, notStarted: 1, codes: {} });
      }

      // An uncertain answer does not refuse: the next run checks again.
      const uncertain = await setup(
        [
          { key: "first", size: 4096 },
          { key: "second", size: 4096 },
        ],
        {},
        { privacyStatus: 500 },
      );
      expect(await uncertain.run({ concurrency: 1 })).toMatchObject({
        privacy: "uncertain",
        pending: 1,
      });
      const client = ingest.createCosClient({
        hostSuffix: SUFFIX,
        fetchImpl: fakeCos(uncertain.bucket, uncertain.secrets).fetchImpl,
      });
      expect(await uncertain.run({ cos: client })).toMatchObject({
        privacy: "private",
        registered: 2,
      });
      // That private answer settled the recorded uncertain one.
      expect(await uncertain.run({ cos: client })).toMatchObject({
        privacy: "not-needed",
        registered: 2,
        newlyRegistered: 0,
      });
    });

    it("reports a recorded uncertain answer again on a re-run that checks nothing, until a check answers private", async () => {
      const gets = (context: Awaited<ReturnType<typeof setup>>) =>
        context.cos.requests.filter((r) => r.method === "GET").length;
      // One item: the re-run finds it registered, so nothing new is checked.
      const single = await setup(
        [{ key: "only", size: 4096 }],
        {},
        { privacyStatus: 500 },
      );
      expect(await single.run()).toMatchObject({
        privacy: "uncertain",
        registered: 1,
      });
      expect(gets(single)).toBe(3);
      const again = await single.run();
      expect(again).toMatchObject({
        privacy: "uncertain",
        registered: 1,
        newlyRegistered: 0,
        reused: 0,
        codes: {},
      });
      expect(gets(single)).toBe(3);
      expect(ingest.runbookLines(again)).toEqual([
        expect.stringMatching(
          /^EDITORIAL_DIRECT_INGEST_RUNBOOK PRIVACY_UNCERTAIN: /,
        ),
      ]);
      expect((await stateRows(single)).get("#privacy")).toMatchObject({
        status: "uncertain",
      });

      // The rest through the relay only: the Admin's path checks those, not
      // the direct original whose answer is still open.
      const adminOptions: AdminOptions = {};
      const relayed = await setup(
        [
          { key: "first", size: 4096 },
          { key: "second", size: 4096 },
        ],
        adminOptions,
        { privacyStatus: 500 },
      );
      expect(await relayed.run({ concurrency: 1 })).toMatchObject({
        privacy: "uncertain",
        pending: 1,
      });
      adminOptions.ingest = false;
      expect(await relayed.run()).toMatchObject({
        privacy: "uncertain",
        registered: 2,
        newlyRegistered: 1,
        relayFallbacks: 1,
      });
      expect(gets(relayed)).toBe(3);
    });

    it("treats a privacy check that throws as uncertain: three tries, then the run stops", async () => {
      const context = await setup([
        { key: "first", size: 4096 },
        { key: "second", size: 4096 },
      ]);
      let calls = 0;
      const summary = await context.run({
        concurrency: 1,
        cos: {
          putObject: context.client.putObject,
          checkPrivate: async () => {
            calls++;
            throw new Error("injected check failure");
          },
        },
      });
      expect(summary).toMatchObject({
        privacy: "uncertain",
        registered: 1,
        pending: 1,
      });
      expect(calls).toBe(3);
      // The second item never started.
      expect(context.admin.stats().startCalls).toBe(1);
      const rows = await stateRows(context);
      expect(rows.has("second")).toBe(false);
      expect(rows.get("#privacy")).toEqual({
        status: "uncertain",
        checkedAt: expect.any(String),
      });
    });

    it("starts no item while the privacy check of a new original runs", async () => {
      const context = await setup(
        Array.from({ length: 3 }, (_, index) => ({
          key: `item-${index}`,
          size: 4096,
        })),
      );
      // The first registration's check takes a while and answers public;
      // the other item in flight registers meanwhile, and its worker waits.
      const summary = await context.run({
        concurrency: 2,
        cos: {
          putObject: context.client.putObject,
          checkPrivate: async () => {
            await new Promise((resolve) => setTimeout(resolve, 300));
            return "public";
          },
        },
      });
      expect(summary).toMatchObject({
        privacy: "public",
        registered: 2,
        pending: 1,
      });
      expect(context.admin.stats().startCalls).toBe(2);
      expect((await stateRows(context)).has("item-2")).toBe(false);
    });

    it("stops the run before it records a privacy answer, so a failed state write cannot skip the stop", async () => {
      const context = await setup([
        { key: "first", size: 4096 },
        { key: "held", size: 4096 },
      ]);
      const held = md5(await readFile(join(context.directory, "held.jpg")));
      let heldAborted: boolean | undefined;
      const cos: CosClient = {
        putObject: async (request) => {
          if (md5(request.body as Uint8Array) !== held)
            return context.client.putObject(request);
          // The second item's PUT is held until the run aborts it.
          const signal = request.signal as AbortSignal;
          heldAborted = await new Promise<boolean>((resolve) => {
            const timer = setTimeout(() => resolve(false), 2_000);
            signal.addEventListener("abort", () => {
              clearTimeout(timer);
              resolve(true);
            });
          });
          return { ok: false, status: 0 };
        },
        checkPrivate: async () => {
          // The state file can no longer be appended to.
          await rm(context.stateFile);
          await mkdir(context.stateFile);
          return "public";
        },
      };
      await expect(context.run({ concurrency: 2, cos })).rejects.toMatchObject({
        code: "EISDIR",
      });
      expect(heldAborted).toBe(true);
    });

    it("refuses a registration whose MD5 differs from the local bytes", async () => {
      const context = await setup([{ key: "md5", size: 4096 }], {
        md5Override: "A".repeat(22) + "==",
      });
      expect(await context.run()).toMatchObject({
        failed: 1,
        codes: { MEDIA_UPLOAD_READBACK_MISMATCH: 1 },
      });
    });

    it("keeps at most 2 completes and 4 PUTs in flight", async () => {
      const context = await setup(
        Array.from({ length: 6 }, (_, index) => ({
          key: `item-${index}`,
          size: 4096,
        })),
        { completeDelayMs: 40 },
        { putDelayMs: 20 },
      );
      expect(await context.run()).toMatchObject({ registered: 6 });
      expect(context.admin.stats().maxCompletes).toBe(2);
      expect(context.cos.maxActive()).toBeLessThanOrEqual(4);
      expect(context.cos.maxActive()).toBeGreaterThan(1);
    });

    it("refuses a changed source file and a changed manifest item", async () => {
      const context = await setup([{ key: "changed", size: 4096 }]);
      await writeFile(join(context.directory, "changed.jpg"), original(4096));
      expect(await context.run()).toMatchObject({
        failed: 1,
        codes: { MEDIA_SOURCE_CHANGED: 1 },
      });
      expect(context.admin.requests).toHaveLength(0);
      context.manifest.items[0]!.alt = "另一合成说明";
      await expect(context.run()).rejects.toMatchObject({
        code: "STATE_INPUT_CHANGED",
      });
    });

    it("abandons every unregistered staging key on request", async () => {
      const context = await setup(
        [
          { key: "first", size: 4096 },
          { key: "second", size: 4096 },
        ],
        { completeFaults: Array.from({ length: 8 }, () => "before" as const) },
      );
      await context.run({ attempts: 1, concurrency: 1 });
      const staged = () =>
        [...context.bucket.keys()].filter((key) =>
          key.startsWith("catalog-ingest/"),
        ).length;
      expect(staged()).toBe(2);
      const result = await ingest.abandonIngest({
        manifest: context.manifest,
        directory: context.directory,
        stateFile: context.stateFile,
        send: context.send,
      });
      expect(result).toMatchObject({
        abandon: true,
        total: 2,
        abandoned: 2,
      });
      expect(result.codes).toEqual({});
      expect(staged()).toBe(0);
      expectRedacted(JSON.stringify(result), context.secrets);
    });

    it("abandons a staged item from the MD5 its row recorded, after its file changed or was removed", async () => {
      const context = await setup(
        [
          { key: "changed", size: 4096 },
          { key: "removed", size: 4096 },
        ],
        { completeFaults: Array.from({ length: 8 }, () => "before" as const) },
      );
      const originals = new Map<string, Buffer>();
      for (const key of ["changed", "removed"])
        originals.set(
          key,
          await readFile(join(context.directory, `${key}.jpg`)),
        );
      await context.run({ attempts: 1, concurrency: 1 });
      expect(stagedKeys(context)).toBe(2);
      // The MD5 the staging PUT sent, which the Admin's staging id covers.
      for (const [key, bytes] of originals)
        expect((await stateRows(context)).get(key)).toMatchObject({
          staged: true,
          md5Base64: md5(bytes),
        });
      await writeFile(join(context.directory, "changed.jpg"), original(4096));
      await rm(join(context.directory, "removed.jpg"));
      const before = context.admin.requests.length;
      const result = await ingest.abandonIngest({
        manifest: context.manifest,
        directory: context.directory,
        stateFile: context.stateFile,
        send: context.send,
      });
      expect(result).toMatchObject({ abandoned: 2, absent: 0 });
      expect(result.codes).toEqual({});
      expect(
        context.admin.requests.slice(before).map((request) => request.route),
      ).toEqual([INGEST.abandon, INGEST.abandon]);
      expect(stagedKeys(context)).toBe(0);
    });

    it("keeps a staged item's recorded MD5 through a re-run that finds its file changed, so --abandon still removes its object", async () => {
      for (const restored of [false, true]) {
        const context = await setup([{ key: "staged", size: 4096 }], {
          completeFaults: Array.from({ length: 8 }, () => "before" as const),
        });
        const file = join(context.directory, "staged.jpg");
        const bytes = await readFile(file);
        // The PUT landed; complete never answered.
        await context.run({ attempts: 1 });
        expect(cosPuts(context), String(restored)).toHaveLength(1);
        expect(stagedKeys(context), String(restored)).toBe(1);
        const recorded = (await stateRows(context)).get("staged");
        expect(recorded, String(restored)).toMatchObject({
          staged: true,
          md5Base64: md5(bytes),
          stagingDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
        });
        // Same size, other bytes: no longer the manifest's SHA-256.
        await writeFile(file, original(4096));
        const before = context.admin.requests.length;
        expect(await context.run(), String(restored)).toMatchObject({
          registered: 0,
          failed: 1,
          codes: { MEDIA_SOURCE_CHANGED: 1 },
        });
        // Refused before any request; the row keeps what --abandon needs.
        expect(context.admin.requests.length, String(restored)).toBe(before);
        expect(cosPuts(context), String(restored)).toHaveLength(1);
        expect(
          (await stateRows(context)).get("staged"),
          String(restored),
        ).toMatchObject({
          status: "failed",
          code: "MEDIA_SOURCE_CHANGED",
          staged: true,
          md5Base64: recorded?.md5Base64,
          stagingDigest: recorded?.stagingDigest,
        });
        if (restored) await writeFile(file, bytes);
        const result = await ingest.abandonIngest({
          manifest: context.manifest,
          directory: context.directory,
          stateFile: context.stateFile,
          send: context.send,
        });
        expect(result, String(restored)).toMatchObject({
          abandoned: 1,
          absent: 0,
        });
        expect(result.codes, String(restored)).toEqual({});
        expect(
          context.admin.requests.slice(before).map((request) => request.route),
          String(restored),
        ).toEqual([INGEST.abandon]);
        expect(stagedKeys(context), String(restored)).toBe(0);
        expect(
          (await stateRows(context)).get("staged"),
          String(restored),
        ).not.toHaveProperty("stagingDigest");
      }
    });

    it("reads the file only for a row recorded without an MD5, and refuses an MD5 that cannot be one", async () => {
      const context = await setup(
        [
          { key: "legacy", size: 4096 },
          { key: "invalid", size: 4096 },
        ],
        { completeFaults: Array.from({ length: 8 }, () => "before" as const) },
      );
      await context.run({ attempts: 1, concurrency: 1 });
      expect(stagedKeys(context)).toBe(2);
      // As an earlier version recorded it, and a damaged row.
      const [header, ...lines] = (await readFile(context.stateFile, "utf8"))
        .trim()
        .split("\n");
      const rows = lines.map(
        (line) => JSON.parse(line) as { key: string; value: Json },
      );
      for (const row of rows)
        if (row.key === "legacy") delete row.value.md5Base64;
        else if (row.key === "invalid") row.value.md5Base64 = "not-an-md5";
      await writeFile(
        context.stateFile,
        `${[header, ...rows.map((row) => JSON.stringify(row))].join("\n")}\n`,
        { mode: 0o600 },
      );
      const abandon = () =>
        ingest.abandonIngest({
          manifest: context.manifest,
          directory: context.directory,
          stateFile: context.stateFile,
          send: context.send,
        });
      const legacy = join(context.directory, "legacy.jpg");
      const bytes = await readFile(legacy);
      await rm(legacy);
      const before = context.admin.requests.length;
      expect(await abandon()).toMatchObject({
        abandoned: 0,
        codes: { MEDIA_FILE_UNREADABLE: 1, STATE_INVALID: 1 },
      });
      expect(context.admin.requests).toHaveLength(before);
      await writeFile(legacy, bytes);
      expect(await abandon()).toMatchObject({
        abandoned: 1,
        codes: { STATE_INVALID: 1 },
      });
      expect(stagedKeys(context)).toBe(1);
    });

    it("abandons a failed item whose own abandon did not succeed, and never an unstarted one", async () => {
      const context = await setup(
        [
          { key: "failed", size: 4096 },
          { key: "unstarted", size: 4096 },
        ],
        {
          completeCode: {
            status: 422,
            code: "INGEST_CONTENT_INVALID",
            keepStaging: true,
          },
          abandonFaults: 2,
        },
      );
      // Only the first item runs; the second never starts and has no row.
      const summary = await context.run({
        manifest: {
          ...context.manifest,
          items: context.manifest.items.slice(0, 1),
        },
      });
      expect(summary).toMatchObject({
        failed: 1,
        abandoned: 0,
        codes: { INGEST_CONTENT_INVALID: 1 },
      });
      const abandonsBefore = adminRoutes(context).filter((route) =>
        route.endsWith("/abandon"),
      ).length;
      const result = await ingest.abandonIngest({
        manifest: context.manifest,
        directory: context.directory,
        stateFile: context.stateFile,
        send: context.send,
      });
      expect(result).toMatchObject({ abandoned: 1 });
      expect(result.codes).toEqual({});
      expect(
        adminRoutes(context).filter((route) => route.endsWith("/abandon")),
      ).toHaveLength(abandonsBefore + 1);
    });

    it("tells another credential's --abandon apart: nothing is claimed and the batch's state is kept", async () => {
      const context = await setup(
        [
          { key: "first", size: 4096 },
          { key: "second", size: 4096 },
        ],
        { completeFaults: Array.from({ length: 8 }, () => "before" as const) },
      );
      await context.run({ attempts: 1, concurrency: 1 });
      expect(stagedKeys(context)).toBe(2);
      const rows = () => stateRows(context);
      // The staging id start granted is kept only as a digest.
      for (const key of ["first", "second"])
        expect((await rows()).get(key)).toMatchObject({
          staged: true,
          stagingDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
        });
      // The same origin, so the state file is accepted, but another actor:
      // the Admin looks at that actor's own (empty) key.
      const other = ingest.createAdminSend({
        baseURL: context.admin.origin,
        apiKey: context.secrets.otherToken,
      });
      const foreign = await ingest.abandonIngest({
        manifest: context.manifest,
        directory: context.directory,
        stateFile: context.stateFile,
        send: other,
      });
      expect(foreign).toMatchObject({ abandoned: 0, absent: 0, notStarted: 0 });
      expect(foreign.codes).toEqual({ INGEST_ACTOR_MISMATCH: 2 });
      expect(stagedKeys(context)).toBe(2);
      for (const key of ["first", "second"])
        expect((await rows()).get(key)).toMatchObject({ staged: true });
      // The batch's own credential removes both.
      const own = await ingest.abandonIngest({
        manifest: context.manifest,
        directory: context.directory,
        stateFile: context.stateFile,
        send: context.send,
      });
      expect(own).toMatchObject({ abandoned: 2, absent: 0 });
      expect(own.codes).toEqual({});
      expect(stagedKeys(context)).toBe(0);
      // The keys are empty now, so the rows bind no actor any more.
      for (const key of ["first", "second"]) {
        const row = (await rows()).get(key);
        expect(row).toMatchObject({ staged: false });
        expect(row).not.toHaveProperty("stagingDigest");
      }
      expectRedacted(
        `${JSON.stringify(foreign)}${await readFile(context.stateFile, "utf8")}`,
        context.secrets,
      );
    });

    it("stops a resumed item under another credential, keeping the batch's staged object and its record", async () => {
      const context = await setup([{ key: "staged", size: 8192 }], {
        completeFaults: ["before", "before", "before", "before"],
      });
      expect(await context.run({ attempts: 1 })).toMatchObject({
        pending: 1,
        codes: { ADMIN_UNAVAILABLE: 1 },
      });
      expect(cosPuts(context)).toHaveLength(1);
      const recorded = (await stateRows(context)).get("staged");
      expect(recorded).toMatchObject({
        staged: true,
        stagingDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
      });
      // The same origin, so the state file is accepted, but another actor:
      // its grant names its own staging key, not the one holding the bytes.
      const other = ingest.createAdminSend({
        baseURL: context.admin.origin,
        apiKey: context.secrets.otherToken,
      });
      const before = context.admin.requests.length;
      const foreign = await context.run({ send: other, attempts: 1 });
      expect(foreign).toMatchObject({
        registered: 0,
        failed: 1,
        codes: { INGEST_ACTOR_MISMATCH: 1 },
      });
      // No PUT, complete or abandon under the other actor.
      expect(
        context.admin.requests.slice(before).map((request) => request.route),
      ).toEqual([INGEST.start]);
      expect(cosPuts(context)).toHaveLength(1);
      expect(stagedKeys(context)).toBe(1);
      expect((await stateRows(context)).get("staged")).toMatchObject({
        staged: true,
        stagingDigest: recorded?.stagingDigest,
      });
      // The batch's own credential finishes it from the staged bytes.
      const own = await context.run();
      expect(own).toMatchObject({ registered: 1, failed: 0 });
      expect(cosPuts(context)).toHaveLength(1);
      expect(stagedKeys(context)).toBe(0);
    });

    it("keeps the record when another credential's resumed start fails terminally and its abandon answers for its own key", async () => {
      const adminOptions: AdminOptions = {
        completeFaults: ["before", "before", "before", "before"],
      };
      const context = await setup(
        [{ key: "staged", size: 8192 }],
        adminOptions,
      );
      await context.run({ attempts: 1 });
      const recorded = (await stateRows(context)).get("staged");
      expect(recorded).toMatchObject({ staged: true });
      adminOptions.startRefusal = { status: 403, code: "FORBIDDEN" };
      const other = ingest.createAdminSend({
        baseURL: context.admin.origin,
        apiKey: context.secrets.otherToken,
      });
      const before = context.admin.requests.length;
      expect(await context.run({ send: other, attempts: 1 })).toMatchObject({
        failed: 1,
        abandoned: 0,
      });
      expect(
        context.admin.requests.slice(before).map((request) => request.route),
      ).toEqual([INGEST.start, INGEST.abandon]);
      // The other actor's key was empty; the batch's object and record stay.
      expect(stagedKeys(context)).toBe(1);
      expect((await stateRows(context)).get("staged")).toMatchObject({
        staged: true,
        stagingDigest: recorded?.stagingDigest,
      });
      delete adminOptions.startRefusal;
      expect(
        await ingest.abandonIngest({
          manifest: context.manifest,
          directory: context.directory,
          stateFile: context.stateFile,
          send: context.send,
        }),
      ).toMatchObject({ abandoned: 1, codes: {} });
      expect(stagedKeys(context)).toBe(0);
    });

    it("lets another credential run an item whose staging key a final failure cleared", async () => {
      const adminOptions: AdminOptions = {
        completeCode: { status: 422, code: "INGEST_CONTENT_INVALID" },
      };
      const context = await setup(
        [{ key: "cleared", size: 4096 }],
        adminOptions,
      );
      expect(await context.run()).toMatchObject({
        failed: 1,
        codes: { INGEST_CONTENT_INVALID: 1 },
      });
      expect(stagedKeys(context)).toBe(0);
      const row = (await stateRows(context)).get("cleared");
      expect(row).toMatchObject({ staged: false });
      expect(row).not.toHaveProperty("stagingDigest");
      delete adminOptions.completeCode;
      const other = ingest.createAdminSend({
        baseURL: context.admin.origin,
        apiKey: context.secrets.otherToken,
      });
      expect(await context.run({ send: other })).toMatchObject({
        registered: 1,
        failed: 0,
        codes: {},
      });
    });

    it("counts a staging object already gone as absent, and refuses without the batch's state file", async () => {
      const context = await setup(
        [
          { key: "expired", size: 4096 },
          { key: "unstarted", size: 4096 },
        ],
        { completeFaults: Array.from({ length: 8 }, () => "before" as const) },
      );
      // Without any state there is nothing to go on: no request, no file.
      const before = context.admin.requests.length;
      await expect(
        ingest.abandonIngest({
          manifest: context.manifest,
          directory: context.directory,
          stateFile: context.stateFile,
          send: context.send,
        }),
      ).rejects.toMatchObject({ code: "STATE_NOT_FOUND" });
      expect(context.admin.requests).toHaveLength(before);
      await expect(stat(context.stateFile)).rejects.toMatchObject({
        code: "ENOENT",
      });
      await context.run({
        attempts: 1,
        manifest: {
          ...context.manifest,
          items: context.manifest.items.slice(0, 1),
        },
      });
      expect(stagedKeys(context)).toBe(1);
      // The staging object expired (L1) or was removed by hand meanwhile.
      for (const key of [...context.bucket.keys()])
        if (key.startsWith("catalog-ingest/")) context.bucket.delete(key);
      const result = await ingest.abandonIngest({
        manifest: context.manifest,
        directory: context.directory,
        stateFile: context.stateFile,
        send: context.send,
      });
      expect(result).toMatchObject({
        total: 2,
        abandoned: 0,
        absent: 1,
        notStarted: 1,
      });
      expect(result.codes).toEqual({});
    });

    it("leaves registered items alone on --abandon: no abandon request and no file read", async () => {
      const context = await setup(
        [
          { key: "done", size: 4096 },
          { key: "stuck", size: 4096 },
        ],
        { completeFaults: [undefined, "before", "before", "before", "before"] },
      );
      expect(await context.run({ attempts: 1, concurrency: 1 })).toMatchObject({
        registered: 1,
        pending: 1,
      });
      // Reading the registered original again would now fail.
      await rm(join(context.directory, "done.jpg"));
      const before = context.admin.requests.length;
      const result = await ingest.abandonIngest({
        manifest: context.manifest,
        directory: context.directory,
        stateFile: context.stateFile,
        send: context.send,
      });
      expect(result).toMatchObject({ total: 2, abandoned: 1 });
      // A read of the removed registered file would add MEDIA_FILE_UNREADABLE.
      expect(result.codes).toEqual({});
      expect(
        context.admin.requests.slice(before).map((request) => request.route),
      ).toEqual([INGEST.abandon]);
      expect(stagedKeys(context)).toBe(0);
    });

    it("gives complete 75 s, past nginx's 60 s and the 45 s server deadline, and other control requests 30 s", async () => {
      const timeouts = vi.spyOn(AbortSignal, "timeout");
      const fetchImpl = vi.fn(
        async () =>
          new Response(JSON.stringify({ ok: true, result: {} }), {
            status: 200,
          }),
      );
      const send = ingest.createAdminSend(
        { baseURL: "https://admin.example.test", apiKey: "synthetic-api-key" },
        { fetchImpl: fetchImpl as unknown as typeof fetch },
      );
      const seen: Record<string, number[]> = {};
      for (const route of [
        INGEST.start,
        INGEST.complete,
        INGEST.abandon,
        "/api/editorial/media-upload/start",
        "/api/editorial/media-upload/complete",
      ]) {
        timeouts.mockClear();
        expect(await send(route, "POST", {}, undefined)).toMatchObject({
          ok: true,
        });
        seen[route] = timeouts.mock.calls.map(([ms]) => Number(ms));
      }
      expect(fetchImpl).toHaveBeenCalledTimes(5);
      expect(seen).toEqual({
        [INGEST.start]: [30_000],
        [INGEST.complete]: [75_000],
        [INGEST.abandon]: [30_000],
        "/api/editorial/media-upload/start": [30_000],
        "/api/editorial/media-upload/complete": [75_000],
      });
    });

    it("writes the state whole again once the rows appended since pass the compaction bound", async () => {
      const context = await setup(
        Array.from({ length: 6 }, (_, index) => ({
          key: `item-${index}`,
          size: 4096,
        })),
      );
      const compactAfterBytes = 2048;
      expect(
        await context.run({
          concurrency: 1,
          stateCompactBytes: compactAfterBytes,
        }),
      ).toMatchObject({ registered: 6, privacy: "private" });
      const text = await readFile(context.stateFile, "utf8");
      const [header, ...lines] = text.trim().split("\n");
      const last = new Map(
        lines.map((line) => [(JSON.parse(line) as { key: string }).key, line]),
      );
      const whole = Buffer.byteLength(
        `${[header, ...last.values()].join("\n")}\n`,
      );
      const longest = Math.max(
        ...lines.map((line) => Buffer.byteLength(line) + 1),
      );
      // One whole state and at most the bound's rows appended since (six
      // items append about five rows each).
      expect(last.size).toBe(7);
      expect(Buffer.byteLength(text)).toBeLessThanOrEqual(
        whole + compactAfterBytes + longest,
      );
      expect((await stat(context.stateFile)).mode & 0o077).toBe(0);
      // Still the batch's state: a later run sends nothing.
      const before = context.admin.requests.length;
      expect(await context.run()).toMatchObject({
        registered: 6,
        newlyRegistered: 0,
      });
      expect(context.admin.requests).toHaveLength(before);
    });

    it("keeps the state of the most items a manifest holds, at the largest row it writes, within what the next run reads", async () => {
      // A 128-character key, and a mediaId and catalogId of 128 characters
      // that JSON escapes to 6 bytes each.
      const identity = "\u0001".repeat(128);
      const key = `k${"x".repeat(127)}`;
      const context = await setup(
        [
          {
            key,
            size: 4096,
            json: { mediaId: identity, catalogId: identity },
          },
        ],
        { completeFaults: ["before", "before", "before", "before"] },
      );
      // Every PUT and complete phase as long as a 900 s PUT.
      let clock = 0;
      const options = {
        now: () => (clock += 900_000),
        budgetMs: 86_400_000,
      };
      expect(await context.run({ attempts: 1, ...options })).toMatchObject({
        pending: 1,
      });
      // The 24 latest PUT and complete timings an item keeps.
      const [header, ...lines] = (await readFile(context.stateFile, "utf8"))
        .trim()
        .split("\n");
      const row = lines
        .map((line) => JSON.parse(line) as { key: string; value: Json })
        .filter((entry) => entry.key === key)
        .at(-1)!;
      row.value.metrics = {
        bytes: 4096,
        puts: Array.from({ length: 24 }, () => ({
          ms: 900_000,
          status: 503,
        })),
        completes: Array.from({ length: 24 }, () => 900_000),
      };
      await writeFile(
        context.stateFile,
        `${header}\n${JSON.stringify(row)}\n`,
        { mode: 0o600 },
      );
      expect(await context.run(options)).toMatchObject({ registered: 1 });
      const [written, ...rows] = (await readFile(context.stateFile, "utf8"))
        .trim()
        .split("\n");
      expect(rows.at(-1)).toContain('"status":"registered"');
      const largest = Math.max(
        ...rows.map((line) => Buffer.byteLength(line) + 1),
      );
      expect(largest).toBeLessThan(3 * 1024);
      const { maxItems, maxStateBytes, compactAfterBytes } =
        ingest.STATE_LIMITS;
      // Every item's row and the privacy row written whole, the rows
      // appended before the next whole write, and the row that passes it.
      expect(
        Buffer.byteLength(written!) +
          1 +
          (maxItems + 1) * largest +
          compactAfterBytes +
          largest,
      ).toBeLessThanOrEqual(maxStateBytes);
      // And a run reads such a state: here past the manifest's 32 MiB, with
      // rows of other items at the largest size.
      const filler = rows.at(-1)!;
      const others = Array.from(
        { length: Math.ceil((33 * MiB) / largest) + 1 },
        (_, index) =>
          filler.replace(
            JSON.stringify(key),
            JSON.stringify(`o${String(index).padStart(127, "0")}`),
          ),
      );
      await writeFile(
        context.stateFile,
        `${[written, ...others, ...rows].join("\n")}\n`,
        { mode: 0o600 },
      );
      expect((await stat(context.stateFile)).size).toBeGreaterThan(33 * MiB);
      const before = context.admin.requests.length;
      expect(await context.run(options)).toMatchObject({
        registered: 1,
        newlyRegistered: 0,
      });
      expect(context.admin.requests).toHaveLength(before);
    });

    it("names the runbook step for outcomes a re-run does not settle, and nothing private", () => {
      const lines = (result: Json) => ingest.runbookLines(result).join("\n");
      const secrets = secretsFor();
      for (const [result, label, category] of [
        [
          { codes: { INGEST_FINAL_INVALID: 1 } },
          "INGEST_FINAL_INVALID",
          "EDITORIAL_MEDIA_INGEST_FINAL_INVALID",
        ],
        [
          { codes: { MEDIA_IDENTITY_CONFLICT: 2 } },
          "MEDIA_IDENTITY_CONFLICT",
          "EDITORIAL_MEDIA_INGEST_ORPHAN",
        ],
        [
          { codes: { MEDIA_IDENTITY_EXISTS: 1 } },
          "MEDIA_IDENTITY_EXISTS",
          "EDITORIAL_MEDIA_INGEST_ORPHAN",
        ],
        [
          { abandon: true, codes: {} },
          "ABANDON_SCOPE",
          "EDITORIAL_MEDIA_INGEST_STAGING_DELETE_FAILED",
        ],
        [
          { codes: { MEDIA_INGEST_UNAVAILABLE: 1 } },
          "MEDIA_INGEST_UNAVAILABLE",
          "--abandon",
        ],
        [{ privacy: "public", codes: {} }, "PRIVACY_PUBLIC", "PRIVACY_STOPPED"],
        [
          { privacy: "unexpected", codes: {} },
          "PRIVACY_UNEXPECTED",
          "PRIVACY_STOPPED",
        ],
        [
          { privacy: "uncertain", codes: {} },
          "PRIVACY_UNCERTAIN",
          "same state file",
        ],
        [
          { codes: { PRIVACY_STOPPED: 1 } },
          "PRIVACY_STOPPED",
          "new state file",
        ],
      ] as const) {
        const text = lines(result);
        expect(text, label).toMatch(
          new RegExp(`^EDITORIAL_DIRECT_INGEST_RUNBOOK ${label}: `),
        );
        expect(text, label).toContain(category);
        expect(text.split("\n"), label).toHaveLength(1);
        expectRedacted(text, secrets);
      }
      // A plain re-run settles everything else, and a private run needs none.
      expect(
        ingest.runbookLines({
          privacy: "private",
          codes: { ADMIN_UNAVAILABLE: 1, MEDIA_INGEST_PUT_UNCERTAIN: 1 },
        }),
      ).toEqual([]);
      expect(
        ingest.runbookLines({
          privacy: "public",
          codes: { INGEST_FINAL_INVALID: 1, ADMIN_UNAVAILABLE: 1 },
        }),
      ).toHaveLength(2);
    });

    it("validates the manifest strictly before reading any file", () => {
      const item = {
        key: "one",
        file: "one.jpg",
        mimeType: "image/jpeg",
        catalogId: "synthetic-ingest-catalog",
        mediaId: "synthetic-ingest-one",
        sha256: "a".repeat(64),
        bytes: 10,
        width: 4,
        height: 3,
        alt: "合成",
      };
      const { width, height, ...undecoded } = item;
      void width;
      void height;
      const manifest = (items: Json[]) => ({
        version: 1,
        batchId: "synthetic",
        items,
      });
      for (const file of ["one.jpg", "sub/one.jpg", "./sub/../one.jpg"])
        expect(
          () => ingest.validateIngestManifest(manifest([{ ...item, file }])),
          file,
        ).not.toThrow();
      for (const [items, code] of [
        [
          [{ ...item, file: "https://elsewhere.test/one.jpg" }],
          "MEDIA_INPUT_INVALID",
        ],
        // Only paths inside the manifest's directory.
        [[{ ...item, file: "/synthetic/one.jpg" }], "MEDIA_PATH_INVALID"],
        [[{ ...item, file: ".." }], "MEDIA_PATH_INVALID"],
        [[{ ...item, file: "../one.jpg" }], "MEDIA_PATH_INVALID"],
        [[{ ...item, file: "sub/../../one.jpg" }], "MEDIA_PATH_INVALID"],
        [[{ ...item, bytes: 128 * MiB + 1 }], "MEDIA_INPUT_INVALID"],
        [[{ ...item, mimeType: "image/gif" }], "MEDIA_INPUT_INVALID"],
        // width and height of the full local decode are required here.
        [[undecoded], "MEDIA_INPUT_INVALID"],
        [[{ ...undecoded, width: 4 }], "MEDIA_INPUT_INVALID"],
        [[{ ...undecoded, height: 3 }], "MEDIA_INPUT_INVALID"],
        [[{ ...item, width: "4" }], "MEDIA_INPUT_INVALID"],
        [[{ ...item, url: "x" }], "ITEM_IDENTITY_INVALID"],
        [[item, { ...item, key: "two" }], "ITEM_IDENTITY_INVALID"],
      ] as [Json[], string][])
        expect(() => ingest.validateIngestManifest(manifest(items))).toThrow(
          code,
        );
    });

    it("refuses an item path outside the manifest's directory before reading any file or sending any request", async () => {
      const context = await setup([
        { key: "inside", size: 4096 },
        { key: "outside", size: 4096 },
      ]);
      // The batch is a subdirectory and the originals stay one level above
      // it. "inside.jpg" is absent from the batch at first, so a read in item
      // order would answer MEDIA_FILE_UNREADABLE before the escaping item.
      const batch = join(context.directory, "batch");
      await mkdir(join(batch, "sub"), { recursive: true });
      const outside = context.manifest.items[1]!;
      const refused = async () => {
        for (const file of [
          join(context.directory, "outside.jpg"),
          "../outside.jpg",
          "sub/../../outside.jpg",
        ]) {
          outside.file = file;
          expect(
            () => ingest.validateIngestManifest(context.manifest),
            file,
          ).toThrow("MEDIA_PATH_INVALID");
          for (const dryRun of [true, false])
            await expect(
              context.run({ directory: batch, dryRun }),
              file,
            ).rejects.toMatchObject({ code: "MEDIA_PATH_INVALID" });
          await expect(
            ingest.abandonIngest({
              manifest: context.manifest,
              directory: batch,
              stateFile: context.stateFile,
              send: context.send,
            }),
            file,
          ).rejects.toMatchObject({ code: "MEDIA_PATH_INVALID" });
        }
      };
      await refused();
      // Readable now: a check item by item would have registered it.
      await copyFile(
        join(context.directory, "inside.jpg"),
        join(batch, "inside.jpg"),
      );
      await refused();
      expect(context.admin.requests).toHaveLength(0);
      expect(context.cos.requests).toHaveLength(0);
      await expect(stat(context.stateFile)).rejects.toMatchObject({
        code: "ENOENT",
      });
      // The same original inside the batch is ingested.
      await copyFile(
        join(context.directory, "outside.jpg"),
        join(batch, "sub", "outside.jpg"),
      );
      outside.file = "sub/outside.jpg";
      expect(await context.run({ directory: batch })).toMatchObject({
        registered: 2,
        failed: 0,
      });
    });

    it("refuses an item under a symlinked directory for the whole batch before any read", async () => {
      const context = await setup([
        { key: "first", size: 4096 },
        { key: "linked", size: 4096 },
      ]);
      // The original sits outside the batch, reached through a symlinked
      // directory; the file itself is no symlink.
      const elsewhere = await mkdtemp(
        join(tmpdir(), "direct-ingest-elsewhere-"),
      );
      directories.push(elsewhere);
      await rename(
        join(context.directory, "linked.jpg"),
        join(elsewhere, "linked.jpg"),
      );
      await symlink(elsewhere, join(context.directory, "via"));
      context.manifest.items[1]!.file = "via/linked.jpg";
      const abandon = () =>
        ingest.abandonIngest({
          manifest: context.manifest,
          directory: context.directory,
          stateFile: context.stateFile,
          send: context.send,
        });
      // "first.jpg" moved away: a read in item order would answer
      // MEDIA_FILE_UNREADABLE first.
      await rename(
        join(context.directory, "first.jpg"),
        join(context.directory, "first.away"),
      );
      await expect(context.run({ dryRun: true })).rejects.toMatchObject({
        code: "MEDIA_PATH_INVALID",
      });
      await rename(
        join(context.directory, "first.away"),
        join(context.directory, "first.jpg"),
      );
      // Every file readable: still refused, and nothing sent or recorded.
      for (const dryRun of [true, false])
        await expect(context.run({ dryRun })).rejects.toMatchObject({
          code: "MEDIA_PATH_INVALID",
        });
      await expect(abandon()).rejects.toMatchObject({
        code: "MEDIA_PATH_INVALID",
      });
      expect(context.admin.requests).toHaveLength(0);
      expect(context.cos.requests).toHaveLength(0);
      await expect(stat(context.stateFile)).rejects.toMatchObject({
        code: "ENOENT",
      });
    });

    it("refuses an item whose directory became a symlink after the batch was checked", async () => {
      let swap = () => {};
      const context = await setup(
        [
          { key: "first", size: 4096 },
          { key: "second", size: 4096 },
        ],
        { mutateGrant: () => swap() },
      );
      await mkdir(join(context.directory, "b"));
      await rename(
        join(context.directory, "second.jpg"),
        join(context.directory, "b", "second.jpg"),
      );
      context.manifest.items[1]!.file = "b/second.jpg";
      // The same bytes outside the batch, which "b" points to once the first
      // item has started.
      const elsewhere = await mkdtemp(
        join(tmpdir(), "direct-ingest-elsewhere-"),
      );
      directories.push(elsewhere);
      await copyFile(
        join(context.directory, "b", "second.jpg"),
        join(elsewhere, "second.jpg"),
      );
      let swapped = false;
      swap = () => {
        if (swapped) return;
        swapped = true;
        renameSync(
          join(context.directory, "b"),
          join(context.directory, "b-real"),
        );
        symlinkSync(elsewhere, join(context.directory, "b"));
      };
      const summary = await context.run({ concurrency: 1 });
      expect(swapped).toBe(true);
      expect(summary).toMatchObject({
        registered: 1,
        failed: 1,
        codes: { MEDIA_PATH_INVALID: 1 },
      });
      expect(context.admin.stats().startCalls).toBe(1);
      expect(context.admin.docs.has("synthetic-ingest-second")).toBe(false);
    });

    it("refuses an original whose directory is a link only while it is opened or stays one, and a linked file", async () => {
      const base = await realpath(
        await mkdtemp(join(tmpdir(), "direct-ingest-open-")),
      );
      directories.push(base);
      const inside = join(base, "b");
      const elsewhere = join(base, "elsewhere");
      await mkdir(inside);
      await mkdir(elsewhere);
      await writeFile(join(inside, "one.jpg"), "inside");
      await writeFile(join(elsewhere, "one.jpg"), "outside");
      await symlink(join(inside, "one.jpg"), join(inside, "link.jpg"));
      const toLink = async () => {
        await rename(inside, `${inside}-real`);
        await symlink(elsewhere, inside);
      };
      const back = async () => {
        await unlink(inside);
        await rename(`${inside}-real`, inside);
      };
      // "b" names "elsewhere" during the open only; whether the open itself
      // got through is recorded.
      const opens: string[] = [];
      const swappedOpen = async (file: string, flags: number) => {
        await toLink();
        try {
          const handle = await open(file, flags);
          opens.push("opened");
          return handle;
        } catch (error) {
          opens.push(String((error as { code?: unknown }).code));
          throw error;
        } finally {
          await back();
        }
      };
      // The CLI's own flags: on macOS the open itself meets the link and
      // never reaches the outside file; elsewhere the inode check refuses it.
      await expect(
        ingest.openOriginal(inside, "one.jpg", { openFile: swappedOpen }),
      ).rejects.toMatchObject({ code: "MEDIA_PATH_INVALID" });
      expect(opens).toEqual([
        process.platform === "darwin" ? "ELOOP" : "opened",
      ]);
      // Only the final component O_NOFOLLOW, as off macOS: the inode check.
      const finalOnly = constants.O_RDONLY | constants.O_NOFOLLOW;
      await expect(
        ingest.openOriginal(inside, "one.jpg", {
          openFile: swappedOpen,
          flags: finalOnly,
        }),
      ).rejects.toMatchObject({ code: "MEDIA_PATH_INVALID" });
      expect(opens.at(-1)).toBe("opened");
      // A link that stays: the directory's real path check.
      await toLink();
      for (const flags of [undefined, finalOnly])
        await expect(
          ingest.openOriginal(inside, "one.jpg", { flags }),
        ).rejects.toMatchObject({ code: "MEDIA_PATH_INVALID" });
      await back();
      for (const flags of [undefined, finalOnly]) {
        await expect(
          ingest.openOriginal(inside, "link.jpg", { flags }),
        ).rejects.toMatchObject({ code: "MEDIA_FILE_UNREADABLE" });
        await expect(
          ingest.openOriginal(inside, "absent.jpg", { flags }),
        ).rejects.toMatchObject({ code: "MEDIA_FILE_UNREADABLE" });
        const { handle, info } = await ingest.openOriginal(inside, "one.jpg", {
          flags,
        });
        try {
          expect(info.isFile()).toBe(true);
          expect((await handle.readFile()).toString()).toBe("inside");
        } finally {
          await handle.close();
        }
      }
    });

    it("reads every original where the batch was checked, even after the link naming the batch is re-pointed", async () => {
      let repoint = () => {};
      const context = await setup(
        [
          { key: "first", size: 4096 },
          { key: "second", size: 4096 },
        ],
        { mutateGrant: () => repoint() },
      );
      // The batch is named through a link; once the first item has started,
      // the link names a copy whose "second.jpg" holds other bytes.
      const names = await mkdtemp(join(tmpdir(), "direct-ingest-names-"));
      const elsewhere = await mkdtemp(
        join(tmpdir(), "direct-ingest-elsewhere-"),
      );
      directories.push(names, elsewhere);
      const link = join(names, "batch");
      await symlink(context.directory, link);
      await copyFile(
        join(context.directory, "first.jpg"),
        join(elsewhere, "first.jpg"),
      );
      await writeFile(join(elsewhere, "second.jpg"), original(4096));
      let repointed = false;
      repoint = () => {
        if (repointed) return;
        repointed = true;
        unlinkSync(link);
        symlinkSync(elsewhere, link);
      };
      expect(
        await context.run({ directory: link, concurrency: 1 }),
      ).toMatchObject({ registered: 2, failed: 0 });
      expect(repointed).toBe(true);
    });

    it("leaves an item in a missing directory to its read, and refuses a missing batch directory", async () => {
      const context = await setup([
        { key: "present", size: 4096 },
        { key: "absent", size: 4096 },
      ]);
      context.manifest.items[1]!.file = "missing/absent.jpg";
      expect(await context.run()).toMatchObject({
        registered: 1,
        failed: 1,
        codes: { MEDIA_FILE_UNREADABLE: 1 },
      });
      await expect(
        context.run({
          directory: join(context.directory, "gone"),
          dryRun: true,
        }),
      ).rejects.toMatchObject({ code: "MEDIA_FILE_UNREADABLE" });
    });

    it("refuses the direct mode without a putObject, a valid suffix or within existingOnly, or with a staging owner or record of the wrong type", async () => {
      const bytes = original(1024);
      const base = {
        item: {
          requestHash: "1".repeat(64),
          body: {
            catalogId: "synthetic-ingest-catalog",
            mediaId: "synthetic-ingest-direct",
            alt: "合成",
          },
          file: {
            sha256: sha256(bytes),
            size: bytes.length,
            mimeType: "image/jpeg",
          },
        },
        bytes,
        send: vi.fn(),
        uploadMode: "direct-cos-v1",
        putObject: vi.fn(),
        cosHostSuffix: SUFFIX,
      };
      for (const change of [
        { putObject: undefined },
        { cosHostSuffix: "127.0.0.1" },
        { existingOnly: true },
        // Never read as "no record": that would let any actor's grant through.
        { ownsStaging: "recorded" },
        // Nor as "no PUT recorded": that would let the relay register it.
        { stagingRecorded: "recorded" },
      ])
        expect(await upload.stageMediaUpload({ ...base, ...change })).toEqual({
          ok: false,
          code: "MEDIA_UPLOAD_INPUT_INVALID",
          retryable: false,
        });
      expect(base.send).not.toHaveBeenCalled();
    });
  },
);

describe("direct-ingest CLI output", { timeout: 60_000 }, () => {
  const runCli = (args: string[]) =>
    new Promise<{ code: number | null; output: string; stdout: string }>(
      (resolve, reject) => {
        const child = spawn(process.execPath, [SCRIPT, ...args], {
          stdio: ["ignore", "pipe", "pipe"],
        });
        let stdout = "",
          stderr = "";
        child.stdout.on("data", (chunk: Buffer) => (stdout += chunk));
        child.stderr.on("data", (chunk: Buffer) => (stderr += chunk));
        const timer = setTimeout(() => child.kill("SIGKILL"), 60_000);
        child.on("error", reject);
        child.on("close", (code) => {
          clearTimeout(timer);
          resolve({ code, output: stdout + stderr, stdout });
        });
      },
    );
  async function cliFiles(
    context: Awaited<ReturnType<typeof setup>>,
    config: Json = {},
  ) {
    const manifestFile = join(context.directory, "manifest.json");
    const configFile = join(context.directory, "config.json");
    await writeFile(manifestFile, JSON.stringify(context.manifest));
    await writeFile(
      configFile,
      JSON.stringify({
        baseURL: context.admin.origin,
        apiKey: context.secrets.token,
        cosHostSuffix: SUFFIX,
        attempts: 1,
        ...config,
      }),
    );
    await chmod(configFile, 0o600);
    return [
      "--manifest",
      manifestFile,
      "--config",
      configFile,
      "--state",
      context.stateFile,
    ];
  }

  it("prints only counts and fixed codes when the Admin returns a URL it must refuse", async () => {
    const context = await setup([{ key: "refused", size: 4096 }], {
      mutateGrant: (grant) => {
        const upload = grant.upload as Json;
        upload.url = String(upload.url).replace(SUFFIX, "elsewhere.test");
      },
    });
    const args = await cliFiles(context);
    const result = await runCli([...args, "--execute"]);
    expect(result.code).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({
      failed: 1,
      codes: { MEDIA_UPLOAD_RESPONSE_INVALID: 1 },
    });
    expectRedacted(result.output, context.secrets);
    expectRedacted(await readFile(context.stateFile, "utf8"), context.secrets);
  });

  it("prints no Admin error body and falls back to the relay over loopback", async () => {
    const context = await setup([{ key: "small", size: 200 * 1024 }], {
      ingest: false,
    });
    const args = await cliFiles(context);
    const result = await runCli([...args, "--execute"]);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      registered: 1,
      relayFallbacks: 1,
      privacy: "relay-only",
    });
    expectRedacted(result.output, context.secrets);

    const failing = await setup([{ key: "busy", size: 4096 }], {
      startFaults: 99,
    });
    const failed = await runCli([...(await cliFiles(failing)), "--execute"]);
    expect(failed.code).toBe(1);
    expect(JSON.parse(failed.stdout)).toMatchObject({
      pending: 1,
      codes: { ADMIN_UNAVAILABLE: 1 },
    });
    expectRedacted(failed.output, failing.secrets);
  });

  it("prints the runbook step after the summary or error: an identity conflict, a privacy stop and --abandon", async () => {
    const conflict = await setup([{ key: "conflict", size: 4096 }]);
    conflict.admin.docs.set("synthetic-ingest-conflict", {
      mediaId: "synthetic-ingest-conflict",
      catalogId: "another-synthetic-catalog",
    });
    const conflicted = await runCli([
      ...(await cliFiles(conflict)),
      "--execute",
    ]);
    expect(conflicted.code).toBe(1);
    expect(JSON.parse(conflicted.stdout)).toMatchObject({
      failed: 1,
      codes: { MEDIA_IDENTITY_CONFLICT: 1 },
    });
    expect(conflicted.output).toContain(
      "EDITORIAL_DIRECT_INGEST_RUNBOOK MEDIA_IDENTITY_CONFLICT: ",
    );
    expect(conflicted.output).toContain("EDITORIAL_MEDIA_INGEST_ORPHAN");
    expectRedacted(conflicted.output, conflict.secrets);

    // A state that recorded a public answer refuses before any request.
    const stopped = await setup(
      [
        { key: "first", size: 4096 },
        { key: "second", size: 4096 },
      ],
      {},
      { privacyStatus: 206 },
    );
    expect(await stopped.run({ concurrency: 1 })).toMatchObject({
      privacy: "public",
    });
    const args = await cliFiles(stopped);
    const before = stopped.admin.requests.length;
    const refused = await runCli([...args, "--execute"]);
    expect(refused.code).toBe(1);
    expect(refused.stdout).toBe("");
    expect(refused.output).toContain(
      "EDITORIAL_DIRECT_INGEST_FAILED PRIVACY_STOPPED",
    );
    expect(refused.output).toContain(
      "EDITORIAL_DIRECT_INGEST_RUNBOOK PRIVACY_STOPPED: ",
    );
    expect(stopped.admin.requests).toHaveLength(before);
    expectRedacted(refused.output, stopped.secrets);

    // --abandon still runs, and names what it cannot reach.
    const abandoned = await runCli([...args, "--abandon"]);
    expect(abandoned.code).toBe(0);
    expect(JSON.parse(abandoned.stdout)).toMatchObject({
      abandon: true,
      notStarted: 1,
    });
    expect(abandoned.output).toContain(
      "EDITORIAL_DIRECT_INGEST_RUNBOOK ABANDON_SCOPE: ",
    );
    expect(abandoned.output).toContain(
      "EDITORIAL_MEDIA_INGEST_STAGING_DELETE_FAILED",
    );
    expectRedacted(abandoned.output, stopped.secrets);
  });

  it("dry-runs without a config or any request, and refuses a readable config", async () => {
    const context = await setup([{ key: "dry", size: 4096 }]);
    const args = await cliFiles(context);
    const dry = await runCli(args.slice(0, 2));
    expect(dry.code).toBe(0);
    expect(JSON.parse(dry.stdout)).toEqual({
      dryRun: true,
      total: 1,
      bytes: 4096,
      overRelayLimit: 0,
    });
    await chmod(args[3]!, 0o644);
    const refused = await runCli([...args, "--execute"]);
    expect(refused.code).toBe(1);
    expect(refused.stdout).toBe("");
    expect(refused.output).toContain("LOCAL_FILE_INVALID");
    expectRedacted(refused.output, context.secrets);
    expect(context.admin.requests).toHaveLength(0);
  });
});

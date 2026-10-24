import { spawn } from "node:child_process";
import { createHash, randomBytes, randomFillSync } from "node:crypto";
import {
  chmod,
  mkdtemp,
  readFile,
  rm,
  stat,
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
  retryDelayMs?: number;
  now?: () => number;
  signal?: AbortSignal;
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
      expect(() =>
        ingest.validateIngestManifest(manifest([item])),
      ).not.toThrow();
      for (const [items, code] of [
        [
          [{ ...item, file: "https://elsewhere.test/one.jpg" }],
          "MEDIA_INPUT_INVALID",
        ],
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

    it("refuses the direct mode without a putObject, a valid suffix or within existingOnly, or with a staging owner that is no function", async () => {
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

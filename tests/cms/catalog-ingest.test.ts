import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import v8 from "node:v8";
import vm from "node:vm";
import { crc32 } from "node:zlib";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  createLocalReq,
  createPayloadRequest,
  getPayload,
  handleEndpoints,
  type Endpoint,
  type Payload,
  type PayloadRequest,
  type Plugin,
  type SanitizedConfig,
} from "payload";
import sharp from "sharp";
import { LocalCatalogSourceReader } from "@moya/backend-production/internal/catalog-source";
import {
  CATALOG_INGEST_STAGING_TAGGING,
  CATALOG_ORIGINAL_MAX_BYTES,
  editorialMediaIngestCompleteResultSchema,
  editorialMediaIngestStartResultSchema,
  editorialMediaIngestVerifyResultSchema,
} from "@moya/contracts/internal/editorial";
import { withVerifiedIngest, type VerifiedIngest } from "admin/media";
import { createCatalogIngestEndpoints } from "admin/media-ingest";

/*
 * catalog-scale-v1 increment 2: Catalog ingest through real Payload, the real
 * media hooks and the real S3 commands, with only the HTTP transport
 * replaced by an in-memory COS (HEAD, ranged GET with If-Match, PUT, copy
 * with If-Match, forbid-overwrite and directives, DELETE). Synthetic
 * credentials and .test hosts only; nothing reaches a network.
 */

type FakeObject = {
  size: number;
  read: (start: number, end: number) => Buffer;
  etag: string;
  crc64: string | null;
  tags: number;
  contentType: string;
  /** Further HEAD headers: what COS stored beside the signed ones. */
  headers?: Record<string, string>;
};
type StorageRequest = {
  kind: "head" | "get" | "copy" | "put" | "delete";
  key: string;
  headers: Record<string, string>;
  transactions: number;
  status: number;
};
type Hook = (
  request: StorageRequest,
  signal: AbortSignal | undefined,
) => Promise<void> | void;

const cos = await vi.hoisted(async () => {
  const { createRequire } = await import("node:module");
  const { Readable } = await import("node:stream");
  const require = createRequire(import.meta.url);
  const admin = createRequire(require.resolve("admin/config"));
  const state = {
    sdk: admin.resolve("@aws-sdk/client-s3"),
    adapter: admin.resolve("@payloadcms/storage-s3"),
    objects: new Map<string, FakeObject>(),
    requests: [] as StorageRequest[],
    before: undefined as Hook | undefined,
    /** Stands in for what COS stores on a copy. */
    copied: (object: FakeObject): FakeObject => object,
    transactions: () => 0,
    handler: undefined as unknown as object,
  };
  const empty = (statusCode: number, headers: Record<string, string> = {}) => ({
    response: { statusCode, headers, body: Readable.from([]) },
  });
  const failure = (statusCode: number, code: string) => ({
    response: {
      statusCode,
      headers: { "content-type": "application/xml" },
      body: Readable.from([
        Buffer.from(
          `<?xml version="1.0" encoding="UTF-8"?><Error><Code>${code}</Code><Message>synthetic</Message></Error>`,
        ),
      ]),
    },
  });
  const aborted = () =>
    Object.assign(new Error("synthetic abort"), { name: "AbortError" });
  state.handler = {
    async handle(
      request: {
        method: string;
        path: string;
        headers: Record<string, string>;
        body?: unknown;
      },
      options?: { abortSignal?: AbortSignal },
    ) {
      const headers = Object.fromEntries(
        Object.entries(request.headers ?? {}).map(([name, value]) => [
          name.toLowerCase(),
          String(value),
        ]),
      );
      const key = decodeURIComponent(request.path.replace(/^\//, ""));
      const source = headers["x-amz-copy-source"];
      const entry: StorageRequest = {
        kind:
          request.method === "HEAD"
            ? "head"
            : request.method === "GET"
              ? "get"
              : request.method === "DELETE"
                ? "delete"
                : source
                  ? "copy"
                  : "put",
        key,
        headers,
        transactions: state.transactions(),
        status: 0,
      };
      state.requests.push(entry);
      await state.before?.(entry, options?.abortSignal);
      if (options?.abortSignal?.aborted) throw aborted();
      const respond = <T extends { response: { statusCode: number } }>(
        result: T,
      ) => {
        entry.status = result.response.statusCode;
        return result;
      };
      const object = state.objects.get(key);
      if (entry.kind === "head")
        return respond(
          object
            ? empty(200, {
                "content-length": String(object.size),
                "content-type": object.contentType,
                etag: object.etag,
                ...(object.crc64
                  ? { "x-cos-hash-crc64ecma": object.crc64 }
                  : {}),
                ...(object.tags
                  ? { "x-cos-tagging-count": String(object.tags) }
                  : {}),
                ...object.headers,
              })
            : empty(404),
        );
      if (entry.kind === "get") {
        if (!object) return respond(failure(404, "NoSuchKey"));
        if (headers["if-match"] && headers["if-match"] !== object.etag)
          return respond(failure(412, "PreconditionFailed"));
        const range = /^bytes=(\d+)-(\d+)$/.exec(headers.range ?? "");
        const start = range ? Number(range[1]) : 0;
        const end = range
          ? Math.min(Number(range[2]), object.size - 1)
          : object.size - 1;
        const bytes = object.read(start, end);
        return respond({
          response: {
            statusCode: range ? 206 : 200,
            headers: {
              "content-length": String(bytes.length),
              "content-range": `bytes ${start}-${end}/${object.size}`,
              etag: object.etag,
            },
            body: Readable.from([bytes]),
          },
        });
      }
      if (entry.kind === "copy") {
        const from = state.objects.get(
          decodeURIComponent(source!.slice(source!.indexOf("/") + 1)),
        );
        if (!from) return respond(failure(404, "NoSuchKey"));
        if (
          headers["x-amz-copy-source-if-match"] &&
          headers["x-amz-copy-source-if-match"] !== from.etag
        )
          return respond(failure(412, "PreconditionFailed"));
        if (headers["x-cos-forbid-overwrite"] === "true" && object)
          return respond(failure(409, "FileAlreadyExists"));
        state.objects.set(
          key,
          state.copied({
            ...from,
            tags:
              headers["x-amz-tagging-directive"] === "REPLACE" ? 0 : from.tags,
          }),
        );
        return respond({
          response: {
            statusCode: 200,
            headers: { "content-type": "application/xml" },
            body: Readable.from([
              Buffer.from(
                `<?xml version="1.0" encoding="UTF-8"?><CopyObjectResult><ETag>${from.etag}</ETag><LastModified>2026-10-23T00:00:00.000Z</LastModified></CopyObjectResult>`,
              ),
            ]),
          },
        });
      }
      if (entry.kind === "put") {
        const chunks: Buffer[] = [];
        if (request.body instanceof Uint8Array)
          chunks.push(Buffer.from(request.body));
        else if (typeof request.body === "string")
          chunks.push(Buffer.from(request.body));
        else if (request.body)
          for await (const chunk of request.body as AsyncIterable<Uint8Array>)
            chunks.push(Buffer.from(chunk));
        const bytes = Buffer.concat(chunks);
        state.objects.set(key, {
          size: bytes.length,
          read: (start, end) => bytes.subarray(start, end + 1),
          etag: '"synthetic-adapter-put"',
          crc64: null,
          tags: 0,
          contentType: headers["content-type"] ?? "application/octet-stream",
        });
        return respond(empty(200, { etag: '"synthetic-adapter-put"' }));
      }
      state.objects.delete(key);
      return respond(empty(204));
    },
  };
  return state;
});

// Keep the real SDK commands, middleware and signing; replace only the
// transport of every client the ingest storage builds.
vi.mock(cos.sdk, async (importOriginal) => {
  const actual = await importOriginal<{
    S3Client: new (config: Record<string, unknown>) => object;
  }>();
  class S3Client extends actual.S3Client {
    constructor(config: Record<string, unknown>) {
      super({ ...config, requestHandler: cos.handler });
    }
  }
  return { ...actual, S3Client };
});
// The media adapter must never write: any PUT it made would show here.
vi.mock(cos.adapter, async (importOriginal) => {
  const actual = await importOriginal<{
    s3Storage: (options: Record<string, unknown>) => Plugin;
  }>();
  return {
    ...actual,
    s3Storage: (options: Record<string, unknown>) =>
      actual.s3Storage({
        ...options,
        config: {
          ...(options.config as Record<string, unknown>),
          requestHandler: cos.handler,
        },
      }),
  };
});

const suffix = randomUUID();
const BUCKET = "synthetic-ingest-1250000000";
const UPLOAD_HOST = "cos.upload.example.test";
const catalogA = `ingest-catalog-a-${suffix}`;
const catalogB = `ingest-catalog-b-${suffix}`;
const STAGING = /^catalog-ingest\/v1\/([a-f0-9]{2})\/([a-f0-9]{64})$/;
const hex = (value: string | Uint8Array) =>
  createHash("sha256").update(value).digest("hex");
const md5 = (bytes: Uint8Array) => createHash("md5").update(bytes);
let config: SanitizedConfig;
let payload: Payload;
let ownerReq: PayloadRequest;
let ownerToken: string;
let scopedToken: string;
let otherToken: string;
let unscopedToken: string;
let budgetTokens: string[];
let jpeg: Buffer;
let png: Buffer;
let webp: Buffer;
let parent: string;
const logged: unknown[] = [];
const replies: unknown[] = [];

type Reply = {
  status: number;
  body: {
    ok: boolean;
    result?: Record<string, unknown> & {
      media?: Record<string, unknown>;
      upload?: { url: string; headers: Record<string, string> };
    };
    error?: { code: string };
  };
};
const reply = async (response: Response): Promise<Reply> => {
  const body = (await response.json()) as Reply["body"];
  replies.push(body);
  return { status: response.status, body };
};
const request = (
  route: string,
  value: unknown,
  token: string | undefined,
  method = "POST",
) =>
  new Request(`http://localhost/api/editorial/media-ingest/${route}`, {
    method,
    headers: {
      "content-type": "application/json",
      ...(token ? { Authorization: `JWT ${token}` } : {}),
    },
    body: JSON.stringify(value),
  });
/** Through the composed configuration (CMS_CATALOG_INGEST=on). */
const call = async (route: string, value: unknown, token = ownerToken) =>
  reply(
    await handleEndpoints({ config, request: request(route, value, token) }),
  );
/** Through a separately composed route set (another mode or deadline). */
const via =
  (endpoints: Endpoint[]) =>
  async (route: string, value: unknown, token = ownerToken) => {
    const req = await createPayloadRequest({
      config,
      request: request(route, value, token),
      canSetHeaders: true,
    });
    const endpoint = endpoints.find(
      (item) =>
        item.path === `/editorial/media-ingest/${route}` &&
        item.method === "post",
    )!;
    return reply(await endpoint.handler(req));
  };
const routes = (
  environment: Record<string, string | undefined> = {},
  deadlineMs?: number,
  actorHourlyBytes?: number,
) =>
  createCatalogIngestEndpoints({
    mediaDirectory: path.join(parent, "media"),
    stagingDirectory: path.join(parent, "editorial-ingest-staging"),
    environment: { ...process.env, ...environment },
    ...(deadlineMs === undefined ? {} : { deadlineMs }),
    ...(actorHourlyBytes === undefined ? {} : { actorHourlyBytes }),
  });

type Intent = {
  transferId: string;
  catalogId: string;
  mediaId: string;
  sha256: string;
  bytes: number;
  mimeType: "image/jpeg" | "image/png" | "image/webp";
  md5Base64: string;
  alt: string;
  rights?: string;
  orderConfidence?: "HIGH" | "LOW";
  width?: number;
  height?: number;
};
const intentFor = (
  label: string,
  bytes: Uint8Array,
  overrides: Partial<Intent> = {},
): Intent => ({
  transferId: hex(`${suffix}:${label}`),
  catalogId: catalogA,
  mediaId: `ingest-${label}-${suffix}`,
  sha256: hex(bytes),
  bytes: bytes.length,
  mimeType: "image/jpeg",
  md5Base64: md5(bytes).digest("base64"),
  alt: "Synthetic ingested original",
  rights: "Synthetic fixture",
  orderConfidence: "HIGH",
  ...overrides,
});
const stored = (
  bytes: Buffer,
  extra: Partial<FakeObject> = {},
): FakeObject => ({
  size: bytes.length,
  read: (start, end) => bytes.subarray(start, end + 1),
  etag: `"${md5(bytes).digest("hex")}"`,
  crc64: String(BigInt(`0x${hex(bytes).slice(0, 15)}`)),
  tags: 0,
  contentType: "image/jpeg",
  ...extra,
});
const finalKey = (intent: Intent) =>
  `editorial/${hex(intent.catalogId)}/${hex(intent.mediaId)}-${intent.sha256}.${
    intent.mimeType === "image/jpeg" ? "jpg" : intent.mimeType.slice(6)
  }`;

/**
 * The uploader's PUT to the signed URL, as COS would take it: the signature
 * binds the listed headers, Content-MD5 must match the body and
 * forbid-overwrite refuses a second write.
 */
const upload = (
  result: Reply["body"]["result"],
  bytes: Buffer | FakeObject,
): number => {
  const signed = result!.upload!;
  const url = new URL(signed.url);
  expect(url.host).toBe(`${BUCKET}.${UPLOAD_HOST}`);
  const key = url.pathname.slice(1);
  expect(key).toMatch(STAGING);
  expect(url.searchParams.get("X-Amz-SignedHeaders")).toBe(
    [...Object.keys(signed.headers), "host"].sort().join(";"),
  );
  const object = Buffer.isBuffer(bytes)
    ? stored(bytes, { contentType: signed.headers["content-type"]! })
    : bytes;
  if (Number(signed.headers["content-length"]) !== object.size) return 403;
  if (
    `"${Buffer.from(signed.headers["content-md5"]!, "base64").toString("hex")}"` !==
    object.etag
  )
    return 400;
  if (cos.objects.has(key)) return 409;
  cos.objects.set(key, {
    ...object,
    tags: signed.headers["x-cos-tagging"] ? 1 : 0,
  });
  return 200;
};
const stagingOf = (result: Reply["body"]["result"]) =>
  new URL(result!.upload!.url).pathname.slice(1);
const started = async (
  intent: Intent,
  bytes: Buffer | FakeObject,
  send: typeof call = call,
  token = ownerToken,
) => {
  const start = await send("start", intent, token);
  expect(start.status).toBe(200);
  expect(start.body.result!.state).toBe("upload");
  expect(upload(start.body.result, bytes)).toBe(200);
  return stagingOf(start.body.result);
};
const mediaCount = async (mediaId: string) =>
  (
    await payload.find({
      collection: "media",
      overrideAccess: true,
      where: { mediaId: { equals: mediaId } },
    })
  ).totalDocs;
const editorialKeysFor = (mediaId: string) =>
  [...cos.objects.keys()].filter(
    (key) => key.startsWith("editorial/") && key.includes(`/${hex(mediaId)}-`),
  );
const since = (mark: number) => cos.requests.slice(mark);
const until = async (predicate: () => boolean) => {
  for (let attempt = 0; attempt < 500; attempt++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("SYNTHETIC_WAIT_TIMED_OUT");
};
const hold = () => {
  let release = () => {};
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
};
const abortable = (promise: Promise<void>, signal: AbortSignal | undefined) =>
  new Promise<void>((resolve, reject) => {
    signal?.addEventListener(
      "abort",
      () =>
        reject(
          Object.assign(new Error("synthetic abort"), { name: "AbortError" }),
        ),
      { once: true },
    );
    void promise.then(resolve);
  });

const bytesOf = (...parts: (Uint8Array | number[])[]) =>
  Buffer.from(parts.flatMap((part) => [...part]));
const u32 = (value: number) => [
  (value >>> 24) & 0xff,
  (value >>> 16) & 0xff,
  (value >>> 8) & 0xff,
  value & 0xff,
];
const chunk = (type: string, data: number[] = []) => {
  const body = bytesOf(Buffer.from(type, "latin1"), data);
  return bytesOf(u32(data.length), body, u32(crc32(body)));
};
const pngHeader = (width: number, height: number, depth = 8) =>
  bytesOf(
    [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
    chunk("IHDR", [...u32(width), ...u32(height), depth, 6, 0, 0, 0]),
    chunk("IDAT", [1, 2, 3]),
    chunk("IEND"),
  );
const le32 = (value: number) => [
  value & 0xff,
  (value >>> 8) & 0xff,
  (value >>> 16) & 0xff,
  (value >>> 24) & 0xff,
];
const riff = (fourcc: string, data: number[]) =>
  bytesOf(
    Buffer.from(fourcc, "latin1"),
    le32(data.length),
    data,
    data.length % 2 ? [0] : [],
  );
const animatedWebp = () => {
  const body = bytesOf(
    Buffer.from("WEBP", "latin1"),
    riff("VP8X", [0x02, 0, 0, 0, 7, 0, 0, 7, 0, 0]),
    riff("ANIM", [0, 0, 0, 0, 0, 0]),
    riff("VP8 ", [0x10, 0x02, 0, 0x9d, 0x01, 0x2a, 8, 0, 8, 0, 1]),
  );
  return bytesOf(Buffer.from("RIFF", "latin1"), le32(body.length), body);
};
/** A JPEG generated on demand, so a 128 MiB original never sits in memory. */
const virtualJpeg = (
  size: number,
  width: number,
  height: number,
  end = [0xff, 0xd9],
) => {
  const segment = (marker: number, data: number[]) => [
    0xff,
    marker,
    (data.length + 2) >> 8,
    (data.length + 2) & 0xff,
    ...data,
  ];
  const head = Buffer.from([
    0xff,
    0xd8,
    ...segment(0xdb, new Array(65).fill(1)),
    ...segment(0xc0, [
      8,
      height >> 8,
      height & 0xff,
      width >> 8,
      width & 0xff,
      3,
      1,
      0x11,
      0,
      2,
      0x11,
      0,
      3,
      0x11,
      0,
    ]),
    ...segment(0xc4, new Array(20).fill(0)),
    ...segment(0xda, [3, 1, 0, 2, 0, 3, 0, 0, 63, 0]),
  ]);
  const tail = Buffer.from(end);
  const fill = size - tail.length;
  const read = (start: number, last: number) => {
    const out = Buffer.allocUnsafe(last - start + 1);
    for (let index = 0; index < out.length; index++) {
      const at = start + index;
      out[index] =
        at < head.length
          ? head[at]!
          : at >= fill
            ? tail[at - fill]!
            : (at * 31 + 7) % 251;
    }
    return out;
  };
  const sha = createHash("sha256");
  const digest = createHash("md5");
  for (let at = 0; at < size; at += 1024 * 1024) {
    const part = read(at, Math.min(at + 1024 * 1024, size) - 1);
    sha.update(part);
    digest.update(part);
  }
  const md5Hex = digest.digest("hex");
  return {
    sha256: sha.digest("hex"),
    md5Base64: Buffer.from(md5Hex, "hex").toString("base64"),
    object: {
      size,
      read,
      etag: `"${md5Hex}"`,
      crc64: "4242",
      tags: 0,
      contentType: "image/jpeg",
    } satisfies FakeObject,
  };
};

beforeAll(async () => {
  if (process.env.CMS_ENVIRONMENT !== "synthetic")
    throw new Error("SYNTHETIC_CMS_TARGET_REQUIRED");
  parent = await mkdtemp(path.join(tmpdir(), "moya-cms-ingest-"));
  vi.stubEnv("CMS_STORAGE_MODE", "cos");
  vi.stubEnv("CMS_COS_ENDPOINT", "https://cos.admin.example.test");
  vi.stubEnv("CMS_COS_REGION", "synthetic-region");
  vi.stubEnv("CMS_COS_BUCKET", BUCKET);
  vi.stubEnv("CMS_COS_ACCESS_KEY_ID", "synthetic-access-key");
  vi.stubEnv("CMS_COS_SECRET_ACCESS_KEY", "synthetic-secret-key");
  vi.stubEnv("CMS_CATALOG_INGEST", "on");
  vi.stubEnv("CMS_CATALOG_INGEST_UPLOAD_ENDPOINT", `https://${UPLOAD_HOST}`);
  config = await (await import("admin/config")).default;
  payload = await getPayload({ config });
  cos.transactions = () =>
    Object.keys(
      (payload.db as unknown as { sessions?: Record<string, unknown> })
        .sessions ?? {},
    ).length;
  for (const level of [
    "fatal",
    "error",
    "warn",
    "info",
    "debug",
    "trace",
  ] as const)
    vi.spyOn(payload.logger, level).mockImplementation(((
      ...args: unknown[]
    ) => {
      logged.push(args);
    }) as never);
  const password = randomUUID();
  const owner = await payload.create({
    collection: "users",
    overrideAccess: true,
    data: {
      email: `ingest-owner-${suffix}@example.invalid`,
      password,
      role: "owner",
    },
  });
  ownerReq = await createLocalReq(
    { user: { ...owner, collection: "users" } },
    payload,
  );
  const automation = async (label: string, scope: string[]) => {
    const email = `ingest-${label}-${suffix}@example.invalid`;
    await payload.create({
      collection: "users",
      overrideAccess: false,
      req: ownerReq,
      data: { email, password, role: "automation", scopeCatalogIds: scope },
    });
    return email;
  };
  const login = async (email: string) => {
    const response = await handleEndpoints({
      config,
      request: new Request("http://localhost/api/users/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, password }),
      }),
    });
    expect(response.status).toBe(200);
    return ((await response.json()) as { token: string }).token;
  };
  ownerToken = await login(owner.email);
  scopedToken = await login(await automation("scoped", [catalogA]));
  otherToken = await login(await automation("other", [catalogB]));
  unscopedToken = await login(await automation("unscoped", []));
  budgetTokens = [];
  for (const label of ["budget-1", "budget-2", "budget-3", "budget-4"])
    budgetTokens.push(await login(await automation(label, [catalogA])));
  const image = () =>
    sharp({
      create: {
        width: 96,
        height: 64,
        channels: 3,
        background: { r: 200, g: 120, b: 40 },
      },
    });
  jpeg = await image().jpeg().toBuffer();
  png = await image().png().toBuffer();
  webp = await image().webp().toBuffer();
});

beforeEach(() => {
  cos.before = undefined;
  cos.copied = (object) => object;
});

afterAll(async () => {
  await payload?.destroy();
  vi.unstubAllEnvs();
  if (parent) await rm(parent, { recursive: true, force: true });
});

describe("Catalog ingest through real Payload and a synthetic COS", () => {
  it("composes start, complete, abandon and verify, and no dev-only route, with COS storage", () => {
    const paths = config.endpoints
      .filter(({ path }) => path.startsWith("/editorial/media-ingest/"))
      .map(({ path, method }) => `${method} ${path}`)
      .sort();
    expect(paths).toEqual([
      "post /editorial/media-ingest/abandon",
      "post /editorial/media-ingest/complete",
      "post /editorial/media-ingest/start",
      "post /editorial/media-ingest/verify",
    ]);
  });

  it("refuses anonymous callers before reading a body, and out-of-scope automation before storage", async () => {
    const start = config.endpoints.find(
      ({ path }) => path === "/editorial/media-ingest/start",
    )!;
    const anonymous = new Proxy(
      { user: null },
      {
        get(target, key) {
          if (key === "user") return target.user;
          throw new Error("ANONYMOUS_BODY_READ");
        },
      },
    ) as unknown as PayloadRequest;
    expect((await start.handler(anonymous)).status).toBe(403);
    const intent = intentFor("scope", jpeg);
    const mark = cos.requests.length;
    for (const route of ["start", "verify"]) {
      const anonymousReply = await call(
        route,
        route === "verify" ? { mediaId: intent.mediaId } : intent,
        "",
      );
      expect(anonymousReply.status).toBe(403);
    }
    for (const [route, value] of [
      ["start", intent],
      ["complete", { intent }],
      ["abandon", { intent }],
    ] as const) {
      const refused = await call(route, value, otherToken);
      expect(refused.status).toBe(403);
      expect(refused.body.error?.code).toBe("INGEST_FORBIDDEN");
    }
    expect(since(mark)).toEqual([]);
  });

  it("ingests through a signed staging PUT, a verified server-side copy and a fileless registration", async () => {
    const intent = intentFor("happy", jpeg, { width: 96, height: 64 });
    const start = await call("start", intent);
    expect(start.status).toBe(200);
    const result = editorialMediaIngestStartResultSchema.parse(
      start.body.result,
    );
    if (result.state !== "upload") throw new Error("UPLOAD_EXPECTED");
    const url = new URL(result.upload.url);
    expect(url.host).toBe(`${BUCKET}.${UPLOAD_HOST}`);
    expect(url.pathname).toMatch(
      /^\/catalog-ingest\/v1\/[a-f0-9]{2}\/[a-f0-9]{64}$/,
    );
    expect(url.pathname.slice(-64)).toBe(result.ingestId);
    expect(
      Date.parse(result.upload.expiresAt) - Date.now(),
    ).toBeLessThanOrEqual(300_000);
    expect(Date.parse(result.upload.expiresAt)).toBeGreaterThan(Date.now());
    expect(result.upload.headers).toEqual({
      "content-length": String(jpeg.length),
      "content-type": "image/jpeg",
      "x-cos-forbid-overwrite": "true",
      "content-md5": intent.md5Base64,
    });
    // A repeated start re-signs the same staging key.
    const again = await call("start", intent);
    expect(stagingOf(again.body.result)).toBe(url.pathname.slice(1));
    expect(upload(start.body.result, jpeg)).toBe(200);
    expect(upload(start.body.result, jpeg)).toBe(409);
    const staging = url.pathname.slice(1);
    const mark = cos.requests.length;
    expect(cos.transactions()).toBe(0);
    const complete = await call("complete", { intent });
    expect(complete.status).toBe(200);
    const done = editorialMediaIngestCompleteResultSchema.parse(
      complete.body.result,
    );
    expect(done).toMatchObject({
      reused: false,
      validatedBytes: jpeg.length,
      validatedSha256: intent.sha256,
      validatedMd5: intent.md5Base64,
      width: 96,
      height: 64,
      media: {
        mediaId: intent.mediaId,
        catalogId: catalogA,
        objectKey: finalKey(intent),
        sha256: intent.sha256,
        filesize: jpeg.length,
        mimeType: "image/jpeg",
        width: 96,
        height: 64,
        rights: "Synthetic fixture",
        orderConfidence: "HIGH",
      },
    });
    const requests = since(mark);
    expect(
      requests.map(({ kind, key }) => [
        kind,
        key === staging ? "staging" : key === finalKey(intent) ? "final" : key,
      ]),
    ).toEqual([
      ["head", "final"],
      ["head", "staging"],
      ["get", "staging"],
      ["copy", "final"],
      ["head", "final"],
      ["delete", "staging"],
    ]);
    // The read is pinned and ranged; the copy is pinned, never replaces and
    // keeps the signed Content-Type; no Payload transaction spans any of it.
    const read = requests.find(({ kind }) => kind === "get")!;
    expect(read.headers.range).toBe(`bytes=0-${jpeg.length - 1}`);
    expect(read.headers["if-match"]).toBe(`"${md5(jpeg).digest("hex")}"`);
    const copy = requests.find(({ kind }) => kind === "copy")!;
    expect(copy.headers).toMatchObject({
      "x-amz-copy-source": `${BUCKET}/${staging}`,
      "x-amz-copy-source-if-match": `"${md5(jpeg).digest("hex")}"`,
      "x-cos-forbid-overwrite": "true",
      "x-amz-metadata-directive": "COPY",
    });
    expect(copy.headers).not.toHaveProperty("x-amz-tagging-directive");
    expect(requests.every(({ transactions }) => transactions === 0)).toBe(true);
    expect(requests.some(({ kind }) => kind === "put")).toBe(false);
    expect(cos.objects.has(staging)).toBe(false);
    expect(cos.objects.get(finalKey(intent))!.read(0, jpeg.length - 1)).toEqual(
      jpeg,
    );
    const document = (
      await payload.find({
        collection: "media",
        overrideAccess: true,
        where: { mediaId: { equals: intent.mediaId } },
      })
    ).docs;
    expect(document).toHaveLength(1);
    expect(document[0]).toMatchObject({
      origin: "upload",
      prefix: `editorial/${hex(catalogA)}`,
      filename: `${hex(intent.mediaId)}-${intent.sha256}.jpg`,
    });
    // Idempotent: the same projection; nothing is read or copied, and the
    // caller's own staging key (already gone) is removed again.
    const replayMark = cos.requests.length;
    const replay = await call("complete", { intent });
    expect(replay.status).toBe(200);
    expect(replay.body.result).toEqual({
      media: done.media,
      reused: true,
      validatedBytes: jpeg.length,
      validatedSha256: intent.sha256,
      validatedMd5: null,
      width: 96,
      height: 64,
    });
    expect(
      since(replayMark).map(({ kind, key }) => [
        kind,
        key === staging ? "staging" : key,
      ]),
    ).toEqual([["delete", "staging"]]);
    const registered = await call("start", intent);
    expect(registered.body.result).toEqual({
      state: "registered",
      media: done.media,
    });
    // The scoped automation actor reads the same record; the actor scoped
    // to another catalog learns only that the mediaId exists.
    expect(
      (await call("complete", { intent }, scopedToken)).body.result,
    ).toMatchObject({
      reused: true,
      media: { id: done.media.id },
    });
    const other = await call(
      "start",
      { ...intent, catalogId: catalogB },
      otherToken,
    );
    expect(other.status).toBe(409);
    expect(other.body).toEqual({
      ok: false,
      error: { code: "MEDIA_IDENTITY_EXISTS", fields: [] },
    });
    const verified = await call("verify", { mediaId: intent.mediaId });
    expect(
      editorialMediaIngestVerifyResultSchema.parse(verified.body.result),
    ).toEqual({
      media: done.media,
      intact: true,
      validatedBytes: jpeg.length,
      validatedSha256: intent.sha256,
    });
    expect(
      (await call("verify", { mediaId: intent.mediaId }, otherToken)).status,
    ).toBe(404);
    // An automation actor with no Catalog scope reads no media: 403, as the
    // other routes answer it, and no error is logged.
    const before = logged.length;
    const unscoped = await call(
      "verify",
      { mediaId: intent.mediaId },
      unscopedToken,
    );
    expect(unscoped.status).toBe(403);
    expect(unscoped.body.error?.code).toBe("INGEST_FORBIDDEN");
    expect(logged.slice(before)).toEqual([]);
  });

  it("ingests a 128 MiB 9504 x 6336 original within the deadline while Admin memory stays flat", async () => {
    v8.setFlagsFromString("--expose-gc");
    const gc = vm.runInNewContext("gc") as () => void;
    const large = virtualJpeg(CATALOG_ORIGINAL_MAX_BYTES, 9504, 6336);
    const intent = intentFor("large", Buffer.alloc(0), {
      sha256: large.sha256,
      md5Base64: large.md5Base64,
      bytes: large.object.size,
    });
    let reads = 0;
    let peak = 0;
    const start = await call("start", intent);
    expect(upload(start.body.result, large.object)).toBe(200);
    // Two control requests carry the whole exchange with the Admin.
    expect(
      Buffer.byteLength(JSON.stringify(intent)) +
        Buffer.byteLength(JSON.stringify({ intent })) +
        Buffer.byteLength(JSON.stringify(start.body)),
    ).toBeLessThan(16 * 1024);
    gc();
    const baseline = process.memoryUsage().rss;
    cos.before = (request) => {
      if (request.kind !== "get") return;
      if (++reads % 4 === 0) gc();
      peak = Math.max(peak, process.memoryUsage().rss);
    };
    const began = Date.now();
    const complete = await call("complete", { intent });
    const elapsed = Date.now() - began;
    expect(complete.status).toBe(200);
    expect(complete.body.result).toMatchObject({
      reused: false,
      validatedBytes: CATALOG_ORIGINAL_MAX_BYTES,
      validatedSha256: large.sha256,
      width: 9504,
      height: 6336,
      media: {
        objectKey: finalKey(intent),
        filesize: CATALOG_ORIGINAL_MAX_BYTES,
      },
    });
    expect(reads).toBe(128);
    expect(elapsed).toBeLessThan(45_000);
    expect(peak - baseline).toBeLessThan(32 * 1024 * 1024);
  }, 120_000);

  it("creates one record and one final object for concurrent completes of one intent", async () => {
    const intent = intentFor("concurrent", jpeg);
    await started(intent, jpeg);
    const mark = cos.requests.length;
    const [first, second] = await Promise.all([
      call("complete", { intent }),
      call("complete", { intent }),
    ]);
    expect([first.status, second.status]).toEqual([200, 200]);
    expect(
      [first.body.result!.reused, second.body.result!.reused].sort(),
    ).toEqual([false, true]);
    expect(first.body.result!.media).toEqual(second.body.result!.media);
    expect(since(mark).filter(({ kind }) => kind === "copy")).toHaveLength(1);
    expect(await mediaCount(intent.mediaId)).toBe(1);
    expect(editorialKeysFor(intent.mediaId)).toEqual([finalKey(intent)]);
  });

  it("leaves no orphan for concurrent completes of one mediaId under two catalogs", async () => {
    const first = intentFor("conflict", jpeg);
    const second = intentFor("conflict", jpeg, {
      catalogId: catalogB,
      transferId: hex(`${suffix}:conflict-b`),
    });
    await started(first, jpeg);
    await started(second, jpeg);
    const mark = cos.requests.length;
    const results = await Promise.all([
      call("complete", { intent: first }),
      call("complete", { intent: second }),
    ]);
    expect(results.map(({ status }) => status).sort()).toEqual([200, 409]);
    expect(results.find(({ status }) => status === 409)!.body.error?.code).toBe(
      "MEDIA_IDENTITY_CONFLICT",
    );
    expect(since(mark).filter(({ kind }) => kind === "copy")).toHaveLength(1);
    expect(await mediaCount(first.mediaId)).toBe(1);
    expect(editorialKeysFor(first.mediaId)).toHaveLength(1);
  });

  it("never lets abandon delete staging between a complete's verification and its copy", async () => {
    const intent = intentFor("race", jpeg);
    const staging = await started(intent, jpeg);
    const gate = hold();
    cos.before = (request) =>
      request.kind === "copy" ? gate.promise : undefined;
    const mark = cos.requests.length;
    const completing = call("complete", { intent });
    await until(() => since(mark).some(({ kind }) => kind === "copy"));
    const abandoning = call("abandon", { intent });
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(since(mark).some(({ kind }) => kind === "delete")).toBe(false);
    gate.release();
    const [complete, abandon] = await Promise.all([completing, abandoning]);
    expect(complete.status).toBe(200);
    expect(abandon.status).toBe(200);
    const kinds = since(mark).map(
      ({ kind, key }) => `${kind}:${key === staging ? "staging" : "final"}`,
    );
    expect(kinds.indexOf("copy:final")).toBeLessThan(
      kinds.indexOf("delete:staging"),
    );
    expect(cos.objects.get(finalKey(intent))!.size).toBe(jpeg.length);
    expect(await mediaCount(intent.mediaId)).toBe(1);
  });

  it("keeps later callers of a mediaId behind its holder after a waiter gives up at its own deadline", async () => {
    const deadlineMs = 2_000;
    const send = via(routes({}, deadlineMs));
    const intent = intentFor("queue", jpeg);
    const staging = await started(intent, jpeg, send);
    // The holder waits inside its registration, past its last deadline
    // check, as a pool or advisory-lock wait would: nothing aborts it.
    const gate = hold();
    let holding = false;
    const create = payload.create.bind(payload);
    const spy = vi.spyOn(payload, "create").mockImplementation((async (
      options: Parameters<Payload["create"]>[0],
    ) => {
      if ((options.data as { mediaId?: string }).mediaId === intent.mediaId) {
        holding = true;
        await gate.promise;
      }
      return create(options);
    }) as never);
    try {
      const holder = send("complete", { intent });
      await until(() => holding);
      // A waiter answers at its own deadline, not when the holder ends.
      const waiter = await Promise.race([
        send("complete", { intent }),
        new Promise<null>((resolve) =>
          setTimeout(() => resolve(null), deadlineMs * 3),
        ),
      ]);
      expect(waiter?.status).toBe(504);
      expect(waiter?.body.error?.code).toBe("INGEST_DEADLINE_EXCEEDED");
      // The next caller still queues behind the holder.
      const mark = cos.requests.length;
      const abandoning = send("abandon", { intent });
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(since(mark)).toEqual([]);
      gate.release();
      const [complete, abandon] = await Promise.all([holder, abandoning]);
      expect(complete.status).toBe(200);
      expect(complete.body.result).toMatchObject({ reused: false });
      expect(abandon.status).toBe(200);
      // The holder's best-effort staging delete (h) falls after its own
      // deadline, so the object was still there and the abandon removed it.
      expect(abandon.body.result!.state).toBe("abandoned");
      expect(since(mark).map(({ kind, key }) => [kind, key])).toEqual([
        ["head", staging],
        ["delete", staging],
      ]);
    } finally {
      gate.release();
      spy.mockRestore();
    }
    expect(cos.objects.has(staging)).toBe(false);
    expect(cos.objects.get(finalKey(intent))!.read(0, jpeg.length - 1)).toEqual(
      jpeg,
    );
    expect(await mediaCount(intent.mediaId)).toBe(1);
  });

  it("deletes staging and writes nothing for a declared SHA-256 or size that differs", async () => {
    const wrongHash = intentFor("hash", jpeg, { sha256: hex("other bytes") });
    const staging = await started(wrongHash, jpeg);
    const refused = await call("complete", { intent: wrongHash });
    expect(refused.status).toBe(422);
    expect(refused.body.error?.code).toBe("INGEST_HASH_MISMATCH");
    expect(cos.objects.has(staging)).toBe(false);
    expect(editorialKeysFor(wrongHash.mediaId)).toEqual([]);
    expect(await mediaCount(wrongHash.mediaId)).toBe(0);
    const sized = intentFor("size", jpeg);
    const start = await call("start", sized);
    const key = stagingOf(start.body.result);
    cos.objects.set(key, stored(jpeg.subarray(0, jpeg.length - 1)));
    const short = await call("complete", { intent: sized });
    expect(short.status).toBe(422);
    expect(short.body.error?.code).toBe("INGEST_SIZE_MISMATCH");
    expect(cos.objects.has(key)).toBe(false);
    expect(editorialKeysFor(sized.mediaId)).toEqual([]);
    // A full read checks the declared MD5 too, not only the SHA-256.
    const wrongMd5 = intentFor("md5", jpeg, {
      md5Base64: md5(Buffer.from("other bytes")).digest("base64"),
    });
    const md5Start = await call("start", wrongMd5);
    const md5Key = stagingOf(md5Start.body.result);
    cos.objects.set(md5Key, stored(jpeg));
    const md5Refused = await call("complete", { intent: wrongMd5 });
    expect(md5Refused.status).toBe(422);
    expect(md5Refused.body.error?.code).toBe("INGEST_HASH_MISMATCH");
    expect(cos.objects.has(md5Key)).toBe(false);
    expect(editorialKeysFor(wrongMd5.mediaId)).toEqual([]);
    expect(await mediaCount(wrongMd5.mediaId)).toBe(0);
    const missing = await call("complete", {
      intent: intentFor("absent", jpeg),
    });
    expect(missing.status).toBe(409);
    expect(missing.body.error?.code).toBe("INGEST_NOT_UPLOADED");
  });

  it.each([
    [
      "animated PNG",
      "image/png",
      () =>
        bytesOf(
          png.subarray(0, 33),
          chunk("acTL", [0, 0, 0, 2, 0, 0, 0, 0]),
          png.subarray(33),
        ),
    ],
    ["animated WebP", "image/webp", animatedWebp],
    ["pixels over the limit", "image/png", () => pngHeader(12_000, 10_001)],
    [
      "decoded size over 512 MiB",
      "image/png",
      () => pngHeader(10_000, 7_000, 16),
    ],
    ["a side over 65,500", "image/png", () => pngHeader(65_501, 1)],
    [
      "a 16-bit RGBA row over 256 KiB",
      "image/png",
      () => pngHeader(32_769, 8, 16),
    ],
    ["a format other than the MIME type", "image/jpeg", () => png],
    [
      "a truncated JPEG (no FFD9)",
      "image/jpeg",
      () => jpeg.subarray(0, jpeg.length - 2),
    ],
    [
      "a JPEG that does not end with FFD9",
      "image/jpeg",
      () => bytesOf(jpeg, [1, 2, 3]),
    ],
    [
      "a PNG without its final IEND",
      "image/png",
      () => png.subarray(0, png.length - 12),
    ],
  ] as const)(
    "refuses %s with 422 and writes nothing under editorial/",
    async (label, mimeType, make) => {
      const bytes = Buffer.from(make());
      const intent = intentFor(
        `content-${label.replace(/[^a-z0-9]+/gi, "-")}`,
        bytes,
        { mimeType },
      );
      const staging = await started(intent, bytes);
      const mark = cos.requests.length;
      const refused = await call("complete", { intent });
      expect(refused.status).toBe(422);
      expect(refused.body.error?.code).toBe("INGEST_CONTENT_INVALID");
      expect(cos.objects.has(staging)).toBe(false);
      expect(since(mark).some(({ kind }) => kind === "copy")).toBe(false);
      expect(editorialKeysFor(intent.mediaId)).toEqual([]);
      expect(await mediaCount(intent.mediaId)).toBe(0);
    },
  );

  it("re-verifies a final object left by a crash between copy and create, and never registers a corrupt one", async () => {
    const intent = intentFor("crash", png, { mimeType: "image/png" });
    const staging = await started(intent, png);
    cos.objects.set(
      finalKey(intent),
      stored(png, { contentType: "image/png" }),
    );
    const mark = cos.requests.length;
    const recovered = await call("complete", { intent });
    expect(recovered.status).toBe(200);
    expect(recovered.body.result).toMatchObject({
      reused: false,
      width: 96,
      height: 64,
    });
    expect(since(mark).some(({ kind }) => kind === "copy")).toBe(false);
    expect(
      since(mark).filter(
        ({ kind, key }) => kind === "get" && key === finalKey(intent),
      ),
    ).not.toHaveLength(0);
    expect(cos.objects.has(staging)).toBe(false);

    const corrupt = intentFor("corrupt-final", png, { mimeType: "image/png" });
    await started(corrupt, png);
    const altered = Buffer.from(png);
    altered[40] = altered[40]! ^ 0xff;
    cos.objects.set(
      finalKey(corrupt),
      stored(altered, { contentType: "image/png" }),
    );
    const before = logged.length;
    const invalid = await call("complete", { intent: corrupt });
    expect(invalid.status).toBe(500);
    expect(invalid.body.error?.code).toBe("INGEST_FINAL_INVALID");
    expect(await mediaCount(corrupt.mediaId)).toBe(0);
    expect(logged.slice(before)).toEqual([
      [{ category: "EDITORIAL_MEDIA_INGEST_FINAL_INVALID" }],
    ]);
  });

  it("goes back to the final object when the copy finds it taken (forbid-overwrite 409)", async () => {
    const intent = intentFor("copy-409", webp, { mimeType: "image/webp" });
    await started(intent, webp);
    cos.before = (request) => {
      if (request.kind === "copy")
        cos.objects.set(
          finalKey(intent),
          stored(webp, { contentType: "image/webp" }),
        );
    };
    const mark = cos.requests.length;
    const complete = await call("complete", { intent });
    expect(complete.status).toBe(200);
    expect(complete.body.result).toMatchObject({
      reused: false,
      width: 96,
      height: 64,
    });
    expect(
      since(mark)
        .filter(({ kind }) => kind === "copy")
        .map(({ status }) => status),
    ).toEqual([409]);
    expect(await mediaCount(intent.mediaId)).toBe(1);
  });

  it("re-checks the record under the lock after the copy and reports only a real orphan", async () => {
    // Another path registers the mediaId while this complete copies.
    const racing = async (intent: Intent, register: () => Promise<unknown>) => {
      await started(intent, jpeg);
      const gate = hold();
      cos.before = (request) =>
        request.kind === "copy" ? gate.promise : undefined;
      const mark = cos.requests.length;
      const completing = call("complete", { intent });
      await until(() => since(mark).some(({ kind }) => kind === "copy"));
      const registration = await register();
      const before = logged.length;
      gate.release();
      const result = await completing;
      return {
        registration,
        result,
        copies: since(mark).filter(({ kind }) => kind === "copy"),
        logs: logged.slice(before),
      };
    };
    // The native create with a file writes the same content-addressed key.
    const nativeCreate = async (intent: Intent, alt = intent.alt) => {
      const req = await createLocalReq({ user: ownerReq.user! }, payload);
      return payload.create({
        collection: "media",
        overrideAccess: false,
        req,
        user: req.user,
        depth: 0,
        data: {
          catalogId: intent.catalogId,
          mediaId: intent.mediaId,
          alt,
          rights: intent.rights,
          orderConfidence: intent.orderConfidence,
        } as never,
        file: {
          data: jpeg,
          mimetype: "image/jpeg",
          name: "synthetic.jpg",
          size: jpeg.length,
        } as never,
      });
    };

    // The same intent: the winner's record, reused.
    const same = intentFor("recheck-same", jpeg);
    const reused = await racing(same, () => nativeCreate(same));
    expect(reused.result.status).toBe(200);
    expect(reused.result.body.result).toMatchObject({
      reused: true,
      media: {
        id: (reused.registration as { id: unknown }).id,
        objectKey: finalKey(same),
        sha256: same.sha256,
      },
    });
    expect(reused.copies.map(({ status }) => status)).toEqual([409]);
    expect(reused.logs).toEqual([]);
    expect(await mediaCount(same.mediaId)).toBe(1);

    // The same object under other facts: refused, and the final key is the
    // winner's own record, so nothing is orphaned.
    const altered = intentFor("recheck-alt", jpeg);
    const conflict = await racing(altered, () =>
      nativeCreate(altered, "Another synthetic alt"),
    );
    expect(conflict.result.status).toBe(409);
    expect(conflict.result.body.error?.code).toBe("MEDIA_IDENTITY_CONFLICT");
    expect(conflict.logs).toEqual([]);
    expect(await mediaCount(altered.mediaId)).toBe(1);

    // The Owner registers another object under the mediaId: the copied
    // original is held by no record and is reported once.
    const other = intentFor("recheck-other", jpeg);
    const orphaned = await racing(other, async () => {
      const response = await handleEndpoints({
        config,
        request: new Request("http://localhost/api/media", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            Authorization: `JWT ${ownerToken}`,
          },
          body: JSON.stringify({
            catalogId: catalogA,
            mediaId: other.mediaId,
            origin: "existing",
            objectKey: `display/v1/synthetic-${suffix}/${hex(other.mediaId)}.webp`,
            sha256: hex(`recheck-other-${suffix}`),
            mimeType: "image/webp",
            filesize: 1024,
            width: 3,
            height: 2,
            alt: "Synthetic registered original",
          }),
        }),
      });
      expect(response.status).toBe(201);
    });
    expect(orphaned.result.status).toBe(409);
    expect(orphaned.result.body.error?.code).toBe("MEDIA_IDENTITY_CONFLICT");
    expect(orphaned.copies.map(({ status }) => status)).toEqual([200]);
    expect(orphaned.logs).toEqual([
      [{ category: "EDITORIAL_MEDIA_INGEST_ORPHAN" }],
    ]);
    expect(editorialKeysFor(other.mediaId)).toEqual([finalKey(other)]);
    expect(await mediaCount(other.mediaId)).toBe(1);
  });

  it("re-hashes the final object once when neither ETag nor CRC64 matches staging", async () => {
    const matching = intentFor("crc-equal", jpeg);
    await started(matching, jpeg);
    cos.copied = (object) => ({ ...object, etag: '"copied-etag"' });
    let mark = cos.requests.length;
    expect((await call("complete", { intent: matching })).status).toBe(200);
    expect(
      since(mark).some(
        ({ kind, key }) => kind === "get" && key === finalKey(matching),
      ),
    ).toBe(false);

    const rehash = intentFor("rehash", jpeg);
    await started(rehash, jpeg);
    cos.copied = (object) => ({
      ...object,
      etag: '"copied-etag"',
      crc64: null,
    });
    mark = cos.requests.length;
    expect((await call("complete", { intent: rehash })).status).toBe(200);
    expect(
      since(mark).some(
        ({ kind, key }) => kind === "get" && key === finalKey(rehash),
      ),
    ).toBe(true);

    const damaged = intentFor("damaged-copy", jpeg);
    await started(damaged, jpeg);
    const altered = Buffer.from(jpeg);
    altered[100] = altered[100]! ^ 0xff;
    cos.copied = () => stored(altered, { crc64: null });
    const refused = await call("complete", { intent: damaged });
    expect(refused.status).toBe(500);
    expect(refused.body.error?.code).toBe("INGEST_FINAL_INVALID");
    expect(await mediaCount(damaged.mediaId)).toBe(0);
  });

  it("answers within the server deadline, registers nothing, and a retry completes", async () => {
    const send = via(routes({}, 400));
    const intent = intentFor("deadline", jpeg);
    await started(intent, jpeg, send);
    cos.before = (request, signal) =>
      request.kind === "get"
        ? abortable(new Promise(() => {}), signal)
        : undefined;
    const began = Date.now();
    const late = await send("complete", { intent });
    expect(Date.now() - began).toBeLessThan(5_000);
    expect(late.status).toBe(504);
    expect(late.body.error?.code).toBe("INGEST_DEADLINE_EXCEEDED");
    expect(await mediaCount(intent.mediaId)).toBe(0);
    expect(editorialKeysFor(intent.mediaId)).toEqual([]);
    cos.before = undefined;
    expect((await send("complete", { intent })).status).toBe(200);
  });

  it("opens no registration transaction when the deadline passes with the last storage answer", async () => {
    const deadlineMs = 1_000;
    const send = via(routes({}, deadlineMs));
    const intent = intentFor("deadline-after-copy", jpeg);
    await started(intent, jpeg, send);
    // COS answers the final object's HEAD after the copy just as the
    // deadline passes: the answer arrives, so no storage call fails.
    let passed = false;
    cos.copied = (object) => ({
      ...object,
      headers: {
        get "x-cos-request-id"() {
          if (!passed) {
            passed = true;
            vi.advanceTimersByTime(deadlineMs);
          }
          return "synthetic-request";
        },
      },
    });
    const begin = vi.spyOn(payload.db, "beginTransaction");
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    let late: Reply;
    let transactions: number;
    try {
      late = await send("complete", { intent });
    } finally {
      vi.useRealTimers();
      // mockRestore also clears the recorded calls.
      transactions = begin.mock.calls.length;
      begin.mockRestore();
    }
    expect(passed).toBe(true);
    expect(late.status).toBe(504);
    expect(late.body.error?.code).toBe("INGEST_DEADLINE_EXCEEDED");
    // Only (a)'s short transaction ran; (g) never took the media lock.
    expect(transactions).toBe(1);
    expect(await mediaCount(intent.mediaId)).toBe(0);
    expect(editorialKeysFor(intent.mediaId)).toEqual([finalKey(intent)]);
    // A retry re-verifies the final object and registers it.
    const retry = await send("complete", { intent });
    expect(retry.status).toBe(200);
    expect(retry.body.result).toMatchObject({ reused: false });
    expect(await mediaCount(intent.mediaId)).toBe(1);
  });

  it("registers nothing when the deadline passes while (g) waits for the record lookup", async () => {
    const deadlineMs = 1_500;
    const send = via(routes({}, deadlineMs));
    const intent = intentFor("deadline-in-lookup", jpeg);
    await started(intent, jpeg, send);
    // After the copy, the first lookup under (g)'s lock waits past the
    // deadline, as a pool or lock wait would; nothing aborts it.
    let copied = false;
    let waited = false;
    cos.before = (request) => {
      if (request.kind === "copy") copied = true;
    };
    const find = payload.find.bind(payload);
    const spy = vi.spyOn(payload, "find").mockImplementation((async (
      options: Parameters<Payload["find"]>[0],
    ) => {
      const where = options.where as
        { mediaId?: { equals?: string } } | undefined;
      if (copied && !waited && where?.mediaId?.equals === intent.mediaId) {
        waited = true;
        await new Promise((resolve) => setTimeout(resolve, deadlineMs + 300));
      }
      return find(options);
    }) as never);
    let late: Reply;
    try {
      late = await send("complete", { intent });
    } finally {
      spy.mockRestore();
    }
    expect(waited).toBe(true);
    expect(late.status).toBe(504);
    expect(late.body.error?.code).toBe("INGEST_DEADLINE_EXCEEDED");
    expect(await mediaCount(intent.mediaId)).toBe(0);
    expect(editorialKeysFor(intent.mediaId)).toEqual([finalKey(intent)]);
    cos.before = undefined;
    const retry = await send("complete", { intent });
    expect(retry.status).toBe(200);
    expect(await mediaCount(intent.mediaId)).toBe(1);
  });

  it("admits two running and eight waiting completes, and refuses the next with 429", async () => {
    const send = via(routes({}, 20_000));
    const intents = Array.from({ length: 11 }, (_, index) =>
      intentFor(`busy-${index}`, jpeg),
    );
    for (const intent of intents) await started(intent, jpeg, send);
    const gate = hold();
    cos.before = (request) =>
      request.kind === "get" ? gate.promise : undefined;
    const mark = cos.requests.length;
    const pending = intents
      .slice(0, 10)
      .map((intent) => send("complete", { intent }));
    await until(
      () => since(mark).filter(({ kind }) => kind === "get").length === 2,
    );
    // Let the other eight reach the gate behind the two running.
    await new Promise((resolve) => setTimeout(resolve, 300));
    const busy = await send("complete", { intent: intents[10] });
    expect(busy.status).toBe(429);
    expect(busy.body.error?.code).toBe("INGEST_BUSY");
    gate.release();
    expect((await Promise.all(pending)).map(({ status }) => status)).toEqual(
      new Array(10).fill(200),
    );
    expect((await send("complete", { intent: intents[10] })).status).toBe(200);
  });

  it("abandons only the caller's own derived staging key, idempotently", async () => {
    const intent = intentFor("abandon", jpeg);
    const own = await started(intent, jpeg);
    const theirs = await started(intent, jpeg, call, scopedToken);
    expect(own).not.toBe(theirs);
    const abandoned = await call("abandon", { intent });
    expect(abandoned.status).toBe(200);
    expect(abandoned.body.result).toEqual({
      ingestId: own.slice(-64),
      state: "abandoned",
    });
    expect(cos.objects.has(own)).toBe(false);
    expect(cos.objects.has(theirs)).toBe(true);
    // Again, or as an actor whose own key holds nothing while another
    // actor's does: answered, and said to have removed nothing.
    const again = await call("abandon", { intent });
    expect(again.status).toBe(200);
    expect(again.body.result).toEqual({
      ingestId: own.slice(-64),
      state: "absent",
    });
    expect(cos.objects.has(theirs)).toBe(true);
    expect((await call("complete", { intent }, scopedToken)).status).toBe(200);
  });

  it("removes the caller's own staging object when complete reuses another path's record, and still answers reused", async () => {
    // Two actors staged the same original; the first one registers it.
    const intent = intentFor("reuse-staging", jpeg);
    const own = await started(intent, jpeg);
    const theirs = await started(intent, jpeg, call, scopedToken);
    const first = await call("complete", { intent });
    expect(first.status).toBe(200);
    expect(cos.objects.has(own)).toBe(false);
    expect(cos.objects.has(theirs)).toBe(true);
    const before = logged.length;
    const mark = cos.requests.length;
    const reused = await call("complete", { intent }, scopedToken);
    expect(reused.status).toBe(200);
    expect(reused.body.result).toEqual({
      media: first.body.result!.media,
      reused: true,
      validatedBytes: jpeg.length,
      validatedSha256: intent.sha256,
      validatedMd5: null,
      width: 96,
      height: 64,
    });
    // Only the caller's own key is removed: nothing is read or copied, and
    // no Payload transaction spans the request.
    expect(
      since(mark).map(({ kind, key, transactions }) => [
        kind,
        key === theirs ? "theirs" : key,
        transactions,
      ]),
    ).toEqual([["delete", "theirs", 0]]);
    expect(cos.objects.has(theirs)).toBe(false);
    expect(logged.slice(before)).toEqual([]);
    expect(editorialKeysFor(intent.mediaId)).toEqual([finalKey(intent)]);
    expect(await mediaCount(intent.mediaId)).toBe(1);

    // A delete that fails, as after a registration, is logged and the reuse
    // still answered: abandon and the staging lifecycle are the backstops.
    const failing = intentFor("reuse-staging-failure", jpeg);
    await started(failing, jpeg);
    const kept = await started(failing, jpeg, call, scopedToken);
    expect((await call("complete", { intent: failing })).status).toBe(200);
    cos.before = (request) => {
      if (request.kind === "delete")
        throw new Error("synthetic delete failure");
    };
    const failureMark = logged.length;
    const answered = await call("complete", { intent: failing }, scopedToken);
    expect(answered.status).toBe(200);
    expect(answered.body.result).toMatchObject({ reused: true });
    expect(cos.objects.has(kept)).toBe(true);
    expect(logged.slice(failureMark)).toEqual([
      [{ category: "EDITORIAL_MEDIA_INGEST_STAGING_DELETE_FAILED" }],
    ]);
    cos.before = undefined;
    expect(
      (await call("abandon", { intent: failing }, scopedToken)).body.result,
    ).toMatchObject({ state: "abandoned" });
    expect(cos.objects.has(kept)).toBe(false);
  });

  it("bounds outstanding ingests per actor and declared bytes per hour", async () => {
    const send = via(routes());
    const small = (index: number) =>
      intentFor(`outstanding-${index}`, jpeg, {
        transferId: hex(`${suffix}:o:${index}`),
      });
    for (let index = 0; index < 32; index++)
      expect((await send("start", small(index), budgetTokens[0])).status).toBe(
        200,
      );
    const over = await send("start", small(32), budgetTokens[0]);
    expect(over.status).toBe(429);
    expect(over.body.error?.code).toBe("INGEST_QUOTA_EXCEEDED");
    // A repeated start re-signs an outstanding ingest; abandon settles one.
    expect((await send("start", small(0), budgetTokens[0])).status).toBe(200);
    expect(
      (await send("abandon", { intent: small(0) }, budgetTokens[0])).status,
    ).toBe(200);
    expect((await send("start", small(32), budgetTokens[0])).status).toBe(200);

    const bytes = virtualJpeg(4096, 8, 8);
    const large = (actor: number, index: number) => ({
      ...intentFor(`bytes-${actor}-${index}`, Buffer.alloc(0)),
      sha256: hex(`${actor}:${index}`),
      md5Base64: bytes.md5Base64,
      bytes: CATALOG_ORIGINAL_MAX_BYTES,
    });
    const hourly = via(routes());
    for (let index = 0; index < 32; index++)
      expect(
        (await hourly("start", large(1, index), budgetTokens[1])).status,
      ).toBe(200);
    // A repeated start re-signs an outstanding ingest: one object, one charge.
    expect((await hourly("start", large(1, 0), budgetTokens[1])).status).toBe(
      200,
    );
    for (let index = 1; index < 32; index++)
      expect(
        (await hourly("abandon", { intent: large(1, index) }, budgetTokens[1]))
          .status,
      ).toBe(200);
    // 4 GiB declared this hour: the next one is refused, and so is a new PUT
    // of an abandoned one (its staging object is gone), while the re-sign
    // of the outstanding one is not.
    expect((await hourly("start", large(1, 32), budgetTokens[1])).status).toBe(
      429,
    );
    const again = await hourly("start", large(1, 1), budgetTokens[1]);
    expect(again.status).toBe(429);
    expect(again.body.error?.code).toBe("INGEST_QUOTA_EXCEEDED");
    expect((await hourly("start", large(1, 0), budgetTokens[1])).status).toBe(
      200,
    );
    for (const actor of [2, 3])
      for (let index = 0; index < 32; index++)
        expect(
          (await hourly("start", large(actor, index), budgetTokens[actor]))
            .status,
        ).toBe(200);
    // 12 GiB in total this hour.
    const global = await hourly("start", large(4, 0), budgetTokens[0]);
    expect(global.status).toBe(429);
    expect(global.body.error?.code).toBe("INGEST_QUOTA_EXCEEDED");
  });

  it("frees an outstanding slot on every complete and on a content refusal", async () => {
    const send = via(routes());
    const item = (index: number, overrides: Partial<Intent> = {}) =>
      intentFor(`settle-${index}`, jpeg, overrides);
    // A paced batch completes far more than 32 ingests an hour.
    for (let index = 0; index < 32; index++) {
      await started(item(index), jpeg, send);
      expect((await send("complete", { intent: item(index) })).status).toBe(
        200,
      );
    }
    await started(item(32), jpeg, send);
    const refused = item(33, { sha256: hex("other bytes") });
    await started(refused, jpeg, send);
    for (let index = 34; index < 64; index++)
      expect((await send("start", item(index))).status).toBe(200);
    expect((await send("start", item(64))).status).toBe(429);
    const mismatch = await send("complete", { intent: refused });
    expect(mismatch.status).toBe(422);
    expect(mismatch.body.error?.code).toBe("INGEST_HASH_MISMATCH");
    expect((await send("start", item(64))).status).toBe(200);
  });

  it("checks the MD5 ETag, the header and the tail only when the server SHA-256 is off (D9)", async () => {
    const send = via(routes({ CMS_CATALOG_INGEST_SERVER_SHA256: "off" }));
    const original = virtualJpeg(5 * 1024 * 1024, 4000, 3000);
    const intent = intentFor("etag-only", Buffer.alloc(0), {
      sha256: original.sha256,
      md5Base64: original.md5Base64,
      bytes: original.object.size,
    });
    await started(intent, original.object, send);
    const mark = cos.requests.length;
    const complete = await send("complete", { intent });
    expect(complete.status).toBe(200);
    expect(complete.body.result).toMatchObject({
      reused: false,
      width: 4000,
      height: 3000,
      validatedSha256: original.sha256,
      validatedMd5: original.md5Base64,
    });
    const reads = since(mark).filter(
      ({ kind, key }) => kind === "get" && key !== finalKey(intent),
    );
    expect(reads.map(({ headers }) => headers.range)).toEqual([
      "bytes=0-1048575",
      `bytes=${original.object.size - 16}-${original.object.size - 1}`,
    ]);

    const mismatch = intentFor("etag-mismatch", jpeg);
    const start = await send("start", mismatch);
    cos.objects.set(
      stagingOf(start.body.result),
      stored(jpeg, { etag: '"0123456789abcdef0123456789abcdef"' }),
    );
    const refused = await send("complete", { intent: mismatch });
    expect(refused.status).toBe(422);
    expect(refused.body.error?.code).toBe("INGEST_HASH_MISMATCH");
    expect(cos.objects.has(stagingOf(start.body.result))).toBe(false);

    const truncated = virtualJpeg(3 * 1024 * 1024, 4000, 3000, [0x12, 0x34]);
    const cut = intentFor("etag-truncated", Buffer.alloc(0), {
      sha256: truncated.sha256,
      md5Base64: truncated.md5Base64,
      bytes: truncated.object.size,
    });
    await started(cut, truncated.object, send);
    const incomplete = await send("complete", { intent: cut });
    expect(incomplete.status).toBe(422);
    expect(incomplete.body.error?.code).toBe("INGEST_CONTENT_INVALID");
    expect(editorialKeysFor(cut.mediaId)).toEqual([]);

    const verify = await send("verify", { mediaId: intent.mediaId });
    expect(verify.status).toBe(409);
    expect(verify.body.error?.code).toBe("INGEST_SERVER_HASH_DISABLED");
  });

  it("refuses a header over the bounds from its prefix alone when the server SHA-256 is off (D9)", async () => {
    const send = via(routes({ CMS_CATALOG_INGEST_SERVER_SHA256: "off" }));
    // A side over 65,500 px, in the first range read; the tail is complete.
    const wide = virtualJpeg(3 * 1024 * 1024, 65_501, 1_000);
    const intent = intentFor("etag-bounds", Buffer.alloc(0), {
      sha256: wide.sha256,
      md5Base64: wide.md5Base64,
      bytes: wide.object.size,
    });
    const staging = await started(intent, wide.object, send);
    const mark = cos.requests.length;
    const refused = await send("complete", { intent });
    expect(refused.status).toBe(422);
    expect(refused.body.error?.code).toBe("INGEST_CONTENT_INVALID");
    expect(cos.objects.has(staging)).toBe(false);
    expect(
      since(mark)
        .filter(({ kind }) => kind === "get")
        .map(({ headers }) => headers.range),
    ).toEqual(["bytes=0-1048575"]);
    expect(since(mark).some(({ kind }) => kind === "copy")).toBe(false);
    expect(editorialKeysFor(intent.mediaId)).toEqual([]);
    expect(await mediaCount(intent.mediaId)).toBe(0);
  });

  it("tags staging and strips the tag on copy under the tag lifecycle (L1)", async () => {
    const send = via(routes({ CMS_CATALOG_INGEST_STAGING_TAG: "on" }));
    const intent = intentFor("tagged", jpeg);
    const start = await send("start", intent);
    expect(start.body.result!.upload!.headers["x-cos-tagging"]).toBe(
      CATALOG_INGEST_STAGING_TAGGING,
    );
    expect(
      new URL(start.body.result!.upload!.url).searchParams.get(
        "X-Amz-SignedHeaders",
      ),
    ).toBe(
      "content-length;content-md5;content-type;host;x-cos-forbid-overwrite;x-cos-tagging",
    );
    expect(upload(start.body.result, jpeg)).toBe(200);
    expect(cos.objects.get(stagingOf(start.body.result))!.tags).toBe(1);
    const mark = cos.requests.length;
    expect((await send("complete", { intent })).status).toBe(200);
    expect(
      since(mark).find(({ kind }) => kind === "copy")!.headers[
        "x-amz-tagging-directive"
      ],
    ).toBe("REPLACE");
    expect(cos.objects.get(finalKey(intent))!.tags).toBe(0);

    // A final object that kept the staging tag would expire: never registered.
    const kept = intentFor("tag-kept", jpeg);
    await started(kept, jpeg, send);
    cos.copied = (object) => ({ ...object, tags: 1 });
    const refused = await send("complete", { intent: kept });
    expect(refused.status).toBe(500);
    expect(refused.body.error?.code).toBe("INGEST_FINAL_INVALID");
    // A retry finds that tagged final object and refuses it unread.
    const retryMark = cos.requests.length;
    const retried = await send("complete", { intent: kept });
    expect(retried.status).toBe(500);
    expect(retried.body.error?.code).toBe("INGEST_FINAL_INVALID");
    expect(
      since(retryMark).map(({ kind, key }) => [
        kind,
        key === finalKey(kept) ? "final" : key,
      ]),
    ).toEqual([["head", "final"]]);
    expect(await mediaCount(kept.mediaId)).toBe(0);

    // Storage that shows no tag on staging would make the final tag check
    // vacuous: refused as a configuration fault before any read or copy.
    cos.copied = (object) => object;
    const unreported = intentFor("tag-unreported", jpeg);
    const staging = await started(unreported, jpeg, send);
    cos.objects.set(staging, { ...cos.objects.get(staging)!, tags: 0 });
    const tagMark = cos.requests.length;
    const before = logged.length;
    const unconfigured = await send("complete", { intent: unreported });
    expect(unconfigured.status).toBe(503);
    expect(unconfigured.body.error?.code).toBe("INGEST_CONFIGURATION_INVALID");
    expect(since(tagMark).map(({ kind }) => kind)).toEqual(["head", "head"]);
    expect(logged.slice(before)).toEqual([
      [{ category: "EDITORIAL_MEDIA_INGEST_CONFIGURATION_INVALID" }],
    ]);
    expect(cos.objects.has(staging)).toBe(true);
    expect(editorialKeysFor(unreported.mediaId)).toEqual([]);
    expect(await mediaCount(unreported.mediaId)).toBe(0);
  });

  it("refuses, before any copy, staging that holds what a signed PUT never stores", async () => {
    const send = via(routes());
    const cases: [string, Partial<FakeObject>][] = [
      ["an unsigned tag (L2)", { tags: 1 }],
      ["a Content-Encoding", { headers: { "content-encoding": "gzip" } }],
      ["a Content-Disposition", { headers: { "content-disposition": "x" } }],
      ["a Cache-Control", { headers: { "cache-control": "public" } }],
      ["user metadata", { headers: { "x-cos-meta-probe": "1" } }],
      ["a storage class", { headers: { "x-cos-storage-class": "ARCHIVE" } }],
      [
        "KMS encryption",
        { headers: { "x-cos-server-side-encryption": "cos/kms" } },
      ],
      [
        "a customer key",
        {
          headers: {
            "x-amz-server-side-encryption-customer-algorithm": "AES256",
          },
        },
      ],
      ["another Content-Type", { contentType: "application/octet-stream" }],
    ];
    for (const [index, [label, change]] of cases.entries()) {
      const intent = intentFor(`staging-extra-${index}`, jpeg);
      const staging = await started(intent, jpeg, send);
      cos.objects.set(staging, { ...cos.objects.get(staging)!, ...change });
      const mark = cos.requests.length;
      const refused = await send("complete", { intent });
      expect(refused.status, label).toBe(422);
      expect(refused.body.error?.code, label).toBe("INGEST_STAGING_INVALID");
      // HEAD final, HEAD staging, then only the staging delete: no read,
      // no copy, nothing under editorial/.
      expect(
        since(mark).map(({ kind }) => kind),
        label,
      ).toEqual(["head", "head", "delete"]);
      expect(cos.objects.has(staging), label).toBe(false);
      expect(editorialKeysFor(intent.mediaId), label).toEqual([]);
      expect(await mediaCount(intent.mediaId), label).toBe(0);
    }
    // What a bucket default may add (SSE-COS, the standard class) passes.
    const plain = intentFor("staging-bucket-default", jpeg);
    const staging = await started(plain, jpeg, send);
    cos.objects.set(staging, {
      ...cos.objects.get(staging)!,
      headers: {
        "x-cos-server-side-encryption": "AES256",
        "x-cos-storage-class": "STANDARD",
      },
    });
    expect((await send("complete", { intent: plain })).status).toBe(200);

    // A final object (an earlier copy) holding them is refused unread, and so
    // is a copy that added one.
    const left = intentFor("final-extra", jpeg);
    cos.objects.set(finalKey(left), {
      ...stored(jpeg),
      headers: { "content-disposition": "attachment" },
    });
    const finalMark = cos.requests.length;
    const leftover = await send("complete", { intent: left });
    expect(leftover.status).toBe(500);
    expect(leftover.body.error?.code).toBe("INGEST_FINAL_INVALID");
    expect(since(finalMark).map(({ kind }) => kind)).toEqual(["head"]);
    const copiedExtra = intentFor("copy-extra", jpeg);
    await started(copiedExtra, jpeg, send);
    cos.copied = (object) => ({
      ...object,
      headers: { "cache-control": "public" },
    });
    const copied = await send("complete", { intent: copiedExtra });
    expect(copied.status).toBe(500);
    expect(copied.body.error?.code).toBe("INGEST_FINAL_INVALID");
    expect(await mediaCount(copiedExtra.mediaId)).toBe(0);

    // L1: a tag beside the signed one is refused the same way, not taken
    // for a COS that reports no tag count.
    const tagged = via(routes({ CMS_CATALOG_INGEST_STAGING_TAG: "on" }));
    cos.copied = (object) => object;
    const twoTags = intentFor("staging-two-tags", jpeg);
    const twoTagsStaging = await started(twoTags, jpeg, tagged);
    cos.objects.set(twoTagsStaging, {
      ...cos.objects.get(twoTagsStaging)!,
      tags: 2,
    });
    const refusedTags = await tagged("complete", { intent: twoTags });
    expect(refusedTags.status).toBe(422);
    expect(refusedTags.body.error?.code).toBe("INGEST_STAGING_INVALID");
    expect(cos.objects.has(twoTagsStaging)).toBe(false);
  });

  it("charges a new PUT after a refusal, and complete's reads, to the actor's hourly bytes", async () => {
    const original = virtualJpeg(400 * 1024, 640, 480);
    const declared = (label: string, overrides: Partial<Intent> = {}) =>
      intentFor(label, Buffer.alloc(0), {
        sha256: original.sha256,
        md5Base64: original.md5Base64,
        bytes: original.object.size,
        ...overrides,
      });
    // 1 MiB an hour for this route set. A declared SHA-256 that differs:
    // complete reads, refuses (422) and deletes staging; the next start signs
    // a new PUT and is charged again, so the third is over.
    const send = via(routes({}, undefined, 1024 * 1024));
    const wrong = declared("charge-again", { sha256: hex("other bytes") });
    for (let round = 0; round < 2; round++) {
      await started(wrong, original.object, send);
      const refused = await send("complete", { intent: wrong });
      expect(refused.status).toBe(422);
      expect(refused.body.error?.code).toBe("INGEST_HASH_MISMATCH");
    }
    const over = await send("start", wrong);
    expect(over.status).toBe(429);
    expect(over.body.error?.code).toBe("INGEST_QUOTA_EXCEEDED");

    // A final object that does not hash to its key is re-read in full by
    // every complete, with no start: those reads are charged too.
    const reads = via(routes({}, undefined, 1024 * 1024));
    const intent = declared("charge-reads");
    cos.objects.set(finalKey(intent), {
      ...original.object,
      read: (start, end) => {
        const bytes = original.object.read(start, end);
        if (start === 0) bytes[300] = bytes[300]! ^ 1;
        return bytes;
      },
    });
    for (let round = 0; round < 2; round++) {
      const invalid = await reads("complete", { intent });
      expect(invalid.status).toBe(500);
      expect(invalid.body.error?.code).toBe("INGEST_FINAL_INVALID");
    }
    const mark = cos.requests.length;
    const bounded = await reads("complete", { intent });
    expect(bounded.status).toBe(429);
    expect(bounded.body.error?.code).toBe("INGEST_QUOTA_EXCEEDED");
    expect(since(mark).map(({ kind }) => kind)).toEqual(["head"]);
  });

  it("keeps the media hook closed to fileless creates without the exact verified marker", async () => {
    const mediaId = `marker-${suffix}`;
    const sha256 = hex(jpeg);
    const marker: VerifiedIngest = {
      catalogId: catalogA,
      mediaId,
      origin: "upload",
      objectKey: `editorial/${hex(catalogA)}/${hex(mediaId)}-${sha256}.jpg`,
      prefix: `editorial/${hex(catalogA)}`,
      filename: `${hex(mediaId)}-${sha256}.jpg`,
      sha256,
      filesize: jpeg.length,
      mimeType: "image/jpeg",
      width: 96,
      height: 64,
      alt: "Synthetic marker",
    };
    const create = (data: Record<string, unknown>, file?: object) =>
      payload.create({
        collection: "media",
        overrideAccess: false,
        req: ownerReq,
        user: ownerReq.user,
        depth: 0,
        data: data as never,
        ...(file ? { file: file as never } : {}),
      });
    const refusal = (promise: Promise<unknown>) =>
      promise.then(
        () => "CREATED",
        (error: Error) => error.message,
      );
    const mark = cos.requests.length;
    // No marker: unchanged.
    expect(await refusal(create({ ...marker }))).toBe("MEDIA_FILE_INVALID");
    // A marker, but a field differs, is missing, is added or the key is not
    // content-addressed.
    const withoutHeight: Record<string, unknown> = { ...marker };
    delete withoutHeight.height;
    for (const data of [
      { ...marker, width: 97 },
      { ...marker, filesize: jpeg.length + 1 },
      withoutHeight,
      { ...marker, rights: "Added" },
    ])
      expect(
        await refusal(withVerifiedIngest(ownerReq, marker, () => create(data))),
      ).toBe("MEDIA_FILE_INVALID");
    for (const unaddressed of [
      {
        ...marker,
        objectKey: `editorial/${hex(catalogA)}/other.jpg`,
        filename: "other.jpg",
      },
      { ...marker, objectKey: `editorial/${hex(catalogB)}/${marker.filename}` },
      { ...marker, prefix: `editorial/${hex(catalogB)}` },
    ])
      expect(
        await refusal(
          withVerifiedIngest(ownerReq, unaddressed, () => create(unaddressed)),
        ),
      ).toBe("MEDIA_FILE_INVALID");
    // A file present at create is refused: the adapter would write the key.
    expect(
      await refusal(
        withVerifiedIngest(ownerReq, marker, () =>
          create(marker, {
            data: jpeg,
            mimetype: "image/jpeg",
            name: "synthetic.jpg",
            size: jpeg.length,
          }),
        ),
      ),
    ).toBe("MEDIA_FILE_INVALID");
    // So is a file left in the storage context, which the adapter falls back
    // to when req.file is absent.
    const file = {
      data: jpeg,
      mimetype: "image/jpeg",
      name: "synthetic.jpg",
      size: jpeg.length,
    };
    const contextReq = await createLocalReq(
      { user: ownerReq.user!, context: { _payloadCloudStorage: { file } } },
      payload,
    );
    expect(
      await refusal(
        withVerifiedIngest(contextReq, marker, () =>
          payload.create({
            collection: "media",
            overrideAccess: false,
            req: contextReq,
            user: contextReq.user,
            depth: 0,
            data: { ...marker } as never,
          }),
        ),
      ),
    ).toBe("MEDIA_FILE_INVALID");
    expect(since(mark)).toEqual([]);
    expect(await mediaCount(mediaId)).toBe(0);
    // Inside one scope: a nested scope on the same request is refused, and
    // the first create spends the marker even when it is refused, so the
    // exact fields after it find none.
    expect(
      await withVerifiedIngest(ownerReq, marker, async () => [
        await refusal(
          withVerifiedIngest(ownerReq, marker, () => create(marker)),
        ),
        await refusal(create({ ...marker, width: 97 })),
        await refusal(create(marker)),
      ]),
    ).toEqual([
      "MEDIA_INPUT_INVALID",
      "MEDIA_FILE_INVALID",
      "MEDIA_FILE_INVALID",
    ]);
    expect(await mediaCount(mediaId)).toBe(0);
    // The exact marker registers in a scope of its own.
    expect(
      await refusal(withVerifiedIngest(ownerReq, marker, () => create(marker))),
    ).toBe("CREATED");
    // The scope removed it: nothing registers afterwards.
    expect(
      await refusal(create({ ...marker, mediaId: `${mediaId}-again` })),
    ).toBe("MEDIA_FILE_INVALID");
    expect(since(mark).some(({ kind }) => kind === "put")).toBe(false);
    // The ordinary REST create without a file is refused as before.
    const rest = await handleEndpoints({
      config,
      request: new Request("http://localhost/api/media", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          Authorization: `JWT ${ownerToken}`,
        },
        body: JSON.stringify({ ...marker, mediaId: `${mediaId}-rest` }),
      }),
    });
    expect(rest.status).toBe(400);
    expect(await mediaCount(`${mediaId}-rest`)).toBe(0);
  });

  it("leaves the Owner's registration of an existing object unchanged", async () => {
    const existing = {
      catalogId: catalogA,
      origin: "existing",
      objectKey: `display/v1/synthetic-${suffix}/${hex(`existing-${suffix}`)}.webp`,
      sha256: hex(`existing-${suffix}`),
      mimeType: "image/webp",
      filesize: 50 * 1024 * 1024,
      width: 3,
      height: 2,
      alt: "Synthetic registered original",
    };
    const owner = await handleEndpoints({
      config,
      request: new Request("http://localhost/api/media", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          Authorization: `JWT ${ownerToken}`,
        },
        body: JSON.stringify({ ...existing, mediaId: `existing-${suffix}` }),
      }),
    });
    expect(owner.status).toBe(201);
    const automation = await handleEndpoints({
      config,
      request: new Request("http://localhost/api/media", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          Authorization: `JWT ${scopedToken}`,
        },
        body: JSON.stringify({
          ...existing,
          mediaId: `existing-scoped-${suffix}`,
          objectKey: `${existing.objectKey}.2`,
        }),
      }),
    });
    expect(automation.status).toBe(403);
  });

  it("runs the Development store end to end into the directory the worker reads", async () => {
    const media = path.join(parent, "dev-media");
    const staging = path.join(parent, "dev-staging");
    const local = createCatalogIngestEndpoints({
      mediaDirectory: media,
      stagingDirectory: staging,
      environment: {
        ...process.env,
        CMS_STORAGE_MODE: "local",
        CMS_ENVIRONMENT: "synthetic",
        CMS_CATALOG_INGEST_UPLOAD_ENDPOINT: "http://127.0.0.1:3002",
      },
    });
    const devPut = local.find(({ method }) => method === "put")!;
    expect(devPut.path).toBe("/editorial/media-ingest/dev-put/:ingestId");
    const send = via(local);
    const intent = intentFor("development", png, { mimeType: "image/png" });
    const start = await send("start", intent);
    expect(start.status).toBe(200);
    const signed = start.body.result!.upload!;
    const url = new URL(signed.url);
    expect(url.origin).toBe("http://127.0.0.1:3002");
    expect(url.pathname).toBe(
      `/api/editorial/media-ingest/dev-put/${String(start.body.result!.ingestId)}`,
    );
    const put = async () => {
      const req = await createPayloadRequest({
        config,
        request: new Request(url, {
          method: "PUT",
          headers: signed.headers,
          body: new Uint8Array(png),
        }),
        canSetHeaders: true,
      });
      req.routeParams = { ingestId: url.pathname.split("/").at(-1)! };
      return devPut.handler(req);
    };
    const mark = cos.requests.length;
    expect((await put()).status).toBe(200);
    expect((await put()).status).toBe(409);
    const complete = await send("complete", { intent });
    expect(complete.status).toBe(200);
    expect(complete.body.result).toMatchObject({
      reused: false,
      width: 96,
      height: 64,
    });
    expect(since(mark)).toEqual([]);
    const filename = `${hex(intent.mediaId)}-${intent.sha256}.png`;
    expect(await readFile(path.join(media, filename))).toEqual(png);
    expect((await stat(path.join(media, filename))).mode & 0o777).toBe(0o644);
    await expect(
      stat(path.join(staging, String(start.body.result!.ingestId))),
    ).rejects.toMatchObject({ code: "ENOENT" });
    const target = path.join(parent, `worker-input-${suffix}.png`);
    await expect(
      new LocalCatalogSourceReader(media).read(finalKey(intent), target, {
        expectedSha256: intent.sha256,
        maxBytes: CATALOG_ORIGINAL_MAX_BYTES,
      }),
    ).resolves.toEqual({ byteSize: png.length, sha256: intent.sha256 });
  });

  /*
   * The Codex library and CLI core (scripts/editorial/direct-ingest.mjs)
   * against these routes, not a fake Admin: its Admin client reaches them
   * through Payload's own endpoint handling, and its COS client reaches a
   * stand-in for the bucket host that takes a PUT only with exactly the
   * signed header set, the signed length and Content-MD5, and never twice.
   */
  type CodexSummary = Record<string, unknown> & {
    codes: Record<string, number>;
  };
  type Bucket = {
    method: string;
    host: string;
    key: string;
    headers: string[];
  };
  type Fetch = (
    input: string | URL | Request,
    init?: RequestInit,
  ) => Promise<Response>;
  const codexLibrary = async () =>
    (await import(
      new URL("../../scripts/editorial/direct-ingest.mjs", import.meta.url).href
    )) as {
      runDirectIngest: (
        options: Record<string, unknown>,
      ) => Promise<CodexSummary>;
      createAdminSend: (
        config: Record<string, unknown>,
        options: { fetchImpl: Fetch },
      ) => unknown;
      createCosClient: (options: {
        hostSuffix: string;
        fetchImpl: Fetch;
      }) => unknown;
    };
  const codexActor = async (label: string) => {
    const email = `ingest-codex-${label}-${suffix}@example.invalid`;
    const password = randomUUID();
    await payload.create({
      collection: "users",
      overrideAccess: false,
      req: ownerReq,
      data: {
        email,
        password,
        role: "automation",
        scopeCatalogIds: [catalogA],
      },
    });
    const response = await handleEndpoints({
      config,
      request: new Request("http://localhost/api/users/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, password }),
      }),
    });
    expect(response.status).toBe(200);
    return ((await response.json()) as { token: string }).token;
  };
  /** The library's fetch toward the Admin, answered by the given routes. */
  const adminFetch =
    (
      dispatch: (request: Request) => Promise<Response>,
      log: { route: string; bytes: number }[],
    ): Fetch =>
    async (input, init = {}) => {
      const route = new URL(String(input)).pathname;
      const body = typeof init.body === "string" ? init.body : "";
      const response = await dispatch(
        new Request(`http://localhost${route}`, {
          method: init.method ?? "POST",
          headers: new Headers(init.headers),
          body,
        }),
      );
      const text = await response.text();
      log.push({
        route,
        bytes: Buffer.byteLength(body) + Buffer.byteLength(text),
      });
      return new Response(text, {
        status: response.status,
        headers: { "content-type": "application/json" },
      });
    };
  const composedRoutes = (request: Request) =>
    handleEndpoints({ config, request });
  const routeSet =
    (endpoints: Endpoint[]) =>
    async (request: Request): Promise<Response> => {
      const route = new URL(request.url).pathname;
      const endpoint = endpoints.find(
        (item) =>
          `/api${item.path}` === route &&
          item.method === request.method.toLowerCase(),
      );
      if (!endpoint) return Response.json({}, { status: 404 });
      return endpoint.handler(
        await createPayloadRequest({ config, request, canSetHeaders: true }),
      );
    };
  /** The bucket host: a private bucket that takes signed staging PUTs only. */
  const bucketFetch =
    (log: Bucket[], { reportsTagCount = true } = {}): Fetch =>
    async (input, init = {}) => {
      const url = new URL(String(input));
      const headers = Object.fromEntries(new Headers(init.headers));
      const key = decodeURIComponent(url.pathname.slice(1));
      log.push({
        method: init.method ?? "GET",
        host: url.host,
        key,
        headers: Object.keys(headers).sort(),
      });
      const signed = (url.searchParams.get("X-Amz-SignedHeaders") ?? "")
        .split(";")
        .filter((name) => name !== "host");
      const body = init.body as Uint8Array;
      const status =
        url.host !== `${BUCKET}.${UPLOAD_HOST}` ||
        init.method !== "PUT" ||
        !STAGING.test(key) ||
        Object.keys(headers).sort().join(";") !== signed.sort().join(";") ||
        String(body.byteLength) !== headers["content-length"]
          ? 403
          : md5(body).digest("base64") !== headers["content-md5"]
            ? 400
            : cos.objects.has(key)
              ? 409
              : 200;
      if (status === 200)
        cos.objects.set(
          key,
          stored(Buffer.from(body.buffer, body.byteOffset, body.byteLength), {
            contentType: headers["content-type"]!,
            // A COS whose HEAD omits the tag count reads as untagged.
            tags: reportsTagCount && headers["x-cos-tagging"] ? 1 : 0,
          }),
        );
      return new Response(null, { status });
    };

  it("ingests a 70 MB original through the Codex library: two small Admin requests, one PUT, no readback", async () => {
    const library = await codexLibrary();
    const large = virtualJpeg(70_000_000, 9504, 6336);
    const directory = await mkdtemp(path.join(parent, "codex-"));
    await writeFile(
      path.join(directory, "large.jpg"),
      large.object.read(0, large.object.size - 1),
    );
    const item = {
      key: "large",
      file: "large.jpg",
      mimeType: "image/jpeg" as const,
      catalogId: catalogA,
      mediaId: `ingest-codex-large-${suffix}`,
      sha256: large.sha256,
      bytes: large.object.size,
      width: 9504,
      height: 6336,
      alt: "Synthetic ingested original",
      rights: "Synthetic fixture",
      orderConfidence: "HIGH" as const,
    };
    const admin: { route: string; bytes: number }[] = [];
    const bucket: Bucket[] = [];
    const mark = cos.requests.length;
    const summary = await library.runDirectIngest({
      manifest: { version: 1, batchId: `codex-${suffix}`, items: [item] },
      directory,
      stateFile: path.join(directory, "state.jsonl"),
      send: library.createAdminSend(
        {
          baseURL: "http://127.0.0.1:3002",
          sessionToken: await codexActor("large"),
        },
        { fetchImpl: adminFetch(composedRoutes, admin) },
      ),
      cos: library.createCosClient({
        hostSuffix: UPLOAD_HOST,
        fetchImpl: bucketFetch(bucket),
      }),
      cosHostSuffix: UPLOAD_HOST,
      dryRun: false,
      retryDelayMs: 0,
    });
    expect(summary).toMatchObject({
      total: 1,
      registered: 1,
      newlyRegistered: 1,
      failed: 0,
      pending: 0,
      relayFallbacks: 0,
      privacy: "private",
    });
    expect(summary.codes).toEqual({});
    // I-AC1: the main site sees start and complete only, under 16 KB.
    expect(admin.map(({ route }) => route)).toEqual([
      "/api/editorial/media-ingest/start",
      "/api/editorial/media-ingest/complete",
    ]);
    expect(admin.reduce((total, { bytes }) => total + bytes, 0)).toBeLessThan(
      16 * 1024,
    );
    // The bytes go once to the bucket host with exactly the signed headers;
    // the only other request is the anonymous Range 0-0 privacy check.
    const intent = intentFor("codex", Buffer.alloc(0), {
      mediaId: item.mediaId,
      sha256: item.sha256,
    });
    expect(bucket).toEqual([
      {
        method: "PUT",
        host: `${BUCKET}.${UPLOAD_HOST}`,
        key: expect.stringMatching(STAGING),
        headers: [
          "content-length",
          "content-md5",
          "content-type",
          "x-cos-forbid-overwrite",
        ],
      },
      {
        method: "GET",
        host: `${BUCKET}.${UPLOAD_HOST}`,
        key: finalKey(intent),
        headers: ["range"],
      },
    ]);
    const found = await payload.find({
      collection: "media",
      overrideAccess: true,
      where: { mediaId: { equals: item.mediaId } },
    });
    expect(found.totalDocs).toBe(1);
    expect(found.docs[0]).toMatchObject({
      objectKey: finalKey(intent),
      filesize: item.bytes,
      width: 9504,
      height: 6336,
      sha256: item.sha256,
    });
    // Staging is gone; the Admin read it, copied it and never wrote it.
    expect(cos.objects.has(bucket[0]!.key)).toBe(false);
    expect(cos.objects.get(finalKey(intent))?.size).toBe(item.bytes);
    expect(
      since(mark)
        .filter(({ kind }) => kind === "put")
        .map(({ key }) => key),
    ).toEqual([]);
  }, 120_000);

  it("reports the Admin's own code to the Codex library when L1 meets a COS that omits the tag count", async () => {
    const library = await codexLibrary();
    const directory = await mkdtemp(path.join(parent, "codex-"));
    await writeFile(path.join(directory, "small.jpg"), jpeg);
    const mediaId = `ingest-codex-l1-${suffix}`;
    const bucket: Bucket[] = [];
    const mark = cos.requests.length;
    const summary = await library.runDirectIngest({
      manifest: {
        version: 1,
        batchId: `codex-l1-${suffix}`,
        items: [
          {
            key: "small",
            file: "small.jpg",
            mimeType: "image/jpeg",
            catalogId: catalogA,
            mediaId,
            sha256: hex(jpeg),
            bytes: jpeg.length,
            width: 96,
            height: 64,
            alt: "Synthetic ingested original",
          },
        ],
      },
      directory,
      stateFile: path.join(directory, "state.jsonl"),
      send: library.createAdminSend(
        {
          baseURL: "http://127.0.0.1:3002",
          sessionToken: await codexActor("l1"),
        },
        {
          fetchImpl: adminFetch(
            routeSet(routes({ CMS_CATALOG_INGEST_STAGING_TAG: "on" })),
            [],
          ),
        },
      ),
      cos: library.createCosClient({
        hostSuffix: UPLOAD_HOST,
        fetchImpl: bucketFetch(bucket, {
          reportsTagCount: false,
        }),
      }),
      cosHostSuffix: UPLOAD_HOST,
      dryRun: false,
      retryDelayMs: 0,
    });
    // Retried as a 5xx and left pending, under the Admin's code.
    expect(summary).toMatchObject({
      total: 1,
      registered: 0,
      failed: 0,
      pending: 1,
    });
    expect(summary.codes).toEqual({ INGEST_CONFIGURATION_INVALID: 1 });
    expect(bucket[0]?.headers).toContain("x-cos-tagging");
    // The positive control refused before any read or copy.
    expect(new Set(since(mark).map(({ kind }) => kind))).toEqual(
      new Set(["head"]),
    );
    expect(await mediaCount(mediaId)).toBe(0);
  });

  it("never logs or returns a URL, key, signature or token", () => {
    const events = logged.filter((args) =>
      (args as unknown[]).some(
        (value) => !!value && typeof value === "object" && "category" in value,
      ),
    );
    expect(events.length).toBeGreaterThan(0);
    for (const entry of events)
      expect(entry).toEqual([
        { category: expect.stringMatching(/^EDITORIAL_MEDIA_INGEST_[A-Z_]+$/) },
      ]);
    const failures = replies.filter(
      (body) => (body as { ok: boolean }).ok === false,
    );
    expect(failures.length).toBeGreaterThan(0);
    for (const body of failures)
      expect(body).toEqual({
        ok: false,
        error: { code: expect.stringMatching(/^[A-Z_]+$/), fields: [] },
      });
    const strict = JSON.stringify([events, failures]);
    for (const pattern of [
      /https?:/,
      /catalog-ingest\/v1/,
      /editorial\//,
      /X-Amz-/i,
      /synthetic-(?:access|secret)-key/,
      /[a-f0-9]{64}/,
    ])
      expect(strict).not.toMatch(pattern);
    // Nothing else logged in this file names a staging key, a signed URL's
    // host or parameters, or a credential.
    const everything = JSON.stringify(logged);
    for (const pattern of [
      /catalog-ingest\/v1/,
      /X-Amz-/i,
      /cos\.upload\.example\.test/,
      /synthetic-(?:access|secret)-key/,
    ])
      expect(everything).not.toMatch(pattern);
  });
});

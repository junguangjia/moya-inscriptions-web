import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import {
  createLocalReq,
  getPayload,
  handleEndpoints,
  type Plugin,
  type Payload,
  type SanitizedConfig,
} from "payload";
import sharp from "sharp";

const storage = await vi.hoisted(async () => {
  const { createRequire } = await import("node:module");
  // Resolve the installed dependency through Admin's public config entrypoint.
  const require = createRequire(import.meta.url);
  return {
    module: createRequire(require.resolve("admin/config")).resolve(
      "@payloadcms/storage-s3",
    ),
    objects: new Map<string, Buffer>(),
    requests: [] as { method: string; key: string }[],
  };
});

// Keep the real plugin, schema, access checks and S3 commands. Replace only
// the HTTP transport, so synthetic credentials can never reach a network.
vi.mock(storage.module, async (importOriginal) => {
  const actual = await importOriginal<{
    s3Storage: (options: Record<string, unknown>) => Plugin;
  }>();
  const { Readable } = await import("node:stream");
  return {
    ...actual,
    s3Storage: (options: Record<string, unknown>) =>
      actual.s3Storage({
        ...options,
        config: {
          ...(options.config as Record<string, unknown>),
          requestHandler: {
            async handle(request: {
              method: string;
              path: string;
              body?: unknown;
            }) {
              const key = decodeURIComponent(request.path.slice(1));
              storage.requests.push({ method: request.method, key });
              if (request.method === "PUT") {
                let uploaded: Buffer;
                if (typeof request.body === "string")
                  uploaded = Buffer.from(request.body);
                else if (request.body instanceof Uint8Array)
                  uploaded = Buffer.from(request.body);
                else {
                  const chunks: Buffer[] = [];
                  for await (const chunk of request.body as AsyncIterable<Uint8Array>)
                    chunks.push(Buffer.from(chunk));
                  uploaded = Buffer.concat(chunks);
                }
                storage.objects.set(key, uploaded);
                return {
                  response: {
                    statusCode: 200,
                    headers: { etag: '"synthetic-original-upload"' },
                    body: Readable.from([]),
                  },
                };
              }
              const bytes = storage.objects.get(key);
              if (!bytes || !["HEAD", "GET"].includes(request.method))
                throw new Error("UNEXPECTED_SYNTHETIC_S3_REQUEST");
              return {
                response: {
                  statusCode: 200,
                  headers: {
                    "content-length": String(bytes.length),
                    "content-type": "image/webp",
                    etag: '"synthetic-etag"',
                  },
                  body: Readable.from(request.method === "GET" ? [bytes] : []),
                },
              };
            },
          },
        },
      }),
  };
});

const suffix = randomUUID();
const prefix = `display/v1/synthetic-${suffix}`;
let config: SanitizedConfig;
let payload: Payload;
let token: string;
let outsideToken: string;
let filename: string;
let bytes: Buffer;

const get = (route: string, auth?: string) =>
  handleEndpoints({
    config,
    request: new Request(`http://localhost/api/${route}`, {
      headers: auth ? { Authorization: `JWT ${auth}` } : {},
    }),
  });

beforeAll(async () => {
  if (process.env.CMS_ENVIRONMENT !== "synthetic")
    throw new Error("SYNTHETIC_CMS_TARGET_REQUIRED");
  vi.stubEnv("CMS_STORAGE_MODE", "cos");
  vi.stubEnv("CMS_COS_ENDPOINT", "https://storage.example.invalid");
  vi.stubEnv("CMS_COS_REGION", "synthetic-region");
  vi.stubEnv("CMS_COS_BUCKET", `synthetic-${suffix}`);
  vi.stubEnv("CMS_COS_ACCESS_KEY_ID", "synthetic-access-key");
  vi.stubEnv("CMS_COS_SECRET_ACCESS_KEY", "synthetic-secret-key");
  config = await (await import("admin/config")).default;
  payload = await getPayload({ config });
  const password = randomUUID();
  const email = `cos-owner-${suffix}@example.invalid`;
  const owner = await payload.create({
    collection: "users",
    overrideAccess: true,
    data: { email, password, role: "owner" },
  });
  const ownerReq = await createLocalReq(
    { user: { ...owner, collection: "users" } },
    payload,
  );
  const outsideEmail = `cos-outside-${suffix}@example.invalid`;
  await payload.create({
    collection: "users",
    overrideAccess: false,
    req: ownerReq,
    data: {
      email: outsideEmail,
      password,
      role: "automation",
      scopeCatalogIds: [`outside-${suffix}`],
    },
  });
  const login = async (userEmail: string) => {
    const response = await handleEndpoints({
      config,
      request: new Request("http://localhost/api/users/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: userEmail, password }),
      }),
    });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(typeof body.token).toBe("string");
    return body.token as string;
  };
  token = await login(email);
  outsideToken = await login(outsideEmail);
  bytes = await sharp({
    create: { width: 3, height: 2, channels: 3, background: "white" },
  })
    .webp()
    .toBuffer();
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  filename = `${sha256}-${suffix}.webp`;
  const objectKey = `${prefix}/${filename}`;
  storage.objects.set(objectKey, bytes);
  await payload.create({
    collection: "media",
    overrideAccess: false,
    req: ownerReq,
    data: {
      mediaId: `cos-${suffix}`,
      catalogId: `cos-catalog-${suffix}`,
      origin: "existing",
      objectKey,
      sha256,
      mimeType: "image/webp",
      filesize: bytes.length,
      width: 3,
      height: 2,
      alt: "Synthetic retained COS media",
      rights: "Synthetic fixture",
      orderConfidence: "HIGH",
    },
  });
  expect(storage.requests).toEqual([]);
});

afterAll(async () => {
  await payload?.destroy();
  vi.unstubAllEnvs();
});

it("completes resumable bytes through the real S3 adapter metadata hook and replays without another PUT", async () => {
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const post = (
    route: string,
    body: string | Uint8Array,
    headers: Record<string, string>,
  ) =>
    handleEndpoints({
      config,
      request: new Request(
        `http://localhost/api/editorial/media-upload/${route}`,
        {
          method: "POST",
          headers: { Authorization: `JWT ${token}`, ...headers },
          body: typeof body === "string" ? body : new Uint8Array(body),
        },
      ),
    });
  const json = (route: string, value: unknown) =>
    post(route, JSON.stringify(value), { "content-type": "application/json" });
  const intent = {
    transferId: createHash("sha256").update(`cos-${suffix}`).digest("hex"),
    catalogId: `cos-upload-catalog-${suffix}`,
    mediaId: `cos-upload-media-${suffix}`,
    sha256,
    bytes: bytes.length,
    mimeType: "image/webp",
    alt: "Synthetic original S3 upload",
    rights: "Synthetic fixture",
    orderConfidence: "HIGH",
  };
  storage.requests.length = 0;
  const started = await json("start", intent);
  expect(started.status).toBe(200);
  const { uploadId } = (await started.json()).result;
  const chunk = await post(`chunk/${uploadId}/0`, bytes, {
    "content-type": "application/octet-stream",
    "x-editorial-chunk-sha256": sha256,
  });
  expect(chunk.status).toBe(200);
  const complete = await json("complete", { uploadId });
  expect(complete.status).toBe(200);
  const result = (await complete.json()).result;
  expect(result).toMatchObject({
    reused: false,
    validatedBytes: bytes.length,
    validatedSha256: sha256,
    media: {
      mediaId: intent.mediaId,
      catalogId: intent.catalogId,
      sha256,
      filesize: bytes.length,
      width: 3,
      height: 2,
      rights: "Synthetic fixture",
      orderConfidence: "HIGH",
    },
  });
  expect(storage.requests.filter(({ method }) => method === "PUT")).toEqual([
    { method: "PUT", key: result.media.objectKey },
  ]);
  expect(storage.objects.get(result.media.objectKey)).toEqual(bytes);
  const putCount = storage.requests.filter(
    ({ method }) => method === "PUT",
  ).length;
  const replay = await json("complete", { uploadId });
  expect(replay.status).toBe(200);
  expect((await replay.json()).result).toMatchObject({
    reused: true,
    media: { id: result.media.id },
  });
  expect(
    storage.requests.filter(({ method }) => method === "PUT"),
  ).toHaveLength(putCount);
  expect(
    (
      await payload.find({
        collection: "media",
        overrideAccess: true,
        where: { mediaId: { equals: intent.mediaId } },
      })
    ).totalDocs,
  ).toBe(1);

  const stageExistingOnly = async (
    existingIntent: typeof intent & { existingOnly: true },
  ) => {
    const start = await json("start", existingIntent);
    expect(start.status).toBe(200);
    const session = (await start.json()).result;
    const staged = await post(`chunk/${session.uploadId}/0`, bytes, {
      "content-type": "application/octet-stream",
      "x-editorial-chunk-sha256": sha256,
    });
    expect(staged.status).toBe(200);
    return session.uploadId as string;
  };
  const existingUploadId = await stageExistingOnly({
    ...intent,
    transferId: createHash("sha256")
      .update(`cos-existing-${suffix}`)
      .digest("hex"),
    existingOnly: true,
  });
  const existing = await json("complete", { uploadId: existingUploadId });
  expect(existing.status).toBe(200);
  expect((await existing.json()).result).toMatchObject({
    reused: true,
    validatedBytes: bytes.length,
    validatedSha256: sha256,
    media: { id: result.media.id, mediaId: intent.mediaId },
  });
  expect(
    storage.requests.filter(({ method }) => method === "PUT"),
  ).toHaveLength(putCount);
  expect(
    (
      await payload.find({
        collection: "media",
        overrideAccess: true,
        where: { mediaId: { equals: intent.mediaId } },
      })
    ).totalDocs,
  ).toBe(1);

  const absentMediaId = `cos-upload-absent-${suffix}`;
  const absentUploadId = await stageExistingOnly({
    ...intent,
    transferId: createHash("sha256")
      .update(`cos-absent-${suffix}`)
      .digest("hex"),
    mediaId: absentMediaId,
    existingOnly: true,
  });
  const absent = await json("complete", { uploadId: absentUploadId });
  expect(absent.status).toBe(409);
  expect(await absent.json()).toMatchObject({
    ok: false,
    error: { code: "MEDIA_UPLOAD_EXISTING_REQUIRED" },
  });
  expect(
    storage.requests.filter(({ method }) => method === "PUT"),
  ).toHaveLength(putCount);
  expect(
    (
      await payload.find({
        collection: "media",
        overrideAccess: true,
        where: { mediaId: { equals: absentMediaId } },
      })
    ).totalDocs,
  ).toBe(0);
});

it("includes and persists document prefix in the enabled COS schema and Owner projection", async () => {
  const media = config.collections.find((item) => item.slug === "media")!;
  expect(
    media.flattenedFields.find((field) => field.name === "prefix"),
  ).toMatchObject({ type: "text" });
  const query = new URLSearchParams({
    "where[mediaId][equals]": `cos-${suffix}`,
    "select[prefix]": "true",
    "select[objectKey]": "true",
  });
  const response = await get(`media?${query}`, token);
  expect(response.status).toBe(200);
  expect((await response.json()).docs).toEqual([
    expect.objectContaining({ prefix, objectKey: `${prefix}/${filename}` }),
  ]);
});

it.each([true, false])(
  "serves registered bytes at the exact key (explicit prefix: %s)",
  async (explicit) => {
    storage.requests.length = 0;
    const query = explicit ? `?prefix=${encodeURIComponent(prefix)}` : "";
    const response = await get(`media/file/${filename}${query}`, token);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/webp");
    expect(Buffer.from(await response.arrayBuffer())).toEqual(bytes);
    expect(storage.requests).toEqual([
      { method: "HEAD", key: `${prefix}/${filename}` },
      { method: "GET", key: `${prefix}/${filename}` },
    ]);
  },
);

it("denies anonymous, out-of-scope, wrong-prefix and unregistered reads before S3", async () => {
  storage.requests.length = 0;
  const route = `media/file/${filename}?prefix=${encodeURIComponent(prefix)}`;
  for (const [path, auth] of [
    [route, undefined],
    [route, outsideToken],
    [`media/file/${filename}?prefix=another-prefix`, token],
    [
      `media/file/unregistered.webp?prefix=${encodeURIComponent(prefix)}`,
      token,
    ],
  ]) {
    const response = await get(path!, auth);
    expect(response.status).toBe(403);
  }
  expect(storage.requests).toEqual([]);
});

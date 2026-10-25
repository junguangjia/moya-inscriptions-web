import { createHash, randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createLocalReq,
  getPayload,
  handleEndpoints,
  type Payload,
  type PayloadRequest,
} from "payload";
import config from "admin/config";
import sharp from "sharp";
import {
  MEDIA_UPLOAD_CHUNK_BYTES,
  type EditorialMediaUploadSession,
} from "@moya/contracts/internal/editorial";

const suffix = randomUUID();
const catalogId = `upload-catalog-${suffix}`;
const digest = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");
let payload: Payload;
let ownerToken: string;
let otherToken: string;
let bytes: Buffer;
let requestCount = 0;
let sentBodyBytes = 0;
const post = async (
  route: string,
  body: BodyInit | Uint8Array,
  auth: string | undefined = ownerToken,
  headers: Record<string, string> = {},
) => {
  requestCount++;
  if (typeof body === "string") sentBodyBytes += Buffer.byteLength(body);
  else if (body instanceof Uint8Array) sentBodyBytes += body.byteLength;
  return handleEndpoints({
    config,
    request: new Request(
      `http://127.0.0.1:3002/api/editorial/media-upload/${route}`,
      {
        method: "POST",
        headers: {
          ...(auth ? { Authorization: `JWT ${auth}` } : {}),
          ...headers,
        },
        body: body instanceof Uint8Array ? new Uint8Array(body) : body,
        // Node requires this for a real streaming Request body.
        ...(body instanceof ReadableStream ? { duplex: "half" } : {}),
      },
    ),
  });
};
const json = (route: string, value: unknown, auth = ownerToken) =>
  post(route, JSON.stringify(value), auth, {
    "content-type": "application/json",
  });
const start = async (label: string, includeOptionalMetadata = true) => {
  const intent = {
    transferId: digest(Buffer.from(`${suffix}:${label}`)),
    catalogId,
    mediaId: `upload-${label}-${suffix}`,
    sha256: digest(bytes),
    bytes: bytes.length,
    mimeType: "image/png",
    alt: "Synthetic original",
    ...(includeOptionalMetadata
      ? { rights: "Synthetic test", orderConfidence: "HIGH" }
      : {}),
  };
  const response = await json("start", intent);
  expect(response.status).toBe(200);
  expect(response.headers.get("x-editorial-upload-stream")).toBe("1");
  return {
    intent,
    session: (await response.json()).result as EditorialMediaUploadSession,
  };
};
const stream = (
  session: EditorialMediaUploadSession,
  data: Buffer,
  offset = 0,
  hash = digest(data),
) =>
  post(`stream/${session.uploadId}/${offset}`, data, ownerToken, {
    "content-type": "application/octet-stream",
    "content-length": String(data.length),
    "x-editorial-stream-sha256": hash,
  });

beforeAll(async () => {
  if (
    process.env.CMS_ENVIRONMENT !== "synthetic" ||
    process.env.CMS_STORAGE_MODE !== "local"
  )
    throw new Error("SYNTHETIC_LOCAL_CMS_REQUIRED");
  payload = await getPayload({ config });
  const password = randomUUID();
  const owner = await payload.create({
    collection: "users",
    overrideAccess: true,
    data: {
      email: `upload-owner-${suffix}@example.invalid`,
      password,
      role: "owner",
    },
  });
  const req = await createLocalReq(
    { user: { ...owner, collection: "users" } },
    payload,
  );
  const otherEmail = `upload-other-${suffix}@example.invalid`;
  await payload.create({
    collection: "users",
    req,
    overrideAccess: false,
    data: {
      email: otherEmail,
      password,
      role: "automation",
      scopeCatalogIds: [`outside-${suffix}`],
    },
  });
  const login = async (email: string) => {
    const response = await handleEndpoints({
      config,
      request: new Request("http://127.0.0.1:3002/api/users/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, password }),
      }),
    });
    expect(response.status).toBe(200);
    return (await response.json()).token as string;
  };
  ownerToken = await login(owner.email);
  otherToken = await login(otherEmail);
  bytes = await sharp(randomBytes(384 * 384 * 3), {
    raw: { width: 384, height: 384, channels: 3 },
  })
    .png({ compressionLevel: 0 })
    .toBuffer();
  expect(bytes.length).toBeGreaterThan(2 * MEDIA_UPLOAD_CHUNK_BYTES);
});
afterAll(async () => {
  await payload?.destroy();
});

describe("real Native resumable media endpoints", () => {
  it("authenticates before reading bodies and isolates actor/catalog sessions", async () => {
    const route = (await config).endpoints.find(
      ({ path }) => path === "/editorial/media-upload/start",
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
    expect((await route.handler(anonymous)).status).toBe(403);
    const { intent, session } = await start("scope");
    expect((await json("start", intent, otherToken)).status).toBe(403);
    expect(
      (await json("status", { uploadId: session.uploadId }, otherToken)).status,
    ).toBe(403);
    expect(
      (await json("complete", { uploadId: session.uploadId }, otherToken))
        .status,
    ).toBe(403);
  });

  it("resumes legacy chunks and recovers a lost completion reply without creating another media", async () => {
    const { intent, session } = await start("chunks", false);
    const first = bytes.subarray(0, MEDIA_UPLOAD_CHUNK_BYTES);
    const route = `chunk/${session.uploadId}/0`;
    const headers = {
      "content-type": "application/octet-stream",
      "x-editorial-chunk-sha256": digest(first),
    };
    expect((await post(route, first, ownerToken, headers)).status).toBe(200);
    expect((await post(route, first, ownerToken, headers)).status).toBe(200);
    const conflicting = Buffer.from(first);
    conflicting[0] = conflicting[0]! ^ 1;
    expect(
      (
        await post(route, conflicting, ownerToken, {
          ...headers,
          "x-editorial-chunk-sha256": digest(conflicting),
        })
      ).status,
    ).toBe(409);
    expect(
      (await (await json("status", { uploadId: session.uploadId })).json())
        .result.receivedIndices,
    ).toEqual([0]);
    expect(
      (
        await stream(
          session,
          bytes.subarray(MEDIA_UPLOAD_CHUNK_BYTES),
          MEDIA_UPLOAD_CHUNK_BYTES,
        )
      ).status,
    ).toBe(200);
    const complete = await json("complete", { uploadId: session.uploadId });
    expect(complete.status).toBe(200);
    const result = (await complete.json()).result;
    expect(result).toMatchObject({
      reused: false,
      validatedBytes: bytes.length,
      validatedSha256: intent.sha256,
      media: {
        mediaId: intent.mediaId,
        sha256: intent.sha256,
        filesize: bytes.length,
        width: 384,
        height: 384,
      },
    });
    expect(result.media).not.toHaveProperty("rights");
    expect(result.media).not.toHaveProperty("orderConfidence");
    const repeated = await json("complete", { uploadId: session.uploadId });
    expect(repeated.status).toBe(200);
    const replayed = (await repeated.json()).result;
    expect(replayed).toMatchObject({
      reused: true,
      media: { id: result.media.id },
    });
    expect(replayed.media).not.toHaveProperty("rights");
    expect(replayed.media).not.toHaveProperty("orderConfidence");
    const ownMedia = await payload.find({
      collection: "media",
      overrideAccess: true,
      where: { mediaId: { equals: intent.mediaId } },
    });
    expect(ownMedia.totalDocs).toBe(1);
    expect(ownMedia.docs[0]!.rights).toBeNull();
    expect(ownMedia.docs[0]!.orderConfidence).toBeNull();
    expect((await json("start", intent)).status).toBe(200);
  });

  it("rolls back complete invalid spans but retains whole aborted chunks and resumes the remaining bytes", async () => {
    const { session } = await start("aborted");
    expect((await stream(session, bytes, 0, "0".repeat(64))).status).toBe(400);
    expect(
      (await (await json("status", { uploadId: session.uploadId })).json())
        .result.receivedIndices,
    ).toEqual([]);
    let pulls = 0;
    const interrupted = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (pulls++ === 0)
          controller.enqueue(bytes.subarray(0, MEDIA_UPLOAD_CHUNK_BYTES));
        else controller.error(new Error("SYNTHETIC_INTERRUPTED_BODY"));
      },
    });
    const response = await post(
      `stream/${session.uploadId}/0`,
      interrupted,
      ownerToken,
      {
        "content-type": "application/octet-stream",
        "content-length": String(bytes.length),
        "x-editorial-stream-sha256": digest(bytes),
      },
    );
    expect(response.status).toBe(408);
    expect(
      (await (await json("status", { uploadId: session.uploadId })).json())
        .result.receivedIndices,
    ).toEqual([0]);
    expect(
      (
        await stream(
          session,
          bytes.subarray(MEDIA_UPLOAD_CHUNK_BYTES),
          MEDIA_UPLOAD_CHUNK_BYTES,
        )
      ).status,
    ).toBe(200);
    expect(
      (await json("complete", { uploadId: session.uploadId })).status,
    ).toBe(200);
  });

  it("never treats an interrupted prefix as verified file bytes; final SHA rejects a corrupt retained prefix", async () => {
    const { session } = await start("corrupt-prefix");
    const corrupt = Buffer.from(bytes.subarray(0, MEDIA_UPLOAD_CHUNK_BYTES));
    corrupt[0] = corrupt[0]! ^ 1;
    let pulls = 0;
    const interrupted = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (pulls++ === 0) controller.enqueue(corrupt);
        else controller.error(new Error("SYNTHETIC_INTERRUPTED_BODY"));
      },
    });
    expect(
      (
        await post(`stream/${session.uploadId}/0`, interrupted, ownerToken, {
          "content-type": "application/octet-stream",
          "content-length": String(bytes.length),
          "x-editorial-stream-sha256": digest(bytes),
        })
      ).status,
    ).toBe(408);
    expect(
      (await (await json("status", { uploadId: session.uploadId })).json())
        .result.receivedIndices,
    ).toEqual([0]);
    expect(
      (
        await stream(
          session,
          bytes.subarray(MEDIA_UPLOAD_CHUNK_BYTES),
          MEDIA_UPLOAD_CHUNK_BYTES,
        )
      ).status,
    ).toBe(200);
    const complete = await json("complete", { uploadId: session.uploadId });
    expect(complete.status).toBe(409);
    expect(await complete.json()).toMatchObject({
      ok: false,
      error: { code: "UPLOAD_FILE_HASH_MISMATCH" },
    });
    // This fixture records only bounded local request counts/bytes; no remote transport.
    expect(requestCount).toBeLessThan(40);
    expect(sentBodyBytes).toBeLessThan(5 * bytes.length);
  });
  it("maps a reuse of a registered original over 40 MiB to an identity conflict", async () => {
    // A Catalog ingest registers originals up to 128 MiB; an Owner
    // registration of an existing object stands in for one here.
    const mediaId = `upload-registered-large-${suffix}`;
    const objectKey = `editorial/${digest(Buffer.from(catalogId))}/${digest(Buffer.from(mediaId))}-${digest(bytes)}.png`;
    const registered = await handleEndpoints({
      config,
      request: new Request("http://127.0.0.1:3002/api/media", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          Authorization: `JWT ${ownerToken}`,
        },
        body: JSON.stringify({
          mediaId,
          catalogId,
          origin: "existing",
          objectKey,
          sha256: digest(bytes),
          mimeType: "image/png",
          filesize: 64 * 1024 * 1024,
          width: 384,
          height: 384,
          alt: "Synthetic original",
          rights: "Synthetic test",
          orderConfidence: "HIGH",
        }),
      }),
    });
    expect(registered.status).toBe(201);
    const reuse = await json("start", {
      transferId: digest(Buffer.from(`${suffix}:registered-large-reuse`)),
      catalogId,
      mediaId,
      sha256: digest(bytes),
      bytes: bytes.length,
      mimeType: "image/png",
      alt: "Synthetic original",
      rights: "Synthetic test",
      orderConfidence: "HIGH",
    });
    expect(reuse.status).toBe(200);
    const reuseSession = (await reuse.json())
      .result as EditorialMediaUploadSession;
    expect((await stream(reuseSession, bytes)).status).toBe(200);
    const complete = await json("complete", {
      uploadId: reuseSession.uploadId,
    });
    expect(complete.status).toBe(409);
    expect(await complete.json()).toEqual({
      ok: false,
      error: { code: "MEDIA_IDENTITY_CONFLICT", fields: [] },
    });
  });

  it("composes no Catalog ingest route while CMS_CATALOG_INGEST is off", async () => {
    expect(process.env.CMS_CATALOG_INGEST).toBeUndefined();
    expect(
      (await config).endpoints.filter(({ path }) =>
        path.startsWith("/editorial/media-ingest/"),
      ),
    ).toEqual([]);
    for (const [method, route] of [
      ["POST", "start"],
      ["POST", "complete"],
      ["POST", "abandon"],
      ["POST", "verify"],
      ["PUT", `dev-put/${"a".repeat(64)}`],
    ] as const) {
      const response = await handleEndpoints({
        config,
        request: new Request(
          `http://127.0.0.1:3002/api/editorial/media-ingest/${route}`,
          {
            method,
            headers: {
              "content-type": "application/json",
              Authorization: `JWT ${ownerToken}`,
            },
            body: "{}",
          },
        ),
      });
      expect(response.status).toBe(404);
    }
  });
});

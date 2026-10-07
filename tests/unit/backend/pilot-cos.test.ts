import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { request } from "node:https";
import { createServer, request as requestHttp } from "node:http";

import type { RequestOptions } from "node:https";

import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import { requestCosHttps } from "@moya/backend-production/internal/cos-https";
import {
  canonicalCosRequest,
  cosUrlEncode,
  signCosRequest,
} from "@moya/backend-production/internal/cos-signature";
import { PilotCosStorage } from "@moya/backend-production/internal/pilot-cos";

import type {
  CosHttpRequest,
  CosHttpResponse,
} from "@moya/backend-production/internal/cos-https";
import type { PilotCosOptions } from "@moya/backend-production/internal/pilot-cos";

vi.mock("node:https", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:https")>()),
  request: vi.fn(),
}));

const content = Buffer.from("frozen-pilot-image-bytes");
const digest = createHash("sha256").update(content).digest("hex");
const mediaId = `media_${"a".repeat(32)}`;
const objectKey = `display/v1/${mediaId}/${digest}.webp`;
const now = 1_788_820_000_000;
// Synthetic credentials for the local HTTP signing fixture.
const options = (): PilotCosOptions => ({
  bucket: "pilot-example-1250000000",
  region: "ap-guangzhou",
  mediaOrigin: "https://media.example.invalid",
  objects: [{ mediaId, objectKey, sha256: digest, sizeBytes: content.length }],
  credentials: async () => ({
    secretId: "unit-only-id",
    secretKey: "synthetic-cos-secret-1",
  }),
});
const response = (
  statusCode: number,
  body = Buffer.alloc(0),
): CosHttpResponse => ({
  statusCode,
  headers: {},
  body,
});
// Real official SDK APIs/signing/parser run against a local HTTP fixture through
// an explicit native-request test seam. Production always uses verified HTTPS.
const queues = new Map<
  string,
  {
    responses: CosHttpResponse[];
    calls: CosHttpRequest[];
    stall?: boolean;
  }
>();
let nextQueue = 0;
let fixturePort = 0;
const fixture = createServer((incoming, outgoing) => {
  const queue = queues.get(String(incoming.headers["x-unit-queue"]));
  const chunks: Buffer[] = [];
  incoming.on("data", (chunk: Buffer) => chunks.push(chunk));
  incoming.on("end", () => {
    if (queue?.stall) return;
    const next = queue?.responses.shift();
    if (!queue || !next) {
      outgoing.writeHead(500);
      outgoing.end();
      return;
    }
    const last = queue.calls.length - 1;
    queue.calls[last] = { ...queue.calls[last]!, body: Buffer.concat(chunks) };
    outgoing.writeHead(next.statusCode, next.headers);
    outgoing.end(next.body);
  });
});
beforeAll(async () => {
  await new Promise<void>((resolve) => fixture.listen(0, "127.0.0.1", resolve));
  const address = fixture.address();
  if (!address || typeof address === "string")
    throw new Error("Fixture unavailable");
  fixturePort = address.port;
});
afterAll(async () => {
  fixture.closeAllConnections();
  await new Promise<void>((resolve, reject) =>
    fixture.close((error) => (error ? reject(error) : resolve())),
  );
});
const queueSender = (...responses: CosHttpResponse[]) => {
  const id = String(++nextQueue);
  const calls: CosHttpRequest[] = [];
  const nativeOptions: RequestOptions[] = [];
  const requests: ReturnType<typeof request>[] = [];
  const state = { calls, responses, stall: false };
  queues.set(id, state);
  const sender = ((input: RequestOptions) => {
    nativeOptions.push(input);
    const headers = Object.fromEntries(
      Object.entries(input.headers ?? {}).map(([key, value]) => [
        key.toLowerCase(),
        String(value),
      ]),
    );
    calls.push({
      url: new URL(
        String(input.path),
        `https://${input.hostname ?? input.host}`,
      ),
      method: input.method as "GET" | "HEAD" | "PUT",
      headers,
      timeoutMs: 30_000,
      maxResponseBytes: 32 * 1024 * 1024,
    });
    const outgoing = requestHttp({
      ...input,
      protocol: "http:",
      hostname: "127.0.0.1",
      host: "127.0.0.1",
      port: fixturePort,
      agent: false,
      headers: { ...input.headers, "x-unit-queue": id },
    });
    requests.push(outgoing);
    return outgoing;
  }) as typeof request;
  return { calls, sender, nativeOptions, requests, state };
};
const neverVersioned = () =>
  response(200, Buffer.from("<VersioningConfiguration/>"));

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe("COS XML signing", () => {
  const officialDownload = {
    method: "GET" as const,
    pathname: "/exampleobject(腾讯云)",
    headers: {
      Date: "Thu, 16 May 2019 06:55:53 GMT",
      Host: "examplebucket-1250000000.cos.ap-beijing.myqcloud.com",
    },
    query: {
      "response-content-type": "application/octet-stream",
      "response-cache-control": "max-age=600",
    },
  };

  it("matches Tencent's published download canonical vector", () => {
    // https://cloud.tencent.com/document/product/436/7778, example two.
    // Tencent masks the secret and signature; this is the published SHA1 vector.
    expect(canonicalCosRequest(officialDownload)).toMatchObject({
      headerList: "date;host",
      parameterList: "response-cache-control;response-content-type",
      httpStringSha1: "54ecfe22f59d3514fdc764b87a32d8133ea611e6",
    });
    expect(cosUrlEncode("!'()* /中")).toBe("%21%27%28%29%2A%20%2F%E4%B8%AD");
  });

  it("uses the hex text of SignKey in the second HMAC", () => {
    // Expected signature independently calculated with Python hashlib/hmac;
    // the credential is synthetic and has no cloud authority.
    expect(
      signCosRequest({
        ...officialDownload,
        secretId: "unit-only-id",
        secretKey: "synthetic-cos-secret-1",
        startsAt: 1557989753,
        expiresAt: 1557996953,
      }),
    ).toContain("q-signature=79a47ba978758cfb62e73013c8c55b4614aff4d2");
    expect(() =>
      canonicalCosRequest({
        ...officialDownload,
        headers: { HOST: "a", host: "b" },
      }),
    ).toThrow("duplicate canonical");
    expect(() =>
      signCosRequest({
        ...officialDownload,
        secretId: "id",
        secretKey: "synthetic-cos-secret-2",
        startsAt: 20,
        expiresAt: 20,
      }),
    ).toThrow("configuration invalid");
  });
});

describe("bounded Pilot COS operations", () => {
  it("uploads only missing objects and verifies actual GET bytes", async () => {
    const queue = queueSender(
      response(404),
      neverVersioned(),
      response(200),
      response(200, content),
    );
    const storage = new PilotCosStorage(options(), {
      nativeRequest: queue.sender,
      now: () => now,
    });
    expect(await storage.ensureObject(objectKey, content)).toEqual({
      objectKey,
      sha256: digest,
      sizeBytes: content.length,
      outcome: "uploaded",
      verifiedAt: new Date(now).toISOString(),
    });
    expect(
      queue.calls.map((call) => [
        call.method,
        call.url.pathname,
        call.url.searchParams.get("versioning"),
      ]),
    ).toEqual([
      ["HEAD", `/${objectKey}`, null],
      ["GET", "/", ""],
      ["PUT", `/${objectKey}`, null],
      ["GET", `/${objectKey}`, null],
    ]);
    const put = queue.calls[2]!;
    expect(put.headers["x-cos-forbid-overwrite"]).toBe("true");
    expect(put.headers.authorization).toContain("x-cos-forbid-overwrite");
    expect(put.headers["content-md5"]).toBe(
      createHash("md5").update(content).digest("base64"),
    );
    expect(put.body).toEqual(content);
  });

  it("enforces verified TLS and a single network attempt on SDK retryable errors", async () => {
    const queue = queueSender(response(503));
    await expect(
      new PilotCosStorage(options(), {
        nativeRequest: queue.sender,
      }).ensureObject(objectKey, content),
    ).rejects.toThrow(/^COS request failed; verify state before retrying$/);
    expect(queue.calls).toHaveLength(1);
    expect(queue.nativeOptions[0]?.rejectUnauthorized).toBe(true);
    expect(queue.calls[0]?.url.protocol).toBe("https:");
  });

  it("does not follow an SDK redirect to another host", async () => {
    const queue = queueSender({
      ...response(302),
      headers: { location: "https://other.example.invalid/object" },
    });
    await expect(
      new PilotCosStorage(options(), {
        nativeRequest: queue.sender,
      }).ensureObject(objectKey, content),
    ).rejects.toThrow("existence could not be verified");
    expect(queue.calls).toHaveLength(1);
  });

  it("destroys an SDK request at the absolute deadline", async () => {
    const queue = queueSender();
    queue.state.stall = true;
    await expect(
      new PilotCosStorage(
        { ...options(), requestTimeoutMs: 30 },
        { nativeRequest: queue.sender },
      ).verifyObject(objectKey),
    ).rejects.toThrow(/^COS request failed; verify state before retrying$/);
    expect(queue.requests).toHaveLength(1);
    expect(queue.requests[0]?.destroyed).toBe(true);
  });

  it("preserves the caller's frozen byte snapshot across async credential reads", async () => {
    const queue = queueSender(
      response(404),
      neverVersioned(),
      response(200),
      response(200, content),
    );
    const mutable = Buffer.from(content);
    const pending = new PilotCosStorage(options(), {
      nativeRequest: queue.sender,
    }).ensureObject(objectKey, mutable);
    mutable.fill(0);
    expect((await pending).outcome).toBe("uploaded");
    expect(queue.calls[2]?.body).toEqual(content);
  });

  it("signs temporary tokens on SDK object requests without logging them", async () => {
    const queue = queueSender(response(200), response(200, content));
    const storage = new PilotCosStorage(
      {
        ...options(),
        credentials: async () => ({
          secretId: "unit-only-id",
          secretKey: "synthetic-cos-secret-1",
          securityToken: "synthetic-cos-token-3",
          expiresAt: now / 1000 + 90,
        }),
      },
      { nativeRequest: queue.sender, now: () => now },
    );
    await storage.ensureObject(objectKey, content);
    expect(
      queue.calls.every(
        (call) =>
          call.headers["x-cos-security-token"] === "synthetic-cos-token-3",
      ),
    ).toBe(true);
    expect(
      queue.calls.every((call) =>
        new URLSearchParams(call.headers.authorization)
          .get("q-header-list")
          ?.includes("x-cos-security-token"),
      ),
    ).toBe(true);
  });

  it("contains SDK parser errors for malformed remote response text", async () => {
    const queue = queueSender(
      response(404),
      response(200, Buffer.from("not-xml")),
    );
    await expect(
      new PilotCosStorage(options(), {
        nativeRequest: queue.sender,
      }).ensureObject(objectKey, content),
    ).rejects.toThrow(/^COS request failed; verify state before retrying$/);
    expect(queue.calls.some((call) => call.method === "PUT")).toBe(false);
  });

  it("bounds raw versioning responses before the SDK parser can default them", async () => {
    const queue = queueSender(
      response(404),
      response(200, Buffer.alloc(4097, 32)),
    );
    await expect(
      new PilotCosStorage(options(), {
        nativeRequest: queue.sender,
      }).ensureObject(objectKey, content),
    ).rejects.toThrow(/^COS request failed; verify state before retrying$/);
    expect(queue.calls.some((call) => call.method === "PUT")).toBe(false);
  });

  it("replay reuses existing byte-identical objects without PUT", async () => {
    const queue = queueSender(
      response(200),
      response(200, content),
      response(200),
      response(200, content),
    );
    const storage = new PilotCosStorage(options(), {
      nativeRequest: queue.sender,
    });
    expect((await storage.ensureObject(objectKey, content)).outcome).toBe(
      "reused",
    );
    expect((await storage.ensureObject(objectKey, content)).outcome).toBe(
      "reused",
    );
    expect(queue.calls.map((call) => call.method)).toEqual([
      "HEAD",
      "GET",
      "HEAD",
      "GET",
    ]);
  });

  it("rejects different GET bytes even when metadata claims the expected digest", async () => {
    const queue = queueSender(response(200), {
      ...response(200, Buffer.alloc(content.length)),
      headers: { "x-cos-meta-sha256": digest, etag: digest },
    });
    await expect(
      new PilotCosStorage(options(), {
        nativeRequest: queue.sender,
      }).ensureObject(objectKey, content),
    ).rejects.toThrow("content conflicts");
    expect(queue.calls.every((call) => call.method !== "PUT")).toBe(true);
  });

  it.each([409, 412])(
    "verifies a concurrent create after HTTP %s instead of overwriting",
    async (status) => {
      const queue = queueSender(
        response(404),
        neverVersioned(),
        response(status),
        response(200, content),
      );
      expect(
        (
          await new PilotCosStorage(options(), {
            nativeRequest: queue.sender,
          }).ensureObject(objectKey, content)
        ).outcome,
      ).toBe("reused");
      expect(queue.calls.filter((call) => call.method === "PUT")).toHaveLength(
        1,
      );
    },
  );

  it.each([
    "<VersioningConfiguration><Status>Enabled</Status></VersioningConfiguration>",
    "<VersioningConfiguration><Status>Suspended</Status></VersioningConfiguration>",
    "",
    "<Error/>",
    "<Unexpected/>",
    '{"VersioningConfiguration":{}}',
  ])(
    "blocks upload when versioning is enabled, suspended or unknown: %s",
    async (xml) => {
      const queue = queueSender(response(404), response(200, Buffer.from(xml)));
      await expect(
        new PilotCosStorage(options(), {
          nativeRequest: queue.sender,
        }).ensureObject(objectKey, content),
      ).rejects.toThrow("never-versioned");
      expect(queue.calls.some((call) => call.method === "PUT")).toBe(false);
    },
  );

  it("treats denied existence reads as uncertainty rather than absent objects", async () => {
    const queue = queueSender(response(403));
    await expect(
      new PilotCosStorage(options(), {
        nativeRequest: queue.sender,
      }).ensureObject(objectKey, content),
    ).rejects.toThrow("existence could not be verified");
    expect(queue.calls).toHaveLength(1);
  });

  it("rejects unlisted keys and changed input before making any request", async () => {
    const queue = queueSender();
    const storage = new PilotCosStorage(options(), {
      nativeRequest: queue.sender,
    });
    await expect(storage.ensureObject("../outside", content)).rejects.toThrow(
      "outside",
    );
    await expect(
      storage.ensureObject(objectKey, Buffer.alloc(content.length)),
    ).rejects.toThrow("SHA-256");
    await expect(
      storage.ensureObject(objectKey, Buffer.alloc(1)),
    ).rejects.toThrow("size mismatch");
    expect(queue.calls).toHaveLength(0);
  });

  it("rejects malformed, duplicate and oversized manifests", () => {
    const normal = options();
    expect(
      () =>
        new PilotCosStorage({
          ...normal,
          objects: [...normal.objects, ...normal.objects],
        }),
    ).toThrow("duplicated");
    expect(
      () =>
        new PilotCosStorage({
          ...normal,
          objects: [{ ...normal.objects[0]!, sizeBytes: 33 * 1024 * 1024 }],
        }),
    ).toThrow("manifest invalid");
    expect(
      () =>
        new PilotCosStorage({
          ...normal,
          objects: [
            { ...normal.objects[0]!, objectKey: "display/v1/../image.webp" },
          ],
        }),
    ).toThrow("manifest invalid");
  });

  it("caps GET response size and does not leak transport details", async () => {
    const queue = queueSender(response(200, Buffer.alloc(content.length + 1)));
    await expect(
      new PilotCosStorage(options(), {
        nativeRequest: queue.sender,
      }).verifyObject(objectKey),
    ).rejects.toThrow("COS request failed; verify state before retrying");
    await expect(
      new PilotCosStorage(options(), {
        nativeRequest: () => {
          throw new Error("secret-and-signed-request");
        },
      }).verifyObject(objectKey),
    ).rejects.toThrow(/^COS request failed; verify state before retrying$/);
  });

  it("does not return success when upload succeeds but verification fails; next retry can reuse", async () => {
    const queue = queueSender(
      response(404),
      neverVersioned(),
      response(200),
      response(503),
      response(200),
      response(200, content),
    );
    const storage = new PilotCosStorage(options(), {
      nativeRequest: queue.sender,
    });
    await expect(storage.ensureObject(objectKey, content)).rejects.toThrow(
      "content conflicts",
    );
    expect((await storage.ensureObject(objectKey, content)).outcome).toBe(
      "reused",
    );
    expect(queue.calls.filter((call) => call.method === "PUT")).toHaveLength(1);
  });
});

describe("short-lived backend URL resolver", () => {
  it("refreshes signatures on every API read and signs only matching identities", async () => {
    let time = now;
    const storage = new PilotCosStorage(options(), { now: () => time });
    const resolver = storage.createStorageUrlResolver();
    const locators = [
      { mediaId, objectKey },
      { mediaId: "wrong", objectKey },
      { mediaId, objectKey: "outside" },
    ];
    const first = await resolver.resolveMany(locators);
    expect(first.size).toBe(1);
    const url = new URL(first.get(mediaId)!);
    expect(url.origin).toBe("https://media.example.invalid");
    expect(url.pathname).toBe(`/${objectKey}`);
    expect(url.searchParams.get("q-sign-time")).toBe(
      `${now / 1000};${now / 1000 + 300}`,
    );
    expect(url.searchParams.get("response-cache-control")).toBe("no-store");
    time += 400_000;
    expect((await resolver.resolveMany(locators)).get(mediaId)).not.toBe(
      url.toString(),
    );
  });

  it("delivers no Catalog rendition key", async () => {
    const storage = new PilotCosStorage(options(), { now: () => now });
    const resolver = storage.createStorageUrlResolver();
    expect(
      (
        await resolver.resolveKeys([
          `media-rendition-${"1".repeat(32)}`,
          objectKey,
        ])
      ).size,
    ).toBe(0);
  });

  it("bounds temporary credential lifetime and never emits expired URLs", async () => {
    let time = now;
    const storage = new PilotCosStorage(
      {
        ...options(),
        credentials: async () => ({
          secretId: "unit-only-id",
          secretKey: "synthetic-cos-secret-1",
          securityToken: "synthetic-cos-token-3",
          expiresAt: now / 1000 + 90,
        }),
      },
      { now: () => time },
    );
    const resolver = storage.createStorageUrlResolver();
    const url = new URL(
      (await resolver.resolveMany([{ mediaId, objectKey }])).get(mediaId)!,
    );
    expect(url.searchParams.get("q-sign-time")).toBe(
      `${now / 1000};${now / 1000 + 90}`,
    );
    expect(url.searchParams.get("x-cos-security-token")).toBe(
      "synthetic-cos-token-3",
    );
    expect(url.searchParams.get("q-url-param-list")).toContain(
      "x-cos-security-token",
    );
    time += 100_000;
    await expect(
      resolver.resolveMany([{ mediaId, objectKey }]),
    ).rejects.toThrow("expired");
  });

  it.each([
    { securityToken: "synthetic-cos-token-4" },
    { securityToken: "synthetic-cos-token-4", expiresAt: now / 1000 + 20 },
    { securityToken: "synthetic-cos-token-4", expiresAt: Infinity },
    { securityToken: "synthetic-cos-token-4", expiresAt: NaN },
    { securityToken: "", expiresAt: now / 1000 + 90 },
    {
      securityToken: "synthetic-cos-token" + "\r\ninvalid-header",
      expiresAt: now / 1000 + 90,
    },
  ])(
    "fails closed for invalid temporary credentials without returning a URL",
    async (temporary) => {
      const storage = new PilotCosStorage(
        {
          ...options(),
          credentials: async () => ({
            secretId: "unit-only-id",
            secretKey: "synthetic-cos-secret-1",
            ...temporary,
          }),
        },
        { now: () => now },
      );
      await expect(
        storage
          .createStorageUrlResolver()
          .resolveMany([{ mediaId, objectKey }]),
      ).rejects.toThrow(
        /^COS credentials (expired or insufficient validity|invalid)$/,
      );
    },
  );

  it.each([
    "http://media.example.invalid",
    "https://u:synthetic@media.example.invalid",
    "https://media.example.invalid/path",
    "https://media.example.invalid/?signed=1",
    "https://127.0.0.1",
    "https://media.example.invalid:8443",
  ])("rejects unsafe origins: %s", (mediaOrigin) => {
    expect(() => new PilotCosStorage({ ...options(), mediaOrigin })).toThrow(
      "HTTPS DNS origin",
    );
  });
});

describe("native HTTPS limits", () => {
  const input = (): CosHttpRequest => ({
    url: new URL("https://media.example.invalid/key"),
    method: "GET",
    headers: {},
    maxResponseBytes: 4,
    timeoutMs: 10,
  });

  const mockConnection = () => {
    const incoming = Object.assign(new EventEmitter(), {
      statusCode: 200,
      headers: {},
      destroy: vi.fn(),
    });
    const outgoing = Object.assign(new EventEmitter(), {
      end: vi.fn(),
      destroy: vi.fn(),
    });
    vi.mocked(request).mockImplementation(((
      _url: unknown,
      _options: unknown,
      callback: (value: unknown) => void,
    ) => {
      queueMicrotask(() => callback(incoming));
      return outgoing;
    }) as unknown as typeof request);
    return { incoming, outgoing };
  };

  it("uses an absolute deadline and destroys a stalled request", async () => {
    vi.useFakeTimers();
    const connection = mockConnection();
    const result = expect(requestCosHttps(input())).rejects.toThrow(
      "timed out",
    );
    await vi.advanceTimersByTimeAsync(10);
    await result;
    expect(connection.outgoing.destroy).toHaveBeenCalledOnce();
  });

  it("aborts oversized and incomplete response bodies", async () => {
    const connection = mockConnection();
    const result = expect(requestCosHttps(input())).rejects.toThrow(
      "byte limit",
    );
    await Promise.resolve();
    connection.incoming.emit("data", Buffer.alloc(5));
    await result;
    expect(connection.incoming.destroy).toHaveBeenCalledOnce();
    const interrupted = mockConnection();
    const failure = expect(requestCosHttps(input())).rejects.toThrow(
      "interrupted",
    );
    await Promise.resolve();
    interrupted.incoming.emit("aborted");
    await failure;
  });

  it("never follows redirect responses or includes underlying errors in failures", async () => {
    const connection = mockConnection();
    connection.incoming.statusCode = 302;
    const pending = requestCosHttps(input());
    await Promise.resolve();
    connection.incoming.emit("end");
    expect((await pending).statusCode).toBe(302);
    expect(request).toHaveBeenCalledOnce();
    const next = mockConnection();
    const rejected = expect(requestCosHttps(input())).rejects.toThrow(
      /^COS request transport failed$/,
    );
    next.outgoing.emit("error", new Error("secret-url-token"));
    await rejected;
  });
});

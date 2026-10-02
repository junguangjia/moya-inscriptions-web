import { createServer, request as httpRequest } from "node:http";
import { mkdtemp, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createServer as createTcpServer } from "node:net";
import { request as secureRequest } from "node:https";
import { setTimeout as delay } from "node:timers/promises";

import {
  openProductionPublishingMedia,
  parseProductionPublishingMediaConfig,
} from "@moya/backend-production/internal/publishing-config";
import {
  createPublishingCosTransport,
  PublishingMediaStoreError,
} from "@moya/backend-production/internal/publishing-media-store";
import { afterEach, describe, expect, it } from "vitest";

import { cosFixture, cosOptions } from "./publishing-cos-fixture.js";
import type { request as httpsRequest, RequestOptions } from "node:https";

const env = {
  WORK_MEDIA_COS_BUCKET: cosOptions.bucket,
  WORK_MEDIA_COS_REGION: cosOptions.region,
  WORK_MEDIA_COS_PREFIX: cosOptions.prefix,
  WORK_MEDIA_COS_SECRET_ID: "synthetic-unit-id",
  WORK_MEDIA_COS_SECRET_KEY: "synthetic-unit-secret",
  WORK_MEDIA_TOOLS_IMAGE: "synthetic-tools:v1",
  WORK_MEDIA_WORK_DIR: "/srv/synthetic/jobs",
};
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const clean of cleanups.splice(0)) await clean();
});

describe("Production publishing factory", () => {
  it("validates complete configuration without I/O and fails closed with key-only errors", () => {
    expect(parseProductionPublishingMediaConfig(env)).toMatchObject({
      prefix: cosOptions.prefix,
      requestTimeoutMs: 30000,
      workerConcurrency: 1,
    });
    for (const name of Object.keys(env)) {
      const partial: Record<string, string | undefined> = {
        ...env,
        [name]: undefined,
      };
      expect(() => parseProductionPublishingMediaConfig(partial)).toThrow(name);
    }
    for (const delta of [
      { WORK_MEDIA_COS_PREFIX: "editorial/private-value/" },
      { WORK_MEDIA_WORKER_CONCURRENCY: "5" },
      { WORK_MEDIA_STORE_DIR: "/srv/retained" },
      { WORK_MEDIA_COS_REQUEST_TIMEOUT_MS: "120001" },
      { WORK_MEDIA_COS_SECURITY_TOKEN: "synthetic-token" },
      { WORK_MEDIA_COS_CREDENTIAL_EXPIRES_AT: "1" },
      { WORK_MEDIA_WORK_DIR: "/tmp/jobs" },
      { WORK_MEDIA_TOOLS_IMAGE: "untagged" },
    ])
      expect(() =>
        parseProductionPublishingMediaConfig({ ...env, ...delta }),
      ).toThrow();
  });
  it("opens the existing processor/runner with private scratch and no COS/Docker request", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "publishing-config-"));
    cleanups.push(() => rm(directory, { recursive: true, force: true }));
    const work = path.join(directory, "jobs");
    await mkdir(work, { mode: 0o700 });
    const config = {
      ...parseProductionPublishingMediaConfig(env),
      workDirectory: work,
    };
    const fixture = cosFixture();
    const runtime = await openProductionPublishingMedia(config, {
      transport: fixture.transport,
      temporaryRoots: [],
    });
    expect(runtime.processor.process).toBeTypeOf("function");
    expect(runtime.store.sweepStaging).toBeTypeOf("function");
    expect(fixture.calls).toEqual([]);
    await expect(
      openProductionPublishingMedia(config, {
        transport: fixture.transport,
        temporaryRoots: [],
        foreignDirectories: [directory],
      }),
    ).rejects.toThrow("separate");
  });
});

describe("official COS SDK bounded transport (loopback only)", () => {
  const setup = async (
    mode: "success" | "error200" | "oversize" | "stall" | "failure",
  ) => {
    let calls = 0;
    let socketsClosed = 0;
    const server = createServer((incoming, response) => {
      calls++;
      incoming.resume();
      incoming.on("end", () => {
        if (mode === "stall") return;
        response.statusCode = mode === "failure" ? 503 : 200;
        response.end(
          mode === "error200"
            ? "<Error><Code>InternalError</Code><Message>synthetic-private-diagnostic</Message></Error>"
            : mode === "oversize"
              ? "x".repeat(4096)
              : "<VersioningConfiguration/>",
        );
      });
    });
    server.on("connection", (socket) =>
      socket.on("close", () => socketsClosed++),
    );
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("fixture unavailable");
    cleanups.push(async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    });
    const requests: ReturnType<typeof httpRequest>[] = [];
    const nativeRequest = ((input: RequestOptions) => {
      const request = httpRequest({
        ...input,
        protocol: "http:",
        hostname: "127.0.0.1",
        host: "127.0.0.1",
        port: address.port,
        agent: false,
      });
      requests.push(request);
      return request;
    }) as typeof httpsRequest;
    const transport = createPublishingCosTransport(
      {
        credentials: async () => ({
          secretId: "synthetic-unit-id",
          secretKey: "synthetic-unit-secret",
        }),
        requestTimeoutMs: 500,
      },
      { nativeRequest },
    );
    return {
      transport,
      requests,
      calls: () => calls,
      closed: () => socketsClosed,
    };
  };
  const parameters = { Bucket: cosOptions.bucket, Region: cosOptions.region };
  it("uses the real SDK parser and retains raw versioning evidence", async () => {
    const f = await setup("success");
    const result = await f.transport.request("getBucketVersioning", parameters);
    expect(result.rawBody.toString()).toBe("<VersioningConfiguration/>");
    expect(f.calls()).toBe(1);
  });
  it.each(["oversize", "error200", "failure"] as const)(
    "rejects %s without hidden network retries or diagnostic disclosure",
    async (mode) => {
      const f = await setup(mode);
      await expect(
        f.transport.request(
          mode === "error200" ? "multipartComplete" : "getBucketVersioning",
          {
            ...parameters,
            Key: "synthetic-key",
            UploadId: "synthetic-upload",
            Parts: [{ PartNumber: 1, ETag: '"synthetic"' }],
          },
          undefined,
          1024,
        ),
      ).rejects.toMatchObject({
        code: "unavailable",
        message: "Publishing media store failure: unavailable",
      });
      expect(f.requests).toHaveLength(1);
    },
  );
  it("aborts a real pending SDK request and destroys its owned socket promptly", async () => {
    const f = await setup("stall");
    const controller = new AbortController();
    const pending = f.transport.request(
      "getBucketVersioning",
      parameters,
      controller.signal,
    );
    setTimeout(() => controller.abort(), 30);
    await expect(pending).rejects.toMatchObject({ code: "aborted" });
    expect(f.requests).toHaveLength(1);
    expect(f.requests[0]!.destroyed).toBe(true);
  });
});

describe("official COS multipart upload inactivity bounds (loopback only)", () => {
  const timeoutMs = 300;
  const body = Buffer.alloc(8 * 1024 * 1024, 97);
  const parameters = {
    Bucket: cosOptions.bucket,
    Region: cosOptions.region,
    Key: "synthetic-key",
    UploadId: "synthetic-upload",
    PartNumber: 1,
    ContentLength: body.length,
    Body: body,
  };
  const credentials = async () => ({
    secretId: "synthetic-unit-id",
    secretKey: "synthetic-unit-secret",
  });
  const setup = async (
    mode: "progress" | "stall" | "headers" | "trickle" | "oversize",
  ) => {
    let received = 0;
    let calls = 0;
    let headerWrites = 0;
    let flowing = false;
    let pacing: ReturnType<typeof setTimeout> | undefined;
    let trickle: ReturnType<typeof setInterval> | undefined;
    let release = () => {};
    let started!: () => void;
    const firstData = new Promise<void>((resolve) => {
      started = resolve;
    });
    let closed!: () => void;
    const peerClosed = new Promise<void>((resolve) => {
      closed = resolve;
    });
    let clientClosed!: () => void;
    const nativeClosed = new Promise<void>((resolve) => {
      clientClosed = resolve;
    });
    const server = createServer((incoming, response) => {
      calls++;
      incoming.pause();
      release = () => {
        flowing = true;
        clearTimeout(pacing);
        incoming.resume();
      };
      incoming.on("data", (chunk: Buffer) => {
        received += chunk.length;
        started();
        if (mode === "progress" && !flowing) {
          incoming.pause();
          pacing = setTimeout(() => incoming.resume(), 10);
        }
      });
      incoming.on("end", () => {
        if (mode === "headers") return;
        if (mode === "trickle") {
          response.socket!.write("HTTP/1.1 200 OK\r\nX-Slow: ");
          trickle = setInterval(() => {
            headerWrites++;
            response.socket?.write("x");
          }, 50);
          return;
        }
        response.setHeader("ETag", '"synthetic-part-etag"');
        response.end(mode === "oversize" ? "x".repeat(2048) : "");
      });
      if (mode !== "stall") incoming.resume();
    });
    server.on("connection", (socket) => socket.once("close", closed));
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("fixture unavailable");
    cleanups.push(async () => {
      clearTimeout(pacing);
      clearInterval(trickle);
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    });
    const requests: ReturnType<typeof httpRequest>[] = [];
    const nativeRequest = ((input: RequestOptions) => {
      const request = httpRequest({
        ...input,
        protocol: "http:",
        hostname: "127.0.0.1",
        host: "127.0.0.1",
        port: address.port,
        agent: false,
      });
      request.once("socket", (socket) => socket.once("close", clientClosed));
      requests.push(request);
      return request;
    }) as typeof httpsRequest;
    return {
      transport: createPublishingCosTransport(
        { credentials, requestTimeoutMs: timeoutMs },
        { nativeRequest },
      ),
      requests,
      received: () => received,
      calls: () => calls,
      headerWrites: () => headerWrites,
      release: () => release(),
      firstData,
      waitClosed: async () => {
        await Promise.race([
          nativeClosed,
          delay(timeoutMs).then(() => {
            throw new Error("owned client socket did not close");
          }),
        ]);
        // A paused peer can have unread buffered bytes ahead of the FIN. Only
        // after proving native closure, drain those bytes to observe peer close.
        release();
        await Promise.race([
          peerClosed,
          delay(timeoutMs).then(() => {
            throw new Error("owned peer socket did not close");
          }),
        ]);
      },
    };
  };
  it("allows genuine pending 8 MiB transmission progress beyond the former total deadline", async () => {
    const f = await setup("progress");
    let settled = false;
    const pending = f.transport
      .request("multipartUpload", parameters)
      .finally(() => {
        settled = true;
      });
    // Observe immediately so a regression's early rejection is handled.
    const outcome = pending.then(
      (result) => ({ result }),
      (error: unknown) => ({ error }),
    );
    await f.firstData;
    await delay(timeoutMs / 2);
    const before = f.received();
    await delay(timeoutMs);
    expect(before).toBeGreaterThan(0);
    expect(f.received()).toBeGreaterThan(before);
    expect(f.received()).toBeLessThan(body.length);
    expect(f.requests[0]!.writableFinished).toBe(false);
    expect(settled).toBe(false);
    f.release();
    expect(await outcome).toMatchObject({
      result: { ETag: '"synthetic-part-etag"' },
    });
    expect(f.received()).toBe(body.length);
    expect(f.calls()).toBe(1);
    expect(f.requests).toHaveLength(1);
  });
  it("bounds a stalled upload and destroys the single native request", async () => {
    const f = await setup("stall");
    const started = Date.now();
    await expect(
      f.transport.request("multipartUpload", parameters),
    ).rejects.toMatchObject({ code: "unavailable" });
    expect(Date.now() - started).toBeLessThan(timeoutMs * 4);
    expect(f.received()).toBe(0);
    expect(f.requests).toHaveLength(1);
    expect(f.requests[0]!.writableFinished).toBe(false);
    expect(f.requests[0]!.destroyed).toBe(true);
    await f.waitClosed();
  });
  it.each(["headers", "trickle"] as const)(
    "bounds %s after the body flush even with header-byte activity",
    async (mode) => {
      const f = await setup(mode);
      const started = Date.now();
      await expect(
        f.transport.request("multipartUpload", parameters),
      ).rejects.toMatchObject({ code: "unavailable" });
      expect(Date.now() - started).toBeLessThan(timeoutMs * 4);
      expect(f.received()).toBe(body.length);
      expect(f.requests).toHaveLength(1);
      expect(f.requests[0]!.writableFinished).toBe(true);
      expect(f.requests[0]!.destroyed).toBe(true);
      if (mode === "trickle")
        expect(f.headerWrites()).toBeGreaterThanOrEqual(2);
      await f.waitClosed();
    },
  );
  it("cancels a progressing pending upload promptly with the public aborted outcome", async () => {
    const f = await setup("progress");
    const controller = new AbortController();
    const pending = f.transport.request(
      "multipartUpload",
      parameters,
      controller.signal,
    );
    const assertion = expect(pending).rejects.toMatchObject({
      code: "aborted",
    });
    await f.firstData;
    await delay(timeoutMs / 2);
    expect(f.received()).toBeGreaterThan(0);
    expect(f.requests[0]!.writableFinished).toBe(false);
    const started = Date.now();
    controller.abort();
    await assertion;
    expect(Date.now() - started).toBeLessThan(timeoutMs);
    expect(f.requests).toHaveLength(1);
    expect(f.requests[0]!.destroyed).toBe(true);
    await f.waitClosed();
  });
  it("still rejects an oversized response before SDK buffering and never retries", async () => {
    const f = await setup("oversize");
    await expect(
      f.transport.request("multipartUpload", parameters, undefined, 1024),
    ).rejects.toMatchObject({ code: "unavailable" });
    expect(f.received()).toBe(body.length);
    expect(f.requests).toHaveLength(1);
    expect(f.requests[0]!.destroyed).toBe(true);
    await f.waitClosed();
  });
  it("bounds unresolved credentials before any network request", async () => {
    let calls = 0;
    const transport = createPublishingCosTransport(
      { credentials: () => new Promise(() => {}), requestTimeoutMs: timeoutMs },
      {
        nativeRequest: (() => {
          calls++;
          throw new Error("unexpected network");
        }) as typeof httpsRequest,
      },
    );
    await expect(
      transport.request("multipartUpload", parameters),
    ).rejects.toMatchObject({ code: "unavailable" });
    expect(calls).toBe(0);
  });
  it("bounds setup through TLS handshake without allowing a second request", async () => {
    const sockets = new Set<import("node:net").Socket>();
    const server = createTcpServer((socket) => {
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("fixture unavailable");
    cleanups.push(async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    });
    const requests: ReturnType<typeof secureRequest>[] = [];
    const nativeRequest = ((input: RequestOptions) => {
      const request = secureRequest({
        ...input,
        hostname: "127.0.0.1",
        host: "127.0.0.1",
        port: address.port,
        servername: "localhost",
        agent: false,
      });
      requests.push(request);
      return request;
    }) as typeof httpsRequest;
    const transport = createPublishingCosTransport(
      { credentials, requestTimeoutMs: timeoutMs },
      { nativeRequest },
    );
    await expect(
      transport.request("multipartUpload", parameters),
    ).rejects.toMatchObject({ code: "unavailable" });
    expect(requests).toHaveLength(1);
    expect(requests[0]!.destroyed).toBe(true);
  });
});

describe("COS stream and maintenance cancellation", () => {
  it("downstream pipeline destruction aborts an outstanding GET before iterator completion", async () => {
    const f = cosFixture();
    const key = `blobs/aa/aa/${"a".repeat(32)}`;
    f.objects.set(cosOptions.prefix + key, {
      bytes: Buffer.from("data"),
      headers: {},
      modified: new Date(),
    });
    let started!: () => void;
    const waiting = new Promise<void>((resolve) => {
      started = resolve;
    });
    let aborted = false;
    f.state.before = async (method, _input, signal) => {
      if (method !== "getObject") return;
      started();
      await new Promise<void>((_resolve, reject) =>
        signal!.addEventListener(
          "abort",
          () => {
            aborted = true;
            reject(new PublishingMediaStoreError("aborted"));
          },
          { once: true },
        ),
      );
    };
    const result = await f.store.openRead(key);
    if (result?.status !== "ok") throw new Error("missing");
    const sink = new Writable({
      write(_chunk, _encoding, callback) {
        callback();
      },
    });
    const pumping = pipeline(result.body, sink);
    const assertion = expect(pumping).rejects.toThrow();
    await waiting;
    sink.destroy(new Error("synthetic disconnect"));
    await assertion;
    expect(aborted).toBe(true);
    await result.close();
  });
  it("staging sweep forwards cancellation into the current list request", async () => {
    const f = cosFixture();
    const controller = new AbortController();
    f.state.before = async (_method, _input, signal) => {
      expect(signal).toBe(controller.signal);
      controller.abort();
      throw new PublishingMediaStoreError("aborted");
    };
    await expect(
      f.store.sweepStaging(new Date(), controller.signal),
    ).rejects.toMatchObject({ code: "aborted" });
  });
});

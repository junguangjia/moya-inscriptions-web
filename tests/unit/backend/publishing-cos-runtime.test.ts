import { createServer, request as httpRequest } from "node:http";
import { mkdtemp, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Writable } from "node:stream";
import { pipeline } from "node:stream/promises";

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

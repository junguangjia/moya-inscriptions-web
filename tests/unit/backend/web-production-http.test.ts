import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { connect } from "node:net";
import { setTimeout as delay } from "node:timers/promises";

import { afterEach, describe, expect, it } from "vitest";

import {
  createProductionHttpServer,
  productionHttpLimits,
} from "../../../apps/web/scripts/production-http-server.mts";
import { parseListenArguments } from "../../../apps/web/scripts/start-production.mts";

import type { IncomingMessage, Server, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

const upload = `/api/community/publishing/uploads/media-component-${"a".repeat(32)}`;
const servers: Server[] = [];
const scaledLimits = {
  requestDeadlineMs: 150,
  bodyIdleTimeoutMs: 500,
  uploadResponseTimeoutMs: 500,
  headersTimeoutMs: 500,
  connectionsCheckingIntervalMs: 10,
};

const consume = async (request: IncomingMessage, response: ServerResponse) => {
  let bytes = 0;
  for await (const chunk of request) bytes += (chunk as Buffer).length;
  response.end(String(bytes));
};
const listen = async (
  handler = consume,
  limits: Parameters<typeof createProductionHttpServer>[1] = {},
) => {
  const server = createProductionHttpServer(handler, {
    ...scaledLimits,
    ...limits,
  });
  servers.push(server);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return { server, port: (server.address() as AddressInfo).port };
};

const send = (
  port: number,
  path = upload,
  headers: Record<string, string> = {},
  method = "POST",
) => {
  const request = httpRequest({
    host: "127.0.0.1",
    port,
    path,
    method,
    headers,
  });
  request.on("error", () => undefined);
  const response = new Promise<{ status: number; body: string }>(
    (resolve, reject) => {
      request.once("error", reject);
      request.once("response", (message) => {
        let body = "";
        message.setEncoding("utf8");
        message.on("data", (chunk: string) => {
          body += chunk;
        });
        message.once("end", () =>
          resolve({ status: message.statusCode!, body }),
        );
        message.once("error", reject);
      });
    },
  );
  // Tests sometimes hold the body open before awaiting this promise.
  void response.catch(() => undefined);
  return { request, response };
};

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
          server.closeAllConnections();
        }),
    ),
  );
});

describe("Production Web HTTP upload boundary", () => {
  it("streams a >1 MiB upload beyond the ordinary total deadline while bytes progress", async () => {
    const { server, port } = await listen();
    const chunk = Buffer.alloc(128 * 1024, 1);
    const count = 16;
    const { request, response } = send(port, upload, {
      "content-length": String(chunk.length * count),
    });
    const began = Date.now();
    for (let index = 0; index < count; index += 1) {
      request.write(chunk);
      await delay(25);
    }
    request.end();
    expect(await response).toEqual({
      status: 200,
      body: String(chunk.length * count),
    });
    expect(Date.now() - began).toBeGreaterThan(
      scaledLimits.requestDeadlineMs * 2,
    );
    expect(server.requestTimeout).toBe(0);
    expect(server.headersTimeout).toBe(scaledLimits.headersTimeoutMs);
    expect(server.maxConnections).toBe(productionHttpLimits.maxConnections);
    expect(server.maxHeadersCount).toBe(productionHttpLimits.maxHeaders);
  });

  it.each([
    "/ordinary",
    `${upload}/extra`,
    `${upload}?extra=1`,
    upload.replace("media-component-", "lookalike-"),
  ])(
    "retains the total body deadline for %s despite continuous progress",
    async (path) => {
      const { port } = await listen();
      const { request, response } = send(port, path, {
        "content-length": "100",
      });
      const timer = setInterval(() => request.write("x"), 20);
      try {
        expect((await response).status).toBe(408);
      } finally {
        clearInterval(timer);
        request.destroy();
      }
    },
  );

  it("does not exempt other methods at the upload URL", async () => {
    const { port } = await listen();
    const { request, response } = send(
      port,
      upload,
      { "content-length": "100" },
      "PUT",
    );
    const timer = setInterval(() => request.write("x"), 20);
    try {
      expect((await response).status).toBe(408);
    } finally {
      clearInterval(timer);
      request.destroy();
    }
  });

  it("terminates a stalled upload and releases its concurrency slot", async () => {
    const { port } = await listen(consume, { maxConcurrentUploads: 1 });
    const stalled = send(port, upload, { "content-length": "100" });
    stalled.request.write("x");
    expect((await stalled.response).status).toBe(408);
    const next = send(port, upload, { "content-length": "1" });
    next.request.end("x");
    expect(await next.response).toEqual({ status: 200, body: "1" });
  });

  it("rejects oversize declared bodies before calling the handler", async () => {
    let calls = 0;
    const { port } = await listen(async (request, response) => {
      calls += 1;
      await consume(request, response);
    });
    for (const [path, length] of [
      [upload, productionHttpLimits.uploadMaxBytes + 1],
      ["/ordinary", productionHttpLimits.ordinaryMaxBytes + 1],
      ["/api/community/media", productionHttpLimits.profileMediaMaxBytes + 1],
      [
        "/api/community/article-authoring/draft",
        productionHttpLimits.articleMaxBytes + 1,
      ],
    ] as const) {
      const { request, response } = send(port, path, {
        "content-length": String(length),
      });
      request.flushHeaders();
      expect((await response).status).toBe(413);
      request.destroy();
    }
    expect(calls).toBe(0);
  });

  it("counts chunked ordinary bytes without enlarging lookalike media/body limits", async () => {
    const { port } = await listen(consume, { ordinaryMaxBytes: 8 });
    const { request, response } = send(port, "/api/community/media-extra");
    request.write("12345678");
    request.end("9");
    expect((await response).status).toBe(413);
  });

  it("requires fixed-length upload bodies and rejects Expect before Next", async () => {
    const { port } = await listen();
    const empty = send(port);
    empty.request.end();
    expect((await empty.response).status).toBe(422); // Node emits Content-Length: 0.
    const chunked = send(port);
    chunked.request.write("x");
    expect((await chunked.response).status).toBe(422);
    const expected = send(port, upload, {
      "content-length": "1",
      expect: "100-continue",
    });
    expected.request.flushHeaders();
    expect((await expected.response).status).toBe(417);
  });

  it("bounds concurrent uploads, retains the first, and releases on abort", async () => {
    const { port } = await listen(consume, { maxConcurrentUploads: 1 });
    const first = send(port, upload, { "content-length": "100" });
    first.request.write("x");
    await delay(20);
    const denied = send(port, upload, { "content-length": "1" });
    denied.request.end("x");
    expect((await denied.response).status).toBe(503);
    first.request.destroy();
    await delay(20);
    const next = send(port, upload, { "content-length": "1" });
    next.request.end("x");
    expect((await next.response).status).toBe(200);
  });

  it("bounds a silent upload response after the final body byte", async () => {
    const { port } = await listen(async (request) => {
      for await (const chunk of request) void chunk;
    });
    const { request, response } = send(port, upload, { "content-length": "1" });
    request.end("x");
    expect((await response).status).toBe(504);
  });

  it("does not terminate a notification-like response after its empty request body", async () => {
    const { port } = await listen(async (_request, response) => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write("data: first\n\n");
      await delay(240);
      response.end("data: second\n\n");
    });
    const { request, response } = send(
      port,
      "/api/community/notifications/stream",
      {},
      "GET",
    );
    request.end();
    expect(await response).toEqual({
      status: 200,
      body: "data: first\n\ndata: second\n\n",
    });
  });

  it("bounds slow headers before route identification and oversized headers", async () => {
    const { port } = await listen();
    const socket = connect(port, "127.0.0.1");
    let data = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      data += chunk;
    });
    socket.write(`POST ${upload} HTTP/1.1\r\nHost: localhost\r\nX-Slow: `);
    await once(socket, "close");
    expect(data).toContain("408 Request Timeout");
    const oversized = send(
      port,
      "/",
      { "x-large": "x".repeat(productionHttpLimits.maxHeaderBytes + 1) },
      "GET",
    );
    oversized.request.end();
    expect((await oversized.response).status).toBe(431);
  });

  it("uses the bounded wrapper for package and systemd Production startup", async () => {
    const manifest = JSON.parse(
      await readFile(
        new URL("../../../apps/web/package.json", import.meta.url),
        "utf8",
      ),
    );
    expect(manifest.scripts.start).toBe(
      "NODE_ENV=production node scripts/start-production.mts --hostname 127.0.0.1 --port 3000",
    );
    expect(manifest.scripts.dev).toBe("next dev --port 3000");
    const unit = await readFile(
      new URL(
        "../../../infra/production/systemd/yoyi-web.service",
        import.meta.url,
      ),
      "utf8",
    );
    expect(unit).toContain(
      "ExecStart=/usr/bin/env NODE_ENV=production node scripts/start-production.mts --hostname 127.0.0.1 --port 3000",
    );
    expect(unit).not.toContain("node_modules/next/dist/bin/next start");
  });

  it("rejects invalid limit overrides and external/ambiguous listener arguments", () => {
    expect(() =>
      createProductionHttpServer(consume, { bodyIdleTimeoutMs: 0 }),
    ).toThrow();
    expect(parseListenArguments([])).toEqual({
      hostname: "127.0.0.1",
      port: 3000,
    });
    expect(
      parseListenArguments(["--port", "34567", "--hostname", "127.0.0.1"]),
    ).toEqual({ hostname: "127.0.0.1", port: 34567 });
    for (const args of [
      ["--hostname", "0.0.0.0"],
      ["--port", "0"],
      ["--port", "65536"],
      ["--port", "3000", "--port", "3001"],
      ["--unknown", "1"],
      ["--port"],
    ]) {
      expect(() => parseListenArguments(args)).toThrow();
    }
  });
});

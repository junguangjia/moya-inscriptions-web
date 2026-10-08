import { execFile } from "node:child_process";
import { once } from "node:events";
import {
  chmod,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { Agent, createServer, request as secureRequest } from "node:https";
import { createServer as createTcpServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { Readable } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import { TLSSocket } from "node:tls";

import { createPublishingCosTransport } from "@moya/backend-production/internal/publishing-media-store";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import { cosOptions } from "./publishing-cos-fixture.js";
import type { ClientRequest } from "node:http";
import type { RequestOptions } from "node:https";
import type { Socket } from "node:net";
import type { Duplex } from "node:stream";

const TIMEOUT_MS = 300;
const BODY = Buffer.alloc(8 * 1024 * 1024, 97);
const ETAG = '"synthetic-part-etag"';
const BUCKET = { Bucket: cosOptions.bucket, Region: cosOptions.region };
const PART = {
  ...BUCKET,
  Key: "synthetic-key",
  UploadId: "synthetic-upload",
  PartNumber: 1,
  ContentLength: BODY.length,
  Body: BODY,
};
const credentials = async () => ({
  secretId: "synthetic-unit-id",
  secretKey: "synthetic-unit-secret",
});

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

// Unlike Promise.race(delay(...)), clear the owned timer on early completion.
const within = <T>(promise: Promise<T>, milliseconds = 1_500): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("Synthetic TLS fixture did not settle in time")),
      milliseconds,
    );
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });

let certificateDirectory: string | undefined;
let certificate: Buffer;
let privateKey: Buffer | undefined;
const ownedCleanups: (() => Promise<void>)[] = [];

beforeAll(async () => {
  certificateDirectory = await mkdtemp(path.join(tmpdir(), "moya-cos-tls-"));
  await chmod(certificateDirectory, 0o700);
  const keyPath = path.join(certificateDirectory, "localhost-key.pem");
  const certificatePath = path.join(certificateDirectory, "localhost-cert.pem");
  const configPath = path.join(certificateDirectory, "openssl.cnf");
  // Pre-create outputs with private permissions before OpenSSL opens them.
  for (const file of [keyPath, certificatePath])
    await writeFile(file, "", { mode: 0o600, flag: "wx" });
  // A config file avoids depending on OpenSSL's newer -addext flag (LibreSSL).
  await writeFile(
    configPath,
    [
      "[req]",
      "prompt=no",
      "distinguished_name=subject",
      "x509_extensions=extensions",
      "[subject]",
      "CN=localhost",
      "[extensions]",
      "subjectAltName=DNS:localhost,IP:127.0.0.1",
      "basicConstraints=critical,CA:TRUE",
      "keyUsage=critical,keyCertSign,digitalSignature,keyEncipherment",
      "extendedKeyUsage=serverAuth",
      "",
    ].join("\n"),
    { mode: 0o600, flag: "wx" },
  );
  await new Promise<void>((resolve, reject) => {
    // Arguments contain paths/configuration only. Never expose stderr, output,
    // the key contents, or an exec error carrying captured diagnostics.
    execFile(
      "openssl",
      [
        "req",
        "-x509",
        "-newkey",
        "rsa:2048",
        "-nodes",
        "-sha256",
        "-days",
        "1",
        "-config",
        configPath,
        "-keyout",
        keyPath,
        "-out",
        certificatePath,
      ],
      { timeout: 10_000, maxBuffer: 64 * 1024 },
      (error) => {
        if (error)
          reject(new Error("Synthetic TLS certificate generation failed"));
        else resolve();
      },
    );
  });
  for (const file of [keyPath, certificatePath, configPath]) {
    await chmod(file, 0o600);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
  }
  expect((await stat(certificateDirectory)).mode & 0o777).toBe(0o700);
  privateKey = await readFile(keyPath);
  certificate = await readFile(certificatePath);
}, 15_000);

afterEach(async () => {
  for (const cleanup of ownedCleanups.splice(0).reverse()) await cleanup();
});
afterAll(async () => {
  privateKey?.fill(0);
  if (certificateDirectory)
    await rm(certificateDirectory, { recursive: true, force: true });
});

type Mode =
  | "success"
  | "stall"
  | "progress"
  | "body-trickle"
  | "delayed-headers"
  | "early-response"
  | "early-response-then-finish"
  | "oversize";
interface Trace {
  request: ClientRequest;
  socket?: TLSSocket;
  authorizedOnAssignment?: boolean;
  connectingOnAssignment?: boolean;
  reusedOnAssignment?: boolean;
  handshakes: number;
  finished: ReturnType<typeof deferred<void>>;
  finishedAt?: number;
  responseAt?: number;
  responseBeforeFinish?: boolean;
  closed: ReturnType<typeof deferred<void>>;
}

async function fixture(
  mode: Mode,
  publicationPut: boolean | "legacy-put" = false,
  totalMs = 1_800,
) {
  const firstData = deferred<void>();
  const responseSeen = deferred<void>();
  const peerClosed = deferred<void>();
  const sockets = new Set<Duplex>();
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const traces: Trace[] = [];
  let received = 0;
  let uploadCalls = 0;
  let warmupCalls = 0;
  let serverHandshakes = 0;
  let responseWrites = 0;
  let released = false;
  let release = () => {};
  const later = (callback: () => void, milliseconds: number) => {
    const timer = setTimeout(() => {
      timers.delete(timer);
      callback();
    }, milliseconds);
    timers.add(timer);
  };
  const server = createServer(
    { key: privateKey!, cert: certificate },
    (incoming, response) => {
      incoming.on("error", () => {}); // expected when the owned client aborts
      response.on("error", () => {});
      if (incoming.method === "GET") {
        warmupCalls++;
        incoming.resume();
        incoming.once("end", () => response.end("<VersioningConfiguration/>"));
        return;
      }
      uploadCalls++;
      incoming.pause();
      const early =
        mode === "early-response" || mode === "early-response-then-finish";
      const paced = mode === "progress" || early;
      release = () => {
        released = true;
        incoming.resume();
      };
      const trickle = () => {
        response.setHeader("ETag", ETAG);
        response.setHeader("Content-Type", "application/xml");
        response.flushHeaders();
        const tick = () => {
          if (response.destroyed || response.writableEnded) return;
          responseWrites++;
          response.write(" "); // safely below the response-byte bound
          later(tick, 40);
        };
        tick();
      };
      incoming.on("data", (chunk: Buffer) => {
        received += chunk.length;
        firstData.resolve();
        if (paced && !released) {
          incoming.pause();
          later(() => incoming.resume(), 10);
        }
      });
      incoming.once("end", () => {
        if (early) return;
        if (mode === "body-trickle") {
          trickle();
          return;
        }
        if (mode === "delayed-headers") {
          later(trickle, 210);
          return;
        }
        response.setHeader("ETag", ETAG);
        response.end(
          mode === "oversize" ? "x".repeat(2_048) : "<UploadPartResult/>",
        );
      });
      if (early) {
        trickle();
      }
      if (mode !== "stall") incoming.resume();
    },
  );
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => {
      sockets.delete(socket);
      peerClosed.resolve();
    });
  });
  server.on("secureConnection", () => {
    serverHandshakes++;
  });
  const agent = new Agent({ keepAlive: true, maxSockets: 1, ca: certificate });
  ownedCleanups.push(async () => {
    for (const timer of timers) clearTimeout(timer);
    agent.destroy();
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Synthetic TLS listener unavailable");
  const nativeRequest = ((input: RequestOptions) => {
    const request = secureRequest({
      ...input,
      hostname: "127.0.0.1",
      host: "127.0.0.1",
      port: address.port,
      servername: "localhost",
      ca: certificate,
      rejectUnauthorized: true,
      agent,
    });
    const trace: Trace = {
      request,
      handshakes: 0,
      finished: deferred<void>(),
      closed: deferred<void>(),
    };
    traces.push(trace);
    request.once("socket", (socket) => {
      // Keep assertions/diagnostics boolean/count-based: never serialize a
      // socket, server, agent, or TLS options object into test failure output.
      if (!(socket instanceof TLSSocket))
        throw new Error("Expected synthetic TLS socket");
      trace.socket = socket;
      trace.authorizedOnAssignment = socket.authorized;
      trace.connectingOnAssignment = socket.connecting;
      trace.reusedOnAssignment = request.reusedSocket;
      socket.once("secureConnect", () => {
        trace.handshakes++;
      });
      socket.once("close", () => trace.closed.resolve());
    });
    request.once("finish", () => {
      trace.finishedAt = performance.now();
      trace.finished.resolve();
    });
    request.once("response", () => {
      trace.responseAt = performance.now();
      trace.responseBeforeFinish = !request.writableFinished;
      responseSeen.resolve();
    });
    return request;
  }) as typeof secureRequest;
  const transport = createPublishingCosTransport(
    {
      credentials: publicationPut
        ? async () => ({
            ...(await credentials()),
            securityToken: "synthetic-unit-token",
            expiresAt: Math.floor(Date.now() / 1_000) + 3_600,
          })
        : credentials,
      requestTimeoutMs: TIMEOUT_MS,
      ...(publicationPut === true
        ? { streamingPutTotalTimeoutMs: totalMs }
        : {}),
    },
    { nativeRequest },
  );
  return {
    traces,
    transport,
    publicationPut,
    firstData: firstData.promise,
    responseSeen: responseSeen.promise,
    received: () => received,
    uploadCalls: () => uploadCalls,
    warmupCalls: () => warmupCalls,
    serverHandshakes: () => serverHandshakes,
    responseWrites: () => responseWrites,
    release: () => release(),
    waitClosed: async (trace: Trace) => {
      // Prove native closure first; unread TLS/request bytes can precede FIN
      // at a paused peer. Only then drain the peer to observe its close.
      await within(trace.closed.promise);
      release();
      await within(peerClosed.promise);
    },
    warm: async () => {
      // Observe free before sending so the reuse assertion cannot race pooling.
      const free = once(agent, "free").then(() => undefined);
      await transport.request("getBucketVersioning", BUCKET);
      await within(free);
    },
  };
}

function startUpload(
  f: Awaited<ReturnType<typeof fixture>>,
  signal?: AbortSignal,
  maxBytes?: number,
) {
  let settled = false;
  const outcome = f.transport
    .request(
      f.publicationPut ? "putObject" : "multipartUpload",
      f.publicationPut
        ? { ...BUCKET, Key: PART.Key, ContentLength: BODY.length, Body: BODY }
        : PART,
      signal,
      maxBytes,
    )
    .then(
      (result) => {
        settled = true;
        return { status: "success" as const, result, at: performance.now() };
      },
      (error: unknown) => {
        settled = true;
        return { status: "failure" as const, error, at: performance.now() };
      },
    );
  return { outcome, settled: () => settled };
}

function expectFailure(
  outcome: Awaited<ReturnType<typeof startUpload>["outcome"]>,
  code = "unavailable",
) {
  expect(outcome.status).toBe("failure");
  if (outcome.status === "failure")
    expect(outcome.error).toMatchObject({ code });
}

describe("official COS verified TLS request phases", () => {
  it("keeps non-opted-in PUTs under their original total deadline", async () => {
    const f = await fixture("progress", "legacy-put");
    const pending = startUpload(f);
    await within(f.firstData);
    expectFailure(await within(pending.outcome));
    expect(f.traces[0]!.request.destroyed).toBe(true);
    expect(f.uploadCalls()).toBe(1);
    await f.waitClosed(f.traces[0]!);
  });

  it.each([false, true])(
    "allows a progressing single publication PUT beyond the control deadline (reused=%s)",
    async (reused) => {
      const f = await fixture("progress", true);
      if (reused) await f.warm();
      const pending = startUpload(f);
      await within(f.firstData);
      await delay(TIMEOUT_MS / 2);
      const before = f.received();
      await delay(TIMEOUT_MS);
      const trace = f.traces.at(-1)!;
      expect(f.received()).toBeGreaterThan(before);
      expect(trace.request.writableFinished).toBe(false);
      expect(pending.settled()).toBe(false);
      expect(trace.socket?.authorized).toBe(true);
      expect(trace.reusedOnAssignment).toBe(reused);
      f.release();
      expect((await within(pending.outcome)).status).toBe("success");
      expect(f.received()).toBe(BODY.length);
      expect(f.uploadCalls()).toBe(1);
    },
  );

  it("ends a progressing single PUT at its non-renewing hard total", async () => {
    const totalMs = 600;
    const f = await fixture("progress", true, totalMs);
    const started = performance.now();
    const pending = startUpload(f);
    await within(f.firstData);
    await delay(TIMEOUT_MS / 2);
    const before = f.received();
    const outcome = await within(pending.outcome);
    expectFailure(outcome);
    expect(f.received()).toBeGreaterThan(before);
    expect(f.received()).toBeLessThan(BODY.length);
    expect(outcome.at - started).toBeGreaterThanOrEqual(totalMs - 50);
    expect(outcome.at - started).toBeLessThan(totalMs + 200);
    expect(f.traces[0]!.request.destroyed).toBe(true);
    expect(f.uploadCalls()).toBe(1);
    await f.waitClosed(f.traces[0]!);
  });

  it.each(["stall", "body-trickle", "delayed-headers"] as const)(
    "retains bounded single-PUT inactivity/response completion for %s",
    async (mode) => {
      const f = await fixture(mode, true);
      const outcome = await within(startUpload(f).outcome);
      expectFailure(outcome);
      expect(f.traces[0]!.socket?.authorized).toBe(true);
      expect(f.traces[0]!.request.destroyed).toBe(true);
      expect(f.uploadCalls()).toBe(1);
      await f.waitClosed(f.traces[0]!);
    },
  );

  it("cancels a progressing publication PUT without a retry", async () => {
    const f = await fixture("progress", true);
    const controller = new AbortController();
    const pending = startUpload(f, controller.signal);
    await within(f.firstData);
    controller.abort();
    expectFailure(await within(pending.outcome), "aborted");
    expect(f.traces[0]!.request.destroyed).toBe(true);
    expect(f.uploadCalls()).toBe(1);
    await f.waitClosed(f.traces[0]!);
  });

  it.each([60, 269])(
    "refuses a %s-second token before SDK invocation or source consumption",
    async (validitySeconds) => {
      let consumed = false;
      const body = Readable.from(
        (async function* () {
          consumed = true;
          yield Buffer.from("x");
        })(),
      );
      const sdkFactory = vi.fn(() => {
        throw new Error("Unexpected SDK invocation");
      });
      const transport = createPublishingCosTransport(
        {
          credentials: async () => ({
            ...(await credentials()),
            securityToken: "synthetic-unit-token",
            expiresAt: Math.floor(Date.now() / 1_000) + validitySeconds,
          }),
          requestTimeoutMs: 30_000,
          streamingPutTotalTimeoutMs: 240_000,
        },
        { sdkFactory },
      );
      try {
        await expect(
          transport.request("putObject", {
            ...BUCKET,
            Key: PART.Key,
            ContentLength: 1,
            Body: body,
          }),
        ).rejects.toMatchObject({ code: "unavailable" });
        expect(sdkFactory).not.toHaveBeenCalled();
        expect(consumed).toBe(false);
      } finally {
        body.destroy();
      }
    },
  );

  it("bounds stalled PUT credentials before invoking the SDK", async () => {
    const sdkFactory = vi.fn(() => {
      throw new Error("Unexpected SDK invocation");
    });
    const transport = createPublishingCosTransport(
      {
        credentials: () => new Promise(() => {}),
        requestTimeoutMs: 50,
        streamingPutTotalTimeoutMs: 500,
      },
      { sdkFactory },
    );
    await expect(
      transport.request("putObject", {
        ...BUCKET,
        Key: PART.Key,
        ContentLength: 1,
        Body: Buffer.from("x"),
      }),
    ).rejects.toMatchObject({ code: "unavailable" });
    expect(sdkFactory).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    "allows a progressing actual 8 MiB upload over TLS (reused=%s)",
    async (reused) => {
      const f = await fixture("progress");
      if (reused) await f.warm();
      const prior = reused ? f.traces[0] : undefined;
      const pending = startUpload(f);
      await within(f.firstData);
      await delay(TIMEOUT_MS / 2);
      const before = f.received();
      await delay(TIMEOUT_MS);
      const trace = f.traces.at(-1)!;
      expect(before).toBeGreaterThan(0);
      expect(f.received()).toBeGreaterThan(before);
      expect(f.received()).toBeLessThan(BODY.length);
      expect(trace.request.writableFinished).toBe(false);
      expect(pending.settled()).toBe(false);
      expect(trace.socket?.authorized).toBe(true);
      expect(trace.reusedOnAssignment).toBe(reused);
      expect(f.serverHandshakes()).toBe(1);
      if (reused) {
        expect(trace.socket === prior!.socket).toBe(true);
        expect(trace.authorizedOnAssignment).toBe(true);
        expect(trace.connectingOnAssignment).toBe(false);
        expect(trace.handshakes).toBe(0);
        expect(prior!.handshakes).toBe(1);
      } else {
        expect(trace.authorizedOnAssignment).toBe(false);
        expect(trace.handshakes).toBe(1);
      }
      f.release();
      const result = await within(pending.outcome);
      expect(result.status).toBe("success");
      if (result.status === "success")
        expect(result.result).toMatchObject({ ETag: ETAG });
      expect(f.received()).toBe(BODY.length);
      expect(f.uploadCalls()).toBe(1);
      expect(f.warmupCalls()).toBe(reused ? 1 : 0);
      expect(f.traces.length).toBe(reused ? 2 : 1);
    },
  );

  it("completes a normal verified TLS response within its bound", async () => {
    const f = await fixture("success");
    const outcome = await within(startUpload(f).outcome);
    expect(outcome.status).toBe("success");
    if (outcome.status === "success")
      expect(outcome.result.rawBody.toString()).toBe("<UploadPartResult/>");
    expect(f.received()).toBe(BODY.length);
    expect(f.traces[0]!.socket?.authorized).toBe(true);
    expect(f.traces.length).toBe(1);
    expect(f.uploadCalls()).toBe(1);
  });

  it.each([
    "body-trickle",
    "delayed-headers",
    "early-response",
    "early-response-then-finish",
  ] as const)(
    "bounds absolute response completion for %s, without resetting on activity",
    async (mode) => {
      const f = await fixture(mode);
      const pending = startUpload(f);
      await within(f.responseSeen);
      const trace = f.traces[0]!;
      expect(trace.socket?.authorized).toBe(true);
      if (mode.startsWith("early-response")) {
        expect(trace.responseBeforeFinish).toBe(true);
        expect(trace.request.writableFinished).toBe(false);
        await within(f.firstData);
        await delay(80);
        const before = f.received();
        await delay(110);
        expect(before).toBeGreaterThan(0);
        expect(f.received()).toBeGreaterThan(before);
        expect(f.received()).toBeLessThan(BODY.length);
        expect(trace.request.writableFinished).toBe(false);
        expect(pending.settled()).toBe(false);
        if (mode === "early-response-then-finish") {
          // A later upload finish must not extend the early response deadline.
          f.release();
          await within(trace.finished.promise);
          expect(trace.finishedAt! - trace.responseAt!).toBeGreaterThan(170);
        }
      }
      const outcome = await within(pending.outcome);
      expectFailure(outcome);
      if (mode === "early-response")
        expect(trace.request.writableFinished).toBe(false);
      const start = Math.min(
        trace.finishedAt ?? Infinity,
        trace.responseAt ?? Infinity,
      );
      expect(Number.isFinite(start)).toBe(true);
      const elapsed = outcome.at - start;
      expect(elapsed).toBeGreaterThanOrEqual(TIMEOUT_MS - 50);
      // Header delay is 210 ms, so a wrong reset at response would expire
      // near 510 ms and fail this bound. Give the correct 300 ms timer 150 ms
      // scheduling margin without renewing the configured deadline.
      expect(elapsed).toBeLessThan(TIMEOUT_MS + 150);
      expect(f.responseWrites()).toBeGreaterThanOrEqual(2);
      expect(trace.request.destroyed).toBe(true);
      expect(f.traces.length).toBe(1);
      expect(f.uploadCalls()).toBe(1);
      await f.waitClosed(trace);
    },
  );

  it("aborts the owned verified TLS upload promptly without retrying", async () => {
    const f = await fixture("progress");
    const controller = new AbortController();
    const pending = startUpload(f, controller.signal);
    await within(f.firstData);
    await delay(100);
    const trace = f.traces[0]!;
    expect(trace.socket?.authorized).toBe(true);
    expect(trace.request.writableFinished).toBe(false);
    const started = performance.now();
    controller.abort();
    const outcome = await within(pending.outcome);
    expectFailure(outcome, "aborted");
    expect(outcome.at - started).toBeLessThan(TIMEOUT_MS);
    expect(trace.request.destroyed).toBe(true);
    expect(f.traces.length).toBe(1);
    await f.waitClosed(trace);
  });

  it("rejects an oversized TLS response before SDK buffering, with one request", async () => {
    const f = await fixture("oversize");
    expectFailure(await within(startUpload(f, undefined, 1_024).outcome));
    expect(f.received()).toBe(BODY.length);
    expect(f.traces[0]!.request.destroyed).toBe(true);
    expect(f.traces.length).toBe(1);
    expect(f.uploadCalls()).toBe(1);
    await f.waitClosed(f.traces[0]!);
  });

  it("keeps a new TLS handshake bounded after TCP has connected", async () => {
    const sockets = new Set<Socket>();
    const server = createTcpServer((socket) => {
      sockets.add(socket);
      socket.once("close", () => sockets.delete(socket));
      // Consume the ClientHello but never send handshake bytes.
      socket.resume();
    });
    ownedCleanups.push(async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("Synthetic TLS listener unavailable");
    let calls = 0;
    let request: ClientRequest | undefined;
    let socket: TLSSocket | undefined;
    let tcpConnected = false;
    let secureConnected = false;
    const closed = deferred<void>();
    const nativeRequest = ((input: RequestOptions) => {
      calls++;
      request = secureRequest({
        ...input,
        hostname: "127.0.0.1",
        host: "127.0.0.1",
        port: address.port,
        servername: "localhost",
        ca: certificate,
        rejectUnauthorized: true,
        agent: false,
      });
      request.once("socket", (assigned) => {
        if (!(assigned instanceof TLSSocket))
          throw new Error("Expected synthetic TLS socket");
        socket = assigned;
        assigned.once("connect", () => {
          tcpConnected = true;
        });
        assigned.once("secureConnect", () => {
          secureConnected = true;
        });
        assigned.once("close", () => closed.resolve());
      });
      return request;
    }) as typeof secureRequest;
    const transport = createPublishingCosTransport(
      { credentials, requestTimeoutMs: TIMEOUT_MS },
      { nativeRequest },
    );
    const started = performance.now();
    await expect(
      within(transport.request("multipartUpload", PART)),
    ).rejects.toMatchObject({ code: "unavailable" });
    expect(performance.now() - started).toBeLessThan(TIMEOUT_MS * 3);
    expect(tcpConnected).toBe(true);
    expect(secureConnected).toBe(false);
    expect(socket?.authorized).toBe(false);
    expect(calls).toBe(1);
    expect(request?.destroyed).toBe(true);
    await within(closed.promise);
  });
});

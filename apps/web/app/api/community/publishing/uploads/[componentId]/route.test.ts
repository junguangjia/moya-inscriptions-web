import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { POST } from "./route";

const MiB = 1024 * 1024;
const component = `media-component-${"a".repeat(32)}`;
const account = `user-${"b".repeat(32)}`;
const attempt = "3f0d1c52-7a4e-4b8e-9a61-2f5d6c7b8e90";
const session = "S".repeat(43);
const origin = "http://127.0.0.1:3420";
const endpoint = `${origin}/api/community/publishing/uploads/${component}`;
const backend = "http://backend.test/";

const context = (componentId = component) => ({
  params: Promise.resolve({ componentId }),
});

interface UploadRequestOptions {
  readonly body: ReadableStream<Uint8Array> | Uint8Array;
  readonly length: number | string;
  readonly headers?: Record<string, string>;
  readonly omit?: readonly string[];
  readonly url?: string;
  readonly signal?: AbortSignal;
}

/** The browser request as Next hands it to the route: a streaming body with duplex half. */
const uploadRequest = ({
  body,
  length,
  headers = {},
  omit = [],
  url = endpoint,
  signal,
}: UploadRequestOptions): Request => {
  const all: Record<string, string> = {
    host: "127.0.0.1:3420",
    origin,
    "sec-fetch-site": "same-origin",
    cookie: `theme=dark; yoyi-session=${session}`,
    "content-type": "application/octet-stream",
    "content-length": String(length),
    "x-author-account": account,
    "x-upload-attempt": attempt,
    ...headers,
  };
  for (const name of omit) delete all[name];
  const init: RequestInit & { duplex: "half" } = {
    method: "POST",
    headers: all,
    body: body as BodyInit,
    duplex: "half",
    ...(signal === undefined ? {} : { signal }),
  };
  return new Request(url, init);
};

const bytes = (size: number) => new Uint8Array(size);

const nextTask = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

const readAll = async (
  body: BodyInit | null | undefined,
  onChunk?: (chunk: Uint8Array) => Promise<void> | void,
): Promise<{ chunks: number; bytes: number }> => {
  const reader = (body as ReadableStream<Uint8Array>).getReader();
  let chunks = 0;
  let size = 0;
  for (;;) {
    const part = await reader.read();
    if (part.done) return { chunks, bytes: size };
    chunks += 1;
    size += part.value.byteLength;
    await onChunk?.(part.value);
  }
};

const uploadResult = (receivedBytes: number) => ({
  componentId: component,
  sha256: "0".repeat(64),
  receivedBytes,
});

const expectPrivate = (response: Response) => {
  expect(response.headers.get("cache-control")).toBe("private, no-store");
  expect(response.headers.get("vary")).toBe("Cookie");
  expect(response.headers.get("x-content-type-options")).toBe("nosniff");
};

/** A relay answer without a usable Backend answer: the outcome is unknown. */
const expectUnanswered = async (
  response: Response,
  status: 502 | 504,
  reason: "interrupted" | "timeout" | "invalid-answer",
) => {
  expect(response.status).toBe(status);
  expectPrivate(response);
  expect(response.headers.get("x-publishing-relay")).toBe(reason);
  expect(await response.text()).toBe("");
};

/** How undici fails a fetch whose Backend socket closed while the body was still being written. */
const socketClosed = (code: "EPIPE" | "ECONNRESET") =>
  new TypeError("fetch failed", {
    cause: Object.assign(new Error(`write ${code}`), { code }),
  });

beforeEach(() => {
  vi.stubEnv("NODE_ENV", "production");
  vi.stubEnv("MOYA_PUBLIC_API_BASE_URL", backend);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("work publishing upload relay", () => {
  it("streams a large body to the Backend one chunk at a time and passes the JSON answer through", async () => {
    const chunkCount = 256;
    const chunk = bytes(MiB);
    let produced = 0;
    let consumed = 0;
    const source = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          if (produced === chunkCount) {
            controller.close();
            return;
          }
          // The next browser chunk may only be read once the Backend consumed
          // the previous one: any buffering or read-ahead in Web fails here.
          if (produced !== consumed) {
            controller.error(new Error("the relay read ahead of the Backend"));
            return;
          }
          produced += 1;
          controller.enqueue(chunk);
        },
      },
      { highWaterMark: 0 },
    );
    const upstream = vi.fn<typeof fetch>(async (_input, init) => {
      const read = await readAll(init?.body, async () => {
        consumed += 1;
        await nextTask();
      });
      return Response.json(uploadResult(read.bytes), {
        headers: { "content-type": "application/json; charset=utf-8" },
      });
    });
    vi.stubGlobal("fetch", upstream);

    const response = await POST(
      uploadRequest({ body: source, length: chunkCount * MiB }),
      context(),
    );

    expect(response.status).toBe(200);
    expectPrivate(response);
    expect(response.headers.get("content-type")).toBe("application/json");
    expect(await response.json()).toEqual(uploadResult(chunkCount * MiB));
    expect(consumed).toBe(chunkCount);
    expect(upstream).toHaveBeenCalledOnce();
    const [target, init] = upstream.mock.calls[0]!;
    expect(String(target)).toBe(
      `${backend}v1/community/publishing/uploads/${component}`,
    );
    expect(init).toMatchObject({
      method: "POST",
      duplex: "half",
      cache: "no-store",
      redirect: "error",
    });
    expect(init?.body).toBeInstanceOf(ReadableStream);
    expect(init?.headers).toEqual({
      accept: "application/json",
      Authorization: `Bearer ${session}`,
      "content-type": "application/octet-stream",
      "content-length": String(chunkCount * MiB),
      "x-author-account": account,
      "x-upload-attempt": attempt,
    });
  });

  it("keeps at most one chunk between the browser and a slow Backend", async () => {
    let produced = 0;
    let consumed = 0;
    let furthestAhead = 0;
    const source = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          if (produced === 64) {
            controller.close();
            return;
          }
          produced += 1;
          furthestAhead = Math.max(furthestAhead, produced - consumed);
          controller.enqueue(bytes(256 * 1024));
        },
      },
      { highWaterMark: 0 },
    );
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async (_input, init) => {
        const read = await readAll(init?.body, async () => {
          for (let pause = 0; pause < 3; pause += 1) await nextTask();
          consumed += 1;
        });
        return Response.json(uploadResult(read.bytes));
      }),
    );
    const response = await POST(
      uploadRequest({ body: source, length: 64 * 256 * 1024 }),
      context(),
    );
    expect(response.status).toBe(200);
    expect(furthestAhead).toBe(1);
  });

  it("aborts the Backend request when the browser goes away mid-body", async () => {
    const browser = new AbortController();
    let pulls = 0;
    const source = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          pulls += 1;
          controller.enqueue(bytes(64 * 1024));
        },
      },
      { highWaterMark: 0 },
    );
    let backendSignal: AbortSignal | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async (_input, init) => {
        backendSignal = init?.signal ?? undefined;
        const reader = (init?.body as ReadableStream<Uint8Array>).getReader();
        await reader.read();
        await reader.read();
        browser.abort();
        return new Promise<Response>((_resolve, reject) => {
          if (backendSignal?.aborted) reject(backendSignal.reason);
          backendSignal?.addEventListener("abort", () =>
            reject(backendSignal?.reason),
          );
        });
      }),
    );
    const response = await POST(
      uploadRequest({
        body: source,
        length: 128 * MiB,
        signal: browser.signal,
      }),
      context(),
    );
    expect(backendSignal?.aborted).toBe(true);
    expect(response.status).toBe(400);
    expect(response.headers.get("x-publishing-relay")).toBeNull();
    const pullsAfterAbort = pulls;
    await nextTask();
    expect(pulls).toBe(pullsAfterAbort);
    expect(pulls).toBeLessThanOrEqual(3);
  });

  it("returns an early Backend answer and stops relaying the remaining bytes", async () => {
    let pulls = 0;
    const source = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          pulls += 1;
          controller.enqueue(bytes(MiB));
        },
      },
      { highWaterMark: 0 },
    );
    const superseded = {
      error: {
        code: "CONFLICT",
        message: "upload_superseded",
        requestId: "request-1",
      },
    };
    let backendSignal: AbortSignal | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async (_input, init) => {
        backendSignal = init?.signal ?? undefined;
        await (init?.body as ReadableStream<Uint8Array>).getReader().read();
        return Response.json(superseded, { status: 409 });
      }),
    );
    const response = await POST(
      uploadRequest({ body: source, length: 64 * MiB }),
      context(),
    );
    expect(response.status).toBe(409);
    expectPrivate(response);
    expect(await response.json()).toEqual(superseded);
    expect(response.headers.get("x-publishing-relay")).toBeNull();
    expect(backendSignal?.aborted).toBe(true);
    expect(pulls).toBe(1);
  });

  it.each(["EPIPE", "ECONNRESET"] as const)(
    "marks an early Backend close (%s) before any answer as interrupted, not as a Backend 503",
    async (code) => {
      let pulls = 0;
      const source = new ReadableStream<Uint8Array>(
        {
          pull(controller) {
            pulls += 1;
            controller.enqueue(bytes(MiB));
          },
        },
        { highWaterMark: 0 },
      );
      vi.stubGlobal(
        "fetch",
        vi.fn<typeof fetch>(async (_input, init) => {
          const reader = (init?.body as ReadableStream<Uint8Array>).getReader();
          await reader.read();
          await reader.read();
          // The Backend answered and closed the socket: the next write fails and
          // undici discards the answer, cancelling the request body like this.
          await reader.cancel(socketClosed(code));
          throw socketClosed(code);
        }),
      );
      const response = await POST(
        uploadRequest({ body: source, length: 64 * MiB }),
        context(),
      );
      await expectUnanswered(response, 502, "interrupted");
      const pullsAfterFailure = pulls;
      await nextTask();
      expect(pulls).toBe(pullsAfterFailure);
      expect(pulls).toBeLessThanOrEqual(3);
    },
  );

  it("marks a Backend connection lost after the last byte as interrupted", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async (_input, init) => {
        await readAll(init?.body);
        throw socketClosed("ECONNRESET");
      }),
    );
    const response = await POST(
      uploadRequest({ body: bytes(8), length: 8 }),
      context(),
    );
    await expectUnanswered(response, 502, "interrupted");
  });

  it("marks an answer whose body breaks off as interrupted", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async (_input, init) => {
        await readAll(init?.body);
        const broken = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('{"componentId":'));
          },
          pull(controller) {
            controller.error(socketClosed("ECONNRESET"));
          },
        });
        return new Response(broken, {
          headers: { "content-type": "application/json" },
        });
      }),
    );
    const response = await POST(
      uploadRequest({ body: bytes(8), length: 8 }),
      context(),
    );
    await expectUnanswered(response, 502, "interrupted");
  });

  it("accepts a declared length at the 8 GiB contract maximum", async () => {
    const eightGiB = 8 * 1024 * MiB;
    const upstream = vi.fn<typeof fetch>(async (_input, init) => {
      await (init?.body as ReadableStream<Uint8Array>).getReader().read();
      return Response.json(
        {
          error: {
            code: "CONFLICT",
            message: "The transfer was cancelled",
            requestId: "request-2",
          },
        },
        { status: 409 },
      );
    });
    vi.stubGlobal("fetch", upstream);
    const response = await POST(
      uploadRequest({
        body: new ReadableStream<Uint8Array>(
          {
            pull(controller) {
              controller.enqueue(bytes(MiB));
            },
          },
          { highWaterMark: 0 },
        ),
        length: eightGiB,
      }),
      context(),
    );
    expect(response.status).toBe(409);
    expect(upstream).toHaveBeenCalledOnce();
    expect(upstream.mock.calls[0]?.[1]?.headers).toMatchObject({
      "content-length": String(eightGiB),
    });
  });

  it.each([
    [
      "a foreign Origin",
      { headers: { origin: "https://foreign.invalid" } },
      403,
    ],
    [
      "an Origin that only matches a forwarded host",
      {
        headers: {
          origin: "https://foreign.invalid",
          "x-forwarded-host": "foreign.invalid",
        },
      },
      403,
    ],
    [
      "a same-site request",
      { headers: { "sec-fetch-site": "same-site" } },
      403,
    ],
    [
      "a cross-site request",
      { headers: { "sec-fetch-site": "cross-site" } },
      403,
    ],
    [
      "a user-initiated request (Fetch Metadata none)",
      { headers: { "sec-fetch-site": "none" } },
      403,
    ],
    [
      "an Origin with another protocol",
      { headers: { origin: "https://127.0.0.1:3420" } },
      403,
    ],
    [
      "an Origin with another port",
      { headers: { origin: "http://127.0.0.1:3421" } },
      403,
    ],
    [
      "an Origin with a path",
      { headers: { origin: "http://127.0.0.1:3420/" } },
      403,
    ],
    ["an opaque Origin", { headers: { origin: "null" } }, 403],
    ["a query string", { url: `${endpoint}?attempt=1` }, 404],
    ["a missing account", { omit: ["x-author-account"] }, 422],
    [
      "a malformed account",
      { headers: { "x-author-account": "user-123" } },
      422,
    ],
    ["a missing attempt", { omit: ["x-upload-attempt"] }, 422],
    [
      "a malformed attempt",
      { headers: { "x-upload-attempt": "attempt-1" } },
      422,
    ],
    ["a missing content type", { omit: ["content-type"] }, 422],
    [
      "a JSON content type",
      { headers: { "content-type": "application/json" } },
      422,
    ],
    [
      "a parameterized content type",
      { headers: { "content-type": "application/octet-stream; charset=x" } },
      422,
    ],
    ["a missing length", { omit: ["content-length"] }, 411],
    ["a non-numeric length", { length: "12abc" }, 422],
    ["a zero length", { length: 0 }, 422],
    ["a length over the 8 GiB ceiling", { length: 8 * 1024 * MiB + 1 }, 413],
    ["no session cookie", { omit: ["cookie"] }, 401],
  ] as const)(
    "refuses %s before contacting the Backend",
    async (_label, options, status) => {
      const upstream = vi.fn<typeof fetch>();
      vi.stubGlobal("fetch", upstream);
      const response = await POST(
        uploadRequest({ body: bytes(4), length: 4, ...options }),
        context(),
      );
      expect(response.status).toBe(status);
      expectPrivate(response);
      expect(await response.text()).toBe("");
      expect(upstream).not.toHaveBeenCalled();
    },
  );

  it.each([
    "media-component-123",
    `media-item-${"a".repeat(32)}`,
    `media-component-${"A".repeat(32)}`,
    `media-component-${"a".repeat(32)}/../x`,
  ])("refuses the component id %s", async (componentId) => {
    const upstream = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", upstream);
    const response = await POST(
      uploadRequest({ body: bytes(4), length: 4 }),
      context(componentId),
    );
    expect(response.status).toBe(404);
    expect(upstream).not.toHaveBeenCalled();
  });

  it("accepts a same-origin write without Fetch Metadata or Origin", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async (_input, init) =>
        Response.json(uploadResult((await readAll(init?.body)).bytes)),
      ),
    );
    const response = await POST(
      uploadRequest({
        body: bytes(4),
        length: 4,
        omit: ["origin", "sec-fetch-site"],
      }),
      context(),
    );
    expect(response.status).toBe(200);
  });

  it("answers 503 without contacting the Backend when its address is not configured", async () => {
    vi.stubEnv("MOYA_PUBLIC_API_BASE_URL", "");
    const upstream = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", upstream);
    const response = await POST(
      uploadRequest({ body: bytes(4), length: 4 }),
      context(),
    );
    expect(response.status).toBe(503);
    expect(upstream).not.toHaveBeenCalled();
  });

  it.each([
    ["more bytes than declared", 5, 4, 413],
    ["fewer bytes than declared", 3, 4, 422],
  ] as const)(
    "stops a body with %s",
    async (_label, actual, declared, status) => {
      vi.stubGlobal(
        "fetch",
        vi.fn<typeof fetch>(async (_input, init) => {
          await readAll(init?.body);
          return Response.json(uploadResult(actual));
        }),
      );
      const response = await POST(
        uploadRequest({
          body: new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(bytes(actual));
              controller.close();
            },
          }),
          length: declared,
        }),
        context(),
      );
      expect(response.status).toBe(status);
      expect(await response.text()).toBe("");
    },
  );

  it.each([200, 401, 403, 404, 409, 413, 422, 503])(
    "passes a JSON Backend status %i through",
    async (status) => {
      const body = { status };
      vi.stubGlobal(
        "fetch",
        vi.fn<typeof fetch>(async (_input, init) => {
          await readAll(init?.body);
          return Response.json(body, { status });
        }),
      );
      const response = await POST(
        uploadRequest({ body: bytes(8), length: 8 }),
        context(),
      );
      expect(response.status).toBe(status);
      expectPrivate(response);
      expect(response.headers.get("x-publishing-relay")).toBeNull();
      expect(await response.json()).toEqual(body);
    },
  );

  it.each([
    [
      "an unexpected status",
      () => Response.json({ error: "internal" }, { status: 500 }),
      502,
    ],
    [
      "a redirect status",
      () =>
        new Response(null, {
          status: 307,
          headers: { location: "https://elsewhere.invalid/" },
        }),
      502,
    ],
    [
      "a successful answer that is not JSON",
      () =>
        new Response("<html>", { headers: { "content-type": "text/html" } }),
      502,
    ],
    [
      "an oversized JSON answer",
      () => Response.json({ padding: "x".repeat(70 * 1024) }),
      502,
    ],
  ] as const)("refuses %s", async (_label, answer, status) => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async (_input, init) => {
        await readAll(init?.body);
        return answer();
      }),
    );
    const response = await POST(
      uploadRequest({ body: bytes(8), length: 8 }),
      context(),
    );
    await expectUnanswered(response, status, "invalid-answer");
  });

  it("keeps a non-JSON refusal status with an empty body", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(
        async () =>
          new Response("<html>too large</html>", {
            status: 413,
            headers: { "content-type": "text/html" },
          }),
      ),
    );
    const response = await POST(
      uploadRequest({ body: bytes(8), length: 8 }),
      context(),
    );
    expect(response.status).toBe(413);
    expect(response.headers.get("x-publishing-relay")).toBeNull();
    expect(await response.text()).toBe("");
  });

  it("marks a network failure or a refused redirect as interrupted", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn<typeof fetch>()
        .mockRejectedValue(new TypeError("fetch failed: redirect")),
    );
    const response = await POST(
      uploadRequest({ body: bytes(8), length: 8 }),
      context(),
    );
    await expectUnanswered(response, 502, "interrupted");
  });

  it("bounds only the wait for the answer after the last byte", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    let backendSignal: AbortSignal | undefined;
    let bodyRelayed!: () => void;
    const relayed = new Promise<void>((resolve) => {
      bodyRelayed = resolve;
    });
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async (_input, init) => {
        backendSignal = init?.signal ?? undefined;
        await readAll(init?.body);
        bodyRelayed();
        return new Promise<Response>((_resolve, reject) => {
          backendSignal?.addEventListener("abort", () =>
            reject(new DOMException("aborted", "AbortError")),
          );
        });
      }),
    );
    const pending = POST(
      uploadRequest({ body: bytes(16), length: 16 }),
      context(),
    );
    await relayed;
    await vi.advanceTimersByTimeAsync(59_999);
    expect(backendSignal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(backendSignal?.aborted).toBe(true);
    await expectUnanswered(await pending, 504, "timeout");
  });

  it("bounds an answer whose body stalls after its headers", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    let backendSignal: AbortSignal | undefined;
    let answered!: () => void;
    const headersSent = new Promise<void>((resolve) => {
      answered = resolve;
    });
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async (_input, init) => {
        backendSignal = init?.signal ?? undefined;
        await readAll(init?.body);
        const stalled = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('{"componentId":'));
            backendSignal?.addEventListener("abort", () =>
              controller.error(new DOMException("aborted", "AbortError")),
            );
          },
        });
        answered();
        return new Response(stalled, {
          headers: { "content-type": "application/json" },
        });
      }),
    );
    const pending = POST(
      uploadRequest({ body: bytes(16), length: 16 }),
      context(),
    );
    await headersSent;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(backendSignal?.aborted).toBe(true);
    await expectUnanswered(await pending, 504, "timeout");
  });
});

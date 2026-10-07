import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { GET } from "./route";

const MiB = 1024 * 1024;
const item = `media-item-${"c".repeat(32)}`;
const editKey = "d".repeat(32);
const session = "S".repeat(43);
const origin = "http://127.0.0.1:3420";
const backend = "http://backend.test/";

const params = (overrides: Partial<Record<string, string>> = {}) => ({
  params: Promise.resolve({
    itemId: item,
    variant: "motion",
    editKey,
    ...overrides,
  } as { itemId: string; variant: string; editKey: string }),
});

const mediaRequest = (
  options: {
    readonly headers?: Record<string, string>;
    readonly query?: string;
    readonly method?: string;
    readonly signal?: AbortSignal;
  } = {},
): Request =>
  new Request(
    `${origin}/api/community/publishing/media/${item}/motion/${editKey}${options.query ?? ""}`,
    {
      method: options.method ?? "GET",
      headers: {
        host: "127.0.0.1:3420",
        cookie: `yoyi-session=${session}`,
        ...options.headers,
      },
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    },
  );

const nextTask = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

const expectPrivate = (response: Response) => {
  expect(response.headers.get("cache-control")).toBe("private, no-store");
  expect(response.headers.get("vary")).toBe("Cookie");
  expect(response.headers.get("x-content-type-options")).toBe("nosniff");
};

beforeEach(() => {
  vi.stubEnv("NODE_ENV", "production");
  vi.stubEnv("MOYA_PUBLIC_API_BASE_URL", backend);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("work publishing media relay", () => {
  it("streams a ranged derivative back as the browser reads it", async () => {
    const chunkCount = 64;
    let produced = 0;
    let delivered = 0;
    const derivative = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          if (produced === chunkCount) {
            controller.close();
            return;
          }
          // Produced only after the browser read the previous chunk.
          if (produced !== delivered) {
            controller.error(new Error("the relay read ahead of the browser"));
            return;
          }
          produced += 1;
          controller.enqueue(new Uint8Array(MiB));
        },
      },
      { highWaterMark: 0 },
    );
    const upstream = vi.fn<typeof fetch>(
      async () =>
        new Response(derivative, {
          status: 206,
          headers: {
            "content-type": "video/mp4",
            "content-length": String(chunkCount * MiB),
            "content-range": `bytes 1024-${chunkCount * MiB + 1023}/${
              256 * MiB
            }`,
            "accept-ranges": "bytes",
            etag: '"private"',
            "set-cookie": "leak=1",
          },
        }),
    );
    vi.stubGlobal("fetch", upstream);

    const response = await GET(
      mediaRequest({
        headers: { range: `bytes=1024-${chunkCount * MiB + 1023}` },
      }),
      params(),
    );

    expect(response.status).toBe(206);
    expectPrivate(response);
    expect(response.headers.get("content-type")).toBe("video/mp4");
    expect(response.headers.get("content-length")).toBe(
      String(chunkCount * MiB),
    );
    expect(response.headers.get("content-range")).toBe(
      `bytes 1024-${chunkCount * MiB + 1023}/${256 * MiB}`,
    );
    expect(response.headers.get("accept-ranges")).toBe("bytes");
    expect(response.headers.get("cross-origin-resource-policy")).toBe(
      "same-origin",
    );
    expect(response.headers.get("etag")).toBeNull();
    expect(response.headers.get("set-cookie")).toBeNull();
    const reader = response.body!.getReader();
    let bytes = 0;
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      bytes += part.value.byteLength;
      delivered += 1;
      await nextTask();
    }
    expect(bytes).toBe(chunkCount * MiB);
    const [target, init] = upstream.mock.calls[0]!;
    expect(String(target)).toBe(
      `${backend}v1/community/publishing/media/${item}/motion/${editKey}`,
    );
    expect(init).toMatchObject({
      method: "GET",
      cache: "no-store",
      redirect: "error",
    });
    expect(init?.headers).toEqual({
      accept: "image/webp, image/jpeg, image/png, video/mp4",
      Authorization: `Bearer ${session}`,
      range: `bytes=1024-${chunkCount * MiB + 1023}`,
    });
  });

  it("reads anonymously without a session and without a range", async () => {
    const upstream = vi.fn<typeof fetch>(
      async () =>
        new Response(new Uint8Array([1, 2, 3]), {
          headers: { "content-type": "image/webp", "content-length": "3" },
        }),
    );
    vi.stubGlobal("fetch", upstream);
    const response = await GET(
      mediaRequest({ headers: { cookie: "theme=dark" } }),
      params({ variant: "thumb", editKey: "base" }),
    );
    expect(response.status).toBe(200);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(
      new Uint8Array([1, 2, 3]),
    );
    expect(response.headers.get("content-range")).toBeNull();
    expect(upstream.mock.calls[0]?.[1]?.headers).toEqual({
      accept: "image/webp, image/jpeg, image/png, video/mp4",
    });
    expect(String(upstream.mock.calls[0]?.[0])).toBe(
      `${backend}v1/community/publishing/media/${item}/thumb/base`,
    );
  });

  // unified-media-pipeline-v1: `viewer` is the bounded zoom still (CW7).
  it.each(["thumb", "display", "full", "cover", "motion", "viewer"])(
    "accepts the %s variant",
    async (variant) => {
      vi.stubGlobal(
        "fetch",
        vi.fn<typeof fetch>(
          async () =>
            new Response(new Uint8Array([1]), {
              headers: { "content-type": "image/jpeg" },
            }),
        ),
      );
      const response = await GET(mediaRequest(), params({ variant }));
      expect(response.status).toBe(200);
    },
  );

  it.each([
    ["an unknown variant", { variant: "original" }],
    ["a source variant", { variant: "still" }],
    ["a malformed item id", { itemId: "media-item-12" }],
    ["a component id", { itemId: `media-component-${"c".repeat(32)}` }],
    ["an upper-case edit key", { editKey: "D".repeat(32) }],
    ["a short edit key", { editKey: "d".repeat(31) }],
    ["a traversal edit key", { editKey: "../base" }],
  ])("refuses %s", async (_label, overrides) => {
    const upstream = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", upstream);
    const response = await GET(mediaRequest(), params(overrides));
    expect(response.status).toBe(404);
    expectPrivate(response);
    expect(upstream).not.toHaveBeenCalled();
  });

  it("refuses any query string", async () => {
    const upstream = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", upstream);
    const response = await GET(
      mediaRequest({ query: "?download=1" }),
      params(),
    );
    expect(response.status).toBe(404);
    expect(upstream).not.toHaveBeenCalled();
  });

  it.each([
    "bytes=0-1,4-5",
    "bytes=5-4",
    "bytes=-",
    "items=0-1",
    "bytes=0-1-2",
    "bytes=abc-",
  ])("refuses the range %s before contacting the Backend", async (range) => {
    const upstream = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", upstream);
    const response = await GET(mediaRequest({ headers: { range } }), params());
    expect(response.status).toBe(416);
    expectPrivate(response);
    expect(upstream).not.toHaveBeenCalled();
  });

  it.each(["bytes=0-", "bytes=100-199", "bytes=-500", "bytes=7-7"])(
    "forwards the single range %s",
    async (range) => {
      const upstream = vi.fn<typeof fetch>(
        async () =>
          new Response(new Uint8Array([1]), {
            status: 206,
            headers: {
              "content-type": "video/mp4",
              "content-range": "bytes 7-7/100",
            },
          }),
      );
      vi.stubGlobal("fetch", upstream);
      const response = await GET(
        mediaRequest({ headers: { range } }),
        params(),
      );
      expect(response.status).toBe(206);
      expect(
        (upstream.mock.calls[0]?.[1]?.headers as Record<string, string>).range,
      ).toBe(range);
    },
  );

  it("passes an unsatisfiable range answer with its size", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(
        async () =>
          new Response("nope", {
            status: 416,
            headers: {
              "content-range": "bytes */100",
              "content-type": "text/plain",
            },
          }),
      ),
    );
    const response = await GET(
      mediaRequest({ headers: { range: "bytes=200-" } }),
      params(),
    );
    expect(response.status).toBe(416);
    expect(response.headers.get("content-range")).toBe("bytes */100");
    expect(response.headers.get("content-type")).toBeNull();
    expect(await response.text()).toBe("");
  });

  it.each([
    [401, 401],
    // The product access policy's refusal for a signed-in account.
    [403, 403],
    [404, 404],
    [503, 503],
    [500, 502],
    [302, 502],
  ])(
    "maps a Backend status %i to %i with an empty body",
    async (upstreamStatus, status) => {
      let cancelled = false;
      vi.stubGlobal(
        "fetch",
        vi.fn<typeof fetch>(
          async () =>
            new Response(
              new ReadableStream({
                cancel() {
                  cancelled = true;
                },
              }),
              {
                status: upstreamStatus,
                headers: { "content-type": "application/json" },
              },
            ),
        ),
      );
      const response = await GET(mediaRequest(), params());
      expect(response.status).toBe(status);
      expectPrivate(response);
      expect(await response.text()).toBe("");
      expect(cancelled).toBe(true);
    },
  );

  it.each([
    ["an HTML body", { "content-type": "text/html" }],
    ["an SVG image", { "content-type": "image/svg+xml" }],
    ["a QuickTime source", { "content-type": "video/quicktime" }],
    ["a HEIC source", { "content-type": "image/heic" }],
    ["no content type", {}],
    [
      "a malformed length",
      { "content-type": "image/webp", "content-length": "12, 13" },
    ],
  ])("refuses a derivative answer with %s", async (_label, headers) => {
    let cancelled = false;
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async () => {
        const response = new Response(
          new ReadableStream({
            cancel() {
              cancelled = true;
            },
          }),
          { headers },
        );
        if (!("content-type" in headers))
          response.headers.delete("content-type");
        return response;
      }),
    );
    const response = await GET(mediaRequest(), params());
    expect(response.status).toBe(502);
    expect(await response.text()).toBe("");
    expect(cancelled).toBe(true);
  });

  it("refuses a partial answer without a valid content range", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(
        async () =>
          new Response(new Uint8Array([1]), {
            status: 206,
            headers: { "content-type": "video/mp4" },
          }),
      ),
    );
    const response = await GET(
      mediaRequest({ headers: { range: "bytes=0-" } }),
      params(),
    );
    expect(response.status).toBe(502);
  });

  it("aborts the Backend read when the browser goes away", async () => {
    const browser = new AbortController();
    let backendSignal: AbortSignal | undefined;
    let cancelled = false;
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async (_input, init) => {
        backendSignal = init?.signal ?? undefined;
        return new Response(
          new ReadableStream<Uint8Array>(
            {
              pull(controller) {
                controller.enqueue(new Uint8Array(MiB));
              },
              cancel() {
                cancelled = true;
              },
            },
            { highWaterMark: 0 },
          ),
          { headers: { "content-type": "video/mp4" } },
        );
      }),
    );
    const response = await GET(
      mediaRequest({ signal: browser.signal }),
      params(),
    );
    const reader = response.body!.getReader();
    await reader.read();
    browser.abort();
    expect(backendSignal?.aborted).toBe(true);
    // Next cancels the response stream when the socket closes.
    await reader.cancel();
    expect(cancelled).toBe(true);
  });

  it("answers HEAD with headers only and releases the Backend body", async () => {
    let cancelled = false;
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(
        async () =>
          new Response(
            new ReadableStream({
              cancel() {
                cancelled = true;
              },
            }),
            { headers: { "content-type": "image/png", "content-length": "9" } },
          ),
      ),
    );
    const response = await GET(mediaRequest({ method: "HEAD" }), params());
    expect(response.status).toBe(200);
    expect(response.headers.get("content-length")).toBe("9");
    expect(response.body).toBeNull();
    expect(cancelled).toBe(true);
  });

  it("bounds the wait for the Backend's response headers", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    let backendSignal: AbortSignal | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(
        (_input, init) =>
          new Promise<Response>((_resolve, reject) => {
            backendSignal = init?.signal ?? undefined;
            backendSignal?.addEventListener("abort", () =>
              reject(new DOMException("aborted", "AbortError")),
            );
          }),
      ),
    );
    const pending = GET(mediaRequest(), params());
    await vi.advanceTimersByTimeAsync(14_999);
    expect(backendSignal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect((await pending).status).toBe(503);
  });

  it("maps a network failure or a refused redirect to 503", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockRejectedValue(new TypeError("fetch failed")),
    );
    const response = await GET(mediaRequest(), params());
    expect(response.status).toBe(503);
    expectPrivate(response);
  });
});

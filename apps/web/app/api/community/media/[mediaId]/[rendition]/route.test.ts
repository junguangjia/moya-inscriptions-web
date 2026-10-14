import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { GET } from "./route";

/*
 * profile-media-renditions-v1: the Backend authorizes every read and tags
 * only a current image; Web turns that answer (and the Backend's 304 for it)
 * into private revalidation, keeps an untagged owner-only answer and every
 * refusal private, no-store, and streams the bytes.
 */
const KiB = 1024;
const mediaId = `user-media-${"a".repeat(32)}`;
const session = "S".repeat(43);
const origin = "http://127.0.0.1:3420";
const backend = "http://backend.test/";
const tag = `"${"b".repeat(64)}"`;
const otherTag = `"${"c".repeat(64)}"`;

const params = (overrides: Partial<Record<string, string>> = {}) => ({
  params: Promise.resolve({
    mediaId,
    rendition: "avatar-128",
    ...overrides,
  } as { mediaId: string; rendition: string }),
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
    `${origin}/api/community/media/${mediaId}/avatar-128${options.query ?? ""}`,
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

const webp = (
  headers: Record<string, string> = {},
  status = 200,
  body: BodyInit | null = new Uint8Array([82, 73, 70, 70]),
) =>
  new Response(body, {
    status,
    headers: {
      "content-type": "image/webp",
      "content-length": "4",
      "cache-control": "private, no-store",
      vary: "Authorization",
      ...headers,
    },
  });

/** A Backend answer whose body records being released. */
const releasing = (
  status: number,
  headers: Record<string, string> = {},
): { response: Response; cancelled: () => boolean } => {
  let cancelled = false;
  return {
    response: new Response(
      new ReadableStream({
        cancel() {
          cancelled = true;
        },
      }),
      { status, headers },
    ),
    cancelled: () => cancelled,
  };
};

/** The Backend's answer to a matching validator: headers only. */
const notModified = (headers: Record<string, string>) =>
  new Response(null, { status: 304, headers });

const upstreamOnce = (...answers: Response[]) => {
  const upstream = vi.fn<typeof fetch>();
  for (const answer of answers) upstream.mockResolvedValueOnce(answer);
  vi.stubGlobal("fetch", upstream);
  return upstream;
};

const sentHeaders = (upstream: ReturnType<typeof upstreamOnce>, call = 0) =>
  upstream.mock.calls[call]?.[1]?.headers as Record<string, string>;

const nextTask = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

const expectNoStore = (response: Response) => {
  expect(response.headers.get("cache-control")).toBe("private, no-store");
  expect(response.headers.get("vary")).toBe("Cookie");
  expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  expect(response.headers.get("etag")).toBeNull();
};

const expectRevalidated = (response: Response) => {
  expect(response.headers.get("cache-control")).toBe("private, no-cache");
  expect(response.headers.get("vary")).toBe("Cookie");
  expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  expect(response.headers.get("etag")).toBe(tag);
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

describe("profile media rendition relay", () => {
  it("streams a current rendition back as the browser reads it, under private revalidation", async () => {
    const chunkCount = 16;
    let produced = 0;
    let delivered = 0;
    const rendition = new ReadableStream<Uint8Array>(
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
          controller.enqueue(new Uint8Array(KiB));
        },
      },
      { highWaterMark: 0 },
    );
    const upstream = upstreamOnce(
      webp(
        {
          "content-length": String(chunkCount * KiB),
          "accept-ranges": "bytes",
          "cross-origin-resource-policy": "same-origin",
          etag: tag,
          "set-cookie": "leak=1",
        },
        200,
        rendition,
      ),
    );

    const response = await GET(mediaRequest(), params());

    expect(response.status).toBe(200);
    expectRevalidated(response);
    expect(response.headers.get("content-type")).toBe("image/webp");
    expect(response.headers.get("content-length")).toBe(
      String(chunkCount * KiB),
    );
    expect(response.headers.get("accept-ranges")).toBe("bytes");
    expect(response.headers.get("cross-origin-resource-policy")).toBe(
      "same-origin",
    );
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
    expect(bytes).toBe(chunkCount * KiB);
    const [target, init] = upstream.mock.calls[0]!;
    expect(String(target)).toBe(
      `${backend}v1/community/media/${mediaId}/avatar-128`,
    );
    expect(init).toMatchObject({
      method: "GET",
      cache: "no-store",
      redirect: "error",
    });
    expect(init?.headers).toEqual({
      accept: "image/webp",
      Authorization: `Bearer ${session}`,
    });
  });

  it("keeps an owner-only answer without a validator private, no-store", async () => {
    upstreamOnce(webp());
    const response = await GET(
      mediaRequest({ headers: { "if-none-match": tag } }),
      params({ rendition: "background-1600" }),
    );
    expect(response.status).toBe(200);
    expectNoStore(response);
    expect(response.headers.get("cross-origin-resource-policy")).toBe(
      "same-origin",
    );
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(
      new Uint8Array([82, 73, 70, 70]),
    );
  });

  it("reads anonymously without a session", async () => {
    const upstream = upstreamOnce(webp({ etag: tag }));
    const response = await GET(
      mediaRequest({ headers: { cookie: "theme=dark" } }),
      params({ rendition: "avatar-512" }),
    );
    expect(response.status).toBe(200);
    expectRevalidated(response);
    expect(sentHeaders(upstream)).toEqual({ accept: "image/webp" });
    expect(String(upstream.mock.calls[0]?.[0])).toBe(
      `${backend}v1/community/media/${mediaId}/avatar-512`,
    );
  });

  it.each(["avatar-128", "avatar-512", "background-960", "background-1600"])(
    "accepts the %s rendition",
    async (rendition) => {
      upstreamOnce(webp({ etag: tag }));
      const response = await GET(mediaRequest(), params({ rendition }));
      expect(response.status).toBe(200);
    },
  );

  it.each([
    ["an unknown rendition", { rendition: "avatar-256" }],
    ["a work rendition", { rendition: "thumb" }],
    ["the original", { rendition: "original" }],
    ["an upper-case rendition", { rendition: "AVATAR-128" }],
    ["a malformed media id", { mediaId: "user-media-12" }],
    ["an upper-case media id", { mediaId: `user-media-${"A".repeat(32)}` }],
    ["a media item id", { mediaId: `media-item-${"a".repeat(32)}` }],
    ["a traversal id", { mediaId: "../me" }],
  ])("refuses %s before contacting the Backend", async (_label, overrides) => {
    const upstream = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", upstream);
    const response = await GET(mediaRequest(), params(overrides));
    expect(response.status).toBe(404);
    expectNoStore(response);
    expect(upstream).not.toHaveBeenCalled();
  });

  it.each(["?width=64", "?v=1&download=1"])(
    "refuses the query string %s before contacting the Backend",
    async (query) => {
      const upstream = vi.fn<typeof fetch>();
      vi.stubGlobal("fetch", upstream);
      const response = await GET(mediaRequest({ query }), params());
      expect(response.status).toBe(404);
      expectNoStore(response);
      expect(upstream).not.toHaveBeenCalled();
    },
  );

  it("answers 503 without a configured Backend", async () => {
    vi.stubEnv("MOYA_PUBLIC_API_BASE_URL", "");
    const upstream = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", upstream);
    const response = await GET(mediaRequest(), params());
    expect(response.status).toBe(503);
    expectNoStore(response);
    expect(upstream).not.toHaveBeenCalled();
  });
});

describe("profile media revalidation", () => {
  it.each([
    ["the exact tag", tag],
    ["the weak form", `W/${tag}`],
    ["a list", `${otherTag}, W/${tag}`],
    ["a list without spaces", `${otherTag},${tag}`],
    ["any representation", "*"],
  ])(
    "forwards %s and passes the Backend's 304 without a body",
    async (_label, validators) => {
      const upstream = upstreamOnce(notModified({ etag: tag }));
      const response = await GET(
        mediaRequest({ headers: { "if-none-match": validators } }),
        params(),
      );
      expect(response.status).toBe(304);
      expectRevalidated(response);
      expect(response.headers.get("content-type")).toBeNull();
      expect(await response.text()).toBe("");
      expect(sentHeaders(upstream)["if-none-match"]).toBe(validators);
    },
  );

  it.each([
    ["an unquoted tag", "b".repeat(64)],
    ["a lower-case weak prefix", `w/${tag}`],
    ["an upper-case tag", `"${"B".repeat(64)}"`],
    ["a short tag", `"${"b".repeat(63)}"`],
    ["another validator form", '"v1"'],
    ["a trailing comma", `${tag},`],
    ["a list above 1 KiB", Array.from({ length: 16 }, () => tag).join(", ")],
  ])(
    "drops %s, so the Backend sends the image again",
    async (_label, validators) => {
      const upstream = upstreamOnce(webp({ etag: tag }));
      const response = await GET(
        mediaRequest({ headers: { "if-none-match": validators } }),
        params(),
      );
      expect(response.status).toBe(200);
      expect(sentHeaders(upstream)).not.toHaveProperty("if-none-match");
    },
  );

  it("forwards a list of exactly 1 KiB", async () => {
    // Fifteen tags and fourteen ", " separators, padded with spaces to 1024.
    const list = Array.from({ length: 15 }, () => tag).join(", ");
    const validators = list.replace(
      ", ",
      `${" ".repeat(1024 - list.length)}, `,
    );
    expect(validators).toHaveLength(1024);
    const upstream = upstreamOnce(notModified({ etag: tag }));
    const response = await GET(
      mediaRequest({ headers: { "if-none-match": validators } }),
      params(),
    );
    expect(response.status).toBe(304);
    expect(sentHeaders(upstream)["if-none-match"]).toBe(validators);
  });

  it.each([
    ["without a validator", {}, tag],
    ["with a weak validator", { etag: `W/${tag}` }, tag],
    ["nobody asked for", { etag: tag }, undefined],
  ])("refuses a 304 %s", async (_label, headers, validators) => {
    upstreamOnce(notModified(headers));
    const response = await GET(
      mediaRequest(
        validators === undefined
          ? {}
          : { headers: { "if-none-match": validators } },
      ),
      params(),
    );
    expect(response.status).toBe(502);
    expectNoStore(response);
  });

  it.each([
    ["a malformed validator", '"v1"'],
    ["two validators", `${tag}, ${otherTag}`],
  ])("refuses a rendition with %s", async (_label, etag) => {
    const answer = releasing(200, { "content-type": "image/webp", etag });
    upstreamOnce(answer.response);
    const response = await GET(mediaRequest(), params());
    expect(response.status).toBe(502);
    expectNoStore(response);
    expect(await response.text()).toBe("");
    expect(answer.cancelled()).toBe(true);
  });
});

describe("profile media answers outside a rendition", () => {
  it.each([
    [401, 401],
    // The product access policy's refusal for a signed-in account.
    [403, 403],
    // A replaced, cleared, blocked, suspended, erased or unknown image.
    [404, 404],
    [503, 503],
    [422, 502],
    [409, 502],
    [500, 502],
    [302, 502],
  ])(
    "maps a Backend status %i to %i with an empty body",
    async (upstreamStatus, status) => {
      const answer = releasing(upstreamStatus, {
        "content-type": "application/json",
        etag: tag,
      });
      upstreamOnce(answer.response);
      const response = await GET(
        mediaRequest({ headers: { cookie: "theme=dark" } }),
        params(),
      );
      expect(response.status).toBe(status);
      expectNoStore(response);
      expect(response.headers.get("content-type")).toBeNull();
      expect(await response.text()).toBe("");
      expect(answer.cancelled()).toBe(true);
    },
  );

  it.each([
    ["a PNG", { "content-type": "image/png" }],
    ["a JPEG", { "content-type": "image/jpeg" }],
    ["an HTML body", { "content-type": "text/html" }],
    ["an SVG image", { "content-type": "image/svg+xml" }],
    ["no content type", {}],
    [
      "a malformed length",
      { "content-type": "image/webp", "content-length": "12, 13" },
    ],
  ])("refuses a rendition answer with %s", async (_label, headers) => {
    const answer = releasing(200, { etag: tag, ...headers });
    if (!("content-type" in headers))
      answer.response.headers.delete("content-type");
    upstreamOnce(answer.response);
    const response = await GET(mediaRequest(), params());
    expect(response.status).toBe(502);
    expectNoStore(response);
    expect(await response.text()).toBe("");
    expect(answer.cancelled()).toBe(true);
  });
});

describe("profile media ranges", () => {
  it.each(["bytes=0-1,4-5", "bytes=5-4", "bytes=-", "items=0-1", "bytes=abc-"])(
    "refuses the range %s before contacting the Backend",
    async (range) => {
      const upstream = vi.fn<typeof fetch>();
      vi.stubGlobal("fetch", upstream);
      const response = await GET(
        mediaRequest({ headers: { range } }),
        params(),
      );
      expect(response.status).toBe(416);
      expectNoStore(response);
      expect(upstream).not.toHaveBeenCalled();
    },
  );

  it("forwards one range and passes a current partial answer", async () => {
    const upstream = upstreamOnce(
      webp(
        { etag: tag, "content-length": "2", "content-range": "bytes 2-3/4" },
        206,
        new Uint8Array([70, 70]),
      ),
    );
    const response = await GET(
      mediaRequest({ headers: { range: "bytes=2-" } }),
      params(),
    );
    expect(response.status).toBe(206);
    expectRevalidated(response);
    expect(response.headers.get("content-range")).toBe("bytes 2-3/4");
    expect(sentHeaders(upstream).range).toBe("bytes=2-");
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(
      new Uint8Array([70, 70]),
    );
  });

  it("refuses a partial answer without a valid content range", async () => {
    upstreamOnce(webp({ etag: tag }, 206));
    const response = await GET(
      mediaRequest({ headers: { range: "bytes=0-" } }),
      params(),
    );
    expect(response.status).toBe(502);
  });

  it("passes an unsatisfiable range answer with its size only", async () => {
    upstreamOnce(
      new Response("nope", {
        status: 416,
        headers: {
          "content-range": "bytes */4",
          "content-type": "text/plain",
          etag: tag,
        },
      }),
    );
    const response = await GET(
      mediaRequest({ headers: { range: "bytes=9-" } }),
      params(),
    );
    expect(response.status).toBe(416);
    expectNoStore(response);
    expect(response.headers.get("content-range")).toBe("bytes */4");
    expect(response.headers.get("content-type")).toBeNull();
    expect(await response.text()).toBe("");
  });
});

describe("profile media with a Session the Backend no longer accepts", () => {
  const refused = () =>
    Response.json({ error: { code: "UNAUTHENTICATED" } }, { status: 401 });

  it("clears the cookie and reads the image again as signed out", async () => {
    const upstream = upstreamOnce(refused(), refused(), webp({ etag: tag }));
    const response = await GET(
      mediaRequest({ headers: { "if-none-match": otherTag } }),
      params(),
    );
    expect(response.status).toBe(200);
    expectRevalidated(response);
    expect(response.headers.get("set-cookie")).toMatch(
      /^yoyi-session=; .*Max-Age=0/u,
    );
    expect(upstream).toHaveBeenCalledTimes(3);
    expect(String(upstream.mock.calls[1]![0])).toBe(`${backend}v1/me`);
    expect(sentHeaders(upstream, 0).Authorization).toBe(`Bearer ${session}`);
    expect(sentHeaders(upstream, 2)).toEqual({
      accept: "image/webp",
      "if-none-match": otherTag,
    });
  });

  it("keeps the cleared cookie on a refusal of the signed-out read", async () => {
    upstreamOnce(refused(), refused(), refused());
    const response = await GET(mediaRequest(), params());
    expect(response.status).toBe(401);
    expectNoStore(response);
    expect(response.headers.get("set-cookie")).toMatch(
      /^yoyi-session=; .*Max-Age=0/u,
    );
  });

  it("keeps a Session the Backend still accepts", async () => {
    const upstream = upstreamOnce(
      refused(),
      Response.json({ id: `user-${"1".repeat(32)}` }),
    );
    const response = await GET(mediaRequest(), params());
    expect(response.status).toBe(401);
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(upstream).toHaveBeenCalledTimes(2);
  });

  it("never asks `me` when no Session was presented", async () => {
    const upstream = upstreamOnce(refused());
    const response = await GET(
      mediaRequest({ headers: { cookie: "theme=dark" } }),
      params(),
    );
    expect(response.status).toBe(401);
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(upstream).toHaveBeenCalledOnce();
  });
});

describe("profile media transport", () => {
  it("answers HEAD with headers only and releases the Backend body", async () => {
    const answer = releasing(200, {
      "content-type": "image/webp",
      "content-length": "9",
      etag: tag,
    });
    const upstream = upstreamOnce(answer.response);
    const response = await GET(mediaRequest({ method: "HEAD" }), params());
    expect(response.status).toBe(200);
    expectRevalidated(response);
    expect(response.headers.get("content-length")).toBe("9");
    expect(response.body).toBeNull();
    expect(answer.cancelled()).toBe(true);
    expect(upstream.mock.calls[0]?.[1]?.method).toBe("GET");
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
                controller.enqueue(new Uint8Array(KiB));
              },
              cancel() {
                cancelled = true;
              },
            },
            { highWaterMark: 0 },
          ),
          { headers: { "content-type": "image/webp", etag: tag } },
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
    const response = await pending;
    expect(response.status).toBe(503);
    expectNoStore(response);
  });

  it("maps a network failure or a refused redirect to 503", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockRejectedValue(new TypeError("fetch failed")),
    );
    const response = await GET(mediaRequest(), params());
    expect(response.status).toBe(503);
    expectNoStore(response);
  });
});

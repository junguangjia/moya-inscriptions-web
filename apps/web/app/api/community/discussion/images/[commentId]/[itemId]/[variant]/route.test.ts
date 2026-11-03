import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GET, HEAD } from "./route";

const syntheticUnrelated = "EXPLICIT_SYNTHETIC_PLACEHOLDER";
const commentId = "comment-" + "a".repeat(32);
const itemId = "media-item-" + "b".repeat(32);
const session = "S".repeat(43); // Explicit synthetic session-shaped sample.
const base = "http://backend.test/";
const path = `/api/community/discussion/images/${commentId}/${itemId}/display`;
const params = (override: Record<string, string> = {}) => ({
  params: Promise.resolve({
    commentId,
    itemId,
    variant: "display",
    ...override,
  }),
});
const request = (
  options: {
    method?: string;
    headers?: Record<string, string>;
    query?: string;
    signal?: AbortSignal;
  } = {},
) =>
  new Request("http://web.test" + path + (options.query ?? ""), {
    method: options.method ?? "GET",
    ...(options.headers ? { headers: options.headers } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
  });
const image = (headers: Record<string, string> = {}, status = 200) =>
  new Response(new Uint8Array([1, 2, 3, 4]), {
    status,
    headers: {
      "content-type": "image/webp",
      "content-length": "4",
      ...headers,
    },
  });
const expectPrivate = (response: Response) => {
  expect(response.headers.get("cache-control")).toBe("private, no-store");
  expect(response.headers.get("vary")).toBe("Cookie, Range");
  expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  expect(response.headers.get("cross-origin-resource-policy")).toBe(
    "same-origin",
  );
};
beforeEach(() => vi.stubEnv("MOYA_PUBLIC_API_BASE_URL", base));
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("discussion image route", () => {
  it("streams a response larger than the business JSON cap without buffering", async () => {
    let produced = 0;
    const chunks = 64;
    const upstream = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        new ReadableStream({
          pull(stream) {
            if (produced === chunks) return stream.close();
            produced++;
            stream.enqueue(new Uint8Array(128 * 1024));
          },
        }),
        { headers: { "content-type": "image/webp" } },
      ),
    );
    vi.stubGlobal("fetch", upstream);
    const response = await GET(request(), params());
    expectPrivate(response);
    expect(produced).toBeLessThan(4);
    expect((await response.arrayBuffer()).byteLength).toBe(8 * 1024 * 1024);
    expect(String(upstream.mock.calls[0]?.[0])).toBe(
      base + `v1/community/discussion/images/${commentId}/${itemId}/display`,
    );
    const sent = upstream.mock.calls[0]?.[1];
    expect(new Headers(sent?.headers).get("authorization")).toBeNull();
    expect(sent?.cache).toBe("no-store");
    expect(sent?.redirect).toBe("error");
  });
  it("forwards only the cookie credential and a single byte range", async () => {
    const upstream = vi.fn<typeof fetch>().mockResolvedValue(
      image(
        {
          "content-range": "bytes 0-3/100",
          "accept-ranges": "bytes",
        },
        206,
      ),
    );
    vi.stubGlobal("fetch", upstream);
    const response = await GET(
      request({
        headers: {
          cookie: `yoyi-session=${session}; payload-token=${syntheticUnrelated}`,
          authorization: `Bearer ${syntheticUnrelated}`,
          range: "bytes=0-3",
        },
      }),
      params(),
    );
    const sent = new Headers(upstream.mock.calls[0]?.[1]?.headers);
    expect(sent.get("authorization")).toBe(`Bearer ${session}`);
    expect(sent.get("cookie")).toBeNull();
    expect(sent.get("range")).toBe("bytes=0-3");
    expect(response.status).toBe(206);
    expect(response.headers.get("content-range")).toBe("bytes 0-3/100");
    await response.arrayBuffer();
  });
  it("rejects unknown IDs, variants, queries and multiple ranges before fetch", async () => {
    const upstream = vi.fn();
    vi.stubGlobal("fetch", upstream);
    for (const value of [
      params({ commentId: "../other" }),
      params({ itemId: "source-object" }),
      params({ variant: "original" }),
      params({ variant: "motion" }),
    ])
      expect((await GET(request(), value)).status).toBe(404);
    expect(
      (await GET(request({ query: "?source=other" }), params())).status,
    ).toBe(404);
    expect(
      (await GET(request({ headers: { range: "bytes=0-3,5-9" } }), params()))
        .status,
    ).toBe(416);
    expect(upstream).not.toHaveBeenCalled();
  });
  it("returns current permission refusals without falling back to generic media", async () => {
    const upstream = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(null, { status: 404 }));
    vi.stubGlobal("fetch", upstream);
    const response = await GET(request(), params());
    expect(response.status).toBe(404);
    expectPrivate(response);
    expect(upstream).toHaveBeenCalledTimes(1);
  });
  it("clears an expired session and retries the same association anonymously", async () => {
    const upstream = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 401 }))
      .mockResolvedValueOnce(new Response(null, { status: 401 }))
      .mockResolvedValueOnce(image());
    vi.stubGlobal("fetch", upstream);
    const response = await GET(
      request({ headers: { cookie: `yoyi-session=${session}` } }),
      params(),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("set-cookie")).toContain("Max-Age=0");
    expect(
      new Headers(upstream.mock.calls[2]?.[1]?.headers).get("authorization"),
    ).toBeNull();
    expect(String(upstream.mock.calls[2]?.[0])).toBe(
      String(upstream.mock.calls[0]?.[0]),
    );
    await response.arrayBuffer();
  });
  it("does not clear or downgrade a still-valid session on an image refusal", async () => {
    const upstream = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 401 }))
      .mockResolvedValueOnce(Response.json({ current: true }));
    vi.stubGlobal("fetch", upstream);
    const response = await GET(
      request({ headers: { cookie: `yoyi-session=${session}` } }),
      params(),
    );
    expect(response.status).toBe(401);
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(upstream).toHaveBeenCalledTimes(2);
  });
  it.each(["text/html", "image/svg+xml", "video/mp4"])(
    "refuses %s bytes",
    async (type) => {
      vi.stubGlobal(
        "fetch",
        vi
          .fn<typeof fetch>()
          .mockResolvedValue(image({ "content-type": type })),
      );
      expect((await GET(request(), params())).status).toBe(502);
    },
  );
  it("cancels HEAD bodies and exposes only authorized response headers", async () => {
    let cancelled = false;
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockResolvedValue(
        new Response(
          new ReadableStream({
            cancel() {
              cancelled = true;
            },
          }),
          {
            headers: {
              "content-type": "image/jpeg",
              "content-length": "4",
              "set-cookie": "upstream-only-synthetic",
            },
          },
        ),
      ),
    );
    const response = await HEAD(
      request({ method: "HEAD" }),
      params({ variant: "full" }),
    );
    expect(response.status).toBe(200);
    expect(response.body).toBeNull();
    expect(cancelled).toBe(true);
    expect(response.headers.get("set-cookie")).toBeNull();
  });
  it("aborts the Backend when the browser stops reading", async () => {
    let cancelled = false;
    const upstream = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        new ReadableStream({
          cancel() {
            cancelled = true;
          },
        }),
        { headers: { "content-type": "image/png" } },
      ),
    );
    vi.stubGlobal("fetch", upstream);
    const response = await GET(request(), params());
    await response.body!.cancel();
    expect(cancelled).toBe(true);
    expect(upstream.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
  });
});

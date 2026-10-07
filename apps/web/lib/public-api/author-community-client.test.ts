import { afterEach, describe, expect, it, vi } from "vitest";
import {
  authorClient,
  authorRequest,
  PRODUCT_ACCESS_REFUSED_EVENT,
} from "./author-community-client";

afterEach(() => {
  authorClient.setAccount(null);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("shared private author transport", () => {
  it("retires document reads on navigation and permits reads after BFCache restoration", async () => {
    const document = new EventTarget();
    vi.stubGlobal("window", document);
    const fetch = vi.fn(
      (_url: string, options: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          options.signal!.addEventListener("abort", () =>
            reject(options.signal!.reason),
          );
        }),
    );
    vi.stubGlobal("fetch", fetch);
    const pending = authorRequest("threads", { parse: (value) => value });
    document.dispatchEvent(new Event("pagehide"));
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    await expect(
      authorRequest("threads", { parse: (value) => value }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(fetch).toHaveBeenCalledTimes(1);
    document.dispatchEvent(new Event("pageshow"));
    fetch.mockResolvedValue(new Response('{"items":[]}', { status: 200 }));
    await expect(
      authorRequest("threads", { parse: (value) => value }),
    ).resolves.toEqual({ items: [] });
    expect(fetch.mock.calls[1]![1].signal!.aborted).toBe(false);
  });

  it("reads live from a back/forward-cache document as soon as it is visible again, before pageshow", async () => {
    const owner = new EventTarget();
    const visibility = {
      visibilityState: "visible" as DocumentVisibilityState,
    };
    vi.stubGlobal("window", owner);
    vi.stubGlobal("document", visibility);
    const fetch = vi.fn(
      (_url: string, options: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          options.signal!.addEventListener("abort", () =>
            reject(options.signal!.reason),
          );
        }),
    );
    vi.stubGlobal("fetch", fetch);
    const pending = authorRequest("access", { parse: (value) => value });
    // Entering the back/forward cache: hidden, then a persisted pagehide.
    visibility.visibilityState = "hidden";
    owner.dispatchEvent(
      Object.assign(new Event("pagehide"), { persisted: true }),
    );
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    await expect(
      authorRequest("access", { parse: (value) => value }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(fetch).toHaveBeenCalledTimes(1);
    // Restored: the document is visible again before any pageshow listener
    // runs, and an earlier listener (the access watcher) reads at once.
    visibility.visibilityState = "visible";
    fetch.mockResolvedValue(
      new Response('{"mode":"closed_beta","access":"sign_in_required"}', {
        status: 200,
      }),
    );
    await expect(
      authorRequest("access", { parse: (value) => value }),
    ).resolves.toEqual({ mode: "closed_beta", access: "sign_in_required" });
    expect(fetch.mock.calls[1]![1].signal!.aborted).toBe(false);
  });

  it("never reads again from an unloaded document, even if it still reports visible", async () => {
    const owner = new EventTarget();
    vi.stubGlobal("window", owner);
    vi.stubGlobal("document", { visibilityState: "visible" });
    const fetch = vi.fn(
      (_url: string, options: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          options.signal!.addEventListener("abort", () =>
            reject(options.signal!.reason),
          );
        }),
    );
    vi.stubGlobal("fetch", fetch);
    const pending = authorRequest("threads", { parse: (value) => value });
    owner.dispatchEvent(
      Object.assign(new Event("pagehide"), { persisted: false }),
    );
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    await expect(
      authorRequest("threads", { parse: (value) => value }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("keeps commands active and does not retire reads merely on focus loss", async () => {
    authorClient.setAccount("synthetic-owner");
    const document = new EventTarget();
    vi.stubGlobal("window", document);
    let readSignal!: AbortSignal;
    let writeSignal!: AbortSignal;
    let complete!: (response: Response) => void;
    vi.stubGlobal(
      "fetch",
      vi.fn((_url: string, options: RequestInit) => {
        if (options.method === "GET") {
          readSignal = options.signal!;
          return new Promise<Response>((_resolve, reject) =>
            readSignal.addEventListener("abort", () =>
              reject(readSignal.reason),
            ),
          );
        }
        writeSignal = options.signal!;
        return new Promise<Response>((resolve) => {
          complete = resolve;
        });
      }),
    );
    const read = authorRequest("threads", { parse: (value) => value });
    const write = authorRequest(
      "command",
      { parse: (value) => value },
      { method: "POST", body: {} },
    );
    document.dispatchEvent(new Event("blur"));
    expect(readSignal.aborted).toBe(false);
    expect(writeSignal.aborted).toBe(false);
    document.dispatchEvent(new Event("pagehide"));
    await expect(read).rejects.toMatchObject({ name: "AbortError" });
    expect(writeSignal.aborted).toBe(false);
    complete(new Response('{"accepted":true}', { status: 200 }));
    await expect(write).resolves.toEqual({ accepted: true });
  });

  it("handles a successful empty revocation response without JSON parsing", async () => {
    authorClient.setAccount("synthetic-owner");
    const response = new Response(null, { status: 204 });
    const json = vi.spyOn(response, "json");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response));
    await expect(
      authorRequest(
        "article-authoring/connections/synthetic",
        {
          parse: (value) => {
            if (value !== null) throw new Error("Expected empty response");
            return null;
          },
        },
        { method: "DELETE" },
      ),
    ).resolves.toBeNull();
    expect(json).not.toHaveBeenCalled();
  });

  it("rejects an old private read if A to B to A occurs while its body is parsing", async () => {
    authorClient.setAccount("synthetic-owner-a");
    let releaseBody!: (value: unknown) => void;
    let started!: () => void;
    const body = new Promise<unknown>((resolve) => {
      releaseBody = resolve;
    });
    const bodyStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    const response = new Response("{}", { status: 200 });
    vi.spyOn(response, "json").mockImplementation(() => {
      started();
      return body;
    });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response));
    const pending = authorRequest(
      "article-authoring/connections",
      { parse: (value) => value },
      { accountScoped: true },
    );
    await bodyStarted;
    authorClient.setAccount("synthetic-owner-b");
    authorClient.setAccount("synthetic-owner-a");
    releaseBody({ items: [] });
    await expect(pending).rejects.toMatchObject({ status: 401 });
  });

  it("reads this session's product access through the existing relay", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        Response.json({ mode: "closed_beta", access: "restricted" }),
      );
    vi.stubGlobal("fetch", fetchMock);
    await expect(authorClient.access()).resolves.toBe("restricted");
    expect(fetchMock.mock.calls[0]![0]).toBe("/api/community/access");
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(Response.json({ access: "granted" })),
    );
    await expect(authorClient.access()).rejects.toThrow();
  });

  it("announces a 403 so the page can ask the Backend again, and only a 403", async () => {
    const dispatched = vi.fn();
    vi.stubGlobal("dispatchEvent", dispatched);
    for (const status of [401, 404, 500]) {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue(new Response(null, { status })),
      );
      await expect(authorClient.me()).rejects.toMatchObject({ status });
    }
    expect(dispatched).not.toHaveBeenCalled();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(null, { status: 403 })),
    );
    await expect(authorClient.me()).rejects.toMatchObject({ status: 403 });
    expect(dispatched).toHaveBeenCalledOnce();
    expect((dispatched.mock.calls[0]![0] as Event).type).toBe(
      PRODUCT_ACCESS_REFUSED_EVENT,
    );
  });
});

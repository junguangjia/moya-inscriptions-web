import { afterEach, describe, expect, it, vi } from "vitest";
import { authorClient, authorRequest } from "./author-community-client";

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
});

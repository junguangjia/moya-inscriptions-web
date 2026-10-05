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

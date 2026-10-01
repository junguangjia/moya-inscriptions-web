import { afterEach, describe, expect, it, vi } from "vitest";
import { authorClient, authorRequest } from "./author-community-client";

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
});

import { afterEach, describe, expect, it, vi } from "vitest";
import { authorClient } from "./author-community-client";
import { feedbackClient } from "./feedback-client";
afterEach(() => {
  vi.unstubAllGlobals();
  authorClient.setAccount(null);
});
describe("feedback client", () => {
  const message = {
    message: "希望增加筛选",
    submissionId: "00000000-0000-4000-8000-000000000001",
  };
  it("uses the existing account-fenced same-origin POST and validates its receipt", async () => {
    authorClient.setAccount("user-00000000000000000000000000000001");
    const receipt = {
      id: "feedback-00000000000000000000000000000001",
      createdAt: "2026-10-23T12:00:00.000Z",
    };
    const fetch = vi
      .fn()
      .mockResolvedValue(Response.json(receipt, { status: 201 }));
    vi.stubGlobal("fetch", fetch);
    expect(await feedbackClient.submit(message)).toEqual(receipt);
    expect(fetch).toHaveBeenCalledWith(
      "/api/community/feedback",
      expect.objectContaining({
        method: "POST",
        credentials: "same-origin",
        cache: "no-store",
        headers: expect.objectContaining({
          "x-author-account": authorClient.account(),
        }),
      }),
    );
    expect(JSON.parse(fetch.mock.calls[0]![1].body)).toEqual(message);
  });
  it("rejects missing account, rejected backend and invalid success bodies", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    await expect(feedbackClient.submit(message)).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
    authorClient.setAccount("user-00000000000000000000000000000001");
    fetch.mockResolvedValueOnce(Response.json({}, { status: 503 }));
    await expect(feedbackClient.submit(message)).rejects.toThrow();
    fetch.mockResolvedValueOnce(Response.json({ saved: true }));
    await expect(feedbackClient.submit(message)).rejects.toThrow();
  });
});

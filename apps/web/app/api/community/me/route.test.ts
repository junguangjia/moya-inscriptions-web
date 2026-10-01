import { beforeEach, describe, expect, it, vi } from "vitest";

const { fetchServerCurrentUserMock } = vi.hoisted(() => ({
  fetchServerCurrentUserMock: vi.fn(),
}));

vi.mock("../../../../lib/public-api/server", () => ({
  fetchServerCurrentUser: fetchServerCurrentUserMock,
}));

import { GET } from "./route";

const opaqueSession = "C".repeat(43);
const profile = {
  id: "user-0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f01",
  handle: "dev-user-01",
  displayName: "拓片爱好者",
};
const request = (cookie?: string) =>
  new Request("http://localhost/api/community/me", {
    headers: cookie === undefined ? {} : { cookie },
  });

beforeEach(() => {
  fetchServerCurrentUserMock.mockReset();
});

describe("same-origin current-user bridge", () => {
  it("relays the cookie credential and returns the profile", async () => {
    fetchServerCurrentUserMock.mockResolvedValue({
      state: "success",
      profile,
    });
    const response = await GET(request(`yoyi-session=${opaqueSession}`));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual(profile);
    expect(fetchServerCurrentUserMock).toHaveBeenCalledWith(opaqueSession);
  });

  it("answers 401 without calling the Backend when no credential is present", async () => {
    for (const cookie of [undefined, "payload-token=abc", "yoyi-session=bad"]) {
      const response = await GET(request(cookie));
      expect(response.status).toBe(401);
      expect(await response.text()).toBe("");
    }
    expect(fetchServerCurrentUserMock).not.toHaveBeenCalled();
  });

  it.each([
    ["unauthenticated", 401],
    ["unavailable", 503],
    ["unexpected-error", 502],
  ] as const)("maps %s without exposing internals", async (state, status) => {
    fetchServerCurrentUserMock.mockResolvedValue({ state });
    const response = await GET(request(`yoyi-session=${opaqueSession}`));
    expect(response.status).toBe(status);
    expect(await response.text()).toBe("");
  });

  // email-auth-v1: a Session the Backend refuses (logged out or
  // factor-replaced on another device, expired, unknown) leaves this browser
  // signed out, so its cookie is cleared; a failed check never signs out.
  it("clears the cookie of a Session the Backend refuses", async () => {
    fetchServerCurrentUserMock.mockResolvedValue({ state: "unauthenticated" });
    const response = await GET(request(`yoyi-session=${opaqueSession}`));
    expect(response.status).toBe(401);
    expect(response.headers.get("set-cookie")).toMatch(
      /^yoyi-session=; .*Max-Age=0; Path=\/; HttpOnly; SameSite=Lax/u,
    );
  });

  it.each(["unavailable", "unexpected-error"] as const)(
    "keeps the cookie when the check is %s",
    async (state) => {
      fetchServerCurrentUserMock.mockResolvedValue({ state });
      const response = await GET(request(`yoyi-session=${opaqueSession}`));
      expect(response.headers.get("set-cookie")).toBeNull();
    },
  );
});

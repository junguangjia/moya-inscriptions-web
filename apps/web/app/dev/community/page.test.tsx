import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { cookiesMock, notFoundMock, fetchServerCurrentUserMock } = vi.hoisted(
  () => ({
    cookiesMock: vi.fn(),
    notFoundMock: vi.fn((): never => {
      throw new Error("NEXT_NOT_FOUND");
    }),
    fetchServerCurrentUserMock: vi.fn(),
  }),
);

vi.mock("next/headers", () => ({ cookies: cookiesMock }));
vi.mock("next/navigation", () => ({ notFound: notFoundMock }));
vi.mock("../../../lib/public-api/server", () => ({
  fetchServerCurrentUser: fetchServerCurrentUserMock,
}));

import CommunityDevelopmentPage from "./page";

const opaqueSession = "F".repeat(43);
const profile = {
  id: "user-0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f01",
  handle: "dev-user-01",
  displayName: "拓片爱好者",
};

const withCookie = (value?: string) => {
  cookiesMock.mockResolvedValue({
    get: (name: string) =>
      name === "yoyi-session" && value !== undefined ? { value } : undefined,
  });
};

describe("CommunityDevelopmentPage", () => {
  beforeEach(() => {
    vi.stubEnv("NODE_ENV", "development");
    withCookie(undefined);
    fetchServerCurrentUserMock.mockReset();
  });

  afterEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
  });

  it("is unavailable in Production before reading any cookie", async () => {
    vi.stubEnv("NODE_ENV", "production");
    await expect(CommunityDevelopmentPage({})).rejects.toThrow(
      "NEXT_NOT_FOUND",
    );
    expect(notFoundMock).toHaveBeenCalledOnce();
    expect(cookiesMock).not.toHaveBeenCalled();
    expect(fetchServerCurrentUserMock).not.toHaveBeenCalled();
  });

  it("offers the seeded Development handles when signed out", async () => {
    const markup = renderToStaticMarkup(await CommunityDevelopmentPage({}));
    expect(markup).toContain("未登录");
    expect(markup).toContain('action="/api/community/development/sign-in"');
    for (const handle of ["dev-user-01", "dev-user-02", "dev-user-03"])
      expect(markup).toContain(`value="${handle}"`);
    expect(markup).not.toContain("登出");
    expect(fetchServerCurrentUserMock).not.toHaveBeenCalled();
  });

  it("shows the session owner's profile and a sign-out form when signed in", async () => {
    withCookie(opaqueSession);
    fetchServerCurrentUserMock.mockResolvedValue({
      state: "success",
      profile,
    });
    const markup = renderToStaticMarkup(
      await CommunityDevelopmentPage({
        searchParams: Promise.resolve({ notice: "signed-in" }),
      }),
    );
    expect(fetchServerCurrentUserMock).toHaveBeenCalledWith(opaqueSession);
    expect(markup).toContain("已登录");
    expect(markup).toContain("拓片爱好者");
    expect(markup).toContain("@dev-user-01");
    expect(markup).toContain(profile.id);
    expect(markup).toContain('action="/api/community/development/sign-out"');
    expect(markup).toContain("登录成功");
    expect(markup).not.toContain(opaqueSession);
  });

  it("reports an expired or unavailable session truthfully", async () => {
    withCookie(opaqueSession);
    fetchServerCurrentUserMock.mockResolvedValue({ state: "unauthenticated" });
    expect(renderToStaticMarkup(await CommunityDevelopmentPage({}))).toContain(
      "未登录",
    );
    fetchServerCurrentUserMock.mockResolvedValue({ state: "unavailable" });
    const markup = renderToStaticMarkup(
      await CommunityDevelopmentPage({
        searchParams: Promise.resolve({ notice: "not-a-notice" }),
      }),
    );
    expect(markup).toContain("Backend 暂时不可用");
    expect(markup).not.toContain('role="status"');
  });

  it("ignores crafted notice keys instead of reaching the prototype chain", async () => {
    for (const notice of ["__proto__", "constructor", "toString"]) {
      const markup = renderToStaticMarkup(
        await CommunityDevelopmentPage({
          searchParams: Promise.resolve({ notice }),
        }),
      );
      expect(markup).toContain("未登录");
      expect(markup).not.toContain('role="status"');
    }
  });

  it("links directly to live notification categories instead of the empty Catalog preview", async () => {
    const markup = renderToStaticMarkup(await CommunityDevelopmentPage({}));
    expect(markup).toContain('href="/?notifications=comments"');
    expect(markup).toContain('href="/?notifications=likes"');
    expect(markup).not.toContain('href="/dev/t02p"');
    expect(markup).not.toContain("不使用真实数据");
  });
  it("declares a handle pattern browsers accept under the v flag", async () => {
    const markup = renderToStaticMarkup(await CommunityDevelopmentPage({}));
    const pattern = /pattern="([^"]+)"/u.exec(markup)?.[1];
    expect(pattern).toBeDefined();
    // Browsers compile `pattern` with the `v` flag: a bare `-` inside a class is a syntax error there.
    const compiled = new RegExp(`^(?:${pattern!})$`, "v");
    expect(compiled.test("dev-user-01")).toBe(true);
    expect(compiled.test("1abc")).toBe(false);
  });
});

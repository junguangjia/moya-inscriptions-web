import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
}));
vi.mock("../features/auth/auth-page", () => ({
  AuthPage: ({ mode, returnTo }: { mode: string; returnTo: string }) => (
    <main data-auth-mode={mode} data-auth-return={returnTo} />
  ),
}));
const { readAuthPageWideScreenRedirect } = vi.hoisted(() => ({
  readAuthPageWideScreenRedirect: vi.fn(async () => false),
}));
vi.mock("./wide-screen-browse-only", () => ({
  readAuthPageWideScreenRedirect,
}));

import { WIDE_SCREEN_AUTH_REDIRECT_SCRIPT } from "../features/auth/wide-screen-auth-redirect";
import LoginPage from "./login/page";
import RegisterPage from "./register/page";
import AgreementsPage from "./login/agreements/page";

beforeEach(() => {
  vi.stubEnv("NODE_ENV", "production");
  readAuthPageWideScreenRedirect.mockReset();
  readAuthPageWideScreenRedirect.mockResolvedValue(false);
});
afterEach(() => vi.unstubAllEnvs());

describe("Production real authentication pages", () => {
  it.each([
    ["sign-in", LoginPage],
    ["register", RegisterPage],
  ] as const)(
    "renders %s through the existing auth presentation",
    async (mode, page) => {
      const markup = renderToStaticMarkup(
        await page({
          searchParams: Promise.resolve({ return: "/?feed=inscriptions" }),
        }),
      );
      expect(markup).toContain(`data-auth-mode="${mode}"`);
      expect(markup).toContain('data-auth-return="/?feed=inscriptions"');
    },
  );

  it.each([
    ["sign-in", LoginPage],
    ["register", RegisterPage],
  ] as const)(
    "sends a wide screen on %s back to Home before the auth markup when the policy applies",
    async (mode, page) => {
      readAuthPageWideScreenRedirect.mockResolvedValue(true);
      const markup = renderToStaticMarkup(
        await page({ searchParams: Promise.resolve({}) }),
      );
      expect(readAuthPageWideScreenRedirect).toHaveBeenCalledTimes(1);
      // The inline script leads the page, so it runs before the form is parsed.
      expect(markup).toBe(
        `<script id="yoyi-auth-redirect">${WIDE_SCREEN_AUTH_REDIRECT_SCRIPT}</script>` +
          `<main data-auth-mode="${mode}" data-auth-return="/"></main>`,
      );
    },
  );

  it.each([
    ["sign-in", LoginPage],
    ["register", RegisterPage],
  ] as const)(
    "keeps %s free of the redirect when the policy does not apply",
    async (mode, page) => {
      const markup = renderToStaticMarkup(await page({}));
      expect(readAuthPageWideScreenRedirect).toHaveBeenCalledTimes(1);
      expect(markup).not.toContain("<script");
      expect(markup).toBe(
        `<main data-auth-mode="${mode}" data-auth-return="/"></main>`,
      );
    },
  );

  it("retains safe auth return paths", async () => {
    const markup = renderToStaticMarkup(
      await LoginPage({
        searchParams: Promise.resolve({ return: "https://foreign.invalid" }),
      }),
    );
    expect(markup).toContain('data-auth-return="/"');
  });

  it("links published policies without presenting the Development agreement draft", () => {
    const markup = renderToStaticMarkup(AgreementsPage());
    expect(markup).toContain('href="/policies/terms"');
    expect(markup).toContain('href="/policies/privacy"');
    expect(markup).not.toContain("开发环境草稿");
  });
});

describe("Development registration instructions page", () => {
  it("returns to registration through the shared icon-only back", () => {
    vi.stubEnv("NODE_ENV", "development");
    const markup = renderToStaticMarkup(AgreementsPage());
    // The link leads the page and holds only the shared icon, no text.
    expect(markup).toMatch(
      /<main[^>]*><a aria-label="返回注册"[^>]*href="\/register"><span[^>]*data-icon="back"[^>]*><\/span><\/a><h1>/,
    );
    expect(markup).not.toContain(">返回注册<");
  });
});

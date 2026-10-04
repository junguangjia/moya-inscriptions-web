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

import LoginPage from "./login/page";
import RegisterPage from "./register/page";
import AgreementsPage from "./login/agreements/page";

beforeEach(() => vi.stubEnv("NODE_ENV", "production"));
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

  it("retains safe auth return paths", async () => {
    const markup = renderToStaticMarkup(
      await LoginPage({
        searchParams: Promise.resolve({ return: "https://foreign.invalid" }),
      }),
    );
    expect(markup).toContain('data-auth-return="/"');
  });

  it("does not promote the Development agreement draft", () => {
    expect(() => AgreementsPage()).toThrow("NEXT_NOT_FOUND");
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

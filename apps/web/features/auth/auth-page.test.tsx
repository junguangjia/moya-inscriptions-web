// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { router, me } = vi.hoisted(() => ({
  router: { push: vi.fn(), replace: vi.fn(), back: vi.fn() },
  me: vi.fn(),
}));
vi.mock("next/navigation", () => ({ useRouter: () => router }));
vi.mock("../authors/author-data", () => {
  class AuthorRequestError extends Error {
    constructor(readonly status: number) {
      super(`status ${status}`);
    }
  }
  return { authorClient: { me }, AuthorRequestError };
});
vi.mock("./auth-flow", () => ({ AuthFlow: () => <main data-auth-flow="" /> }));
vi.mock("./auth-return", () => ({ useAuthReturn: () => null }));

import { AuthPage } from "./auth-page";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

describe("authentication loading and error return", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    router.replace.mockReset();
    router.back.mockReset();
    me.mockReset();
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  const render = async () => {
    await act(async () =>
      root.render(<AuthPage mode="sign-in" returnTo="//outside.invalid/x" />),
    );
  };
  const back = () =>
    container.querySelector<HTMLButtonElement>(
      "button[aria-label='返回原页面']",
    );

  it("shows only the shared back icon while preparing sign-in", async () => {
    me.mockReturnValue(new Promise(() => undefined));
    await render();
    expect(container.textContent).toContain("正在准备登录…");
    expect(back()?.closest("nav")?.getAttribute("aria-label")).toBe("认证导航");
    expect(back()?.textContent?.trim()).toBe("");
    expect(back()?.querySelector("[data-icon='back']")).not.toBeNull();
    expect(container.textContent).not.toContain("返回");
  });

  it("keeps the retry label and the safe source fallback after a failure", async () => {
    me.mockRejectedValue(new Error("offline"));
    await render();
    expect(container.textContent).toContain("暂时无法连接登录服务，请重试。");
    const retry = [...container.querySelectorAll("button")].find(
      (candidate) => candidate.textContent?.trim() === "重试",
    );
    expect(retry).toBeDefined();
    expect(back()?.textContent?.trim()).toBe("");
    expect(back()?.querySelector("[data-icon='back']")).not.toBeNull();
    await act(async () => back()?.click());
    expect(router.back).not.toHaveBeenCalled();
    expect(router.replace).toHaveBeenCalledWith("/", { scroll: false });
  });
});

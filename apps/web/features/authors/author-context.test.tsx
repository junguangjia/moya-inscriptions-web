// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { me, setAccount, profile } = vi.hoisted(() => ({
  me: vi.fn(),
  setAccount: vi.fn(),
  profile: vi.fn(),
}));
vi.mock("./author-data", () => {
  class AuthorRequestError extends Error {
    constructor(readonly status: number) {
      super(`status ${status}`);
    }
  }
  return {
    authorClient: { me, setAccount, profile },
    AuthorRequestError,
  };
});
vi.mock("./local-library", () => ({
  readGuestFavorites: async () => [],
  pendingGuestBatch: async () => null,
  hasOtherGuestBatch: async () => false,
  contentKey: vi.fn(),
  acknowledgeGuestBatch: vi.fn(),
  setGuestFavorite: vi.fn(),
}));

import { AuthorProvider } from "./author-context";
import { AuthorRequestError } from "./author-data";
import { carrySessionNotice } from "./session-change";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

// account-switching-v1: synthetic accounts; no session or Backend.
const first = {
  id: `user-${"a".repeat(32)}`,
  handle: "synthetic-first",
  displayName: "甲",
};
const second = {
  id: `user-${"b".repeat(32)}`,
  handle: "synthetic-second",
  displayName: "乙",
};

let root: Root | null = null;
let node: HTMLDivElement;
beforeEach(() => {
  vi.clearAllMocks();
  profile.mockReturnValue(new Promise(() => undefined));
  window.sessionStorage.clear();
});
afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  document.body.replaceChildren();
});
const render = async () => {
  node = document.createElement("div");
  document.body.append(node);
  root = createRoot(node);
  await act(async () =>
    root!.render(
      <AuthorProvider signInHref="/login">
        <span />
      </AuthorProvider>,
    ),
  );
};
const storage = async () =>
  act(async () => {
    window.dispatchEvent(
      new StorageEvent("storage", { key: "yoyi-community-session-change" }),
    );
  });
const notice = () => node.querySelector(".phase4-feedback")?.textContent ?? "";

describe("AuthorProvider across tabs (account-switching-v1)", () => {
  it("says so when another tab made another account current", async () => {
    me.mockResolvedValue(first);
    await render();
    expect(setAccount).toHaveBeenLastCalledWith(first.id);
    expect(notice()).toBe("");
    me.mockResolvedValue(second);
    await storage();
    expect(setAccount).toHaveBeenLastCalledWith(second.id);
    expect(notice()).toContain("当前账户已在其他页面切换为「乙」");
  });

  it("stays quiet for a recheck of the same account and for a first sign-in", async () => {
    me.mockRejectedValue(new AuthorRequestError(401, "请先登录"));
    await render();
    expect(setAccount).toHaveBeenLastCalledWith(null);
    me.mockResolvedValue(first);
    await storage();
    expect(setAccount).toHaveBeenLastCalledWith(first.id);
    expect(notice()).toBe("");
    await storage();
    expect(notice()).toBe("");
  });

  const carried =
    "已退出当前账号；另有 1 个账号未能确认退出：「乙」。请到 设置 → 切换账号 再次退出。";

  it("shows the notice a partial 退出所有账号 left for the reload, once", async () => {
    window.sessionStorage.setItem("yoyi-community-session-notice", carried);
    me.mockRejectedValue(new AuthorRequestError(401, "请先登录"));
    await render();
    expect(setAccount).toHaveBeenLastCalledWith(null);
    expect(notice()).toContain(carried);
    // It is no merge retry.
    expect(node.querySelector(".phase4-feedback button")).toBeNull();
    expect(
      window.sessionStorage.getItem("yoyi-community-session-notice"),
    ).toBeNull();
    // A later recheck does not repeat it, and the next load does not see it.
    await act(async () => root!.unmount());
    await render();
    expect(notice()).toBe("");
  });

  it("keeps the carried notice when this load finds an account signed in", async () => {
    carrySessionNotice(carried);
    me.mockResolvedValue(first);
    await render();
    expect(setAccount).toHaveBeenLastCalledWith(first.id);
    expect(notice()).toContain(carried);
  });

  it("shows nothing when the previous page left no notice or storage is unavailable", async () => {
    me.mockRejectedValue(new AuthorRequestError(401, "请先登录"));
    const getItem = vi
      .spyOn(Storage.prototype, "getItem")
      .mockImplementation(() => {
        throw new DOMException("blocked", "SecurityError");
      });
    try {
      await render();
      expect(notice()).toBe("");
    } finally {
      getItem.mockRestore();
    }
  });
});

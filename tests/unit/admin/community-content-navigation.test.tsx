// @vitest-environment jsdom
import { createElement } from "react";
import type { MouseEvent as ReactMouseEvent, ReactNode } from "react";
import type {
  OperatorUser,
  OperatorWork,
} from "@moya/contracts/internal/community-operator";
import {
  cleanup,
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const runtime = await vi.hoisted(async () => {
  const { createRequire } = await import("node:module");
  const { realpathSync } = await import("node:fs");
  const { join } = await import("node:path");
  const require = createRequire(
    join(import.meta.dirname, "../../../apps/admin/"),
  );
  return {
    ui: realpathSync(require.resolve("@payloadcms/ui")),
    navigation: realpathSync(require.resolve("next/navigation")),
    link: realpathSync(require.resolve("next/link")),
    params: new URLSearchParams(),
    call: vi.fn(),
  };
});
vi.mock(runtime.ui, () => ({
  SetStepNav: () => null,
  ConfirmationModal: () => null,
  useModal: () => ({ openModal: vi.fn(), closeModal: vi.fn() }),
}));
vi.mock(runtime.navigation, () => ({ useSearchParams: () => runtime.params }));
vi.mock(runtime.link, () => ({
  default: ({ children, ...props }: { children: ReactNode; href: string }) =>
    createElement("a", props, children),
}));
vi.mock("admin/community-api", async (original) => ({
  ...(await original<object>()),
  call: runtime.call,
}));

import { CommunityContentClient } from "admin/community-content-client";
import { OperatorFailure } from "admin/community-api";
import { useNavigationGuard } from "admin/workspace-navigation-guard";

const navigate = (query: string) => {
  runtime.params = new URLSearchParams(query);
  window.history.replaceState(
    null,
    "",
    `/admin/community-moderation/content${query ? `?${query}` : ""}`,
  );
};
beforeEach(() => {
  navigate("");
  HTMLElement.prototype.scrollIntoView = vi.fn();
  runtime.call.mockReset();
  runtime.call.mockImplementation(
    async (name: string, input: { page?: number }) => {
      if (
        ![
          "read-works",
          "read-featured",
          "read-users",
          "read-catalogs",
        ].includes(name)
      )
        throw new Error(`Unexpected read: ${name}`);
      return {
        items: [],
        total: name === "read-users" || name === "read-catalogs" ? 0 : 60,
        page: input.page ?? 1,
        pageSize: 20,
        totalPages: 3,
        settingsVersion: 1,
        enabledQuantity: null,
      };
    },
  );
});
afterEach(cleanup);

describe("canonical content workspace URLs", () => {
  it.each([
    ["", "用户作品", "read-works"],
    ["tab=works", "用户作品", "read-works"],
    ["tab=featured", "推荐", "read-featured"],
    ["tab=users", "网站用户", "read-users"],
    ["tab=unknown", "用户作品", "read-works"],
  ])(
    "opens %s directly as %s with its matching existing read",
    async (query, heading, read) => {
      navigate(query);
      render(createElement(CommunityContentClient));
      expect(
        screen.getByRole("heading", { level: 1, name: heading }),
      ).toBeTruthy();
      await waitFor(() =>
        expect(runtime.call.mock.calls.some(([name]) => name === read)).toBe(
          true,
        ),
      );
      for (const tab of ["用户作品", "推荐内容", "用户管理"])
        expect(screen.queryByRole("button", { name: tab })).toBeNull();
      expect(
        runtime.call.mock.calls.some(([name]) => name === "read-works"),
      ).toBe(read === "read-works");
      expect(
        runtime.call.mock.calls.some(([name]) => name === "read-featured"),
      ).toBe(read === "read-featured");
    },
  );

  it("restores a direct work search and page and keeps both in the URL during pagination", async () => {
    navigate("q=碑&page=2");
    render(createElement(CommunityContentClient));
    await waitFor(() =>
      expect(runtime.call).toHaveBeenCalledWith("read-works", {
        page: 2,
        search: "碑",
        pageSize: 20,
      }),
    );
    expect(
      (screen.getByRole("textbox", { name: /搜索作品/ }) as HTMLInputElement)
        .value,
    ).toBe("碑");
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "下一页" }).hasAttribute("disabled"),
      ).toBe(false),
    );
    fireEvent.click(screen.getByRole("button", { name: "下一页" }));
    await waitFor(() =>
      expect(runtime.call).toHaveBeenCalledWith("read-works", {
        page: 3,
        search: "碑",
        pageSize: 20,
      }),
    );
    const params = new URLSearchParams(window.location.search);
    expect(params.get("q")).toBe("碑");
    expect(params.get("page")).toBe("3");
  });

  it("resets only the page when submitting a new recommendation search", async () => {
    navigate("tab=featured&q=旧&page=2");
    render(createElement(CommunityContentClient));
    await waitFor(() =>
      expect(runtime.call).toHaveBeenCalledWith("read-featured", {
        page: 2,
        search: "旧",
        filter: "active",
        pageSize: 20,
      }),
    );
    fireEvent.change(screen.getByRole("textbox", { name: "搜索推荐标题" }), {
      target: { value: "新碑" },
    });
    fireEvent.click(screen.getByRole("button", { name: "搜索" }));
    await waitFor(() =>
      expect(runtime.call).toHaveBeenCalledWith("read-featured", {
        page: 1,
        search: "新碑",
        filter: "active",
        pageSize: 20,
      }),
    );
    const params = new URLSearchParams(window.location.search);
    expect(params.get("tab")).toBe("featured");
    expect(params.get("q")).toBe("新碑");
    expect(params.has("page")).toBe(false);
  });

  it("responds to canonical query changes while the same client remains mounted", async () => {
    navigate("q=原&page=2");
    const view = render(createElement(CommunityContentClient));
    await waitFor(() =>
      expect(runtime.call).toHaveBeenCalledWith("read-works", {
        page: 2,
        search: "原",
        pageSize: 20,
      }),
    );
    navigate("tab=featured&q=新&page=3&filter=all");
    view.rerender(createElement(CommunityContentClient));
    await waitFor(() =>
      expect(runtime.call).toHaveBeenCalledWith("read-featured", {
        page: 3,
        search: "新",
        filter: "all",
        pageSize: 20,
      }),
    );
    expect(
      screen.getByRole("heading", { level: 1, name: "推荐" }),
    ).toBeTruthy();
    navigate("tab=users");
    view.rerender(createElement(CommunityContentClient));
    await waitFor(() =>
      expect(
        screen.getByRole("heading", { level: 1, name: "网站用户" }),
      ).toBeTruthy(),
    );
    await waitFor(() =>
      expect(
        runtime.call.mock.calls.some(([name]) => name === "read-users"),
      ).toBe(true),
    );
  });

  it("restores a selected work from its URL and clears only the item when returning to the list", async () => {
    const item: OperatorWork = {
      id: `work-${"a".repeat(32)}`,
      title: "合成作品",
      text: "合成正文",
      authorId: "synthetic-author",
      authorName: "合成作者",
      authorStatus: "active",
      state: "visible",
      authorDeleted: false,
      version: 1,
      firstPublishedAt: null,
    };
    runtime.call.mockImplementation(
      async (_name: string, input: { search?: string; page?: number }) => ({
        items: input.search === item.id ? [item] : [],
        total: 1,
        page: input.page ?? 1,
        pageSize: 20,
      }),
    );
    navigate(`q=碑&page=2&item=${item.id}`);
    render(createElement(CommunityContentClient));
    await screen.findByRole("region", { name: "作品详情与管理" });
    expect(
      screen.getByRole("heading", { level: 2, name: "合成作品" }),
    ).toBeTruthy();
    expect(runtime.call).toHaveBeenCalledWith("read-works", {
      page: 1,
      pageSize: 20,
      search: item.id,
    });
    fireEvent.click(screen.getByRole("button", { name: "返回列表" }));
    expect(screen.queryByRole("region", { name: "作品详情与管理" })).toBeNull();
    const params = new URLSearchParams(window.location.search);
    expect(params.has("item")).toBe(false);
    expect(params.get("q")).toBe("碑");
    expect(params.get("page")).toBe("2");
  });

  it("restores website-user search and page, paginates, and resets the page on a new search", async () => {
    runtime.call.mockImplementation(
      async (_name: string, input: { page?: number }) => ({
        items: [],
        total: 80,
        page: input.page ?? 1,
        pageSize: 20,
      }),
    );
    navigate("tab=users&q=原名&page=2");
    render(createElement(CommunityContentClient));
    await waitFor(() =>
      expect(runtime.call).toHaveBeenCalledWith(
        "read-users",
        { page: 2, search: "原名", pageSize: 20 },
        expect.any(AbortSignal),
      ),
    );
    const search = screen.getByRole("textbox", {
      name: /搜索昵称/,
    }) as HTMLInputElement;
    expect(search.value).toBe("原名");
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "下一页" }).hasAttribute("disabled"),
      ).toBe(false),
    );
    fireEvent.click(screen.getByRole("button", { name: "下一页" }));
    await waitFor(() =>
      expect(runtime.call).toHaveBeenCalledWith(
        "read-users",
        { page: 3, search: "原名", pageSize: 20 },
        expect.any(AbortSignal),
      ),
    );
    expect(new URLSearchParams(window.location.search).get("page")).toBe("3");
    fireEvent.change(search, { target: { value: " 新名 " } });
    await waitFor(() =>
      expect(
        screen
          .getByRole("button", { name: "搜索用户" })
          .hasAttribute("disabled"),
      ).toBe(false),
    );
    fireEvent.click(screen.getByRole("button", { name: "搜索用户" }));
    await waitFor(() =>
      expect(runtime.call).toHaveBeenCalledWith(
        "read-users",
        { page: 1, search: "新名", pageSize: 20 },
        expect.any(AbortSignal),
      ),
    );
    const params = new URLSearchParams(window.location.search);
    expect(params.get("tab")).toBe("users");
    expect(params.get("q")).toBe("新名");
    expect(params.has("page")).toBe(false);
  });

  it("returns from a user's works to the same website-user search and page", async () => {
    const user: OperatorUser = {
      id: `user-${"c".repeat(32)}`,
      handle: "synthetic-author",
      displayName: "合成作者",
      bio: "",
      status: "active",
      createdAt: "2026-10-01T00:00:00.000Z",
      submittedWorks: 2,
      recommended: false,
      recommendationVersion: 1,
    };
    runtime.call.mockImplementation(
      async (name: string, input: { page?: number }) => ({
        items: name === "read-users" ? [user] : [],
        total: 80,
        page: input.page ?? 1,
        pageSize: 20,
      }),
    );
    navigate("tab=users&q=书&page=3");
    const view = render(createElement(CommunityContentClient));
    const open = await screen.findByRole("button", {
      name: "合成作者 · 查看详情与作品",
    });
    await waitFor(() => expect(open.hasAttribute("disabled")).toBe(false));
    fireEvent.click(open);
    await waitFor(() =>
      expect(runtime.call).toHaveBeenCalledWith("read-works", {
        page: 1,
        search: "",
        authorId: user.id,
        pageSize: 20,
      }),
    );
    const worksURL = new URLSearchParams(window.location.search);
    expect(worksURL.get("author")).toBe(user.id);
    expect(worksURL.get("usersQ")).toBe("书");
    expect(worksURL.get("usersPage")).toBe("3");
    // Next's native-history integration publishes the changed search params.
    runtime.params = worksURL;
    view.rerender(createElement(CommunityContentClient));
    const back = await screen.findByRole("button", { name: "返回用户列表" });
    await waitFor(() => expect(back.hasAttribute("disabled")).toBe(false));
    fireEvent.click(back);
    await waitFor(() =>
      expect(
        screen.getByRole("heading", { level: 1, name: "网站用户" }),
      ).toBeTruthy(),
    );
    await waitFor(() =>
      expect(runtime.call).toHaveBeenCalledWith(
        "read-users",
        { page: 3, search: "书", pageSize: 20 },
        expect.any(AbortSignal),
      ),
    );
    expect(
      (screen.getByRole("textbox", { name: /搜索昵称/ }) as HTMLInputElement)
        .value,
    ).toBe("书");
    const usersURL = new URLSearchParams(window.location.search);
    expect(usersURL.get("tab")).toBe("users");
    expect(usersURL.get("q")).toBe("书");
    expect(usersURL.get("page")).toBe("3");
    expect(usersURL.has("author")).toBe(false);
  });

  it("keeps the existing author filter after reloading a user's works URL", async () => {
    const author = `user-${"d".repeat(32)}`;
    navigate(`author=${author}&q=碑&page=2&usersQ=书&usersPage=3`);
    render(createElement(CommunityContentClient));
    await waitFor(() =>
      expect(runtime.call).toHaveBeenCalledWith("read-works", {
        page: 2,
        search: "碑",
        authorId: author,
        pageSize: 20,
      }),
    );
    expect(
      screen.getByRole("heading", { level: 1, name: "用户作品" }),
    ).toBeTruthy();
  });
});

describe("pending command navigation protection", () => {
  it.each(["success", "unknown"])(
    "applies a pending query change after %s resolution without replaying a write",
    async (outcome) => {
      const user: OperatorUser = {
        id: `user-${"e".repeat(32)}`,
        handle: "synthetic-user",
        displayName: "待处理用户",
        bio: "",
        status: "active",
        createdAt: "2026-10-01T00:00:00.000Z",
        submittedWorks: 0,
        recommended: false,
        recommendationVersion: 1,
      };
      let resolveWrite!: (value: unknown) => void;
      let rejectWrite!: (error: Error) => void;
      const pending = new Promise((resolve, reject) => {
        resolveWrite = resolve;
        rejectWrite = reject;
      });
      let writes = 0;
      runtime.call.mockImplementation(
        async (name: string, input: { page?: number }) => {
          if (name === "recommend-user") {
            writes++;
            return writes === 1 ? pending : { version: 2 };
          }
          return {
            items: name === "read-users" ? [user] : [],
            total: 1,
            page: input.page ?? 1,
            pageSize: 20,
            settingsVersion: 1,
            enabledQuantity: null,
          };
        },
      );
      navigate("tab=users&q=原");
      const view = render(createElement(CommunityContentClient));
      const recommend = await screen.findByRole("button", { name: "推荐用户" });
      await waitFor(() =>
        expect(recommend.hasAttribute("disabled")).toBe(false),
      );
      fireEvent.click(recommend);
      await waitFor(() => expect(writes).toBe(1));
      navigate("tab=featured&q=目标&page=2");
      view.rerender(createElement(CommunityContentClient));
      expect(
        screen.getByRole("heading", { level: 1, name: "网站用户" }),
      ).toBeTruthy();
      expect(
        runtime.call.mock.calls.filter(([name]) => name === "read-featured"),
      ).toHaveLength(0);
      await act(async () => {
        if (outcome === "success") resolveWrite({ version: 2 });
        else
          rejectWrite(
            new OperatorFailure(
              "OPERATOR_UNREACHABLE",
              "synthetic unavailable",
              502,
            ),
          );
      });
      if (outcome === "unknown") {
        const retry = await screen.findByRole("button", {
          name: "重试同一操作",
        });
        expect(
          screen.getByRole("heading", { level: 1, name: "网站用户" }),
        ).toBeTruthy();
        expect(
          runtime.call.mock.calls.filter(([name]) => name === "read-featured"),
        ).toHaveLength(0);
        expect(writes).toBe(1);
        fireEvent.click(retry);
      }
      await waitFor(() =>
        expect(
          screen.getByRole("heading", { level: 1, name: "推荐" }),
        ).toBeTruthy(),
      );
      await waitFor(() =>
        expect(runtime.call).toHaveBeenCalledWith("read-featured", {
          page: 2,
          search: "目标",
          filter: "active",
          pageSize: 20,
        }),
      );
      expect(
        runtime.call.mock.calls.filter(([name]) => name === "read-featured"),
      ).toHaveLength(1);
      const writeCalls = runtime.call.mock.calls.filter(
        ([name]) => name === "recommend-user",
      );
      expect(writeCalls).toHaveLength(outcome === "success" ? 1 : 2);
      if (outcome === "unknown")
        expect(writeCalls[1]![1]).toEqual(writeCalls[0]![1]);
    },
  );

  const Guard = ({
    blocked,
    onBlocked,
    onLink,
  }: {
    blocked: boolean;
    onBlocked: () => void;
    onLink: (event: ReactMouseEvent<HTMLAnchorElement>) => void;
  }) => {
    useNavigationGuard(blocked, onBlocked);
    return createElement(
      "a",
      { href: "/admin/collections/catalogs", onClick: onLink },
      "资料",
    );
  };
  it("blocks Admin clicks and unload while a result is pending, then removes its listeners", () => {
    const onBlocked = vi.fn();
    const onLink = vi.fn((event) => event.preventDefault());
    const view = render(
      createElement(Guard, { blocked: true, onBlocked, onLink }),
    );
    fireEvent.click(screen.getByRole("link", { name: "资料" }));
    expect(onBlocked).toHaveBeenCalledOnce();
    expect(onLink).not.toHaveBeenCalled();
    const pendingUnload = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(pendingUnload);
    expect(pendingUnload.defaultPrevented).toBe(true);
    view.rerender(createElement(Guard, { blocked: false, onBlocked, onLink }));
    fireEvent.click(screen.getByRole("link", { name: "资料" }));
    expect(onLink).toHaveBeenCalledOnce();
    const readyUnload = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(readyUnload);
    expect(readyUnload.defaultPrevented).toBe(false);
  });
});

// @vitest-environment jsdom
import { createElement } from "react";
import type { MouseEvent as ReactMouseEvent, ReactNode } from "react";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
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
    pathname: "/admin",
    params: new URLSearchParams(),
    user: { collection: "users", role: "owner" } as {
      collection: string;
      role: string;
    } | null,
    setNavOpen: vi.fn(),
    setTheme: vi.fn(),
    excludeDevice: vi.fn(),
    theme: "light",
    mobile: false,
    animate: false,
    getPreference: vi.fn(),
  };
});

vi.mock(runtime.ui, () => ({
  Link: ({
    children,
    prefetch,
    onClick,
    ...props
  }: {
    children: ReactNode;
    prefetch?: boolean;
    onClick?: (event: ReactMouseEvent<HTMLAnchorElement>) => void;
  }) =>
    createElement(
      "a",
      {
        ...props,
        "data-prefetch": String(prefetch),
        onClick: (event: ReactMouseEvent<HTMLAnchorElement>) => {
          onClick?.(event);
          event.preventDefault();
        },
      },
      children,
    ),
  useAuth: () => ({ user: runtime.user }),
  useNav: () => ({
    hydrated: true,
    navOpen: true,
    navRef: { current: null },
    shouldAnimate: runtime.animate,
    setNavOpen: runtime.setNavOpen,
  }),
  useTheme: () => ({ theme: runtime.theme, setTheme: runtime.setTheme }),
  usePreferences: () => ({ getPreference: runtime.getPreference }),
  Logout: () => createElement("button", {}, "退出登录"),
  NavToggler: ({ children }: { children: ReactNode }) =>
    createElement("button", {}, children),
  Hamburger: () => createElement("span", {}, "菜单"),
}));
vi.mock(runtime.navigation, () => ({
  usePathname: () => runtime.pathname,
  useSearchParams: () => runtime.params,
}));
vi.mock("../../../apps/admin/src/analytics/device", () => ({
  excludeOwnerAnalyticsDevice: runtime.excludeDevice,
}));

import { WorkspaceNavigation, WorkspaceTabs } from "admin/workspace-navigation";
import { currentWorkspace } from "admin/workspace-routes";

const canonicalRoutes = [
  "/admin",
  "/admin/collections/catalogs",
  "/admin/collections/media",
  "/admin/collections/articles",
  "/admin/collections/article-collections",
  "/admin/community-moderation/content",
  "/admin/community-moderation/content?tab=featured",
  "/admin/community-moderation/threads",
  "/admin/community-moderation",
  "/admin/community-moderation/work-submissions",
  "/admin/community-moderation/article-submissions",
  "/admin/community-moderation/reports",
  "/admin/community-moderation/appeals",
  "/admin/community-moderation/direct-messages",
  "/admin/community-moderation/feedback",
  "/admin/community-moderation/content?tab=users",
  "/admin/community-moderation/account-capacity",
  "/admin/analytics",
  "/admin/analytics/board",
  "/admin/analytics/ips",
  "/admin/analytics/status",
  "/admin/editorial-workflow",
  "/admin/collections/editorial-approvals",
  "/admin/collections/editorial-article-approvals",
  "/admin/community-moderation/publishing-jobs",
  "/admin/community-moderation/history",
  "/admin/collections/editorial-receipts",
  "/admin/community-moderation/settings",
  "/admin/collections/users",
  "/admin/collections/payload-mcp-api-keys",
];
const location = (href: string) => {
  const url = new URL(href, "https://admin.example.test");
  runtime.pathname = url.pathname;
  runtime.params = url.searchParams;
};

beforeEach(() => {
  runtime.pathname = "/admin";
  runtime.params = new URLSearchParams();
  runtime.user = { collection: "users", role: "owner" };
  runtime.theme = "light";
  runtime.mobile = false;
  runtime.animate = false;
  runtime.getPreference.mockReset().mockResolvedValue(undefined);
  runtime.setNavOpen.mockReset();
  runtime.setTheme.mockReset();
  runtime.excludeDevice.mockReset();
  window.matchMedia = vi.fn((query) => ({
    matches: query.includes("max-width") ? runtime.mobile : !runtime.mobile,
  })) as unknown as typeof window.matchMedia;
  HTMLElement.prototype.scrollIntoView = vi.fn();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("flat Admin workspace navigation", () => {
  it("renders exactly eight distinct primary destinations and no legacy accordion groups", () => {
    render(createElement(WorkspaceNavigation));
    const nav = screen.getByRole("navigation", { name: "工作区" });
    const links = within(nav).getAllByRole("link");
    expect(links.map((link) => link.textContent)).toEqual([
      "工作台",
      "内容",
      "审核",
      "用户",
      "数据",
      "发布工具",
      "操作记录",
      "设置",
    ]);
    expect(new Set(links.map((link) => link.getAttribute("href"))).size).toBe(
      8,
    );
    expect(nav.querySelectorAll('[aria-current="page"]')).toHaveLength(1);
    expect(nav.querySelectorAll("details,[aria-expanded]")).toHaveLength(0);
    expect(screen.queryByText("系统与自动化")).toBeNull();
    expect(screen.queryByText("编辑批处理工作流")).toBeNull();
    expect(runtime.excludeDevice).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole("button", { name: "切换深色界面" }));
    expect(runtime.setTheme).toHaveBeenCalledWith("dark");
  });

  it("keeps every canonical page reachable as one sibling tab, without duplicate tabs", () => {
    const seen = new Set<string>(["/admin"]);
    for (const href of canonicalRoutes.slice(1)) {
      location(href);
      const view = render(createElement(WorkspaceTabs));
      const links = screen.getAllByRole("link");
      const hrefs = links.map((link) => link.getAttribute("href")!);
      expect(new Set(hrefs).size).toBe(hrefs.length);
      expect(hrefs).toContain(href);
      expect(
        links.filter((link) => link.getAttribute("aria-current") === "page"),
      ).toHaveLength(1);
      expect(
        links
          .find((link) => link.getAttribute("aria-current") === "page")
          ?.getAttribute("href"),
      ).toBe(href);
      hrefs.forEach((path) => seen.add(path));
      view.unmount();
    }
    expect([...seen].sort()).toEqual([...canonicalRoutes].sort());
  });

  it("shows AI tabs only in Development and never prefetches connection consent", () => {
    location("/admin/agent-connections/consent");
    const view = render(createElement(WorkspaceTabs));
    expect(screen.queryByRole("link", { name: "AI 操作" })).toBeNull();
    expect(screen.queryByRole("link", { name: "AI 连接" })).toBeNull();
    view.rerender(
      createElement(WorkspaceTabs, { developmentAgentsEnabled: true }),
    );
    expect(
      screen.getByRole("link", { name: "AI 操作" }).getAttribute("href"),
    ).toBe("/admin/community-moderation/agent-operations");
    const connection = screen.getByRole("link", { name: "AI 连接" });
    expect(connection.getAttribute("aria-current")).toBe("page");
    expect(connection.getAttribute("data-prefetch")).toBe("false");
    expect(screen.queryByRole("link", { name: /consent/ })).toBeNull();
    for (const link of screen.getAllByRole("link"))
      expect(link.getAttribute("data-prefetch")).toBe("false");
  });

  it.each([
    null,
    { collection: "users", role: "automation" },
    { collection: "public-users", role: "owner" },
  ])("keeps navigation and tabs Owner-only for %s", (user) => {
    runtime.user = user;
    location("/admin/community-moderation/content?tab=users");
    const view = render(
      createElement(
        "div",
        {},
        createElement(WorkspaceNavigation),
        createElement(WorkspaceTabs),
      ),
    );
    expect(view.container.textContent).toBe("");
    expect(view.container.querySelector("a")).toBeNull();
    expect(runtime.excludeDevice).not.toHaveBeenCalled();
  });

  it("closes the mobile navigation after choosing a destination", () => {
    runtime.mobile = true;
    render(createElement(WorkspaceNavigation));
    fireEvent.click(
      within(screen.getByRole("navigation", { name: "工作区" })).getByRole(
        "link",
        { name: "内容" },
      ),
    );
    expect(runtime.setNavOpen).toHaveBeenCalledWith(false);
  });
});

describe("canonical workspace ownership", () => {
  it.each([
    ["", "content", "/admin/community-moderation/content"],
    ["tab=works&q=碑&page=2", "content", "/admin/community-moderation/content"],
    [
      "tab=featured&q=碑",
      "content",
      "/admin/community-moderation/content?tab=featured",
    ],
    ["tab=users", "users", "/admin/community-moderation/content?tab=users"],
    ["tab=invalid", "content", "/admin/community-moderation/content"],
  ])("distinguishes content destinations for %s", (query, workspace, href) => {
    const active = currentWorkspace(
      "/admin/community-moderation/content",
      new URLSearchParams(query),
    );
    expect(active?.workspace.id).toBe(workspace);
    expect(active?.page.href).toBe(href);
  });

  it.each([
    ["catalogs", "content"],
    ["media", "content"],
    ["articles", "content"],
    ["article-collections", "content"],
    ["editorial-approvals", "publishing"],
    ["editorial-article-approvals", "publishing"],
    ["editorial-receipts", "history"],
    ["users", "settings"],
    ["payload-mcp-api-keys", "settings"],
  ])(
    "retains %s ownership throughout native create, edit and version routes",
    (slug, workspace) => {
      const href = `/admin/collections/${slug}`;
      for (const suffix of [
        "",
        "/create",
        "/42",
        "/42/versions",
        "/42/versions/7",
      ]) {
        const current = currentWorkspace(
          href + suffix,
          new URLSearchParams("page=3"),
        );
        expect(current?.workspace.id).toBe(workspace);
        expect(current?.page.href).toBe(href);
      }
    },
  );

  it("does not match an unrelated collection with a similar name", () => {
    expect(
      currentWorkspace(
        "/admin/collections/articles-extra/42",
        new URLSearchParams(),
      ),
    ).toBeNull();
  });
});

it("opens desktop navigation after a bounded preference wait even when Payload starts animation", async () => {
  vi.useFakeTimers();
  runtime.getPreference.mockReturnValue(new Promise(() => {}));
  const view = render(createElement(WorkspaceNavigation));
  await vi.advanceTimersByTimeAsync(100);
  runtime.animate = true;
  view.rerender(createElement(WorkspaceNavigation));
  await vi.advanceTimersByTimeAsync(650);
  expect(runtime.setNavOpen).toHaveBeenCalledWith(true);
});

it("finishes desktop initialization after Payload applies an old closed preference", async () => {
  vi.useFakeTimers();
  let finish!: (value: { open: boolean }) => void;
  const preference = new Promise<{ open: boolean }>((resolve) => {
    finish = resolve;
  });
  runtime.getPreference.mockReturnValue(preference);
  render(createElement(WorkspaceNavigation));
  // Native NavProvider awaits its getNavPreference adapter before setNavOpen.
  const nativePreference = (async () => {
    const value = await (async () => (await preference).open)();
    runtime.setNavOpen(value);
  })();
  finish({ open: false });
  await nativePreference;
  await vi.advanceTimersByTimeAsync(0);
  expect(runtime.setNavOpen).toHaveBeenLastCalledWith(true);
});

it("keeps all Data destinations in a stable tab bar with accessible purposes", () => {
  location("/admin/analytics");
  render(createElement(WorkspaceTabs));
  const nav = screen.getByRole("navigation", { name: "数据页面" });
  for (const link of within(nav).getAllByRole("link")) {
    expect(link.getAttribute("title")).toBeTruthy();
    expect(link.getAttribute("aria-description")).toBe(
      link.getAttribute("title"),
    );
  }
  expect(
    within(nav).getByRole("link", { name: "统计看板" }).getAttribute("title"),
  ).toBe("查看已保存的统计汇总看板。");
});

// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import type { AuthorProfile } from "@moya/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const {
  authRequest,
  people,
  command,
  mutate,
  setThemePreference,
  setFeedLayoutPreference,
  session,
  presentation,
} = vi.hoisted(() => ({
  authRequest: vi.fn(),
  people: vi.fn(),
  command: vi.fn(),
  mutate: vi.fn(),
  setThemePreference: vi.fn(),
  setFeedLayoutPreference: vi.fn(),
  session: { id: "user-00000000000000000000000000000001" },
  presentation: { platform: "phone" },
}));
vi.mock("../auth/auth-api", () => ({ authRequest }));
vi.mock("./author-data", () => ({ authorClient: { people, command } }));
vi.mock("./author-context", () => ({
  useAuthors: () => ({ signInHref: "/login", viewer: session, mutate }),
}));
vi.mock("../product-shell/product-shell", () => ({
  useProductShell: () => ({
    feedLayout: "double",
    platform: presentation.platform,
    theme: "system",
    setThemePreference,
    setFeedLayoutPreference,
  }),
}));
import { ProfileSettings } from "./profile-settings";
(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
const profile: AuthorProfile = {
  id: "user-00000000000000000000000000000001",
  handle: "synthetic-settings-owner",
  displayName: "设置测试",
  bio: "",
  avatar: null,
  isOwner: true,
  following: false,
  privacy: {
    following: "public",
    followers: "private",
    favorites: "public",
    likes: "private",
  },
  totals: { works: 0, following: 0, followers: 0, favorites: 0, likes: 0 },
  nextAvatarChangeAt: null,
};
const sourceHistory = { screen: "profile" };
let root: Root | null = null;
beforeEach(() => {
  vi.clearAllMocks();
  session.id = profile.id;
  presentation.platform = "phone";
  people.mockResolvedValue({ items: [], page: 1, pageSize: 20, total: 0 });
  command.mockResolvedValue({});
  authRequest.mockResolvedValue({ status: 503, body: null });
  vi.stubGlobal(
    "matchMedia",
    vi.fn(() => ({ matches: true })),
  );
  Object.defineProperty(HTMLDialogElement.prototype, "showModal", {
    configurable: true,
    value: vi.fn(function (this: HTMLDialogElement) {
      this.open = true;
    }),
  });
  Object.defineProperty(HTMLDialogElement.prototype, "close", {
    configurable: true,
    value: vi.fn(function (this: HTMLDialogElement) {
      this.open = false;
    }),
  });
  window.history.replaceState(sourceHistory, "", "/#profile");
});
afterEach(async () => {
  window.history.replaceState(sourceHistory, "", "/#profile");
  await act(async () => root?.unmount());
  root = null;
  document.body.replaceChildren();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
const render = async (owner: AuthorProfile | null = profile) => {
  const node = document.createElement("div");
  document.body.append(node);
  root = createRoot(node);
  const onClose = vi.fn(),
    onSaved = vi.fn(),
    onEdit = vi.fn();
  await act(async () =>
    root!.render(
      <ProfileSettings
        profile={owner}
        onClose={onClose}
        onSaved={onSaved}
        onEdit={onEdit}
      />,
    ),
  );
  return { node, onClose, onSaved, onEdit };
};
const button = (node: HTMLElement, label: string) => {
  const result = Array.from(node.querySelectorAll("button")).find(
    (item) =>
      item.getAttribute("aria-label") === label ||
      item.textContent?.startsWith(label),
  );
  if (!result) throw new Error(`Missing button ${label}`);
  return result;
};
const click = async (node: HTMLElement, label: string) =>
  act(async () => button(node, label).click());
const pop = async (state: unknown) =>
  act(async () => {
    window.history.replaceState(state, "", "/#profile");
    window.dispatchEvent(new PopStateEvent("popstate", { state }));
  });
const favorites = (node: HTMLElement) =>
  Array.from(node.querySelectorAll("label"))
    .find((label) => label.textContent?.includes("收藏列表"))!
    .querySelector("select")!;
const edit = async (node: HTMLElement) =>
  act(async () => {
    const input = favorites(node);
    input.value = "private";
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
const person = {
  id: "user-00000000000000000000000000000002",
  displayName: "合成屏蔽账户",
  handle: "synthetic-blocked",
};

describe("grouped My settings", () => {
  it("lets a guest choose display preferences without requesting private data", async () => {
    const { node } = await render(null);
    expect(node.querySelector("dialog")?.open).toBe(true);
    expect(node.querySelector("a")?.getAttribute("href")).toBe("/login");
    expect(node.textContent).toContain("登录后管理账户设置");
    await click(node, "外观");
    await click(node, "深色");
    await click(node, "单列");
    expect(setThemePreference).toHaveBeenCalledWith("dark");
    expect(setFeedLayoutPreference).toHaveBeenCalledWith("single");
    expect(people).not.toHaveBeenCalled();
    expect(command).not.toHaveBeenCalled();
  });
  it("keeps privacy drafts within settings but guards exiting the root", async () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false),
      back = vi.spyOn(window.history, "back").mockImplementation(() => {});
    const { node, onClose } = await render();
    const rootState = window.history.state;
    await click(node, "列表隐私");
    await edit(node);
    await click(node, "返回");
    expect(back).toHaveBeenCalledOnce();
    expect(confirm).not.toHaveBeenCalled();
    await pop(rootState);
    expect(node.textContent).toContain("有未保存的更改");
    await click(node, "列表隐私");
    expect(favorites(node).value).toBe("private");
    await pop(rootState);
    await click(node, "返回");
    expect(confirm).toHaveBeenCalledOnce();
    expect(back).toHaveBeenCalledOnce();
    expect(onClose).not.toHaveBeenCalled();
    confirm.mockReturnValue(true);
    await click(node, "返回");
    await pop(sourceHistory);
    expect(onClose).toHaveBeenCalledOnce();
    expect(command).not.toHaveBeenCalled();
  });
  it("saves only the submitted privacy and clears its exit guard after confirmation", async () => {
    const confirm = vi.spyOn(window, "confirm");
    const { node, onSaved } = await render();
    expect(button(node, "编辑信息")).toBeDefined();
    await click(node, "列表隐私");
    await edit(node);
    await click(node, "保存隐私设置");
    expect(command).toHaveBeenCalledWith("me/privacy", {
      requestId: expect.any(String),
      privacy: { ...profile.privacy, favorites: "private" },
    });
    expect(onSaved).toHaveBeenCalledOnce();
    expect(mutate).toHaveBeenCalledOnce();
    expect(node.textContent).toContain("隐私设置已保存");
    await pop(sourceHistory);
    expect(confirm).not.toHaveBeenCalled();
  });
  it("holds navigation and duplicate submission while saving; failure retains the draft", async () => {
    const pending = deferred<unknown>();
    command.mockReturnValue(pending.promise);
    const forward = vi
        .spyOn(window.history, "forward")
        .mockImplementation(() => {}),
      back = vi.spyOn(window.history, "back").mockImplementation(() => {});
    const { node } = await render();
    const rootState = window.history.state;
    await click(node, "列表隐私");
    await edit(node);
    const save = button(node, "保存隐私设置");
    await act(async () => {
      save.click();
      save.click();
    });
    expect(command).toHaveBeenCalledOnce();
    expect(button(node, "返回").disabled).toBe(true);
    await pop(rootState);
    expect(forward).toHaveBeenCalledOnce();
    expect(
      node
        .querySelector("[data-settings-page]")
        ?.getAttribute("data-settings-page"),
    ).toBe("privacy");
    await act(async () =>
      pending.resolve(Promise.reject(new Error("保存失败"))),
    );
    expect(node.querySelector("[role=alert]")?.textContent).toBe("保存失败");
    expect(favorites(node).value).toBe("private");
    expect(button(node, "返回").disabled).toBe(false);
    expect(back).not.toHaveBeenCalled();
  });
  it("ignores a privacy write from a discarded account generation", async () => {
    const pending = deferred<unknown>();
    command.mockReturnValue(pending.promise);
    vi.spyOn(window.history, "go").mockImplementation(() => {});
    const { node, onSaved } = await render();
    const rootState = window.history.state;
    await click(node, "列表隐私");
    await edit(node);
    await click(node, "保存隐私设置");
    session.id = "user-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    await act(async () =>
      root!.render(
        <ProfileSettings profile={null} onClose={vi.fn()} onSaved={onSaved} />,
      ),
    );
    await pop(rootState);
    session.id = profile.id;
    await act(async () =>
      root!.render(
        <ProfileSettings
          profile={profile}
          onClose={vi.fn()}
          onSaved={onSaved}
        />,
      ),
    );
    await act(async () => pending.resolve({}));
    expect(onSaved).not.toHaveBeenCalled();
    expect(mutate).not.toHaveBeenCalled();
    await click(node, "列表隐私");
    expect(favorites(node).value).toBe("public");
  });
  it("preserves the draft when declining sign-out and after a failed sign-out", async () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    authRequest.mockImplementation(async (path) =>
      path === "account"
        ? {
            status: 200,
            body: {
              userId: profile.id,
              email: {
                channel: "email",
                state: "verified",
                masked: "s***@example.com",
                version: 1,
                usable: true,
              },
              phone: {
                channel: "phone",
                state: "unbound",
                masked: null,
                version: 0,
                usable: false,
              },
              capabilities: {
                profile: "full-local",
                email: { available: true },
                phone: { available: true },
                developmentOnly: true,
              },
            },
          }
        : { status: 503, body: null },
    );
    const { node, onClose } = await render();
    const rootState = window.history.state;
    await click(node, "列表隐私");
    await edit(node);
    await pop(rootState);
    await click(node, "账号与安全");
    await click(node, "退出登录");
    expect(confirm).toHaveBeenCalledOnce();
    expect(authRequest.mock.calls.some(([path]) => path === "sign-out")).toBe(
      false,
    );
    confirm.mockReturnValue(true);
    await click(node, "退出登录");
    expect(node.textContent).toContain("退出未能确认");
    expect(onClose).not.toHaveBeenCalled();
    await pop(rootState);
    await click(node, "列表隐私");
    expect(favorites(node).value).toBe("private");
  });
  it("loads blocked accounts only on their page and presents an empty state", async () => {
    const { node } = await render();
    expect(people).not.toHaveBeenCalled();
    await click(node, "已屏蔽账户");
    expect(people).toHaveBeenCalledWith(profile.id, "blocks", 1);
    expect(node.textContent).toContain("暂无已屏蔽账户");
  });
  it("retries a failed blocked-account read", async () => {
    people.mockRejectedValueOnce(new Error("读取失败"));
    const { node } = await render();
    await click(node, "已屏蔽账户");
    expect(node.querySelector("[role=alert]")?.textContent).toBe("读取失败");
    await click(node, "重试");
    expect(people).toHaveBeenCalledTimes(2);
    expect(node.textContent).toContain("暂无已屏蔽账户");
  });
  it("serializes pagination and appends without duplicate people", async () => {
    const pending = deferred<unknown>();
    people
      .mockResolvedValueOnce({
        items: [person],
        page: 1,
        pageSize: 1,
        total: 2,
      })
      .mockReturnValueOnce(pending.promise);
    const { node } = await render();
    await click(node, "已屏蔽账户");
    const more = button(node, "加载更多");
    await act(async () => {
      more.click();
      more.click();
    });
    expect(people).toHaveBeenCalledTimes(2);
    expect(more.disabled).toBe(true);
    await act(async () =>
      pending.resolve({
        items: [
          person,
          {
            ...person,
            id: "user-00000000000000000000000000000003",
            handle: "second",
          },
        ],
        page: 2,
        pageSize: 1,
        total: 2,
      }),
    );
    expect(node.querySelectorAll("button").length).toBe(3);
    expect(node.textContent).toContain("@second");
  });
  it("confirms unblock once then reloads the true list", async () => {
    const pending = deferred<unknown>();
    command.mockReturnValue(pending.promise);
    people.mockResolvedValueOnce({
      items: [person],
      page: 1,
      pageSize: 20,
      total: 1,
    });
    const { node } = await render();
    await click(node, "已屏蔽账户");
    const unblock = button(node, "解除屏蔽");
    await act(async () => {
      unblock.click();
      unblock.click();
    });
    expect(command).toHaveBeenCalledOnce();
    expect(command).toHaveBeenCalledWith("relationships/block", {
      requestId: expect.any(String),
      targetId: person.id,
      enabled: false,
    });
    await act(async () => pending.resolve({}));
    expect(people).toHaveBeenCalledTimes(2);
    expect(node.textContent).toContain("暂无已屏蔽账户");
  });
  it("requires a failed post-unblock refresh to recover before paging again", async () => {
    people
      .mockResolvedValueOnce({
        items: [person],
        page: 1,
        pageSize: 1,
        total: 2,
      })
      .mockRejectedValueOnce(new Error("刷新失败"));
    const { node } = await render();
    await click(node, "已屏蔽账户");
    await click(node, "解除屏蔽");
    expect(node.querySelector("[role=alert]")?.textContent).toBe("刷新失败");
    expect(
      Array.from(node.querySelectorAll("button")).some((item) =>
        item.textContent?.includes("加载更多"),
      ),
    ).toBe(false);
    await click(node, "重试");
    expect(people).toHaveBeenLastCalledWith(profile.id, "blocks", 1);
    expect(node.textContent).toContain("暂无已屏蔽账户");
  });
  it("consumes settings history before opening Edit Info", async () => {
    const { node, onEdit, onClose } = await render();
    const back = vi.spyOn(window.history, "back").mockImplementation(() => {});
    await click(node, "编辑信息");
    expect(back).toHaveBeenCalledOnce();
    expect(onEdit).not.toHaveBeenCalled();
    await pop(sourceHistory);
    expect(onEdit).toHaveBeenCalledOnce();
    expect(onClose).not.toHaveBeenCalled();
  });
  it("keeps desktop layout controls hidden and supports radio arrow selection", async () => {
    presentation.platform = "pc";
    const { node } = await render(null);
    await click(node, "外观");
    expect(node.querySelector("[aria-label='首页布局']")).toBeNull();
    expect(
      node.querySelector("dialog")?.getAttribute("data-settings-platform"),
    ).toBe("pc");
    await act(async () =>
      button(node, "跟随系统").dispatchEvent(
        new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }),
      ),
    );
    expect(setThemePreference).toHaveBeenCalledWith("light");
    expect(document.activeElement?.textContent).toBe("浅色");
  });
  it("restores root scroll and the exact row focus after child Back", async () => {
    const { node } = await render();
    const rootState = window.history.state;
    const scroll = node.querySelector<HTMLElement>(
      "[data-settings-page] > div",
    )!;
    scroll.scrollTop = 124;
    button(node, "列表隐私").focus();
    await click(node, "列表隐私");
    expect(scroll.scrollTop).toBe(0);
    await pop(rootState);
    expect(scroll.scrollTop).toBe(124);
    expect(
      document.activeElement?.getAttribute("data-settings-focus-key"),
    ).toBe("privacy");
  });
});

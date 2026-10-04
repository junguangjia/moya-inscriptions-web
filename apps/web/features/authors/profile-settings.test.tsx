// @vitest-environment jsdom
import { act, Fragment, StrictMode } from "react";
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
vi.mock("../auth/auth-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../auth/auth-api")>()),
  authRequest,
}));
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
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn() }),
  usePathname: () => window.location.pathname,
}));
import { AuthReturnProvider, useAuthReturn } from "../auth/auth-return";
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
    const back = button(node, "返回");
    expect(back.querySelector("[data-icon='back']")).not.toBeNull();
    expect(back.querySelector("svg")).toBeNull();
    expect(back.textContent).toBe("");
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

describe("settings authentication return", () => {
  const sourcePath = "/#profile";
  const authPath = `/login?return=${encodeURIComponent(sourcePath)}`;
  const nativeReplace = window.history.replaceState;

  const journey = async ({ strict = false } = {}) => {
    const Boundary = strict ? StrictMode : Fragment;
    const node = document.createElement("div");
    document.body.append(node);
    root = createRoot(node);
    const onClose = vi.fn(),
      onSaved = vi.fn(),
      onEdit = vi.fn(),
      onDeparture = vi.fn();
    let state: ReturnType<typeof useAuthReturn>;
    const Probe = () => {
      state = useAuthReturn();
      return null;
    };
    const context = () => {
      if (!state) throw new Error("The synthetic auth return was not mounted");
      return state;
    };
    const mount = async (owner: AuthorProfile | null, mounted = true) => {
      session.id = owner?.id ?? "checking-settings-guest";
      await act(async () =>
        root!.render(
          <Boundary>
            <AuthReturnProvider>
              <Probe />
              {mounted && (
                <ProfileSettings
                  key={session.id}
                  profile={owner}
                  onClose={onClose}
                  onSaved={onSaved}
                  onEdit={onEdit}
                  onDeparture={onDeparture}
                />
              )}
            </AuthReturnProvider>
          </Boundary>,
        ),
      );
    };
    const leave = async () => {
      context().capture(sourcePath, null);
      const entry: unknown = window.history.state;
      await act(async () =>
        window.history.pushState({ __NA: true }, "", authPath),
      );
      await mount(null, false);
      expect(context().hasSource()).toBe(true);
      return entry;
    };
    const returnChecking = async (entry: unknown) => {
      await act(async () => {
        nativeReplace.call(window.history, entry, "", sourcePath);
        window.dispatchEvent(new PopStateEvent("popstate", { state: entry }));
      });
      expect(context().isRestoring()).toBe(true);
      await mount(null);
    };
    const confirm = async (owner: AuthorProfile = profile) => {
      context().identify(owner.id);
      await mount(owner);
      expect(context().isRestoring()).toBe(true);
    };
    const scroll = () =>
      node.querySelector<HTMLElement>("[data-settings-page] > div")!;
    const page = () =>
      node
        .querySelector("[data-settings-page]")
        ?.getAttribute("data-settings-page");
    await mount(profile);
    return {
      node,
      onClose,
      onSaved,
      onEdit,
      onDeparture,
      context,
      mount,
      leave,
      returnChecking,
      confirm,
      scroll,
      page,
    };
  };

  const useSyntheticAccount = () =>
    authRequest.mockImplementation(async (path) => {
      if (path === "account")
        return {
          status: 200,
          body: {
            userId: session.id,
            email: {
              channel: "email",
              state: "verified",
              masked:
                session.id === profile.id
                  ? "old***@example.com"
                  : "new***@example.com",
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
        };
      if (path === "challenges")
        return {
          status: 200,
          body: {
            challengeId: "synthetic-settings-challenge",
            continuationToken: "synthetic-only-continuation",
            maskedTarget: "old***@example.com",
          },
        };
      if (path === "challenges/verify")
        return {
          status: 200,
          body: {
            outcome: "reauthenticated",
            reauthToken: "synthetic-only-reauth-proof",
          },
        };
      return { status: 503, body: null };
    });
  const changeInput = async (input: HTMLInputElement, value: string) =>
    act(async () => {
      Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
      )?.set?.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
  const expectReadOnlyReturn = () => {
    expect(command).not.toHaveBeenCalled();
    expect(authRequest.mock.calls.every(([path]) => path === "account")).toBe(
      true,
    );
  };

  it("signals settings departure synchronously before the closing animation finishes", async () => {
    vi.spyOn(window.history, "back").mockImplementation(() => {});
    const view = await journey();
    await click(view.node, "外观");
    view.scroll().scrollTop = 318;
    const entry = await view.leave();
    await view.returnChecking(entry);
    await view.confirm();
    expect(view.page()).toBe("display");
    expect(view.scroll().scrollTop).toBe(318);
    expect(view.onDeparture).not.toHaveBeenCalled();
    const restoredRoot = { ...window.history.state, phase4DialogDepth: 0 };
    await click(view.node, "返回");
    await pop(restoredRoot);
    const sourceEntry: Record<string, unknown> = { ...restoredRoot };
    delete sourceEntry.phase4Dialog;
    delete sourceEntry.phase4DialogDepth;
    const frame = view.node.querySelector<HTMLElement>("[data-settings-page]")!;
    frame.style.setProperty("--yoyi-duration-normal", "200ms");
    vi.stubGlobal(
      "matchMedia",
      vi.fn(() => ({ matches: false })),
    );
    vi.useFakeTimers();
    try {
      view.onDeparture.mockImplementation(() => {
        expect(view.context().read("profile-settings-page")).toBeUndefined();
        expect(view.onClose).not.toHaveBeenCalled();
      });
      await click(view.node, "返回");
      await pop(sourceEntry);
      expect(view.context().isRestoring()).toBe(true);
      expect(view.onDeparture).toHaveBeenCalledOnce();
      expect(view.onClose).not.toHaveBeenCalled();
      await act(async () => vi.advanceTimersByTime(199));
      expect(view.onClose).not.toHaveBeenCalled();
      await act(async () => vi.advanceTimersByTime(1));
      expect(view.onClose).toHaveBeenCalledOnce();
      expect(view.onDeparture).toHaveBeenCalledOnce();
      expectReadOnlyReturn();
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([false, true])(
    "retires the settings snapshot on actual close before ordinary reopen (StrictMode=%s)",
    async (strict) => {
      vi.spyOn(window.history, "back").mockImplementation(() => {});
      const view = await journey({ strict });
      view.scroll().scrollTop = 94;
      await click(view.node, "外观");
      view.scroll().scrollTop = 318;
      const entry = await view.leave();
      await view.returnChecking(entry);
      expect(view.page()).toBe("display");
      expect(view.scroll().scrollTop).toBe(318);
      await view.confirm();
      expect(view.page()).toBe("display");
      expect(view.scroll().scrollTop).toBe(318);
      const restoredRoot = {
        ...window.history.state,
        phase4DialogDepth: 0,
      };
      await click(view.node, "返回");
      await pop(restoredRoot);
      expect(view.page()).toBe("root");
      expect(view.scroll().scrollTop).toBe(94);
      // Child Back is not a close: late account rekeys must still have a view.
      expect(view.context().read("profile-settings-page")).toMatchObject({
        page: "display",
        positions: { display: 318 },
      });
      const sourceEntry: Record<string, unknown> = { ...restoredRoot };
      delete sourceEntry.phase4Dialog;
      delete sourceEntry.phase4DialogDepth;
      await click(view.node, "返回");
      await pop(sourceEntry);
      expect(view.onClose).toHaveBeenCalledOnce();
      expect(view.onEdit).not.toHaveBeenCalled();
      // Keep the same ticket so whole-journey retirement cannot hide the bug.
      expect(view.context().isRestoring()).toBe(true);
      expect(view.context().read("profile-settings-page")).toBeUndefined();
      await view.mount(profile, false);
      await view.mount(profile);
      expect(view.context().isRestoring()).toBe(true);
      expect(view.page()).toBe("root");
      expect(view.scroll().scrollTop).toBe(0);
      expectReadOnlyReturn();
    },
  );

  it("retires the settings snapshot when an explicit edit exits the restored modal", async () => {
    vi.spyOn(window.history, "back").mockImplementation(() => {});
    const view = await journey();
    await click(view.node, "外观");
    view.scroll().scrollTop = 318;
    const entry = await view.leave();
    await view.returnChecking(entry);
    await view.confirm();
    const restoredRoot = { ...window.history.state, phase4DialogDepth: 0 };
    await click(view.node, "返回");
    await pop(restoredRoot);
    const sourceEntry: Record<string, unknown> = { ...restoredRoot };
    delete sourceEntry.phase4Dialog;
    delete sourceEntry.phase4DialogDepth;
    await click(view.node, "编辑信息");
    await pop(sourceEntry);
    expect(view.onEdit).toHaveBeenCalledOnce();
    expect(view.onClose).not.toHaveBeenCalled();
    expect(view.context().isRestoring()).toBe(true);
    expect(view.context().read("profile-settings-page")).toBeUndefined();
    await view.mount(profile, false);
    await view.mount(profile);
    expect(view.page()).toBe("root");
    expect(view.scroll().scrollTop).toBe(0);
    expectReadOnlyReturn();
  });

  it("keeps the restored child page and scroll through checking guest and confirmed-owner rekeys", async () => {
    const view = await journey();
    view.scroll().scrollTop = 94;
    await click(view.node, "外观");
    view.scroll().scrollTop = 318;
    const entry = await view.leave();
    await view.returnChecking(entry);
    expect(view.page()).toBe("display");
    expect(view.scroll().scrollTop).toBe(318);
    await view.confirm();
    expect(view.page()).toBe("display");
    expect(view.scroll().scrollTop).toBe(318);
    expect(view.context().read("profile-settings-page")).toEqual({
      page: "display",
      positions: { root: 94, display: 318 },
    });
    expect(people).not.toHaveBeenCalled();
    expectReadOnlyReturn();
  });

  it("reloads a changed account without restoring the previous privacy draft, blocked people, or proof", async () => {
    useSyntheticAccount();
    people.mockResolvedValueOnce({
      items: [person],
      page: 1,
      pageSize: 20,
      total: 1,
    });
    const view = await journey();
    const rootEntry = window.history.state;
    await click(view.node, "列表隐私");
    await edit(view.node);
    await pop(rootEntry);
    await click(view.node, "已屏蔽账户");
    expect(view.node.textContent).toContain(person.displayName);
    await pop(rootEntry);
    await click(view.node, "账号与安全");
    await click(view.node, "换绑");
    const code = view.node.querySelector<HTMLInputElement>(
      'input[autocomplete="one-time-code"]',
    )!;
    await changeInput(code, "123456");
    await click(view.node, "验证并继续");
    const identifier = view.node.querySelector<HTMLInputElement>(
      'input[autocomplete="email"]',
    )!;
    await changeInput(identifier, "unsent-old-owner@example.com");
    expect(identifier.value).toBe("unsent-old-owner@example.com");
    const entry = await view.leave();
    authRequest.mockClear();
    people.mockClear();
    await view.returnChecking(entry);
    expect(authRequest).not.toHaveBeenCalled();
    expect(people).not.toHaveBeenCalled();
    const other: AuthorProfile = {
      ...profile,
      id: "user-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      handle: "synthetic-settings-other",
      privacy: { ...profile.privacy, following: "private" },
    };
    await view.confirm(other);
    expect(view.page()).toBe("security");
    expect(view.node.querySelector("form")).toBeNull();
    expect(view.node.textContent).toContain("new***@example.com");
    expect(view.node.textContent).not.toContain("old***@example.com");
    const snapshot = view.context().read("profile-settings-page") as Record<
      string,
      unknown
    >;
    expect(Object.keys(snapshot).sort()).toEqual(["page", "positions"]);
    const returnedRoot = { ...window.history.state, phase4DialogDepth: 0 };
    await pop(returnedRoot);
    await click(view.node, "列表隐私");
    expect(favorites(view.node).value).toBe(other.privacy.favorites);
    expect(view.node.textContent).not.toContain("更改尚未保存");
    await pop(returnedRoot);
    const nextPeople = deferred<unknown>();
    people.mockReturnValueOnce(nextPeople.promise);
    await click(view.node, "已屏蔽账户");
    expect(people).toHaveBeenCalledWith(other.id, "blocks", 1);
    expect(view.node.textContent).not.toContain(person.displayName);
    await act(async () =>
      nextPeople.resolve({ items: [], page: 1, pageSize: 20, total: 0 }),
    );
    expect(view.node.textContent).toContain("暂无已屏蔽账户");
    expectReadOnlyReturn();
    expect(view.onSaved).not.toHaveBeenCalled();
  });

  it("returns from a restored child to the modal root before Back exits settings", async () => {
    const back = vi.spyOn(window.history, "back").mockImplementation(() => {});
    const view = await journey();
    view.scroll().scrollTop = 112;
    await click(view.node, "外观");
    view.scroll().scrollTop = 226;
    const entry = await view.leave();
    await view.returnChecking(entry);
    await view.confirm();
    const returnedRoot = { ...window.history.state, phase4DialogDepth: 0 };
    await click(view.node, "返回");
    expect(back).toHaveBeenCalledOnce();
    expect(view.onClose).not.toHaveBeenCalled();
    await pop(returnedRoot);
    expect(view.page()).toBe("root");
    expect(view.scroll().scrollTop).toBe(112);
    await click(view.node, "返回");
    expect(back).toHaveBeenCalledTimes(2);
    await pop(sourceHistory);
    expect(view.onClose).toHaveBeenCalledOnce();
    expectReadOnlyReturn();
  });

  it("returns an interrupted factor flow to security without resending or reusing a challenge", async () => {
    useSyntheticAccount();
    const view = await journey();
    await click(view.node, "账号与安全");
    await click(view.node, "换绑");
    expect(view.page()).toBe("factor");
    expect(
      authRequest.mock.calls.filter(([path]) => path === "challenges"),
    ).toHaveLength(1);
    view.scroll().scrollTop = 170;
    const entry = await view.leave();
    authRequest.mockClear();
    await view.returnChecking(entry);
    await view.confirm();
    expect(view.page()).toBe("security");
    expect(view.scroll().scrollTop).toBe(170);
    expect(view.context().read("profile-settings-page")).toMatchObject({
      page: "security",
    });
    expect(view.node.querySelector("form")).toBeNull();
    expect(
      view.node.querySelector('input[autocomplete="one-time-code"]'),
    ).toBeNull();
    expect(button(view.node, "换绑")).toBeDefined();
    expectReadOnlyReturn();
  });

  it("commits a delayed blocked-account read after the restored owner is confirmed", async () => {
    const view = await journey();
    await click(view.node, "已屏蔽账户");
    const entry = await view.leave();
    people.mockClear();
    await view.returnChecking(entry);
    expect(view.page()).toBe("blocks");
    expect(people).not.toHaveBeenCalled();
    const pending = deferred<unknown>();
    people.mockReturnValueOnce(pending.promise);
    await view.confirm();
    expect(people).toHaveBeenCalledOnce();
    expect(people).toHaveBeenCalledWith(profile.id, "blocks", 1);
    expect(view.node.textContent).toContain("正在读取屏蔽列表");
    await act(async () =>
      pending.resolve({ items: [person], page: 1, pageSize: 20, total: 1 }),
    );
    expect(view.node.textContent).toContain(person.displayName);
    expect(button(view.node, "解除屏蔽").disabled).toBe(false);
    expect(view.node.textContent).not.toContain("正在读取屏蔽列表");
    expect(people).toHaveBeenCalledOnce();
    expect(authRequest).not.toHaveBeenCalled();
    expect(command).not.toHaveBeenCalled();
    expect(view.onSaved).not.toHaveBeenCalled();
  });
  const withClampedSettingsScroll = async (check: () => Promise<void>) => {
    const prototype = HTMLElement.prototype;
    const previous = Object.getOwnPropertyDescriptor(prototype, "scrollTop");
    const inherited =
      previous ??
      Object.getOwnPropertyDescriptor(Element.prototype, "scrollTop");
    const positions = new WeakMap<HTMLElement, number>();
    const isSettingsScroller = (element: HTMLElement) =>
      element.matches("[data-settings-page] > div");
    Object.defineProperty(prototype, "scrollTop", {
      configurable: true,
      get(this: HTMLElement) {
        return isSettingsScroller(this)
          ? (positions.get(this) ?? 0)
          : (inherited?.get?.call(this) ?? 0);
      },
      set(this: HTMLElement, value: number) {
        if (!isSettingsScroller(this)) {
          inherited?.set?.call(this, value);
          return;
        }
        // jsdom has no layout: mimic the browser's zero scroll range while
        // guest/loading content is short, then an actual populated list range.
        const maximum = this.textContent?.includes(person.displayName)
          ? 600
          : 0;
        positions.set(this, Math.max(0, Math.min(value, maximum)));
      },
    });
    try {
      await check();
    } finally {
      if (previous) Object.defineProperty(prototype, "scrollTop", previous);
      else Reflect.deleteProperty(prototype, "scrollTop");
    }
  };

  it("retries a clamped restored offset when delayed blocked-account content creates its scroll range", async () => {
    await withClampedSettingsScroll(async () => {
      people.mockResolvedValueOnce({
        items: [person],
        page: 1,
        pageSize: 20,
        total: 1,
      });
      const view = await journey();
      await click(view.node, "已屏蔽账户");
      view.scroll().scrollTop = 318;
      expect(view.scroll().scrollTop).toBe(318);
      const entry = await view.leave();
      people.mockClear();
      await view.returnChecking(entry);
      expect(view.scroll().scrollTop).toBe(0);
      const pending = deferred<unknown>();
      people.mockReturnValueOnce(pending.promise);
      await view.confirm();
      expect(view.scroll().scrollTop).toBe(0);
      await act(async () =>
        pending.resolve({ items: [person], page: 1, pageSize: 20, total: 1 }),
      );
      expect(view.node.textContent).toContain(person.displayName);
      expect(view.scroll().scrollTop).toBe(318);
      expect(people).toHaveBeenCalledOnce();
      expect(authRequest).not.toHaveBeenCalled();
      expect(command).not.toHaveBeenCalled();
    });
  });

  it("does not retry a clamped restored offset after the user wheels before delayed content arrives", async () => {
    await withClampedSettingsScroll(async () => {
      people.mockResolvedValueOnce({
        items: [person],
        page: 1,
        pageSize: 20,
        total: 1,
      });
      const view = await journey();
      await click(view.node, "已屏蔽账户");
      view.scroll().scrollTop = 318;
      const entry = await view.leave();
      people.mockClear();
      await view.returnChecking(entry);
      const pending = deferred<unknown>();
      people.mockReturnValueOnce(pending.promise);
      await view.confirm();
      expect(view.scroll().scrollTop).toBe(0);
      await act(async () =>
        view
          .scroll()
          .dispatchEvent(
            new WheelEvent("wheel", { deltaY: 40, bubbles: true }),
          ),
      );
      await act(async () =>
        pending.resolve({ items: [person], page: 1, pageSize: 20, total: 1 }),
      );
      expect(view.node.textContent).toContain(person.displayName);
      expect(view.scroll().scrollTop).toBe(0);
      expect(people).toHaveBeenCalledOnce();
      expect(authRequest).not.toHaveBeenCalled();
      expect(command).not.toHaveBeenCalled();
    });
  });
  it("keeps the user's new child offset when revisiting a page after source restoration completes", async () => {
    vi.spyOn(window.history, "back").mockImplementation(() => {});
    const view = await journey();
    await click(view.node, "外观");
    view.scroll().scrollTop = 318;
    const entry = await view.leave();
    await view.returnChecking(entry);
    await view.confirm();
    expect(view.scroll().scrollTop).toBe(318);
    const returnedRoot = { ...window.history.state, phase4DialogDepth: 0 };
    view.scroll().scrollTop = 100;
    await click(view.node, "返回");
    await pop(returnedRoot);
    await click(view.node, "外观");
    expect(view.page()).toBe("display");
    expect(view.scroll().scrollTop).toBe(100);
    // The controlled source is still valid; ordinary child navigation must
    // prefer the newer local offset over that immutable original snapshot.
    expect(view.context().read("profile-settings-page")).toMatchObject({
      positions: { display: 318 },
    });
    expectReadOnlyReturn();
  });

  it("does not rearm a cancelled delayed restore when the same page is revisited", async () => {
    vi.spyOn(window.history, "back").mockImplementation(() => {});
    await withClampedSettingsScroll(async () => {
      people.mockResolvedValueOnce({
        items: [person],
        page: 1,
        pageSize: 20,
        total: 1,
      });
      const view = await journey();
      await click(view.node, "已屏蔽账户");
      view.scroll().scrollTop = 318;
      const entry = await view.leave();
      people.mockClear();
      await view.returnChecking(entry);
      const pending = deferred<unknown>();
      people.mockReturnValueOnce(pending.promise);
      await view.confirm();
      await act(async () =>
        view
          .scroll()
          .dispatchEvent(
            new WheelEvent("wheel", { deltaY: 40, bubbles: true }),
          ),
      );
      await act(async () =>
        pending.resolve({ items: [person], page: 1, pageSize: 20, total: 1 }),
      );
      expect(view.scroll().scrollTop).toBe(0);
      const returnedRoot = { ...window.history.state, phase4DialogDepth: 0 };
      view.scroll().scrollTop = 100;
      await click(view.node, "返回");
      await pop(returnedRoot);
      await click(view.node, "已屏蔽账户");
      expect(view.scroll().scrollTop).toBe(100);
      expect(people).toHaveBeenCalledOnce();
      expectReadOnlyReturn();
    });
  });

  it("resumes an unfinished clamped restore after StrictMode replays the same-page effect", async () => {
    await withClampedSettingsScroll(async () => {
      people.mockResolvedValueOnce({
        items: [person],
        page: 1,
        pageSize: 20,
        total: 1,
      });
      const view = await journey({ strict: true });
      await click(view.node, "已屏蔽账户");
      view.scroll().scrollTop = 318;
      const entry = await view.leave();
      people.mockClear();
      await view.returnChecking(entry);
      const pending = deferred<unknown>();
      people.mockReturnValue(pending.promise);
      await view.confirm();
      expect(view.scroll().scrollTop).toBe(0);
      await act(async () =>
        pending.resolve({ items: [person], page: 1, pageSize: 20, total: 1 }),
      );
      expect(view.node.textContent).toContain(person.displayName);
      expect(view.scroll().scrollTop).toBe(318);
      expectReadOnlyReturn();
    });
  });
});

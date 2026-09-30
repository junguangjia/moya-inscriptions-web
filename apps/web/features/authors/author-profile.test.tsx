// @vitest-environment jsdom
import { act, createRef } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthorProfile } from "@moya/contracts";
import type { Root } from "react-dom/client";
const {
  profileRead,
  comments,
  openContent,
  navigatePrimary,
  openTopic,
  author,
  onViewChange,
  shell,
  beforeCommit,
  settingsDeparture,
} = vi.hoisted(() => ({
  beforeCommit: vi.fn(),
  settingsDeparture: {
    deferClose: false,
    pendingClose: null as (() => void) | null,
    completions: 0,
  },
  comments: vi.fn(),
  openContent: vi.fn(),
  navigatePrimary: vi.fn(),
  openTopic: vi.fn(),
  profileRead: vi.fn(),
  onViewChange: vi.fn(),
  shell: {
    platform: "phone" as "phone" | "pc",
    activeDestination: "user" as "home" | "user",
    feedLayout: "double",
  },
  author: {
    cache: new Map<string, unknown>(),
    viewer: null as { id: string } | null,
    checking: false,
    sessionError: false,
    revision: 1,
    signInHref: "/dev/community",
    mutate: vi.fn(),
    notify: vi.fn(),
  },
}));
vi.mock("./author-data", async (original) => ({
  ...(await original<typeof import("./author-data")>()),
  authorClient: { profile: profileRead, comments, command: vi.fn() },
}));
vi.mock("./author-context", () => ({ useAuthors: () => author }));
vi.mock("../product-shell/product-shell", () => ({
  useProductShell: () => ({
    ...shell,
    openContent,
    navigatePrimary,
    openTopic,
  }),
}));
vi.mock("../shell/horizontal-pager", async () => {
  const { useImperativeHandle } = await import("react");
  return {
    HorizontalPager: ({
      ref,
      onCommit,
      activeKey,
      scrollOwner,
      panels,
      visible,
    }: {
      ref: import("react").Ref<{ scrollToKey: (tab: string) => void }>;
      onCommit: (tab: string) => void;
      activeKey: string;
      scrollOwner: string;
      panels: Record<string, import("react").ReactNode>;
      visible: boolean;
    }) => {
      useImperativeHandle(ref, () => ({
        scrollToKey: (tab: string) => {
          beforeCommit(tab);
          onCommit(tab);
        },
      }));
      return (
        <div
          data-profile-pager={activeKey}
          data-scroll-owner={scrollOwner}
          data-pager-visible={String(visible)}
        >
          {panels[activeKey]}
        </div>
      );
    },
  };
});
vi.mock("./avatar-editor", () => ({
  AvatarEntry: ({ children }: { children: unknown }) => (
    <div>{children as never}</div>
  ),
}));
vi.mock("./profile-list", () => ({ ProfileList: () => null }));
vi.mock("./people-list", () => ({
  PeopleList: ({
    list,
    owner,
    onClose,
  }: {
    list: string;
    owner: boolean;
    onClose: () => void;
  }) => (
    <div role="dialog" aria-label={list} data-owner={owner}>
      <button onClick={onClose}>关闭名单</button>
    </div>
  ),
}));
vi.mock("./profile-editor", () => ({
  ProfileEditor: ({ onClose }: { onClose: () => void }) => (
    <div data-profile-editor="">
      <button onClick={onClose}>返回设置</button>
    </div>
  ),
}));
vi.mock("./profile-background-editor", () => ({
  ProfileBackgroundEditor: () => <div data-background-editor="" />,
}));
vi.mock("./profile-settings", () => ({
  ProfileSettings: ({
    onEdit,
    onClose,
    onDeparture,
  }: {
    onEdit?: () => void;
    onClose: () => void;
    onDeparture?: () => void;
  }) => (
    <div data-settings-stub="">
      <button
        onClick={() => {
          onDeparture?.();
          const finish = () => {
            settingsDeparture.completions++;
            onClose();
          };
          if (settingsDeparture.deferClose)
            settingsDeparture.pendingClose = finish;
          else finish();
        }}
      >
        关闭设置
      </button>
      {onEdit && <button onClick={onEdit}>编辑信息</button>}
    </div>
  ),
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn() }),
  usePathname: () => window.location.pathname,
}));
import { AuthReturnProvider, useAuthReturn } from "../auth/auth-return";
import {
  AuthorProfileOverlay,
  AuthorProfilePage,
  MyComments,
} from "./author-profile";
(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
const OWNER = `user-${"1".repeat(32)}`,
  VISITOR = `user-${"2".repeat(32)}`;
const profile = (isOwner: boolean): AuthorProfile => ({
  id: OWNER,
  handle: "synthetic-owner",
  displayName: "作者",
  bio: "",
  avatar: null,
  isOwner,
  following: false,
  privacy: {
    following: "public",
    followers: "public",
    favorites: "public",
    likes: "public",
  },
  totals: { works: 0, following: 1, followers: 2, favorites: 0, likes: 0 },
  nextAvatarChangeAt: null,
});
let root: Root | null = null;
const overlay = (tab: "works" | "comments" = "works") => (
  <AuthorProfileOverlay
    backButtonRef={createRef()}
    onClose={vi.fn()}
    onViewChange={onViewChange}
    state={{
      kind: "profile",
      version: 2,
      authorId: OWNER,
      entryId: "entry-1",
      tab,
      profileScrollTop: 0,
      sourceDestination: "home",
      sourceScrollTop: 0,
    }}
  />
);
const render = async (element = overlay()) => {
  const node = document.createElement("div");
  document.body.append(node);
  root = createRoot(node);
  await act(async () => root!.render(element));
  return node;
};
const button = (node: HTMLElement, text: string) =>
  Array.from(node.querySelectorAll("button")).find(
    (item) =>
      item.textContent === text || item.getAttribute("aria-label") === text,
  );
beforeEach(() => {
  beforeCommit.mockReset();
  settingsDeparture.deferClose = false;
  settingsDeparture.pendingClose = null;
  settingsDeparture.completions = 0;
  shell.platform = "phone";
  shell.activeDestination = "user";
  author.cache.clear();
  author.viewer = { id: OWNER };
  author.checking = false;
  author.sessionError = false;
  profileRead.mockResolvedValue(profile(true));
  comments.mockResolvedValue({ items: [], page: 1, total: 0 });
});
afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  document.body.replaceChildren();
  vi.clearAllMocks();
});
describe("Owner profile controls", () => {
  it("keeps edit info in Settings and exposes only an icon button for the cover", async () => {
    const node = await render();
    expect(node.querySelector('[aria-label="主页背景"]')).not.toBeNull();
    expect(node.querySelector("header")?.textContent).not.toContain("我的");
    for (const label of ["编辑信息", "主页背景", "我的评论", "回收站"])
      expect(button(node, label)).toBeUndefined();
    const coverEdit = button(node, "编辑主页背景")!;
    expect(coverEdit.closest('[aria-label="用户资料"]')).not.toBeNull();
    expect(coverEdit.textContent).toBe("");
    expect(button(node, "关注 1")?.querySelector("strong")?.textContent).toBe(
      "1",
    );
    expect(button(node, "粉丝 2")?.querySelector("strong")?.textContent).toBe(
      "2",
    );
    await act(async () => button(node, "设置")!.click());
    await act(async () => button(node, "编辑信息")!.click());
    expect(node.querySelector("[data-profile-editor]")).not.toBeNull();
    await act(async () => button(node, "返回设置")!.click());
    expect(node.querySelector("[data-settings-stub]")).not.toBeNull();
  });
  it("opens background editing and dedicated following/follower pages", async () => {
    const node = await render();
    await act(async () => button(node, "编辑主页背景")!.click());
    expect(node.querySelector("[data-background-editor]")).not.toBeNull();
    await act(async () => button(node, "关注 1")!.click());
    expect(
      node.querySelector('[aria-label="following"][data-owner="true"]'),
    ).not.toBeNull();
    await act(async () => button(node, "关闭名单")!.click());
    expect(node.querySelector('[aria-label="following"]')).toBeNull();
    await act(async () => button(node, "粉丝 2")!.click());
    expect(
      node.querySelector('[aria-label="followers"][data-owner="true"]'),
    ).not.toBeNull();
  });
  it("does not expose owner management for a remembered profile after account change", async () => {
    author.viewer = { id: VISITOR };
    author.cache.set(`profile:${OWNER}`, profile(true));
    profileRead.mockReturnValue(new Promise(() => undefined));
    const node = await render();
    expect(node.textContent).toContain("作者");
    for (const text of ["编辑信息", "编辑主页背景", "我的评论", "回收站"])
      expect(button(node, text)).toBeUndefined();
  });
  it("closes owner editing on account changes", async () => {
    const node = await render();
    await act(async () => button(node, "设置")!.click());
    await act(async () => button(node, "编辑信息")!.click());
    author.viewer = { id: VISITOR };
    profileRead.mockResolvedValue(profile(false));
    await act(async () => root!.render(overlay()));
    expect(node.querySelector("[data-profile-editor]")).toBeNull();
    expect(button(node, "编辑信息")).toBeUndefined();
  });
});

describe("Primary user profile", () => {
  it.each(["phone", "pc"] as const)(
    "shares header collapse while preserving body offsets in the %s scroll owner",
    async (platform) => {
      shell.platform = platform;
      const node = await render(
        <section data-primary-destination="user">
          <AuthorProfilePage onBack={vi.fn()} />
        </section>,
      );
      const owner =
        platform === "pc"
          ? document.documentElement
          : node.querySelector<HTMLElement>(
              '[data-primary-destination="user"]',
            )!;
      const descriptors = Object.getOwnPropertyDescriptors(owner);
      vi.spyOn(
        node.querySelector<HTMLElement>('[aria-label="用户资料"]')!,
        "getBoundingClientRect",
      ).mockReturnValue({ height: 600.4 } as DOMRect);
      let top = 0;
      let currentLimit = 1800;
      const maximum = () => currentLimit;
      // Real HorizontalPager sizes the destination before its commit callback.
      beforeCommit.mockImplementation((tab: string) => {
        currentLimit = tab === "works" ? 1800 : 600;
        top = Math.min(top, currentLimit);
      });
      // Model a browser's clamping when the new panel is shorter than its
      // scroll owner. Assertions observe the rendered scroll position only.
      Object.defineProperties(owner, {
        scrollHeight: { configurable: true, get: () => maximum() + 600 },
        clientHeight: { configurable: true, get: () => 600 },
        scrollTop: {
          configurable: true,
          get: () => (top = Math.min(top, maximum())),
          set: (value: number) => {
            top = Math.min(Math.max(0, value), maximum());
          },
        },
      });
      const scrollTo = (next: number) =>
        act(() => {
          owner.scrollTop = next;
          (platform === "pc" ? window : owner).dispatchEvent(
            new Event("scroll"),
          );
        });
      try {
        scrollTo(1260);
        await act(async () => button(node, "收藏")!.click());
        expect(button(node, "收藏")?.getAttribute("aria-selected")).toBe(
          "true",
        );
        expect(owner.scrollTop).toBe(600);
        await act(async () => button(node, "作品")!.click());
        expect(owner.scrollTop).toBe(1260);
        await act(async () => button(node, "收藏")!.click());
        expect(owner.scrollTop).toBe(600);
        scrollTo(130);
        await act(async () => button(node, "喜欢")!.click());
        expect(owner.scrollTop).toBe(130);
        await act(async () => button(node, "作品")!.click());
        expect(owner.scrollTop).toBe(130);
        scrollTo(0);
        await act(async () => button(node, "历史")!.click());
        expect(owner.scrollTop).toBe(0);
      } finally {
        for (const name of [
          "scrollHeight",
          "clientHeight",
          "scrollTop",
        ] as const) {
          const descriptor = descriptors[name];
          if (descriptor) Object.defineProperty(owner, name, descriptor);
          else delete (owner as unknown as Record<string, unknown>)[name];
        }
      }
    },
  );
  it("keeps the hidden desktop profile from capturing or resetting another primary page's scroll", async () => {
    shell.platform = "pc";
    const page = () => <AuthorProfilePage onBack={vi.fn()} />;
    const node = await render(page());
    act(() => {
      document.documentElement.scrollTop = 860;
      window.dispatchEvent(new Event("scroll"));
    });
    shell.activeDestination = "home";
    await act(async () => root!.render(page()));
    expect(node.querySelector('[data-pager-visible="false"]')).not.toBeNull();
    act(() => {
      document.documentElement.scrollTop = 300;
      window.dispatchEvent(new Event("scroll"));
    });
    await act(async () => root!.render(page()));
    expect(document.documentElement.scrollTop).toBe(300);
    shell.activeDestination = "user";
    await act(async () => root!.render(page()));
    expect(document.documentElement.scrollTop).toBe(860);
    expect(node.querySelector('[data-pager-visible="true"]')).not.toBeNull();
    document.documentElement.scrollTop = 0;
  });
  it("embeds in the primary scroll owner and sends Back home without opening an overlay", async () => {
    const onBack = vi.fn();
    const node = await render(<AuthorProfilePage onBack={onBack} />);
    expect(
      node.querySelector('[role="region"][aria-label="用户主页"]'),
    ).not.toBeNull();
    expect(node.querySelector('[role="dialog"], [aria-modal]')).toBeNull();
    expect(
      node
        .querySelector("[data-profile-pager]")
        ?.getAttribute("data-scroll-owner"),
    ).toBe("document");
    await act(async () => button(node, "收藏")!.click());
    expect(button(node, "收藏")?.getAttribute("aria-selected")).toBe("true");
    expect(
      node
        .querySelector("[data-profile-pager]")
        ?.getAttribute("data-profile-pager"),
    ).toBe("favorites");
    await act(async () => button(node, "返回")!.click());
    expect(onBack).toHaveBeenCalledOnce();
    expect(onViewChange).not.toHaveBeenCalled();
  });
  it("uses the supplied Search action on the primary root while overlays retain Back", async () => {
    const search = vi.fn();
    const node = await render(
      <AuthorProfilePage
        onBack={vi.fn()}
        headerStart={
          <button aria-label="搜索" onClick={search}>
            搜索
          </button>
        }
      />,
    );
    expect(button(node, "返回")).toBeUndefined();
    await act(async () => button(node, "搜索")!.click());
    expect(search).toHaveBeenCalledOnce();
    await act(async () => root!.render(overlay()));
    expect(button(node, "返回")).toBeDefined();
    expect(button(node, "搜索")).toBeUndefined();
  });
  it("resets account-scoped page state and owner controls when the session changes", async () => {
    const page = <AuthorProfilePage onBack={vi.fn()} />;
    const node = await render(page);
    await act(async () => button(node, "收藏")!.click());
    await act(async () => button(node, "编辑主页背景")!.click());
    author.viewer = null;
    await act(async () => root!.render(<AuthorProfilePage onBack={vi.fn()} />));
    expect(node.querySelector("[data-background-editor]")).toBeNull();
    expect(button(node, "编辑主页背景")).toBeUndefined();
    expect(button(node, "作品")?.getAttribute("aria-selected")).toBe("true");
    expect(node.textContent).toContain("访客");
  });
  it("does not revive the removed profile comments view from old history state", async () => {
    const node = await render(overlay("comments"));
    expect(button(node, "作品")?.getAttribute("aria-selected")).toBe("true");
    expect(node.textContent).not.toContain("我的评论");
    expect(node.querySelector('[data-author-panel="comments"]')).toBeNull();
  });
});

describe("Comments message content", () => {
  it("delegates opening a comment target so the message dialog can finish closing first", async () => {
    const target = { type: "work" as const, id: `work-${"3".repeat(32)}` };
    const commentId = `comment-${"4".repeat(32)}`;
    comments.mockResolvedValue({
      items: [
        {
          id: commentId,
          rootId: commentId,
          text: "测试评论",
          createdAt: "2026-09-20T10:00:00.000Z",
          deleted: false,
          target,
        },
      ],
      page: 1,
      total: 1,
    });
    const onOpenContent = vi.fn();
    const node = await render(
      <MyComments entryId="messages" onOpenContent={onOpenContent} />,
    );
    const opener = button(node, "前往评论位置")!;
    await act(async () => opener.click());
    expect(onOpenContent).toHaveBeenCalledWith(target, opener);
    expect(openContent).not.toHaveBeenCalled();
    expect(author.cache.get("discussion-location")).toEqual({
      target,
      id: commentId,
    });
  });

  const articleComment = () => {
    const target = {
      type: "article" as const,
      id: `article-${"6".repeat(32)}`,
    };
    const commentId = `comment-${"7".repeat(32)}`;
    comments.mockResolvedValue({
      items: [
        {
          id: commentId,
          rootId: commentId,
          text: "文章评论",
          createdAt: "2026-09-20T10:00:00.000Z",
          deleted: false,
          target,
        },
      ],
      page: 1,
      total: 1,
    });
    return target;
  };

  it("hands an Article comment to the host so it can close before the Article opens", async () => {
    const target = articleComment();
    const onOpenContent = vi.fn();
    const node = await render(
      <MyComments entryId="messages" onOpenContent={onOpenContent} />,
    );
    const opener = button(node, "前往评论位置")!;
    await act(async () => opener.click());
    expect(onOpenContent).toHaveBeenCalledWith(target, opener);
    expect(openTopic).not.toHaveBeenCalled();
    expect(navigatePrimary).not.toHaveBeenCalled();
  });

  it("opens an Article comment on the discussion destination without a host", async () => {
    const target = articleComment();
    const node = await render(<MyComments entryId="profile" />);
    const opener = button(node, "前往评论位置")!;
    await act(async () => opener.click());
    expect(navigatePrimary).toHaveBeenCalledWith("discussion");
    await act(async () => {
      await new Promise((resolve) =>
        requestAnimationFrame(() => resolve(null)),
      );
    });
    expect(openTopic).toHaveBeenCalledWith(target.id, opener, 0);
  });
});

describe("profile settings authentication snapshot lifetime", () => {
  it.each([
    { name: "explicitly closed", close: true, defer: false },
    { name: "left open during checking", close: false, defer: false },
    { name: "departing during animation", close: true, defer: true },
  ])(
    "handles a settings snapshot $name before the confirmed actor rekey",
    async ({ close, defer }) => {
      settingsDeparture.deferClose = defer;
      const sourcePath = "/#profile";
      const authPath = `/login?return=${encodeURIComponent(sourcePath)}`;
      const originalPath = `${window.location.pathname}${window.location.search}${window.location.hash}`;
      const originalHistory: unknown = window.history.state;
      const nativeReplace = window.history.replaceState;
      window.history.replaceState(
        { __artvennEntry: "synthetic-settings-parent" },
        "",
        sourcePath,
      );
      let state: ReturnType<typeof useAuthReturn>;
      const Probe = () => {
        state = useAuthReturn();
        return null;
      };
      const context = () => {
        if (!state) throw Error("Synthetic profile auth return missing");
        return state;
      };
      const mount = async (
        viewer: { id: string } | null,
        checking = false,
        mounted = true,
      ) => {
        author.viewer = viewer;
        author.checking = checking;
        await act(async () =>
          root!.render(
            <AuthReturnProvider>
              <Probe />
              {mounted && <AuthorProfilePage onBack={vi.fn()} />}
            </AuthReturnProvider>,
          ),
        );
      };
      const node = document.createElement("div");
      document.body.append(node);
      root = createRoot(node);
      try {
        await mount({ id: OWNER });
        await act(async () => button(node, "设置")!.click());
        expect(node.querySelector("[data-settings-stub]")).not.toBeNull();
        context().capture(sourcePath, null);
        const sourceEntry: unknown = window.history.state;
        await act(async () =>
          window.history.pushState({ __NA: true }, "", authPath),
        );
        await mount(null, true, false);
        expect(context().hasSource()).toBe(true);
        await act(async () => {
          nativeReplace.call(window.history, sourceEntry, "", sourcePath);
          window.dispatchEvent(
            new PopStateEvent("popstate", { state: sourceEntry }),
          );
        });
        await mount(null, true);
        expect(context().isRestoring()).toBe(true);
        expect(node.querySelector("[data-settings-stub]")).not.toBeNull();
        expect(context().read("profile-settings:primary-user")).toMatchObject({
          open: true,
        });
        if (close) {
          // Departure retires the actual parent snapshot before delayed onClose.
          await act(async () => button(node, "关闭设置")!.click());
          if (defer) {
            expect(node.querySelector("[data-settings-stub]")).not.toBeNull();
            expect(settingsDeparture.completions).toBe(0);
            expect(settingsDeparture.pendingClose).not.toBeNull();
          } else expect(node.querySelector("[data-settings-stub]")).toBeNull();
          expect(
            context().read("profile-settings:primary-user"),
          ).toBeUndefined();
        }
        expect(context().isRestoring()).toBe(true);
        context().identify(OWNER);
        await mount({ id: OWNER });
        expect(context().isRestoring()).toBe(true);
        if (close) {
          expect(node.querySelector("[data-settings-stub]")).toBeNull();
          if (defer) {
            // The confirmed actor has re-keyed before the old animation ends.
            expect(settingsDeparture.completions).toBe(0);
            await act(async () => settingsDeparture.pendingClose?.());
            expect(settingsDeparture.completions).toBe(1);
            expect(node.querySelector("[data-settings-stub]")).toBeNull();
          }
          // Explicit ordinary entry remains usable after retiring the snapshot.
          await act(async () => button(node, "设置")!.click());
          expect(node.querySelector("[data-settings-stub]")).not.toBeNull();
          expect(
            context().read("profile-settings:primary-user"),
          ).toBeUndefined();
        } else {
          // Checking cleanup and an actor rekey must retain a late restore.
          expect(node.querySelector("[data-settings-stub]")).not.toBeNull();
          expect(context().read("profile-settings:primary-user")).toMatchObject(
            { open: true },
          );
        }
      } finally {
        await act(async () => root?.unmount());
        root = null;
        window.history.replaceState(originalHistory, "", originalPath);
      }
    },
  );
});

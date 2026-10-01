// @vitest-environment jsdom
import { act, useEffect, useState } from "react";
import type { ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const { inbox, author, client } = vi.hoisted(() => ({
  inbox: {
    page: {
      observation: "synthetic-inbox-observation",
      unread: { total: 1, likes: 0, comments: 1, mentions: 0 },
      nextCursor: null,
      items: [
        {
          id: "notification-example",
          available: true,
          unread: true,
          target: { type: "work", id: "work-example" },
          commentId: "comment-example",
          actors: [{ id: "user-example", displayName: "书法学徒" }],
          actorCount: 1,
          reason: "comment",
          text: "收到的评论内容",
          createdAt: "2026-09-22T03:57:28.000Z",
          observation: "synthetic-item-observation",
        },
      ],
    },
    loading: false,
    error: "",
    setFilter: vi.fn(),
    refresh: vi.fn(),
    read: vi.fn(),
    more: vi.fn(),
  },
  author: {
    viewer: { id: "recipient-example" },
    checking: false,
    sessionError: false,
    cache: new Map(),
  },
  client: { locate: vi.fn(), card: vi.fn() },
}));
vi.mock("./notification-context", () => ({ useNotifications: () => inbox }));
vi.mock("../authors/author-context", () => ({ useAuthors: () => author }));
vi.mock("../authors/author-data", () => ({ authorClient: client }));
vi.mock("../authors/author-profile", () => ({
  MyComments: () => <p>Sent comments</p>,
}));
vi.mock("../authors/author-dialog", () => ({
  AuthorDialog: ({
    children,
    onClose,
    onBack,
    title,
    titleContent,
  }: {
    children: ReactNode;
    onClose: () => void;
    onBack?: () => void;
    title: string;
    titleContent?: ReactNode;
  }) => (
    <div role="dialog" aria-label={title}>
      <button data-close="" onClick={onClose}>
        Close
      </button>
      <button data-back="" onClick={onBack}>
        Back
      </button>
      <h2>{titleContent ?? title}</h2>
      {children}
    </div>
  ),
}));
vi.mock("../product-shell/product-shell", () => ({
  useProductShell: () => ({ activeContent: null, activeProfile: null }),
}));
import { LiveMessageTrigger } from "./live-message-center";
import type { DirectMessagePanelAdapter } from "./live-message-center";
import local from "./notifications.module.css";
(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
let node: HTMLDivElement, root: ReturnType<typeof createRoot>;
const item = inbox.page.items[0]!;
const button = (name: string) =>
  [...node.querySelectorAll("button")].find(
    (element) =>
      element.textContent === name ||
      element.getAttribute("aria-label")?.startsWith(name),
  )!;
const click = async (element: HTMLElement) => act(async () => element.click());
beforeEach(async () => {
  vi.clearAllMocks();
  window.history.replaceState({}, "", "/");
  item.reason = "comment";
  author.checking = false;
  author.sessionError = false;
  item.unread = true;
  inbox.loading = false;
  inbox.error = "";
  inbox.read.mockResolvedValue(undefined);
  client.locate.mockResolvedValue({});
  client.card.mockResolvedValue({});
  node = document.createElement("div");
  document.body.append(node);
  root = createRoot(node);
  await act(async () => root.render(<LiveMessageTrigger />));
  await click(button("打开消息"));
});
afterEach(async () => {
  await act(async () => root.unmount());
  node.remove();
});
describe("Owner notification reading interactions", () => {
  it.each(["评论", "赞和收藏"])(
    "the accessible refresh in %s keeps the all-observed-activity read semantics",
    async (category) => {
      await click(button(category));
      expect(node.textContent).not.toContain("全部标为已读");
      expect(node.textContent).not.toContain("未读");
      expect(
        node.querySelector('[data-notification-unread][aria-label="未读"]'),
      ).not.toBeNull();
      expect(node.querySelector("time")?.dateTime).toBe(item.createdAt);
      inbox.refresh.mockClear();
      await click(button("刷新消息"));
      expect(inbox.read).toHaveBeenCalledExactlyOnceWith(
        "synthetic-inbox-observation",
      );
      expect(inbox.refresh).not.toHaveBeenCalled();
    },
  );
  it.each(["comments", "likes", "mentions"] as const)(
    "opens the direct %s entry once and preserves dismissal",
    async (category) => {
      await act(async () => root.render(null));
      window.history.replaceState({}, "", `/?notifications=${category}`);
      inbox.setFilter.mockClear();
      await act(async () => root.render(<LiveMessageTrigger />));
      expect(node.querySelector('[role="dialog"]')).not.toBeNull();
      expect(inbox.setFilter).toHaveBeenCalledExactlyOnceWith(category);
      expect(
        node
          .querySelector("[data-message-view]")
          ?.getAttribute("data-message-view"),
      ).toBe(category === "likes" ? "reactions" : "comments");
      if (category === "mentions")
        expect(
          node.querySelector('[role="tab"][aria-selected="true"]')?.textContent,
        ).toBe("提到我");
      await click(node.querySelector<HTMLButtonElement>("[data-close]")!);
      await act(async () => root.render(<LiveMessageTrigger />));
      expect(node.querySelector('[role="dialog"]')).toBeNull();
      expect(inbox.read).not.toHaveBeenCalled();
    },
  );
  it("lets only the active header consume a direct entry", async () => {
    await act(async () => root.render(null));
    window.history.replaceState(
      {},
      "",
      "/?notifications=comments&feed=discover",
    );
    inbox.setFilter.mockClear();
    await act(async () =>
      root.render(
        <>
          <section hidden>
            <LiveMessageTrigger />
          </section>
          <LiveMessageTrigger />
        </>,
      ),
    );
    expect(node.querySelectorAll('[role="dialog"]')).toHaveLength(1);
    expect(node.querySelector('section [role="dialog"]')).toBeNull();
    expect(inbox.setFilter).toHaveBeenCalledExactlyOnceWith("comments");
    expect(
      new URLSearchParams(window.location.search).get("notifications"),
    ).toBeNull();
    expect(new URLSearchParams(window.location.search).get("feed")).toBe(
      "discover",
    );
  });
  // parallel-community-integration-qa: C's profile 私信 action stores an entry
  // request that the live host must open for, on the view holding the DM panel.
  const entryAdapter = (token: number | null) => ({
    render: () => <p data-dm-panel="">DM panel</p>,
    useUnreadConversationCount: () => 0,
    useOpenRequest: () => token,
  });
  it("opens only the active host on the direct-message view for an adapter entry request", async () => {
    await act(async () => root.render(null));
    const adapter = entryAdapter(7);
    await act(async () =>
      root.render(
        <>
          <section hidden>
            <LiveMessageTrigger directMessages={adapter} />
          </section>
          <LiveMessageTrigger directMessages={adapter} />
        </>,
      ),
    );
    expect(node.querySelectorAll('[role="dialog"]')).toHaveLength(1);
    expect(node.querySelector('section [role="dialog"]')).toBeNull();
    expect(
      node.querySelector('[role="dialog"] [data-dm-panel]'),
    ).not.toBeNull();
  });
  it("opens once the overlay that issued the entry request stops making the host inert", async () => {
    await act(async () => root.render(null));
    const adapter = entryAdapter(9);
    await act(async () =>
      root.render(
        <div data-overlay-backdrop="" inert>
          <LiveMessageTrigger directMessages={adapter} />
        </div>,
      ),
    );
    expect(node.querySelector('[role="dialog"]')).toBeNull();
    await act(async () => {
      node.querySelector("[data-overlay-backdrop]")!.removeAttribute("inert");
      await new Promise((resolve) => setTimeout(resolve, 120));
    });
    expect(node.querySelectorAll('[role="dialog"]')).toHaveLength(1);
    expect(
      node.querySelector('[role="dialog"] [data-dm-panel]'),
    ).not.toBeNull();
  });
  it("does not open without an entry request", async () => {
    await act(async () => root.render(null));
    await act(async () =>
      root.render(<LiveMessageTrigger directMessages={entryAdapter(null)} />),
    );
    expect(node.querySelector('[role="dialog"]')).toBeNull();
  });
  it("ignores an unknown category and retains ordinary message navigation", async () => {
    await act(async () => root.render(null));
    window.history.replaceState({}, "", "/?notifications=unknown");
    await act(async () => root.render(<LiveMessageTrigger />));
    expect(node.querySelector('[role="dialog"]')).toBeNull();
    await click(button("打开消息"));
    expect(
      node
        .querySelector("[data-message-view]")
        ?.getAttribute("data-message-view"),
    ).toBe("home");
  });
  it("opening a comment reads only its observation and removes the dot after server confirmation", async () => {
    await click(button("评论"));
    const entry = node.querySelector("[data-notification-id]")!;
    await click(
      [...entry.querySelectorAll("button")].find((element) =>
        element.textContent?.includes("查看原内容"),
      )!,
    );
    expect(client.locate).toHaveBeenCalledWith(item.target, item.commentId, []);
    expect(inbox.read).toHaveBeenCalledExactlyOnceWith(item.observation);
    item.unread = false;
    await act(async () => root.render(<LiveMessageTrigger />));
    expect(node.querySelector("[data-notification-unread]")).toBeNull();
  });
  it("opening the message center does not consume new incoming activity", () => {
    expect(inbox.refresh).toHaveBeenCalledOnce();
    expect(inbox.read).not.toHaveBeenCalled();
  });
  // parallel-community-integration-qa: an open conversation replaces the home
  // content as in the accepted chat. The panel stays mounted, fills the body
  // and hands the participant to the dialog header.
  it("gives an open conversation the whole body and the header, and restores home on Back", async () => {
    let mounts = 0;
    const Panel = ({
      onDepthChange,
      onTitleChange,
      backRequested,
    }: Parameters<DirectMessagePanelAdapter["render"]>[0]) => {
      const [open, setOpen] = useState(false);
      const [mount] = useState(() => ++mounts);
      useEffect(() => onDepthChange(open ? 1 : 0), [open, onDepthChange]);
      useEffect(() => {
        if (backRequested > 0) setOpen(false);
      }, [backRequested]);
      useEffect(() => {
        if (!open) return;
        onTitleChange({
          label: "书法学徒",
          content: <button aria-label="查看书法学徒的主页">书法学徒</button>,
        });
        return () => onTitleChange(null);
      }, [open, onTitleChange]);
      return open ? (
        <div data-dm-view="conversation" data-mount={mount} />
      ) : (
        <button data-dm-row="" onClick={() => setOpen(true)}>
          row
        </button>
      );
    };
    const adapter: DirectMessagePanelAdapter = {
      render: (props) => <Panel {...props} />,
      useUnreadConversationCount: () => 0,
    };
    inbox.error = "动态暂时不可用";
    await act(async () => root.render(null));
    await act(async () =>
      root.render(<LiveMessageTrigger directMessages={adapter} />),
    );
    await click(button("打开消息"));
    const content = () => node.querySelector("[data-message-live]")!;
    const heading = () => node.querySelector('[role="dialog"] h2')!;
    expect(node.querySelector('nav[aria-label="消息分类"]')).not.toBeNull();
    expect(content().className).not.toContain(local.directOpen);
    expect(heading().textContent).toBe("消息");
    expect(content().textContent).toContain("动态暂时不可用");

    await click(node.querySelector("[data-dm-row]") as HTMLElement);
    expect(node.querySelector('nav[aria-label="消息分类"]')).toBeNull();
    expect(
      [...node.querySelectorAll("h3")].map((h) => h.textContent),
    ).not.toContain("私信");
    expect(content().className).toContain(local.directOpen);
    expect(
      content().querySelector(`.${local.directRegion} [data-dm-view]`),
    ).not.toBeNull();
    expect(
      heading().querySelector('button[aria-label="查看书法学徒的主页"]'),
    ).not.toBeNull();
    expect(
      node.querySelector('[role="dialog"]')!.getAttribute("aria-label"),
    ).toBe("书法学徒");
    expect(content().textContent).not.toContain("动态暂时不可用");

    await click(node.querySelector("[data-back]") as HTMLElement);
    expect(node.querySelector('nav[aria-label="消息分类"]')).not.toBeNull();
    expect(content().className).not.toContain(local.directOpen);
    expect(heading().textContent).toBe("消息");
    expect(node.querySelector("[data-dm-row]")).not.toBeNull();
    // The panel kept its state across the change: it was never remounted.
    expect(mounts).toBe(1);
    inbox.error = "";
  });
  // parallel-community-integration-qa: window focus and reconnect revalidate
  // the confirmed account; an open conversation must survive that.
  it.each(["checking", "sessionError"] as const)(
    "keeps an open conversation mounted while the confirmed account revalidates (%s)",
    async (flag) => {
      let mounts = 0;
      const Panel = ({
        onDepthChange,
      }: Parameters<DirectMessagePanelAdapter["render"]>[0]) => {
        const [open, setOpen] = useState(false);
        useState(() => ++mounts);
        useEffect(() => onDepthChange(open ? 1 : 0), [open, onDepthChange]);
        return open ? (
          <div data-dm-view="conversation" />
        ) : (
          <button data-dm-row="" onClick={() => setOpen(true)}>
            row
          </button>
        );
      };
      const adapter: DirectMessagePanelAdapter = {
        render: (props) => <Panel {...props} />,
        useUnreadConversationCount: () => 0,
      };
      await act(async () => root.render(null));
      await act(async () =>
        root.render(<LiveMessageTrigger directMessages={adapter} />),
      );
      await click(button("打开消息"));
      await click(node.querySelector("[data-dm-row]") as HTMLElement);
      expect(
        node.querySelector('[data-dm-view="conversation"]'),
      ).not.toBeNull();

      author[flag] = true;
      await act(async () =>
        root.render(<LiveMessageTrigger directMessages={adapter} />),
      );
      expect(
        node.querySelector('[data-dm-view="conversation"]'),
      ).not.toBeNull();
      expect(node.textContent).not.toContain("正在确认账户");
      author[flag] = false;
      await act(async () =>
        root.render(<LiveMessageTrigger directMessages={adapter} />),
      );
      expect(
        node.querySelector('[data-dm-view="conversation"]'),
      ).not.toBeNull();
      expect(mounts).toBe(1);
    },
  );
  it("still shows the account states while no account is confirmed", async () => {
    const viewer = author.viewer;
    author.viewer = null as unknown as typeof viewer;
    author.checking = true;
    await act(async () => root.render(null));
    await act(async () => root.render(<LiveMessageTrigger />));
    await click(button("打开消息"));
    expect(node.textContent).toContain("正在确认账户");
    author.checking = false;
    author.viewer = viewer;
  });
});

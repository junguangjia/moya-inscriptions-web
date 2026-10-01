// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { author, shell, calls } = vi.hoisted(() => ({
  author: {
    viewer: null as { id: string } | null,
    checking: false,
    sessionError: false,
    signInHref: "/dev/community",
    revision: 0,
  },
  shell: { platform: "pc", openProfile: vi.fn() },
  calls: [] as { method: string; url: string; body: unknown }[],
}));
vi.mock("../authors/author-context", () => ({ useAuthors: () => author }));
vi.mock("../product-shell/product-shell", () => ({
  useProductShell: () => shell,
}));
vi.mock("../shell/request-identity", () => ({
  requestIdentity: () => "11111111-1111-4111-8111-111111111111",
}));
import { DirectMessagePanel } from "./direct-message-panel";
import type { DirectMessageTitle } from "./direct-message-panel";
import { authorClient } from "./message-data";
import previewStyles from "../authors/message-preview.module.css";
import panelStyles from "./direct-message-panel.module.css";

const me = `user-${"1".repeat(32)}`;
const other = `user-${"2".repeat(32)}`;
const conversationId = `dm-${"c".repeat(32)}`;
const conversation = (over: Record<string, unknown> = {}) => ({
  id: conversationId,
  participant: { id: other, displayName: "书法学徒", available: true },
  state: "requested",
  canSend: false,
  sendRefusal: "request_pending",
  lastMessage: {
    sequence: 1,
    senderId: me,
    text: "你好",
    removed: false,
    createdAt: "2026-09-22T00:00:00.000Z",
  },
  unreadCount: 0,
  muted: false,
  hidden: false,
  readSequence: 1,
  createdAt: "2026-09-22T00:00:00.000Z",
  ...over,
});
const message = (sequence: number, senderId: string, text: string) => ({
  id: `dmsg-${String(sequence).repeat(32).slice(0, 32)}`,
  conversationId,
  sequence,
  senderId,
  text,
  removed: false,
  createdAt: "2026-09-22T00:00:01.000Z",
});
let state: "requested" | "active" = "requested";
/** When true every request fails as a browser without a network does. */
let offline = false;
/** When set, the server refuses a send with this 422 reason. */
let refuseSendWith: string | null = null;
const respond = (url: string, method: string, body: unknown) => {
  if (url.endsWith("/api/community/messages/unread"))
    return { unreadConversations: 0 };
  if (url.includes("/api/community/messages?"))
    return {
      items: [
        conversation({
          state,
          canSend: state === "active",
          sendRefusal: state === "active" ? null : "request_pending",
        }),
      ],
      nextCursor: null,
    };
  if (url.includes(`/api/community/messages/${conversationId}?`))
    return {
      conversation: conversation({
        state,
        canSend: state === "active",
        sendRefusal: state === "active" ? null : "request_pending",
      }),
      items:
        state === "active"
          ? [message(2, other, "在的"), message(1, me, "你好")]
          : [message(1, me, "你好")],
      nextBefore: null,
    };
  if (
    url.endsWith("/api/community/messages") &&
    method === "POST" &&
    refuseSendWith !== null
  ) {
    // The server's truth after a gate refusal is the requested state.
    if (refuseSendWith === "dm_request_pending") state = "requested";
    return {
      status: 422,
      json: {
        error: {
          code: "INVALID_INPUT",
          message: refuseSendWith,
          requestId: "22222222-2222-4222-8222-222222222222",
        },
      },
    };
  }
  if (url.endsWith("/api/community/messages") && method === "POST") {
    const text = (body as { text: string }).text;
    return { status: 201, json: message(3, me, text) };
  }
  if (url.includes("/api/community/messages/with/"))
    return { conversation: null };
  const action =
    /\/api\/community\/messages\/[^/]+\/(hide|unhide|mute|unmute)$/.exec(
      url,
    )?.[1];
  if (action && method === "POST")
    return conversation({
      state,
      canSend: state === "active",
      sendRefusal: state === "active" ? null : "request_pending",
      muted: action === "mute",
      hidden: action === "hide",
    });
  if (url.endsWith("/read"))
    return conversation({
      state,
      canSend: state === "active",
      sendRefusal: state === "active" ? null : "request_pending",
      readSequence: 2,
    });
  throw new Error(`unexpected ${method} ${url}`);
};

let node: HTMLDivElement;
let root: Root;
beforeEach(() => {
  calls.length = 0;
  state = "requested";
  offline = false;
  refuseSendWith = null;
  author.viewer = null;
  author.checking = false;
  author.sessionError = false;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ method, url: input, body });
      if (offline) throw new TypeError("Failed to fetch");
      const answer = respond(input, method, body) as {
        status?: number;
        json?: unknown;
      };
      const status = "status" in answer && answer.status ? answer.status : 200;
      const payload =
        "json" in answer && answer.json !== undefined ? answer.json : answer;
      return new Response(JSON.stringify(payload), {
        status,
        headers: { "content-type": "application/json" },
      });
    }),
  );
  node = document.createElement("div");
  document.body.appendChild(node);
  root = createRoot(node);
});
afterEach(async () => {
  await act(async () => root.unmount());
  node.remove();
  vi.unstubAllGlobals();
});
const flush = () =>
  act(async () => {
    await new Promise((r) => setTimeout(r, 20));
  });

describe("DirectMessagePanel (content-community-completion-v1)", () => {
  it("shows the truthful signed-out state and makes no request", async () => {
    await act(async () =>
      root.render(<DirectMessagePanel onOpenProfile={vi.fn()} />),
    );
    expect(node.textContent).toContain("登录后查看私信");
    expect(calls).toEqual([]);
  });

  it("lists real conversations, explains the request gate and never fakes a sent message", async () => {
    author.viewer = { id: me };
    authorClient.setAccount(me);
    await act(async () =>
      root.render(<DirectMessagePanel onOpenProfile={vi.fn()} />),
    );
    await flush();
    expect(node.textContent).toContain("书法学徒");
    // Owner acceptance (2026-09-25): a row shows no visible request tag, only
    // the unread count; its accessible name still states the request.
    expect(node.querySelector("[data-dm-row]")?.textContent).not.toContain(
      "等待对方回复",
    );
    expect(
      node
        .querySelector('button[aria-label^="打开与"]')
        ?.getAttribute("aria-label"),
    ).toContain("等待对方回复");
    await act(async () =>
      (
        node.querySelector('button[aria-label^="打开与"]') as HTMLButtonElement
      ).click(),
    );
    await flush();
    expect(node.querySelector("[data-dm-refusal]")?.textContent).toContain(
      "等对方回复后才能继续发送",
    );
    expect(node.querySelector('textarea[aria-label="私信内容"]')).toBeNull();
    expect(calls.some((c) => c.method === "POST")).toBe(false);
  });

  it("sends from the composer once the pair is active and appends the committed message", async () => {
    author.viewer = { id: me };
    authorClient.setAccount(me);
    state = "active";
    await act(async () =>
      root.render(<DirectMessagePanel onOpenProfile={vi.fn()} />),
    );
    await flush();
    await act(async () =>
      (
        node.querySelector('button[aria-label^="打开与"]') as HTMLButtonElement
      ).click(),
    );
    await flush();
    const textarea = node.querySelector(
      'textarea[aria-label="私信内容"]',
    ) as HTMLTextAreaElement;
    expect(textarea).not.toBeNull();
    const setter = Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      "value",
    )!.set!;
    await act(async () => {
      setter.call(textarea, "太好了");
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => textarea.closest("form")!.requestSubmit());
    await flush();
    const sent = calls.find(
      (c) => c.method === "POST" && c.url.endsWith("/api/community/messages"),
    );
    expect(sent?.body).toEqual({
      requestId: "11111111-1111-4111-8111-111111111111",
      conversationId,
      text: "太好了",
    });
    // The sender never travels in the body; the message list is re-read, not fabricated.
    expect(JSON.stringify(sent?.body)).not.toContain("senderId");
    const historyReads = calls.filter(
      (c) =>
        c.method === "GET" &&
        c.url.includes(`/api/community/messages/${conversationId}`),
    );
    expect(historyReads.length).toBeGreaterThanOrEqual(2);
    expect(calls.indexOf(historyReads.at(-1)!)).toBeGreaterThan(
      calls.indexOf(sent!),
    );
  });
});

const key = (target: Element, name: string) =>
  act(async () => {
    target.dispatchEvent(
      new KeyboardEvent("keydown", { key: name, bubbles: true }),
    );
  });
const openFirstConversation = async () => {
  await act(async () =>
    (
      node.querySelector('button[aria-label^="打开与"]') as HTMLButtonElement
    ).click(),
  );
  await flush();
};

describe("DirectMessagePanel rows, notices and header (C3 repair)", () => {
  it("keeps a row's actions covered and disabled until ArrowLeft reveals them; Escape or the row closes them", async () => {
    author.viewer = { id: me };
    authorClient.setAccount(me);
    state = "active";
    await act(async () =>
      root.render(<DirectMessagePanel onOpenProfile={vi.fn()} />),
    );
    await flush();
    const row = node.querySelector(
      `[data-dm-row="${conversationId}"]`,
    ) as HTMLLIElement;
    const open = row.querySelector(
      'button[aria-label^="打开与"]',
    ) as HTMLButtonElement;
    const mute = row.querySelector(
      'button[aria-label="静音"]',
    ) as HTMLButtonElement;
    const hide = row.querySelector(
      'button[aria-label="删除对话"]',
    ) as HTMLButtonElement;
    expect(row.dataset.reveal).toBe("0");
    expect([mute.disabled, hide.disabled]).toEqual([true, true]);
    expect(
      row.querySelector('[role="group"]')?.getAttribute("aria-hidden"),
    ).toBe("true");

    open.focus();
    await key(open, "ArrowLeft");
    await flush();
    expect(row.dataset.reveal).toBe("136");
    expect([mute.disabled, hide.disabled]).toEqual([false, false]);
    expect(document.activeElement).toBe(mute);

    await key(mute, "Escape");
    expect(row.dataset.reveal).toBe("0");
    expect(document.activeElement).toBe(open);

    // Activating the row while its actions show closes them instead of opening.
    await key(open, "ArrowLeft");
    await act(async () => open.click());
    await flush();
    expect(row.dataset.reveal).toBe("0");
    expect(node.querySelector("[data-dm-view]")).toBeNull();
    expect(calls.some((c) => c.method === "POST")).toBe(false);
  });

  it("mutes and hides only from the revealed actions; hiding offers Undo in the floating notice", async () => {
    author.viewer = { id: me };
    authorClient.setAccount(me);
    state = "active";
    await act(async () =>
      root.render(<DirectMessagePanel onOpenProfile={vi.fn()} />),
    );
    await flush();
    const open = () =>
      node.querySelector('button[aria-label^="打开与"]') as HTMLButtonElement;
    await key(open(), "ArrowLeft");
    await act(async () =>
      (
        node.querySelector('button[aria-label="静音"]') as HTMLButtonElement
      ).click(),
    );
    await flush();
    expect(calls.some((c) => c.url.endsWith(`/${conversationId}/mute`))).toBe(
      true,
    );
    expect(open().getAttribute("aria-label")).toContain("已静音");
    expect(
      node.querySelector('[role="img"][aria-label="已静音"]'),
    ).not.toBeNull();

    await key(open(), "ArrowLeft");
    await act(async () =>
      (
        node.querySelector('button[aria-label="删除对话"]') as HTMLButtonElement
      ).click(),
    );
    await flush();
    expect(node.querySelector(`[data-dm-row="${conversationId}"]`)).toBeNull();
    const notice = node.querySelector("[data-dm-notice]") as HTMLElement;
    expect(notice.textContent).toContain("已删除对话");
    expect(notice.className).toContain(previewStyles.notice);
    await act(async () => notice.querySelector("button")!.click());
    await flush();
    expect(calls.some((c) => c.url.endsWith(`/${conversationId}/unhide`))).toBe(
      true,
    );
    expect(
      node.querySelector(`[data-dm-row="${conversationId}"]`),
    ).not.toBeNull();
  });

  it("keeps request, gate, refusal and start notices inline, never as the floating toast", async () => {
    author.viewer = { id: me };
    authorClient.setAccount(me);
    await act(async () =>
      root.render(<DirectMessagePanel onOpenProfile={vi.fn()} />),
    );
    await flush();
    const inline = (element: Element | null) => {
      expect(element).not.toBeNull();
      expect(element!.className).not.toContain(previewStyles.notice);
    };
    expect(
      [...node.querySelectorAll("[data-dm-row] span")].some((span) =>
        ["等待对方回复", "私信请求"].includes(span.textContent ?? ""),
      ),
    ).toBe(false);
    await openFirstConversation();
    inline(node.querySelector("[data-dm-gate]"));
    inline(node.querySelector("[data-dm-refusal]"));
    expect(node.querySelector("[data-dm-refusal]")!.className).toContain(
      panelStyles.inlineNotice,
    );

    await act(async () => root.unmount());
    root = createRoot(node);
    await act(async () =>
      root.render(
        <DirectMessagePanel
          onOpenProfile={vi.fn()}
          openWith={{ userId: other, displayName: "书法学徒" }}
        />,
      ),
    );
    await flush();
    const start = node.querySelector('[data-dm-view="start"]');
    expect(start).not.toBeNull();
    inline(start!.querySelector('[role="status"]'));
    expect(calls.some((c) => c.method === "POST")).toBe(false);
  });

  it("hands the participant to a host header, clears it on Back, and keeps its own title row without that seam", async () => {
    author.viewer = { id: me };
    authorClient.setAccount(me);
    state = "active";
    const titles: (DirectMessageTitle | null)[] = [];
    const onTitleChange = (title: DirectMessageTitle | null) => {
      titles.push(title);
    };
    const onOpenProfile = vi.fn();
    const depths: number[] = [];
    const onDepthChange = (depth: number) => {
      depths.push(depth);
    };
    const panel = (back: number) => (
      <DirectMessagePanel
        onOpenProfile={onOpenProfile}
        onTitleChange={onTitleChange}
        onDepthChange={onDepthChange}
        backRequested={back}
      />
    );
    await act(async () => root.render(panel(0)));
    await flush();
    await openFirstConversation();
    const view = node.querySelector('[data-dm-view="conversation"]')!;
    expect(view.getAttribute("data-dm-title")).toBe("host");
    expect(view.querySelector(`.${panelStyles.title}`)).toBeNull();
    const header = titles.at(-1)!;
    expect(header.label).toBe("书法学徒");

    // The host renders the header content; it opens the participant's profile.
    const hostNode = document.createElement("div");
    document.body.append(hostNode);
    const hostRoot = createRoot(hostNode);
    await act(async () => hostRoot.render(header.content));
    const button = hostNode.querySelector(
      'button[aria-label="查看书法学徒的主页"]',
    ) as HTMLButtonElement;
    expect(button.textContent).toContain("书法学徒");
    await act(async () => button.click());
    expect(onOpenProfile).toHaveBeenCalledWith(other, button);
    await act(async () => hostRoot.unmount());
    hostNode.remove();

    await act(async () => root.render(panel(1)));
    await flush();
    expect(titles.at(-1)).toBeNull();
    expect(depths.at(-1)).toBe(0);

    await act(async () => root.unmount());
    root = createRoot(node);
    await act(async () =>
      root.render(<DirectMessagePanel onOpenProfile={vi.fn()} />),
    );
    await flush();
    await openFirstConversation();
    const fallback = node.querySelector('[data-dm-view="conversation"]')!;
    expect(fallback.getAttribute("data-dm-title")).toBe("view");
    expect(
      fallback.querySelector(`.${panelStyles.title}`)?.textContent,
    ).toContain("书法学徒");
  });

  it("returns focus to the composer when sending dropped it", async () => {
    author.viewer = { id: me };
    authorClient.setAccount(me);
    state = "active";
    await act(async () =>
      root.render(<DirectMessagePanel onOpenProfile={vi.fn()} />),
    );
    await flush();
    await openFirstConversation();
    const textarea = node.querySelector(
      'textarea[aria-label="私信内容"]',
    ) as HTMLTextAreaElement;
    const setter = Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      "value",
    )!.set!;
    await act(async () => {
      setter.call(textarea, "收到");
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
    });
    // A browser drops focus from the submit button once sending disables it.
    const submit = textarea
      .closest("form")!
      .querySelector('button[type="submit"]') as HTMLButtonElement;
    submit.focus();
    submit.blur();
    expect(document.activeElement).toBe(document.body);
    await act(async () => textarea.closest("form")!.requestSubmit());
    await flush();
    expect(textarea.value).toBe("");
    expect(document.activeElement).toBe(textarea);
  });

  it("keeps the accepted chat structure: a scrolling stream above the bottom composer", async () => {
    author.viewer = { id: me };
    authorClient.setAccount(me);
    state = "active";
    const structure = (view: Element) =>
      [...view.children].map((child) =>
        child.hasAttribute("data-dm-stream") ||
        child.className.includes(previewStyles.chatStream!)
          ? "stream"
          : child.hasAttribute("data-message-composer")
            ? "composer"
            : child.className.includes(panelStyles.title!)
              ? "title"
              : child.tagName.toLowerCase(),
      );
    await act(async () =>
      root.render(
        <DirectMessagePanel onOpenProfile={vi.fn()} onTitleChange={vi.fn()} />,
      ),
    );
    await flush();
    await openFirstConversation();
    const chat = node.querySelector('[data-dm-view="conversation"]')!;
    expect(chat.className).toContain(previewStyles.chat);
    expect(structure(chat)).toEqual(["stream", "composer"]);
    const composer = chat.querySelector("[data-message-composer]")!;
    expect(composer.className).toContain(previewStyles.chatComposer);
    const textarea = composer.querySelector('textarea[aria-label="私信内容"]');
    expect(textarea).not.toBeNull();
    // Owner acceptance (2026-09-25): the same box-and-send shape as comments,
    // with no avatar beside it.
    const send = composer.querySelector('button[type="submit"]')!;
    expect(send.parentElement!.contains(textarea)).toBe(true);
    expect([...send.parentElement!.children].at(-1)).toBe(send);
    expect(composer.textContent).not.toContain("我");
    expect(composer.querySelector('[aria-label="查看我的主页"]')).toBeNull();

    await act(async () => root.unmount());
    root = createRoot(node);
    await act(async () =>
      root.render(
        <DirectMessagePanel
          onOpenProfile={vi.fn()}
          openWith={{ userId: other, displayName: "书法学徒" }}
        />,
      ),
    );
    await flush();
    const start = node.querySelector('[data-dm-view="start"]')!;
    expect(start.className).toContain(previewStyles.chat);
    expect(structure(start)).toEqual(["title", "stream", "composer"]);
  });

  it("settles when a host passes a new title callback on every render", async () => {
    author.viewer = { id: me };
    authorClient.setAccount(me);
    state = "active";
    let calls = 0;
    const { useState: useHostState } = await import("react");
    const Host = () => {
      const [title, setTitle] = useHostState<DirectMessageTitle | null>(null);
      return (
        <>
          <p data-host-title="">{title?.label ?? "消息"}</p>
          <DirectMessagePanel
            onOpenProfile={vi.fn()}
            onTitleChange={(next) => {
              calls += 1;
              setTitle(next);
            }}
          />
        </>
      );
    };
    await act(async () => root.render(<Host />));
    await flush();
    await openFirstConversation();
    await flush();
    expect(node.querySelector("[data-host-title]")?.textContent).toBe(
      "书法学徒",
    );
    expect(calls).toBeLessThanOrEqual(2);
  });

  it("keeps the conversation and the typed draft when a send and its refresh both fail", async () => {
    author.viewer = { id: me };
    authorClient.setAccount(me);
    state = "active";
    await act(async () =>
      root.render(<DirectMessagePanel onOpenProfile={vi.fn()} />),
    );
    await flush();
    await openFirstConversation();
    const textarea = node.querySelector(
      'textarea[aria-label="私信内容"]',
    ) as HTMLTextAreaElement;
    const setter = Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      "value",
    )!.set!;
    await act(async () => {
      setter.call(textarea, "离线时写下的草稿");
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
    });
    offline = true;
    await act(async () => textarea.closest("form")!.requestSubmit());
    await flush();
    expect(node.querySelector('[data-dm-view="conversation"]')).not.toBeNull();
    expect(
      (
        node.querySelector(
          'textarea[aria-label="私信内容"]',
        ) as HTMLTextAreaElement
      ).value,
    ).toBe("离线时写下的草稿");
    expect(node.querySelector("[data-dm-error]")).not.toBeNull();

    offline = false;
    await act(async () => textarea.closest("form")!.requestSubmit());
    await flush();
    expect(
      calls.filter(
        (c) => c.method === "POST" && c.url.endsWith("/api/community/messages"),
      ),
    ).toHaveLength(2);
    expect(
      (
        node.querySelector(
          'textarea[aria-label="私信内容"]',
        ) as HTMLTextAreaElement
      ).value,
    ).toBe("");
  });

  it("offers a retry when a conversation cannot be loaded", async () => {
    author.viewer = { id: me };
    authorClient.setAccount(me);
    state = "active";
    await act(async () =>
      root.render(<DirectMessagePanel onOpenProfile={vi.fn()} />),
    );
    await flush();
    offline = true;
    await openFirstConversation();
    const failed = node.querySelector('[data-dm-view-state="unavailable"]');
    expect(failed?.getAttribute("role")).toBe("alert");
    const retry = [...failed!.querySelectorAll("button")].find(
      (b) => b.textContent === "重试",
    )!;
    offline = false;
    await act(async () => retry.click());
    await flush();
    expect(node.querySelector('[data-dm-view="conversation"]')).not.toBeNull();
  });

  const typeAndSend = async (text: string) => {
    const textarea = node.querySelector(
      'textarea[aria-label="私信内容"]',
    ) as HTMLTextAreaElement;
    const setter = Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      "value",
    )!.set!;
    await act(async () => {
      setter.call(textarea, text);
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => textarea.closest("form")!.requestSubmit());
    await flush();
  };

  it.each([
    ["dm_blocked", "对方目前不接受你的私信。"],
    ["dm_daily_limit", "今天新发起的私信对话已达上限，请明天再试。"],
    ["dm_rate_limited", "发送太快了，请稍后再试。"],
  ])(
    "shows the server's exact reason when a first message is refused (%s)",
    async (reason, text) => {
      author.viewer = { id: me };
      authorClient.setAccount(me);
      refuseSendWith = reason;
      await act(async () =>
        root.render(
          <DirectMessagePanel
            onOpenProfile={vi.fn()}
            openWith={{ userId: other, displayName: "书法学徒" }}
          />,
        ),
      );
      await flush();
      await typeAndSend("你好");
      expect(node.querySelector("[data-dm-error]")?.textContent).toBe(text);
      expect(node.textContent).not.toContain("暂时无法完成");
      expect(
        (
          node.querySelector(
            'textarea[aria-label="私信内容"]',
          ) as HTMLTextAreaElement
        ).value,
      ).toBe("你好");
    },
  );

  it("shows a gate refusal once, as the composer's reason, not beside a generic retry", async () => {
    author.viewer = { id: me };
    authorClient.setAccount(me);
    state = "active";
    await act(async () =>
      root.render(<DirectMessagePanel onOpenProfile={vi.fn()} />),
    );
    await flush();
    await openFirstConversation();
    refuseSendWith = "dm_request_pending";
    await typeAndSend("还在吗");
    expect(node.querySelector("[data-dm-refusal]")?.textContent).toBe(
      "你已发送一条私信，等对方回复后才能继续发送。",
    );
    expect(node.querySelector("[data-dm-error]")).toBeNull();
    expect(node.textContent).not.toContain("暂时无法完成");
  });

  it("does not bring a stale refusal back as an alert once the pair can send again", async () => {
    author.viewer = { id: me };
    authorClient.setAccount(me);
    state = "active";
    await act(async () =>
      root.render(<DirectMessagePanel onOpenProfile={vi.fn()} />),
    );
    await flush();
    await openFirstConversation();
    refuseSendWith = "dm_request_pending";
    await typeAndSend("还在吗");
    expect(node.querySelector("[data-dm-refusal]")).not.toBeNull();
    // The recipient replies: the pair is active again and the next poll says so.
    refuseSendWith = null;
    state = "active";
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await flush();
    expect(node.querySelector("[data-dm-refusal]")).toBeNull();
    expect(
      node.querySelector('textarea[aria-label="私信内容"]'),
    ).not.toBeNull();
    expect(node.querySelector("[data-dm-error]")).toBeNull();
  });

  it.each(["checking", "sessionError"] as const)(
    "keeps an open conversation and its draft while the confirmed account revalidates (%s)",
    async (flag) => {
      author.viewer = { id: me };
      authorClient.setAccount(me);
      state = "active";
      const onDepthChange = vi.fn();
      const panel = () => (
        <DirectMessagePanel
          onOpenProfile={vi.fn()}
          onDepthChange={onDepthChange}
        />
      );
      await act(async () => root.render(panel()));
      await flush();
      await openFirstConversation();
      const textarea = node.querySelector(
        'textarea[aria-label="私信内容"]',
      ) as HTMLTextAreaElement;
      const setter = Object.getOwnPropertyDescriptor(
        HTMLTextAreaElement.prototype,
        "value",
      )!.set!;
      await act(async () => {
        setter.call(textarea, "切回应用前写下的草稿");
        textarea.dispatchEvent(new Event("input", { bubbles: true }));
      });
      // Window focus or a reconnect revalidates the same account.
      author[flag] = true;
      await act(async () => root.render(panel()));
      await flush();
      author[flag] = false;
      await act(async () => root.render(panel()));
      await flush();
      expect(
        node.querySelector('[data-dm-view="conversation"]'),
      ).not.toBeNull();
      expect(
        (
          node.querySelector(
            'textarea[aria-label="私信内容"]',
          ) as HTMLTextAreaElement
        ).value,
      ).toBe("切回应用前写下的草稿");
      expect(onDepthChange).not.toHaveBeenLastCalledWith(0);
    },
  );

  it("still shows the account states while no account is confirmed", async () => {
    author.viewer = null;
    author.checking = true;
    await act(async () =>
      root.render(<DirectMessagePanel onOpenProfile={vi.fn()} />),
    );
    expect(node.textContent).toContain("正在加载账户");
    author.checking = false;
    author.sessionError = true;
    await act(async () =>
      root.render(<DirectMessagePanel onOpenProfile={vi.fn()} />),
    );
    expect(node.textContent).toContain("账户暂时不可用");
    author.sessionError = false;
  });
});

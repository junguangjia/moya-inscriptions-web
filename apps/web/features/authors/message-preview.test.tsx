// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { author, shell } = vi.hoisted(() => ({
  author: {
    viewer: null as { id: string } | null,
    checking: false,
    sessionError: false,
    signInHref: "/dev/community",
  },
  shell: {
    activeDestination: "home" as "home" | "discussion" | "user",
    activeTopicId: null as string | null,
    navigatePrimary: vi.fn(),
    openContent: vi.fn(),
    openTopic: vi.fn(),
  },
}));
vi.mock("./author-context", () => ({ useAuthors: () => author }));
vi.mock("../product-shell/product-shell", () => ({
  useProductShell: () => shell,
}));
vi.mock("./author-profile", () => ({
  MyComments: () => <p>Existing account comments</p>,
}));
vi.mock("./preview-author-profile", () => ({
  PreviewAuthorProfile: ({
    name,
    followed = false,
    onFollowChange,
    onClose,
  }: {
    name: string;
    followed?: boolean;
    onFollowChange?: (enabled: boolean) => void;
    onClose: () => void;
  }) => (
    <section aria-label={`${name}的主页`} data-preview-profile-bridge="">
      <button type="button" aria-label="关闭示例主页" onClick={onClose}>
        返回消息
      </button>
      <button
        type="button"
        aria-label="切换示例主页关注"
        aria-pressed={followed}
        onClick={() => onFollowChange?.(!followed)}
      >
        {followed ? "取消关注" : "关注"}
      </button>
    </section>
  ),
}));
import { MessageTrigger } from "./message-center";
import { MessagePreview } from "./message-preview";
import { DiscussionPreviewProvider } from "../discussion-preview/preview-context";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
let node: HTMLDivElement;
let frames: FrameRequestCallback[];
const baseHistory = { screen: "home" };
const button = (text: string) => {
  const found = [...node.querySelectorAll<HTMLButtonElement>("button")].find(
    (item) =>
      item.textContent === text || item.getAttribute("aria-label") === text,
  );
  if (!found) throw new Error(`Missing button: ${text}`);
  return found;
};
const click = (text: string) => act(async () => button(text).click());
const render = () =>
  act(async () => root.render(<MessageTrigger developmentPreview />));
const flushFrames = () =>
  act(async () => frames.splice(0).forEach((fn) => fn(0)));
const pointer = (
  element: Element,
  type: string,
  x: number,
  y: number,
  pointerId = 1,
  isPrimary = true,
) => {
  const event = new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    clientX: x,
    clientY: y,
    button: 0,
  });
  Object.defineProperty(event, "isPrimary", { value: isPrimary });
  Object.defineProperty(event, "pointerId", { value: pointerId });
  element.dispatchEvent(event);
  return event;
};
const press = (element: Element, key: string) =>
  act(async () => {
    element.dispatchEvent(
      new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }),
    );
  });
const activate = (element: HTMLButtonElement) =>
  act(async () => element.click());
const conversationRow = (name = "秋山") => {
  const conversation = [
    ...node.querySelectorAll<HTMLButtonElement>("button"),
  ].find((item) =>
    item.getAttribute("aria-label")?.startsWith(`与${name}的私信`),
  );
  if (!conversation) throw new Error(`Missing conversation: ${name}`);
  const front = conversation.parentElement!;
  const row = front.closest("li")!;
  const actions = row.querySelector<HTMLElement>('[role="group"]')!;
  const action = (label: string) => {
    const result = actions.querySelector<HTMLButtonElement>(
      `button[aria-label="${label}"]`,
    );
    if (!result) throw new Error(`Missing action ${label} for ${name}`);
    return result;
  };
  const offset = () => row.style.getPropertyValue("--conversation-offset");
  return { conversation, front, row, actions, action, offset };
};
const captureTracker = (front: HTMLElement) => {
  const captured = new Set<number>();
  const capture = vi.fn((id: number) => {
    captured.add(id);
  });
  const release = vi.fn((id: number) => {
    captured.delete(id);
  });
  Object.defineProperties(front, {
    setPointerCapture: { configurable: true, value: capture },
    hasPointerCapture: {
      configurable: true,
      value: (id: number) => captured.has(id),
    },
    releasePointerCapture: { configurable: true, value: release },
  });
  return { capture, release };
};
const swipe = (front: Element, distance: number) =>
  act(async () => {
    pointer(front, "pointerdown", 270, 30);
    pointer(front, "pointermove", 270 - distance, 35);
    pointer(front, "pointerup", 270 - distance, 35);
  });

beforeEach(() => {
  vi.stubEnv("NODE_ENV", "development");
  author.viewer = null;
  shell.navigatePrimary.mockClear();
  shell.openContent.mockClear();
  shell.openTopic.mockClear();
  shell.activeTopicId = null;
  shell.activeDestination = "home";
  frames = [];
  vi.stubGlobal("requestAnimationFrame", (fn: FrameRequestCallback) => {
    frames.push(fn);
    return frames.length;
  });
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
  vi.stubGlobal(
    "fetch",
    vi.fn(() => {
      throw new Error("Message preview must not fetch");
    }),
  );
  Object.defineProperty(HTMLDialogElement.prototype, "showModal", {
    configurable: true,
    value: function (this: HTMLDialogElement) {
      this.open = true;
    },
  });
  Object.defineProperty(HTMLDialogElement.prototype, "close", {
    configurable: true,
    value: function (this: HTMLDialogElement) {
      this.open = false;
    },
  });
  window.history.replaceState(baseHistory, "", "/#home");
  vi.spyOn(window.history, "back").mockImplementation(() => {
    const current = window.history.state;
    const depth = Number(current?.phase4DialogDepth ?? 0);
    const next =
      depth > 0 ? { ...current, phase4DialogDepth: depth - 1 } : baseHistory;
    window.history.replaceState(next, "", "/#home");
    window.dispatchEvent(new PopStateEvent("popstate", { state: next }));
  });
  node = document.createElement("div");
  document.body.append(node);
  root = createRoot(node);
});
afterEach(async () => {
  window.history.replaceState(baseHistory, "", "/#home");
  await act(async () => root.unmount());
  vi.useRealTimers();
  document.body.replaceChildren();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});
const open = async () => {
  await render();
  await click("打开消息");
};

describe("Frontend message preview", () => {
  it("is available to a development guest and clears each category badge only when opened", async () => {
    await open();
    expect(node.querySelector('dialog[aria-label="消息"]')).not.toBeNull();
    expect(node.querySelector('ul[aria-label="私信会话"]')).not.toBeNull();
    expect(button("粉丝，3 条未读")).toBeDefined();
    expect(button("赞与收藏，4 条未读")).toBeDefined();
    await click("粉丝，3 条未读");
    expect(node.querySelector("dialog")?.getAttribute("aria-label")).toBe(
      "粉丝",
    );
    await click("返回");
    expect(button("粉丝")).toBeDefined();
    expect(button("赞与收藏，4 条未读")).toBeDefined();
    expect(window.history.back).toHaveBeenCalledTimes(1);
  });

  it("opens a category at the top without focus scrolling and restores its source position", async () => {
    await open();
    const dialog = node.querySelector<HTMLElement>("[data-message-view]")!;
    const scrollTo = vi.fn((_x: number, y: number) => {
      dialog.scrollTop = y;
    });
    Object.defineProperty(dialog, "scrollTo", {
      configurable: true,
      value: scrollTo,
    });
    dialog.scrollTop = 320;
    await click("粉丝，3 条未读");
    await flushFrames();
    expect(scrollTo).toHaveBeenLastCalledWith(0, 0);
    expect(dialog.scrollTop).toBe(0);
    dialog.scrollTop = 700;
    await click("返回");
    await flushFrames();
    expect(dialog.scrollTop).toBe(320);
  });

  it("shows only actor/action in likes and saves and received/sent work context in comments", async () => {
    await open();
    await click("赞与收藏，4 条未读");
    expect(node.textContent).toContain("赞了你的作品");
    expect(node.textContent).toContain("收藏了你的作品");
    expect(node.textContent).not.toContain("推荐");
    await click("返回");
    await click("评论，3 条未读");
    expect(node.textContent).toContain("山间访碑记");
    expect(node.textContent).toContain("秋山");
    expect(node.textContent).toContain("石面上的岁月痕迹也很动人");
    await click("发出的评论");
    expect(node.textContent).toContain("观石的作品 · 石上春秋");
    expect(node.textContent).toContain("字口保存得很好");
    expect(node.textContent).not.toContain("山间访碑记");
    await act(async () =>
      button("发出的评论").dispatchEvent(
        new KeyboardEvent("keydown", { key: "Home", bubbles: true }),
      ),
    );
    expect(button("收到的评论").getAttribute("aria-selected")).toBe("true");
    expect(document.activeElement).toBe(button("收到的评论"));
    expect(fetch).not.toHaveBeenCalled();
  });

  it("opens received and sent activities at their exact source comment while deleted sources stay unavailable", async () => {
    const onOpenComment = vi.fn();
    await act(async () =>
      root.render(
        <MessagePreview onClose={vi.fn()} onOpenComment={onOpenComment} />,
      ),
    );
    await click("评论，3 条未读");
    const received = node.querySelector<HTMLButtonElement>(
      '[data-comment-origin="available"]',
    )!;
    await act(async () => received.click());
    expect(onOpenComment).toHaveBeenLastCalledWith(
      {
        topicId: "news-field-notes",
        contentId: "news-field-notes",
        commentId: "news-field-notes-comment-1",
        rootCommentId: "news-field-notes-comment-1",
      },
      "received",
    );
    const deletedPost = node.querySelector<HTMLElement>(
      '[data-unavailable-reason="content-deleted"]',
    )!;
    expect(deletedPost.textContent).toContain("内容不可见");
    expect(deletedPost.closest("button")).toBeNull();

    await click("发出的评论");
    const sent = node.querySelector<HTMLButtonElement>(
      '[data-comment-origin="available"]',
    )!;
    await act(async () => sent.click());
    expect(onOpenComment).toHaveBeenLastCalledWith(
      {
        topicId: "news-field-notes",
        contentId: "news-field-notes",
        commentId: "news-field-notes-comment-2",
        rootCommentId: "news-field-notes-comment-2",
      },
      "sent",
    );
    const deletedRoot = node.querySelector<HTMLElement>(
      '[data-unavailable-reason="root-comment-deleted"]',
    )!;
    expect(deletedRoot.textContent).toContain("内容不可见");
    expect(deletedRoot.closest("button")).toBeNull();
  });

  it("fully closes the message history before opening the original comment in discussion", async () => {
    await act(async () =>
      root.render(
        <DiscussionPreviewProvider enabled>
          <MessageTrigger developmentPreview />
        </DiscussionPreviewProvider>,
      ),
    );
    await click("打开消息");
    await click("评论，3 条未读");
    vi.spyOn(window.history, "go").mockImplementation(() => {
      window.history.replaceState(baseHistory, "", "/#home");
      window.dispatchEvent(
        new PopStateEvent("popstate", { state: baseHistory }),
      );
    });
    const target = node.querySelector<HTMLButtonElement>(
      '[data-comment-origin="available"]',
    )!;
    await act(async () => target.click());
    expect(node.querySelector('dialog[aria-label="消息"]')).toBeNull();
    expect(shell.navigatePrimary).not.toHaveBeenCalled();
    await flushFrames();
    expect(shell.navigatePrimary).toHaveBeenCalledWith("discussion");
    expect(shell.openTopic).toHaveBeenCalledWith(
      "news-field-notes",
      expect.any(HTMLButtonElement),
      0,
    );
    expect(shell.navigatePrimary.mock.invocationCallOrder[0]).toBeLessThan(
      shell.openTopic.mock.invocationCallOrder[0]!,
    );

    shell.activeTopicId = "news-field-notes";
    await act(async () =>
      root.render(
        <DiscussionPreviewProvider enabled>
          <MessageTrigger developmentPreview />
        </DiscussionPreviewProvider>,
      ),
    );
    shell.activeTopicId = null;
    await act(async () =>
      root.render(
        <DiscussionPreviewProvider enabled>
          <MessageTrigger developmentPreview />
        </DiscussionPreviewProvider>,
      ),
    );
    expect(node.querySelector('dialog[aria-label="评论"]')).not.toBeNull();
    expect(button("收到的评论").getAttribute("aria-selected")).toBe("true");
    expect(shell.navigatePrimary).toHaveBeenLastCalledWith("home");
    expect(shell.navigatePrimary).toHaveBeenCalledTimes(2);
  });

  it("synchronizes follow-back changes through the profile bridge without real requests", async () => {
    await open();
    await click("粉丝，3 条未读");
    await click("回关秋山");
    expect(button("取消回关秋山").textContent).toBe("互相关注");
    await click("查看秋山的主页");
    expect(
      node.querySelector(
        '[data-preview-profile-bridge][aria-label="秋山的主页"]',
      ),
    ).not.toBeNull();
    expect(button("切换示例主页关注").getAttribute("aria-pressed")).toBe(
      "true",
    );
    await click("切换示例主页关注");
    expect(button("切换示例主页关注").getAttribute("aria-pressed")).toBe(
      "false",
    );
    await click("关闭示例主页");
    expect(node.querySelector("[data-preview-profile-bridge]")).toBeNull();
    expect(button("回关秋山").getAttribute("aria-pressed")).toBe("false");
    expect(node.querySelector('dialog[aria-label="粉丝"]')).not.toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("opens the profile bridge from the avatar and the conversation from its text", async () => {
    await open();
    await click("查看秋山的主页");
    expect(
      node.querySelector(
        '[data-preview-profile-bridge][aria-label="秋山的主页"]',
      ),
    ).not.toBeNull();
    expect(node.querySelector("textarea")).toBeNull();
    await click("关闭示例主页");
    expect(button("与秋山的私信，2 条未读")).toBeDefined();
    await click("与秋山的私信，2 条未读");
    expect(node.querySelector('dialog[aria-label="秋山"]')).not.toBeNull();
    expect(button("发送")).toBeDefined();
    expect(node.querySelector("[data-preview-profile-bridge]")).toBeNull();
    await click("返回");
    expect(button("与秋山的私信")).toBeDefined();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("offers only icon mute and delete actions and keeps deletion undo in the original position", async () => {
    await open();
    const row = conversationRow();
    const order = () =>
      [
        ...node.querySelectorAll<HTMLButtonElement>(
          'ul[aria-label="私信会话"] button[aria-label^="与"]',
        ),
      ].map((item) => item.getAttribute("aria-label"));
    expect(row.actions.querySelectorAll("button")).toHaveLength(2);
    expect(row.actions.textContent).toBe("");
    expect(row.action("删除").querySelector("svg")).not.toBeNull();
    expect(row.action("免打扰").querySelector("svg")).not.toBeNull();
    expect(row.action("免打扰").disabled).toBe(true);
    expect(
      node.querySelector('button[aria-label="秋山的会话操作"]'),
    ).toBeNull();
    expect(node.textContent).not.toContain("不显示");

    await press(row.conversation, "ArrowLeft");
    await activate(row.action("免打扰"));
    expect(row.offset()).toBe("0px");
    expect(node.textContent).toContain("已开启免打扰");
    expect(row.conversation.getAttribute("aria-label")).toBe(
      "与秋山的私信，2 条未读，已免打扰",
    );
    expect(
      row.row.querySelector('[role="img"][aria-label="已免打扰"] svg'),
    ).not.toBeNull();
    expect(row.row.textContent).not.toContain("静音");
    await press(row.conversation, "ArrowLeft");
    await activate(row.action("取消免打扰"));
    expect(node.textContent).toContain("已取消免打扰");
    expect(
      row.row.querySelector('[role="img"][aria-label="已免打扰"]'),
    ).toBeNull();

    const before = order();
    await press(row.conversation, "ArrowLeft");
    await activate(row.action("删除"));
    expect(
      node.querySelector('[aria-label="与秋山的私信，2 条未读"]'),
    ).toBeNull();
    expect(node.textContent).toContain("已删除会话");
    await click("撤销");
    expect(order()).toEqual(before);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("tracks the finger before release and reveals trash before mute across two resting positions", async () => {
    await open();
    const row = conversationRow();
    const capture = captureTracker(row.front);
    await act(async () => {
      pointer(row.front, "pointerdown", 270, 30);
      pointer(row.front, "pointermove", 240, 32);
    });
    expect(row.offset()).toBe("30px");
    expect(row.row.getAttribute("data-dragging")).toBe("true");
    expect(capture.capture).toHaveBeenCalledWith(1);
    expect(
      Number(row.row.style.getPropertyValue("--trash-opacity")),
    ).toBeGreaterThan(0);
    expect(
      Number(row.row.style.getPropertyValue("--trash-opacity")),
    ).toBeLessThan(1);
    expect(row.row.style.getPropertyValue("--mute-opacity")).toBe("0");
    expect(row.action("删除").disabled).toBe(true);
    expect(row.action("免打扰").tabIndex).toBe(-1);
    await act(async () => pointer(row.front, "pointermove", 210, 33));
    expect(row.offset()).toBe("60px");
    expect(row.row.style.getPropertyValue("--trash-opacity")).toBe("1");
    expect(row.row.style.getPropertyValue("--mute-opacity")).toBe("0");
    await act(async () => pointer(row.front, "pointerup", 210, 33));
    expect(row.offset()).toBe("72px");
    expect(row.row.getAttribute("data-dragging")).toBe("false");
    expect(capture.release).toHaveBeenCalledWith(1);
    expect(row.action("删除").disabled).toBe(false);
    expect(row.action("删除").tabIndex).toBe(0);
    expect(row.action("免打扰").disabled).toBe(true);

    await act(async () => {
      pointer(row.front, "pointerdown", 270, 30);
      pointer(row.front, "pointermove", 246, 32);
    });
    expect(row.offset()).toBe("96px");
    expect(
      Number(row.row.style.getPropertyValue("--mute-opacity")),
    ).toBeGreaterThan(0);
    expect(
      Number(row.row.style.getPropertyValue("--mute-opacity")),
    ).toBeLessThan(1);
    expect(row.action("免打扰").disabled).toBe(true);
    await act(async () => pointer(row.front, "pointerup", 220, 32));
    expect(row.offset()).toBe("136px");
    expect(row.action("免打扰").disabled).toBe(false);
    expect(row.action("免打扰").tabIndex).toBe(0);
    expect(row.row.style.getPropertyValue("--mute-opacity")).toBe("1");
    await press(row.conversation, "ArrowRight");
    await swipe(row.front, 400);
    expect(row.offset()).toBe("136px");
    expect(button("与秋山的私信，2 条未读")).toBeDefined();
    expect(node.textContent).not.toContain("已删除会话");
  });

  it("dismisses the deletion notice and undo after four seconds without restoring the conversation", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    await open();
    const row = conversationRow();
    await press(row.conversation, "ArrowLeft");
    await activate(row.action("删除"));
    await act(async () => vi.advanceTimersByTime(3999));
    expect(node.querySelector('[role="status"]')?.textContent).toContain(
      "已删除会话",
    );
    expect(button("撤销")).toBeDefined();
    await act(async () => vi.advanceTimersByTime(1));
    expect(node.querySelector('[role="status"]')).toBeNull();
    expect(node.querySelector('button[aria-label^="与秋山的私信"]')).toBeNull();
  });

  it("gives a replacement deletion and its undo confirmation their own full notice duration", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    await open();
    const first = conversationRow();
    await press(first.conversation, "ArrowLeft");
    await activate(first.action("删除"));
    await act(async () => vi.advanceTimersByTime(3000));
    const second = conversationRow("观石");
    await press(second.conversation, "ArrowLeft");
    await activate(second.action("删除"));
    await act(async () => vi.advanceTimersByTime(3999));
    await click("撤销");
    expect(conversationRow("观石")).toBeDefined();
    expect(node.querySelector('button[aria-label^="与秋山的私信"]')).toBeNull();
    await act(async () => vi.advanceTimersByTime(3999));
    expect(node.querySelector('[role="status"]')?.textContent).toBe(
      "已恢复会话",
    );
    await act(async () => vi.advanceTimersByTime(1));
    expect(node.querySelector('[role="status"]')).toBeNull();
  });

  it("restarts the notice duration when consecutive mute actions show the same text", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    await open();
    const first = conversationRow();
    await press(first.conversation, "ArrowLeft");
    await activate(first.action("免打扰"));
    await act(async () => vi.advanceTimersByTime(3900));
    const second = conversationRow("观石");
    await press(second.conversation, "ArrowLeft");
    await activate(second.action("免打扰"));
    await act(async () => vi.advanceTimersByTime(3999));
    expect(node.querySelector('[role="status"]')?.textContent).toBe(
      "已开启免打扰",
    );
    await act(async () => vi.advanceTimersByTime(1));
    expect(node.querySelector('[role="status"]')).toBeNull();
  });

  it.each(["conversation", "avatar"])(
    "keeps dragging when implicit touch capture transfers from the nested %s button",
    async (target) => {
      await open();
      const row = conversationRow();
      const child =
        target === "avatar"
          ? row.front.querySelector<HTMLButtonElement>(
              'button[aria-label="查看秋山的主页"]',
            )!
          : row.conversation;
      const tracker = captureTracker(row.front);
      await act(async () => {
        pointer(child, "pointerdown", 270, 30);
        pointer(child, "gotpointercapture", 270, 30);
        pointer(child, "pointermove", 230, 32);
      });
      expect(row.offset()).toBe("40px");
      expect(tracker.capture).toHaveBeenCalledWith(1);
      await act(async () => {
        pointer(child, "lostpointercapture", 230, 32);
        pointer(row.front, "gotpointercapture", 230, 32);
        pointer(row.front, "pointermove", 150, 34);
      });
      expect(row.offset()).toBe("120px");
      expect(row.row.getAttribute("data-dragging")).toBe("true");
      await act(async () => pointer(row.front, "pointerup", 150, 34));
      expect(row.offset()).toBe("136px");
      expect(row.action("免打扰").disabled).toBe(false);
      expect(node.querySelector('dialog[aria-label="消息"]')).not.toBeNull();
      expect(node.querySelector("[data-preview-profile-bridge]")).toBeNull();
    },
  );

  it.each(["pointercancel", "lostpointercapture"])(
    "returns to the prior resting position after %s and ignores the stale release",
    async (cancelEvent) => {
      await open();
      const row = conversationRow();
      const capture = captureTracker(row.front);
      await act(async () => {
        pointer(row.front, "pointerdown", 270, 30);
        pointer(row.front, "pointermove", 170, 33);
      });
      expect(row.offset()).toBe("100px");
      await act(async () => {
        pointer(row.front, cancelEvent, 170, 33);
        pointer(row.front, "pointerup", 130, 33);
      });
      expect(row.offset()).toBe("0px");
      expect(row.action("删除").disabled).toBe(true);
      expect(capture.release).toHaveBeenCalledWith(1);
      await swipe(row.front, 60);
      expect(row.offset()).toBe("72px");
      await act(async () => {
        pointer(row.front, "pointerdown", 270, 30);
        pointer(row.front, "pointermove", 228, 33);
      });
      expect(row.offset()).toBe("114px");
      await act(async () => pointer(row.front, cancelEvent, 228, 33));
      expect(row.offset()).toBe("72px");
      expect(row.action("删除").disabled).toBe(false);
      expect(row.action("免打扰").disabled).toBe(true);
      expect(row.row.getAttribute("data-dragging")).toBe("false");
    },
  );

  it("ignores another pointer's move, cancellation, and release without losing the active gesture", async () => {
    await open();
    const row = conversationRow();
    const capture = captureTracker(row.front);
    await act(async () => {
      pointer(row.front, "pointerdown", 270, 30, 7);
      pointer(row.front, "pointerdown", 180, 32, 8, false);
      pointer(row.front, "pointermove", 140, 32, 8, false);
      pointer(row.front, "pointercancel", 140, 32, 8, false);
      pointer(row.front, "pointerup", 140, 32, 8, false);
    });
    expect(row.offset()).toBe("0px");
    expect(capture.capture).not.toHaveBeenCalled();
    await act(async () => pointer(row.front, "pointermove", 222, 32, 7));
    expect(row.offset()).toBe("48px");
    expect(capture.capture).toHaveBeenCalledWith(7);
    await act(async () => pointer(row.front, "pointerup", 222, 32, 7));
    expect(row.offset()).toBe("72px");
    expect(capture.release).toHaveBeenCalledWith(7);
  });

  it("leaves vertical gestures to native scrolling without capture or a later horizontal takeover", async () => {
    await open();
    const row = conversationRow();
    const capture = captureTracker(row.front);
    let scrollEvent: MouseEvent | undefined;
    await act(async () => {
      pointer(row.front, "pointerdown", 270, 30);
      scrollEvent = pointer(row.front, "pointermove", 266, 60);
      pointer(row.front, "pointermove", 170, 70);
      pointer(row.front, "pointerup", 140, 70);
    });
    expect(scrollEvent?.defaultPrevented).toBe(false);
    expect(capture.capture).not.toHaveBeenCalled();
    expect(row.offset()).toBe("0px");
    expect(row.action("删除").disabled).toBe(true);
    expect(node.querySelector('dialog[aria-label="消息"]')).not.toBeNull();
  });

  it.each([
    ["same row", 60],
    ["another row", 0],
    ["exposed action", 60],
  ] as const)(
    "closes revealed actions as a vertical gesture begins on %s",
    async (target, y) => {
      await open();
      const row = conversationRow();
      await swipe(row.front, 60);
      const origin =
        target === "same row"
          ? row.front
          : target === "another row"
            ? conversationRow("观石").front
            : row.action("删除");
      let move: MouseEvent | undefined;
      await act(async () => {
        pointer(origin, "pointerdown", 270, 30);
        pointer(origin, "pointermove", 269, 34);
      });
      expect(row.offset()).toBe("72px");
      await act(async () => {
        move = pointer(origin, "pointermove", 267, y);
      });
      expect(move?.defaultPrevented).toBe(false);
      expect(row.offset()).toBe("0px");
      expect(row.action("删除").disabled).toBe(true);
      await act(async () => {
        pointer(origin, "pointercancel", 267, y);
        pointer(origin, "pointerup", 150, y);
      });
      expect(row.offset()).toBe("0px");
      expect(node.querySelector('dialog[aria-label="消息"]')).not.toBeNull();
    },
  );

  it("closes resting and actively dragged actions when the message list scrolls", async () => {
    await open();
    const row = conversationRow();
    const tracker = captureTracker(row.front);
    const scroller = node.querySelector<HTMLElement>("[data-message-view]")!;
    await swipe(row.front, 60);
    await act(async () => scroller.dispatchEvent(new Event("scroll")));
    expect(row.offset()).toBe("0px");
    await act(async () => {
      pointer(row.front, "pointerdown", 270, 30);
      pointer(row.front, "pointermove", 160, 32);
    });
    expect(row.offset()).toBe("110px");
    tracker.release.mockClear();
    await act(async () => scroller.dispatchEvent(new Event("scroll")));
    expect(row.offset()).toBe("0px");
    expect(row.row.getAttribute("data-dragging")).toBe("false");
    expect(tracker.release).toHaveBeenCalledWith(1);
    await act(async () => pointer(row.front, "pointerup", 130, 32));
    expect(row.offset()).toBe("0px");
    expect(row.action("删除").disabled).toBe(true);
  });

  it.each([20, 60])(
    "suppresses the pointer click after a %ipx drag while retaining keyboard activation",
    async (distance) => {
      await open();
      const row = conversationRow();
      await swipe(row.front, distance);
      const restingOffset = row.offset();
      await act(async () =>
        row.conversation.dispatchEvent(
          new MouseEvent("click", {
            bubbles: true,
            cancelable: true,
            detail: 1,
          }),
        ),
      );
      expect(row.offset()).toBe(restingOffset);
      expect(node.querySelector('dialog[aria-label="消息"]')).not.toBeNull();
      await press(row.conversation, "ArrowRight");
      await activate(row.conversation);
      expect(node.querySelector('dialog[aria-label="秋山"]')).not.toBeNull();
    },
  );

  it("reveals actions by keyboard, moves focus, and closes them without dismissing the dialog", async () => {
    await open();
    const row = conversationRow();
    row.conversation.focus();
    await press(row.conversation, "ArrowLeft");
    await flushFrames();
    expect(row.offset()).toBe("136px");
    expect(document.activeElement).toBe(row.action("免打扰"));
    expect(row.actions.getAttribute("aria-hidden")).toBe("false");
    await press(row.action("免打扰"), "ArrowRight");
    expect(row.offset()).toBe("0px");
    expect(document.activeElement).toBe(row.conversation);
    expect(row.action("删除").disabled).toBe(true);
    await press(row.conversation, "ArrowLeft");
    await flushFrames();
    const escape = new KeyboardEvent("keydown", {
      key: "Escape",
      bubbles: true,
      cancelable: true,
    });
    await act(async () => row.action("删除").dispatchEvent(escape));
    expect(escape.defaultPrevented).toBe(true);
    expect(row.offset()).toBe("0px");
    expect(document.activeElement).toBe(row.conversation);
    expect(node.querySelector('dialog[aria-label="消息"]')).not.toBeNull();
    expect(window.history.back).not.toHaveBeenCalled();
  });

  it("closes the previous row when a different row takes horizontal ownership", async () => {
    await open();
    const first = conversationRow();
    const second = conversationRow("观石");
    await swipe(first.front, 60);
    expect(first.offset()).toBe("72px");
    await act(async () => {
      pointer(second.front, "pointerdown", 270, 30);
      pointer(second.front, "pointermove", 220, 32);
    });
    expect(first.offset()).toBe("0px");
    expect(second.offset()).toBe("50px");
    expect(first.action("删除").disabled).toBe(true);
    await act(async () => pointer(second.front, "pointerup", 150, 32));
    expect(second.offset()).toBe("136px");
  });

  it("keeps icon category names accessible without showing the Chinese captions", async () => {
    await open();
    for (const [name, label] of [
      ["粉丝", "粉丝，3 条未读"],
      ["赞与收藏", "赞与收藏，4 条未读"],
      ["评论", "评论，3 条未读"],
    ]) {
      expect(button(label!).textContent).not.toContain(name);
      expect(button(label!).querySelector("svg, .yoyi-icon")).not.toBeNull();
    }
    await click("粉丝，3 条未读");
    const follow = button("回关秋山");
    const appearance = follow.className;
    await click("回关秋山");
    expect(button("取消回关秋山")).toBe(follow);
    expect(follow.className).toBe(appearance);
    expect(follow.textContent).toBe("互相关注");
  });

  it("places profile access in the chat title and preserves the composer while viewing that profile", async () => {
    await open();
    await click("与秋山的私信，2 条未读");
    const titleProfile = button("查看秋山的主页");
    expect(titleProfile.closest("header h2")).not.toBeNull();
    expect(node.textContent).not.toContain("查看 秋山 的主页");
    const chat = node.querySelector("[data-message-chat]")!;
    const stream = chat.querySelector<HTMLElement>("[data-message-stream]")!;
    const composer = chat.querySelector<HTMLFormElement>(
      "[data-message-composer]",
    )!;
    expect(stream.nextElementSibling).toBe(composer);
    expect(composer.parentElement).toBe(chat);
    const input = composer.querySelector<HTMLTextAreaElement>("textarea")!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(
        HTMLTextAreaElement.prototype,
        "value",
      )!.set!.call(input, "尚未发送的消息");
      input.dispatchEvent(new Event("input", { bubbles: true }));
      stream.scrollTop = 120;
      titleProfile.focus();
    });
    await activate(titleProfile);
    expect(
      node.querySelector(
        '[data-preview-profile-bridge][aria-label="秋山的主页"]',
      ),
    ).not.toBeNull();
    await click("关闭示例主页");
    await flushFrames();
    expect(document.activeElement).toBe(titleProfile);
    expect(node.querySelector("[data-message-composer]")).toBe(composer);
    expect(composer.querySelector("textarea")).toBe(input);
    expect(input.value).toBe("尚未发送的消息");
    expect(stream.scrollTop).toBe(120);
    expect(node.querySelector('[role="log"]')?.textContent).toBe("");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("locally sends text, updates preview/unread state and never writes storage or fetches", async () => {
    const storage = vi.spyOn(Storage.prototype, "setItem");
    await open();
    await click("与秋山的私信，2 条未读");
    expect(button("发送").disabled).toBe(true);
    const input = node.querySelector<HTMLTextAreaElement>("textarea")!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(
        HTMLTextAreaElement.prototype,
        "value",
      )!.set!.call(input, "下次一起去 <script>");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await click("发送");
    expect(node.querySelector('[role="log"]')?.textContent).toBe(
      "下次一起去 <script>",
    );
    expect(node.querySelector("script")).toBeNull();
    expect(input.value).toBe("");
    await click("返回");
    expect(button("与秋山的私信").textContent).toContain("下次一起去 <script>");
    expect(fetch).not.toHaveBeenCalled();
    expect(storage).not.toHaveBeenCalled();
  });

  it("walks back through profile and message subpage before closing the modal", async () => {
    const push = vi.spyOn(window.history, "pushState");
    await open();
    const marker = window.history.state.phase4Dialog;
    expect(window.history.state.phase4DialogDepth).toBe(0);
    await click("粉丝，3 条未读");
    expect(window.history.state.phase4DialogDepth).toBe(1);
    await click("查看秋山的主页");
    expect(window.history.state.phase4DialogDepth).toBe(2);
    expect(window.history.state.phase4Dialog).toBe(marker);
    expect(push).toHaveBeenCalledTimes(3);
    await act(async () => window.history.back());
    expect(node.querySelector("[data-preview-profile-bridge]")).toBeNull();
    expect(node.querySelector('dialog[aria-label="粉丝"]')).not.toBeNull();
    expect(window.history.state.phase4DialogDepth).toBe(1);
    await act(async () => window.history.back());
    expect(node.querySelector('dialog[aria-label="消息"]')).not.toBeNull();
    expect(window.history.state.phase4DialogDepth).toBe(0);
    expect(button("粉丝")).toBeDefined();
    await act(async () => window.history.back());
    expect(node.querySelector("dialog")).toBeNull();
    await click("打开消息");
    expect(button("粉丝，3 条未读")).toBeDefined();
  });

  it("returns directly to message home when browser history skips a profile and its parent", async () => {
    await open();
    await click("粉丝，3 条未读");
    await click("查看秋山的主页");
    await act(async () => {
      const next = { ...window.history.state, phase4DialogDepth: 0 };
      window.history.replaceState(next, "", "/#home");
      window.dispatchEvent(new PopStateEvent("popstate", { state: next }));
    });
    expect(node.querySelector("[data-preview-profile-bridge]")).toBeNull();
    expect(node.querySelector('dialog[aria-label="消息"]')).not.toBeNull();
    expect(window.history.state.phase4DialogDepth).toBe(0);
  });

  it("discards the preview on account switch", async () => {
    await open();
    await click("粉丝，3 条未读");
    await click("回关秋山");
    author.viewer = { id: "user-" + "1".repeat(32) };
    await render();
    expect(node.querySelector("dialog")).toBeNull();
    await click("打开消息");
    await click("粉丝，3 条未读");
    expect(button("回关秋山").getAttribute("aria-pressed")).toBe("false");
  });

  it("never composes synthetic messages in production", async () => {
    await act(async () => root.render(<MessageTrigger />));
    await click("打开消息");
    expect(node.textContent).not.toContain("示例消息");
    expect(node.textContent).not.toContain("秋山");
    // content-community-completion-v1: the 私信 tab is the real direct-message
    // panel; a guest sees the truthful sign-in state and no request is made.
    expect(node.textContent).toContain("登录后查看私信");
    expect(fetch).not.toHaveBeenCalled();
  });
});

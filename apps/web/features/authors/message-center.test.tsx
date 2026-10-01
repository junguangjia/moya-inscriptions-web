// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ContentIdentity } from "@moya/contracts";

const { author, openContent, shellCalls, commentTarget } = vi.hoisted(() => ({
  shellCalls: [] as string[],
  commentTarget: {
    value: { type: "work", id: `work-${"3".repeat(32)}` } as {
      type: string;
      id: string;
    },
  },
  author: {
    viewer: { id: `user-${"1".repeat(32)}` } as { id: string } | null,
    checking: false,
    sessionError: false,
    signInHref: "/dev/community",
  },
  openContent: vi.fn(),
}));
vi.mock("./author-context", () => ({ useAuthors: () => author }));
vi.mock("../product-shell/product-shell", () => ({
  useProductShell: () => ({
    openContent,
    navigatePrimary: (destination: string) =>
      shellCalls.push(`navigatePrimary:${destination}`),
    openTopic: (id: string) => shellCalls.push(`openTopic:${id}`),
  }),
}));
vi.mock("./author-profile", () => ({
  MyComments: ({
    entryId,
    onOpenContent,
  }: {
    entryId: string;
    onOpenContent: (target: ContentIdentity, opener: HTMLElement) => void;
  }) => (
    <button
      data-comments-entry={entryId}
      onClick={(event) =>
        onOpenContent(
          commentTarget.value as ContentIdentity,
          event.currentTarget,
        )
      }
    >
      前往评论位置
    </button>
  ),
}));
import { MessageTrigger } from "./message-center";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
const sourceHistory = { screen: "home" };
let root: Root | null = null;
let node: HTMLDivElement;
let frames: FrameRequestCallback[];

beforeEach(() => {
  vi.clearAllMocks();
  shellCalls.length = 0;
  commentTarget.value = { type: "work", id: `work-${"3".repeat(32)}` };
  author.viewer = { id: `user-${"1".repeat(32)}` };
  author.checking = false;
  author.sessionError = false;
  frames = [];
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    frames.push(callback);
    return frames.length;
  });
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
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
  window.history.replaceState(sourceHistory, "", "/#home");
  vi.spyOn(window.history, "back").mockImplementation(() => {});
  node = document.createElement("div");
  document.body.append(node);
  root = createRoot(node);
});
afterEach(async () => {
  window.history.replaceState(sourceHistory, "", "/#home");
  await act(async () => root?.unmount());
  root = null;
  document.body.replaceChildren();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
const render = (unreadCount = 0) =>
  act(async () => root!.render(<MessageTrigger unreadCount={unreadCount} />));
const button = (label: string) => {
  const result = [...node.querySelectorAll<HTMLButtonElement>("button")].find(
    (item) =>
      item.textContent === label || item.getAttribute("aria-label") === label,
  );
  if (!result) throw new Error(`Missing button: ${label}`);
  return result;
};
const click = (label: string) => act(async () => button(label).click());
const finishBack = () =>
  act(async () => {
    window.history.replaceState(sourceHistory, "", "/#home");
    window.dispatchEvent(
      new PopStateEvent("popstate", { state: sourceHistory }),
    );
  });
const flushFrames = () =>
  act(async () => {
    const pending = frames.splice(0);
    pending.forEach((callback) => callback(0));
  });

describe("Message center navigation and account boundaries", () => {
  it("shows the supplied unread count, caps at 99+ and removes zero without marking it read on open", async () => {
    for (const [count, badge] of [
      [1, "1"],
      [99, "99"],
      [100, "99+"],
      [1250, "99+"],
    ] as const) {
      await render(count);
      expect(
        node.querySelector("[data-message-unread-badge]")?.textContent,
      ).toBe(badge);
      expect(button(`打开消息，${badge} 条未读消息`)).toBeDefined();
    }
    await click("打开消息，99+ 条未读消息");
    expect(node.querySelector("[data-message-unread-badge]")?.textContent).toBe(
      "99+",
    );
    await render(0);
    expect(node.querySelector("[data-message-unread-badge]")).toBeNull();
    expect(button("打开消息")).toBeDefined();
  });

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])(
    "does not show an invalid unread count %s",
    async (count) => {
      await render(count);
      expect(node.querySelector("[data-message-unread-badge]")).toBeNull();
    },
  );

  it("hides supplied unread counts outside a confirmed account", async () => {
    await render(5);
    expect(node.querySelector("[data-message-unread-badge]")).not.toBeNull();
    author.checking = true;
    await render(5);
    expect(node.querySelector("[data-message-unread-badge]")).toBeNull();
    author.checking = false;
    author.viewer = null;
    await render(5);
    expect(node.querySelector("[data-message-unread-badge]")).toBeNull();
  });

  it("closes its native modal history entry before opening a comment target", async () => {
    await render();
    const trigger = button("打开消息");
    await click("打开消息");
    expect(node.querySelector("dialog")?.open).toBe(true);
    await click("我的评论");
    await click("前往评论位置");
    expect(window.history.back).toHaveBeenCalledOnce();
    expect(openContent).not.toHaveBeenCalled();
    expect(node.querySelector("dialog")?.open).toBe(true);
    await finishBack();
    expect(node.querySelector("dialog")).toBeNull();
    expect(openContent).not.toHaveBeenCalled();
    await flushFrames();
    expect(openContent).toHaveBeenCalledWith(
      { type: "work", id: `work-${"3".repeat(32)}` },
      trigger,
    );
  });

  it("opens an Article comment on the discussion destination after closing", async () => {
    const articleId = `article-${"5".repeat(32)}`;
    commentTarget.value = { type: "article", id: articleId };
    await render();
    await click("打开消息");
    await click("我的评论");
    await click("前往评论位置");
    expect(shellCalls).toEqual([]);
    await finishBack();
    expect(node.querySelector("dialog")).toBeNull();
    await flushFrames();
    expect(shellCalls).toEqual(["navigatePrimary:discussion"]);
    await flushFrames();
    expect(shellCalls).toEqual([
      "navigatePrimary:discussion",
      `openTopic:${articleId}`,
    ]);
    expect(openContent).not.toHaveBeenCalled();
  });

  it.each(["guest", "checking", "failed-session"] as const)(
    "does not mount authenticated comment content for a %s session",
    async (state) => {
      if (state === "guest") author.viewer = null;
      if (state === "checking") author.checking = true;
      if (state === "failed-session") author.sessionError = true;
      await render();
      await click("打开消息");
      await click("我的评论");
      expect(node.querySelector("[data-comments-entry]")).toBeNull();
      expect(openContent).not.toHaveBeenCalled();
    },
  );

  it("retires a pending comment target when the account changes during modal Back", async () => {
    await render();
    await click("打开消息");
    await click("我的评论");
    await click("前往评论位置");
    author.viewer = { id: `user-${"2".repeat(32)}` };
    await render();
    await finishBack();
    await flushFrames();
    expect(openContent).not.toHaveBeenCalled();
  });

  it("rechecks account ownership before the deferred target navigation", async () => {
    await render();
    await click("打开消息");
    await click("我的评论");
    await click("前往评论位置");
    await finishBack();
    author.viewer = null;
    await render();
    await flushFrames();
    expect(openContent).not.toHaveBeenCalled();
  });
});

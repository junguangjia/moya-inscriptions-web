// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/*
 * content-community-completion-v1 (C3 repair): while the 私信 panel shows a
 * conversation or start view, the scoped message center gives it the whole
 * dialog body and shows the participant in its header, as in the accepted
 * chat. The panel is replaced by a stand-in that reports depth and title
 * through the real props.
 */
const { author } = vi.hoisted(() => ({
  author: {
    viewer: { id: `user-${"1".repeat(32)}` } as { id: string } | null,
    checking: false,
    sessionError: false,
    signInHref: "/dev/community",
  },
}));
vi.mock("./author-context", () => ({ useAuthors: () => author }));
vi.mock("../product-shell/product-shell", () => ({
  useProductShell: () => ({ openContent: vi.fn(), openProfile: vi.fn() }),
}));
vi.mock("./author-profile", () => ({ MyComments: () => null }));
vi.mock("../messages", async () => {
  const { createElement, Fragment } = await import("react");
  return {
    useDirectMessageEntry: () => null,
    useUnreadConversationCount: () => 0,
    DirectMessagePanel: ({
      onDepthChange,
      onTitleChange,
    }: {
      onDepthChange?: (depth: number) => void;
      onTitleChange?: (
        title: { label: string; content: unknown } | null,
      ) => void;
    }) =>
      createElement(
        Fragment,
        null,
        createElement(
          "button",
          {
            type: "button",
            onClick: () => {
              onDepthChange?.(1);
              onTitleChange?.({
                label: "书法学徒",
                content: createElement(
                  "button",
                  { type: "button", "aria-label": "查看书法学徒的主页" },
                  "书法学徒",
                ),
              });
            },
          },
          "stand-in open",
        ),
        createElement(
          "button",
          {
            type: "button",
            onClick: () => {
              onDepthChange?.(0);
              onTitleChange?.(null);
            },
          },
          "stand-in list",
        ),
      ),
  };
});
import { MessageTrigger } from "./message-center";
import styles from "./message-center.module.css";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root | null = null;
let node: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal("requestAnimationFrame", () => 1);
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
  window.history.replaceState({ screen: "home" }, "", "/#home");
  node = document.createElement("div");
  document.body.append(node);
  root = createRoot(node);
});
afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  document.body.replaceChildren();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
const click = (label: string) =>
  act(async () => {
    const target = [
      ...document.querySelectorAll<HTMLButtonElement>("button"),
    ].find(
      (item) =>
        item.textContent === label || item.getAttribute("aria-label") === label,
    );
    if (!target) throw new Error(`Missing button: ${label}`);
    target.click();
  });

describe("Scoped message center with an open direct-message view", () => {
  it("gives the panel the dialog body and the participant the header, then restores the tabs", async () => {
    await act(async () => root!.render(<MessageTrigger />));
    await click("打开消息");
    const dialog = document.querySelector("dialog")!;
    const tabs = document.querySelector('[role="tablist"]') as HTMLElement;
    const heading = () => dialog.querySelector("header h2")!;
    expect(tabs.hidden).toBe(false);
    expect(dialog.className).not.toContain(styles.directOpen);
    expect(heading().textContent).toBe("消息");
    expect(
      document.querySelector('section[data-message-section="direct"]'),
    ).not.toBeNull();

    await click("stand-in open");
    expect(tabs.hidden).toBe(true);
    expect(dialog.className).toContain(styles.directOpen);
    expect(dialog.getAttribute("aria-label")).toBe("书法学徒");
    expect(
      heading().querySelector('button[aria-label="查看书法学徒的主页"]'),
    ).not.toBeNull();

    await click("stand-in list");
    expect(tabs.hidden).toBe(false);
    expect(dialog.className).not.toContain(styles.directOpen);
    expect(heading().textContent).toBe("消息");
  });
});

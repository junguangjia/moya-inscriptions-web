// @vitest-environment jsdom
import { act } from "react";
import type { ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

/*
 * parallel-community-integration-qa (e60b691): with live notifications the
 * message trigger renders N's live host, which must mount C's real 私信 panel
 * through the adapter, not the host's own "私信尚未在此环境接入" placeholder.
 */
const { author, inbox } = vi.hoisted(() => ({
  author: {
    viewer: { id: `user-${"1".repeat(32)}` },
    checking: false,
    sessionError: false,
    signInHref: "/login",
    cache: new Map<string, unknown>(),
    refresh: () => Promise.resolve(),
  },
  inbox: {
    page: null,
    loading: false,
    error: "",
    setFilter: () => {},
    refresh: () => {},
    read: () => Promise.resolve(),
    more: () => {},
  },
}));
vi.mock("./author-context", () => ({ useAuthors: () => author }));
vi.mock("../notifications/notification-context", () => ({
  useNotifications: () => inbox,
}));
vi.mock("../product-shell/product-shell", () => ({
  useProductShell: () => ({
    activeContent: null,
    activeProfile: null,
    activeTopicId: null,
    activeDestination: "home",
  }),
}));
vi.mock("./author-profile", () => ({ MyComments: () => null }));
vi.mock("./author-dialog", () => ({
  AuthorDialog: ({ children }: { children: ReactNode }) => (
    <div role="dialog">{children}</div>
  ),
}));
vi.mock("../messages", async () => {
  const { createElement } = await import("react");
  return {
    DirectMessagePanel: () =>
      createElement("div", { "data-real-dm-panel": "" }, "real panel"),
    useDirectMessageEntry: () => null,
    useUnreadConversationCount: () => 0,
  };
});
import { MessageTrigger } from "./message-center";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
let node: HTMLDivElement, root: ReturnType<typeof createRoot>;
beforeEach(() => {
  node = document.createElement("div");
  document.body.append(node);
  root = createRoot(node);
});
afterEach(async () => {
  await act(async () => root.unmount());
  node.remove();
});

it("mounts C's real 私信 panel in the live message host", async () => {
  await act(async () => root.render(<MessageTrigger liveNotifications />));
  const trigger = [...node.querySelectorAll("button")].find((b) =>
    b.getAttribute("aria-label")?.startsWith("打开消息"),
  )!;
  await act(async () => trigger.click());
  expect(node.querySelector("[data-message-live]")).not.toBeNull();
  expect(node.querySelector("[data-real-dm-panel]")).not.toBeNull();
  expect(node.textContent).not.toContain("私信尚未在此环境接入");
});

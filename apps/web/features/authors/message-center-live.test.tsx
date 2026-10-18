// @vitest-environment jsdom
import { act } from "react";
import type { ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/*
 * parallel-community-integration-qa (e60b691): with live notifications the
 * message trigger renders N's live host, which must mount C's real 私信 panel
 * through the adapter, not the host's own "私信尚未在此环境接入" placeholder.
 */
const { author, inbox, shell } = vi.hoisted(() => ({
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
    setFilter: vi.fn(),
    visit: () => () => {},
    revalidate: () => {},
    refresh: () => {},
    read: () => Promise.resolve(),
    more: () => {},
  },
  // Left undefined like the other partial shell mocks unless a case sets it.
  shell: { browseOnly: undefined as boolean | undefined },
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
vi.mock("../shell/browse-only-context", () => ({
  useBrowseOnly: () => shell.browseOnly === true,
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
  shell.browseOnly = undefined;
  inbox.setFilter.mockClear();
  window.history.replaceState({}, "", "/");
  node = document.createElement("div");
  document.body.append(node);
  root = createRoot(node);
});
afterEach(async () => {
  await act(async () => root.unmount());
  node.remove();
  window.history.replaceState({}, "", "/");
});
const triggers = () =>
  [...node.querySelectorAll("button")].filter((button) =>
    button.getAttribute("aria-label")?.startsWith("打开消息"),
  );

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

describe("wide-screen browse-only (pc-browse-only-v1)", () => {
  it.each([
    ["live", true],
    ["scoped", false],
  ] as const)(
    "keeps only an aria-hidden end-slot placeholder for the %s trigger",
    async (_, liveNotifications) => {
      shell.browseOnly = true;
      await act(async () =>
        root.render(<MessageTrigger liveNotifications={liveNotifications} />),
      );
      const placeholder = node.querySelector("[data-message-trigger-hidden]");
      expect(placeholder?.tagName).toBe("SPAN");
      expect(placeholder?.getAttribute("aria-hidden")).toBe("true");
      expect(node.children).toHaveLength(1);
      expect(node.querySelector("button")).toBeNull();
      expect(node.querySelector('[role="dialog"]')).toBeNull();
    },
  );
  it("never mounts the live ?notifications= entry", async () => {
    window.history.replaceState({}, "", "/?notifications=comments");
    shell.browseOnly = true;
    await act(async () => root.render(<MessageTrigger liveNotifications />));
    expect(node.querySelector('[role="dialog"]')).toBeNull();
    expect(inbox.setFilter).not.toHaveBeenCalled();
    // The shell, not the trigger, cleans the URL when browse-only is enforced.
    expect(
      new URLSearchParams(window.location.search).get("notifications"),
    ).toBe("comments");
  });
  it("mounts the trigger and its pending entry once browse-only lifts", async () => {
    // A wide-screen cookie holder: browse-only while /me is pending, then
    // signed in. The live host mounts then and still opens the entry.
    window.history.replaceState({}, "", "/?notifications=comments");
    shell.browseOnly = true;
    await act(async () => root.render(<MessageTrigger liveNotifications />));
    shell.browseOnly = false;
    await act(async () => root.render(<MessageTrigger liveNotifications />));
    expect(node.querySelector("[data-message-trigger-hidden]")).toBeNull();
    expect(triggers()).toHaveLength(1);
    expect(node.querySelector('[role="dialog"]')).not.toBeNull();
    expect(inbox.setFilter).toHaveBeenCalledExactlyOnceWith("comments");
  });
  it.each([
    [false, true],
    [false, false],
    [undefined, true],
    [undefined, false],
  ] as const)(
    "keeps the message trigger when browseOnly is %s (live: %s)",
    async (browseOnly, liveNotifications) => {
      shell.browseOnly = browseOnly;
      await act(async () =>
        root.render(<MessageTrigger liveNotifications={liveNotifications} />),
      );
      expect(node.querySelector("[data-message-trigger-hidden]")).toBeNull();
      expect(triggers()).toHaveLength(1);
    },
  );
  it("drops the trigger when a mounted header turns browse-only", async () => {
    shell.browseOnly = false;
    await act(async () => root.render(<MessageTrigger liveNotifications />));
    await act(async () => triggers()[0]!.click());
    expect(node.querySelector('[role="dialog"]')).not.toBeNull();
    shell.browseOnly = true;
    await act(async () => root.render(<MessageTrigger liveNotifications />));
    expect(triggers()).toHaveLength(0);
    expect(node.querySelector('[role="dialog"]')).toBeNull();
    expect(node.querySelector("[data-message-trigger-hidden]")).not.toBeNull();
  });
});

// @vitest-environment jsdom
/**
 * parallel-community-integration-qa (combined-head review B1): an Article
 * notification opens as a topic of the discussion destination. The live
 * message host lives in the destination the reader came from; when the
 * Article closes it must return there before reopening, because a modal
 * reopened inside a hidden destination blocks the page invisibly. Adapted
 * from the reviewer's reproduction: one host per destination header, the
 * inactive destination hidden as PrimaryShell does, and a shell that refuses
 * openTopic outside discussion as ProductShell does.
 */
import { act } from "react";
import type { ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const { inbox, author, client, shell } = vi.hoisted(() => {
  const shell = {
    activeDestination: "home" as "home" | "discussion" | "user",
    openToken: null as number | null,
    /** As ProductShell while a closing profile is still registered. */
    refuseNavigations: 0,
    activeContent: null,
    activeProfile: null,
    activeTopicId: null as string | null,
    calls: [] as string[],
    rerender: () => {},
    navigatePrimary(destination: "home" | "discussion" | "user") {
      if (shell.refuseNavigations > 0) {
        shell.refuseNavigations -= 1;
        return;
      }
      if (destination === shell.activeDestination) return;
      shell.calls.push(`navigatePrimary:${destination}`);
      shell.activeDestination = destination;
      shell.rerender();
    },
    openTopic(id: string) {
      shell.calls.push(`openTopic:${id}`);
      // The real openTopic refuses from any destination but discussion.
      if (shell.activeDestination !== "discussion") return;
      shell.activeTopicId = id;
      shell.rerender();
    },
    openContent() {},
    openProfile() {},
  };
  return {
    shell,
    inbox: {
      page: {
        observation: "synthetic-inbox-observation",
        unread: { total: 1, likes: 0, comments: 1, mentions: 0 },
        nextCursor: null,
        items: [
          {
            id: "notification-article",
            available: true,
            unread: true,
            target: { type: "article", id: "article-example" },
            commentId: "comment-example",
            actors: [{ id: "user-example", displayName: "读者" }],
            actorCount: 1,
            reason: "reply",
            text: "synthetic",
            createdAt: "2026-09-22T03:57:28.000Z",
            observation: "synthetic-item-observation",
          },
        ],
      },
      loading: false,
      error: "",
      setFilter: vi.fn(),
      refresh: vi.fn(),
      read: vi.fn(async () => undefined),
      more: vi.fn(),
    },
    author: {
      viewer: { id: "recipient-example" },
      checking: false,
      sessionError: false,
      cache: new Map(),
    },
    client: { locate: vi.fn(async () => ({})), card: vi.fn(async () => ({})) },
  };
});
vi.mock("./notification-context", () => ({ useNotifications: () => inbox }));
vi.mock("../authors/author-context", () => ({ useAuthors: () => author }));
vi.mock("../authors/author-data", () => ({ authorClient: client }));
vi.mock("../authors/author-profile", () => ({ MyComments: () => null }));
vi.mock("../authors/author-dialog", () => ({
  AuthorDialog: ({
    children,
    onClose,
    closeRequested,
    title,
  }: {
    children: ReactNode;
    onClose: () => void;
    closeRequested?: boolean;
    title: string;
  }) => {
    if (closeRequested) queueMicrotask(onClose);
    return (
      <div role="dialog" data-test-dialog="" aria-label={title}>
        {children}
      </div>
    );
  },
}));
vi.mock("../product-shell/product-shell", () => ({
  useProductShell: () => ({ ...shell }),
}));
import { LiveMessageTrigger } from "./live-message-center";
import type { DirectMessagePanelAdapter } from "./live-message-center";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const frames = async () => {
  for (let i = 0; i < 4; i++)
    await act(
      async () => new Promise<void>((r) => requestAnimationFrame(() => r())),
    );
};

let node: HTMLDivElement, root: ReturnType<typeof createRoot>;
// As C's panel adapter: a profile's 私信 action leaves an open request.
const adapter: DirectMessagePanelAdapter = {
  render: () => <p data-dm-panel="">DM panel</p>,
  useUnreadConversationCount: () => 0,
  useOpenRequest: () => shell.openToken,
};
// As PrimaryShell: hosts live in the home and discussion headers only; the
// user destination has none; the inactive destinations are hidden.
const Destination = ({
  name,
  children,
}: {
  name: "home" | "discussion" | "user";
  children?: ReactNode;
}) => (
  <section
    data-dest={name}
    data-primary-destination={name}
    data-active={shell.activeDestination === name ? "true" : "false"}
    hidden={shell.activeDestination !== name}
  >
    {children}
  </section>
);
const App = () => (
  <>
    <Destination name="home">
      <LiveMessageTrigger directMessages={adapter} />
    </Destination>
    <Destination name="discussion">
      <LiveMessageTrigger directMessages={adapter} />
    </Destination>
    <Destination name="user" />
  </>
);
beforeEach(async () => {
  shell.activeDestination = "home";
  shell.activeTopicId = null;
  shell.openToken = null;
  shell.refuseNavigations = 0;
  shell.calls.length = 0;
  node = document.createElement("div");
  document.body.append(node);
  root = createRoot(node);
  shell.rerender = () => root.render(<App />);
  await act(async () => root.render(<App />));
});
afterEach(async () => {
  await act(async () => root.unmount());
  node.remove();
});
const roundTrip = async (from: "home" | "discussion") => {
  const trigger = node.querySelector(
    `[data-dest="${from}"] button[aria-label^="打开消息"]`,
  ) as HTMLButtonElement;
  await act(async () => trigger.click());
  const comments = [
    ...node.querySelectorAll(`[data-dest="${from}"] button`),
  ].find((b) => b.getAttribute("aria-label")?.startsWith("评论"));
  await act(async () => (comments as HTMLButtonElement).click());
  const row = [
    ...node.querySelectorAll(
      '[data-notification-id="notification-article"] button',
    ),
  ].at(-1) as HTMLButtonElement;
  await act(async () => row.click());
  await frames();
  expect(shell.activeTopicId).toBe("article-example");
  expect(node.querySelector("[data-test-dialog]")).toBeNull();
  // Back from the Article: the shell leaves the topic on discussion.
  shell.activeTopicId = null;
  await act(async () => shell.rerender());
  await frames();
  return [...node.querySelectorAll("[data-test-dialog]")].map((d) => ({
    host: d.closest("[data-dest]")?.getAttribute("data-dest"),
    hidden: d.closest("[hidden]") !== null,
  }));
};

it("returns to the home destination before reopening after an Article opened from there", async () => {
  const reopened = await roundTrip("home");
  expect(shell.calls).toEqual([
    "navigatePrimary:discussion",
    "openTopic:article-example",
    "navigatePrimary:home",
  ]);
  expect(shell.activeDestination).toBe("home");
  expect(reopened).toEqual([{ host: "home", hidden: false }]);
});

it("reopens in place when the Article was opened from the discussion destination", async () => {
  shell.activeDestination = "discussion";
  await act(async () => shell.rerender());
  const reopened = await roundTrip("discussion");
  // Switching to the destination already shown is a no-op, as in ProductShell.
  expect(shell.calls).toEqual(["openTopic:article-example"]);
  expect(reopened).toEqual([{ host: "discussion", hidden: false }]);
});

it("opens the message center from the user destination, which has no host, by bringing home forward", async () => {
  shell.activeDestination = "user";
  await act(async () => shell.rerender());
  // The profile that issued the request is still closing for a few frames.
  shell.refuseNavigations = 3;
  shell.openToken = 1;
  await act(async () => shell.rerender());
  await frames();
  await frames();
  const dialogs = [...node.querySelectorAll("[data-test-dialog]")].map((d) => ({
    host: d.closest("[data-dest]")?.getAttribute("data-dest"),
    hidden: d.closest("[hidden]") !== null,
    panel: d.querySelector("[data-dm-panel]") !== null,
  }));
  expect(shell.calls).toEqual(["navigatePrimary:home"]);
  expect(dialogs).toEqual([{ host: "home", hidden: false, panel: true }]);
});

it("does not move a reader who is already on a destination with a host", async () => {
  shell.activeDestination = "discussion";
  await act(async () => shell.rerender());
  shell.openToken = 2;
  await act(async () => shell.rerender());
  await frames();
  expect(shell.calls).toEqual([]);
  expect(
    [...node.querySelectorAll("[data-test-dialog]")].map((d) =>
      d.closest("[data-dest]")?.getAttribute("data-dest"),
    ),
  ).toEqual(["discussion"]);
});

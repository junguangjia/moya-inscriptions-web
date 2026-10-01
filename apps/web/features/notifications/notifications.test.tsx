// @vitest-environment jsdom
import { act, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const { author, client } = vi.hoisted(() => ({
  author: {
    viewer: { id: `user-${"1".repeat(32)}` } as { id: string } | null,
    checking: false,
    sessionError: false,
  },
  client: {
    notifications: vi.fn(),
    readNotifications: vi.fn(),
    mentionPeople: vi.fn(),
    account: vi.fn(() => `user-${"1".repeat(32)}`),
  },
}));
vi.mock("../authors/author-context", () => ({ useAuthors: () => author }));
vi.mock("../authors/author-data", () => ({ authorClient: client }));
import { NotificationProvider, useNotifications } from "./notification-context";
import { MentionControl } from "./mention-control";
(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
let node: HTMLDivElement, root: ReturnType<typeof createRoot>;
const sockets: {
  close: ReturnType<typeof vi.fn>;
  addEventListener: ReturnType<typeof vi.fn>;
}[] = [];
const page = (total: number) => ({
  items: [],
  unread: { total, likes: total, comments: 0, mentions: 0 },
  observation: "synthetic-observation",
  nextCursor: null,
});
beforeEach(() => {
  sockets.length = 0;
  vi.clearAllMocks();
  author.viewer = { id: `user-${"1".repeat(32)}` };
  author.checking = false;
  author.sessionError = false;
  client.notifications.mockResolvedValue(page(2));
  vi.stubGlobal(
    "EventSource",
    class {
      close = vi.fn();
      addEventListener = vi.fn();
      constructor(readonly url: string) {
        expect(url).toBe("/api/community/notifications/stream");
        sockets.push(this);
      }
    },
  );
  node = document.createElement("div");
  document.body.append(node);
  root = createRoot(node);
});
afterEach(async () => {
  await act(async () => root.unmount());
  node.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
function State({ mounted }: { mounted: () => void }) {
  const inbox = useNotifications();
  useEffect(mounted, [mounted]);
  return (
    <>
      <output>{inbox.page?.unread.total ?? "empty"}</output>
      {inbox.error && <p role="alert">{inbox.error}</p>}
      <button onClick={inbox.refresh}>重试</button>
    </>
  );
}
describe("real notification composition", () => {
  it("owns one stream, keeps editor children mounted on focus/session checks and clears account state on logout", async () => {
    const mounted = vi.fn();
    const render = () =>
      act(async () =>
        root.render(
          <NotificationProvider enabled>
            <State mounted={mounted} />
          </NotificationProvider>,
        ),
      );
    await render();
    expect(node.querySelector("output")?.textContent).toBe("2");
    expect(sockets).toHaveLength(1);
    author.checking = true;
    await render();
    author.checking = false;
    await render();
    expect(mounted).toHaveBeenCalledTimes(1);
    expect(sockets).toHaveLength(1);
    author.viewer = null;
    await render();
    expect(node.querySelector("output")?.textContent).toBe("empty");
    expect(sockets[0]!.close).toHaveBeenCalledOnce();
  });
  it("uses an error state with no sample fallback and ignores responses from a previous account", async () => {
    let finish: ((value: ReturnType<typeof page>) => void) | undefined;
    client.notifications.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const mounted = vi.fn(),
      render = () =>
        act(async () =>
          root.render(
            <NotificationProvider enabled>
              <State mounted={mounted} />
            </NotificationProvider>,
          ),
        );
    await render();
    author.viewer = { id: `user-${"2".repeat(32)}` };
    client.notifications.mockRejectedValue(new Error("offline"));
    await render();
    await act(async () => finish?.(page(99)));
    expect(node.querySelector("output")?.textContent).toBe("empty");
    expect(node.querySelector('[role="alert"]')?.textContent).toContain(
      "暂时不可用",
    );
  });
  it("waits for read persistence and inbox reload while passive SSE remains non-mutating", async () => {
    let inbox!: ReturnType<typeof useNotifications>;
    function Probe() {
      inbox = useNotifications();
      return null;
    }
    await act(async () =>
      root.render(
        <NotificationProvider enabled>
          <Probe />
        </NotificationProvider>,
      ),
    );
    const signal = sockets[0]!.addEventListener.mock.calls.find(
      ([name]) => name === "refresh",
    )![1] as () => void;
    await act(async () => signal());
    expect(client.readNotifications).not.toHaveBeenCalled();
    let finish!: (value: ReturnType<typeof page>) => void;
    client.readNotifications.mockResolvedValue(undefined);
    client.notifications.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    let completed = false;
    await act(async () => {
      void inbox.read("observed-inbox").then(() => {
        completed = true;
      });
    });
    expect(completed).toBe(false);
    await act(async () => finish(page(0)));
    expect(completed).toBe(true);
    expect(inbox.page?.unread.total).toBe(0);
  });
  it.each(["stream", "foreground", "read"])(
    "revalidates loaded pages on %s without losing older rows or keeping stale private excerpts",
    async (trigger) => {
      let inbox!: ReturnType<typeof useNotifications>;
      function Probe() {
        inbox = useNotifications();
        return null;
      }
      client.notifications
        .mockResolvedValueOnce({
          ...page(2),
          items: [{ id: "first", excerpt: "first" }],
          nextCursor: "old-page-2",
        })
        .mockResolvedValueOnce({
          ...page(2),
          items: [{ id: "older", excerpt: "old private text" }],
        });
      await act(async () =>
        root.render(
          <NotificationProvider enabled>
            <Probe />
          </NotificationProvider>,
        ),
      );
      await act(async () => inbox.more());
      expect(inbox.page?.items.map((item) => item.id)).toEqual([
        "first",
        "older",
      ]);
      client.notifications
        .mockResolvedValueOnce({
          ...page(1),
          items: [{ id: "first", excerpt: "fresh" }],
          nextCursor: "fresh-page-2",
        })
        .mockResolvedValueOnce({
          ...page(1),
          items: [{ id: "older", excerpt: "", available: false }],
        });
      client.readNotifications.mockResolvedValue(undefined);
      await act(async () => {
        if (trigger === "read") await inbox.read("item-observation");
        else if (trigger === "foreground") {
          Object.defineProperty(document, "visibilityState", {
            configurable: true,
            value: "visible",
          });
          document.dispatchEvent(new Event("visibilitychange"));
        } else {
          const signal = sockets[0]!.addEventListener.mock.calls.find(
            ([name]) => name === "refresh",
          )![1] as () => void;
          signal();
        }
      });
      expect(client.notifications.mock.calls.at(-1)?.[1]).toBe("fresh-page-2");
      expect(inbox.page?.items.map((item) => item.id)).toEqual([
        "first",
        "older",
      ]);
      expect(inbox.page?.items[1]).toMatchObject({
        excerpt: "",
        available: false,
      });
      expect(inbox.page?.unread.total).toBe(1);
      if (trigger !== "read")
        expect(client.readNotifications).not.toHaveBeenCalled();
    },
  );
  it("selects one stable user among duplicate display names and never parses plain pasted text into recipients", async () => {
    vi.useFakeTimers();
    const person = {
      id: `user-${"2".repeat(32)}`,
      handle: "reader-two",
      displayName: "同名",
    };
    client.mentionPeople.mockResolvedValue({
      items: [
        { ...person, id: `user-${"3".repeat(32)}`, handle: "reader-three" },
        person,
      ],
    });
    const change = vi.fn();
    await act(async () =>
      root.render(
        <NotificationProvider enabled>
          <MentionControl text="碑😀" mentions={[]} onChange={change} />
        </NotificationProvider>,
      ),
    );
    await act(async () => {
      node.querySelector("button")!.click();
    });
    await act(async () => {
      const input = node.querySelector("input")!;
      Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
      )!.set!.call(input, "reader");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(260);
    });
    const selected = [...node.querySelectorAll("button")].find((button) =>
      button.textContent?.includes("@reader-two"),
    )!;
    await act(async () => selected.click());
    expect(change).toHaveBeenCalledWith("碑😀 @reader-two", [
      { userId: person.id, handle: person.handle, start: 4, end: 15 },
    ]);
  });

  it("sits inside a comment box as an @ trigger that opens the same picker", async () => {
    // Owner acceptance (2026-09-25): the comment composer is one box and a
    // send button; mentions stay reachable from an "@" inside the box.
    await act(async () =>
      root.render(
        <NotificationProvider enabled>
          <MentionControl inline text="" mentions={[]} onChange={vi.fn()} />
        </NotificationProvider>,
      ),
    );
    const trigger = node.querySelector("button")!;
    expect(trigger.textContent).toBe("@");
    expect(trigger.getAttribute("aria-label")).toBe("提醒用户");
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    await act(async () => trigger.click());
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    const panel = document.getElementById(
      trigger.getAttribute("aria-controls")!,
    );
    const input = panel!.querySelector<HTMLInputElement>(
      'input[aria-label="查找要提醒的用户"]',
    )!;
    // Enter searches in the picker and never submits the comment around it;
    // Escape closes the picker and returns to the trigger.
    const enter = new KeyboardEvent("keydown", {
      key: "Enter",
      bubbles: true,
      cancelable: true,
    });
    await act(async () => input.dispatchEvent(enter));
    expect(enter.defaultPrevented).toBe(true);
    await act(async () =>
      input.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
      ),
    );
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(trigger);
  });
});

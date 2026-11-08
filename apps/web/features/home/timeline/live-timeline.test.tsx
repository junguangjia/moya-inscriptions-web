// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { TimelineEntry } from "@moya/contracts";
import type { Root } from "react-dom/client";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const client = vi.hoisted(() => ({
  accountEpoch: vi.fn(() => 0),
  timeline: vi.fn(),
  timelinePostCounts: vi.fn(),
}));
const author = vi.hoisted(() => ({
  checking: false,
  viewer: null as { id: string } | null,
}));
vi.mock("../../authors/author-context", () => ({
  useAuthors: () => author,
  useOptionalAuthors: () => author,
}));
vi.mock("../../authors/author-data", () => ({
  authorClient: client,
}));
vi.mock("../../product-shell/product-shell", () => ({
  useProductShell: () => ({
    openCatalog: vi.fn(),
    platform: "phone",
    readActiveScrollTop: () => 0,
    restoreActiveScrollTop: vi.fn(),
  }),
}));

const entries = [
  {
    id: "row-1",
    title: "虚构南寺碑",
    fullTitle: "唐虚构南寺碑",
    startYear: 700,
    endYear: 700,
    precision: "year",
    dateLabel: "虚元八年",
    onAxis: true,
    chapter: "唐",
    polity: "唐",
    disputed: false,
    groupId: null,
    groupTitle: null,
    province: "虚构西州",
    holder: "虚构碑林",
    catalogId: null,
    media: null,
  },
] as unknown as readonly TimelineEntry[];

let container: HTMLDivElement;
let root: Root;

/** The session cache lives in the module, so each case imports it afresh. */
const load = async () => (await import("./live-timeline")).LiveTimeline;

const flush = async () => {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
};

const feedState = () =>
  container
    .querySelector("[data-timeline-feed]")
    ?.getAttribute("data-timeline-state");

beforeEach(() => {
  vi.resetModules();
  author.checking = false;
  author.viewer = null;
  client.accountEpoch.mockReturnValue(0);
  client.timeline.mockReset();
  client.timelinePostCounts.mockReset();
  client.timelinePostCounts.mockResolvedValue({ counts: {} });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("LiveTimeline", () => {
  it("starts a new read when the account changed during the first one", async () => {
    let refuse: (reason: Error) => void = () => undefined;
    client.timeline.mockReturnValueOnce(
      new Promise((_, reject) => {
        refuse = reject;
      }),
    );
    const LiveTimeline = await load();
    act(() => root.render(<LiveTimeline active />));
    author.checking = true;
    act(() => root.render(<LiveTimeline active />));
    client.accountEpoch.mockReturnValue(1);
    client.timeline.mockResolvedValue({ entries });
    author.checking = false;
    act(() => root.render(<LiveTimeline active />));
    await flush();
    expect(client.timeline).toHaveBeenCalledTimes(2);
    expect(feedState()).toBe("populated");
    await act(async () => refuse(new Error("account changed")));
    await flush();
    expect(feedState()).toBe("populated");
  });

  it("waits for the account check before its first read", async () => {
    author.checking = true;
    client.timeline.mockResolvedValue({ entries });
    const LiveTimeline = await load();
    act(() => root.render(<LiveTimeline active />));
    await flush();
    expect(client.timeline).not.toHaveBeenCalled();
    expect(feedState()).toBe("loading");
    author.checking = false;
    act(() => root.render(<LiveTimeline active />));
    await flush();
    expect(client.timeline).toHaveBeenCalledOnce();
    expect(feedState()).toBe("populated");
  });

  it("refreshes an aged list in place when the feed comes back", async () => {
    client.timeline.mockResolvedValue({ entries });
    const LiveTimeline = await load();
    await act(async () => root.render(<LiveTimeline active />));
    await flush();
    expect(client.timeline).toHaveBeenCalledOnce();
    act(() => root.render(<LiveTimeline active={false} />));
    const now = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(now + 300_000);
    // A failed refresh keeps what is on screen.
    client.timeline.mockRejectedValueOnce(new Error("offline"));
    await act(async () => root.render(<LiveTimeline active />));
    await flush();
    clock.mockRestore();
    expect(client.timeline).toHaveBeenCalledTimes(2);
    expect(feedState()).toBe("populated");
  });

  it("refreshes after an image fails, at most once a minute", async () => {
    const withSource = (src: string) =>
      ["row-1", "row-2", "row-3"].map((id, index) => ({
        ...entries[0],
        id,
        startYear: 700 + index,
        endYear: 700 + index,
        media: {
          id: `media-${id}`,
          kind: "image",
          src,
          alt: "虚构南寺碑",
          width: 1200,
          height: 800,
        },
      }));
    const expired = "https://media.example.invalid/expired.webp";
    const fresh = "https://media.example.invalid/fresh.webp";
    client.timeline.mockResolvedValue({ entries: withSource(expired) });
    const LiveTimeline = await load();
    await act(async () => root.render(<LiveTimeline active />));
    await flush();
    const failOne = async () => {
      const image = container.querySelector<HTMLImageElement>(
        `img[src="${expired}"]`,
      );
      expect(image).not.toBeNull();
      await act(async () => image!.dispatchEvent(new Event("error")));
      await flush();
    };
    // Seconds after the fetch, a failure says nothing about the URLs' age.
    await failOne();
    expect(client.timeline).toHaveBeenCalledOnce();
    const now = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(now + 61_000);
    client.timeline.mockResolvedValue({ entries: withSource(fresh) });
    await failOne();
    clock.mockRestore();
    expect(client.timeline).toHaveBeenCalledTimes(2);
    // Every row takes its new URL, including the two that had failed.
    expect(container.querySelectorAll(`img[src="${fresh}"]`).length).toBe(3);
    expect(container.querySelector(`img[src="${expired}"]`)).toBeNull();
  });

  it("retries a failed image after a refresh even when its URL is the same", async () => {
    const stable = entries.map((entry) => ({
      ...entry,
      media: {
        id: "media-1",
        kind: "image",
        src: "https://media.example.invalid/stable.webp",
        alt: "虚构南寺碑",
        width: 1200,
        height: 800,
      },
    }));
    client.timeline.mockResolvedValue({ entries: stable });
    const LiveTimeline = await load();
    await act(async () => root.render(<LiveTimeline active />));
    await flush();
    const now = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(now + 61_000);
    client.timeline.mockResolvedValue({
      entries: stable.map((entry) => ({ ...entry })),
    });
    const image = container.querySelector("img");
    await act(async () => image!.dispatchEvent(new Event("error")));
    await flush();
    clock.mockRestore();
    expect(client.timeline).toHaveBeenCalledTimes(2);
    expect(container.querySelector("img")).not.toBeNull();
  });

  it("never fetches before the feed is active", async () => {
    const LiveTimeline = await load();
    act(() => root.render(<LiveTimeline active={false} />));
    await flush();
    expect(client.timeline).not.toHaveBeenCalled();
    expect(feedState()).toBe("loading");
  });

  it("fetches on first activation and caches for the session", async () => {
    client.timeline.mockResolvedValue({ entries });
    const LiveTimeline = await load();
    act(() => root.render(<LiveTimeline active />));
    expect(client.timeline).toHaveBeenCalledTimes(1);
    expect(feedState()).toBe("loading");
    await flush();
    expect(feedState()).toBe("populated");
    act(() => root.render(<LiveTimeline active={false} />));
    act(() => root.render(<LiveTimeline active />));
    await flush();
    expect(client.timeline).toHaveBeenCalledTimes(1);
    expect(feedState()).toBe("populated");

    // A later mount in the same page session starts populated.
    act(() => root.unmount());
    root = createRoot(container);
    act(() => root.render(<LiveTimeline active={false} />));
    expect(feedState()).toBe("populated");
    expect(client.timeline).toHaveBeenCalledTimes(1);
  });

  it("retries a failure on the next activation", async () => {
    client.timeline.mockRejectedValueOnce(new Error("offline"));
    const LiveTimeline = await load();
    act(() => root.render(<LiveTimeline active />));
    await flush();
    expect(feedState()).toBe("unavailable");
    expect(container.textContent).toContain("时间轴暂时不可用");

    client.timeline.mockResolvedValue({ entries });
    act(() => root.render(<LiveTimeline active={false} />));
    act(() => root.render(<LiveTimeline active />));
    expect(client.timeline).toHaveBeenCalledTimes(2);
    expect(feedState()).toBe("loading");
    await flush();
    expect(feedState()).toBe("populated");
  });

  it("counts an empty answer as unavailable and retries it", async () => {
    client.timeline.mockResolvedValueOnce({ entries: [] });
    const LiveTimeline = await load();
    act(() => root.render(<LiveTimeline active />));
    await flush();
    expect(feedState()).toBe("unavailable");

    client.timeline.mockResolvedValue({ entries });
    act(() => root.render(<LiveTimeline active={false} />));
    act(() => root.render(<LiveTimeline active />));
    expect(client.timeline).toHaveBeenCalledTimes(2);
    await flush();
    expect(feedState()).toBe("populated");
  });

  it("uses an answer that arrives after the reader left", async () => {
    let answer: (value: {
      entries: readonly TimelineEntry[];
    }) => void = () => {};
    client.timeline.mockReturnValue(
      new Promise((resolve) => {
        answer = resolve;
      }),
    );
    const LiveTimeline = await load();
    act(() => root.render(<LiveTimeline active />));
    act(() => root.render(<LiveTimeline active={false} />));
    answer({ entries });
    await flush();
    act(() => root.render(<LiveTimeline active />));
    await flush();
    expect(client.timeline).toHaveBeenCalledTimes(1);
    expect(feedState()).toBe("populated");
  });

  it("reads the post counts only once the list is on screen, and prints them", async () => {
    let answer: (value: {
      entries: readonly TimelineEntry[];
    }) => void = () => {};
    client.timeline.mockReturnValue(
      new Promise((resolve) => {
        answer = resolve;
      }),
    );
    client.timelinePostCounts.mockResolvedValue({ counts: { "row-1": 3 } });
    const LiveTimeline = await load();
    act(() => root.render(<LiveTimeline active />));
    await flush();
    // The counts never hold up the list's first read.
    expect(client.timelinePostCounts).not.toHaveBeenCalled();
    answer({ entries });
    await flush();
    expect(client.timelinePostCounts).toHaveBeenCalledOnce();
    // The phone row ends on the count instead of 保管 (Figma C2).
    expect(container.textContent).toContain("虚元八年 · 虚构西州 · 3 篇帖子");
    expect(container.textContent).not.toContain("虚构碑林");
  });

  it("keeps the rows when the counts fail, and never shows another account's", async () => {
    client.timeline.mockResolvedValue({ entries });
    client.timelinePostCounts.mockRejectedValueOnce(new Error("offline"));
    const LiveTimeline = await load();
    act(() => root.render(<LiveTimeline active />));
    await flush();
    expect(feedState()).toBe("populated");
    expect(container.textContent).toContain("虚构碑林");

    client.timelinePostCounts.mockResolvedValue({ counts: { "row-1": 2 } });
    author.viewer = { id: `user-${"a".repeat(32)}` };
    act(() => root.render(<LiveTimeline active />));
    await flush();
    expect(container.textContent).toContain("2 篇帖子");

    // Another account: the earlier account's count leaves at once.
    client.accountEpoch.mockReturnValue(1);
    client.timelinePostCounts.mockReturnValue(new Promise(() => undefined));
    author.viewer = { id: `user-${"b".repeat(32)}` };
    act(() => root.render(<LiveTimeline active />));
    await flush();
    expect(container.textContent).not.toContain("篇帖子");
    expect(container.textContent).toContain("虚构碑林");
  });

  it("reads the counts again when posts change elsewhere, while the feed is shown", async () => {
    client.timeline.mockResolvedValue({ entries });
    client.timelinePostCounts.mockResolvedValue({ counts: { "row-1": 1 } });
    const LiveTimeline = await load();
    const { invalidateTimelinePostCounts } =
      await import("./timeline-posts-data");
    act(() => root.render(<LiveTimeline active />));
    await flush();
    expect(container.textContent).toContain("1 篇帖子");
    client.timelinePostCounts.mockResolvedValue({ counts: { "row-1": 2 } });
    // A work page or a published post changed them.
    act(() => invalidateTimelinePostCounts());
    await flush();
    expect(client.timelinePostCounts).toHaveBeenCalledTimes(2);
    expect(container.textContent).toContain("2 篇帖子");
    // A fresh copy answers a re-activation without a read.
    act(() => root.render(<LiveTimeline active={false} />));
    act(() => root.render(<LiveTimeline active />));
    await flush();
    expect(client.timelinePostCounts).toHaveBeenCalledTimes(2);
  });

  it("tells the feed its counts are loaded only once read since the last change", async () => {
    client.timeline.mockResolvedValue({ entries });
    client.timelinePostCounts.mockResolvedValue({ counts: {} });
    const LiveTimeline = await load();
    const { invalidateTimelinePostCounts } =
      await import("./timeline-posts-data");
    const counts = () =>
      container
        .querySelector("[data-timeline-feed]")
        ?.getAttribute("data-timeline-counts");
    act(() => root.render(<LiveTimeline active />));
    await flush();
    // An empty answer is loaded: no row has posts.
    expect(counts()).toBe("loaded");
    // A change is read again; until then the counts are stale.
    let answer: (value: { counts: Record<string, number> }) => void = () => {};
    client.timelinePostCounts.mockReturnValueOnce(
      new Promise((resolve) => {
        answer = resolve;
      }),
    );
    act(() => invalidateTimelinePostCounts());
    await flush();
    expect(counts()).toBe("pending");
    answer({ counts: { "row-1": 1 } });
    await flush();
    expect(counts()).toBe("loaded");
    // A failed read leaves them stale.
    client.timelinePostCounts.mockRejectedValueOnce(new Error("offline"));
    act(() => invalidateTimelinePostCounts());
    await flush();
    expect(counts()).toBe("pending");
    expect(container.textContent).toContain("1 篇帖子");
  });

  it("draws cached counts at once but takes them for loaded only while fresh", async () => {
    client.timeline.mockResolvedValue({ entries });
    client.timelinePostCounts.mockResolvedValue({ counts: { "row-1": 2 } });
    const LiveTimeline = await load();
    const counts = () =>
      container
        .querySelector("[data-timeline-feed]")
        ?.getAttribute("data-timeline-counts");
    act(() => root.render(<LiveTimeline active />));
    await flush();
    expect(counts()).toBe("loaded");
    act(() => root.render(<></>));
    // Over a minute later the cache still draws the rows, but a missing id
    // is not taken for 0 until the refresh answers.
    const now = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(now + 61_000);
    let answer: (value: { counts: Record<string, number> }) => void = () => {};
    client.timelinePostCounts.mockReturnValueOnce(
      new Promise((resolve) => {
        answer = resolve;
      }),
    );
    act(() => root.render(<LiveTimeline active />));
    expect(counts()).toBe("pending");
    await flush();
    expect(container.textContent).toContain("2 篇帖子");
    answer({ counts: { "row-1": 2 } });
    await flush();
    expect(counts()).toBe("loaded");
    clock.mockRestore();
  });

  it("reads the counts again when posts change during a read, and never keeps that older answer", async () => {
    client.timeline.mockResolvedValue({ entries });
    type Counts = { counts: Record<string, number> };
    let older: (value: Counts) => void = () => {};
    let newer: (value: Counts) => void = () => {};
    client.timelinePostCounts.mockReturnValueOnce(
      new Promise<Counts>((resolve) => {
        older = resolve;
      }),
    );
    const LiveTimeline = await load();
    const { invalidateTimelinePostCounts } =
      await import("./timeline-posts-data");
    act(() => root.render(<LiveTimeline active />));
    await flush();
    expect(client.timelinePostCounts).toHaveBeenCalledOnce();
    client.timelinePostCounts.mockReturnValueOnce(
      new Promise<Counts>((resolve) => {
        newer = resolve;
      }),
    );
    // A post was attached while the first read was on its way.
    act(() => invalidateTimelinePostCounts());
    await flush();
    expect(client.timelinePostCounts).toHaveBeenCalledTimes(2);
    newer({ counts: { "row-1": 2 } });
    await flush();
    expect(container.textContent).toContain("2 篇帖子");
    older({ counts: { "row-1": 1 } });
    await flush();
    expect(container.textContent).toContain("2 篇帖子");
    // The copy kept for a re-activation is the newer answer.
    act(() => root.render(<LiveTimeline active={false} />));
    act(() => root.render(<LiveTimeline active />));
    await flush();
    expect(client.timelinePostCounts).toHaveBeenCalledTimes(2);
    expect(container.textContent).toContain("2 篇帖子");
  });
});

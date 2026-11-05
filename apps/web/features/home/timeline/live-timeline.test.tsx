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
}));
const author = vi.hoisted(() => ({ checking: false }));
vi.mock("../../authors/author-context", () => ({
  useAuthors: () => author,
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
  client.accountEpoch.mockReturnValue(0);
  client.timeline.mockReset();
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
});

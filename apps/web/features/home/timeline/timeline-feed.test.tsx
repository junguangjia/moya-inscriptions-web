// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createVisualCatalogItems } from "../../../qa/home-catalog-scenarios";
import { createTimelineFixture } from "../../../qa/home/timeline-fixture";
import { TimelineFeed, resolveTimelineLayout } from "./timeline-feed";
import { formatPercent } from "./timeline-format";
import { timelineChapterInfo, timelineYearFraction } from "./timeline-model";
// @ts-expect-error -- Vite serves the stylesheet's own text for a ?raw import.
import timelineCss from "./timeline.module.css?raw";

import type { TimelineEntry } from "@moya/contracts";
import type { Root } from "react-dom/client";
import type { HomeFeedState } from "../home-feed";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const shell = vi.hoisted(() => ({
  browseOnly: false,
  openCatalog: vi.fn(),
  openContent: vi.fn(),
  openEditor: vi.fn(() => true),
  openProfile: vi.fn(),
  platform: "phone" as "phone" | "tablet" | "pc",
  readActiveScrollTop: vi.fn(() => 0),
  restoreActiveScrollTop: vi.fn(),
}));
vi.mock("../../product-shell/product-shell", () => ({
  useProductShell: () => shell,
}));
// timeline-posts-v1: the card's reads; no row has posts unless a case says.
const posts = vi.hoisted(() => ({
  readTimelinePosts: vi.fn(),
}));
vi.mock("./timeline-posts-data", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./timeline-posts-data")>()),
  readTimelinePosts: posts.readTimelinePosts,
}));
const authors = vi.hoisted(() => ({
  value: null as null | {
    checking: boolean;
    viewer: { id: string } | null;
  },
}));
vi.mock("../../authors/author-context", () => ({
  useOptionalAuthors: () => authors.value,
  useAuthors: () => {
    if (authors.value === null) throw Error("Author provider missing");
    return authors.value;
  },
}));

const origin = "http://localhost:3100";
const fixture = createTimelineFixture(origin, createVisualCatalogItems(origin));
const populated: HomeFeedState<TimelineEntry> = {
  state: "populated",
  items: fixture,
};

let container: HTMLDivElement;
let root: Root;

const render = (
  active: boolean,
  state: HomeFeedState<TimelineEntry> = populated,
) => {
  act(() => {
    root.render(<TimelineFeed active={active} state={state} />);
  });
};
const query = (selector: string) => container.querySelector(selector);
const queryAll = (selector: string) => [
  ...container.querySelectorAll<HTMLElement>(selector),
];
const rows = () => queryAll("[data-timeline-row]");
const text = () => container.textContent ?? "";
const click = (element: Element | null | undefined) => {
  if (!element) throw new Error("Nothing to click");
  act(() => {
    element.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
};
/** A history step lands on a later task, which a loaded machine can delay. */
const waitForHistory = <T,>(check: () => T) =>
  vi.waitFor(check, { timeout: 5000 });

const settlePop = async () => {
  await act(async () => {
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
};

/** A row tap without a known count reads its total before anything opens. */
const settleReads = async () => {
  await act(async () => {
    for (let at = 0; at < 6; at += 1) await Promise.resolve();
  });
};

/** A narrow fixture of real shapes so the window can show the rows at once. */
const entry = (overrides: Partial<TimelineEntry>): TimelineEntry =>
  ({
    id: `row-${Math.random().toString(36).slice(2, 10)}`,
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
    ...overrides,
  }) as TimelineEntry;
const small = (
  items: readonly TimelineEntry[],
): HomeFeedState<TimelineEntry> => ({
  state: "populated",
  items,
});

const openedDialog = () => query("dialog");

beforeEach(() => {
  shell.platform = "phone";
  shell.browseOnly = false;
  shell.openCatalog.mockClear();
  shell.openContent.mockClear();
  shell.openEditor.mockClear();
  shell.openProfile.mockClear();
  authors.value = null;
  posts.readTimelinePosts.mockReset();
  posts.readTimelinePosts.mockResolvedValue({ items: [], total: 0, page: 1 });
  shell.restoreActiveScrollTop.mockClear();
  shell.readActiveScrollTop.mockClear();
  Object.defineProperty(HTMLDialogElement.prototype, "showModal", {
    configurable: true,
    value(this: HTMLDialogElement) {
      this.open = true;
    },
  });
  Object.defineProperty(HTMLDialogElement.prototype, "close", {
    configurable: true,
    value(this: HTMLDialogElement) {
      this.open = false;
    },
  });
  window.history.replaceState(null, "", "/");
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  act(() => root.unmount());
  container.remove();
  // Unmounting an open modal steps history back from a microtask; that step
  // must land here, or it closes the next case's modal.
  await Promise.resolve();
  await waitForHistory(() =>
    expect(window.history.state?.phase4Dialog).toBeUndefined(),
  );
});

describe("states", () => {
  it("server-renders the root and no rows", () => {
    const html = renderToStaticMarkup(
      <TimelineFeed active state={populated} />,
    );
    expect(html).toContain("data-timeline-feed");
    expect(html).not.toContain('data-timeline-row="');
  });

  it("builds nothing until the feed has been active", () => {
    render(false);
    expect(rows()).toHaveLength(0);
    render(true);
    expect(rows().length).toBeGreaterThan(0);
    render(false);
    expect(rows().length).toBeGreaterThan(0);
  });

  it("keeps one root element from loading to populated", () => {
    render(true, { state: "loading" });
    const first = container.firstElementChild;
    expect(first?.getAttribute("data-timeline-feed")).toBe("");
    render(true);
    expect(container.firstElementChild).toBe(first);
  });

  it("shows the spine and rail while loading, with no skeleton", () => {
    render(true, { state: "loading" });
    expect(query("[data-timeline-position]")?.textContent).toBe("正在载入");
    expect(query("[data-timeline-rail]")).not.toBeNull();
    expect(rows()).toHaveLength(0);
    expect(text()).not.toContain("时间轴暂时不可用");
  });

  it.each([
    [{ state: "empty" }],
    [{ state: "unavailable" }],
    [{ state: "unexpected-error" }],
    [{ state: "populated", items: [] }],
  ] as const)("shows one failure message for %o", (state) => {
    render(true, state as HomeFeedState<TimelineEntry>);
    expect(text()).toContain("时间轴暂时不可用");
    expect(text()).toContain("请稍后再试。");
    expect(query("[data-timeline-rail]")).toBeNull();
  });

  it("resolves the wide layout seam", () => {
    expect(resolveTimelineLayout("phone", 1000)).toBe("phone");
    expect(resolveTimelineLayout("tablet", 834)).toBe("tablet");
    expect(resolveTimelineLayout("tablet", 896)).toBe("wide");
    expect(resolveTimelineLayout("pc", 500)).toBe("wide");
  });
});

describe("the windowed list", () => {
  it("renders far fewer rows than the fixture holds", () => {
    render(true);
    expect(fixture.length).toBeGreaterThan(400);
    expect(rows().length).toBeGreaterThan(5);
    expect(rows().length).toBeLessThan(60);
    expect(query("[data-timeline-list]")?.getAttribute("style")).toMatch(
      /height: \d+px/u,
    );
  });

  it("opens on 晚商 with the reading position in the bar", () => {
    render(true);
    expect(query("[data-timeline-position]")?.textContent).toBe(
      "约前1250 · 晚商",
    );
    expect(text()).toContain("甲骨文与金文并见");
    expect(text()).not.toMatch(/未收|暂无/u);
  });

  it("gives an empty chapter no tap", () => {
    render(true);
    const empty = rows().find((row) => row.dataset.timelineRow === "empty");
    expect(empty?.querySelector("button")).toBeNull();
    const rail = queryAll("[data-timeline-rail] button");
    expect(rail).toHaveLength(18);
    expect((rail[0] as HTMLButtonElement).disabled).toBe(true);
    expect((rail[3] as HTMLButtonElement).disabled).toBe(false);
  });

  it("uses the tablet columns on a tablet", () => {
    shell.platform = "tablet";
    vi.stubGlobal("innerWidth", 834);
    render(true, small([entry({})]));
    const feed = query("[data-timeline-feed]");
    expect(feed?.getAttribute("data-timeline-layout")).toBe("tablet");
    expect(text()).toContain("名称");
    expect(text()).toContain("保管");
    const button = queryAll("[data-timeline-row='entry'] button")[0];
    expect(button?.textContent).toContain("虚构西州");
    expect(button?.textContent).not.toContain("虚元八年 · 虚构西州");
  });
});

describe("rows", () => {
  it("opens the deck for a linked row, whose Catalog card opens Detail from the row", async () => {
    const withMedia = entry({
      catalogId: "catalog-one" as never,
      media: {
        alt: "虚构图",
        height: 420,
        id: "media-one" as never,
        kind: "image",
        src: `${origin}/docs/design-system/assets/demo/inscription-rubbing.svg`,
        width: 600,
      },
    });
    const textOnly = entry({
      startYear: 701,
      endYear: 701,
      catalogId: "catalog-two" as never,
    });
    render(true, small([withMedia, textOnly]));
    const linked = queryAll("[data-open-catalog]");
    expect(linked.map((row) => row.dataset.catalogId)).toEqual([
      "catalog-one",
      "catalog-two",
    ]);
    expect(linked[0]?.querySelector("img")?.getAttribute("sizes")).toBeNull();
    expect(linked[1]?.querySelector("img")).toBeNull();
    click(linked[1]);
    // Issue #422: the row no longer opens Detail itself; its deck's first
    // card does, after the deck has closed.
    expect(shell.openCatalog).not.toHaveBeenCalled();
    const deck = openedDialog()?.querySelector("[data-timeline-deck]");
    expect(deck?.getAttribute("data-timeline-deck")).toBe(textOnly.id);
    const card = deck?.querySelector("[data-deck-current]");
    expect(card?.getAttribute("data-deck-card")).toBe("catalog");
    click(card);
    expect(shell.openContent).not.toHaveBeenCalled();
    await waitForHistory(() => expect(openedDialog()).toBeNull());
    expect(shell.openContent).toHaveBeenCalledWith(
      { type: "catalog", id: "catalog-two" },
      linked[1],
    );
  });

  it("opens the 词条卡 for an unlinked row and omits absent values", async () => {
    render(
      true,
      small([
        entry({
          fullTitle: "北魏虚构永平碑",
          startYear: 511,
          endYear: 511,
          holder: null,
          chapter: "南北朝",
        }),
      ]),
    );
    const row = queryAll("[data-timeline-row='entry'] button")[0]!;
    click(row);
    // No count is known: the row reads its own total (one post's page)
    // first, and opens the 词条卡 because it has none.
    expect(openedDialog()).toBeNull();
    expect(posts.readTimelinePosts).toHaveBeenCalledWith(
      expect.stringMatching(/^row-/u),
      1,
      1,
      expect.any(AbortSignal),
    );
    await settleReads();
    const dialog = openedDialog();
    expect(dialog?.textContent).toContain("北魏虚构永平碑");
    expect(dialog?.textContent).toContain("年代");
    expect(dialog?.textContent).toContain("511 · 虚元八年");
    expect(dialog?.textContent).toContain("地点");
    expect(dialog?.textContent).not.toContain("保管");
    // timeline-posts-v1 (Figma B5): the action and its line, which is also
    // all a row without posts says.
    expect(dialog?.textContent).toContain("上传这件碑帖");
    expect(dialog?.textContent).toContain("发布后会出现在这个词条下。");
    expect(dialog?.querySelector("[data-timeline-post-grid]")).toBeNull();
    expect(shell.openCatalog).not.toHaveBeenCalled();
    // The modal holds its own history entry; Back closes it.
    expect(window.history.state?.phase4Dialog).toBeTruthy();
    window.history.back();
    await settlePop();
    await waitForHistory(() => expect(openedDialog()).toBeNull());
  });

  it("marks a dispute and a multi-period row with their tags", () => {
    render(
      true,
      small([
        entry({ disputed: true, startYear: 640, endYear: 640 }),
        entry({ precision: "multi", startYear: 650, endYear: 700 }),
      ]),
    );
    const marks = queryAll("[data-mark]").map((mark) => mark.dataset.mark);
    expect(marks).toEqual(["ring", "multi"]);
    expect(queryAll("[data-tag]").map((tag) => tag.textContent)).toEqual([
      "异说",
      "多期",
    ]);
    const lines = queryAll("[data-timeline-row='entry'] button")[1];
    expect(lines?.textContent).toContain("650");
    expect(lines?.textContent).toContain("–700");
  });

  it("expands a group in place, opens a member, and collapses", async () => {
    const members = Array.from({ length: 3 }, (_, at) =>
      entry({
        groupId: "yunfeng",
        groupTitle: "虚构云峰诸刻",
        title: `虚构题记${at}`,
        catalogId: at === 0 ? ("catalog-member" as never) : null,
      }),
    );
    render(true, small(members));
    const toggle = query("[data-timeline-group]") as HTMLElement;
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(toggle.textContent).toContain("虚构云峰诸刻");
    expect(toggle.textContent).toContain("3 件");
    expect(toggle.textContent).toContain("虚构题记0、虚构题记1、虚构题记2");
    click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(query("[data-timeline-group]")).toBe(toggle);
    expect(toggle.textContent).toContain("收起");
    const member = query("li [data-open-catalog]");
    click(member);
    expect(
      openedDialog()
        ?.querySelector("[data-deck-current]")
        ?.getAttribute("data-deck-card"),
    ).toBe("catalog");
    window.history.back();
    await settlePop();
    await waitForHistory(() => expect(openedDialog()).toBeNull());
    click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(query("li [data-open-catalog]")).toBeNull();
  });

  it("returns to the fold row when a deep group collapses", () => {
    const members = Array.from({ length: 3 }, () =>
      entry({ groupId: "deep", groupTitle: "虚构诸刻" }),
    );
    render(true, small(members));
    const toggle = query("[data-timeline-group]") as HTMLElement;
    click(toggle);
    shell.restoreActiveScrollTop.mockClear();
    shell.readActiveScrollTop.mockReturnValue(5000);
    click(toggle);
    expect(shell.restoreActiveScrollTop).toHaveBeenCalledTimes(1);
    shell.readActiveScrollTop.mockReturnValue(0);
  });

  it("shows every row of a crowded year at once", () => {
    render(
      true,
      small(
        Array.from({ length: 9 }, (_, at) =>
          entry({ startYear: 720, endYear: 720, title: `虚构同年碑${at}` }),
        ),
      ),
    );
    expect(
      queryAll("[data-timeline-row='entry']").map((row) => row.textContent),
    ).toEqual(
      Array.from({ length: 9 }, (_, at) =>
        expect.stringContaining(`虚构同年碑${at}`),
      ),
    );
    expect(text()).not.toMatch(/另 \d+ 条/u);
  });
});

describe("posts on the timeline (timeline-posts-v1)", () => {
  const unlinked = () =>
    entry({ id: "row-post", fullTitle: "北魏虚构永平碑", title: "永平碑" });
  // A count known as 0 opens the 词条卡 at once; its grid still shows the
  // posts the read finds, as after a stale count.
  const openCard = () => {
    act(() => {
      root.render(
        <TimelineFeed
          active
          postCounts={new Map([["row-post", 0]])}
          state={small([unlinked()])}
        />,
      );
    });
    const row = queryAll("[data-timeline-row='entry'] button")[0]!;
    click(row);
    return { dialog: openedDialog() as HTMLElement, row };
  };

  it("closes the card, then opens the editor on the entry from the row", async () => {
    authors.value = {
      checking: false,
      viewer: { id: `user-${"a".repeat(32)}` },
    };
    const { dialog, row } = openCard();
    click(dialog.querySelector("[data-timeline-upload]"));
    expect(shell.openEditor).not.toHaveBeenCalled();
    await waitForHistory(() => expect(openedDialog()).toBeNull());
    expect(shell.openEditor).toHaveBeenCalledWith(
      { type: "new", timelineEntryId: "row-post" },
      row,
    );
  });

  it("sends a guest's upload and attach to sign-in", async () => {
    const { dialog, row } = openCard();
    click(dialog.querySelector("[data-timeline-upload]"));
    await waitForHistory(() => expect(openedDialog()).toBeNull());
    expect(shell.openEditor).not.toHaveBeenCalled();
    expect(shell.openProfile).toHaveBeenCalledWith(null, row);

    shell.openProfile.mockClear();
    const again = openCard();
    click(again.dialog.querySelector("[data-timeline-attach]"));
    await waitForHistory(() => expect(openedDialog()).toBeNull());
    expect(shell.openProfile).toHaveBeenCalledWith(null, again.row);
  });

  it("opens a post's work from the card through the row", async () => {
    posts.readTimelinePosts.mockResolvedValue({
      items: [
        {
          id: `work-${"1".repeat(32)}`,
          authorId: `user-${"a".repeat(32)}`,
          authorName: "虚构作者",
          title: "访碑记",
          text: "",
          media: [],
          available: true,
          canEdit: false,
          firstPublishedAt: "2026-11-07T00:00:00.000Z",
        },
      ],
      total: 1,
      page: 1,
    });
    const { dialog, row } = openCard();
    await act(async () => {
      await Promise.resolve();
    });
    expect(posts.readTimelinePosts).toHaveBeenCalledWith(
      "row-post",
      1,
      6,
      expect.any(AbortSignal),
    );
    const cell = dialog.querySelector("[data-timeline-post]");
    expect(cell?.getAttribute("aria-label")).toBe("访碑记");
    click(cell);
    await waitForHistory(() => expect(openedDialog()).toBeNull());
    expect(shell.openContent).toHaveBeenCalledWith(
      { type: "work", id: `work-${"1".repeat(32)}` },
      row,
    );
  });

  it("keeps the posts and drops both actions when browse-only", () => {
    shell.browseOnly = true;
    const { dialog } = openCard();
    expect(dialog.querySelector("[data-timeline-upload]")).toBeNull();
    expect(dialog.querySelector("[data-timeline-attach]")).toBeNull();
    expect(dialog.querySelector("[data-timeline-posts]")).not.toBeNull();
  });

  it("ends a phone row on its count instead of 保管, and says nothing for none", () => {
    act(() => {
      root.render(
        <TimelineFeed
          active
          postCounts={new Map([["row-post", 4]])}
          state={small([
            unlinked(),
            entry({ id: "row-none", startYear: 701, endYear: 701 }),
          ])}
        />,
      );
    });
    const [counted, none] = queryAll("[data-timeline-row='entry'] button");
    expect(counted?.textContent).toContain("虚元八年 · 虚构西州 · 4 篇帖子");
    expect(counted?.textContent).not.toContain("虚构碑林");
    expect(none?.textContent).toContain("虚构碑林");
    expect(none?.textContent).not.toContain("篇帖子");
  });

  it("prints the count after the name on a tablet, keeping 保管 in its column", () => {
    shell.platform = "tablet";
    vi.stubGlobal("innerWidth", 834);
    act(() => {
      root.render(
        <TimelineFeed
          active
          postCounts={new Map([["row-post", 12]])}
          state={small([unlinked()])}
        />,
      );
    });
    const button = queryAll("[data-timeline-row='entry'] button")[0];
    expect(
      button?.querySelector("[data-timeline-post-count]")?.textContent,
    ).toBe("12 篇帖子");
    expect(button?.textContent).toContain("虚构碑林");
  });
});

describe("the card deck (Issue #422)", () => {
  const post = (n: number) => ({
    id: `work-${String(n).repeat(32)}`,
    authorId: `user-${"b".repeat(32)}`,
    authorName: `虚构作者${n}`,
    title: `访碑记${n}`,
    text: "",
    media: [],
    available: true,
    canEdit: false,
    firstPublishedAt: "2026-11-07T00:00:00.000Z",
  });
  const counted = () =>
    entry({ id: "row-post", fullTitle: "北魏虚构永平碑", title: "永平碑" });
  const none = () =>
    entry({
      id: "row-none",
      fullTitle: "唐虚构无帖碑",
      startYear: 701,
      endYear: 701,
    });
  const renderCounted = () => {
    act(() => {
      root.render(
        <TimelineFeed
          active
          postCounts={new Map([["row-post", 2]])}
          state={small([counted(), none()])}
        />,
      );
    });
    return queryAll("[data-timeline-row='entry'] button");
  };
  const deck = () => openedDialog()?.querySelector("[data-timeline-deck]");
  const flushPosts = async () => {
    await act(async () => {
      for (let at = 0; at < 4; at += 1) await Promise.resolve();
    });
  };

  beforeEach(() => {
    posts.readTimelinePosts.mockResolvedValue({
      items: [post(1), post(2)],
      total: 2,
      page: 1,
    });
  });

  it("opens the deck for a row with posts, and the 词条卡 for a row with neither", async () => {
    const [withPosts, without] = renderCounted();
    click(withPosts);
    expect(deck()?.getAttribute("data-timeline-deck")).toBe("row-post");
    expect(openedDialog()?.querySelector("[data-timeline-card]")).toBeNull();
    await flushPosts();
    expect(
      [...(deck()?.querySelectorAll("button[data-deck-card]") ?? [])].map(
        (card) => card.getAttribute("data-deck-card"),
      ),
    ).toEqual(["post", "post"]);
    expect(
      deck()?.querySelector("[data-timeline-deck-position]")?.textContent,
    ).toBe("1 / 2");
    window.history.back();
    await settlePop();
    await waitForHistory(() => expect(openedDialog()).toBeNull());
    // The focus is back on the row.
    await waitForHistory(() => expect(document.activeElement).toBe(withPosts));

    // Its count is unknown: its own read finds none, so the 词条卡 opens.
    posts.readTimelinePosts.mockResolvedValue({ items: [], total: 0, page: 1 });
    click(without);
    expect(openedDialog()).toBeNull();
    await flushPosts();
    expect(deck()).toBeNull();
    expect(
      openedDialog()?.querySelector("[data-timeline-card]")?.textContent,
    ).toContain("上传这件碑帖");
  });

  it("reads an unknown count first, and opens the deck when the row has posts", async () => {
    const [, without] = renderCounted();
    click(without);
    expect(openedDialog()).toBeNull();
    expect(posts.readTimelinePosts).toHaveBeenCalledWith(
      "row-none",
      1,
      1,
      expect.any(AbortSignal),
    );
    await flushPosts();
    expect(deck()?.getAttribute("data-timeline-deck")).toBe("row-none");
  });

  it("opens the 词条卡 when the read of an unknown count fails", async () => {
    posts.readTimelinePosts.mockRejectedValueOnce(new Error("offline"));
    const [, without] = renderCounted();
    click(without);
    await flushPosts();
    expect(deck()).toBeNull();
    expect(
      openedDialog()?.querySelector("[data-timeline-card]"),
    ).not.toBeNull();
  });

  it("reads once for a double tap, and opens nothing once the feed has gone", async () => {
    let answer: (value: unknown) => void = () => undefined;
    posts.readTimelinePosts.mockReturnValueOnce(
      new Promise((resolve) => {
        answer = resolve;
      }),
    );
    const [, without] = renderCounted();
    click(without);
    click(without);
    expect(posts.readTimelinePosts).toHaveBeenCalledOnce();
    answer({ items: [post(1)], total: 1, page: 1 });
    await flushPosts();
    expect(deck()?.getAttribute("data-timeline-deck")).toBe("row-none");
    window.history.back();
    await settlePop();
    await waitForHistory(() => expect(openedDialog()).toBeNull());

    // A read still on its way when the feed unmounts is dropped.
    let late: (value: unknown) => void = () => undefined;
    posts.readTimelinePosts.mockReturnValueOnce(
      new Promise((resolve) => {
        late = resolve;
      }),
    );
    click(without);
    const signal = posts.readTimelinePosts.mock.lastCall?.[3] as AbortSignal;
    act(() => root.render(<div />));
    expect(signal.aborted).toBe(true);
    late({ items: [post(1)], total: 1, page: 1 });
    await flushPosts();
    expect(openedDialog()).toBeNull();
  });

  it("opens the 词条卡 at once for a row the loaded counts leave out, reading no count", () => {
    act(() => {
      root.render(
        <TimelineFeed
          active
          postCounts={new Map([["row-post", 2]])}
          postCountsLoaded
          state={small([counted(), none()])}
        />,
      );
    });
    const [, without] = queryAll("[data-timeline-row='entry'] button");
    click(without);
    // The counts list only rows with posts: missing means none.
    expect(posts.readTimelinePosts).not.toHaveBeenCalledWith(
      "row-none",
      1,
      1,
      expect.anything(),
    );
    expect(without!.hasAttribute("aria-busy")).toBe(false);
    expect(deck()).toBeNull();
    expect(
      openedDialog()?.querySelector("[data-timeline-card]"),
    ).not.toBeNull();
  });

  it("says the tapped row is busy while counts that are not loaded make it read", async () => {
    let answer: (value: unknown) => void = () => undefined;
    posts.readTimelinePosts.mockReturnValueOnce(
      new Promise((resolve) => {
        answer = resolve;
      }),
    );
    const [withPosts, without] = renderCounted();
    expect(
      query("[data-timeline-feed]")?.getAttribute("data-timeline-counts"),
    ).toBe("pending");
    click(without);
    expect(posts.readTimelinePosts).toHaveBeenCalledWith(
      "row-none",
      1,
      1,
      expect.any(AbortSignal),
    );
    expect(without!.getAttribute("aria-busy")).toBe("true");
    expect(withPosts!.hasAttribute("aria-busy")).toBe(false);
    expect(timelineCss).toMatch(
      /\.entry\[aria-busy="true"\],\s*\.member\[aria-busy="true"\] \{[^}]*background: var\(--yoyi-color-background-muted\);/u,
    );
    // The double-tap guard holds while it reads.
    click(without);
    expect(posts.readTimelinePosts).toHaveBeenCalledOnce();
    answer({ items: [], total: 0, page: 1 });
    await flushPosts();
    expect(without!.hasAttribute("aria-busy")).toBe(false);
    expect(
      openedDialog()?.querySelector("[data-timeline-card]"),
    ).not.toBeNull();
  });

  it("closes the deck, then opens a post card's work from the row", async () => {
    const [row] = renderCounted();
    click(row);
    await flushPosts();
    const card = deck()?.querySelector("[data-deck-current]");
    expect(card?.getAttribute("data-deck-post")).toBe(post(1).id);
    click(card);
    expect(shell.openContent).not.toHaveBeenCalled();
    await waitForHistory(() => expect(openedDialog()).toBeNull());
    expect(shell.openContent).toHaveBeenCalledWith(
      { type: "work", id: post(1).id },
      row,
    );
    // The upload button left with the deck.
    expect(query("[data-timeline-deck-upload]")).toBeNull();
  });

  it("starts a new post on the entry from the deck's 上传, from the row", async () => {
    authors.value = {
      checking: false,
      viewer: { id: `user-${"a".repeat(32)}` },
    };
    const [row] = renderCounted();
    click(row);
    click(deck()?.querySelector("[data-timeline-deck-upload]"));
    click(deck()?.querySelector("[data-timeline-deck-new]"));
    await waitForHistory(() => expect(openedDialog()).toBeNull());
    expect(shell.openEditor).toHaveBeenCalledWith(
      { type: "new", timelineEntryId: "row-post" },
      row,
    );
  });

  it("sends a guest's 上传新帖子 and 关联我发过的帖子 to sign-in", async () => {
    const [row] = renderCounted();
    click(row);
    click(deck()?.querySelector("[data-timeline-deck-upload]"));
    click(deck()?.querySelector("[data-timeline-deck-new]"));
    await waitForHistory(() => expect(openedDialog()).toBeNull());
    expect(shell.openEditor).not.toHaveBeenCalled();
    expect(shell.openProfile).toHaveBeenCalledWith(null, row);

    shell.openProfile.mockClear();
    click(row);
    click(deck()?.querySelector("[data-timeline-deck-upload]"));
    click(deck()?.querySelector("[data-timeline-deck-attach]"));
    await waitForHistory(() => expect(openedDialog()).toBeNull());
    expect(shell.openProfile).toHaveBeenCalledWith(null, row);
  });

  it("has no upload button when browse-only", async () => {
    shell.browseOnly = true;
    const [row] = renderCounted();
    click(row);
    await flushPosts();
    expect(deck()?.querySelector("[data-timeline-deck-upload]")).toBeNull();
    expect(deck()?.querySelectorAll("button[data-deck-card]")).toHaveLength(2);
  });

  it("keeps source and absence words off the deck", async () => {
    posts.readTimelinePosts.mockResolvedValue({ items: [], total: 0, page: 1 });
    const [row] = renderCounted();
    click(row);
    await flushPosts();
    expect(deck()?.textContent).toContain("发布后会出现在这个词条下。");
    expect(deck()?.textContent).not.toMatch(
      /来源|出处|未收|暂无|还没有|尚未|没有|无法/u,
    );
  });
});

describe("年代不详", () => {
  const offAxis = (overrides: Partial<TimelineEntry>) =>
    entry({
      onAxis: false,
      precision: "dynasty",
      dateLabel: null,
      startYear: 618,
      endYear: 907,
      ...overrides,
    });
  const undated = [
    entry({ startYear: 700, endYear: 700, title: "虚构有年碑" }),
    offAxis({
      id: "row-undated",
      title: "虚构无年碑",
      fullTitle: "唐虚构无年碑",
    }),
    offAxis({
      title: "虚构链接碑",
      fullTitle: "唐虚构链接碑",
      catalogId: "catalog-undated" as never,
    }),
    ...Array.from({ length: 3 }, (_, at) =>
      offAxis({
        title: `虚构组碑${at}`,
        fullTitle: `唐虚构组碑${at}`,
        groupId: "caves",
        groupTitle: "虚构石窟诸题记",
      }),
    ),
    ...Array.from({ length: 2 }, (_, at) =>
      offAxis({
        title: `虚构双阙${at}`,
        fullTitle: `唐虚构双阙${at}`,
        groupId: "pair",
        groupTitle: "虚构双阙",
      }),
    ),
  ];
  const chapterRows = () =>
    rows().filter(
      (row) =>
        row.dataset.timelineRow !== "empty" &&
        row.dataset.timelineRow !== "marker",
    );
  const undatedRow = (title: string) =>
    queryAll("[data-timeline-row='entry'] button").find((button) =>
      button.textContent?.includes(title),
    );

  it("closes the chapter under its heading, one row each, with no 其他", () => {
    render(true, small(undated));
    expect(chapterRows().map((row) => row.dataset.timelineRow)).toEqual([
      "head",
      "entry",
      "undated",
      "entry",
      "entry",
      "group",
      "entry",
      "entry",
    ]);
    expect(query("[data-timeline-row='undated']")?.textContent).toBe(
      "年代不详",
    );
    expect(text()).not.toContain("其他");
    // Each names its entry as the axis does, by the short title.
    expect(text()).not.toMatch(/唐虚构(?:无年碑|链接碑|双阙)/u);
    for (const title of ["虚构无年碑", "虚构双阙0", "虚构双阙1"]) {
      const row = undatedRow(title);
      // No year, no mark, and the spine dotted off the axis.
      expect(row?.querySelector("[data-mark]")).toBeNull();
      expect(row?.firstElementChild?.textContent).toBe("");
      expect(row?.querySelector("[data-spine='dotted']")).not.toBeNull();
    }
    expect(
      undatedRow("虚构有年碑")?.querySelector("[data-mark='dot']"),
    ).not.toBeNull();
  });

  it("folds a same-kind group of three in place and opens it", () => {
    render(true, small(undated));
    const toggle = query("[data-timeline-group]") as HTMLElement;
    expect(toggle.getAttribute("data-timeline-group")).toBe("undated:唐:caves");
    expect(toggle.textContent).toContain("虚构石窟诸题记");
    expect(toggle.textContent).toContain("3 件");
    expect(toggle.querySelector("[data-mark]")).toBeNull();
    expect(text()).not.toContain("唐虚构组碑0");
    click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(
      [...container.querySelectorAll("li button")].map(
        (button) => button.textContent,
      ),
    ).toEqual(["虚构组碑0", "虚构组碑1", "虚构组碑2"]);
  });

  it("opens an unlinked row's 词条卡 and a linked row's deck, as any row", async () => {
    render(true, small(undated));
    const linked = undatedRow("虚构链接碑");
    expect(linked?.getAttribute("data-catalog-id")).toBe("catalog-undated");
    click(linked);
    expect(
      openedDialog()?.querySelector("[data-timeline-deck]"),
    ).not.toBeNull();
    window.history.back();
    await settlePop();
    await waitForHistory(() => expect(openedDialog()).toBeNull());

    authors.value = {
      checking: false,
      viewer: { id: `user-${"a".repeat(32)}` },
    };
    const row = undatedRow("虚构无年碑")!;
    click(row);
    await settleReads();
    // The 词条卡 names it in full.
    const dialog = openedDialog() as HTMLElement;
    expect(dialog.textContent).toContain("唐虚构无年碑");
    expect(dialog.textContent).toContain("上传这件碑帖");
    click(dialog.querySelector("[data-timeline-upload]"));
    await waitForHistory(() => expect(openedDialog()).toBeNull());
    expect(shell.openEditor).toHaveBeenCalledWith(
      { type: "new", timelineEntryId: "row-undated" },
      row,
    );
  });

  it("counts an undated row's posts as any row's", () => {
    act(() => {
      root.render(
        <TimelineFeed
          active
          postCounts={new Map([["row-undated", 2]])}
          state={small(undated)}
        />,
      );
    });
    expect(undatedRow("虚构无年碑")?.textContent).toContain(
      "虚构西州 · 2 篇帖子",
    );
  });

  it("reads 「晚商 · 年代不详」 in the bar and writes no year for it", () => {
    vi.useFakeTimers();
    window.history.replaceState({ shell: 1 }, "", "/?keep=1");
    const original = HTMLElement.prototype.getBoundingClientRect;
    // Head 55, then the heading: 30 scrolled plus the 36 bar is inside it.
    HTMLElement.prototype.getBoundingClientRect = function stub() {
      return this.hasAttribute("data-timeline-list")
        ? ({ top: -30, width: 390 } as DOMRect)
        : original.call(this);
    };
    try {
      render(
        true,
        small([
          offAxis({ chapter: "商", polity: "商", startYear: -1250 }),
          offAxis({ chapter: "商", polity: "商", startYear: -1250 }),
        ]),
      );
      act(() => {
        window.dispatchEvent(new Event("scroll"));
      });
      act(() => {
        vi.advanceTimersByTime(300);
      });
      expect(query("[data-timeline-position]")?.textContent).toBe(
        "晚商 · 年代不详",
      );
      expect(window.location.search).toBe("?keep=1");
      // The 纪年 sheet's marker stays at the chapter's end (it has no axis
      // row), not back at its start.
      click(query("[data-timeline-position]"));
      const marker = openedDialog()?.querySelector<HTMLElement>(
        "[class*='scaleCurrent']",
      );
      const { endYear } = timelineChapterInfo("商");
      expect(marker?.style.left).toBe(
        formatPercent(timelineYearFraction(endYear!)),
      );
    } finally {
      HTMLElement.prototype.getBoundingClientRect = original;
    }
  });
});

describe("the 纪年 sheet", () => {
  const openEra = () => {
    render(
      true,
      small([
        entry({
          chapter: "东汉",
          polity: "东汉",
          dateLabel: "太玄三年",
          startYear: 90,
          endYear: 90,
        }),
        entry({
          chapter: "东汉",
          polity: "东汉",
          dateLabel: "太玄五年",
          startYear: 92,
          endYear: 92,
        }),
        entry({
          chapter: "唐",
          dateLabel: "太玄元年",
          startYear: 700,
          endYear: 700,
        }),
        entry({
          chapter: "唐",
          dateLabel: "开宁八年",
          startYear: 720,
          endYear: 720,
        }),
        entry({
          chapter: "宋辽金夏",
          polity: "辽",
          dateLabel: "虚圣二年",
          startYear: 1000,
          endYear: 1000,
        }),
      ]),
    );
    click(query("[data-timeline-position]"));
    return openedDialog() as HTMLElement;
  };
  const input = (dialog: Element, label: string) =>
    dialog.querySelector<HTMLInputElement>(`input[aria-label='${label}']`)!;
  const type = (element: HTMLInputElement, value: string) => {
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
      )?.set;
      setter?.call(element, value);
      element.dispatchEvent(new Event("input", { bubbles: true }));
    });
  };
  const submit = (element: Element) => {
    act(() => {
      element
        .closest("form")
        ?.dispatchEvent(
          new Event("submit", { bubbles: true, cancelable: true }),
        );
    });
  };

  it("shows the 总尺, the inputs and the era grid with totals", () => {
    const dialog = openEra();
    expect(dialog.textContent).toContain("纪年");
    expect(dialog.textContent).toContain("约前1250");
    expect(dialog.textContent).toContain(String(new Date().getFullYear()));
    expect(
      dialog.querySelector("[data-timeline-scale] svg rect"),
    ).not.toBeNull();
    const cells = [
      ...dialog.querySelectorAll<HTMLButtonElement>("button"),
    ].filter(
      (button) =>
        button.textContent === "东汉2" || button.textContent === "晚商",
    );
    expect(cells.map((cell) => cell.disabled)).toEqual([true, false]);
  });

  it("jumps to a typed year, landing on the next entry", async () => {
    const dialog = openEra();
    type(input(dialog, "输入年份"), "701");
    submit(input(dialog, "输入年份"));
    await waitForHistory(() => expect(openedDialog()).toBeNull());
    expect(shell.restoreActiveScrollTop).toHaveBeenCalledTimes(1);
  });

  it("does not jump for an empty or impossible year", () => {
    const dialog = openEra();
    type(input(dialog, "输入年份"), "0");
    submit(input(dialog, "输入年份"));
    expect(shell.restoreActiveScrollTop).not.toHaveBeenCalled();
    expect(openedDialog()).not.toBeNull();
  });

  it("says when a reign is unknown", () => {
    const dialog = openEra();
    type(input(dialog, "年号"), "没有");
    submit(input(dialog, "年号"));
    expect(dialog.textContent).toContain("换成年份试试");
    type(input(dialog, "年号"), "没");
    expect(dialog.textContent).not.toContain("换成年份试试");
    expect(openedDialog()).not.toBeNull();
  });

  it("jumps straight to a reign in one chapter", async () => {
    const dialog = openEra();
    type(input(dialog, "年号"), "开宁");
    submit(input(dialog, "年号"));
    await waitForHistory(() => expect(openedDialog()).toBeNull());
    expect(shell.restoreActiveScrollTop).toHaveBeenCalledTimes(1);
  });

  it("prompts a choice for a reign title across chapters", async () => {
    const dialog = openEra();
    type(input(dialog, "年号"), "太玄");
    submit(input(dialog, "年号"));
    const choices = dialog.querySelector("[data-timeline-reign-choices]");
    expect(choices?.textContent).toContain("东汉 · 90");
    expect(choices?.textContent).toContain("唐 · 700");
    expect(openedDialog()).not.toBeNull();
    click(choices?.querySelectorAll("button")[1]);
    await waitForHistory(() => expect(openedDialog()).toBeNull());
    expect(shell.restoreActiveScrollTop).toHaveBeenCalledTimes(1);
  });

  it("jumps to a chapter from the grid", async () => {
    const dialog = openEra();
    const cell = [...dialog.querySelectorAll("button")].find((button) =>
      button.textContent?.startsWith("宋辽金夏"),
    );
    click(cell);
    await waitForHistory(() => expect(openedDialog()).toBeNull());
    expect(shell.restoreActiveScrollTop).toHaveBeenCalledTimes(1);
  });

  it("shows the 凡例 with its own Back step", async () => {
    const dialog = openEra();
    const legend = [...dialog.querySelectorAll("button")].find(
      (button) => button.textContent === "凡例",
    );
    click(legend);
    expect(dialog.querySelector("[data-timeline-legend]")).not.toBeNull();
    expect(dialog.textContent).toContain("空心红圈");
    // Issue #422: no 其他 shelf; the off-axis rows close each chapter.
    expect(dialog.textContent).toContain(
      "「年代不详」下是不落在轴上的条目，放在各朝代末尾。",
    );
    expect(dialog.textContent).not.toContain("「其他」");
    expect(dialog.querySelectorAll("[data-mark]")).toHaveLength(4);
    window.history.back();
    await settlePop();
    await waitForHistory(() =>
      expect(dialog.querySelector("[data-timeline-era]")).not.toBeNull(),
    );
  });
});

describe("what the timeline says", () => {
  const forbidden =
    /来源|出处|第一批|名录|未收|未系年|暂无|还没有|尚未|没有|没找到|无法/u;
  const list = [
    entry({ startYear: 700, endYear: 700 }),
    entry({
      title: "虚构无年之碑",
      fullTitle: "唐虚构无年之碑",
      onAxis: false,
      precision: "dynasty",
      startYear: 618,
      endYear: 907,
    }),
  ];

  it("keeps source and absence words off the rows and the sheets", async () => {
    render(true, small(list));
    expect(container.textContent).not.toMatch(forbidden);
    click(query("[data-timeline-position]"));
    const era = openedDialog();
    expect(era?.textContent).not.toMatch(forbidden);
    click(
      [...(era?.querySelectorAll("button") ?? [])].find(
        (button) => button.textContent === "凡例",
      ),
    );
    expect(openedDialog()?.textContent).toContain("空心红圈");
    expect(openedDialog()?.textContent).not.toMatch(forbidden);
  });

  it("keeps them off 年代不详 and its entry card", async () => {
    render(true, small(list));
    expect(query("[data-timeline-row='undated']")).not.toBeNull();
    click(
      queryAll("[data-timeline-row='entry'] button").find((button) =>
        button.textContent?.includes("虚构无年之碑"),
      ),
    );
    await settleReads();
    const card = openedDialog();
    expect(card?.querySelector("[data-timeline-card]")).not.toBeNull();
    expect(card?.textContent).not.toMatch(forbidden);
  });

  it("leaves a failed image's box empty, with no failure text", () => {
    render(
      true,
      small([
        entry({
          startYear: 700,
          endYear: 700,
          media: {
            id: "media-1",
            kind: "image",
            src: "https://media.example.invalid/expired.webp",
            alt: "虚构南寺碑",
            width: 1200,
            height: 800,
          },
        } as Partial<TimelineEntry>),
      ]),
    );
    const image = query("[data-timeline-media] img");
    act(() => {
      image?.dispatchEvent(new Event("error"));
    });
    const box = query("[data-timeline-media]");
    expect(box?.getAttribute("data-timeline-media")).toBe("failed");
    expect(box?.textContent).toBe("");
  });
});

describe("a sheet over the pager", () => {
  it("keeps wheel gestures from reaching the pager", () => {
    render(true, small([entry({ startYear: 700, endYear: 700 })]));
    click(query("[data-timeline-position]"));
    const onWheel = vi.fn();
    const dialog = openedDialog();
    const panel = dialog?.querySelector("[data-timeline-sheet-panel]");
    expect(panel).toBeTruthy();
    container.addEventListener("wheel", onWheel);
    const wheel = new WheelEvent("wheel", { bubbles: true, deltaX: 40 });
    const stop = vi.spyOn(wheel, "stopPropagation");
    act(() => {
      panel?.dispatchEvent(wheel);
    });
    container.removeEventListener("wheel", onWheel);
    expect(stop).toHaveBeenCalled();
  });
});

describe("the rail", () => {
  const items = [
    entry({ chapter: "秦", polity: "秦", startYear: -210, endYear: -210 }),
    entry({ chapter: "唐", startYear: 700, endYear: 700 }),
    entry({ chapter: "唐", startYear: 710, endYear: 710 }),
    entry({ chapter: "明", polity: "明", startYear: 1400, endYear: 1400 }),
  ];
  const touch = (
    element: Element,
    type: string,
    clientY: number,
    clientX = 370,
  ) => {
    const event = new Event(type, { bubbles: true, cancelable: true });
    const touches = type === "touchend" ? [] : [{ clientX, clientY }];
    Object.defineProperty(event, "touches", { value: touches });
    act(() => {
      element.dispatchEvent(event);
    });
    return event;
  };
  const railElement = () => query("[data-timeline-rail]") as HTMLElement;
  const stubRailRect = () => {
    railElement().getBoundingClientRect = () =>
      ({ top: 100, height: 576, left: 354, width: 36 }) as DOMRect;
  };
  const cellTop = (glyphIndex: number) => 100 + glyphIndex * 32;

  it("marks the current chapter and jumps on tap", () => {
    render(true, small(items));
    expect(
      railElement().querySelector("[aria-current='true']")?.textContent,
    ).toBe("商");
    expect(railElement().hasAttribute("data-local-horizontal")).toBe(true);
    const cells = railElement().querySelectorAll("button");
    click(cells[10]);
    expect(shell.restoreActiveScrollTop).toHaveBeenCalledTimes(1);
  });

  it("does not stop scrolling before the long press fires", () => {
    vi.useFakeTimers();
    render(true, small(items));
    stubRailRect();
    touch(railElement(), "touchstart", cellTop(10));
    const early = touch(railElement(), "touchmove", cellTop(10) + 20);
    expect(early.defaultPrevented).toBe(false);
    act(() => {
      vi.advanceTimersByTime(300);
    });
    expect(query("[data-timeline-bubble]")).toBeNull();
    const later = touch(railElement(), "touchmove", cellTop(12));
    expect(later.defaultPrevented).toBe(false);
    touch(railElement(), "touchend", cellTop(12));
    expect(shell.restoreActiveScrollTop).not.toHaveBeenCalled();
  });

  it("drags per row after a 150 ms press, then resumes images", () => {
    vi.useFakeTimers();
    render(true, small(items));
    stubRailRect();
    touch(railElement(), "touchstart", cellTop(10) + 2);
    act(() => {
      vi.advanceTimersByTime(149);
    });
    expect(query("[data-timeline-bubble]")).toBeNull();
    act(() => {
      vi.advanceTimersByTime(1);
    });
    const bubble = query("[data-timeline-bubble]");
    expect(bubble?.textContent).toBe("唐700");
    expect(railElement().hasAttribute("data-dragging")).toBe(true);
    const moved = touch(railElement(), "touchmove", cellTop(10) + 16);
    expect(moved.defaultPrevented).toBe(true);
    expect(query("[data-timeline-bubble]")?.textContent).toContain("700");
    touch(railElement(), "touchmove", cellTop(14) + 16);
    expect(query("[data-timeline-bubble]")?.textContent).toContain("明");
    const ended = touch(railElement(), "touchend", cellTop(14) + 16);
    expect(ended.defaultPrevented).toBe(true);
    expect(query("[data-timeline-bubble]")).toBeNull();
    expect(railElement().hasAttribute("data-dragging")).toBe(false);
    expect(shell.restoreActiveScrollTop).toHaveBeenCalled();
  });

  it("holds a new row's image until 120 ms after the drag stops", () => {
    vi.useFakeTimers();
    const pictured = entry({
      chapter: "明",
      polity: "明",
      startYear: 1400,
      endYear: 1400,
      catalogId: "catalog-held" as never,
      media: {
        alt: "虚构图",
        height: 420,
        id: "media-held" as never,
        kind: "image",
        src: `${origin}/docs/design-system/assets/demo/inscription-rubbing.svg`,
        width: 600,
      },
    });
    render(true, small([items[0]!, pictured]));
    expect(
      query("[data-timeline-media]")?.getAttribute("data-timeline-media"),
    ).toBe("image");
    stubRailRect();
    touch(railElement(), "touchstart", cellTop(14) + 2);
    act(() => {
      vi.advanceTimersByTime(150);
    });
    // An image already on screen stays loaded through the drag.
    expect(query("[data-timeline-media] img")).not.toBeNull();
    touch(railElement(), "touchend", cellTop(14) + 2);
    act(() => {
      vi.advanceTimersByTime(120);
    });
    expect(query("[data-timeline-media] img")).not.toBeNull();
  });

  it("treats a still long press as a tap", () => {
    vi.useFakeTimers();
    render(true, small(items));
    stubRailRect();
    touch(railElement(), "touchstart", cellTop(4) + 16);
    act(() => {
      vi.advanceTimersByTime(150);
    });
    touch(railElement(), "touchend", cellTop(4) + 16);
    expect(query("[data-timeline-bubble]")).toBeNull();
    // The press itself, then the jump to the chapter head.
    expect(shell.restoreActiveScrollTop).toHaveBeenCalled();
  });
});

describe("the year in the URL", () => {
  // 商 opens the list here, so one short scroll puts an entry under the bar.
  const list = [
    entry({ chapter: "商", polity: "商", startYear: -1200, endYear: -1200 }),
    entry({ chapter: "商", polity: "商", startYear: -1100, endYear: -1100 }),
  ];
  /** The list scrolls against `window` when no panel surface wraps it. */
  const fireScrollAndSettle = () => {
    act(() => {
      window.dispatchEvent(new Event("scroll"));
    });
    act(() => {
      vi.advanceTimersByTime(300);
    });
  };

  it("jumps once to ?year= on first populate", () => {
    vi.useFakeTimers();
    window.history.replaceState(null, "", "/?feed=timeline&year=-1150");
    render(true, small(list));
    expect(shell.restoreActiveScrollTop).toHaveBeenCalledTimes(1);
    // New rows hold the row only while the jump settles, and never jump again.
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    render(true, small([...list]));
    expect(shell.restoreActiveScrollTop).toHaveBeenCalledTimes(1);
  });

  it("ignores an invalid year", () => {
    window.history.replaceState(null, "", "/?feed=timeline&year=abc");
    render(true, small(list));
    expect(shell.restoreActiveScrollTop).not.toHaveBeenCalled();
  });

  it("writes nothing while the top row has no year of its own", () => {
    vi.useFakeTimers();
    window.history.replaceState({ shell: 1 }, "", "/?keep=1");
    render(true, small([entry({ startYear: 700, endYear: 700 })]));
    fireScrollAndSettle();
    expect(window.location.search).toBe("?keep=1");
  });

  it("writes after 300 ms of quiet, yields to other layers, cleans up on leaving", () => {
    vi.useFakeTimers();
    window.history.replaceState({ shell: 1 }, "", "/?keep=1");
    const original = HTMLElement.prototype.getBoundingClientRect;
    HTMLElement.prototype.getBoundingClientRect = function stub() {
      return this.hasAttribute("data-timeline-list")
        ? ({ top: -30, width: 390 } as DOMRect)
        : original.call(this);
    };
    try {
      render(true, small(list));
      fireScrollAndSettle();
      expect(window.location.search).toBe("?keep=1&feed=timeline&year=-1200");
      expect(window.history.state).toEqual({ shell: 1 });

      const written = window.location.search;
      container.setAttribute("inert", "");
      window.history.replaceState({ shell: 1 }, "", "/?keep=1");
      fireScrollAndSettle();
      expect(window.location.search).toBe("?keep=1");
      container.removeAttribute("inert");

      window.history.replaceState(
        { shell: 1, phase4Dialog: "sheet" },
        "",
        "/?keep=1",
      );
      fireScrollAndSettle();
      expect(window.location.search).toBe("?keep=1");
      window.history.replaceState({ shell: 1 }, "", `/${written}`);

      render(false, small(list));
      expect(window.location.search).toBe("?keep=1");
    } finally {
      HTMLElement.prototype.getBoundingClientRect = original;
    }
  });

  it("takes its own params off the URL when the feed is left, whoever wrote them", () => {
    window.history.replaceState(null, "", "/?feed=timeline&year=abc&keep=1");
    render(true, small(list));
    render(false, small(list));
    expect(window.location.search).toBe("?keep=1");
  });

  it("leaves another feed's param alone", () => {
    window.history.replaceState(null, "", "/?feed=discover&keep=1");
    render(true, small(list));
    render(false, small(list));
    expect(window.location.search).toBe("?feed=discover&keep=1");
  });
});

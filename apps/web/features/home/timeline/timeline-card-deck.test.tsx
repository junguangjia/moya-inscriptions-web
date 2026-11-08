// @vitest-environment jsdom
import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  DECK_EDGE,
  DECK_WINDOW,
  TimelineCardDeck,
  timelineDeckOpens,
  timelineDeckPose,
} from "./timeline-card-deck";
// @ts-expect-error -- Vite serves the stylesheet's own text for a ?raw import.
import deckCss from "./timeline-card-deck.module.css?raw";
// @ts-expect-error -- as above: the shell dock's stylesheet.
import dockCss from "../../shell/primary-bottom-navigation.module.css?raw";
// @ts-expect-error -- as above: the design tokens' values.
import themeCss from "@moya/design-tokens/theme.css?raw";

import type { TimelineEntry, UserWork } from "@moya/contracts";
import type { Root } from "react-dom/client";
import type { Mock } from "vitest";
import type { TimelineDeckActions } from "./timeline-card-deck";
import type { TimelineRowLayout } from "./timeline-model";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const data = vi.hoisted(() => ({
  readTimelinePosts: vi.fn(),
  readOwnWorks: vi.fn(),
  readContentTimelineEntry: vi.fn(),
  setWorkTimelineEntry: vi.fn(),
}));
vi.mock("./timeline-posts-data", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./timeline-posts-data")>()),
  ...data,
}));
const authors = vi.hoisted(() => ({
  value: null as null | { checking: boolean; viewer: { id: string } | null },
}));
vi.mock("../../authors/author-context", () => ({
  useOptionalAuthors: () => authors.value,
}));

const viewerId = `user-${"a".repeat(32)}`;
const workId = (n: number) => `work-${n.toString(16).padStart(32, "0")}`;
const work = (n: number, overrides: Partial<UserWork> = {}): UserWork =>
  ({
    id: workId(n),
    authorId: `user-${"b".repeat(32)}`,
    authorName: `作者${n}`,
    title: `访碑记${n}`,
    text: "",
    media: [],
    available: true,
    canEdit: false,
    firstPublishedAt: "2026-11-07T00:00:00.000Z",
    ...overrides,
  }) as UserWork;
const works = (from: number, count: number) =>
  Array.from({ length: count }, (_, at) => work(from + at));
const page = (items: readonly UserWork[], total: number, at = 1) => ({
  items,
  total,
  page: at,
});

const entry = (overrides: Partial<TimelineEntry> = {}): TimelineEntry =>
  ({
    id: "row-yongping",
    title: "永平碑",
    fullTitle: "北魏虚构永平碑",
    startYear: 511,
    endYear: 511,
    precision: "year",
    dateLabel: "永平四年",
    onAxis: true,
    chapter: "南北朝",
    polity: "北魏",
    disputed: false,
    groupId: null,
    groupTitle: null,
    province: "虚构东州",
    holder: "虚构碑林",
    catalogId: null,
    media: null,
    ...overrides,
  }) as TimelineEntry;
const linked = (overrides: Partial<TimelineEntry> = {}) =>
  entry({
    catalogId: "catalog-yongping" as never,
    media: {
      alt: "虚构拓片",
      height: 800,
      id: "media-yongping" as never,
      kind: "image",
      src: "https://media.example.invalid/yongping.webp",
      width: 600,
    },
    ...overrides,
  } as Partial<TimelineEntry>);

let container: HTMLDivElement;
let root: Root;
let actions: {
  readonly [K in keyof TimelineDeckActions]-?: ReturnType<typeof vi.fn>;
};
let closed: Mock<() => void>;

const flush = async () => {
  await act(async () => {
    for (let at = 0; at < 6; at += 1) await Promise.resolve();
  });
};
const waitForHistory = <T,>(check: () => T) =>
  vi.waitFor(check, { timeout: 5000 });

/** As the timeline hosts it: the deck goes when it reports closed. */
const render = ({
  browseOnly = false,
  layout = "phone",
  value = entry(),
}: {
  readonly browseOnly?: boolean;
  readonly layout?: TimelineRowLayout;
  readonly value?: TimelineEntry;
} = {}) => {
  const Host = () => {
    const [open, setOpen] = useState(true);
    return open ? (
      <TimelineCardDeck
        actions={actions as unknown as TimelineDeckActions}
        browseOnly={browseOnly}
        entry={value}
        layout={layout}
        onClose={() => {
          closed();
          setOpen(false);
        }}
      />
    ) : null;
  };
  act(() => root.render(<Host />));
};
const query = (selector: string) => container.querySelector(selector);
const queryAll = (selector: string) => [
  ...container.querySelectorAll<HTMLElement>(selector),
];
const click = (element: Element | null | undefined) => {
  if (!element) throw new Error("Nothing to click");
  act(() => {
    element.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
};
const key = (element: Element | null, name: string) => {
  if (!element) throw new Error("Nothing to press");
  act(() => {
    element.dispatchEvent(
      new KeyboardEvent("keydown", {
        bubbles: true,
        cancelable: true,
        key: name,
      }),
    );
  });
};
const front = () => query("[data-deck-current]") as HTMLElement | null;
const shownCards = () => queryAll("button[data-deck-card]");
const nav = () => query("[data-timeline-deck-nav]") as HTMLElement | null;
/** The 「i / N」 cue while it shows; its row is held even when it does not. */
const position = () =>
  nav()?.hasAttribute("data-shown")
    ? query("[data-timeline-deck-position]")?.textContent
    : undefined;
/** Half the width the deck takes for a card it has not measured (jsdom). */
const FALLBACK_HALF = 150;
/** The stylesheet without its comments, for the rules a test names. */
const css = () => (deckCss as string).replace(/\/\*[\s\S]*?\*\//gu, "");
const stage = () => query("[data-timeline-deck-stage]") as HTMLElement;
const pointer = (
  type: string,
  clientX: number,
  timeStamp: number,
  clientY = 300,
) => {
  const event = new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    clientX,
    clientY,
    button: 0,
  });
  Object.defineProperty(event, "pointerId", { value: 7 });
  Object.defineProperty(event, "pointerType", { value: "touch" });
  Object.defineProperty(event, "timeStamp", { value: timeStamp });
  act(() => {
    front()!.dispatchEvent(event);
  });
};
const swipe = (dx: number, milliseconds: number, dy = 0) => {
  pointer("pointerdown", 200, 1000);
  pointer("pointermove", 200 + dx / 2, 1000 + milliseconds / 2, 300 + dy / 2);
  pointer("pointermove", 200 + dx, 1000 + milliseconds, 300 + dy);
  pointer("pointerup", 200 + dx, 1000 + milliseconds, 300 + dy);
};
const style = (card: HTMLElement | null | undefined, name: string) =>
  card?.style.getPropertyValue(name);
const indices = () => shownCards().map((card) => card.dataset.deckIndex);
const cardAt = (index: number) =>
  shownCards().find((card) => card.dataset.deckIndex === String(index));
/** Past the cards' move after a switch (280 ms and a margin). */
const settle = () =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 400));
  });

beforeEach(() => {
  for (const mock of Object.values(data)) mock.mockReset();
  data.readTimelinePosts.mockResolvedValue(page([], 0));
  authors.value = { checking: false, viewer: { id: viewerId } };
  actions = {
    upload: vi.fn(),
    openWork: vi.fn(),
    openCatalog: vi.fn(),
    signIn: vi.fn(),
    postsChanged: vi.fn(),
  };
  closed = vi.fn<() => void>();
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
  vi.unstubAllGlobals();
  act(() => root.unmount());
  container.remove();
  // Unmounting an open modal steps history back from a microtask.
  await Promise.resolve();
  await waitForHistory(() =>
    expect(window.history.state?.phase4Dialog).toBeUndefined(),
  );
});

describe("the open rule", () => {
  it("opens the deck for a Catalog page, posts or both, and the 词条卡 for neither", () => {
    const catalog = { catalogId: "catalog-one" as never };
    const none = { catalogId: null };
    expect(timelineDeckOpens(catalog, 0)).toBe(true);
    expect(timelineDeckOpens(none, 3)).toBe(true);
    expect(timelineDeckOpens(catalog, 3)).toBe(true);
    expect(timelineDeckOpens(none, 0)).toBe(false);
  });
});

describe("the cards", () => {
  it("leads with the Catalog card, then the posts in their list's order", async () => {
    data.readTimelinePosts.mockResolvedValue(page(works(1, 3), 3));
    render({ value: linked() });
    // The Catalog card is there before the posts arrive, and the cue's row
    // is held, hidden, so nothing moves when they do.
    expect(shownCards().map((card) => card.dataset.deckCard)).toEqual([
      "catalog",
    ]);
    expect(nav()).not.toBeNull();
    expect(nav()?.hasAttribute("data-shown")).toBe(false);
    await flush();
    expect(data.readTimelinePosts).toHaveBeenCalledWith(
      "row-yongping",
      1,
      6,
      expect.any(AbortSignal),
    );
    expect(shownCards().map((card) => card.dataset.deckCard)).toEqual([
      "catalog",
      "post",
      "post",
      "post",
    ]);
    expect(front()?.dataset.deckCard).toBe("catalog");
    // A screen reader hears where the card stands.
    expect(front()?.getAttribute("aria-label")).toBe(
      "永平碑，查看详情，第 1 张，共 4 张",
    );
    expect(front()?.textContent).toBe("永平碑查看详情");
    expect(front()?.querySelector("img")?.getAttribute("loading")).toBe("lazy");
    expect(position()).toBe("1 / 4");
    // The header names the entry, then 年代 · 地点 · 保管 on one quieter
    // line, one separator throughout, as a museum label.
    expect(query("[data-timeline-deck-header]")?.textContent).toBe(
      "北魏虚构永平碑511 · 永平四年 · 虚构东州 · 虚构碑林",
    );
    expect(query("[data-timeline-deck-meta]")?.textContent).toBe(
      "511 · 永平四年 · 虚构东州 · 虚构碑林",
    );
    expect(query("[data-timeline-deck-place]")?.textContent).toBe(
      "虚构东州 · 虚构碑林",
    );
  });

  it("leaves an absent 地点 or 保管 out of the header, and the line with both", async () => {
    render({ value: entry({ holder: null }) });
    await flush();
    expect(query("[data-timeline-deck-place]")?.textContent).toBe("虚构东州");
    act(() => root.unmount());
    root = createRoot(container);
    render({ value: entry({ holder: null, province: null }) });
    await flush();
    expect(query("[data-timeline-deck-place]")).toBeNull();
    expect(query("[data-timeline-deck-header]")?.textContent).toBe(
      "北魏虚构永平碑511 · 永平四年",
    );
    expect(query("[data-timeline-deck-meta]")?.textContent).toBe(
      "511 · 永平四年",
    );
  });

  it("leads the meta line with 地点 · 保管 when the entry has no 年代", async () => {
    render({
      value: entry({ precision: "dynasty", dateLabel: null, polity: null }),
    });
    await flush();
    expect(query("[data-timeline-deck-meta]")?.textContent).toBe(
      "虚构东州 · 虚构碑林",
    );
    act(() => root.unmount());
    root = createRoot(container);
    render({
      value: entry({
        precision: "dynasty",
        dateLabel: null,
        polity: null,
        province: null,
        holder: null,
      }),
    });
    await flush();
    expect(query("[data-timeline-deck-meta]")).toBeNull();
  });

  it("tints a post's cover until it paints, never the Catalog card's letterbox", async () => {
    data.readTimelinePosts.mockResolvedValue(
      page(
        [
          work(1, {
            media: [
              {
                id: `user-media-${"1".padStart(32, "0")}`,
                src: `/api/community/media/user-media-${"1".padStart(32, "0")}`,
                width: 600,
                height: 800,
                placeholderColor: "#a0a0a0",
              },
            ] as never,
          }),
        ],
        1,
      ),
    );
    render({
      value: linked({
        media: {
          alt: "虚构拓片",
          height: 800,
          id: "media-yongping" as never,
          kind: "image",
          src: "https://media.example.invalid/yongping.webp",
          width: 600,
          placeholderColor: "#808080",
        } as never,
      }),
    });
    await flush();
    // The Catalog card's rubbing shows whole (contain): no tint stays round it.
    expect(front()?.dataset.deckCard).toBe("catalog");
    expect(front()?.querySelector("img")?.style.backgroundColor).toBe("");
    const post = shownCards().find((card) => card.dataset.deckCard === "post");
    expect(post?.querySelector("img")?.style.backgroundColor).toBe(
      "rgb(160, 160, 160)",
    );
  });

  it("shows a Catalog card without an image as its title, said once", async () => {
    render({ value: linked({ media: null }) });
    await flush();
    expect(front()?.dataset.deckCard).toBe("catalog");
    expect(front()?.querySelector("img")).toBeNull();
    expect(front()?.textContent).toBe("永平碑查看详情");
  });

  it("starts with the posts when there is no Catalog page", async () => {
    data.readTimelinePosts.mockResolvedValue(
      page([work(1), work(2, { title: "", text: "访碑当日风雪" })], 2),
    );
    render();
    await flush();
    const cards = shownCards();
    expect(cards.map((card) => card.dataset.deckPost)).toEqual([
      workId(1),
      workId(2),
    ]);
    expect(cards[0]?.getAttribute("aria-label")).toBe(
      "访碑记1，作者1，第 1 张，共 2 张",
    );
    // A titled post without a cover or words reads as its title, once.
    expect(cards[0]?.textContent).toBe("访碑记1作者1");
    // An untitled post without a cover reads as its words, named as the grid.
    expect(cards[1]?.textContent).toBe("访碑当日风雪未命名作品作者2");
    expect(position()).toBe("1 / 2");
  });

  it("puts a titled post's words on its cover and its title under them", async () => {
    data.readTimelinePosts.mockResolvedValue(
      page([work(1, { text: "碑在山腰，字口尚清" })], 1),
    );
    render();
    await flush();
    expect(front()?.textContent).toBe("碑在山腰，字口尚清访碑记1作者1");
  });

  it("marks the viewer's own post that others cannot see", async () => {
    data.readTimelinePosts.mockResolvedValue(
      page(
        [
          work(1, {
            authorId: viewerId,
            canEdit: true,
            publiclyVisible: false,
            visibility: "self",
          } as Partial<UserWork>),
        ],
        1,
      ),
    );
    render();
    await flush();
    expect(
      front()?.querySelector("[data-deck-post-audience]")?.textContent,
    ).toBe("仅自己可见");
    expect(front()?.getAttribute("aria-label")).toBe(
      "访碑记1，作者1，仅自己可见",
    );
    // One card has no count.
    expect(position()).toBeUndefined();
  });

  it("opens Catalog Detail from the Catalog card and a work from a post card", async () => {
    data.readTimelinePosts.mockResolvedValue(page(works(1, 2), 2));
    render({ value: linked() });
    await flush();
    const catalog = front()!;
    click(catalog);
    expect(actions.openCatalog).toHaveBeenCalledWith(
      "catalog-yongping",
      catalog,
    );
    key(catalog, "ArrowRight");
    const post = front()!;
    expect(post.dataset.deckPost).toBe(workId(1));
    click(post);
    expect(actions.openWork).toHaveBeenCalledWith(workId(1), post);
  });

  it("brings a neighbour to the front on a tap instead of opening it", async () => {
    data.readTimelinePosts.mockResolvedValue(page(works(1, 3), 3));
    render();
    await flush();
    const neighbour = queryAll("button[data-deck-card]")[1]!;
    expect(neighbour.getAttribute("aria-hidden")).toBe("true");
    expect(neighbour.tabIndex).toBe(-1);
    click(neighbour);
    expect(actions.openWork).not.toHaveBeenCalled();
    expect(front()).toBe(neighbour);
    expect(front()?.hasAttribute("aria-hidden")).toBe(false);
    expect(position()).toBe("2 / 3");
  });

  it("shows the front card and two on each side, and keeps one more hidden under the outermost", async () => {
    data.readTimelinePosts.mockResolvedValue(page(works(1, 8), 8));
    render();
    await flush();
    expect(DECK_WINDOW).toBe(2);
    expect(DECK_EDGE).toBe(3);
    const hidden = () =>
      shownCards()
        .filter((card) => card.hasAttribute("data-deck-far"))
        .map((card) => card.dataset.deckIndex);
    expect(indices()).toEqual(["0", "1", "2", "3"]);
    // The edge card waits exactly under the outermost one that shows, out
    // of sight and of a tap's reach, so it slides out from under it.
    expect(hidden()).toEqual(["3"]);
    for (const name of [
      "--deck-x",
      "--deck-y",
      "--deck-rotate",
      "--deck-scale",
    ])
      expect(style(cardAt(3), name)).toBe(style(cardAt(2), name));
    expect(Number(cardAt(3)?.style.zIndex)).toBeLessThan(
      Number(cardAt(2)?.style.zIndex),
    );
    expect(css()).toMatch(
      /\.card\[data-deck-far\] \{\s*visibility: hidden;\s*pointer-events: none;/u,
    );
    // It hides only once its move under the outermost has ended.
    expect(css()).toMatch(
      /\.card\[data-deck-far\] \{[^}]*visibility 0s linear var\(--yoyi-duration-slow\);/u,
    );
    for (let at = 0; at < 4; at += 1) key(front(), "ArrowRight");
    // Until the move settles, the cards it left stay drawn.
    expect(indices()).toEqual(["0", "1", "2", "3", "4", "5", "6", "7"]);
    await settle();
    expect(indices()).toEqual(["1", "2", "3", "4", "5", "6", "7"]);
    expect(hidden()).toEqual(["1", "7"]);
    expect(front()?.hasAttribute("data-deck-far")).toBe(false);
  });

  it("keeps the window it left drawn through a jump of two, so no edge pops", async () => {
    data.readTimelinePosts.mockResolvedValue(page(works(1, 8), 8));
    render();
    await flush();
    for (let at = 0; at < 3; at += 1) key(front(), "ArrowRight");
    await settle();
    expect(indices()).toEqual(["0", "1", "2", "3", "4", "5", "6"]);
    const leaving = cardAt(1)!;
    expect(leaving.hasAttribute("data-deck-far")).toBe(false);
    // A tap on the card two to the right brings it to the front.
    click(cardAt(5));
    expect(front()?.dataset.deckIndex).toBe("5");
    // The card that showed two to the left is still the same node, gliding
    // under the new outermost card before it hides, and so is the edge.
    expect(leaving.isConnected).toBe(true);
    expect(cardAt(0)).toBeDefined();
    expect(leaving.hasAttribute("data-deck-far")).toBe(true);
    for (const name of [
      "--deck-x",
      "--deck-y",
      "--deck-rotate",
      "--deck-scale",
    ])
      expect(style(leaving, name)).toBe(style(cardAt(3), name));
    expect(indices()).toEqual(["0", "1", "2", "3", "4", "5", "6", "7"]);
    await settle();
    expect(leaving.isConnected).toBe(false);
    expect(indices()).toEqual(["2", "3", "4", "5", "6", "7"]);
  });

  it("holds the place with a placeholder card while the posts load", async () => {
    let answer: (value: ReturnType<typeof page>) => void = () => undefined;
    data.readTimelinePosts.mockReturnValue(
      new Promise((resolve) => {
        answer = resolve;
      }),
    );
    render();
    const placeholder = query("[data-deck-card='placeholder']");
    expect(placeholder?.getAttribute("aria-busy")).toBe("true");
    expect(placeholder?.textContent).toBe("");
    expect(placeholder?.hasAttribute("data-deck-current")).toBe(true);
    expect(css()).toMatch(
      /\.card\[data-deck-card="placeholder"\] \{[^}]*background: var\(--yoyi-color-background-muted\);/u,
    );
    answer(page(works(1, 2), 2));
    await flush();
    expect(query("[data-deck-card='placeholder']")).toBeNull();
    expect(shownCards()).toHaveLength(2);
  });

  it("says the caption on a plain card when the posts turn out empty", async () => {
    render();
    await flush();
    expect(shownCards()).toHaveLength(0);
    const plain = query("[data-deck-card='plain']");
    expect(plain?.textContent).toBe("永平碑发布后会出现在这个词条下。");
    expect(query("[data-timeline-deck]")?.textContent).not.toMatch(
      /暂无|还没有|没有|尚未|未收/u,
    );
    expect(position()).toBeUndefined();
  });

  it("says a failed read in its own words and reads again on 重试", async () => {
    data.readTimelinePosts.mockRejectedValueOnce(new Error("offline"));
    render({ value: linked() });
    await flush();
    expect(shownCards().map((card) => card.dataset.deckCard)).toEqual([
      "catalog",
    ]);
    expect(query("[data-timeline-deck]")?.textContent).toContain(
      "帖子载入失败",
    );
    // The failure hangs under the cue, out of the column's flow.
    expect(
      query("[data-timeline-deck-notes]")?.parentElement?.className,
    ).toMatch(/below/u);
    data.readTimelinePosts.mockResolvedValue(page(works(1, 1), 1));
    click(queryAll("button").find((button) => button.textContent === "重试"));
    await flush();
    expect(data.readTimelinePosts).toHaveBeenCalledTimes(2);
    expect(shownCards()).toHaveLength(2);
    expect(query("[data-timeline-deck]")?.textContent).not.toContain(
      "帖子载入失败",
    );
  });
});

describe("switching", () => {
  beforeEach(() => {
    data.readTimelinePosts.mockResolvedValue(page(works(1, 4), 4));
  });

  it("follows a horizontal swipe and moves one card", async () => {
    render();
    await flush();
    const first = front()!;
    pointer("pointerdown", 200, 1000);
    pointer("pointermove", 120, 1200);
    // The cards follow the finger with no transition, the front one opaque.
    expect(stage().hasAttribute("data-dragging")).toBe(true);
    expect(style(first, "--deck-x")).not.toBe("0%");
    expect(style(first, "--deck-rotate")).not.toBe("0deg");
    expect(style(first, "--deck-opacity")).toBe("1");
    expect(first.style.opacity).toBe("");
    expect(css()).toMatch(
      /\.stage\[data-dragging\] \.card,\s*\.stage\[data-dragging\] \.card::after,\s*\.stage\[data-dragging\] \.foot \{\s*transition: none;/u,
    );
    pointer("pointerup", 100, 1400);
    expect(stage().hasAttribute("data-dragging")).toBe(false);
    expect(front()?.dataset.deckIndex).toBe("1");
    expect(position()).toBe("2 / 4");
    // The release's click is not a tap on the card under it.
    click(front());
    expect(actions.openWork).not.toHaveBeenCalled();
    swipe(100, 400);
    expect(front()?.dataset.deckIndex).toBe("0");
  });

  it("moves on a quick flick and snaps back from a short, slow swipe", async () => {
    render();
    await flush();
    swipe(-20, 1000);
    expect(front()?.dataset.deckIndex).toBe("0");
    expect(style(front(), "--deck-x")).toBe("0%");
    swipe(-30, 20);
    expect(front()?.dataset.deckIndex).toBe("1");
  });

  it("leaves a vertical gesture to the page", async () => {
    render();
    await flush();
    swipe(-40, 400, 160);
    expect(front()?.dataset.deckIndex).toBe("0");
    expect(stage().hasAttribute("data-dragging")).toBe(false);
    expect(stage().getAttribute("class")).toMatch(/stage/u);
    // A pinch stays the page's too.
    expect(css()).toMatch(/\.stage \{[^}]*touch-action: pan-y pinch-zoom;/u);
  });

  it("stops at both ends", async () => {
    render();
    await flush();
    swipe(120, 400);
    expect(front()?.dataset.deckIndex).toBe("0");
    for (let at = 0; at < 5; at += 1) key(front(), "ArrowRight");
    expect(front()?.dataset.deckIndex).toBe("3");
    expect(position()).toBe("4 / 4");
  });

  it("switches with the arrows beside the cue at every width, never on a card", async () => {
    for (const layout of ["tablet", "wide"] as const) {
      render({ layout });
      await flush();
      expect(
        query("[data-deck-layout]")?.getAttribute("data-deck-layout"),
      ).toBe(layout);
      const arrows = queryAll("[data-timeline-deck-nav] button");
      const [previous, next] = arrows as [HTMLButtonElement, HTMLButtonElement];
      expect(arrows.map((arrow) => arrow.getAttribute("aria-label"))).toEqual([
        "上一张",
        "下一张",
      ]);
      // Round paper buttons on the paper veil, not glass.
      for (const arrow of arrows)
        expect(arrow.classList.contains("yoyi-functional-glass")).toBe(false);
      expect(css()).toMatch(
        /\.arrow,\s*\.close \{[^}]*border: 1px solid var\(--yoyi-color-border-subtle\);[^}]*background: var\(--yoyi-color-background-elevated\);[^}]*box-shadow: var\(--yoyi-shadow-subtle\);/u,
      );
      expect(previous.getAttribute("aria-disabled")).toBe("true");
      expect(previous.disabled).toBe(false);
      click(next);
      click(next);
      expect(front()?.dataset.deckIndex).toBe("2");
      click(previous);
      expect(front()?.dataset.deckIndex).toBe("1");
      expect(previous.hasAttribute("aria-disabled")).toBe(false);
      act(() => root.unmount());
      await Promise.resolve();
      await waitForHistory(() =>
        expect(window.history.state?.phase4Dialog).toBeUndefined(),
      );
      root = createRoot(container);
    }
    // Their row is under the stage, out of the column's cards: no arrow is
    // placed over the fan on any layout.
    expect(css()).not.toMatch(/\.arrow[^{]*\{[^}]*position: absolute;/u);
    expect(css()).not.toMatch(/\.arrow \{[^}]*display: none;/u);
    expect(css()).toMatch(/\.below \{[^}]*margin-top: var\(--deck-cue-gap\);/u);
  });

  it("keeps the arrows beside the cue on phone, and says each card's place", async () => {
    render();
    await flush();
    const deck = query("[data-timeline-deck] > [role='group']");
    expect(deck?.getAttribute("aria-roledescription")).toBe("卡片组");
    const arrows = queryAll("[data-timeline-deck-nav] button");
    expect(arrows.map((arrow) => arrow.getAttribute("aria-label"))).toEqual([
      "上一张",
      "下一张",
    ]);
    // Reachable: no hidden state, nothing taken out of the tab order.
    for (const arrow of arrows) {
      expect(arrow.closest("[aria-hidden='true']")).toBeNull();
      expect(arrow.tabIndex).toBe(0);
    }
    expect(nav()?.hasAttribute("data-shown")).toBe(true);
    expect(front()?.getAttribute("aria-label")).toBe(
      "访碑记1，作者1，第 1 张，共 4 张",
    );
    click(arrows[1]);
    expect(front()?.getAttribute("aria-label")).toBe(
      "访碑记2，作者2，第 2 张，共 4 张",
    );
    click(arrows[0]);
    expect(front()?.dataset.deckIndex).toBe("0");
    // Only the cue row hides them, and only while there is one card.
    expect(css()).toMatch(/\.nav \{[^}]*visibility: hidden;/u);
    expect(css()).toMatch(/\.nav\[data-shown\] \{\s*visibility: visible;/u);
  });

  it("keeps the focus on an arrow at its end, and ← works from anywhere", async () => {
    render();
    await flush();
    const next = query("[aria-label='下一张']") as HTMLButtonElement;
    act(() => next.focus());
    for (let at = 0; at < 5; at += 1) click(next);
    expect(front()?.dataset.deckIndex).toBe("3");
    expect(next.getAttribute("aria-disabled")).toBe("true");
    expect(document.activeElement).toBe(next);
    key(next, "ArrowLeft");
    expect(front()?.dataset.deckIndex).toBe("2");
    expect(document.activeElement).toBe(next);
    // The dialog itself, and the close button, take the keys too.
    key(query("dialog"), "ArrowLeft");
    expect(front()?.dataset.deckIndex).toBe("1");
    key(query("[aria-label='关闭']"), "ArrowRight");
    expect(front()?.dataset.deckIndex).toBe("2");
  });

  it("switches with ←/→ and keeps the focus on the card in front", async () => {
    render();
    await flush();
    // The keys work from anywhere in the deck, the title included.
    key(document.activeElement, "ArrowRight");
    expect(front()?.dataset.deckIndex).toBe("1");
    key(document.activeElement, "ArrowLeft");
    act(() => front()!.focus());
    key(front(), "ArrowRight");
    expect(front()?.dataset.deckIndex).toBe("1");
    expect(document.activeElement).toBe(front());
    key(front(), "ArrowLeft");
    expect(front()?.dataset.deckIndex).toBe("0");
    expect(document.activeElement).toBe(front());
  });

  it("fans the neighbours out around a pivot, smaller and dimmer, never see-through", () => {
    const center = timelineDeckPose(0, false);
    const right = timelineDeckPose(1, false);
    const left = timelineDeckPose(-1, false);
    const far = timelineDeckPose(2, false);
    const edge = timelineDeckPose(DECK_EDGE, false);
    expect(center).toMatchObject({
      x: 0,
      y: 0,
      rotate: 0,
      scale: 1,
      dim: 0,
      opacity: 1,
      far: false,
    });
    expect(right.rotate).toBeGreaterThan(0);
    expect(left.rotate).toBe(-right.rotate);
    expect(left.y).toBe(right.y);
    expect(right.x).toBeGreaterThan(0);
    expect(right.scale).toBeLessThan(1);
    expect(far.scale).toBeLessThan(right.scale);
    expect(right.dim).toBeGreaterThan(0);
    expect(far.dim).toBeGreaterThan(right.dim);
    // Every card of the fan is opaque; only a layer inside it dims.
    for (const pose of [center, right, left, far, edge])
      expect(pose.opacity).toBe(1);
    // The edge card waits under the outermost one that shows, hidden.
    expect(edge).toMatchObject({
      x: far.x,
      y: far.y,
      rotate: far.rotate,
      scale: far.scale,
      far: true,
    });
    expect(edge.layer).toBeLessThan(far.layer);
    expect(center.layer).toBeGreaterThan(right.layer);
    expect(css()).toMatch(/transform-origin: 50% 220%;/u);
    expect(css()).toMatch(
      /transform: translate\(var\(--deck-x, 0%\), var\(--deck-y, 0%\)\)\s*rotate\(var\(--deck-rotate, 0deg\)\) scale\(var\(--deck-scale, 1\)\);/u,
    );
    const card = /\n\.card \{([^}]*)\}/u.exec(css())![1]!;
    expect(card).not.toMatch(/opacity/u);
    expect(card).toMatch(
      /background: var\(--yoyi-color-background-elevated\);/u,
    );
    // A neighbour recedes under a layer of the page's paper.
    expect(css()).toMatch(
      /\.card::after \{[^}]*background: color-mix\(\s*in srgb,\s*var\(--yoyi-color-background-page\) 82%,\s*transparent\s*\);[^}]*opacity: var\(--deck-dim, 0\);/u,
    );
    // Its label fades with the pose: the front card's reads, a neighbour's
    // waits, and the coming card's arrives with the drag.
    expect(css()).toMatch(
      /\.foot \{[^}]*height: var\(--deck-caption\);[^}]*opacity: calc\(1 - var\(--deck-dim, 0\) \* 2\);/u,
    );
    // Only reduced motion fades whole cards: a cross-fade, the new front
    // card fading in over the old one, which fades after it.
    expect(css().match(/opacity: var\(--deck-opacity/gu)).toHaveLength(1);
    expect(css()).toMatch(
      /\.root\[data-deck-motion="reduced"\] \.card \{\s*opacity: var\(--deck-opacity, 1\);/u,
    );
    expect(css()).toMatch(
      /\.root\[data-deck-motion="reduced"\] \.card:not\(\[data-deck-current\]\) \{[^}]*transition-delay: var\(--yoyi-duration-fast\);/u,
    );
  });

  it.each([
    // In card heights over width: a 3:4 window in its mat over the caption
    // is 1.42 (tablet) to 1.51 (phone), 1.6 at the 160px floor; none dips,
    // and a turned top rises under 3% of a card (14px of a 480px tablet
    // card under a 20px gap; 11px of a short phone's card under 12px).
    ["tablet", 1 / 1.42, 1.0001, 0.03],
    ["phone", 1 / 1.51, 1.0001, 0.03],
    ["floor", 1 / 1.6, 1.0001, 0.03],
    // A very short window hides the label (about 1.25) and its card is under
    // 200px tall: a corner may dip 1.2% (some 2px) and a top rise 3.5%
    // (some 7px), both inside the 8px gaps above the cue's row and under the
    // header.
    ["very short", 1 / 1.25, 1.012, 0.035],
  ])(
    "lifts every turned card so that none reaches the cue's row under the stage (%s card)",
    (_, width, lowest, rise) => {
      // The pivot is 220% down (transform-origin).
      const pivot = { x: width / 2, y: 2.2 };
      const corners = (offset: number) => {
        const pose = timelineDeckPose(offset, false);
        const turn = (pose.rotate * Math.PI) / 180;
        return [
          [0, 0],
          [width, 0],
          [0, 1],
          [width, 1],
        ].map(([x, y]) => {
          const dx = pose.scale * (x! - pivot.x);
          const dy = pose.scale * (y! - pivot.y);
          return {
            x:
              pivot.x +
              (pose.x / 100) * width +
              dx * Math.cos(turn) -
              dy * Math.sin(turn),
            y:
              pivot.y +
              pose.y / 100 +
              dx * Math.sin(turn) +
              dy * Math.cos(turn),
          };
        });
      };
      for (let offset = -DECK_EDGE; offset <= DECK_EDGE; offset += 0.125) {
        const points = corners(offset);
        // The stage is the front card's box: its bottom line is 1.
        expect(Math.max(...points.map((point) => point.y))).toBeLessThanOrEqual(
          lowest,
        );
        // And a turned card's top stays near the stage's top, inside the gap
        // under the header.
        expect(Math.min(...points.map((point) => point.y))).toBeGreaterThan(
          -rise,
        );
      }
      expect(css()).toMatch(
        /\.stage \{[^}]*height: var\(--deck-card-height\);/u,
      );
    },
  );

  it("brings the new front card over the old one", async () => {
    render();
    await flush();
    const [first, second] = shownCards();
    const layer = (card: HTMLElement | undefined) => Number(card?.style.zIndex);
    expect(layer(first)).toBeGreaterThan(layer(second));
    // Halfway through a drag the incoming card passes over the leaving one.
    pointer("pointerdown", 200, 1000);
    pointer("pointermove", 200 - FALLBACK_HALF - 30, 1200);
    expect(layer(second)).toBeGreaterThan(layer(first));
    pointer("pointerup", 200 - FALLBACK_HALF - 30, 1400);
    expect(front()).toBe(second);
    expect(layer(second)).toBeGreaterThan(layer(first));
    // A key switch raises it at once, before it travels.
    key(front(), "ArrowLeft");
    expect(front()).toBe(first);
    expect(layer(first)).toBeGreaterThan(layer(second));
  });
});

describe("reduced motion", () => {
  it("neither turns nor travels: only the front card shows, and a swipe cross-fades", async () => {
    vi.stubGlobal(
      "matchMedia",
      vi.fn((media: string) => ({
        matches: media === "(prefers-reduced-motion: reduce)",
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
      })),
    );
    data.readTimelinePosts.mockResolvedValue(page(works(1, 3), 3));
    render();
    await flush();
    expect(query("[data-deck-layout]")?.getAttribute("data-deck-motion")).toBe(
      "reduced",
    );
    const [first, second] = shownCards();
    expect(style(second!, "--deck-rotate")).toBe("0deg");
    expect(style(second!, "--deck-x")).toBe("0%");
    expect(style(second!, "--deck-opacity")).toBe("0");
    pointer("pointerdown", 200, 1000);
    pointer("pointermove", 100, 1200);
    expect(style(first!, "--deck-x")).toBe("0%");
    pointer("pointerup", 100, 1400);
    expect(front()).toBe(second);
    expect(style(second!, "--deck-opacity")).toBe("1");
    const block =
      /@media \(prefers-reduced-motion: reduce\) \{([\s\S]*)\}\s*$/u.exec(
        css(),
      )![1]!;
    expect(block).toMatch(/\.card \{\s*transform: none;/u);
    expect(block).toMatch(
      /\.card:not\(\[data-deck-current\]\) \{\s*opacity: 0;/u,
    );
  });
});

describe("paging", () => {
  it("reads the next pages while two cards are still ahead", async () => {
    const all = works(1, 40);
    data.readTimelinePosts.mockImplementation(
      async (_entry: string, at: number, size: number) =>
        page(all.slice((at - 1) * size, at * size), all.length, at),
    );
    render();
    await flush();
    expect(position()).toBe("1 / 40");
    expect(shownCards().length).toBe(DECK_EDGE + 1);
    for (let at = 0; at < 3; at += 1) key(front(), "ArrowRight");
    await flush();
    // The first full page replaces the preview it starts with.
    expect(data.readTimelinePosts).toHaveBeenLastCalledWith(
      "row-yongping",
      1,
      18,
    );
    expect(position()).toBe("4 / 40");
    for (let at = 0; at < 13; at += 1) key(front(), "ArrowRight");
    await flush();
    expect(data.readTimelinePosts).toHaveBeenLastCalledWith(
      "row-yongping",
      2,
      18,
    );
    for (let at = 0; at < 30; at += 1) key(front(), "ArrowRight");
    await flush();
    expect(data.readTimelinePosts).toHaveBeenLastCalledWith(
      "row-yongping",
      3,
      18,
    );
    for (let at = 0; at < 10; at += 1) key(front(), "ArrowRight");
    await flush();
    expect(front()?.dataset.deckPost).toBe(workId(40));
    expect(position()).toBe("40 / 40");
    expect(data.readTimelinePosts).toHaveBeenCalledTimes(4);
  });
});

describe("paging past what the pages hold", () => {
  it("stops when a page adds nothing, whatever the total says", async () => {
    data.readTimelinePosts.mockResolvedValue(page(works(1, 6), 40));
    render();
    await flush();
    for (let at = 0; at < 5; at += 1) {
      key(front(), "ArrowRight");
      await flush();
    }
    expect(front()?.dataset.deckPost).toBe(workId(6));
    expect(data.readTimelinePosts).toHaveBeenCalledTimes(2);
  });
});

describe("the upload button", () => {
  const upload = () => query("[data-timeline-deck-upload]") as HTMLElement;

  it("opens its two choices and starts a new post from 上传新帖子", async () => {
    render({ value: linked() });
    await flush();
    expect(upload().getAttribute("aria-label")).toBe("上传");
    expect(upload().getAttribute("aria-expanded")).toBe("false");
    click(upload());
    expect(upload().getAttribute("aria-expanded")).toBe("true");
    const menu = query("[role='menu']");
    expect(
      [...(menu?.querySelectorAll("[role='menuitem']") ?? [])].map(
        (item) => item.textContent,
      ),
    ).toEqual(["上传新帖子", "关联我发过的帖子"]);
    expect(document.activeElement?.textContent).toBe("上传新帖子");
    // The menu is a step of the deck's history.
    expect(window.history.state?.phase4DialogDepth).toBe(1);
    click(query("[data-timeline-deck-new]"));
    expect(actions.upload).toHaveBeenCalledWith(upload());
    // The menu goes while the host closes the deck over both steps at once.
    expect(query("[role='menu']")).toBeNull();
    expect(upload().getAttribute("aria-expanded")).toBe("false");
    expect(window.history.state?.phase4DialogDepth).toBe(1);
  });

  it("closes only the menu on Back, back to the button", async () => {
    render();
    await flush();
    click(upload());
    expect(query("[role='menu']")).not.toBeNull();
    window.history.back();
    await waitForHistory(() => expect(query("[role='menu']")).toBeNull());
    expect(query("[data-timeline-deck]")).not.toBeNull();
    expect(closed).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(upload());
    expect(window.history.state?.phase4DialogDepth).toBe(0);
  });

  it("closes the menu on Escape before the deck, back to the button", async () => {
    render();
    await flush();
    click(upload());
    key(query("[data-timeline-deck-new]"), "Escape");
    expect(query("[role='menu']")).toBeNull();
    expect(document.activeElement).toBe(upload());
    // Its history step goes with it; the deck's stays.
    await waitForHistory(() =>
      expect(window.history.state?.phase4DialogDepth).toBe(0),
    );
    expect(closed).not.toHaveBeenCalled();
  });

  it("closes only the menu on a tap on its veil, × included, back to the button", async () => {
    render();
    await flush();
    click(upload());
    // The veil is the catcher in the cue's row: hidden from assistive
    // technology, above the cards and ×, under the menu and the button.
    const catcher = upload().parentElement?.querySelector(
      "button[aria-hidden='true'][tabindex='-1']",
    ) as HTMLElement;
    expect(catcher).not.toBeNull();
    expect(catcher.contains(query("[role='menu']"))).toBe(false);
    expect(css()).toMatch(/\n\.menu \{[^}]*z-index: 3;/u);
    expect(css()).toMatch(/\n\.upload \{[^}]*z-index: 3;/u);
    click(catcher);
    expect(query("[role='menu']")).toBeNull();
    expect(query("[data-timeline-deck]")).not.toBeNull();
    expect(closed).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(upload());
    await waitForHistory(() =>
      expect(window.history.state?.phase4DialogDepth).toBe(0),
    );
  });

  it("moves with Home and End, and closes on Tab back to the button", async () => {
    data.readTimelinePosts.mockResolvedValue(page(works(1, 4), 4));
    render();
    await flush();
    click(upload());
    const first = query("[data-timeline-deck-new]");
    const last = query("[data-timeline-deck-attach]");
    key(first, "End");
    expect(document.activeElement).toBe(last);
    key(last, "Home");
    expect(document.activeElement).toBe(first);
    key(first, "ArrowUp");
    expect(document.activeElement).toBe(last);
    // The menu's ←/→ are its own, never a card switch.
    key(last, "ArrowRight");
    expect(position()).toBe("1 / 4");
    key(last, "Tab");
    expect(query("[role='menu']")).toBeNull();
    expect(document.activeElement).toBe(upload());
  });

  it("attaches one of the reader's posts in a sheet over the deck", async () => {
    data.readTimelinePosts.mockResolvedValue(page(works(1, 1), 1));
    data.readOwnWorks.mockResolvedValue(
      page([work(9, { authorId: viewerId })], 1),
    );
    data.readContentTimelineEntry.mockResolvedValue(null);
    data.setWorkTimelineEntry.mockResolvedValue({
      workId: workId(9),
      entryId: "row-yongping",
    });
    render();
    await flush();
    click(upload());
    click(query("[data-timeline-deck-attach]"));
    await flush();
    const sheet = query("[data-timeline-deck-attach-sheet]");
    expect(
      sheet?.querySelector("[data-timeline-attach-picker]"),
    ).not.toBeNull();
    // The deck under the sheet is out of reach, and Back has a step for it.
    expect(
      query("[data-timeline-deck] > [role='group']")?.hasAttribute("inert"),
    ).toBe(true);
    expect(window.history.state?.phase4DialogDepth).toBe(1);
    // Neither the deck's × nor its 「上传」 shows beside or under the sheet.
    expect(query("[data-timeline-deck-close]")).toBeNull();
    expect(query("[data-timeline-deck-upload]")).toBeNull();
    data.readTimelinePosts.mockResolvedValue(
      page([work(9, { authorId: viewerId }), work(1)], 2),
    );
    click(sheet?.querySelector(`[data-timeline-attach-work="${workId(9)}"]`));
    click(sheet?.querySelector("[data-timeline-attach-confirm]"));
    await flush();
    expect(data.setWorkTimelineEntry).toHaveBeenCalledWith(workId(9), {
      requestId: expect.any(String),
      entryId: "row-yongping",
    });
    expect(actions.postsChanged).toHaveBeenCalledOnce();
    await waitForHistory(() =>
      expect(query("[data-timeline-deck-attach-sheet]")).toBeNull(),
    );
    await flush();
    expect(closed).not.toHaveBeenCalled();
    expect(query("[data-timeline-deck]")?.textContent).toContain(
      "已关联到这个词条",
    );
    expect(position()).toBe("1 / 2");
    // Both come back with the sheet gone, the focus on 「上传」.
    expect(query("[data-timeline-deck-close]")).not.toBeNull();
    expect(document.activeElement).toBe(upload());
  });

  it("closes only the attach sheet on Back", async () => {
    data.readOwnWorks.mockResolvedValue(page([], 0));
    render();
    await flush();
    click(upload());
    click(query("[data-timeline-deck-attach]"));
    await flush();
    expect(query("[data-timeline-deck-attach-sheet]")).not.toBeNull();
    window.history.back();
    await waitForHistory(() =>
      expect(query("[data-timeline-deck-attach-sheet]")).toBeNull(),
    );
    expect(query("[data-timeline-deck]")).not.toBeNull();
    expect(query("[data-timeline-deck-close]")).not.toBeNull();
    expect(document.activeElement).toBe(upload());
    expect(closed).not.toHaveBeenCalled();
  });

  it("sends a guest to sign-in from either choice", async () => {
    authors.value = { checking: false, viewer: null };
    render();
    await flush();
    click(upload());
    click(query("[data-timeline-deck-attach]"));
    expect(actions.signIn).toHaveBeenCalledWith(upload());
    expect(query("[data-timeline-deck-attach-sheet]")).toBeNull();
    // 上传新帖子 goes through the host's editor opener, which signs a guest in.
    click(upload());
    click(query("[data-timeline-deck-new]"));
    expect(actions.upload).toHaveBeenCalledWith(upload());
  });

  it("is not there when browse-only", async () => {
    data.readTimelinePosts.mockResolvedValue(page(works(1, 2), 2));
    render({ browseOnly: true });
    await flush();
    expect(query("[data-timeline-deck-upload]")).toBeNull();
    expect(shownCards()).toHaveLength(2);
  });

  it("ends the cue's row on phone whatever the title's length, keeps the corner elsewhere, and opens above it", async () => {
    render();
    await flush();
    // In the cue's own row, beside the arrows, so a two-line title moves
    // them together.
    const nav = query("[data-timeline-deck-nav]")!;
    expect(nav.parentElement?.contains(upload())).toBe(true);
    expect(nav.contains(upload())).toBe(false);
    expect(css()).toMatch(
      /\.root\[data-deck-layout="phone"\] \.upload \{\s*position: absolute;\s*top: calc\(\(var\(--deck-cue\) - var\(--deck-button\)\) \/ 2\);\s*right: 0;\s*bottom: auto;/u,
    );
    // Its menu opens above the button, so above the cue's row.
    expect(css()).toMatch(
      /\.root\[data-deck-layout="phone"\] \.menu \{\s*position: absolute;\s*right: 0;\s*bottom: calc\(\s*100% - \(var\(--deck-cue\) - var\(--deck-button\)\) \/ 2 \+ var\(--yoyi-space-3\)\s*\);/u,
    );
    // Tablet and wide keep the window's corner, fixed to the deck's layer.
    expect(css()).toMatch(
      /\.upload \{\s*position: fixed;[^}]*right: var\(--deck-button-end\);\s*bottom: var\(--deck-button-bottom\);/u,
    );
    expect(css()).toMatch(
      /\.menu \{\s*position: fixed;[^}]*bottom: calc\(\s*var\(--deck-button-bottom\) \+ var\(--deck-button\) \+ var\(--yoyi-space-3\)\s*\);/u,
    );
    expect(css()).toMatch(
      /--deck-button-bottom: calc\(var\(--yoyi-space-7\) \+ env\(safe-area-inset-bottom\)\);/u,
    );
    // While it is open a light paper veil covers the deck, the close button
    // included: a tap off the menu closes the menu first.
    expect(css()).toMatch(
      /\.menuCatcher \{\s*position: fixed;\s*z-index: 1;\s*inset: 0;[^}]*background: color-mix\(\s*in srgb,\s*var\(--yoyi-color-background-page\) 55%,/u,
    );
    expect(css()).toMatch(/\.below \{[^}]*z-index: 3;/u);
    expect(css()).toMatch(/\n\.close \{[^}]*z-index: 2;/u);
  });
});

describe("the modal", () => {
  it("frosts the page to paper through the shared scrim, its veil from the shared UI", async () => {
    render();
    await flush();
    const dialog = query("dialog") as HTMLElement;
    expect(dialog.classList.contains("yoyi-blur-scrim")).toBe(true);
    expect(dialog.classList.contains("yoyi-blur-scrim-paper")).toBe(true);
    // The blur, its tint and their fallbacks live in packages/ui only: the
    // deck never redefines the overlay or draws a blur of its own.
    expect(deckCss as string).not.toMatch(/backdrop-filter\s*:/iu);
    expect(deckCss as string).not.toMatch(/--yoyi-(?:blur|material-glass)-/u);
    expect(deckCss as string).not.toMatch(/--yoyi-color-overlay\s*:/u);
    // The dialog's own page color gives way to the scrim's veil.
    expect(css()).toMatch(/\.dialog\.dialog \{[^}]*background: transparent;/u);
    // The round buttons are paper, not glass; the words are ink, unshadowed.
    expect(
      query("[data-timeline-deck-close]")?.classList.contains(
        "yoyi-functional-glass",
      ),
    ).toBe(false);
    expect(css()).not.toMatch(/text-shadow/u);
  });

  it("keeps the header's and the cue's ink at 4.5:1 over the darkest and the lightest page, in both themes", () => {
    // A soft halo of the page's paper behind the words.
    expect(css()).toMatch(
      /\.headerText::before,\s*\.position::before \{[^}]*background: color-mix\(\s*in srgb,\s*var\(--yoyi-color-background-page\) 70%,\s*transparent\s*\);[^}]*box-shadow: 0 0 var\(--yoyi-space-6\) var\(--yoyi-space-3\)\s*color-mix\(in srgb, var\(--yoyi-color-background-page\) 70%, transparent\);/u,
    );
    expect(css()).toMatch(
      /\.title \{[^}]*color: var\(--yoyi-color-text-primary\);/u,
    );
    expect(css()).toMatch(
      /\.meta \{[^}]*color: var\(--yoyi-color-text-secondary\);/u,
    );
    expect(css()).toMatch(
      /\.position \{[^}]*color: var\(--yoyi-color-text-secondary\);/u,
    );
    expect(css()).not.toMatch(
      /\.(?:meta|title|header|position) \{[^}]*opacity/u,
    );
    // The light theme's values come first in the tokens, the dark second.
    const colors = (name: string) =>
      [
        ...(themeCss as string).matchAll(
          new RegExp(`--yoyi-color-${name}: #([0-9a-f]{6});`, "giu"),
        ),
      ]
        .slice(0, 2)
        .map((match) =>
          [0, 2, 4].map((at) =>
            Number.parseInt(match[1]!.slice(at, at + 2), 16),
          ),
        );
    const pages = colors("background-page");
    const secondary = colors("text-secondary");
    const primary = colors("text-primary");
    const mix = (
      top: readonly number[],
      share: number,
      base: readonly number[],
    ) => top.map((channel, at) => channel * share + base[at]! * (1 - share));
    const luminance = (rgb: readonly number[]) => {
      const [r, g, b] = rgb.map((channel) => {
        const c = channel / 255;
        return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
      });
      return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
    };
    const contrast = (a: readonly number[], b: readonly number[]) => {
      const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
      return (hi! + 0.05) / (lo! + 0.05);
    };
    for (const theme of [0, 1]) {
      const page = pages[theme]!;
      // The worst page behind the words, black or white, under the
      // scrim's paper veil (76%, packages/ui), then the halo (70%).
      for (const behind of [
        [0, 0, 0],
        [255, 255, 255],
      ]) {
        const under = mix(page, 0.7, mix(page, 0.76, behind));
        expect(contrast(secondary[theme]!, under)).toBeGreaterThanOrEqual(4.5);
        expect(contrast(primary[theme]!, under)).toBeGreaterThanOrEqual(4.5);
      }
    }
  });

  it("holds two-line titles and metas, stands at the optical centre, fits every window, and keeps a phone card readable", () => {
    // From the top edge: the lead above the header places the group.
    expect(css()).toMatch(/\.deck \{[^}]*justify-content: flex-start;/u);
    expect(css()).toMatch(/\.header \{[^}]*margin-top: var\(--deck-lead\);/u);
    // The header shares the close button's line, clear of it; the title and
    // the meta take two lines at most; × sits on the title's first line, on
    // tablet in the window's corner.
    expect(css()).toMatch(
      /\.header \{[^}]*padding-inline: calc\(var\(--deck-close\) \+ var\(--yoyi-space-5\)\);/u,
    );
    expect(css()).toMatch(/\.title \{[^}]*-webkit-line-clamp: 2;/u);
    expect(css()).toMatch(/\.meta \{[^}]*-webkit-line-clamp: 2;/u);
    expect(css()).toMatch(
      /\n\.close \{[^}]*top: calc\(\s*var\(--deck-top\) \+ var\(--deck-lead\) \+\s*\(var\(--deck-title-line\) - var\(--deck-close\)\) \/ 2\s*\);/u,
    );
    expect(css()).toMatch(
      /\.root\[data-deck-layout="tablet"\] \.close \{\s*top: calc\(var\(--deck-top\) \+ \(var\(--deck-title-line\) - var\(--deck-close\)\) \/ 2\);/u,
    );
    // The room is kept for a second title line and a second meta line; the
    // card is a 3:4 window in its mat over the caption; the lead never takes
    // the reserve.
    expect(css()).toMatch(
      /--deck-header-line: calc\(\s*var\(--deck-title-line\) \+ var\(--yoyi-space-2\) \+ var\(--deck-meta-line\)\s*\);/u,
    );
    expect(css()).toMatch(
      /--deck-header-reserve: calc\(var\(--deck-title-line\) \+ var\(--deck-meta-line\)\);/u,
    );
    expect(css()).toMatch(
      /--deck-header: calc\(var\(--deck-header-line\) \+ var\(--deck-header-reserve\)\);/u,
    );
    expect(css()).toMatch(
      /--deck-room: calc\(\s*var\(--deck-viewport\) - var\(--deck-top\) - var\(--deck-bottom\) -\s*var\(--deck-header\) - var\(--deck-gap\) - var\(--deck-cue-gap\) -\s*var\(--deck-cue\)\s*\);/u,
    );
    expect(css()).toMatch(
      /--deck-fit: calc\(\s*\(var\(--deck-room\) - var\(--deck-mat\) - var\(--deck-caption\)\) \* 3 \/ 4 \+ 2 \*\s*var\(--deck-mat\)\s*\);/u,
    );
    expect(css()).toMatch(
      /--deck-card-width: max\(\s*var\(--deck-card-min\),\s*min\(76vw, 340px, var\(--deck-fit\)\)\s*\);/u,
    );
    expect(css()).toMatch(
      /--deck-card-height: calc\(\s*var\(--deck-mat\) \+ \(var\(--deck-card-width\) - 2 \* var\(--deck-mat\)\) \* 4 \/ 3 \+\s*var\(--deck-caption\)\s*\);/u,
    );
    expect(css()).toMatch(
      /--deck-spare: max\(\s*0px,\s*var\(--deck-room\) \+ var\(--deck-header\) - var\(--deck-header-line\) -\s*var\(--deck-card-height\)\s*\);/u,
    );
    expect(css()).toMatch(
      /--deck-lead: clamp\(\s*0px,\s*var\(--deck-spare\) \* var\(--deck-lead-share\),\s*var\(--deck-spare\) - var\(--deck-header-reserve\)\s*\);/u,
    );
    expect(css()).toMatch(/--deck-lead-share: 0\.25;/u);
    // A failure or a notice stands over the cards' lower edge at every width.
    expect(css()).toMatch(
      /\n\.notes \{[^}]*bottom: calc\(100% \+ var\(--yoyi-space-3\)\);/u,
    );
    expect(css()).not.toMatch(
      /\.root:not\(\[data-deck-layout="phone"\]\) \.notes/u,
    );
    const token = (name: string) =>
      Number(
        new RegExp(`--yoyi-${name}: (\\d+)px;`, "u").exec(
          themeCss as string,
        )![1],
      );
    // The deck's own values, read from its first (the base) declaration.
    const own = (name: string) =>
      Number(new RegExp(`--deck-${name}: (\\d+)px;`, "u").exec(css())![1]);
    const ownToken = (name: string) =>
      token(
        new RegExp(`--deck-${name}: var\\(--yoyi-([a-z0-9-]+)\\);`, "u").exec(
          css(),
        )![1]!,
      );
    expect(css()).toMatch(
      /--deck-top: calc\(\s*max\(var\(--yoyi-space-4\), env\(safe-area-inset-top\)\) \+ var\(--yoyi-space-4\)\s*\);/u,
    );
    expect(css()).toMatch(
      /--deck-bottom: calc\(var\(--yoyi-space-5\) \+ env\(safe-area-inset-bottom\)\);/u,
    );
    // A short phone page tightens the top and the gaps.
    expect(css()).toMatch(
      /@media \(max-height: 40rem\) \{\s*\.root \{\s*--deck-top: calc\(\s*max\(var\(--yoyi-space-4\), env\(safe-area-inset-top\)\) \+ var\(--yoyi-space-2\)\s*\);\s*--deck-gap: var\(--yoyi-space-4\);\s*--deck-cue-gap: var\(--yoyi-space-4\);/u,
    );
    // A very short window (a phone held sideways) keeps the whole column.
    expect(css()).toMatch(
      /@media \(max-height: 28rem\) \{\s*\.root \{\s*--deck-top: calc\(\s*max\(var\(--yoyi-space-3\), env\(safe-area-inset-top\)\) \+ var\(--yoyi-space-2\)\s*\);\s*--deck-bottom: calc\(var\(--yoyi-space-3\) \+ env\(safe-area-inset-bottom\)\);\s*--deck-header-reserve: 0px;\s*--deck-gap: var\(--yoyi-space-3\);\s*--deck-cue-gap: var\(--yoyi-space-3\);\s*--deck-cue: 44px;\s*--deck-mat: var\(--yoyi-space-3\);\s*--deck-caption: 0px;\s*--deck-card-min: 80px;\s*\}\s*\.root \.title,\s*\.root \.meta \{\s*-webkit-line-clamp: 1;\s*\}\s*\.root \.foot \{\s*display: none;/u,
    );
    const titleLine = own("title-line");
    const metaLine = own("meta-line");
    const headerLine = titleLine + token("space-2") + metaLine;
    const geometry = (width: number, height: number, lines: 1 | 2) => {
      const veryShort = height <= 448;
      const short = height <= 640;
      const top =
        token(veryShort ? "space-3" : "space-4") +
        token(short ? "space-2" : "space-4");
      // --deck-bottom is pinned above: space-5 (space-3 very short).
      const bottom = token(veryShort ? "space-3" : "space-5");
      const gap = veryShort
        ? token("space-3")
        : short
          ? token("space-4")
          : ownToken("gap");
      const cue = veryShort ? 44 : own("cue");
      const mat = veryShort ? token("space-3") : ownToken("mat");
      const caption = veryShort ? 0 : own("caption");
      const min = veryShort ? 80 : own("card-min");
      const reserve = veryShort ? 0 : titleLine + metaLine;
      const header = headerLine + reserve;
      const room = height - top - bottom - header - 2 * gap - cue;
      const fit = (room - mat - caption) * 0.75 + 2 * mat;
      const card = Math.max(min, Math.min(0.76 * width, 340, fit));
      const cardHeight = mat + ((card - 2 * mat) * 4) / 3 + caption;
      const spare = Math.max(0, room + header - headerLine - cardHeight);
      const lead = Math.max(0, Math.min(spare * 0.25, spare - reserve));
      const extra = veryShort ? 0 : (lines - 1) * (titleLine + metaLine);
      const cardTop = top + lead + headerLine + extra + gap;
      const cueBottom = cardTop + cardHeight + gap + cue;
      return {
        bottom,
        card,
        share: card / width,
        centre: (cardTop + cardHeight / 2) / height,
        bottomGap: height - cueBottom,
      };
    };
    // An iPhone 17 Pro page in Safari, an older 390 phone, SE-class pages.
    for (const [width, height] of [
      [402, 716],
      [390, 664],
      [375, 600],
      [375, 548],
    ] as const) {
      const one = geometry(width, height, 1);
      const two = geometry(width, height, 2);
      expect(one.share).toBeGreaterThanOrEqual(height > 640 ? 0.74 : 0.6);
      // The card's centre a little above the middle, never sunk.
      expect(one.centre).toBeLessThanOrEqual(0.5);
      // The cue's row clear of the bottom edge, with one line or two of
      // title and meta.
      expect(one.bottomGap).toBeGreaterThanOrEqual(one.bottom);
      expect(two.bottomGap).toBeGreaterThanOrEqual(two.bottom);
    }
    expect(geometry(402, 716, 1).centre).toBeLessThanOrEqual(0.48);
    // Phones held sideways under the browser's bars: the cue's row and
    // 「上传」 (overhanging it by (56 - 44) / 2) stay inside the window.
    const button = own("button");
    for (const [width, height] of [
      [667, 323],
      [844, 350],
      [932, 380],
    ] as const) {
      const sideways = geometry(width, height, 1);
      expect(sideways.card).toBeGreaterThanOrEqual(80);
      expect(sideways.bottomGap - (button - 44) / 2).toBeGreaterThanOrEqual(0);
    }
    // The phone's button ends the cue's row, clear of its arrows, a long
    // count included (「100 / 120」 is about 70px); the arrows close in on a
    // very narrow phone.
    expect(css()).toMatch(
      /@media \(max-width: 22\.5rem\) \{\s*\.root \.nav \{\s*gap: var\(--yoyi-space-3\);/u,
    );
    expect(css()).toMatch(/\n\.arrow \{[^}]*z-index: 1;/u);
    const side = ownToken("side");
    for (const width of [320, 360, 375, 402]) {
      const gap = token(width <= 360 ? "space-3" : "space-5");
      const cueContent = 2 * 44 + 70 + 2 * gap;
      expect(width - side - button).toBeGreaterThanOrEqual(
        width / 2 + cueContent / 2,
      );
    }
  });

  it("never scrolls sideways, whatever takes the focus", () => {
    expect(css()).toMatch(/\.deck \{[^}]*overflow: hidden;\s*overflow: clip;/u);
    expect(css()).toMatch(
      /\.dialog\.dialog \{[^}]*overflow: hidden;\s*overflow: clip;/u,
    );
  });

  it("covers the whole window, a desktop's scrollbar gutter included", async () => {
    const html = document.documentElement;
    Object.defineProperty(html, "clientWidth", {
      configurable: true,
      value: 1425,
    });
    vi.stubGlobal("innerWidth", 1440);
    try {
      render();
      await flush();
      expect(
        (query("dialog") as HTMLElement).style.getPropertyValue(
          "--deck-gutter",
        ),
      ).toBe("15px");
      expect(css()).toMatch(
        /\.dialog\.dialog \{[^}]*width: calc\(100% \+ var\(--deck-gutter, 0px\)\);/u,
      );
    } finally {
      delete (html as { clientWidth?: number }).clientWidth;
    }
  });

  it("hides the shell's dock and create action while open, and gives them back", async () => {
    const html = document.documentElement;
    render();
    await flush();
    expect(html.hasAttribute("data-floating-actions-hidden")).toBe(true);
    window.history.back();
    await waitForHistory(() => expect(closed).toHaveBeenCalledOnce());
    expect(html.hasAttribute("data-floating-actions-hidden")).toBe(false);
    // The shell's stylesheet reads it: no second 「+」 through the blur.
    expect(dockCss as string).toMatch(
      /:global\(html\[data-floating-actions-hidden\]\) \.dock,\s*:global\(html\[data-floating-actions-hidden\]\) \.desktopAction \{\s*visibility: hidden;/u,
    );
  });

  it("fades out on Back, and hands over at once when an action closes it", async () => {
    let classAtClose: string | null = null;
    const Host = ({ closing }: { readonly closing: boolean }) => {
      const [open, setOpen] = useState(true);
      return open ? (
        <TimelineCardDeck
          actions={actions as unknown as TimelineDeckActions}
          closeRequested={closing}
          entry={entry()}
          layout="phone"
          onClose={() => {
            classAtClose = query("dialog")?.className ?? null;
            setOpen(false);
          }}
        />
      ) : null;
    };
    act(() => root.render(<Host closing={false} />));
    await flush();
    window.history.back();
    await waitForHistory(() => expect(classAtClose).not.toBeNull());
    expect(classAtClose).toMatch(/leaving/u);
    expect(css()).toMatch(
      /\.dialog\.dialog\.leaving \{\s*animation: deckOut var\(--yoyi-duration-fast\)[^}]*pointer-events: none;/u,
    );

    act(() => root.unmount());
    await Promise.resolve();
    await waitForHistory(() =>
      expect(window.history.state?.phase4Dialog).toBeUndefined(),
    );
    root = createRoot(container);
    classAtClose = null;
    act(() => root.render(<Host closing={false} />));
    await flush();
    act(() => root.render(<Host closing />));
    await waitForHistory(() => expect(classAtClose).not.toBeNull());
    expect(classAtClose).not.toMatch(/leaving/u);
  });

  it("takes the focus in, holds a Back entry and closes on Back", async () => {
    render();
    await flush();
    // No card yet: the title has the focus.
    expect(document.activeElement?.textContent).toBe("北魏虚构永平碑");
    expect(query("dialog")?.getAttribute("aria-label")).toBe("北魏虚构永平碑");
    expect(window.history.state?.phase4Dialog).toBeTruthy();
    window.history.back();
    await waitForHistory(() => expect(closed).toHaveBeenCalledOnce());
    expect(query("dialog")).toBeNull();
  });

  it("closes on Escape, ×, and a tap beside the cards", async () => {
    data.readTimelinePosts.mockResolvedValue(page(works(1, 2), 2));
    render();
    await flush();
    act(() => {
      query("dialog")?.dispatchEvent(new Event("cancel", { cancelable: true }));
    });
    await waitForHistory(() => expect(closed).toHaveBeenCalledTimes(1));

    render();
    await flush();
    click(query("[aria-label='关闭']"));
    await waitForHistory(() => expect(closed).toHaveBeenCalledTimes(2));

    render();
    await flush();
    click(stage());
    await waitForHistory(() => expect(closed).toHaveBeenCalledTimes(3));
  });

  it("keeps wheel gestures and local swipes from reaching the pager", async () => {
    render();
    await flush();
    const deck = query("[data-timeline-deck] > [role='group']") as HTMLElement;
    expect(deck.hasAttribute("data-local-horizontal")).toBe(true);
    const wheel = new WheelEvent("wheel", { bubbles: true, deltaX: 40 });
    const stop = vi.spyOn(wheel, "stopPropagation");
    act(() => {
      stage().dispatchEvent(wheel);
    });
    expect(stop).toHaveBeenCalled();
  });
});

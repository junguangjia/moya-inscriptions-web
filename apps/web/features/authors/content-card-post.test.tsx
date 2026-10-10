// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  shell,
  actions,
  work: readWork,
  colophons,
} = vi.hoisted(() => ({
  shell: {
    openContent: vi.fn(),
    openFeedViewer: vi.fn(() => true),
    activeFeedViewer: null,
  },
  actions: {
    environment: {
      onAction: vi.fn(),
      likedIds: [],
      favoriteIds: [],
      likeCount: 35,
      favoriteCount: 2,
      commentCount: 12,
      ready: true,
    },
    canLike: true,
    ensureLiked: vi.fn(() => Promise.resolve(true)),
  },
  work: vi.fn(),
  colophons: [] as Array<Record<string, unknown>>,
}));
vi.mock("../product-shell/product-shell", () => ({
  useProductShell: () => shell,
}));
vi.mock("./content-actions", () => ({
  useContentActions: () => actions,
}));
vi.mock("./author-data", () => ({
  authorClient: { work: readWork },
}));
// The phone single-column masonry slot.
vi.mock("../home/catalog-masonry", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../home/catalog-masonry")>()),
  useFeedPostSlot: () => true,
}));
// The colophons have their own tests; here only what the post hands them.
vi.mock("./feed-colophon", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./feed-colophon")>();
  const { useContext } = await import("react");
  return {
    ...actual,
    FeedColophon: (props: Record<string, unknown>) => {
      const outlet = useContext(actual.FeedColophonOutletContext);
      colophons.push({ ...props, outlet });
      return <section data-feed-colophon="" />;
    },
  };
});
vi.mock("./feed-post-author", () => ({
  FeedPostAuthor: ({ authorId }: { authorId: string }) => (
    <div data-feed-post-author={authorId} />
  ),
}));

import { ContentCard } from "./content-card";
import {
  clearDetailCommentsRequest,
  detailCommentsRequested,
} from "../detail/detail-comments-request";

import type { ContentCard as Card } from "@moya/contracts";
import type { Root } from "react-dom/client";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const workId = `work-${"d".repeat(32)}`;
const authorId = `user-${"f".repeat(32)}`;
const itemId = (letter: string) => `item-${letter.repeat(32)}`;
const still = (letter: string, width = 600, height = 800) => ({
  id: itemId(letter),
  src: `/api/community/publishing/media/${itemId(letter)}/cover/base`,
  width,
  height,
});
const year = new Date().getFullYear();
const work = (overrides: Partial<Card> = {}): Card => ({
  aliases: [],
  target: { type: "work", id: workId },
  title: "春日临帖",
  kind: null,
  authorId,
  firstPublishedAt: `${year}-09-13T12:00:00.000Z`,
  media: still("e"),
  ...overrides,
});
const catalog = (overrides: Partial<Card> = {}): Card =>
  work({
    target: { type: "catalog", id: "runtime-inscription" },
    title: "九成宫醴泉铭",
    kind: "inscription",
    authorId: null,
    firstPublishedAt: null,
    province: "陕西",
    ...overrides,
  });

interface FeedViewerRequest {
  readonly target: unknown;
  readonly media: readonly { readonly id: string }[];
  readonly index: number;
  readonly opener: HTMLElement;
  readonly direction: string;
}

const roots: Root[] = [];
const render = (item: Card) => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  act(() => root.render(<ContentCard item={item} />));
  return container.querySelector<HTMLElement>("article")!;
};
const button = (post: HTMLElement, label: string) =>
  post.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
const tapImage = (post: HTMLElement) =>
  act(() => {
    post
      .querySelector("[data-feed-slide-image]")!
      .dispatchEvent(
        new MouseEvent("click", { bubbles: true, cancelable: true, detail: 1 }),
      );
  });

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  colophons.length = 0;
  document.body.replaceChildren();
  vi.clearAllMocks();
  vi.useRealTimers();
});

describe("ContentCard as a phone single-column post", () => {
  it("stacks author, stage, dots, title, actions and date without a long-press layer", () => {
    const post = render(
      work({ gallery: [still("e"), still("a"), still("b")], mediaCount: 3 }),
    );
    expect(post.hasAttribute("data-feed-post")).toBe(true);
    expect(
      [...post.children].map(
        (child) =>
          [...child.attributes]
            .map((a) => a.name)
            .find((name) => name.startsWith("data-")) ?? child.className,
      ),
    ).toEqual([
      "data-feed-post-author",
      "data-feed-stage-frame",
      "data-feed-post-dots",
      "data-feed-post-title",
      "data-feed-post-actions",
      "data-feed-post-date",
    ]);
    expect(
      post
        .querySelector("[data-feed-post-author]")
        ?.getAttribute("data-feed-post-author"),
    ).toBe(authorId);
    expect(post.querySelector("[data-quick-actions]")).toBeNull();
    expect(
      post.querySelector('[data-feed-post-count="comment"]')?.textContent,
    ).toBe("12");
  });

  it("shows every gallery image in order, else the one card image", () => {
    const gallery = render(
      work({ gallery: [still("e"), still("a"), still("b")], mediaCount: 5 }),
    );
    expect(
      [...gallery.querySelectorAll<HTMLElement>("[data-feed-slide]")].map(
        (slide) => slide.dataset.mediaId,
      ),
    ).toEqual([itemId("e"), itemId("a"), itemId("b")]);
    const single = render(work());
    expect(single.querySelectorAll("[data-feed-slide]")).toHaveLength(1);
  });

  it("opens the feed viewer on a tap, right to left like the post", () => {
    const item = work({ gallery: [still("e"), still("a")], mediaCount: 2 });
    const post = render(item);
    tapImage(post);
    act(() => {
      vi.advanceTimersByTime(300);
    });
    expect(shell.openFeedViewer).toHaveBeenCalledOnce();
    const [[request]] = shell.openFeedViewer.mock.calls as unknown as [
      [FeedViewerRequest],
    ];
    expect(request.target).toEqual(item.target);
    expect(request.media.map((media) => media.id)).toEqual([
      itemId("e"),
      itemId("a"),
    ]);
    expect(request.index).toBe(0);
    expect(request.direction).toBe("rtl");
    expect(request.opener).toBe(post.querySelector("[data-feed-slide-image]"));
    expect(shell.openContent).not.toHaveBeenCalled();
  });

  it("likes on a double tap of the image", () => {
    const post = render(work());
    tapImage(post);
    tapImage(post);
    expect(actions.ensureLiked).toHaveBeenCalledOnce();
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(shell.openFeedViewer).not.toHaveBeenCalled();
  });

  it("continues the stage into the colophons, with the composer outlet outside the strip", () => {
    const post = render(work({ gallery: [still("e"), still("a")] }));
    const colophon = post.querySelector("[data-feed-colophon]")!;
    expect(colophon.closest("[data-feed-stage-comments]")).not.toBeNull();
    // Outside the strip, the post and the pager: fixed to the viewport.
    const outlet = document.querySelector("[data-colophon-composer-outlet]")!;
    expect(outlet.parentElement).toBe(document.body);
    expect(colophons.at(-1)).toEqual({
      target: { type: "work", id: workId },
      title: "春日临帖",
      fallbackCount: 12,
      outlet,
    });
    // The seal leads there.
    expect(post.querySelector("[data-feed-post-dot-comments]")).not.toBeNull();
  });

  it("scrolls the stage to the colophons from the comment button, never to Detail", () => {
    const post = render(work({ gallery: [still("e"), still("a")] }));
    const strip = post.querySelector<HTMLElement>("[data-feed-stage]")!;
    const scrollTo = vi.fn();
    Object.defineProperties(strip, {
      clientWidth: { configurable: true, get: () => 390 },
      scrollTo: { configurable: true, value: scrollTo },
    });
    const comment = button(post, "评论")!;
    act(() => comment.click());
    expect(scrollTo).toHaveBeenCalledOnce();
    const [[options]] = scrollTo.mock.calls as [[ScrollToOptions]];
    expect(Math.abs(options.left ?? 0)).toBe(780);
    expect(options.behavior).toBe("smooth");
    expect(shell.openContent).not.toHaveBeenCalled();
    expect(detailCommentsRequested(workId)).toBe(false);
    // No composer opens by itself.
    expect(
      document.querySelector("[data-colophon-composer-outlet]")?.children,
    ).toHaveLength(0);
  });

  it("opens a text-only work's Detail comments from the comment button", () => {
    const post = render(work({ media: null, excerpt: "只有文字" }));
    expect(post.querySelector("[data-feed-stage-frame]")).toBeNull();
    expect(post.querySelector("[data-feed-post-dots]")).toBeNull();
    expect(post.querySelector("[data-feed-colophon]")).toBeNull();
    expect(
      document.querySelector("[data-colophon-composer-outlet]"),
    ).toBeNull();
    const comment = button(post, "评论")!;
    act(() => comment.click());
    expect(shell.openContent).toHaveBeenCalledWith(
      { type: "work", id: workId },
      comment,
    );
    expect(detailCommentsRequested(workId)).toBe(true);
    clearDetailCommentsRequest();
  });

  it("expands a work's body in place from its title or the trailing action", async () => {
    readWork.mockResolvedValue({ available: true, text: "临《兰亭》第三遍。" });
    const post = render(work());
    const title = post.querySelector<HTMLButtonElement>(
      "[data-feed-post-title] button",
    )!;
    expect(title.getAttribute("aria-expanded")).toBe("false");
    act(() => title.click());
    expect(title.getAttribute("aria-expanded")).toBe("true");
    expect(post.dataset.feedPostExpanded).toBe("true");
    expect(readWork).toHaveBeenCalledWith(workId, expect.any(AbortSignal));
    await act(async () => {
      await Promise.resolve();
    });
    const body = document.getElementById(title.getAttribute("aria-controls")!);
    expect(body?.querySelector("[data-feed-post-body]")?.textContent).toBe(
      "临《兰亭》第三遍。",
    );
    act(() => button(post, "收起正文")!.click());
    expect(title.getAttribute("aria-expanded")).toBe("false");
    expect(post.querySelector("[data-feed-post-body]")).toBeNull();
    expect(shell.openContent).not.toHaveBeenCalled();
  });

  it("uses the body opening as the text line of an untitled work", () => {
    readWork.mockReturnValue(new Promise(() => {}));
    // Another work: bodies read earlier stay cached for the document.
    const post = render(
      work({
        target: { type: "work", id: `work-${"c".repeat(32)}` },
        title: "",
        excerpt: "兰亭序八种摹本对照",
      }),
    );
    expect(post.querySelector("h3")).toBeNull();
    const summary = post.querySelector<HTMLElement>("[data-card-excerpt]")!;
    expect(summary.textContent).toBe("兰亭序八种摹本对照");
    act(() => summary.click());
    // The opening stays while the full body loads.
    expect(
      post.querySelector(
        '[data-feed-post-body-state="loading"] [data-card-excerpt]',
      )?.textContent,
    ).toBe("兰亭序八种摹本对照");
    expect(button(post, "收起正文")).not.toBeNull();
  });

  it("offers Detail instead of expanding a work without text", () => {
    const post = render(work({ title: "" }));
    expect(button(post, "展开正文")).toBeNull();
    const detail = button(post, "查看详情")!;
    act(() => detail.click());
    expect(shell.openContent).toHaveBeenCalledWith(
      { type: "work", id: workId },
      detail,
    );
  });

  it("opens official content from its title and the detail action", () => {
    const post = render(catalog());
    expect(post.querySelector("[data-feed-post-author]")).toBeNull();
    expect(post.querySelector("[data-feed-post-date]")).toBeNull();
    const title = button(post, "打开九成宫醴泉铭")!;
    expect(title.closest("[data-feed-post-title]")).not.toBeNull();
    act(() => title.click());
    expect(shell.openContent).toHaveBeenLastCalledWith(
      { type: "catalog", id: "runtime-inscription" },
      title,
    );
    const detail = button(post, "查看详情")!;
    act(() => detail.click());
    expect(shell.openContent).toHaveBeenLastCalledWith(
      { type: "catalog", id: "runtime-inscription" },
      detail,
    );
    // The province badge stays on the image.
    expect(
      post
        .querySelector("[data-catalog-province]")
        ?.closest("[data-feed-stage-frame]"),
    ).not.toBeNull();
  });

  it("shows this year's date without the year and older dates with it", () => {
    expect(
      render(work()).querySelector("[data-feed-post-date] time")?.textContent,
    ).toBe("9月13日");
    const older = render(
      work({ firstPublishedAt: `${year - 1}-09-13T12:00:00.000Z` }),
    );
    expect(older.querySelector("[data-feed-post-date] time")?.textContent).toBe(
      `${year - 1}年9月13日`,
    );
    expect(
      render(work({ firstPublishedAt: null })).querySelector(
        "[data-feed-post-date]",
      ),
    ).toBeNull();
  });
});

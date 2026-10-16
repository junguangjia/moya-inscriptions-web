// @vitest-environment jsdom
import { act } from "react";
import type { ReactNode, Ref } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const returnState = vi.hoisted(() => ({
  saved: undefined as
    | {
        page: "reading" | "comments";
        top: number;
        commentsTop: number;
        inline: boolean;
      }
    | undefined,
  capture: undefined as (() => unknown) | undefined,
}));
vi.mock("../auth/auth-return", () => ({
  useAuthReturn: () => null,
  useAuthReturnView: (_slot: string, capture: () => unknown) => {
    returnState.capture = capture;
    return returnState.saved;
  },
}));

/*
 * content-community-completion-v1: a live comment section supplied to the
 * accepted readers takes the same comment column as the preview's comments
 * (max width, centred, side padding and room for the fixed composer). Without
 * it the live Article discussion ran edge to edge.
 */
vi.mock("../product-shell/product-shell", () => ({
  useProductShell: () => ({ platform: "desktop" }),
}));
// As the real pager: only the keys of its first render become panels.
const pagerState = vi.hoisted(() => ({
  mounts: [] as (readonly string[])[],
  scrollToKey: vi.fn(),
  canStartGesture: undefined as (() => boolean) | undefined,
}));
vi.mock("../shell/horizontal-pager", async () => {
  const { useImperativeHandle, useState } = await import("react");
  return {
    HorizontalPager: ({
      ref,
      keys,
      panels,
      activeKey,
      onCommit,
      canStartGesture,
      registerActiveScrollElement,
    }: {
      ref?: Ref<{ scrollToKey: (key: string) => void }>;
      keys: readonly string[];
      panels: Record<string, ReactNode>;
      activeKey: string;
      onCommit: (key: string) => void;
      canStartGesture?: () => boolean;
      registerActiveScrollElement?: (element: HTMLElement) => () => void;
    }) => {
      const [mounted] = useState(() => {
        pagerState.mounts.push(keys);
        return keys;
      });
      useImperativeHandle(ref, () => ({
        scrollToKey: pagerState.scrollToKey,
      }));
      pagerState.canStartGesture = canStartGesture;
      return (
        <div>
          {mounted.map((key) => (
            <section
              key={key}
              data-reading-page={key}
              ref={(element) =>
                element && key === activeKey
                  ? registerActiveScrollElement?.(element)
                  : undefined
              }
            >
              <button onClick={() => onCommit(key)}>{key}</button>
              {panels[key]}
            </section>
          ))}
        </div>
      );
    },
  };
});
import { ArticleReader, PostReader } from "./article-reader";
import styles from "./discussion-preview.module.css";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root | null = null;
let node: HTMLDivElement;
beforeEach(() => {
  returnState.saved = undefined;
  returnState.capture = undefined;
  pagerState.mounts = [];
  pagerState.scrollToKey.mockReset();
  pagerState.canStartGesture = undefined;
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    callback(0);
    return 1;
  });
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
  node = document.createElement("div");
  document.body.append(node);
  root = createRoot(node);
});
afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

const live = <div data-live-section="">实时评论</div>;
const column = () =>
  document.querySelector("[data-live-section]")?.parentElement ?? null;

describe("Accepted readers with a live comment section", () => {
  it("gives the Article reader's live comments the accepted comment column", async () => {
    await act(async () =>
      root!.render(
        <ArticleReader id="article-1" comments={live} onOpenProfile={() => {}}>
          <p>正文</p>
        </ArticleReader>,
      ),
    );
    expect(document.querySelector("[data-live-section]")).not.toBeNull();
    expect(column()?.className).toBe(styles.comments);
  });

  it("gives the post reader's live comments the accepted comment column", async () => {
    await act(async () =>
      root!.render(
        <PostReader id="post-1" comments={live} onOpenProfile={() => {}}>
          <p>正文</p>
        </PostReader>,
      ),
    );
    expect(column()?.className).toBe(styles.comments);
  });
  it("restores both panel offsets and the inline comments presentation after auth", async () => {
    returnState.saved = {
      page: "comments",
      top: 120,
      commentsTop: 260,
      inline: true,
    };
    await act(async () =>
      root!.render(
        <ArticleReader
          id="article-return"
          comments={live}
          onOpenProfile={() => {}}
        >
          <p>正文</p>
        </ArticleReader>,
      ),
    );
    expect(
      document
        .querySelector("[data-preview-reader]")
        ?.getAttribute("data-comment-mode"),
    ).toBe("inline");
    const reading = document.querySelector<HTMLElement>(
      '[data-reading-page="reading"]',
    )!;
    const comments = document.querySelector<HTMLElement>(
      '[data-reading-page="comments"]',
    )!;
    expect(comments.scrollTop).toBe(260);
    await act(async () =>
      document
        .querySelector<HTMLButtonElement>(
          '[data-reading-page="reading"] button',
        )!
        .click(),
    );
    expect(reading.scrollTop).toBe(120);
    reading.scrollTop = 180;
    comments.scrollTop = 400;
    expect(returnState.capture?.()).toEqual({
      page: "reading",
      top: 180,
      commentsTop: 400,
      inline: true,
    });
    expect(column()?.closest("[data-inline-comments]")).not.toBeNull();
  });

  it("restores the post reader's own scroller without an automatic comment", async () => {
    returnState.saved = {
      page: "reading",
      top: 340,
      commentsTop: 0,
      inline: false,
    };
    await act(async () =>
      root!.render(
        <PostReader id="post-return" comments={live} onOpenProfile={() => {}}>
          <p>正文</p>
        </PostReader>,
      ),
    );
    const scroller = document.querySelector<HTMLElement>("[data-post-reader]")!;
    expect(scroller.scrollTop).toBe(340);
    scroller.scrollTop = 450;
    expect(returnState.capture?.()).toEqual({ top: 450 });
  });
  it("waits for asynchronous post comments to fit the saved offset", async () => {
    returnState.saved = {
      page: "reading",
      top: 340,
      commentsTop: 0,
      inline: false,
    };
    let available = 0;
    let actual = 0;
    const original = Object.getOwnPropertyDescriptor(
      HTMLElement.prototype,
      "scrollTop",
    );
    Object.defineProperty(HTMLElement.prototype, "scrollTop", {
      configurable: true,
      get() {
        return actual;
      },
      set(value: number) {
        actual = Math.min(value, available);
      },
    });
    try {
      await act(async () =>
        root!.render(
          <PostReader
            id="post-late"
            comments={<p>Loading</p>}
            onOpenProfile={() => {}}
          >
            <p>正文</p>
          </PostReader>,
        ),
      );
      expect(actual).toBe(0);
      available = 900;
      await act(async () =>
        root!.render(
          <PostReader id="post-late" comments={live} onOpenProfile={() => {}}>
            <p>正文</p>
          </PostReader>,
        ),
      );
      expect(actual).toBe(340);
      const scroller =
        document.querySelector<HTMLElement>("[data-post-reader]")!;
      scroller.scrollTop = 450;
      await act(async () => scroller.append(document.createElement("p")));
      expect(actual).toBe(450);
    } finally {
      if (original)
        Object.defineProperty(HTMLElement.prototype, "scrollTop", original);
      else
        delete (HTMLElement.prototype as unknown as { scrollTop?: number })
          .scrollTop;
    }
  });
});

/*
 * pc-browse-only-v1: browse-only readers show the content alone. Neither
 * reader builds comments (live or the preview's, which need the discussion
 * preview state), a comments page or a composer outlet, and the Article reader
 * cannot page. These render without a DiscussionPreviewProvider on purpose.
 */
describe("Browse-only readers", () => {
  const reader = () =>
    document.querySelector<HTMLElement>("[data-preview-reader]")!;
  const press = (key: string) => {
    const event = new KeyboardEvent("keydown", {
      key,
      bubbles: true,
      cancelable: true,
    });
    act(() => {
      reader().dispatchEvent(event);
    });
    return event;
  };
  const noComments = () => {
    expect(document.querySelector("[data-live-section]")).toBeNull();
    expect(document.querySelector("[data-live-comments]")).toBeNull();
    expect(document.querySelector("[data-preview-comments]")).toBeNull();
    expect(document.querySelector("[data-comment-composer-outlet]")).toBeNull();
  };

  it("reads an Article on its reading page alone", async () => {
    await act(async () =>
      root!.render(
        <ArticleReader
          id="article-hidden"
          commentsHidden
          highlightCommentId="comment-1"
          onOpenProfile={() => {}}
        >
          <p>正文</p>
        </ArticleReader>,
      ),
    );
    expect(reader().textContent).toContain("正文");
    expect(reader().getAttribute("data-comment-mode")).toBe("hidden");
    expect(pagerState.mounts).toEqual([["reading"]]);
    expect(document.querySelector('[data-reading-page="comments"]')).toBeNull();
    expect(pagerState.canStartGesture?.()).toBe(false);
    noComments();
  });

  it("ignores a supplied live section and a saved comments page", async () => {
    returnState.saved = {
      page: "comments",
      top: 0,
      commentsTop: 260,
      inline: true,
    };
    await act(async () =>
      root!.render(
        <ArticleReader
          id="article-hidden-return"
          commentsHidden
          comments={live}
          onOpenProfile={() => {}}
        >
          <p>正文</p>
        </ArticleReader>,
      ),
    );
    expect(reader().getAttribute("data-comment-mode")).toBe("hidden");
    expect(document.querySelector("[data-inline-comments]")).toBeNull();
    expect(returnState.capture?.()).toMatchObject({
      page: "reading",
      inline: false,
    });
    noComments();
  });

  it("does not page on ArrowLeft or ArrowRight", async () => {
    await act(async () =>
      root!.render(
        <ArticleReader
          id="article-keys"
          commentsHidden
          onOpenProfile={() => {}}
        >
          <p>正文</p>
        </ArticleReader>,
      ),
    );
    for (const key of ["ArrowLeft", "ArrowRight"])
      expect(press(key).defaultPrevented).toBe(false);
    expect(pagerState.scrollToKey).not.toHaveBeenCalled();
  });

  it("keeps keyboard paging and both pages without browse-only", async () => {
    await act(async () =>
      root!.render(
        <ArticleReader
          id="article-paged"
          comments={live}
          onOpenProfile={() => {}}
        >
          <p>正文</p>
        </ArticleReader>,
      ),
    );
    expect(reader().getAttribute("data-comment-mode")).toBe("paged");
    expect(pagerState.mounts).toEqual([["reading", "comments"]]);
    expect(pagerState.canStartGesture?.()).toBe(true);
    expect(press("ArrowLeft").defaultPrevented).toBe(true);
    expect(pagerState.scrollToKey).toHaveBeenLastCalledWith("comments");
    press("ArrowRight");
    expect(pagerState.scrollToKey).toHaveBeenLastCalledWith("reading");
    expect(
      document.querySelector("[data-comment-composer-outlet]"),
    ).not.toBeNull();
  });

  it("remounts the Article reader when the mode flips either way", async () => {
    const render = (commentsHidden: boolean) =>
      act(async () =>
        root!.render(
          <ArticleReader
            id="article-flip"
            comments={live}
            {...(commentsHidden ? { commentsHidden } : {})}
            onOpenProfile={() => {}}
          >
            <p>正文</p>
          </ArticleReader>,
        ),
      );
    await render(false);
    // Leave the reader on its comments page before the mode flips.
    await act(async () =>
      document
        .querySelector<HTMLButtonElement>(
          '[data-reading-page="comments"] button',
        )!
        .click(),
    );
    expect(column()?.closest('[data-reading-page="comments"]')).not.toBeNull();
    await render(true);
    expect(pagerState.mounts).toEqual([["reading", "comments"], ["reading"]]);
    expect(reader().getAttribute("data-comment-mode")).toBe("hidden");
    noComments();
    await render(false);
    expect(pagerState.mounts).toHaveLength(3);
    expect(pagerState.mounts[2]).toEqual(["reading", "comments"]);
    // The fresh comments page receives the live section again.
    expect(column()?.className).toBe(styles.comments);
    expect(column()?.closest('[data-reading-page="comments"]')).not.toBeNull();
    expect(
      document
        .querySelector("[data-comment-composer-outlet]")
        ?.getAttribute("data-active"),
    ).toBe("false");
  });

  it("reads a post without comments or a composer, and flips back", async () => {
    const render = (commentsHidden: boolean) =>
      act(async () =>
        root!.render(
          <PostReader
            id="post-hidden"
            comments={live}
            {...(commentsHidden ? { commentsHidden } : {})}
            onOpenProfile={() => {}}
          >
            <p>正文</p>
          </PostReader>,
        ),
      );
    await render(true);
    const scroller = document.querySelector<HTMLElement>("[data-post-reader]")!;
    expect(scroller.textContent).toBe("正文");
    noComments();
    await render(false);
    expect(column()?.className).toBe(styles.comments);
    expect(document.querySelector("[data-post-reader]")).toBe(scroller);
    await render(true);
    noComments();
  });

  it("renders a hidden post without any comment slot outside the preview", async () => {
    await act(async () =>
      root!.render(
        <PostReader id="post-bare" commentsHidden onOpenProfile={() => {}}>
          <p>正文</p>
        </PostReader>,
      ),
    );
    expect(document.querySelector("[data-post-reader]")?.textContent).toBe(
      "正文",
    );
    noComments();
  });
});

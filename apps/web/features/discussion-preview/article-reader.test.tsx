// @vitest-environment jsdom
import { act } from "react";
import type { ReactNode } from "react";
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
vi.mock("../shell/horizontal-pager", () => ({
  HorizontalPager: ({
    panels,
    activeKey,
    onCommit,
    registerActiveScrollElement,
  }: {
    panels: Record<string, ReactNode>;
    activeKey: string;
    onCommit: (key: string) => void;
    registerActiveScrollElement?: (element: HTMLElement) => () => void;
  }) => (
    <div>
      {Object.entries(panels).map(([key, panel]) => (
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
          {panel}
        </section>
      ))}
    </div>
  ),
}));
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

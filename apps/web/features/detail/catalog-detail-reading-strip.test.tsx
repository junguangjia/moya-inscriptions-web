// @vitest-environment jsdom
import { act, createRef } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const authJourney = vi.hoisted(() => ({
  returned: undefined as unknown,
  capture: undefined as (() => unknown) | undefined,
}));
vi.mock("../auth/auth-return", () => ({
  useAuthReturnView: (_slot: string, capture: () => unknown) => {
    authJourney.capture = capture;
    return authJourney.returned;
  },
}));
import { useFeedStage } from "../authors/feed-post-stage-context";
import type { FeedStageApi } from "../authors/feed-post-stage-context";
import { CatalogDetailReadingStrip } from "./catalog-detail-reading-strip";
import type { CatalogDetailReadingStripHandle } from "./catalog-detail-reading-strip";
import {
  detailCommentsRequested,
  requestDetailComments,
} from "./detail-comments-request";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
const rect = (left: number, right: number) =>
  ({
    left,
    right,
    top: 0,
    bottom: 400,
    width: right - left,
    height: 400,
  }) as DOMRect;
const roots: Root[] = [];
let stage: FeedStageApi | null = null;
const Probe = () => {
  stage = useFeedStage();
  return null;
};
const mounts = (positionKey?: string) => {
  const onRegionChange = vi.fn();
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  roots.push(root);
  const ref = createRef<CatalogDetailReadingStripHandle>();
  let withComments = true;
  const draw = (id = "one") =>
    act(() =>
      root.render(
        <CatalogDetailReadingStrip
          ref={ref}
          detailId={id}
          id="reading-one"
          onRegionChange={onRegionChange}
          positionKey={positionKey}
          information={
            <>
              <h1 data-detail-reading-anchor="title">寒山诗</h1>
              <p data-detail-reading-anchor="body">全部正文</p>
              <Probe />
            </>
          }
          colophon={
            withComments ? (
              <section>
                <header data-colophon-head="">题跋</header>
                <p data-colophon-anchor="reply-1">回复</p>
              </section>
            ) : undefined
          }
        />,
      ),
    );
  draw();
  const strip = host.querySelector<HTMLDivElement>(
    "[data-detail-reading-strip]",
  )!;
  let offset = -strip.scrollLeft;
  let commentsStart = 950;
  Object.defineProperties(strip, {
    clientWidth: { configurable: true, value: 300 },
    scrollWidth: { configurable: true, value: 1800 },
    scrollLeft: {
      configurable: true,
      get: () => -offset,
      set: (value: number) => {
        offset = -value;
      },
    },
    scrollTo: {
      configurable: true,
      value: vi.fn((options: ScrollToOptions) => {
        offset = -(options.left ?? 0);
      }),
    },
  });
  vi.spyOn(strip, "getBoundingClientRect").mockImplementation(() =>
    rect(0, 300),
  );
  const geometry = () => {
    const head = host.querySelector<HTMLElement>("[data-colophon-head]");
    if (head !== null)
      vi.spyOn(head, "getBoundingClientRect").mockImplementation(() =>
        rect(280 - commentsStart + offset, 300 - commentsStart + offset),
      );
    const reply = host.querySelector<HTMLElement>("[data-colophon-anchor]");
    if (reply !== null)
      vi.spyOn(reply, "getBoundingClientRect").mockImplementation(() =>
        rect(100 - commentsStart + offset, 120 - commentsStart + offset),
      );
  };
  geometry();
  return {
    host,
    onRegionChange,
    strip,
    ref,
    draw,
    geometry,
    offset: () => offset,
    setOffset: (next: number) => {
      offset = next;
    },
    setCommentsStart: (next: number) => {
      commentsStart = next;
    },
    removeComments: () => {
      withComments = false;
      draw();
    },
    unmount: () => {
      act(() => root.unmount());
      roots.splice(roots.indexOf(root), 1);
      host.remove();
    },
  };
};

beforeEach(() => {
  authJourney.returned = undefined;
  authJourney.capture = undefined;
  vi.useFakeTimers();
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) =>
    window.setTimeout(() => callback(0), 16),
  );
  vi.stubGlobal("cancelAnimationFrame", (id: number) =>
    window.clearTimeout(id),
  );
  vi.stubGlobal("matchMedia", () => ({ matches: true }));
});
afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  document.body.replaceChildren();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.restoreAllMocks();
  stage = null;
});

describe("CatalogDetailReadingStrip", () => {
  it.each(["pointerup", "pointercancel"])(
    "keeps native momentum after %s active through its final reading position",
    (release) => {
      const view = mounts();
      act(() => {
        view.strip.dispatchEvent(new Event("pointerdown", { bubbles: true }));
        view.strip.dispatchEvent(new Event(release, { bubbles: true }));
        for (let step = 1; step <= 12; step += 1) {
          vi.advanceTimersByTime(100);
          view.setOffset(step * 80);
          view.strip.dispatchEvent(new Event("scroll"));
        }
        vi.advanceTimersByTime(180);
      });
      expect(view.offset()).toBe(960);
      expect(view.strip.dataset.detailReadingRegion).toBe("comments");
      expect(authJourney.capture?.()).toMatchObject({
        offset: 960,
        region: "comments",
      });
    },
  );

  it("retains either shortcut destination while arriving rows preserve their current anchor", () => {
    vi.stubGlobal("matchMedia", () => ({ matches: false }));
    const view = mounts();
    vi.mocked(view.strip.scrollTo).mockImplementation((options) => {
      const next = options as ScrollToOptions;
      const target = -(next.left ?? 0);
      view.setOffset(
        next.behavior === "smooth" ? (view.offset() + target) / 2 : target,
      );
    });
    act(() => {
      view.ref.current?.scrollToComments();
      stage?.scrollToOffset(stage.readOffset(), "instant");
      vi.advanceTimersByTime(180);
    });
    expect(view.offset()).toBe(950);
    expect(view.onRegionChange).toHaveBeenLastCalledWith("comments");
    act(() => {
      view.ref.current?.scrollToStart();
      stage?.scrollToOffset(stage.readOffset(), "instant");
      vi.advanceTimersByTime(180);
    });
    expect(view.offset()).toBe(0);
    expect(view.onRegionChange).toHaveBeenLastCalledWith("information");
  });
  it("finishes a shortcut's fractional native undershoot at the real comments boundary", () => {
    const view = mounts();
    vi.mocked(view.strip.scrollTo).mockImplementation((options) => {
      view.setOffset(-((options as ScrollToOptions).left ?? 0) - 2.5);
    });
    act(() => {
      view.ref.current?.scrollToComments();
      vi.advanceTimersByTime(180);
    });
    expect(view.offset()).toBe(950);
    expect(view.onRegionChange).toHaveBeenLastCalledWith("comments");
  });
  it("reports quick-navigation state for manual reading and returning to the start", () => {
    const view = mounts();
    expect(view.strip.id).toBe("reading-one");
    expect(view.onRegionChange).toHaveBeenLastCalledWith("information");
    act(() => {
      view.strip.dispatchEvent(
        new KeyboardEvent("keydown", { bubbles: true, key: "ArrowLeft" }),
      );
      view.setOffset(950);
      view.strip.dispatchEvent(new Event("scroll"));
      vi.advanceTimersByTime(180);
    });
    expect(view.onRegionChange).toHaveBeenLastCalledWith("comments");
    act(() => {
      view.ref.current?.scrollToStart();
      vi.advanceTimersByTime(180);
    });
    expect(view.offset()).toBe(0);
    expect(view.onRegionChange).toHaveBeenLastCalledWith("information");
  });

  it("can jump to an injected legacy discussion without a colophon head", () => {
    const view = mounts();
    view.strip
      .querySelector("[data-colophon-head]")
      ?.removeAttribute("data-colophon-head");
    const comments = view.strip.querySelector("section")!;
    vi.spyOn(comments, "getBoundingClientRect").mockImplementation(() =>
      rect(-670 + view.offset(), -650 + view.offset()),
    );
    act(() => {
      expect(view.ref.current?.scrollToComments()).toBe(true);
      vi.advanceTimersByTime(180);
    });
    expect(view.offset()).toBe(950);
    expect(view.onRegionChange).toHaveBeenLastCalledWith("comments");
  });
  it("restores an exact authentication journey's colophon position into the confirmed account scope", () => {
    const guest = mounts("auth-guest:catalog:one:single");
    act(() => {
      guest.ref.current?.scrollToComments();
      vi.advanceTimersByTime(180);
    });
    authJourney.returned = authJourney.capture?.();
    guest.unmount();
    const signedIn = mounts("auth-reader:catalog:one:single");
    expect(signedIn.offset()).toBe(950);
    expect(signedIn.strip.dataset.detailReadingRegion).toBe("comments");
    signedIn.unmount();
    authJourney.returned = undefined;
    expect(mounts("unrelated-reader:catalog:one:single").offset()).toBe(0);
  });

  it("copies the selected vertical prose as text while leaving editor copy untouched", () => {
    const view = mounts();
    const prose = view.host.querySelector("p")!;
    prose.textContent = "版本12\n下一行";
    const selection = window.getSelection()!;
    const range = document.createRange();
    range.selectNodeContents(prose);
    selection.removeAllRanges();
    selection.addRange(range);
    const write = vi.fn();
    const copy = new Event("copy", { bubbles: true, cancelable: true });
    Object.defineProperty(copy, "clipboardData", { value: { setData: write } });
    prose.dispatchEvent(copy);
    expect(write).toHaveBeenCalledWith("text/plain", "版本12\n下一行");
    const editor = document.createElement("textarea");
    view.strip.append(editor);
    const editCopy = new Event("copy", { bubbles: true, cancelable: true });
    editor.dispatchEvent(editCopy);
    expect(editCopy.defaultPrevented).toBe(false);
    selection.removeAllRanges();
  });
  it("restores only the explicit reader/content/mode scope after remount", () => {
    const first = mounts("reader-a:catalog:one:single");
    act(() => {
      first.strip.dispatchEvent(
        new KeyboardEvent("keydown", { bubbles: true, key: "ArrowLeft" }),
      );
      first.setOffset(420);
      first.strip.dispatchEvent(new Event("scroll"));
      vi.advanceTimersByTime(180);
    });
    first.unmount();
    const same = mounts("reader-a:catalog:one:single");
    expect(same.offset()).toBe(420);
    same.unmount();
    expect(mounts("reader-b:catalog:one:single").offset()).toBe(0);
  });
  it("uses real colophon geometry after an arbitrarily long prose region", () => {
    const view = mounts();
    expect(stage?.surface).toBe("reading");
    expect(stage?.count).toBe(0);
    act(() => {
      expect(view.ref.current?.scrollToComments()).toBe(true);
      vi.advanceTimersByTime(180);
    });
    expect(view.offset()).toBe(950);
    expect(view.strip.dataset.detailReadingRegion).toBe("comments");
    act(() => {
      expect(view.ref.current?.scrollToComment("reply-1")).toBe(true);
    });
    expect(view.offset()).toBe(1130);
    expect(view.ref.current?.scrollToComment("foreign")).toBe(false);
  });

  it("does not expose the input region while prose still occupies the view", () => {
    const view = mounts();
    act(() => {
      view.strip.dispatchEvent(
        new KeyboardEvent("keydown", { bubbles: true, key: "ArrowLeft" }),
      );
      view.setOffset(800);
      view.strip.dispatchEvent(new Event("scroll"));
      vi.advanceTimersByTime(180);
    });
    expect(view.strip.dataset.detailReadingRegion).toBe("information");
    act(() => {
      view.ref.current?.scrollToComments();
      vi.advanceTimersByTime(180);
    });
    expect(view.strip.dataset.detailReadingRegion).toBe("comments");
  });

  it("consumes an exact one-shot comment request and leaves another Detail alone", async () => {
    requestDetailComments("one");
    const view = mounts();
    expect(detailCommentsRequested("one")).toBe(false);
    await act(async () => {
      vi.advanceTimersByTime(20);
    });
    expect(view.offset()).toBe(950);
    act(() => {
      vi.advanceTimersByTime(180);
      view.draw("two");
    });
    expect(view.offset()).toBe(0);
  });

  it("offers a text-only reading surface without inventing a comments target", () => {
    const view = mounts();
    view.removeComments();
    expect(view.host.textContent).toContain("全部正文");
    expect(view.ref.current?.scrollToComments()).toBe(false);
    expect(view.ref.current?.scrollToComment("reply-1")).toBe(false);
  });

  it("keeps a registered comment anchor when the region grows", async () => {
    const view = mounts();
    act(() => {
      view.ref.current?.scrollToComments();
      vi.advanceTimersByTime(180);
    });
    stage?.setCommentsAnchor(() => 1110);
    await act(async () => {
      view.host.querySelector("[data-colophon-anchor]")?.append(" 更多回复");
    });
    act(() => {
      vi.advanceTimersByTime(20);
    });
    expect(view.offset()).toBe(1110);
  });
});

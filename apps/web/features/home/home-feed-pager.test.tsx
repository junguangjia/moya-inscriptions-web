// @vitest-environment jsdom
import { act, createRef } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HomeFeedPager } from "./home-feed-pager";
import { homeFeeds } from "./home-feed";
import type { HomeFeedPagerHandle } from "./home-feed-pager";
import type { HomeFeed } from "./home-feed";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
let time = 0,
  id = 0,
  width = 400,
  reduce = false;
let offsets = [0, 400, 800, 1200];
let heights: Record<HomeFeed, number> = {
  discover: 600,
  nearby: 900,
  inscriptions: 700,
  calligraphy: 800,
};
const frames = new Map<number, FrameRequestCallback>();
const cleanups: (() => void)[] = [];
const observers: TestResizeObserver[] = [];
class TestResizeObserver {
  readonly observed = new Set<Element>();
  constructor(readonly callback: ResizeObserverCallback) {
    observers.push(this);
  }
  observe(node: Element) {
    this.observed.add(node);
  }
  unobserve(node: Element) {
    this.observed.delete(node);
  }
  disconnect() {
    this.observed.clear();
  }
  trigger() {
    this.callback([], this);
  }
}
const advance = (count = 1) => {
  for (let i = 0; i < count; i++) {
    time += 16.667;
    const batch = [...frames.values()];
    frames.clear();
    act(() => batch.forEach((callback) => callback(time)));
  }
};
const touch = (
  node: HTMLElement,
  type: string,
  x = 300,
  y = 300,
  multiple = false,
) => {
  const points =
    type === "touchend" || type === "touchcancel"
      ? []
      : [
          { clientX: x, clientY: y },
          ...(multiple ? [{ clientX: x + 80, clientY: y }] : []),
        ];
  const event = new TouchEvent(type, {
    bubbles: true,
    cancelable: true,
    touches: points as Touch[],
  });
  Object.defineProperty(event, "timeStamp", { value: time });
  act(() => node.dispatchEvent(event));
  return event;
};
const nativeScroll = (frame: HTMLElement, left: number) =>
  act(() => {
    frame.scrollLeft = left;
    frame.dispatchEvent(new Event("scroll"));
  });
const setup = (
  platform: "phone" | "tablet" | "pc" = "phone",
  register?: (node: HTMLElement) => () => void,
) => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  cleanups.push(() => act(() => root.unmount()));
  const handle = createRef<HomeFeedPagerHandle>();
  const commits = vi.fn(),
    progress = vi.fn();
  let active: HomeFeed = "discover";
  const render = (feed: HomeFeed = active, visible = true) => {
    active = feed;
    act(() =>
      root.render(
        <HomeFeedPager
          ref={handle}
          activeFeed={feed}
          platform={platform}
          primaryVisible={visible}
          onCommit={(next) => {
            commits(next);
            render(next);
          }}
          onProgress={progress}
          panels={{
            discover: <button type="button">Discover</button>,
            nearby: <button type="button">Nearby</button>,
            inscriptions: <button type="button">Inscriptions</button>,
            calligraphy: <button type="button">Calligraphy</button>,
          }}
          {...(register ? { registerActiveScrollElement: register } : {})}
        />,
      ),
    );
  };
  render();
  const frame = container.querySelector<HTMLElement>("[data-home-feed-pager]")!;
  const track = frame.firstElementChild as HTMLElement;
  const panels = [...track.children] as HTMLElement[];
  const drag = (dx = -220, dy = 0) => {
    touch(frame, "touchstart");
    for (let i = 1; i <= 10; i++) {
      advance();
      touch(frame, "touchmove", 300 + (dx * i) / 10, 300 + (dy * i) / 10);
    }
  };
  return {
    container,
    frame,
    track,
    panels,
    handle,
    commits,
    progress,
    render,
    setPlatform(next: "phone" | "tablet" | "pc") {
      platform = next;
      render();
    },
    drag,
  };
};

describe("HomeFeedPager category engine integration", () => {
  it("releases desktop inline height when mobile panels own scrolling", () => {
    const pager = setup("pc");
    expect(pager.frame.style.height).toBe("600px");
    pager.setPlatform("phone");
    expect(pager.frame.dataset.horizontalPagerScrollOwner).toBe("panel");
    expect(pager.frame.style.height).toBe("");
    pager.setPlatform("pc");
    expect(pager.frame.style.height).toBe("600px");
  });

  beforeEach(() => {
    time = 0;
    id = 0;
    width = 400;
    reduce = false;
    offsets = [0, 400, 800, 1200];
    heights = {
      discover: 600,
      nearby: 900,
      inscriptions: 700,
      calligraphy: 800,
    };
    frames.clear();
    observers.length = 0;
    vi.spyOn(performance, "now").mockImplementation(() => time);
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb) => {
      frames.set(++id, cb);
      return id;
    });
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation((key) => {
      frames.delete(key);
    });
    vi.stubGlobal("ResizeObserver", TestResizeObserver);
    vi.stubGlobal(
      "IntersectionObserver",
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    );
    vi.stubGlobal(
      "matchMedia",
      vi.fn(() => ({
        matches: reduce,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      })),
    );
    for (const name of ["offsetWidth", "clientWidth"] as const)
      vi.spyOn(HTMLElement.prototype, name, "get").mockImplementation(
        () => width,
      );
    vi.spyOn(HTMLElement.prototype, "offsetParent", "get").mockImplementation(
      () => document.body,
    );
    vi.spyOn(HTMLElement.prototype, "offsetTop", "get").mockReturnValue(0);
    vi.spyOn(HTMLElement.prototype, "offsetLeft", "get").mockImplementation(
      function (this: HTMLElement) {
        return (
          offsets[homeFeeds.indexOf(this.dataset.homeFeedPanel as HomeFeed)] ??
          0
        );
      },
    );
    vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(600);
    vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockImplementation(
      function (this: HTMLElement) {
        return heights[this.dataset.homeFeedPanel as HomeFeed] ?? 600;
      },
    );
    Object.defineProperty(HTMLElement.prototype, "scrollTo", {
      configurable: true,
      value(this: HTMLElement, options: ScrollToOptions) {
        this.scrollLeft = Number(options.left ?? 0);
        this.dispatchEvent(new Event("scroll"));
      },
    });
    Object.defineProperty(HTMLElement.prototype, "onscrollend", {
      configurable: true,
      value: null,
    });
  });
  afterEach(() => {
    cleanups.splice(0).forEach((cleanup) => cleanup());
    document.body.replaceChildren();
    frames.clear();
    Reflect.deleteProperty(HTMLElement.prototype, "onscrollend");
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("keeps the same four mounted panels, native vertical surfaces and selected accessibility", () => {
    const v = setup();
    expect(v.frame.dataset.categoryPagerEngine).toBe("embla");
    expect(v.panels).toHaveLength(4);
    expect(
      v.panels.every(
        (p) => !p.hidden && p.hasAttribute("data-home-feed-scroll-surface"),
      ),
    ).toBe(true);
    expect(v.panels.map((p) => p.hasAttribute("inert"))).toEqual([
      false,
      true,
      true,
      true,
    ]);
    expect(v.panels.map((p) => p.getAttribute("aria-hidden"))).toEqual([
      "false",
      "true",
      "true",
      "true",
    ]);
  });
  it("publishes following motion, then commits and opens interaction on release without scrollend", () => {
    const v = setup();
    v.drag();
    expect(v.progress.mock.calls.at(-1)![0]).toBeGreaterThan(0.3);
    expect(v.commits).not.toHaveBeenCalled();
    touch(v.frame, "touchend");
    expect(v.commits).toHaveBeenCalledExactlyOnceWith("nearby");
    expect(v.panels.map((p) => p.hasAttribute("inert"))).toEqual([
      true,
      false,
      true,
      true,
    ]);
    const releasePosition = v.track.style.transform;
    advance(180);
    expect(v.track.style.transform).not.toBe(releasePosition);
    expect(v.progress).toHaveBeenLastCalledWith(expect.closeTo(1, 2));
    act(() => v.frame.dispatchEvent(new Event("scrollend")));
    expect(v.commits).toHaveBeenCalledOnce();
    expect(v.frame.scrollLeft).toBe(0);
  });
  it("works without native scrollend support and does not use native horizontal scroll events", () => {
    Reflect.deleteProperty(HTMLElement.prototype, "onscrollend");
    const v = setup();
    nativeScroll(v.frame, 200);
    expect(v.commits).not.toHaveBeenCalled();
    v.frame.scrollLeft = 0;
    v.drag();
    touch(v.frame, "touchend");
    advance(180);
    expect(v.commits).toHaveBeenCalledExactlyOnceWith("nearby");
  });
  it("keeps a vertical gesture vertical, permits a new horizontal gesture, and ignores implicit pointer capture changes", () => {
    const v = setup();
    v.drag(-30, -180);
    touch(v.frame, "touchend");
    advance(120);
    expect(v.commits).not.toHaveBeenCalled();
    v.drag();
    act(() =>
      v.panels[0]!.dispatchEvent(
        new Event("lostpointercapture", { bubbles: true }),
      ),
    );
    touch(v.frame, "touchend");
    expect(v.commits).toHaveBeenCalledExactlyOnceWith("nearby");
  });
  it("returns a small stationary release to the same page without a commit", () => {
    const v = setup();
    touch(v.frame, "touchstart");
    touch(v.frame, "touchmove", 280, 300);
    advance(20);
    touch(v.frame, "touchend");
    advance(180);
    expect(v.commits).not.toHaveBeenCalled();
    expect(v.progress).toHaveBeenLastCalledWith(expect.closeTo(0, 2));
  });
  it("keeps Phone height fixed and retains the PC document-flow model and exact offsets", () => {
    const phone = setup();
    act(() => phone.handle.current?.scrollToFeed("nearby"));
    expect(phone.frame.style.height).toBe("");
    offsets = [0, 412, 830];
    const pc = setup("pc");
    expect(pc.frame.style.height).toBe("600px");
    act(() => pc.handle.current?.scrollToFeed("nearby"));
    act(() => pc.frame.dispatchEvent(new Event("scrollend")));
    expect(pc.frame.scrollLeft).toBe(412);
    expect(pc.frame.style.height).toBe("900px");
    expect(pc.commits).toHaveBeenCalledExactlyOnceWith("nearby");
    expect(pc.frame.hasAttribute("data-category-pager-engine")).toBe(false);
  });
  it("registers the selected panel and preserves the actual panel nodes and scroll positions", () => {
    const registered: HTMLElement[] = [];
    const release = vi.fn();
    const v = setup("phone", (node) => {
      registered.push(node);
      return release;
    });
    v.panels[0]!.scrollTop = 137;
    v.panels[1]!.scrollTop = 88;
    v.render("nearby");
    expect(registered).toEqual([v.panels[0], v.panels[1]]);
    expect(release).toHaveBeenCalledOnce();
    expect(v.panels.map((p) => p.scrollTop)).toEqual([137, 88, 0, 0]);
    expect([...v.track.children]).toEqual(v.panels);
  });
  it("restores independent panel positions after a hidden ancestor removes their range", () => {
    const v = setup();
    const positions = [137, 88, 44, 212];
    v.panels.forEach((p, i) => {
      v.render(homeFeeds[i]!);
      act(() => {
        p.scrollTop = positions[i]!;
        p.dispatchEvent(new Event("scroll"));
      });
    });
    width = 0;
    v.render("calligraphy", false);
    v.panels.forEach((p) => {
      p.scrollTop = 0;
      p.dispatchEvent(new Event("scroll"));
    });
    width = 400;
    v.render("calligraphy", true);
    expect(v.panels.map((p) => p.scrollTop)).toEqual(positions);
    expect([...v.track.children]).toEqual(v.panels);
  });
  it.each([false, true])(
    "restores a resize-clamped reading position unless the reader moves (%s)",
    (readWhileClamped) => {
      const v = setup();
      const panel = v.panels[0]!;
      expect(
        observers.some((observer) =>
          observer.observed.has(panel.firstElementChild!),
        ),
      ).toBe(true);
      Object.defineProperty(panel, "clientHeight", {
        configurable: true,
        value: 100,
      });
      act(() => {
        panel.scrollTop = 137;
        panel.dispatchEvent(new Event("scroll"));
      });
      heights.discover = 200;
      act(() => {
        panel.scrollTop = 100; // Native range clamp precedes resize delivery.
        panel.dispatchEvent(new Event("scroll"));
        observers.forEach((observer) => observer.trigger());
      });
      expect(panel.scrollTop).toBe(100);
      if (readWhileClamped)
        act(() => {
          panel.scrollTop = 80;
          panel.dispatchEvent(new Event("scroll"));
          observers.forEach((observer) => observer.trigger());
          observers.forEach((observer) => observer.trigger());
        });
      heights.discover = 600;
      act(() => observers.forEach((observer) => observer.trigger()));
      expect(panel.scrollTop).toBe(readWhileClamped ? 80 : 137);
      act(() => {
        observers.forEach((observer) => observer.trigger());
        observers.forEach((observer) => observer.trigger());
      });
      expect(panel.scrollTop).toBe(readWhileClamped ? 80 : 137);
      expect([...v.track.children]).toEqual(v.panels);
    },
  );
  it("supports non-adjacent tab requests and immediate reduced-motion positioning", () => {
    const v = setup();
    act(() => v.handle.current?.scrollToFeed("calligraphy"));
    expect(v.commits).toHaveBeenCalledExactlyOnceWith("calligraphy");
    advance(180);
    expect(v.progress).toHaveBeenLastCalledWith(expect.closeTo(3, 2));
    reduce = true;
    act(() => v.handle.current?.scrollToFeed("nearby"));
    expect(v.progress).toHaveBeenLastCalledWith(expect.closeTo(1, 4));
  });
  it("does not reset the moving engine or its panels during its internal commit render", () => {
    const v = setup();
    v.drag();
    const before = v.track.style.transform;
    touch(v.frame, "touchend");
    expect(v.track.style.transform).toBe(before);
    expect([...v.track.children]).toEqual(v.panels);
    v.render("nearby");
    expect(v.track.style.transform).toBe(before);
  });
  it("lets a new reverse touch replace a pending programmatic animation", () => {
    const v = setup();
    act(() => v.handle.current?.scrollToFeed("nearby"));
    advance(4);
    const before = v.track.style.transform;
    touch(v.frame, "touchstart", 100, 300);
    expect(v.track.style.transform).toBe(before);
    for (let i = 1; i <= 10; i++) {
      advance();
      touch(v.frame, "touchmove", 100 + i * 20, 300);
    }
    touch(v.frame, "touchend");
    advance(180);
    expect(v.commits.mock.calls.map((c) => c[0])).toEqual([
      "nearby",
      "discover",
    ]);
  });
  it("resizes from committed state, ignores native clamp events and does not commit stale motion", () => {
    const v = setup();
    v.drag();
    width = 500;
    offsets = [0, 500, 1000];
    act(() => observers.forEach((o) => o.trigger()));
    nativeScroll(v.frame, 0);
    touch(v.frame, "touchend");
    advance(180);
    expect(v.commits).not.toHaveBeenCalled();
    expect(v.progress).toHaveBeenLastCalledWith(0);
  });
  it("retains the PC one-page wheel rule", () => {
    const v = setup("pc");
    for (const deltaX of [42, 31, 18])
      act(() =>
        v.frame.dispatchEvent(
          new WheelEvent("wheel", {
            bubbles: true,
            cancelable: true,
            deltaX,
            deltaY: 2,
          }),
        ),
      );
    act(() => v.frame.dispatchEvent(new Event("scrollend")));
    expect(v.commits).toHaveBeenCalledExactlyOnceWith("nearby");
  });
  it("defers PC height changes and never writes a queued height after unmount", () => {
    const v = setup("pc");
    const observer = observers.find((o) => o.observed.has(v.frame))!;
    expect(observer).toBeDefined();
    expect(v.frame.style.height).toBe("600px");
    heights.discover = 980;
    act(() => observer.trigger());
    expect(v.frame.style.height).toBe("600px");
    advance();
    expect(v.frame.style.height).toBe("980px");
    heights.discover = 1250;
    act(() => observer.trigger());
    expect(v.frame.style.height).toBe("980px");
    cleanups.splice(0).forEach((cleanup) => cleanup());
    expect(observer.observed.size).toBe(0);
    advance();
    expect(v.frame.style.height).toBe("980px");
    expect(frames.size).toBe(0);
  });
});

// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
const { track, shell, runtime } = vi.hoisted(() => ({
  track: vi.fn(),
  runtime: { flush: vi.fn(), beacon: vi.fn(), exclude: vi.fn() },
  shell: {
    activeContent: null as null | { type: "catalog"; id: string },
    activeDestination: "home",
    activeEditor: null,
    activeProfile: null,
    activeTopicId: null,
    activeViewerMediaId: null,
    activeFeedViewer: null,
    settingsOpen: false,
  },
}));
vi.mock("./client", () => ({
  trackAnalytics: track,
  readAnalyticsContext: (element: HTMLElement) => {
    const requestId = element.closest<HTMLElement>(
      "[data-analytics-search-request]",
    )?.dataset.analyticsSearchRequest;
    return {
      sequenceId: "sequence-test",
      position: 3,
      ...(requestId ? { requestId } : {}),
    };
  },
  analyticsContentContext: () => ({ sequenceId: "sequence-test", position: 3 }),
  clearAnalyticsQueue: vi.fn(),
  startAnalytics: () => runtime,
  stopAnalytics: vi.fn(),
}));
vi.mock("../product-shell/product-shell", () => ({
  useProductShell: () => shell,
}));
vi.mock("../authors/author-context", () => ({
  useOptionalAuthors: () => null,
}));
import {
  observeVisibleContent,
  useContentAnalytics,
  ProductAnalytics,
} from "./product-analytics";
(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
let notify: IntersectionObserverCallback;
let root: Root | undefined;
let visible = "visible";
class Observer {
  constructor(callback: IntersectionObserverCallback) {
    notify = callback;
  }
  observe() {}
  unobserve() {}
  disconnect() {}
}
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("IntersectionObserver", Observer);
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    get: () => visible,
  });
  visible = "visible";
  track.mockClear();
  shell.activeContent = null;
});
afterEach(() => {
  if (root) act(() => root!.unmount());
  root = undefined;
  document.body.replaceChildren();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("visible content and foreground reading", () => {
  it("coalesces the initial Shell restoration into one Detail page view", () => {
    const frames = new Map<number, FrameRequestCallback>();
    let serial = 0;
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      frames.set(++serial, callback);
      return serial;
    });
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation((id) => {
      frames.delete(id);
    });
    const node = document.createElement("div");
    node.dataset.productShell = "";
    document.body.append(node);
    root = createRoot(node);
    act(() => root!.render(<ProductAnalytics enabled />));
    shell.activeContent = { type: "catalog", id: "synthetic-deep-link" };
    act(() => root!.render(<ProductAnalytics enabled />));
    for (const callback of frames.values()) callback(1);
    expect(track).toHaveBeenCalledExactlyOnceWith({
      name: "page_view",
      surface: "detail",
      targetType: "catalog",
      targetId: "synthetic-deep-link",
    });
  });
  it("requires half of a card for a continuous second and preserves its source position", () => {
    document.body.innerHTML =
      '<main><article data-content-type="work" data-content-id="work-synthetic"></article></main>';
    const card = document.querySelector("article")!;
    vi.spyOn(card, "getBoundingClientRect").mockReturnValue({
      top: 0,
      left: 0,
      right: 100,
      bottom: 100,
      width: 100,
      height: 100,
    } as DOMRect);
    const dispose = observeVisibleContent(
      document.querySelector("main")!,
      () => "home",
    );
    const intersection = (ratio: number) =>
      notify(
        [
          {
            target: card,
            isIntersecting: true,
            intersectionRatio: ratio,
          } as unknown as IntersectionObserverEntry,
        ],
        {} as IntersectionObserver,
      );
    intersection(0.49);
    vi.advanceTimersByTime(1_100);
    expect(track).not.toHaveBeenCalled();
    intersection(0.5);
    vi.advanceTimersByTime(500);
    intersection(0.1);
    vi.advanceTimersByTime(600);
    expect(track).not.toHaveBeenCalled();
    intersection(0.5);
    vi.advanceTimersByTime(1_000);
    expect(track).toHaveBeenCalledWith({
      name: "content_impression",
      surface: "home",
      targetType: "work",
      targetId: "work-synthetic",
      position: 3,
      sequenceId: "sequence-test",
    });
    intersection(0.5);
    vi.advanceTimersByTime(1_000);
    expect(track).toHaveBeenCalledOnce();
    dispose();
  });
  it("attributes search impressions to each request even when target and position repeat", async () => {
    document.body.innerHTML =
      '<main data-active-home-feed="inscriptions"><div data-search-results data-analytics-search-request="search-request-1"><article data-catalog-card data-catalog-id="same-result"></article></div></main>';
    const card = document.querySelector("article")!;
    vi.spyOn(card, "getBoundingClientRect").mockReturnValue({
      top: 0,
      left: 0,
      right: 100,
      bottom: 100,
      width: 100,
      height: 100,
    } as DOMRect);
    // Re-observing a geometrically unchanged element delivers its current intersection.
    const observe = vi
      .spyOn(Observer.prototype, "observe")
      .mockImplementation(() => {
        notify(
          [
            {
              target: card,
              isIntersecting: true,
              intersectionRatio: 1,
            } as unknown as IntersectionObserverEntry,
          ],
          {} as IntersectionObserver,
        );
      });
    const dispose = observeVisibleContent(
      document.querySelector("main")!,
      () => "browse",
    );
    vi.advanceTimersByTime(1_000);
    expect(track).toHaveBeenCalledExactlyOnceWith({
      name: "content_impression",
      surface: "search",
      targetType: "catalog",
      targetId: "same-result",
      position: 3,
      sequenceId: "sequence-test",
      requestId: "search-request-1",
    });
    document.querySelector<HTMLElement>(
      "[data-search-results]",
    )!.dataset.analyticsSearchRequest = "search-request-2";
    await Promise.resolve();
    expect(observe).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(999);
    expect(track).toHaveBeenCalledOnce();
    vi.advanceTimersByTime(1);
    expect(track).toHaveBeenCalledTimes(2);
    expect(track.mock.calls[1]?.[0]).toMatchObject({
      surface: "search",
      targetId: "same-result",
      position: 3,
      requestId: "search-request-2",
    });
    dispose();
    observe.mockRestore();
  });
  it("restarts background exposure after search utility inert and aria-hidden coverage clears", async () => {
    document.body.innerHTML =
      '<main><article data-catalog-card data-catalog-id="background-result"></article></main>';
    const main = document.querySelector("main")!;
    const card = document.querySelector("article")!;
    vi.spyOn(card, "getBoundingClientRect").mockReturnValue({
      top: 0,
      left: 0,
      right: 100,
      bottom: 100,
      width: 100,
      height: 100,
    } as DOMRect);
    const observe = vi
      .spyOn(Observer.prototype, "observe")
      .mockImplementation(() => {
        notify(
          [
            {
              target: card,
              isIntersecting: true,
              intersectionRatio: 1,
            } as unknown as IntersectionObserverEntry,
          ],
          {} as IntersectionObserver,
        );
      });
    const dispose = observeVisibleContent(main, () => "home");
    vi.advanceTimersByTime(500);
    main.setAttribute("inert", "");
    await Promise.resolve();
    vi.advanceTimersByTime(1_000);
    expect(track).not.toHaveBeenCalled();
    main.removeAttribute("inert");
    await Promise.resolve();
    vi.advanceTimersByTime(500);
    main.setAttribute("aria-hidden", "true");
    await Promise.resolve();
    vi.advanceTimersByTime(1_000);
    expect(track).not.toHaveBeenCalled();
    main.removeAttribute("aria-hidden");
    await Promise.resolve();
    vi.advanceTimersByTime(999);
    expect(track).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(track).toHaveBeenCalledExactlyOnceWith({
      name: "content_impression",
      surface: "home",
      targetType: "catalog",
      targetId: "background-result",
      position: 3,
      sequenceId: "sequence-test",
    });
    expect(observe).toHaveBeenCalledTimes(5);
    dispose();
    observe.mockRestore();
  });
  it("cancels pending impressions while the tab is hidden or an ancestor becomes inert", () => {
    document.body.innerHTML =
      '<main><article data-catalog-card data-catalog-id="synthetic"></article></main>';
    const card = document.querySelector("article")!;
    vi.spyOn(card, "getBoundingClientRect").mockReturnValue({
      top: 0,
      left: 0,
      right: 100,
      bottom: 100,
      width: 100,
      height: 100,
    } as DOMRect);
    const dispose = observeVisibleContent(
      document.querySelector("main")!,
      () => "browse",
    );
    notify(
      [
        {
          target: card,
          isIntersecting: true,
          intersectionRatio: 1,
        } as unknown as IntersectionObserverEntry,
      ],
      {} as IntersectionObserver,
    );
    visible = "hidden";
    document.dispatchEvent(new Event("visibilitychange"));
    vi.advanceTimersByTime(2_000);
    expect(track).not.toHaveBeenCalled();
    visible = "visible";
    document.querySelector("main")!.setAttribute("inert", "");
    notify(
      [
        {
          target: card,
          isIntersecting: true,
          intersectionRatio: 1,
        } as unknown as IntersectionObserverEntry,
      ],
      {} as IntersectionObserver,
    );
    vi.advanceTimersByTime(2_000);
    expect(track).not.toHaveBeenCalled();
    dispose();
  });
  it("starts only for loaded data, excludes hidden time and emits foreground deltas once", () => {
    let time = 0;
    vi.spyOn(performance, "now").mockImplementation(() => time);
    const Component = ({ loaded }: { loaded: boolean }) => {
      useContentAnalytics("catalog", "synthetic", loaded);
      return null;
    };
    const node = document.createElement("div");
    document.body.append(node);
    root = createRoot(node);
    act(() => root!.render(<Component loaded={false} />));
    expect(track).not.toHaveBeenCalled();
    act(() => root!.render(<Component loaded />));
    expect(track.mock.calls[0]?.[0].name).toBe("content_open");
    time = 1_500;
    visible = "hidden";
    document.dispatchEvent(new Event("visibilitychange"));
    expect(track.mock.calls[1]?.[0]).toMatchObject({
      name: "content_dwell",
      dwellMs: 1_500,
      position: 3,
    });
    time = 101_500;
    visible = "visible";
    document.dispatchEvent(new Event("visibilitychange"));
    time = 102_000;
    act(() => root!.unmount());
    root = undefined;
    // Five hundred final foreground milliseconds stay below the report threshold.
    expect(track).toHaveBeenCalledTimes(2);
  });
});

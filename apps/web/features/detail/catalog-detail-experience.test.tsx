// @vitest-environment jsdom

import { act, createRef } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CatalogDetailExperience } from "./catalog-detail-experience";
import { useCatalogDetailWithdrawal } from "./catalog-detail-withdrawal";

import type { Root } from "react-dom/client";
import type { MediaId } from "@moya/contracts";
import type { WithdrawCatalogDetail } from "./catalog-detail-withdrawal";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const roots: Root[] = [];

describe("CatalogDetailExperience", () => {
  afterEach(() => {
    for (const root of roots.splice(0)) act(() => root.unmount());
    document.body.replaceChildren();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("preserves the desired Detail scroll through a temporary viewport clamp", () => {
    let notifyResize: ResizeObserverCallback | undefined;
    class TestResizeObserver {
      constructor(callback: ResizeObserverCallback) {
        notifyResize = callback;
      }

      disconnect() {}
      observe() {}
      unobserve() {}
    }
    vi.stubGlobal("ResizeObserver", TestResizeObserver);
    let frameId = 0;
    const frames = new Map<number, FrameRequestCallback>();
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      const id = ++frameId;
      frames.set(id, callback);
      return id;
    });
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation((id) =>
      frames.delete(id),
    );
    const flushFrames = () => {
      act(() => {
        while (frames.size > 0) {
          const pending = [...frames.values()];
          frames.clear();
          for (const callback of pending) callback(0);
        }
      });
    };
    const onScrollTopChange = vi.fn();
    const properties = {
      activeViewerMediaId: null,
      backButtonRef: createRef<HTMLButtonElement>(),
      catalogId: "catalog-detail",
      initialScrollTop: 0,
      onBack: vi.fn(),
      onCloseViewer: vi.fn(),
      onOpenViewer: vi.fn(),
      onScrollTopChange,
      onViewerMediaChange: vi.fn(),
      platform: "tablet" as const,
      state: { state: "loading" as const },
    };
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    roots.push(root);
    act(() =>
      root.render(
        <CatalogDetailExperience {...properties} orientation="landscape" />,
      ),
    );
    const scroller = container.querySelector<HTMLElement>(
      "[data-detail-scroll]",
    );
    if (scroller === null) throw new Error("Missing Detail scroll container");
    scroller.scrollTop = 180;
    act(() => scroller.dispatchEvent(new Event("scroll", { bubbles: true })));
    expect(onScrollTopChange).toHaveBeenLastCalledWith(180);
    flushFrames();

    Object.defineProperties(scroller, {
      clientHeight: { configurable: true, value: 834 },
      scrollHeight: { configurable: true, value: 970 },
    });
    act(() => notifyResize?.([], {} as ResizeObserver));
    scroller.scrollTop = 136;
    act(() => scroller.dispatchEvent(new Event("scroll", { bubbles: true })));
    expect(onScrollTopChange).not.toHaveBeenCalledWith(136);

    Object.defineProperties(scroller, {
      clientHeight: { configurable: true, value: 834 },
      scrollHeight: { configurable: true, value: 1258 },
    });
    act(() => notifyResize?.([], {} as ResizeObserver));
    scroller.scrollTop = 167;
    act(() => scroller.dispatchEvent(new Event("scroll", { bubbles: true })));
    expect(onScrollTopChange).not.toHaveBeenCalledWith(167);
    flushFrames();

    expect(scroller.scrollTop).toBe(180);

    const pointerEvent = (type: string, x: number, y: number) => {
      const event = new Event(type, { bubbles: true });
      Object.defineProperties(event, {
        clientX: { value: x },
        clientY: { value: y },
        isPrimary: { value: true },
        pointerId: { value: 1 },
      });
      return event;
    };
    act(() => {
      scroller.dispatchEvent(pointerEvent("pointerdown", 30, 120));
      scroller.dispatchEvent(pointerEvent("pointermove", 32, 90));
      scroller.scrollTop = 120;
      scroller.dispatchEvent(new Event("scroll", { bubbles: true }));
    });

    expect(onScrollTopChange).toHaveBeenLastCalledWith(120);
  });

  it("accepts upward input before the restoration suppression frames finish", () => {
    vi.spyOn(window, "requestAnimationFrame").mockReturnValue(1);
    const cancel = vi
      .spyOn(window, "cancelAnimationFrame")
      .mockImplementation(() => {});
    const onScrollTopChange = vi.fn();
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    roots.push(root);
    act(() =>
      root.render(
        <CatalogDetailExperience
          activeViewerMediaId={null}
          backButtonRef={createRef<HTMLButtonElement>()}
          catalogId="catalog-detail"
          initialScrollTop={180}
          onBack={vi.fn()}
          onCloseViewer={vi.fn()}
          onOpenViewer={vi.fn()}
          onScrollTopChange={onScrollTopChange}
          onViewerMediaChange={vi.fn()}
          platform="phone"
          orientation="portrait"
          state={{ state: "loading" }}
        />,
      ),
    );
    const scroller = container.querySelector<HTMLElement>(
      "[data-detail-scroll]",
    )!;
    Object.defineProperties(scroller, {
      clientHeight: { configurable: true, value: 844 },
      scrollHeight: { configurable: true, value: 2000 },
    });
    act(() => {
      scroller.dispatchEvent(
        new WheelEvent("wheel", { bubbles: true, deltaY: -180 }),
      );
      scroller.scrollTop = 0;
      scroller.dispatchEvent(new Event("scroll", { bubbles: true }));
    });
    expect(cancel).toHaveBeenCalled();
    expect(onScrollTopChange).toHaveBeenLastCalledWith(0);
  });

  it("opens the exact media and restores Detail scroll and current image focus", () => {
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      callback(performance.now());
      return 1;
    });
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => {});
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: vi.fn(() => ({ matches: false })),
    });
    const onOpenViewer = vi.fn();
    const onCloseViewer = vi.fn();
    const state = {
      detail: {
        aliases: [],
        facts: [],
        id: "catalog-detail",
        kind: "inscription" as const,
        media: [
          {
            alt: "详情图像",
            height: 600,
            id: "media-one" as MediaId,
            kind: "image" as const,
            src: "https://example.test/media-one.jpg",
            width: 400,
          },
        ],
        source: "qa" as const,
        sourceCitations: [],
        title: "资料",
      },
      state: "loaded" as const,
    };
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    roots.push(root);
    const render = (activeViewerMediaId: string | null) =>
      root.render(
        <CatalogDetailExperience
          activeViewerMediaId={activeViewerMediaId}
          backButtonRef={createRef<HTMLButtonElement>()}
          catalogId="catalog-detail"
          initialScrollTop={0}
          onBack={vi.fn()}
          onCloseViewer={onCloseViewer}
          onOpenViewer={onOpenViewer}
          onScrollTopChange={vi.fn()}
          onViewerMediaChange={vi.fn()}
          orientation="portrait"
          platform="phone"
          state={state}
        />,
      );
    act(() => render(null));
    const scroller = container.querySelector<HTMLElement>(
      "[data-detail-scroll]",
    )!;
    scroller.scrollTop = 90;
    const opener = container.querySelector<HTMLButtonElement>(
      "[data-detail-main-image]",
    )!;
    act(() => opener.click());
    expect(onOpenViewer).toHaveBeenCalledWith("media-one");

    act(() => render("media-one"));
    expect(
      container.querySelector("[data-detail-viewer]")?.hasAttribute("open"),
    ).toBe(true);
    scroller.scrollTop = 0;
    act(() => render(null));
    expect(scroller.scrollTop).toBe(90);
    expect(document.activeElement).toBe(opener);
  });

  it("rejects a direct media identifier outside the loaded Catalog", () => {
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: vi.fn(() => ({ matches: false })),
    });
    const onCloseViewer = vi.fn();
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    roots.push(root);
    act(() =>
      root.render(
        <CatalogDetailExperience
          activeViewerMediaId="foreign-media"
          backButtonRef={createRef<HTMLButtonElement>()}
          catalogId="catalog-detail"
          initialScrollTop={0}
          onBack={vi.fn()}
          onCloseViewer={onCloseViewer}
          onOpenViewer={vi.fn()}
          onScrollTopChange={vi.fn()}
          onViewerMediaChange={vi.fn()}
          orientation="portrait"
          platform="phone"
          state={{
            detail: {
              aliases: [],
              facts: [],
              id: "catalog-detail",
              kind: "inscription",
              media: [],
              source: "qa",
              sourceCitations: [],
              title: "资料",
            },
            state: "loaded",
          }}
        />,
      ),
    );
    expect(onCloseViewer).toHaveBeenCalledOnce();
  });

  it("withdraws a Detail in place: the Viewer closes, the notice is read from the top with focus", () => {
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      callback(performance.now());
      return 1;
    });
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => {});
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: vi.fn(() => ({ matches: false })),
    });
    let withdraw: WithdrawCatalogDetail | null = null;
    const Actions = () => {
      withdraw = useCatalogDetailWithdrawal();
      return <div data-test-actions="" />;
    };
    const onCloseViewer = vi.fn();
    const onScrollTopChange = vi.fn();
    const detail = (id: string) =>
      ({
        detail: {
          aliases: [],
          authorId: `user-${"a".repeat(32)}`,
          authorName: "临帖人",
          available: true,
          canEdit: true,
          contentType: "work",
          facts: [],
          id,
          media: [
            {
              alt: "作品图像",
              height: 600,
              id: "media-one",
              src: "https://example.test/media-one.jpg",
              width: 400,
            },
          ],
          source: "runtime",
          sourceCitations: [],
          title: "春日临帖",
        },
        state: "loaded",
      }) as const;
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    roots.push(root);
    const render = (
      catalogId: string,
      activeViewerMediaId: string | null,
      calligraphy = false,
      positionKey = "reader:normal",
    ) =>
      act(() =>
        root.render(
          <CatalogDetailExperience
            activeViewerMediaId={activeViewerMediaId}
            backButtonRef={createRef<HTMLButtonElement>()}
            calligraphy={calligraphy}
            catalogId={catalogId}
            commentSection={<section data-comment-section="">comments</section>}
            detailActions={<Actions />}
            initialScrollTop={0}
            onBack={vi.fn()}
            onCloseViewer={onCloseViewer}
            onOpenViewer={vi.fn()}
            onScrollTopChange={onScrollTopChange}
            onViewerMediaChange={vi.fn()}
            orientation="landscape"
            platform={calligraphy ? "phone" : "pc"}
            positionKey={positionKey}
            state={detail(catalogId)}
          />,
        ),
      );
    render("work-one", "media-one");
    expect(withdraw).not.toBeNull();
    const scroller = container.querySelector<HTMLElement>(
      "[data-detail-scroll]",
    )!;
    scroller.scrollTop = 240;

    act(() =>
      withdraw!("work-one", {
        title: "作品已移到回收站",
        description: "保留期内可以在回收站中恢复，恢复后为仅自己可见。",
      }),
    );
    // Re-render as the shell would once the Viewer entry is gone.
    render("work-one", null);
    const notice = container.querySelector<HTMLElement>(
      "[data-detail-withdrawn]",
    );
    expect(notice?.textContent).toContain("作品已移到回收站");
    expect(document.activeElement).toBe(notice);
    expect(onCloseViewer).toHaveBeenCalled();
    expect(scroller.scrollTop).toBe(0);
    expect(onScrollTopChange).toHaveBeenCalledWith(0);
    expect(container.querySelector("[data-detail-main-image]")).toBeNull();
    expect(container.querySelector("[data-comment-section]")).toBeNull();
    expect(container.querySelector("[data-test-actions]")).toBeNull();

    // Mode, breakpoint and account-scoped restoration cannot reveal the
    // same withdrawn content again.
    for (const [calligraphy, positionKey] of [
      [true, "reader:single"],
      [true, "another-reader:single"],
      [false, "another-reader:normal"],
    ] as const) {
      render("work-one", null, calligraphy, positionKey);
      expect(container.querySelector("[data-detail-withdrawn]")).toBe(notice);
      expect(container.querySelector("[data-detail-main-image]")).toBeNull();
      expect(container.querySelector("[data-test-actions]")).toBeNull();
    }

    // Another Detail is never affected.
    render("work-two", null);
    expect(container.querySelector("[data-detail-withdrawn]")).toBeNull();
    expect(container.querySelector("[data-test-actions]")).not.toBeNull();
  });
});

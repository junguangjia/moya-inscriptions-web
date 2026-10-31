// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CatalogMasonry, useMasonrySlot } from "./catalog-masonry";
import { DesktopCardFrame } from "./desktop-card-frame";
import { DesktopFeed } from "./desktop-feed";
import { renderToStaticMarkup } from "react-dom/server";
import type { Root } from "react-dom/client";
import type { PresentationPlatform } from "../shell/device-platform";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
let desktop = true;
vi.mock("../product-shell/product-shell", () => ({
  useOptionalProductShell: () => ({ desktop }),
}));
const roots: Root[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  document.body.replaceChildren();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  desktop = true;
});
const cards = [
  {
    id: "a",
    target: { type: "work" },
    title: "第一帖",
    excerpt: "真实正文",
    media: null,
  },
  {
    id: "b",
    target: { type: "catalog" },
    title: "第二帖",
    media: { width: 1600, height: 1000 },
  },
];
const render = (
  platform: PresentationPlatform = "pc",
  feedLayout: "single" | "double" = "single",
) => {
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
    () => ({
      width: 1296,
      height: 240,
      x: 0,
      y: 0,
      left: 0,
      right: 1296,
      top: 0,
      bottom: 240,
      toJSON() {
        return {};
      },
    }),
  );
  const target = document.createElement("div");
  document.body.append(target);
  const root = createRoot(target);
  roots.push(root);
  const open = vi.fn();
  const Item = ({ item }: { item: (typeof cards)[number] }) => {
    const slot = useMasonrySlot();
    return (
      <DesktopCardFrame
        title={item.title}
        metadata={item.target.type === "work" ? "作品" : "碑刻"}
        preview={item.excerpt ?? ""}
        media={
          item.media ? (
            <div>
              <img alt="第二帖" src="/image.jpg" />
            </div>
          ) : null
        }
        action={
          <button
            type="button"
            aria-label={`打开${item.title}`}
            onClick={() => open(item.id)}
          />
        }
        data-image-width={slot?.desktop?.mediaWidth}
      />
    );
  };
  act(() =>
    root.render(
      <CatalogMasonry
        items={cards}
        getKey={(item) => item.id}
        renderItem={(item) => <Item item={item} />}
        platform={platform}
        feedLayout={feedLayout}
      />,
    ),
  );
  return { target, open };
};
describe("desktop feed isolation and native openers", () => {
  it("retains source content before client width measurement", () => {
    const markup = renderToStaticMarkup(
      <DesktopFeed
        items={cards}
        getKey={(item) => item.id}
        renderItem={(item) => <p>{item.title}</p>}
      />,
    );
    expect(markup).toContain('data-layout-ready="false"');
    expect(markup).toContain("第一帖");
    expect(markup).toContain("第二帖");
    expect(markup.indexOf("第一帖")).toBeLessThan(markup.indexOf("第二帖"));
  });
  it("prepares bounded complete-media defaults and explicit author intent before measurement", () => {
    const container = document.createElement("div");
    const images = [
      { ...cards[1]!, id: "preview" },
      {
        ...cards[1]!,
        id: "contained",
        title: "保留原图",
        media: { width: 1600, height: 1000, feed: { fit: "contain" } },
      },
    ];
    container.innerHTML = renderToStaticMarkup(
      <DesktopFeed
        items={images}
        getKey={(item) => item.id}
        renderItem={(item, _index, slot) => (
          <span
            data-card-width={slot.width}
            data-card-height={slot.height}
            data-image-width={slot.mediaWidth}
            data-card-cropped={slot.cropped}
          >
            {item.title}
          </span>
        )}
      />,
    );
    expect(
      container
        .querySelector("[data-desktop-feed]")
        ?.getAttribute("data-layout-ready"),
    ).toBe("false");
    const sizes = [
      ...container.querySelectorAll<HTMLElement>("[data-card-width]"),
    ];
    expect(sizes).toHaveLength(2);
    for (const node of sizes) {
      const width = Number(node.dataset.cardWidth);
      const height = Number(node.dataset.cardHeight);
      const mediaWidth = Number(node.dataset.imageWidth);
      expect(width).toBeGreaterThan(96);
      expect(width).toBeLessThanOrEqual(1000);
      expect(height).toBeGreaterThan(0);
      expect(height).toBeLessThanOrEqual(640);
      expect(width - mediaWidth).toBeCloseTo(96, 8);
      expect(mediaWidth / height).toBeCloseTo(1.6, 8);
    }
    // Both unframed and author-contained sources use the complete-image default.
    // Explicit eligible authored cover is exercised by the native card suite.
    expect(sizes.map((node) => node.dataset.cardCropped)).toEqual([
      "false",
      "false",
    ]);
    expect(sizes.map((node) => node.textContent)).toEqual([
      "第二帖",
      "保留原图",
    ]);
  });
  it("preserves source DOM order, shows real text and opens the selected content", () => {
    const { target, open } = render();
    expect(
      [...target.querySelectorAll("h3")].map((n) => n.textContent),
    ).toEqual(["第一帖", "第二帖"]);
    expect(target.textContent).toContain("真实正文");
    const items = target.querySelectorAll<HTMLElement>(
      "[data-desktop-feed-item]",
    );
    expect(Number.parseFloat(items[0]!.style.left)).toBeGreaterThan(
      Number.parseFloat(items[1]!.style.left),
    );
    act(() =>
      target
        .querySelector<HTMLButtonElement>('[aria-label="打开第二帖"]')!
        .click(),
    );
    expect(open).toHaveBeenCalledWith("b");
    expect(target.querySelectorAll("img")).toHaveLength(1);
  });
  it.each([
    ["pc", "double"],
    ["tablet", "single"],
    ["phone", "single"],
  ] as const)("keeps the existing %s / %s list path", (platform, layout) => {
    const { target } = render(platform, layout);
    expect(target.querySelector("[data-desktop-feed]")).toBeNull();
    expect(target.querySelector("[data-home-masonry]")).not.toBeNull();
  });
  it("keeps tablet/UA classification authoritative even at desktop-sized widths", () => {
    desktop = false;
    const { target } = render();
    expect(target.querySelector("[data-desktop-feed]")).toBeNull();
  });
});

const box = (left: number, top: number, width: number, height: number) =>
  ({
    x: left,
    y: top,
    left,
    top,
    width,
    height,
    right: left + width,
    bottom: top + height,
    toJSON() {
      return {};
    },
  }) as DOMRect;
const anchorFixture = ({
  initialCount = 49,
  count = 61,
  initialWidth = 3440,
  ratios = [0.5],
  initiallyHidden = false,
  initiallyInert = false,
} = {}) => {
  let width = initialWidth;
  const frames = new Map<number, FrameRequestCallback>();
  let frameId = 0;
  vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
    frames.set(++frameId, callback);
    return frameId;
  });
  vi.spyOn(window, "cancelAnimationFrame").mockImplementation((id) => {
    frames.delete(id);
  });
  let resize: () => void = () => undefined;
  class Observer {
    constructor(callback: () => void) {
      resize = callback;
    }
    observe() {}
    disconnect() {}
  }
  vi.stubGlobal("ResizeObserver", Observer);
  const owner = document.createElement("div");
  owner.style.overflowY = "auto";
  if (initiallyHidden) owner.setAttribute("hidden", "");
  if (initiallyInert) {
    owner.setAttribute("inert", "");
    owner.setAttribute("aria-hidden", "true");
  }
  const target = document.createElement("div");
  // Match DiscoveryFeed's real phase4-load min-height, not an arbitrary spacer.
  const footer = document.createElement("div");
  footer.className = "phase4-load";
  footer.style.minHeight = "60px";
  const more = document.createElement("button");
  more.textContent = "加载更多";
  footer.append(more);
  owner.append(target, footer);
  document.body.append(owner);
  let scrollTop = 0;
  const scrollWrites: number[] = [];
  Object.defineProperties(owner, {
    scrollTop: {
      configurable: true,
      get: () => scrollTop,
      set: (next: number) => {
        scrollTop = Math.min(
          Math.max(0, owner.scrollHeight - owner.clientHeight),
          Math.max(0, next),
        );
        scrollWrites.push(scrollTop);
      },
    },
    clientHeight: { configurable: true, value: 100 },
    scrollHeight: {
      configurable: true,
      get: () =>
        Number.parseFloat(
          target.querySelector<HTMLElement>("[data-desktop-feed]")?.style
            .height ?? "0",
        ) + 60,
    },
  });
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
    function (this: HTMLElement) {
      if (this === owner) return box(0, 0, width, 100);
      if (this === footer)
        return box(
          0,
          Number.parseFloat(
            target.querySelector<HTMLElement>("[data-desktop-feed]")!.style
              .height,
          ) - owner.scrollTop,
          width,
          60,
        );
      if (this.matches("[data-desktop-feed-item]"))
        return box(
          Number.parseFloat(this.style.left),
          Number.parseFloat(this.style.top) - owner.scrollTop,
          Number.parseFloat(this.style.width),
          Number.parseFloat(this.style.height),
        );
      if (this.matches("[data-desktop-feed]"))
        return box(
          0,
          -owner.scrollTop,
          width,
          this.style.height === ""
            ? this.children.length > 0
              ? 240
              : 0
            : Number.parseFloat(this.style.height),
        );
      return box(0, 0, width, 100);
    },
  );
  const root = createRoot(target);
  roots.push(root);
  const all = Array.from({ length: count }, (_, index) => ({
    id: String(index),
    media: { width: ratios[index % ratios.length]! * 1000, height: 1000 },
  }));
  const draw = (items = all.slice(0, initialCount), prefix = "") =>
    act(() =>
      root.render(
        <DesktopFeed
          items={items}
          getKey={(item) => item.id}
          renderItem={(item) => (
            <button>
              {prefix}
              {item.id}
            </button>
          )}
        />,
      ),
    );
  draw();
  const node = (key: string) =>
    target.querySelector<HTMLElement>(`[data-desktop-feed-key="${key}"]`)!;
  const scroll = () => act(() => owner.dispatchEvent(new Event("scroll")));
  return {
    owner,
    target,
    footer,
    all,
    draw,
    node,
    scroll,
    scrollWrites,
    pendingFrames: frames,
    frames: async (count = 1) => {
      for (let index = 0; index < count; index++)
        await act(async () => {
          await Promise.resolve();
          const tasks = [...frames.values()];
          frames.clear();
          for (const task of tasks) task(performance.now());
          await Promise.resolve();
        });
    },
    unmount: () => {
      roots.splice(roots.indexOf(root), 1);
      act(() => root.unmount());
    },
    resize: (next: number) => {
      width = next;
      act(() => resize());
    },
  };
};
describe("desktop feed viewport anchoring", () => {
  it("regroups appended pages while keeping the visible content offset and every native DOM identity", () => {
    const view = anchorFixture();
    view.owner.scrollTop = Number.parseFloat(view.node("16").style.top) + 50;
    view.scroll();
    const oldNodes = [
      ...view.target.querySelectorAll<HTMLElement>("[data-desktop-feed-item]"),
    ];
    const anchor = oldNodes.find((node) => {
      const rect = node.getBoundingClientRect();
      return rect.bottom > 0 && rect.top < view.owner.clientHeight;
    })!;
    const key = anchor.dataset.desktopFeedKey!;
    const offset = anchor.getBoundingClientRect().top;
    expect(offset).toBeLessThan(view.owner.clientHeight);
    expect(anchor.getBoundingClientRect().bottom).toBeGreaterThan(0);
    const oldHeight = anchor.getBoundingClientRect().height;
    const focus = vi.spyOn(HTMLElement.prototype, "focus");
    view.draw(view.all);
    // The accepted mosaic can regroup coordinates; the actual reading anchor
    // and native nodes remain owned by this same presentation boundary.
    const nextNodes = [
      ...view.target.querySelectorAll<HTMLElement>("[data-desktop-feed-item]"),
    ];
    oldNodes.forEach((node, index) => expect(nextNodes[index]).toBe(node));
    const after = view.node(key).getBoundingClientRect();
    const readingOffset =
      offset < 0 && after.height + offset <= 0
        ? (offset * after.height) / oldHeight
        : offset;
    expect(after.top).toBeCloseTo(readingOffset);
    expect(after.bottom).toBeGreaterThan(0);
    expect(focus).not.toHaveBeenCalled();
    expect(
      [...view.target.querySelectorAll("button")].map((n) => n.textContent),
    ).toEqual(view.all.map((n) => n.id));
  });
  it("preserves a visible focused card without programmatically moving focus", () => {
    const view = anchorFixture();
    view.owner.scrollTop = Number.parseFloat(view.node("17").style.top) + 50;
    const button = view.node("17").querySelector<HTMLButtonElement>("button")!;
    button.focus();
    view.scroll();
    const offset = view.node("17").getBoundingClientRect().top;
    expect(offset).toBeLessThan(view.owner.clientHeight);
    expect(view.node("17").getBoundingClientRect().bottom).toBeGreaterThan(0);
    const focus = vi.spyOn(HTMLElement.prototype, "focus");
    view.draw(view.all);
    expect(document.activeElement).toBe(button);
    expect(view.node("17").getBoundingClientRect().top).toBeCloseTo(offset);
    expect(focus).not.toHaveBeenCalled();
  });
  it("does not compensate a gallery behind an open native modal", () => {
    const view = anchorFixture();
    view.owner.scrollTop = 310;
    view.scroll();
    const dialog = document.createElement("dialog");
    dialog.setAttribute("open", "");
    document.body.append(dialog);
    view.draw(view.all);
    expect(view.owner.scrollTop).toBe(310);
  });
  it("keeps a deeply clipped focused card visible when responsive sizing makes it shorter", () => {
    const view = anchorFixture({
      initialCount: 28,
      count: 40,
      initialWidth: 704,
      ratios: [0.4],
    });
    const initial = view.node("17").getBoundingClientRect();
    view.owner.scrollTop = initial.top + initial.height - 50;
    expect(view.owner.scrollTop).toBe(initial.top + initial.height - 50);
    const button = view.node("17").querySelector<HTMLButtonElement>("button")!;
    button.focus();
    view.scroll();
    expect(view.node("17").getBoundingClientRect().bottom).toBeGreaterThan(0);
    const focus = vi.spyOn(HTMLElement.prototype, "focus");
    view.resize(1143);
    expect(view.node("17").getBoundingClientRect().height).toBeLessThan(
      initial.height - 50,
    );
    expect(document.activeElement).toBe(button);
    expect(view.node("17").getBoundingClientRect().bottom).toBeGreaterThan(0);
    expect(view.node("17").getBoundingClientRect().top).toBeLessThan(
      view.owner.clientHeight,
    );
    expect(focus).not.toHaveBeenCalled();
  });
  it("compensates through the existing scroll owner when the container resizes", () => {
    const view = anchorFixture();
    view.owner.scrollTop = Number.parseFloat(view.node("10").style.top) + 50;
    view.scroll();
    const offset = view.node("10").getBoundingClientRect().top;
    view.resize(4920);
    expect(view.node("10").getBoundingClientRect().top).toBeCloseTo(offset);
  });
  it("does not fight a hidden or modal-covered source, or a replaced filter result", () => {
    const view = anchorFixture();
    view.owner.scrollTop = 310;
    view.scroll();
    view.owner.setAttribute("inert", "");
    view.draw(view.all);
    expect(view.owner.scrollTop).toBe(310);
    view.owner.removeAttribute("inert");
    view.scroll();
    view.draw(view.all.map((item) => ({ ...item, id: "new-" + item.id })));
    expect(view.owner.scrollTop).toBe(310);
  });
});

const coveredFixture = () =>
  anchorFixture({
    initialCount: 24,
    count: 36,
    initialWidth: 1440,
    ratios: [0.4, 2.8, 0.5, 1, 1.6, 0.6, 2.8, 0.625, 2.4, 1, 0.65],
  });
const cardsShown = (target: HTMLElement) =>
  [
    ...target.querySelectorAll<HTMLButtonElement>(
      "[data-desktop-feed-item] button",
    ),
  ].map((node) => node.textContent);
const focusVisibleOpener = (view: ReturnType<typeof anchorFixture>) => {
  const opener = view.node("21").querySelector<HTMLButtonElement>("button")!;
  const desired = Number.parseFloat(view.node("21").style.top) + 20;
  view.owner.scrollTop = desired;
  expect(view.owner.scrollTop).toBe(desired);
  opener.focus({ preventScroll: true });
  view.scroll();
  return {
    opener,
    top: opener.parentElement!.getBoundingClientRect().top,
    physical: view.owner.scrollTop,
  };
};
describe("desktop feed covered presentation buffer", () => {
  it("holds an append committed with inert, then waits for the shell physical restore before keeping the same opener offset", async () => {
    const view = coveredFixture();
    const { opener, top, physical } = focusVisibleOpener(view);
    const oldGeometry = view.node("21").style.cssText;
    view.owner.setAttribute("inert", "");
    view.scrollWrites.length = 0;
    view.draw(view.all);
    view.resize(1920);
    expect(cardsShown(view.target)).toHaveLength(24);
    expect(view.node("21").style.cssText).toBe(oldGeometry);
    expect(view.scrollWrites).toEqual([]);
    const back = document.createElement("button");
    document.body.append(back);
    back.focus();
    view.owner.setAttribute("data-scroll-restoring", "");
    view.owner.removeAttribute("inert");
    const focus = vi.spyOn(HTMLElement.prototype, "focus");
    window.requestAnimationFrame(() =>
      window.requestAnimationFrame(() => {
        view.owner.scrollTop = physical;
        opener.focus({ preventScroll: true });
        window.requestAnimationFrame(() =>
          view.owner.removeAttribute("data-scroll-restoring"),
        );
      }),
    );
    await view.frames(3);
    expect(cardsShown(view.target)).toHaveLength(24);
    expect(view.node("21").style.cssText).toBe(oldGeometry);
    expect(view.scrollWrites).toEqual([physical]);
    await view.frames(2);
    expect(cardsShown(view.target)).toEqual(view.all.map((item) => item.id));
    expect(view.node("21").style.cssText).not.toBe(oldGeometry);
    expect(view.node("21").getBoundingClientRect().top).toBeCloseTo(top);
    expect(document.activeElement).toBe(opener);
    expect(focus).toHaveBeenCalledExactlyOnceWith({ preventScroll: true });
    expect(view.owner.scrollTop).toBeLessThanOrEqual(
      view.owner.scrollHeight - view.owner.clientHeight,
    );
  });
  it("reserves pending layout extent so the real pagination footer leaves its 300px observer margin while cards remain held", () => {
    const view = coveredFixture();
    view.owner.scrollTop =
      view.owner.scrollHeight - view.owner.clientHeight - 100;
    view.scroll();
    const host = view.target.querySelector<HTMLElement>("[data-desktop-feed]")!;
    const oldHeight = Number.parseFloat(host.style.height);
    const oldPositions = [
      ...view.target.querySelectorAll<HTMLElement>("[data-desktop-feed-item]"),
    ].map((node) => node.style.cssText);
    expect(view.footer.getBoundingClientRect().top).toBeLessThan(
      view.owner.clientHeight + 300,
    );
    view.owner.setAttribute("inert", "");
    view.scrollWrites.length = 0;
    view.draw(view.all);
    expect(Number.parseFloat(host.style.height)).toBeGreaterThan(oldHeight);
    expect(view.footer.getBoundingClientRect().top).toBeGreaterThan(
      view.owner.clientHeight + 300,
    );
    expect(cardsShown(view.target)).toHaveLength(24);
    expect(
      [
        ...view.target.querySelectorAll<HTMLElement>(
          "[data-desktop-feed-item]",
        ),
      ].map((node) => node.style.cssText),
    ).toEqual(oldPositions);
    expect(view.scrollWrites).toEqual([]);
    expect(view.owner.scrollTop).toBeLessThanOrEqual(
      view.owner.scrollHeight - view.owner.clientHeight,
    );
  });
  it("does not reserve less than the displayed extent when a covered pending filter is shorter", () => {
    const view = coveredFixture();
    focusVisibleOpener(view);
    const host = view.target.querySelector<HTMLElement>("[data-desktop-feed]")!;
    const oldHeight = Number.parseFloat(host.style.height);
    view.owner.setAttribute("inert", "");
    view.scrollWrites.length = 0;
    view.draw(view.all.slice(0, 2));
    expect(Number.parseFloat(host.style.height)).toBe(oldHeight);
    expect(cardsShown(view.target)).toHaveLength(24);
    expect(view.scrollWrites).toEqual([]);
    expect(view.owner.scrollTop).toBeLessThanOrEqual(
      view.owner.scrollHeight - view.owner.clientHeight,
    );
  });
  it.each(["inert", "hidden", "aria-hidden"])(
    "retains the shown records and width while covered by %s",
    async (attribute) => {
      const view = coveredFixture();
      const { opener, top } = focusVisibleOpener(view);
      const geometry = view.node("21").style.cssText;
      view.owner.setAttribute(
        attribute,
        attribute === "aria-hidden" ? "true" : "",
      );
      view.scrollWrites.length = 0;
      view.draw(view.all);
      view.resize(1920);
      await view.frames(4);
      expect(cardsShown(view.target)).toHaveLength(24);
      expect(view.node("21").style.cssText).toBe(geometry);
      expect(view.scrollWrites).toEqual([]);
      view.owner.removeAttribute(attribute);
      await view.frames(2);
      expect(cardsShown(view.target)).toHaveLength(36);
      expect(document.activeElement).toBe(opener);
      expect(view.node("21").getBoundingClientRect().top).toBeCloseTo(top);
    },
  );
  it.each(["close", "remove"])(
    "holds behind an external native dialog until %s",
    async (action) => {
      const view = coveredFixture();
      const { opener, top } = focusVisibleOpener(view);
      const dialog = document.createElement("dialog");
      dialog.setAttribute("open", "");
      document.body.append(dialog);
      view.scrollWrites.length = 0;
      view.draw(view.all);
      await view.frames(2);
      expect(cardsShown(view.target)).toHaveLength(24);
      expect(view.scrollWrites).toEqual([]);
      if (action === "close") dialog.removeAttribute("open");
      else dialog.remove();
      await view.frames(2);
      expect(cardsShown(view.target)).toHaveLength(36);
      expect(document.activeElement).toBe(opener);
      expect(view.node("21").getBoundingClientRect().top).toBeCloseTo(top);
    },
  );
  it("holds the previous render callback with its records until the pending presentation is eligible", async () => {
    const view = coveredFixture();
    focusVisibleOpener(view);
    view.owner.setAttribute("inert", "");
    view.draw(view.all, "pending:");
    expect(cardsShown(view.target)).toEqual(
      view.all.slice(0, 24).map((item) => item.id),
    );
    view.owner.removeAttribute("inert");
    await view.frames(2);
    expect(cardsShown(view.target)).toEqual(
      view.all.map((item) => "pending:" + item.id),
    );
  });
  it("cancels a pending visible release when a new cover appears during the quiet frames", async () => {
    const view = coveredFixture();
    focusVisibleOpener(view);
    view.owner.setAttribute("inert", "");
    view.draw(view.all);
    view.owner.removeAttribute("inert");
    await view.frames(1);
    view.owner.setAttribute("inert", "");
    await view.frames(2);
    expect(cardsShown(view.target)).toHaveLength(24);
    view.owner.removeAttribute("inert");
    await view.frames(2);
    expect(cardsShown(view.target)).toHaveLength(36);
  });
  it("applies a replaced filter after return without transferring the old source anchor", async () => {
    const view = coveredFixture();
    focusVisibleOpener(view);
    view.owner.setAttribute("inert", "");
    const replaced = view.all.map((item) => ({
      ...item,
      id: "new-" + item.id,
    }));
    view.draw(replaced);
    expect(cardsShown(view.target)).toHaveLength(24);
    view.owner.removeAttribute("inert");
    view.scrollWrites.length = 0;
    const focus = vi.spyOn(HTMLElement.prototype, "focus");
    await view.frames(2);
    expect(cardsShown(view.target)).toEqual(replaced.map((item) => item.id));
    expect(view.scrollWrites).toEqual([]);
    expect(focus).not.toHaveBeenCalled();
  });
  it("cancels visibility frames and observers when unmounted", async () => {
    const view = coveredFixture();
    focusVisibleOpener(view);
    view.owner.setAttribute("inert", "");
    view.draw(view.all);
    view.owner.removeAttribute("inert");
    await view.frames(1);
    expect(view.pendingFrames.size).toBeGreaterThan(0);
    view.unmount();
    expect(view.pendingFrames.size).toBe(0);
    view.scrollWrites.length = 0;
    view.owner.setAttribute("inert", "");
    view.owner.removeAttribute("inert");
    await view.frames(3);
    expect(view.pendingFrames.size).toBe(0);
    expect(view.scrollWrites).toEqual([]);
  });
});

describe("desktop feed empty presentation readiness", () => {
  it("accepts active empty content followed by populated content with a truthful zero-height feed", () => {
    const view = anchorFixture({
      initialCount: 0,
      count: 12,
      initialWidth: 1440,
    });
    const host = view.target.querySelector<HTMLElement>("[data-desktop-feed]")!;
    expect(host.getBoundingClientRect().height).toBe(0);
    expect(cardsShown(view.target)).toEqual([]);
    view.draw(view.all);
    expect(cardsShown(view.target)).toEqual(view.all.map((item) => item.id));
    expect(host.getBoundingClientRect().height).toBeGreaterThan(0);
  });
  it("clears displayed records when the active result becomes empty instead of retaining stale cards", () => {
    const view = anchorFixture();
    expect(cardsShown(view.target).length).toBeGreaterThan(0);
    view.draw([]);
    expect(cardsShown(view.target)).toEqual([]);
    expect(
      view.target
        .querySelector<HTMLElement>("[data-desktop-feed]")!
        .getBoundingClientRect().height,
    ).toBe(0);
  });
  it("keeps an initially hidden empty result held until visible, then applies pending data", async () => {
    const view = anchorFixture({
      initialCount: 0,
      count: 12,
      initialWidth: 1440,
      initiallyHidden: true,
    });
    expect(
      view.target
        .querySelector<HTMLElement>("[data-desktop-feed]")!
        .getBoundingClientRect().height,
    ).toBe(0);
    view.draw(view.all);
    await view.frames(3);
    expect(cardsShown(view.target)).toEqual([]);
    view.owner.removeAttribute("hidden");
    await view.frames(2);
    expect(cardsShown(view.target)).toEqual(view.all.map((item) => item.id));
  });
  it("rechecks a held empty presentation when CSS width returns without an attribute or measured-width state change", async () => {
    const view = anchorFixture({
      initialCount: 0,
      count: 12,
      initialWidth: 1440,
    });
    view.resize(0);
    await view.frames(1);
    view.draw(view.all);
    expect(cardsShown(view.target)).toEqual([]);
    view.resize(1440);
    await view.frames(2);
    expect(cardsShown(view.target)).toEqual(view.all.map((item) => item.id));
  });
});

describe("desktop feed cold first layout bootstrap", () => {
  it("prepares measured geometry for a never-visible inert gallery while retaining its held records and callbacks", async () => {
    const view = anchorFixture({
      initialCount: 24,
      count: 36,
      initialWidth: 1440,
      initiallyInert: true,
      ratios: [0.4, 2.8, 0.5, 1, 1.6, 0.6, 2.8, 0.625, 2.4, 1, 0.65],
    });
    const host = view.target.querySelector<HTMLElement>("[data-desktop-feed]")!;
    expect(host.dataset.layoutReady).toBe("true");
    const measuredWidth = Number.parseFloat(view.node("0").style.width);
    expect(measuredWidth).toBeGreaterThan(96);
    expect(measuredWidth).toBeLessThan(1440);
    // The ideal fallback can have this same shape. Its measured RTL position
    // must be prepared before visibility, rather than remaining at fallback x=0.
    expect(Number.parseFloat(view.node("0").style.left)).toBeCloseTo(
      1440 - measuredWidth,
      8,
    );
    expect(Number.parseFloat(view.node("0").style.left)).toBeGreaterThan(0);
    const oldNodes = [
      ...view.target.querySelectorAll<HTMLElement>("[data-desktop-feed-item]"),
    ];
    const styles = oldNodes.map((node) => node.style.cssText);
    view.scrollWrites.length = 0;
    view.draw(view.all, "pending:");
    expect(cardsShown(view.target)).toEqual(
      view.all.slice(0, 24).map((item) => item.id),
    );
    view.owner.setAttribute("data-scroll-restoring", "");
    view.owner.removeAttribute("inert");
    view.owner.removeAttribute("aria-hidden");
    await view.frames(4);
    expect(host.dataset.layoutReady).toBe("true");
    expect(
      [
        ...view.target.querySelectorAll<HTMLElement>(
          "[data-desktop-feed-item]",
        ),
      ].map((n) => n.style.cssText),
    ).toEqual(styles);
    expect(cardsShown(view.target)).toHaveLength(24);
    expect(view.scrollWrites).toEqual([]);
    view.owner.removeAttribute("data-scroll-restoring");
    await view.frames(2);
    expect(cardsShown(view.target)).toEqual(
      view.all.map((item) => "pending:" + item.id),
    );
    const nextNodes = [
      ...view.target.querySelectorAll<HTMLElement>("[data-desktop-feed-item]"),
    ];
    oldNodes.forEach((node, index) => expect(nextNodes[index]).toBe(node));
    expect(view.scrollWrites).toEqual([]);
  });
  it("bootstraps the first positive measured width before an initially zero-width inert gallery is revealed", async () => {
    const view = anchorFixture({
      initialCount: 12,
      count: 24,
      initialWidth: 0,
      initiallyInert: true,
    });
    const host = view.target.querySelector<HTMLElement>("[data-desktop-feed]")!;
    expect(host.dataset.layoutReady).toBe("false");
    view.resize(1440);
    expect(host.dataset.layoutReady).toBe("true");
    const geometry = view.node("0").style.cssText;
    const measuredWidth = Number.parseFloat(view.node("0").style.width);
    expect(measuredWidth).toBeGreaterThan(96);
    expect(measuredWidth).toBeLessThan(1440);
    expect(Number.parseFloat(view.node("0").style.left)).toBeCloseTo(
      1440 - measuredWidth,
      8,
    );
    expect(Number.parseFloat(view.node("0").style.left)).toBeGreaterThan(0);
    expect(view.owner.hasAttribute("inert")).toBe(true);
    view.owner.removeAttribute("inert");
    view.owner.removeAttribute("aria-hidden");
    await view.frames(2);
    expect(view.node("0").style.cssText).toBe(geometry);
    expect(view.scrollWrites).toEqual([]);
  });
});

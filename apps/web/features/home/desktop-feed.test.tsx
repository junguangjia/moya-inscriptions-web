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
const anchorFixture = () => {
  let width = 3440;
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
  const target = document.createElement("div");
  owner.append(target);
  document.body.append(owner);
  Object.defineProperties(owner, {
    clientHeight: { configurable: true, value: 100 },
    scrollHeight: {
      configurable: true,
      get: () =>
        Number.parseFloat(
          target.querySelector<HTMLElement>("[data-desktop-feed]")?.style
            .height ?? "0",
        ),
    },
  });
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
    function (this: HTMLElement) {
      if (this === owner) return box(0, 0, width, 100);
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
          Number.parseFloat(this.style.height) || 240,
        );
      return box(0, 0, width, 100);
    },
  );
  const root = createRoot(target);
  roots.push(root);
  const all = Array.from({ length: 37 }, (_, index) => ({
    id: String(index),
    media: { width: 500, height: 1000 },
  }));
  const draw = (items = all.slice(0, 25)) =>
    act(() =>
      root.render(
        <DesktopFeed
          items={items}
          getKey={(item) => item.id}
          renderItem={(item) => <button>{item.id}</button>}
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
    all,
    draw,
    node,
    scroll,
    resize: (next: number) => {
      width = next;
      act(() => resize());
    },
  };
};
describe("desktop feed viewport anchoring", () => {
  it("fills the previous tail on append while keeping its visible content at the same viewport offset", () => {
    const view = anchorFixture();
    view.owner.scrollTop = 310;
    view.scroll();
    const offset = view.node("15").getBoundingClientRect().top;
    const oldY = Number.parseFloat(view.node("15").style.top);
    const focus = vi.spyOn(HTMLElement.prototype, "focus");
    view.draw(view.all);
    expect(Number.parseFloat(view.node("15").style.top)).not.toBe(oldY);
    expect(view.node("15").getBoundingClientRect().top).toBeCloseTo(offset);
    expect(focus).not.toHaveBeenCalled();
    expect(
      [...view.target.querySelectorAll("button")].map((n) => n.textContent),
    ).toEqual(view.all.map((n) => n.id));
  });
  it("preserves a visible focused card without programmatically moving focus", () => {
    const view = anchorFixture();
    view.owner.scrollTop = 310;
    const button = view.node("17").querySelector<HTMLButtonElement>("button")!;
    button.focus();
    view.scroll();
    const offset = view.node("17").getBoundingClientRect().top;
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
  it("compensates through the existing scroll owner when the container resizes", () => {
    const view = anchorFixture();
    view.owner.scrollTop = 310;
    view.scroll();
    const offset = view.node("15").getBoundingClientRect().top;
    view.resize(4920);
    expect(view.node("15").getBoundingClientRect().top).toBeCloseTo(offset);
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

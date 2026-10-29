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
  it("does not move an earlier terminal row when a new page is appended", () => {
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
      width: 672,
      height: 900,
      x: 0,
      y: 0,
      top: 0,
      bottom: 900,
      left: 0,
      right: 672,
      toJSON() {
        return {};
      },
    });
    const items = [
      0.4, 1, 2.8, 0.6, 1.6, 1, 0.6, 1, 0.625, 2.4, 1, 1, 0.5, 1.5, 0.65, 2.8,
      0.4, 2.4,
    ].map((ratio, index) => ({
      id: String(index),
      media: { width: ratio * 100, height: 100 },
    }));
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    roots.push(root);
    const renderItem = (item: (typeof items)[number]) => <p>{item.id}</p>;
    act(() =>
      root.render(
        <DesktopFeed
          items={items.slice(0, 12)}
          getKey={(item) => item.id}
          renderItem={renderItem}
        />,
      ),
    );
    const before = [
      ...host.querySelectorAll<HTMLElement>("[data-desktop-feed-item]"),
    ].map((n) => n.style.cssText);
    act(() =>
      root.render(
        <DesktopFeed
          items={items}
          getKey={(item) => item.id}
          renderItem={renderItem}
        />,
      ),
    );
    const after = [
      ...host.querySelectorAll<HTMLElement>("[data-desktop-feed-item]"),
    ].map((n) => n.style.cssText);
    expect(after.slice(0, 12)).toEqual(before);
    expect(after).toHaveLength(18);
  });
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

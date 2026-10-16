// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { shell } = vi.hoisted(() => ({
  shell: { current: null as { browseOnly?: boolean } | null },
}));
vi.mock("../shell/browse-only-context", () => ({
  useBrowseOnly: () => shell.current?.browseOnly === true,
}));
vi.mock("./content-actions", () => ({
  useContentActions: () => ({
    environment: { onAction: vi.fn(), likedIds: [], favoriteIds: [] },
  }),
}));

import { CatalogCard } from "../home/catalog-card";
import { LiveCatalogCards } from "./live-catalog-cards";

import type { CatalogId, CatalogSummary, MediaId } from "@moya/contracts";
import type { Root } from "react-dom/client";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const item = {
  aliases: [],
  id: "catalog-live-card" as CatalogId,
  kind: "inscription",
  representativeMedia: {
    alt: "碑刻代表图",
    height: 800,
    id: "media-live-card" as MediaId,
    kind: "image",
    src: "/catalog-live-card.jpg",
    width: 600,
  },
  title: "石门颂",
} as CatalogSummary;

const roots: Root[] = [];
const onOpen = vi.fn();
const tree = () => (
  <LiveCatalogCards>
    <CatalogCard item={item} variant="feed" onOpenCatalog={onOpen} />
  </LiveCatalogCards>
);
const render = () => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  act(() => root.render(tree()));
  return { container, root };
};
const opener = (container: HTMLElement) =>
  container.querySelector<HTMLButtonElement>(
    'button[aria-label="打开石门颂"]',
  )!;
const press = (target: EventTarget, type: string) => {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperties(event, {
    pointerId: { value: 1 },
    pointerType: { value: "touch" },
    isPrimary: { value: true },
    button: { value: 0 },
    clientX: { value: 180 },
    clientY: { value: 400 },
  });
  act(() => {
    target.dispatchEvent(event);
  });
};
const hold = (button: HTMLButtonElement) => {
  press(button, "pointerdown");
  act(() => vi.advanceTimersByTime(400));
};
const menu = () => document.querySelector("[data-quick-action-menu]");

beforeEach(() => {
  vi.useFakeTimers();
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    value: "visible",
  });
});
afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  document.body.replaceChildren();
  shell.current = null;
  vi.useRealTimers();
  vi.clearAllMocks();
});

/*
 * pc-browse-only-v1: wide screens without an account only browse. Live
 * Catalog cards fall back to the plain opener: a click opens Detail and a
 * long press opens no menu.
 */
describe("LiveCatalogCards browse-only", () => {
  it("opens Detail on a click and opens no menu on a 400 ms hold", () => {
    shell.current = { browseOnly: true };
    const { container } = render();
    expect(container.querySelector("[data-quick-actions]")).toBeNull();
    const button = opener(container);
    expect(button.hasAttribute("data-open-catalog")).toBe(true);
    hold(button);
    press(window, "pointerup");
    expect(menu()).toBeNull();
    act(() => button.click());
    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(onOpen).toHaveBeenCalledWith(item, button);
  });

  it.each([
    ["a shell that is not browse-only", { browseOnly: false }],
    ["a partial shell", {}],
    ["no shell", null],
  ] as const)("keeps the long-press menu and click with %s", (_, value) => {
    shell.current = value;
    const { container } = render();
    const button = container.querySelector<HTMLButtonElement>(
      '[data-quick-actions="enabled"]',
    )!;
    expect(button).toBe(opener(container));
    expect(button.hasAttribute("data-open-catalog")).toBe(true);
    act(() => button.click());
    expect(onOpen).toHaveBeenCalledWith(item, button);
    hold(button);
    expect(menu()).not.toBeNull();
    press(window, "pointerup");
    expect(menu()).toBeNull();
  });

  it("switches modes on a resize without remounting the card media", () => {
    shell.current = { browseOnly: false };
    const { container, root } = render();
    const image = container.querySelector("img");
    expect(image).not.toBeNull();
    shell.current = { browseOnly: true };
    act(() => root.render(tree()));
    expect(container.querySelector("img")).toBe(image);
    expect(container.querySelector("[data-quick-actions]")).toBeNull();
    shell.current = { browseOnly: false };
    act(() => root.render(tree()));
    expect(container.querySelector("img")).toBe(image);
    expect(
      container.querySelector('[data-quick-actions="enabled"]'),
    ).not.toBeNull();
  });
});

// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Root } from "react-dom/client";
import type {
  CatalogId,
  CatalogSummary,
  MediaId,
  ContentCard as Card,
} from "@moya/contracts";
import type { MediaSlot } from "../media/responsive-media";
const { shell, slot } = vi.hoisted(() => ({
  shell: { openContent: vi.fn(), browseOnly: false },
  slot: { value: null as MediaSlot | null },
}));
vi.mock("../product-shell/product-shell", () => ({
  useProductShell: () => shell,
}));
vi.mock("./catalog-masonry", () => ({
  useMasonrySlot: () => slot.value,
  useFeedPostSlot: () => false,
}));
vi.mock("../authors/content-actions", () => ({
  useContentActions: () => ({
    environment: { likedIds: [], favoriteIds: [], onAction: vi.fn() },
  }),
}));
import { ContentCard } from "../authors/content-card";
import { CatalogCardPresentation } from "./catalog-card";
(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
const roots: Root[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) act(() => r.unmount());
  document.body.replaceChildren();
  vi.clearAllMocks();
  shell.browseOnly = false;
});
const source = {
  id: `item-${"a".repeat(32)}`,
  src: `/api/community/publishing/media/item-${"a".repeat(32)}/cover/base`,
  width: 600,
  height: 800,
};
const base: Card = {
  aliases: [],
  target: { type: "work", id: `work-${"b".repeat(32)}` },
  title: "临帖",
  kind: null,
  authorId: null,
  firstPublishedAt: null,
  media: source,
};
const render = (overrides: Partial<Card> = {}) => {
  slot.value = {
    platform: "pc",
    columns: 1,
    span: false,
    desktop: { mediaWidth: 180, height: 240, cropped: false },
  };
  const host = document.createElement("div");
  document.body.append(host);
  const r = createRoot(host);
  roots.push(r);
  act(() => r.render(<ContentCard item={{ ...base, ...overrides }} />));
  return host;
};
describe("desktop native content card", () => {
  it("passes the Catalog category's real summary into the vertical caption", () => {
    render();
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    roots.push(root);
    const item: CatalogSummary = {
      aliases: [],
      id: "catalog-synthetic-caption" as CatalogId,
      kind: "inscription",
      title: "合成题刻",
      summary: "馆藏列表已有的实际摘要",
      representativeMedia: {
        ...source,
        id: "media-synthetic-caption" as MediaId,
        kind: "image",
        alt: "合成馆藏图像",
      },
    };
    const open = vi.fn();
    act(() =>
      root.render(
        <CatalogCardPresentation
          item={item}
          variant="feed"
          onOpenCatalog={open}
        />,
      ),
    );
    expect(host.querySelector("[data-card-caption-excerpt]")?.textContent).toBe(
      item.summary,
    );
    const opener = host.querySelector<HTMLButtonElement>("button")!;
    act(() => opener.click());
    expect(open).toHaveBeenCalledWith(item, opener);
  });
  it("opens the same identity with the existing quick-action opener and resolved media", () => {
    const host = render();
    expect(host.querySelector("img")?.getAttribute("src")).toBe(source.src);
    const button = host.querySelector<HTMLButtonElement>(
      '[data-quick-actions="enabled"]',
    )!;
    act(() => button.click());
    expect(shell.openContent).toHaveBeenCalledWith(base.target, button);
    expect(host.textContent).toContain("作品");
  });
  it("keeps anonymous browsing a plain opener without adding quick actions", () => {
    shell.browseOnly = true;
    const host = render();
    expect(host.querySelector("[data-quick-actions]")).toBeNull();
    const button = host.querySelector<HTMLButtonElement>("button")!;
    act(() => button.click());
    expect(shell.openContent).toHaveBeenCalledWith(base.target, button);
  });
  it("keeps untitled text-only posts truthful and retains their existing detail label", () => {
    const host = render({ title: "", media: null, excerpt: "正文的第一段" });
    expect(host.querySelector("h3")).toBeNull();
    expect(host.querySelector("img,[data-catalog-media-state]")).toBeNull();
    expect(host.querySelector("[data-card-excerpt]")?.textContent).toBe(
      "正文的第一段",
    );
    expect(host.querySelector("button")?.getAttribute("aria-label")).toBe(
      "打开未命名作品",
    );
  });
});

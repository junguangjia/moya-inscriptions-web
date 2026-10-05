// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { ReactElement } from "react";
import type { Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

/*
 * content-community-completion-v1: the feed's pictures go through
 * editorialMediaSrc, so a loopback Payload cover reaches a phone on the LAN
 * acceptance origin through the Web origin.
 */
const file = `${"a".repeat(64)}-${"b".repeat(64)}.png`;
const id = `article-${"4".repeat(32)}`;
const loopbackItem = {
  id,
  title: "近闻示例（示例）",
  summary: "合成示例",
  section: null,
  byline: "编辑部",
  publishedAt: "2026-09-24T00:00:00.000Z",
  cover: {
    src: `http://127.0.0.1:3522/api/media/file/${file}`,
    alt: "封面",
  },
};
const { fixture } = vi.hoisted(() => ({
  fixture: { items: [] as object[] },
}));
vi.mock("../product-shell/product-shell", () => ({
  useProductShell: () => ({ openTopic: vi.fn() }),
}));
vi.mock("./use-editorial-content", () => ({
  useArticles: () => ({
    state: { state: "populated", hasMore: false, items: fixture.items },
    busy: false,
    retry: vi.fn(),
    loadMore: vi.fn(),
  }),
}));
import { EditorialNewsFeed, EditorialTopicsFeed } from "./editorial-feed";
import { MEDIA_SIZES } from "../media/responsive-media";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root | null = null;
afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  document.body.replaceChildren();
});
const render = async (element: ReactElement) => {
  const node = document.createElement("div");
  document.body.append(node);
  root = createRoot(node);
  await act(async () => root!.render(element));
  return node;
};

describe("EditorialNewsFeed pictures", () => {
  it("serves a loopback Payload cover through the Web origin, named by its Article", async () => {
    fixture.items = [loopbackItem];
    const node = await render(<EditorialNewsFeed />);
    expect(node.querySelector("img")?.getAttribute("src")).toBe(
      `/api/editorial-media/${id}/${file}`,
    );
  });
});

/*
 * unified-media-pipeline-v1 (CW13): feed covers offer their card candidates,
 * reserve the anchor's size and show the asset colour in their covered box.
 */
describe("Editorial feed responsive covers", () => {
  const origin = "https://media.example.invalid/editorial";
  const webp = "image/webp";
  const catalogCover = {
    id: "media-cover",
    kind: "image",
    alt: "封面",
    src: `${origin}/1200.webp`,
    width: 1200,
    height: 800,
    placeholderColor: "#4d4237",
    renditions: [
      { src: `${origin}/480.webp`, width: 480, height: 320, contentType: webp },
      {
        src: `${origin}/1200.webp`,
        width: 1200,
        height: 800,
        contentType: webp,
      },
    ],
  };
  const item = `media-item-${"6".repeat(32)}`;
  const managedPath = (variant: string) =>
    `/api/community/publishing/media/${item}/${variant}/base`;
  const managedCover = {
    id: item,
    src: managedPath("display"),
    width: 1536,
    height: 2048,
    renditions: [
      { src: managedPath("thumb"), width: 360, height: 480, contentType: webp },
      {
        src: managedPath("display"),
        width: 1536,
        height: 2048,
        contentType: webp,
      },
    ],
  };
  const article = (n: number, covers: object) => ({
    ...loopbackItem,
    id: `article-${String(n).repeat(32)}`,
    ...covers,
  });

  it("sizes large and compact news covers by their boxes", async () => {
    fixture.items = [
      article(1, { cover: catalogCover }),
      article(2, { cover: null, managedCover }),
    ];
    const node = await render(<EditorialNewsFeed />);
    const [large, compact] = node.querySelectorAll("img");
    expect(large?.getAttribute("src")).toBe(`${origin}/1200.webp`);
    expect(large?.getAttribute("srcset")).toBe(
      `${origin}/480.webp 480w, ${origin}/1200.webp 1200w`,
    );
    expect(large?.getAttribute("sizes")).toBe(
      MEDIA_SIZES.editorialLarge(catalogCover),
    );
    expect(large?.getAttribute("width")).toBe("1200");
    expect(large?.getAttribute("height")).toBe("800");
    expect(large?.style.backgroundColor).toBe("rgb(77, 66, 55)");
    expect(compact?.getAttribute("src")).toBe(managedPath("display"));
    expect(compact?.getAttribute("srcset")).toBe(
      `${managedPath("thumb")} 360w, ${managedPath("display")} 1536w`,
    );
    expect(compact?.getAttribute("sizes")).toBe(
      MEDIA_SIZES.editorialCompact(managedCover),
    );
    expect(compact?.getAttribute("width")).toBe("1536");
    // A managed cover without a colour gets none.
    expect(compact?.style.backgroundColor).toBe("");
  });

  it("sizes academic special covers by the tall card box", async () => {
    fixture.items = [article(3, { cover: catalogCover })];
    const node = await render(<EditorialTopicsFeed />);
    const image = node.querySelector("img")!;
    expect(image.getAttribute("sizes")).toBe(
      MEDIA_SIZES.editorialSpecial(catalogCover),
    );
    expect(image.getAttribute("srcset")).toContain("480w");
    expect(image.getAttribute("height")).toBe("800");
    expect(image.style.backgroundColor).toBe("rgb(77, 66, 55)");
  });
});

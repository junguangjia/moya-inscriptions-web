// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

const { shell, contentActions } = vi.hoisted(() => ({
  shell: { openContent: vi.fn() },
  contentActions: vi.fn(),
}));
vi.mock("../product-shell/product-shell", () => ({
  useProductShell: () => shell,
}));
vi.mock("./content-actions", () => ({
  useContentActions: (...args: unknown[]) => {
    contentActions(...args);
    return {
      environment: { onAction: vi.fn(), likedIds: [], favoriteIds: [] },
    };
  },
}));

import { ContentCard } from "./content-card";

import type { ContentCard as Card } from "@moya/contracts";
import type { Root } from "react-dom/client";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const workId = `work-${"d".repeat(32)}`;
const itemId = `item-${"e".repeat(32)}`;
const cover = {
  id: itemId,
  src: `/api/community/publishing/media/${itemId}/cover/base`,
  width: 600,
  height: 800,
};
const card = (overrides: Partial<Card>): Card => ({
  aliases: [],
  target: { type: "work", id: workId },
  title: "春日临帖",
  kind: null,
  authorId: `user-${"f".repeat(32)}`,
  firstPublishedAt: "2026-09-13T12:00:00.000Z",
  media: cover,
  ...overrides,
});

const roots: Root[] = [];
const render = (item: Card, variant?: "feed" | "inscription") => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  act(() =>
    root.render(<ContentCard item={item} {...(variant ? { variant } : {})} />),
  );
  return container.querySelector<HTMLElement>("article")!;
};

afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  document.body.replaceChildren();
  vi.clearAllMocks();
});

describe("ContentCard for works", () => {
  it("marks a Live Photo cover with a static LIVE badge and nothing that plays", () => {
    const live = render(card({ live: true }));
    const badge = live.querySelector("[data-card-live-badge]");
    expect(badge?.textContent).toBe("LIVE");
    expect(badge?.getAttribute("aria-label")).toBe("实况照片");
    // The badge sits on the valid cover itself.
    expect(badge?.closest('[data-catalog-media-state="valid"]')).not.toBeNull();
    expect(live.querySelector("video")).toBeNull();
    expect(live.querySelector("img")?.getAttribute("src")).toBe(cover.src);
  });

  it("shows no LIVE badge on a static cover, on an unset flag or without a cover", () => {
    expect(
      render(card({ live: false })).querySelector("[data-card-live-badge]"),
    ).toBeNull();
    expect(render(card({})).querySelector("[data-card-live-badge]")).toBeNull();
    expect(
      render(
        card({ live: true, media: null, excerpt: "只有文字" }),
      ).querySelector("[data-card-live-badge]"),
    ).toBeNull();
  });

  it("renders a text-only work as its own excerpt, with no invented cover", () => {
    const text = render(
      card({ media: null, excerpt: "第一行正文\n第二行正文" }),
    );
    expect(text.hasAttribute("data-card-text-only")).toBe(true);
    expect(text.querySelector("[data-catalog-media-state]")).toBeNull();
    expect(text.querySelector("img")).toBeNull();
    expect(text.textContent).not.toContain("暂无公开图像");
    expect(text.querySelector("h3")?.textContent).toBe("春日临帖");
    expect(text.querySelector("[data-card-excerpt]")?.textContent).toBe(
      "第一行正文\n第二行正文",
    );
  });

  it("keeps an untitled text-only work's title empty and uses the excerpt alone", () => {
    const text = render(card({ title: "", media: null, excerpt: "无题正文" }));
    expect(text.querySelector("h3")).toBeNull();
    expect(text.querySelector("[data-card-excerpt]")?.textContent).toBe(
      "无题正文",
    );
    // Labels and share text use the UI-only name; the stored title stays empty.
    expect(
      text.querySelector("[data-quick-actions]")?.getAttribute("aria-label"),
    ).toBe("打开未命名作品");
    expect(contentActions).toHaveBeenCalledWith(
      { type: "work", id: workId },
      "未命名作品",
    );
  });

  it("gives an untitled card with media the body opening as its text line", () => {
    // C07: the stored title stays empty and no placeholder is drawn into the
    // card; the opening of the body is the line the reader gets instead.
    const untitled = render(card({ title: "", excerpt: "正文开头做标题行" }));
    expect(untitled.hasAttribute("data-card-text-only")).toBe(false);
    expect(untitled.querySelector("img")?.getAttribute("src")).toBe(cover.src);
    expect(untitled.querySelector("h3")).toBeNull();
    expect(untitled.querySelector("[data-card-excerpt]")?.textContent).toBe(
      "正文开头做标题行",
    );
    expect(untitled.textContent).not.toContain("未命名作品");
  });

  it("lets a media-only work omit its empty title", () => {
    const mediaOnly = render(card({ title: "" }));
    expect(mediaOnly.querySelector("img")).not.toBeNull();
    expect(mediaOnly.querySelector("h3")).toBeNull();
    expect(mediaOnly.querySelector("[data-card-excerpt]")).toBeNull();
    expect(mediaOnly.textContent).toBe("");
  });

  it("shows province only for official catalog cards, never user works", () => {
    const catalog = render(
      card({
        target: { type: "catalog", id: "catalog-province" } as Card["target"],
        kind: "inscription",
        authorId: null,
        province: "山东",
      }),
    );
    expect(catalog.querySelector("[data-catalog-province]")?.textContent).toBe(
      "山东",
    );
    expect(
      render(card({ province: "山东" })).querySelector(
        "[data-catalog-province]",
      ),
    ).toBeNull();
    expect(
      render(
        card({
          target: {
            type: "catalog",
            id: "catalog-no-province",
          } as Card["target"],
          kind: "inscription",
          authorId: null,
        }),
      ).querySelector("[data-catalog-province]"),
    ).toBeNull();
  });

  it("crops panoramas and scrolls in cards without changing original media dimensions", () => {
    for (const [width, height, ratio] of [
      [3000, 300, "1.5"],
      [300, 3000, "0.75"],
    ] as const) {
      const view = render(card({ media: { ...cover, width, height } }));
      const image = view.querySelector("img")!;
      expect(image.getAttribute("width")).toBe(String(width));
      expect(image.getAttribute("height")).toBe(String(height));
      expect(
        (image.parentElement as HTMLElement).style.getPropertyValue(
          "--feed-media-ratio",
        ),
      ).toBe(ratio);
    }
  });

  it("keeps a titled media card and its activation unchanged", () => {
    const titled = render(card({ excerpt: "正文开头" }));
    expect(titled.querySelector("h3")?.textContent).toBe("春日临帖");
    expect(titled.querySelector("[data-card-excerpt]")).toBeNull();
    const action = titled.querySelector<HTMLButtonElement>(
      "[data-quick-actions]",
    )!;
    act(() => action.click());
    expect(shell.openContent).toHaveBeenCalledWith(
      { type: "work", id: workId },
      action,
    );
  });
});

/*
 * unified-media-pipeline-v1 (CW4): a work card carries the candidates of its
 * cover framing with `src` (the cover still) as the anchor; a Catalog card
 * carries Catalog card candidates.
 */
describe("ContentCard responsive media", () => {
  const coverPath = (variant: string) =>
    `/api/community/publishing/media/${itemId}/${variant}/${"3".repeat(32)}`;
  const coverCandidates = [
    {
      src: coverPath("thumb"),
      width: 480,
      height: 640,
      contentType: "image/webp" as const,
    },
    {
      src: coverPath("cover"),
      width: 810,
      height: 1080,
      contentType: "image/webp" as const,
    },
  ];
  const coverMedia = {
    id: itemId,
    src: coverPath("cover"),
    width: 810,
    height: 1080,
    renditions: coverCandidates,
    placeholderColor: "#3c3a35",
  };
  afterEach(() => vi.unstubAllEnvs());

  it("uses the cover candidates while src stays the cover still", () => {
    const view = render(card({ media: coverMedia }));
    const image = view.querySelector("img")!;
    expect(image.getAttribute("src")).toBe(coverPath("cover"));
    expect(image.getAttribute("srcset")).toBe(
      `${coverPath("thumb")} 480w, ${coverPath("cover")} 810w`,
    );
    expect(image.getAttribute("sizes")).not.toBeNull();
    expect(image.getAttribute("width")).toBe("810");
    expect(image.getAttribute("height")).toBe("1080");
    expect(image.style.backgroundColor).toBe("rgb(60, 58, 53)");
    // The inscription list keeps its thumbnail sizes.
    expect(
      render(card({ media: coverMedia }), "inscription")
        .querySelector("img")
        ?.getAttribute("sizes"),
    ).toContain("88px");
  });

  it("passes the list's priority to the first visible cards only", () => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    roots.push(root);
    act(() =>
      root.render(
        <>
          <ContentCard item={card({ media: coverMedia })} priority="high" />
          <ContentCard item={card({ media: coverMedia })} />
        </>,
      ),
    );
    const [first, later] = container.querySelectorAll("img");
    expect(first?.getAttribute("fetchpriority")).toBe("high");
    expect(first?.getAttribute("loading")).toBe("eager");
    expect(later?.getAttribute("loading")).toBe("lazy");
  });

  it("serves Development Catalog card candidates through the Web origin, never a work's", () => {
    vi.stubEnv("NODE_ENV", "development");
    const rendition = (hex: string) =>
      `http://127.0.0.1:3411/v1/development/catalog-renditions/media-rendition-${hex.repeat(32)}`;
    const catalogMedia = {
      id: "media-catalog",
      src: rendition("b"),
      width: 1200,
      height: 900,
      renditions: [
        {
          src: rendition("a"),
          width: 480,
          height: 360,
          contentType: "image/webp" as const,
        },
        {
          src: rendition("b"),
          width: 1200,
          height: 900,
          contentType: "image/webp" as const,
        },
      ],
    };
    const catalog = render(
      card({
        target: { type: "catalog", id: "catalog-renditions" } as Card["target"],
        kind: "inscription",
        authorId: null,
        media: catalogMedia,
      }),
    ).querySelector("img")!;
    expect(catalog.getAttribute("src")).toBe(
      `/api/development/catalog-renditions/media-rendition-${"b".repeat(32)}`,
    );
    expect(catalog.getAttribute("srcset")).toContain(
      `/api/development/catalog-renditions/media-rendition-${"a".repeat(32)} 480w`,
    );
    const work = render(card({ media: coverMedia })).querySelector("img")!;
    expect(work.getAttribute("src")).toBe(coverPath("cover"));
  });
});

// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ContentCard } from "@moya/contracts";

const { shell, author, actions } = vi.hoisted(() => ({
  shell: { openContent: vi.fn(), browseOnly: false },
  author: {
    viewer: null as { id: string } | null,
    checking: false,
    sessionError: false,
  },
  actions: vi.fn(),
}));
vi.mock("../product-shell/product-shell", () => ({
  useProductShell: () => shell,
}));
vi.mock("./author-context", () => ({ useAuthors: () => author }));
vi.mock("./content-actions", () => ({
  useContentActions: (...args: unknown[]) => {
    actions(...args);
    return {
      environment: {
        onAction: vi.fn(),
        likedIds: [],
        favoriteIds: [],
        ready: true,
      },
    };
  },
}));

import { ProfileReadingCard } from "./profile-reading-card";
import { ProfileReadingGrid } from "./profile-reading-grid";
import { resetOwnWorkAudiences, setOwnWorkAudience } from "./own-work-audience";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
const OWNER = `user-${"1".repeat(32)}`;
const OTHER = `user-${"2".repeat(32)}`;
const workId = `work-${"a".repeat(32)}`;
const mediaId = `media-item-${"b".repeat(32)}`;
const cover = {
  id: mediaId,
  src: `/api/community/publishing/media/${mediaId}/cover/base`,
  width: 800,
  height: 1200,
};
const item = (patch: Partial<ContentCard> = {}): ContentCard => ({
  aliases: [],
  target: { type: "work", id: workId },
  title: "临《兰亭序》10日 A4",
  kind: null,
  authorId: OWNER,
  firstPublishedAt: "2026-09-13T12:00:00.000Z",
  media: cover,
  ...patch,
});
let root: Root;
let host: HTMLDivElement;
const show = (value: ContentCard, platform: "phone" | "pc" = "phone") => {
  act(() =>
    root.render(
      <ProfileReadingCard item={value} position={3} platform={platform} />,
    ),
  );
  return host.querySelector("article")!;
};
const open = () =>
  host.querySelector<HTMLButtonElement>('button[aria-label^="打开"]')!;

beforeEach(() => {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  author.viewer = null;
  author.checking = false;
  author.sessionError = false;
  shell.browseOnly = false;
  vi.clearAllMocks();
  resetOwnWorkAudiences();
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  resetOwnWorkAudiences();
  vi.unstubAllEnvs();
});

describe("Profile reading content and activation", () => {
  it("exposes the ordinal as screen-reader text and hides the padded decoration", () => {
    const view = show(item());
    const ordinal = Array.from(
      view.querySelectorAll<HTMLElement>(".yoyi-visually-hidden"),
    ).find((element) => element.textContent === "第 3 项");
    expect(ordinal).toBeDefined();
    expect(ordinal!.closest('[aria-hidden="true"]')).toBeNull();
    expect(ordinal!.parentElement?.hasAttribute("aria-label")).toBe(false);
    expect(
      ordinal!.parentElement?.querySelector('[aria-hidden="true"]')
        ?.textContent,
    ).toBe("03");
    expect(view.querySelector('[aria-label="第 3 项"]')).toBeNull();
  });
  it("keeps an empty legacy work identifiable without inventing a preview", () => {
    show(item({ title: "", excerpt: undefined, media: null }));
    expect(host.textContent).toContain("暂无可预览的内容");
    expect(host.querySelector("img")).toBeNull();
    act(() => open().click());
    expect(shell.openContent).toHaveBeenCalledWith(
      { type: "work", id: workId },
      expect.any(HTMLButtonElement),
    );
  });
  it("opens the current canonical target and preserves its accessible title after a card update", () => {
    const first = item();
    show(first);
    act(() => open().click());
    expect(shell.openContent).toHaveBeenLastCalledWith(
      first.target,
      expect.any(HTMLButtonElement),
    );
    const second = item({
      target: { type: "work", id: `work-${"c".repeat(32)}` },
      title: "另一件作品",
    });
    show(second, "pc");
    act(() => open().click());
    expect(shell.openContent).toHaveBeenLastCalledWith(
      second.target,
      expect.any(HTMLButtonElement),
    );
    expect(open().getAttribute("aria-label")).toBe("打开另一件作品");
    expect(host.querySelector("h3")?.getAttribute("aria-label")).toBe(
      second.title,
    );
  });

  it("uses the actual excerpt for an untitled text work and does not invent an image or visible title", () => {
    const view = show(
      item({ title: "", media: null, excerpt: "“读帖”第一行\nA4 第二行" }),
    );
    expect(view.querySelector("img")).toBeNull();
    expect(view.querySelector("h3")).toBeNull();
    expect(view.querySelector("[data-card-excerpt]")?.textContent).toBe(
      "“读帖”第一行\nA4 第二行",
    );
    expect(view.textContent).not.toContain("暂无公开图像");
    expect(view.textContent).not.toContain("未命名作品");
    expect(open().getAttribute("aria-label")).toBe("打开未命名作品");
  });

  it("keeps Latin titles intact and uses mixed vertical text without inserting a newline per glyph", () => {
    const english = "a still photo, then set it to private";
    expect(
      show(item({ title: english })).querySelector("h3")?.textContent,
    ).toBe(english);
    const title = "10月9日 A4临帖";
    const view = show(item({ title }), "pc");
    expect(view.querySelector("h3")?.textContent).toBe(title);
    expect(view.querySelector("h3")?.textContent).not.toContain("\n");
    expect(view.getAttribute("data-reading-platform")).toBe("pc");
  });

  it("shows the real image total even when the preview gallery is capped, and never autoplays Live media", () => {
    const view = show(
      item({
        live: true,
        mediaCount: 7,
        gallery: [cover, { ...cover, id: "second-preview" }],
      }),
    );
    expect(view.querySelector('[aria-label="7 张图像"]')?.textContent).toBe(
      "7 图",
    );
    expect(view.querySelector('[aria-label="实况照片"]')?.textContent).toBe(
      "LIVE",
    );
    expect(view.querySelector("video,audio")).toBeNull();
    expect(view.getAttribute("data-reading-position")).toBe("3");
  });
});

describe("Profile reading images", () => {
  it("keeps the supplied cover anchor and excludes Viewer-only candidates", () => {
    const path = (name: string) =>
      `/api/community/publishing/media/${mediaId}/${name}/base`;
    const media = {
      ...cover,
      src: path("cover"),
      width: 810,
      height: 1080,
      feed: { fit: "cover" as const, y: 0 },
      renditions: [
        {
          src: path("thumb"),
          width: 360,
          height: 480,
          contentType: "image/webp" as const,
        },
        {
          src: path("cover"),
          width: 810,
          height: 1080,
          contentType: "image/webp" as const,
        },
        {
          src: path("display"),
          width: 1536,
          height: 2048,
          contentType: "image/webp" as const,
        },
      ],
    };
    const view = show(item({ media }));
    const image = view.querySelector("img")!;
    expect(image.getAttribute("src")).toBe(path("cover"));
    expect(image.getAttribute("srcset")).toBe(
      `${path("thumb")} 360w, ${path("cover")} 810w`,
    );
    expect(image.style.objectPosition).toBe("");
    expect(image.getAttribute("width")).toBe("810");
    expect(image.getAttribute("height")).toBe("1080");
  });

  it("offers a genuine image retry without activating the work, then recovers when the source changes", () => {
    const first = item();
    show(first);
    act(() => host.querySelector("img")!.dispatchEvent(new Event("error")));
    expect(
      host.querySelector('[data-reading-media-state="failed"]'),
    ).not.toBeNull();
    const retry = host.querySelector<HTMLButtonElement>(
      'button[aria-label^="重试图像"]',
    )!;
    act(() => retry.click());
    expect(shell.openContent).not.toHaveBeenCalled();
    expect(host.querySelector("img")?.getAttribute("src")).toBe(cover.src);
    act(() => host.querySelector("img")!.dispatchEvent(new Event("error")));
    show(item({ media: { ...cover, src: cover.src + "-new" } }));
    expect(
      host.querySelector('[data-reading-media-state="failed"]'),
    ).toBeNull();
    expect(host.querySelector("img")?.getAttribute("src")).toBe(
      cover.src + "-new",
    );
    act(() => open().click());
    expect(shell.openContent).toHaveBeenCalledWith(
      first.target,
      expect.any(HTMLButtonElement),
    );
  });

  it("keeps a sibling image intact when another card fails and retries the same source", () => {
    const first = item();
    // A shared image source must not couple independent cards' failure state.
    const second = item({
      target: { type: "work", id: `work-${"c".repeat(32)}` },
      title: "另一件作品",
    });
    act(() =>
      root.render(
        <ProfileReadingGrid
          items={[first, second]}
          platform="phone"
          active
          label="作品展读"
        />,
      ),
    );
    const cards = host.querySelectorAll<HTMLElement>(
      "[data-profile-reading-card]",
    );
    const failedImage = cards[0]!.querySelector("img")!;
    const siblingImage = cards[1]!.querySelector("img")!;
    const siblingSource = siblingImage.getAttribute("src");
    expect(failedImage.getAttribute("src")).toBe(siblingSource);

    act(() => failedImage.dispatchEvent(new Event("error")));
    expect(
      cards[0]!.querySelector('[data-reading-media-state="failed"]'),
    ).not.toBeNull();
    expect(cards[1]!.querySelector("img")).toBe(siblingImage);
    expect(siblingImage.isConnected).toBe(true);
    expect(siblingImage.getAttribute("data-reading-media-state")).toBe("valid");
    expect(cards[1]!.querySelector('[aria-label^="重试图像"]')).toBeNull();

    const retry = cards[0]!.querySelector<HTMLButtonElement>(
      'button[aria-label^="重试图像"]',
    )!;
    act(() => retry.click());
    const replacement = cards[0]!.querySelector("img")!;
    expect(replacement).not.toBeNull();
    expect(replacement).not.toBe(failedImage);
    expect(replacement.getAttribute("src")).toBe(cover.src);
    expect(failedImage.isConnected).toBe(false);
    expect(cards[1]!.querySelector("img")).toBe(siblingImage);
    expect(siblingImage.getAttribute("src")).toBe(siblingSource);
    expect(siblingImage.getAttribute("data-reading-media-state")).toBe("valid");
    expect(shell.openContent).not.toHaveBeenCalled();

    act(() =>
      cards[1]!
        .querySelector<HTMLButtonElement>('button[aria-label^="打开"]')!
        .click(),
    );
    expect(shell.openContent).toHaveBeenCalledOnce();
    expect(shell.openContent).toHaveBeenCalledWith(
      second.target,
      expect.any(HTMLButtonElement),
    );
  });

  it("prioritizes only the active list's first two images", () => {
    const cards = [0, 1, 2].map((n) =>
      item({
        target: { type: "work", id: `work-${String(n).padStart(32, "0")}` },
      }),
    );
    act(() =>
      root.render(
        <ProfileReadingGrid
          items={cards}
          platform="phone"
          active
          label="作品展读"
        />,
      ),
    );
    expect(
      [...host.querySelectorAll("img")].map((n) => n.getAttribute("loading")),
    ).toEqual(["eager", "eager", "lazy"]);
    expect(host.querySelector("img")?.getAttribute("fetchpriority")).toBe(
      "high",
    );
    act(() =>
      root.render(
        <ProfileReadingGrid
          items={cards}
          platform="phone"
          active={false}
          label="作品展读"
        />,
      ),
    );
    expect(
      [...host.querySelectorAll("img")].every(
        (n) => n.getAttribute("loading") === "lazy",
      ),
    ).toBe(true);
  });

  it("uses the existing same-origin Development relay for Catalog images without rewriting a work image", () => {
    vi.stubEnv("NODE_ENV", "development");
    const renditionId = `media-rendition-${"d".repeat(32)}`;
    const src = `http://localhost:4010/v1/development/catalog-renditions/${renditionId}`;
    show(
      item({
        target: { type: "catalog", id: "catalog-sample" },
        kind: "calligraphy",
        media: { ...cover, src },
      }),
    );
    expect(host.querySelector("img")?.getAttribute("src")).toBe(
      `/api/development/catalog-renditions/${renditionId}`,
    );
    show(item({ media: { ...cover, src } }));
    expect(host.querySelector("img")?.getAttribute("src")).toBe(src);
  });
});

describe("Author-only audience status", () => {
  it("shows only confirmed author-owned audience state and removes it immediately after a session change", () => {
    setOwnWorkAudience(OWNER, workId, {
      publiclyVisible: false,
      visibility: "self",
    });
    author.viewer = { id: OWNER };
    show(item());
    expect(host.querySelector("[data-reading-audience]")?.textContent).toBe(
      "仅自己可见",
    );
    author.viewer = { id: OTHER };
    show(item());
    expect(host.querySelector("[data-reading-audience]")).toBeNull();
    author.viewer = { id: OWNER };
    author.checking = true;
    show(item());
    expect(host.querySelector("[data-reading-audience]")).toBeNull();
    author.checking = false;
    author.sessionError = true;
    show(item());
    expect(host.querySelector("[data-reading-audience]")).toBeNull();
    author.sessionError = false;
    setOwnWorkAudience(OWNER, workId, {
      publiclyVisible: null,
      visibility: "public",
      unconfirmed: true,
    });
    show(item());
    expect(host.querySelector("[data-reading-audience]")).toBeNull();
  });

  it("updates a known non-public status without inventing a moderation label or issuing a new read", () => {
    author.viewer = { id: OWNER };
    setOwnWorkAudience(OWNER, workId, {
      publiclyVisible: false,
      visibility: "public",
    });
    show(item());
    expect(host.querySelector("[data-reading-audience]")?.textContent).toBe(
      "暂不公开",
    );
    expect(host.textContent).not.toContain("审核");
    act(() =>
      setOwnWorkAudience(OWNER, workId, {
        publiclyVisible: true,
        visibility: "public",
      }),
    );
    expect(host.querySelector("[data-reading-audience]")).toBeNull();
  });
});

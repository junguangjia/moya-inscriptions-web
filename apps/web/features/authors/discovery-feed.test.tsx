// @vitest-environment jsdom
import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  class AuthorRequestError extends Error {
    constructor(
      readonly status: number,
      message: string,
    ) {
      super(message);
    }
  }
  return {
    AuthorRequestError,
    author: {
      cache: new Map<string, unknown>(),
      viewer: { id: `user-${"a".repeat(32)}`, displayName: "作者" },
      checking: false,
      revision: 0,
      notice: "",
      notify: vi.fn(),
    },
    shell: {
      activeContent: null,
      activeProfile: null,
      activeDestination: "home",
      feedLayout: "single" as "single" | "double",
      platform: "phone" as "phone" | "tablet" | "pc",
      readActiveScrollTop: () => 0,
      restoreActiveScrollTop: vi.fn(),
    },
    client: { discovery: vi.fn(), card: vi.fn(), filters: vi.fn() },
    returnView: undefined as unknown,
  };
});
vi.mock("../auth/auth-return", () => ({
  useAuthReturnView: () => mocks.returnView,
}));
vi.mock("./author-context", () => ({ useAuthors: () => mocks.author }));
vi.mock("../product-shell/product-shell", () => ({
  useProductShell: () => mocks.shell,
}));
vi.mock("./author-data", () => ({
  authorClient: mocks.client,
  AuthorRequestError: mocks.AuthorRequestError,
}));
vi.mock("./content-card", () => ({
  ContentCard: ({
    item,
    priority,
  }: {
    item: { title: string };
    priority?: string;
  }) => (
    <article data-card="" data-priority={priority}>
      {item.title}
    </article>
  ),
}));
// The real catalog card pulls in the built UI package; only the span rule matters.
vi.mock("../home/catalog-card", () => ({
  isUltraWideCatalogMedia: (media?: { width: number; height: number }) =>
    media !== undefined && media.width / media.height >= 2.4,
}));
vi.mock("../home/catalog-masonry", () => ({
  CatalogMasonry: <T,>({
    items,
    getKey,
    renderItem,
    feedLayout,
    platform,
    spanAtAlignedRows,
    isFullSpan,
  }: {
    items: readonly T[];
    getKey: (item: T) => string;
    renderItem: (
      item: T,
      onSettled: () => void,
      index: number,
    ) => React.ReactNode;
    feedLayout: string;
    platform: string;
    spanAtAlignedRows?: boolean;
    isFullSpan?: (item: T) => boolean;
  }) => (
    <div
      data-masonry=""
      data-feed-layout={feedLayout}
      data-platform={platform}
      data-span-aligned-rows={spanAtAlignedRows ? "" : undefined}
    >
      {items.map((item, index) => (
        <div
          key={getKey(item)}
          data-full-span={isFullSpan?.(item) ? "" : undefined}
        >
          {renderItem(item, () => undefined, index)}
        </div>
      ))}
    </div>
  ),
}));

import { DiscoveryFeed } from "./discovery-feed";

import type { ContentCard, DiscoveryPage } from "@moya/contracts";
import type { Root } from "react-dom/client";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const card = (n: number): ContentCard => ({
  aliases: [],
  target: { type: "work", id: `work-${String(n).padStart(32, "0")}` },
  title: `作品 ${n}`,
  kind: null,
  authorId: null,
  firstPublishedAt: null,
  media: null,
});

const page = (from: number, hasMore: boolean): DiscoveryPage => ({
  items: [card(from), card(from + 1)],
  sequence: "6f8d8a7e-1a2b-4c3d-8e9f-0a1b2c3d4e5f",
  nextAfter: from + 2,
  hasMore,
});

/** The sentinel observers the feed creates; the test decides when they fire. */
const observers: { callback: IntersectionObserverCallback }[] = [];

let root: Root;
let container: HTMLDivElement;
let rerenderAbove: (() => void) | null = null;

/** A parent that re-renders like the author or publishing providers do. */
const Above = () => {
  const [, bump] = useState(0);
  rerenderAbove = () => bump((n) => n + 1);
  return <DiscoveryFeed active kind="all" />;
};

const flush = async () => {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
};

const button = () =>
  [...container.querySelectorAll<HTMLButtonElement>("button")].find(
    (candidate) => candidate.textContent === "加载更多",
  ) ?? null;

beforeEach(() => {
  observers.length = 0;
  Object.defineProperty(window, "IntersectionObserver", {
    configurable: true,
    value: class {
      constructor(callback: IntersectionObserverCallback) {
        observers.push({ callback });
      }
      observe() {}
      disconnect() {}
    },
  });
  mocks.author.cache.clear();
  mocks.author.revision = 0;
  mocks.author.notice = "";
  mocks.shell.feedLayout = "single";
  mocks.shell.platform = "phone";
  mocks.returnView = undefined;
  mocks.client.discovery.mockReset();
  mocks.client.card.mockReset();
  mocks.client.filters.mockReset();
  mocks.client.card.mockImplementation(async (target: { id: string }) =>
    card(Number(target.id.slice(-2))),
  );
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  rerenderAbove = null;
});

describe("Discovery feed footer (D9)", () => {
  it("keeps one 加载更多 element across provider re-renders and page loads", async () => {
    mocks.client.discovery.mockResolvedValueOnce(page(1, true));
    await act(async () => root.render(<Above />));
    await flush();
    const first = button();
    expect(first).not.toBeNull();
    expect(first!.disabled).toBe(false);

    // Unrelated updates above the feed: an author revision (which
    // revalidates the cards), a toast, a plain parent re-render.
    mocks.author.revision += 1;
    mocks.author.notice = "作品已提交";
    await act(async () => rerenderAbove!());
    await flush();
    await act(async () => rerenderAbove!());
    expect(button()).toBe(first);

    // The sentinel fetches the next page: the button stays, busy and disabled.
    let release: (value: DiscoveryPage) => void = () => undefined;
    mocks.client.discovery.mockImplementationOnce(
      () => new Promise<DiscoveryPage>((resolve) => (release = resolve)),
    );
    expect(observers.length).toBeGreaterThan(0);
    await act(async () => {
      observers
        .at(-1)!
        .callback(
          [{ isIntersecting: true } as IntersectionObserverEntry],
          {} as IntersectionObserver,
        );
    });
    expect(button()).toBe(first);
    expect(first!.disabled).toBe(true);
    expect(first!.getAttribute("aria-busy")).toBe("true");
    expect(container.querySelector('[role="status"]')?.textContent).toBe(
      "正在加载…",
    );
    await act(async () => release(page(3, true)));
    await flush();
    expect(button()).toBe(first);
    expect(first!.disabled).toBe(false);
    expect(container.querySelector('[role="status"]')).toBeNull();
    expect(container.querySelectorAll("[data-card]")).toHaveLength(4);

    // The last page removes the button; nothing else is recreated meanwhile.
    mocks.client.discovery.mockResolvedValueOnce(page(5, false));
    await act(async () => first!.click());
    await flush();
    expect(button()).toBeNull();
    expect(container.querySelectorAll("[data-card]")).toHaveLength(6);
  });
});

// unified-media-pipeline-v1: the visible feed's first cards are its likely
// Largest Contentful Paint, so they load first; nothing else is prioritized.
describe("Discovery feed media priority", () => {
  const priorities = () =>
    [...container.querySelectorAll("[data-card]")].map(
      (node) => node.getAttribute("data-priority") ?? "",
    );

  it.each(["all", "inscription"] as const)(
    "prioritizes the first two %s cards only while the feed is visible",
    async (kind) => {
      mocks.client.discovery.mockResolvedValue({
        ...page(1, false),
        items: [card(1), card(2), card(3)],
      });
      mocks.client.filters.mockResolvedValue(
        Object.fromEntries(
          [
            "dynasty",
            "textAuthor",
            "calligrapher",
            "originalRegion",
            "script",
          ].map((key) => [key, { values: [], unknown: 0, unsupplied: 0 }]),
        ),
      );
      await act(async () => root.render(<DiscoveryFeed active kind={kind} />));
      await flush();
      expect(priorities()).toEqual(["high", "eager", ""]);
      await act(async () =>
        root.render(<DiscoveryFeed active={false} kind={kind} />),
      );
      expect(priorities()).toEqual(["", "", ""]);
    },
  );
});

// single-column-feed-v2: the 碑刻 tab renders the shared feed masonry, stays
// two-column on phone and tablet, and its filter is hidden (Owner 2026-10-09).
describe("Inscription discovery tab", () => {
  const masonry = () =>
    container.querySelector<HTMLElement>("[data-masonry]") ?? null;

  it.each(["phone", "tablet"] as const)(
    "renders a two-column masonry on %s even when the shell says single",
    async (platform) => {
      mocks.shell.platform = platform;
      mocks.shell.feedLayout = "single";
      mocks.client.discovery.mockResolvedValue(page(1, false));
      await act(async () =>
        root.render(<DiscoveryFeed active kind="inscription" />),
      );
      await flush();
      expect(masonry()?.dataset.feedLayout).toBe("double");
      expect(masonry()?.dataset.platform).toBe(platform);
      expect(masonry()?.hasAttribute("data-span-aligned-rows")).toBe(false);
      expect(container.querySelectorAll("[data-card]")).toHaveLength(2);
      expect(container.querySelector("[data-inscription-list]")).toBeNull();
      expect(
        container.querySelector('section[aria-label="碑刻筛选结果"]'),
      ).not.toBeNull();
    },
  );

  it("follows the shell layout on PC", async () => {
    mocks.shell.platform = "pc";
    mocks.shell.feedLayout = "single";
    mocks.client.discovery.mockResolvedValue(page(1, false));
    await act(async () =>
      root.render(<DiscoveryFeed active kind="inscription" />),
    );
    await flush();
    expect(masonry()?.dataset.feedLayout).toBe("single");
  });

  it("keeps the all tab on the shell layout with aligned spans", async () => {
    mocks.client.discovery.mockResolvedValue(page(1, false));
    await act(async () => root.render(<DiscoveryFeed active kind="all" />));
    await flush();
    expect(masonry()?.dataset.feedLayout).toBe("single");
    expect(masonry()?.hasAttribute("data-span-aligned-rows")).toBe(true);
  });

  it("spans ultra-wide inscription media across both columns", async () => {
    const wide: ContentCard = {
      ...card(1),
      media: { width: 2400, height: 600 } as ContentCard["media"],
    };
    mocks.client.discovery.mockResolvedValue({
      ...page(1, false),
      items: [wide, card(2)],
    });
    await act(async () =>
      root.render(<DiscoveryFeed active kind="inscription" />),
    );
    await flush();
    expect(
      [...container.querySelectorAll("[data-masonry] > div")].map((node) =>
        node.hasAttribute("data-full-span"),
      ),
    ).toEqual([true, false]);
  });

  it("hides the filter, never reads filter options and drops restored filters", async () => {
    mocks.returnView = {
      filters: {
        dynasty: ["唐"],
        textAuthor: [],
        calligrapher: [],
        originalRegion: [],
        script: [],
      },
      search: "九成宫",
      count: 0,
      top: 0,
      anchor: null,
    };
    mocks.client.discovery.mockResolvedValue(page(1, false));
    await act(async () =>
      root.render(<DiscoveryFeed active kind="inscription" />),
    );
    await flush();
    expect(container.querySelector("[data-inscription-filter]")).toBeNull();
    expect(mocks.client.filters).not.toHaveBeenCalled();
    expect(mocks.client.discovery).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "inscription",
        filters: {
          dynasty: [],
          textAuthor: [],
          calligrapher: [],
          originalRegion: [],
          script: [],
        },
        search: "",
      }),
    );
  });
});

// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { authorFixture } = vi.hoisted(() => ({
  authorFixture: {
    current: null as null | {
      checking: boolean;
      sessionError: boolean;
      viewer: { id: string } | null;
    },
  },
}));
vi.mock("../authors/author-context", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../authors/author-context")>();
  return { ...actual, useOptionalAuthors: () => authorFixture.current };
});

vi.mock("next/navigation", () => ({
  usePathname: () => window.location.pathname,
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn() }),
}));

import { PreviewCatalogDetailOverlay } from "./preview-catalog-detail-overlay";
import { ProductShell, useProductShell } from "../product-shell/product-shell";
import {
  AuthReturnProvider,
  useAuthReturn,
  useAuthReturnView,
} from "../auth/auth-return";
import { parseProductHistoryState } from "../product-shell/product-history";
import { useBrowseOnly } from "../shell/browse-only-context";

import type { Root } from "react-dom/client";
import type { CatalogDetailPresentationLoader } from "../detail/load-catalog-detail";
import type { ProductShellContextValue } from "../product-shell/product-shell";
import type { ContentIdentity } from "@moya/contracts";
import type { CatalogDetailPresentationState } from "../detail/catalog-detail-presentation";
import type { BrowseOnlyPolicy } from "../shell/browse-only";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const roots: Root[] = [];
const nativeReplace = window.history.replaceState;
let returnState: ReturnType<typeof useAuthReturn> = null;
let shellState: ProductShellContextValue | null = null;
const ReturnObserver = () => {
  returnState = useAuthReturn();
  return null;
};
const ShellObserver = () => {
  shellState = useProductShell();
  return null;
};
const PublicFilter = () => {
  const saved = useAuthReturnView("synthetic-public-list", () => ({
    filter: "favorites",
  }));
  return <span data-public-filter="">{saved?.filter ?? "default"}</span>;
};
const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
};

const OverlayHost = () => {
  const { activeCatalogId, openCatalog } = useProductShell();
  return (
    <button
      data-catalog-id="catalog-a"
      onClick={(event) => openCatalog("catalog-a", event.currentTarget)}
      type="button"
    >
      {activeCatalogId ?? "open"}
    </button>
  );
};

afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  document.body.replaceChildren();
  window.history.replaceState(null, "", "/dev/t02p");
  vi.restoreAllMocks();
});

beforeEach(() => {
  returnState = null;
  shellState = null;
  authorFixture.current = null;
  document.documentElement.dataset.yoyiBootStarted = String(performance.now());
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: vi.fn(() => ({
      addEventListener: vi.fn(),
      matches: false,
      removeEventListener: vi.fn(),
    })),
  });
  Object.defineProperty(window, "visualViewport", {
    configurable: true,
    value: null,
  });
  Object.defineProperty(window, "scrollTo", {
    configurable: true,
    value: vi.fn(),
  });
});

describe("PreviewCatalogDetailOverlay", () => {
  const mountAuthJourney = async (
    response: "not-found" | "unavailable" | "unexpected-error",
    viewer = false,
    contentType: "catalog" | "work" = "catalog",
    checking = false,
  ) => {
    const content: ContentIdentity = {
      type: contentType,
      id: contentType === "work" ? `work-${"a".repeat(32)}` : "catalog-a",
    };
    const detailBase = {
      id: content.id,
      aliases: [],
      facts: [],
      media: [
        {
          id: "synthetic-media",
          src: "/synthetic-source.jpg",
          alt: "Synthetic sample",
          width: 100,
          height: 100,
        },
      ],
      source: "runtime" as const,
      sourceCitations: [],
      title: "Synthetic source",
    };
    const loaded: CatalogDetailPresentationState = {
      state: "loaded",
      detail:
        contentType === "work"
          ? {
              ...detailBase,
              contentType: "work",
              authorId: `user-${"b".repeat(32)}`,
              authorName: "Synthetic author",
              canEdit: false,
              available: true,
            }
          : { ...detailBase, kind: "inscription" },
    };
    const loader = vi.fn<CatalogDetailPresentationLoader>(async () => loaded);
    const IdentityOpener = () => {
      const { openContent } = useProductShell();
      return (
        <button
          data-catalog-id={content.id}
          onClick={(event) => openContent(content, event.currentTarget)}
          type="button"
        >
          Open synthetic source
        </button>
      );
    };
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    roots.push(root);
    window.history.replaceState({ __NA: true }, "", "/dev/t02p?feed=favorites");
    const render = async (auth: boolean) =>
      act(async () =>
        root.render(
          <AuthReturnProvider>
            <ReturnObserver />
            {auth ? (
              <p>Authentication route</p>
            ) : (
              <ProductShell
                user={<p>user</p>}
                home={
                  <>
                    <IdentityOpener />
                    <ShellObserver />
                    <PublicFilter
                      key={authorFixture.current?.viewer?.id ?? "guest"}
                    />
                  </>
                }
                initialPlatform="phone"
                discussion={<p>discussion</p>}
                renderProfileOverlay={() => <p>Synthetic profile</p>}
                renderDetailOverlay={({
                  backButtonRef,
                  target,
                  initialScrollTop,
                  onClose,
                  onScrollTopChange,
                }) => (
                  <PreviewCatalogDetailOverlay
                    backButtonRef={backButtonRef}
                    catalogId={target.id}
                    target={target}
                    key={authorFixture.current?.viewer?.id ?? "guest"}
                    initialScrollTop={initialScrollTop}
                    loader={loader}
                    onClose={onClose}
                    onScrollTopChange={onScrollTopChange}
                  />
                )}
              />
            )}
          </AuthReturnProvider>,
        ),
      );
    await render(false);
    await act(async () =>
      container.querySelector<HTMLButtonElement>("[data-catalog-id]")?.click(),
    );
    if (viewer)
      await act(async () => shellState?.openViewer("synthetic-media"));
    window.history.replaceState(
      { ...window.history.state, sourceScrollTop: 173 },
      "",
    );
    const sourcePath = `${window.location.pathname}${window.location.search}${window.location.hash}`;
    returnState?.capture(sourcePath, null);
    const sourceEntry = window.history.state;
    window.history.pushState(
      { __NA: true },
      "",
      `/login?return=${encodeURIComponent(sourcePath)}`,
    );
    expect(returnState?.hasSource()).toBe(true);
    await render(true);
    loader.mockImplementation(async () => ({ state: response }));
    // A native traversal keeps the captured history ticket, without invoking
    // the provider's push/replace wrappers.
    nativeReplace.call(window.history, sourceEntry, "", sourcePath);
    await act(async () =>
      window.dispatchEvent(
        new PopStateEvent("popstate", { state: sourceEntry }),
      ),
    );
    expect(returnState?.isRestoring()).toBe(true);
    const back = vi.spyOn(window.history, "back");
    const push = vi.spyOn(window.history, "pushState");
    if (checking)
      authorFixture.current = {
        checking: true,
        sessionError: false,
        viewer: null,
      };
    await render(false);
    return { container, back, push, render };
  };

  it.each([false, true])(
    "recovers a not-found authentication source to its list, including viewer=%s",
    async (viewer) => {
      const { container, back, push } = await mountAuthJourney(
        "not-found",
        viewer,
      );
      expect(
        container
          .querySelector("[data-product-shell]")
          ?.getAttribute("data-detail-open"),
      ).toBe("false");
      expect(
        container
          .querySelector("[data-product-shell]")
          ?.getAttribute("data-viewer-open"),
      ).toBe("false");
      expect(parseProductHistoryState(window.history.state)).toEqual({
        destination: "home",
        kind: "primary",
        scrollTop: 173,
        version: 2,
      });
      expect(
        `${window.location.pathname}${window.location.search}${window.location.hash}`,
      ).toBe("/dev/t02p?feed=favorites");
      expect(
        container.querySelector('[data-auth-content-recovery][role="status"]')
          ?.textContent,
      ).toContain("原内容已删除或暂时无法访问，已返回原列表。");
      expect(returnState?.isRestoring()).toBe(false);
      expect(back).not.toHaveBeenCalled();
      expect(push).not.toHaveBeenCalled();
      const dismiss = [
        ...container.querySelectorAll<HTMLButtonElement>("button"),
      ].find((button) => button.textContent === "关闭提示");
      await act(async () => dismiss?.click());
      expect(
        container.querySelector("[data-auth-content-recovery]"),
      ).toBeNull();
    },
  );

  it("uses the actual Work identity when an authentication source becomes inaccessible", async () => {
    const { container, back, push } = await mountAuthJourney(
      "not-found",
      true,
      "work",
    );
    expect(parseProductHistoryState(window.history.state)?.kind).toBe(
      "primary",
    );
    expect(
      container
        .querySelector("[data-product-shell]")
        ?.getAttribute("data-viewer-open"),
    ).toBe("false");
    expect(
      container.querySelector("[data-auth-content-recovery]")?.textContent,
    ).toContain("已返回原列表");
    expect(back).not.toHaveBeenCalled();
    expect(push).not.toHaveBeenCalled();
  });

  it("waits through checking and a failed /me, retaining public filters for the confirmed-account re-key", async () => {
    const { container, back, push, render } = await mountAuthJourney(
      "not-found",
      true,
      "work",
      true,
    );
    expect(returnState?.isRestoring()).toBe(true);
    expect(
      container
        .querySelector("[data-product-shell]")
        ?.getAttribute("data-detail-open"),
    ).toBe("true");
    expect(
      container
        .querySelector("[data-product-shell]")
        ?.getAttribute("data-viewer-open"),
    ).toBe("true");
    expect(container.querySelector("[data-public-filter]")?.textContent).toBe(
      "favorites",
    );
    expect(container.querySelector("[data-auth-content-recovery]")).toBeNull();
    expect(back).not.toHaveBeenCalled();
    authorFixture.current = {
      checking: false,
      sessionError: true,
      viewer: null,
    };
    await render(false);
    expect(returnState?.isRestoring()).toBe(true);
    expect(container.querySelector("[data-auth-content-recovery]")).toBeNull();
    expect(back).not.toHaveBeenCalled();
    // The source's existing identity refresh, represented by its confirmed
    // context result, commits the real-account reader and public list together.
    authorFixture.current = {
      checking: false,
      sessionError: false,
      viewer: { id: "synthetic-confirmed-account" },
    };
    await render(false);
    expect(returnState?.isRestoring()).toBe(false);
    expect(container.querySelector("[data-public-filter]")?.textContent).toBe(
      "favorites",
    );
    expect(parseProductHistoryState(window.history.state)).toEqual({
      destination: "home",
      kind: "primary",
      scrollTop: 173,
      version: 2,
    });
    expect(
      container.querySelector("[data-auth-content-recovery]")?.textContent,
    ).toContain("已返回原列表");
    expect(back).not.toHaveBeenCalled();
    expect(push).not.toHaveBeenCalled();
  });

  it.each(["unavailable", "unexpected-error"] as const)(
    "keeps a recoverable %s on the authentication source detail",
    async (response) => {
      const { container, back, push } = await mountAuthJourney(response);
      expect(
        container
          .querySelector("[data-product-shell]")
          ?.getAttribute("data-detail-open"),
      ).toBe("true");
      expect(parseProductHistoryState(window.history.state)?.kind).toBe(
        "detail",
      );
      expect(
        container.querySelector("[data-auth-content-recovery]"),
      ).toBeNull();
      expect(returnState?.isRestoring()).toBe(true);
      expect(back).not.toHaveBeenCalled();
      expect(push).not.toHaveBeenCalled();
    },
  );

  it("keeps an ordinary not-found detail on the existing message screen", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    roots.push(root);
    const loader: CatalogDetailPresentationLoader = async () => ({
      state: "not-found",
    });
    await act(async () =>
      root.render(
        <ProductShell
          user={<p>user</p>}
          home={<OverlayHost />}
          discussion={<p>discussion</p>}
          initialPlatform="phone"
          renderDetailOverlay={({
            backButtonRef,
            target,
            initialScrollTop,
            onClose,
            onScrollTopChange,
          }) => (
            <PreviewCatalogDetailOverlay
              backButtonRef={backButtonRef}
              catalogId={target.id}
              initialScrollTop={initialScrollTop}
              loader={loader}
              onClose={onClose}
              onScrollTopChange={onScrollTopChange}
            />
          )}
        />,
      ),
    );
    await act(async () =>
      container.querySelector<HTMLButtonElement>("[data-catalog-id]")?.click(),
    );
    expect(container.textContent).toContain("未找到这项资料");
    expect(
      container
        .querySelector("[data-product-shell]")
        ?.getAttribute("data-detail-open"),
    ).toBe("true");
    expect(container.querySelector("[data-auth-content-recovery]")).toBeNull();
    expect(parseProductHistoryState(window.history.state)?.kind).toBe("detail");
  });

  it("suppresses a stale response after the requested identity changes", async () => {
    const first =
      deferred<Awaited<ReturnType<CatalogDetailPresentationLoader>>>();
    const second =
      deferred<Awaited<ReturnType<CatalogDetailPresentationLoader>>>();
    const loader = vi.fn((catalogId: string) =>
      catalogId === "catalog-a" ? first.promise : second.promise,
    );
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    roots.push(root);
    const backButtonRef = { current: null };
    const renderOverlay = (catalogId: string) => (
      <ProductShell
        user={<p>calligraphy</p>}
        home={<OverlayHost />}
        initialPlatform="phone"
        discussion={<p>inscriptions</p>}
        renderDetailOverlay={() => (
          <PreviewCatalogDetailOverlay
            backButtonRef={backButtonRef}
            catalogId={catalogId}
            initialScrollTop={0}
            loader={loader}
            onClose={vi.fn()}
            onScrollTopChange={vi.fn()}
          />
        )}
      />
    );

    await act(async () => root.render(renderOverlay("catalog-a")));
    act(() =>
      container.querySelector<HTMLButtonElement>("[data-catalog-id]")?.click(),
    );
    await act(async () => root.render(renderOverlay("catalog-b")));
    await act(async () =>
      first.resolve({
        detail: {
          aliases: [],
          facts: [],
          id: "catalog-a",
          kind: "inscription",
          media: [],
          source: "runtime",
          sourceCitations: [],
          title: "过期详情",
        },
        state: "loaded",
      }),
    );
    expect(container.textContent).not.toContain("过期详情");
    await act(async () =>
      second.resolve({
        detail: {
          aliases: [],
          facts: [],
          id: "catalog-b",
          kind: "calligraphy",
          media: [],
          source: "runtime",
          sourceCitations: [],
          title: "当前详情",
        },
        state: "loaded",
      }),
    );
    expect(container.textContent).toContain("当前详情");
  });
});

describe("PreviewCatalogDetailOverlay in wide-screen browse-only", () => {
  const nativeInnerWidth = Object.getOwnPropertyDescriptor(
    window,
    "innerWidth",
  );
  const setWidth = (width: number) =>
    Object.defineProperty(window, "innerWidth", {
      configurable: true,
      value: width,
    });
  beforeEach(() => {
    // The phone Detail pages comments in the Embla-backed pager.
    class InertObserver {
      disconnect() {}
      observe() {}
      unobserve() {}
    }
    vi.stubGlobal("IntersectionObserver", InertObserver);
    vi.stubGlobal("ResizeObserver", InertObserver);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    if (nativeInnerWidth === undefined)
      delete (window as { innerWidth?: number }).innerWidth;
    else Object.defineProperty(window, "innerWidth", nativeInnerWidth);
  });

  it("provides the narrow browse-only flag, which follows the width", async () => {
    setWidth(1280);
    const Probe = () => <p data-probe={String(useBrowseOnly())} />;
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    roots.push(root);
    await act(async () =>
      root.render(
        <ProductShell
          user={<p>user</p>}
          home={<Probe />}
          discussion={<p>discussion</p>}
          initialPlatform="pc"
          browseOnlyPolicy={{ session: false }}
        />,
      ),
    );
    const probe = () =>
      container.querySelector("[data-probe]")?.getAttribute("data-probe");
    expect(probe()).toBe("true");
    await act(async () => {
      setWidth(390);
      window.dispatchEvent(new Event("resize"));
    });
    expect(probe()).toBe("false");
  });

  const loadedDetail = (
    contentType: "catalog" | "work",
  ): CatalogDetailPresentationState => {
    const base = {
      aliases: [],
      facts: [],
      media: [],
      source: "runtime" as const,
      sourceCitations: [],
    };
    return {
      state: "loaded",
      detail:
        contentType === "work"
          ? {
              ...base,
              id: `work-${"c".repeat(32)}`,
              contentType: "work",
              authorId: `user-${"d".repeat(32)}`,
              authorName: "Synthetic author",
              available: true,
              canEdit: false,
              sections: [
                { key: "description", title: "正文", text: "Synthetic body" },
              ],
              title: "Synthetic work",
            }
          : {
              ...base,
              id: "catalog-a",
              kind: "inscription",
              title: "Synthetic inscription",
            },
    };
  };

  const mountDetail = async ({
    contentType = "work",
    policy,
    width,
  }: {
    readonly contentType?: "catalog" | "work";
    readonly policy?: BrowseOnlyPolicy;
    readonly width: number;
  }) => {
    setWidth(width);
    const loaded = loadedDetail(contentType);
    const target: ContentIdentity = {
      type: contentType,
      id: loaded.state === "loaded" ? loaded.detail.id : "",
    };
    const loader = vi.fn<CatalogDetailPresentationLoader>(async () => loaded);
    const renderActions = vi.fn(() => (
      <div data-synthetic-actions="">收藏</div>
    ));
    const Opener = () => {
      const { openContent } = useProductShell();
      return (
        <button
          data-open-detail=""
          onClick={(event) => openContent(target, event.currentTarget)}
          type="button"
        >
          Open synthetic detail
        </button>
      );
    };
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    roots.push(root);
    await act(async () =>
      root.render(
        <ProductShell
          user={<p>user</p>}
          home={<Opener />}
          discussion={<p>discussion</p>}
          initialPlatform={width < 768 ? "phone" : "pc"}
          {...(policy === undefined ? {} : { browseOnlyPolicy: policy })}
          renderProfileOverlay={() => <p>Synthetic profile</p>}
          renderDetailOverlay={({
            backButtonRef,
            target: opened,
            initialScrollTop,
            onClose,
            onScrollTopChange,
          }) => (
            <PreviewCatalogDetailOverlay
              backButtonRef={backButtonRef}
              catalogId={opened.id}
              target={opened}
              commentSection={
                <section data-synthetic-comments="">评论</section>
              }
              renderActions={renderActions}
              initialScrollTop={initialScrollTop}
              loader={loader}
              onClose={onClose}
              onScrollTopChange={onScrollTopChange}
            />
          )}
        />,
      ),
    );
    await act(async () =>
      container.querySelector<HTMLButtonElement>("[data-open-detail]")?.click(),
    );
    return { container, renderActions };
  };
  const shellAttribute = (container: HTMLElement, name: string) =>
    container.querySelector("[data-product-shell]")?.getAttribute(name);

  it.each(["work", "catalog"] as const)(
    "reads a %s in the hero layout without comments",
    async (contentType) => {
      const { container, renderActions } = await mountDetail({
        contentType,
        policy: { session: false },
        width: 1280,
      });
      expect(shellAttribute(container, "data-browse-only")).toBe("true");
      expect(shellAttribute(container, "data-detail-open")).toBe("true");
      const detail = container.querySelector("[data-detail-state]");
      expect(detail?.getAttribute("data-detail-state")).toBe("loaded");
      expect(detail?.getAttribute("data-platform")).toBe("pc");
      // Not a null-rendering node: an absent section selects the hero.
      expect(container.querySelector("[data-detail-landscape-layout]")).toBe(
        null,
      );
      expect(container.querySelector("[data-detail-paged-layout]")).toBeNull();
      expect(container.querySelector("[data-synthetic-comments]")).toBeNull();
      expect(container.querySelector('[aria-label="评论"]')).toBeNull();
      // The actions decide their own browse-only reading (DetailActions keeps
      // only the plain author line), so the overlay still composes them.
      expect(renderActions).toHaveBeenCalled();
      expect(container.querySelector("[data-detail-info-panel]")).not.toBe(
        null,
      );
      expect(container.querySelector("[data-detail-title]")?.textContent).toBe(
        contentType === "work" ? "Synthetic work" : "Synthetic inscription",
      );
      if (contentType === "work")
        expect(
          container.querySelector('[data-detail-section="description"]')
            ?.textContent,
        ).toBe("Synthetic body");
    },
  );

  it("keeps the browse-only reading while a cookie still waits for /me", async () => {
    const { container, renderActions } = await mountDetail({
      policy: { session: null },
      width: 1280,
    });
    expect(shellAttribute(container, "data-browse-only")).toBe("true");
    expect(container.querySelector("[data-synthetic-comments]")).toBeNull();
    expect(container.querySelector("[data-detail-landscape-layout]")).toBe(
      null,
    );
    expect(renderActions).toHaveBeenCalled();
  });

  it.each([
    ["without a policy", undefined],
    ["for a signed-in reader", { session: true }],
  ] as const)(
    "keeps comments and actions on a wide screen %s",
    async (_case, policy) => {
      const { container, renderActions } = await mountDetail({
        ...(policy === undefined ? {} : { policy }),
        width: 1280,
      });
      expect(shellAttribute(container, "data-browse-only")).toBe("false");
      expect(
        container.querySelector(
          "[data-detail-landscape-comments] [data-synthetic-comments]",
        ),
      ).not.toBeNull();
      expect(container.querySelector("[data-synthetic-actions]")).not.toBe(
        null,
      );
      expect(renderActions).toHaveBeenCalled();
    },
  );

  it("keeps comments and actions at phone width under the policy", async () => {
    const { container, renderActions } = await mountDetail({
      policy: { session: false },
      width: 390,
    });
    expect(shellAttribute(container, "data-browse-only")).toBe("false");
    expect(container.querySelector("[data-detail-paged-layout]")).not.toBe(
      null,
    );
    expect(container.querySelector("[data-synthetic-comments]")).not.toBe(null);
    expect(container.querySelector("[data-synthetic-actions]")).not.toBe(null);
    expect(renderActions).toHaveBeenCalled();
  });

  it("returns comments and actions at 390 and hides them again at 1280, keeping the Detail open", async () => {
    const { container } = await mountDetail({
      policy: { session: false },
      width: 1280,
    });
    expect(container.querySelector("[data-synthetic-comments]")).toBeNull();
    const resize = (width: number) =>
      act(async () => {
        setWidth(width);
        window.dispatchEvent(new Event("resize"));
      });

    await resize(390);
    expect(shellAttribute(container, "data-browse-only")).toBe("false");
    expect(shellAttribute(container, "data-detail-open")).toBe("true");
    expect(container.querySelector("[data-detail-paged-layout]")).not.toBe(
      null,
    );
    expect(container.querySelector("[data-synthetic-comments]")).not.toBe(null);
    expect(container.querySelector("[data-synthetic-actions]")).not.toBe(null);

    await resize(1280);
    expect(shellAttribute(container, "data-browse-only")).toBe("true");
    expect(shellAttribute(container, "data-detail-open")).toBe("true");
    expect(container.querySelector("[data-detail-paged-layout]")).toBeNull();
    expect(container.querySelector("[data-synthetic-comments]")).toBeNull();
    expect(container.querySelector("[data-detail-landscape-layout]")).toBe(
      null,
    );
    expect(container.querySelector("[data-detail-title]")?.textContent).toBe(
      "Synthetic work",
    );
  });
});

// @vitest-environment jsdom

import { StrictMode, act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { authorFixture, observed } = vi.hoisted(() => ({
  authorFixture: {
    current: null as null | {
      checking: boolean;
      sessionError: boolean;
      viewer: { id: string } | null;
    },
  },
  observed: {
    track: vi.fn(),
    /** Every state the Detail is given, in order. */
    states: [] as CatalogDetailPresentationState[],
  },
}));
vi.mock("../authors/author-context", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../authors/author-context")>();
  return { ...actual, useOptionalAuthors: () => authorFixture.current };
});
vi.mock("../analytics/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../analytics/client")>()),
  trackAnalytics: observed.track,
}));
vi.mock("../detail/catalog-detail-experience", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("../detail/catalog-detail-experience")
    >();
  return {
    ...actual,
    CatalogDetailExperience: (
      props: Parameters<typeof actual.CatalogDetailExperience>[0],
    ) => {
      observed.states.push(props.state);
      return <actual.CatalogDetailExperience {...props} />;
    },
  };
});

vi.mock("next/navigation", () => ({
  usePathname: () => window.location.pathname,
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn() }),
}));

import { PreviewCatalogDetailOverlay } from "./preview-catalog-detail-overlay";
import { ProductShell, useProductShell } from "../product-shell/product-shell";
import { DESKTOP_FEED_LAYOUT_PREFERENCE_STORAGE_KEY } from "../product-shell/preferences";
import {
  AuthReturnProvider,
  useAuthReturn,
  useAuthReturnView,
} from "../auth/auth-return";
import {
  parseProductHistoryState,
  viewerHistoryState,
  viewerLocation,
} from "../product-shell/product-history";
import { useBrowseOnly } from "../shell/browse-only-context";
import { useCatalogDetailWithdrawal } from "../detail/catalog-detail-withdrawal";

import type { Root } from "react-dom/client";
import type {
  CatalogDetailPresentationLoader,
  CatalogDetailPresentationPeek,
} from "../detail/load-catalog-detail";
import type { ProductShellContextValue } from "../product-shell/product-shell";
import type { ContentIdentity } from "@moya/contracts";
import type {
  CatalogDetailPresentation,
  CatalogDetailPresentationState,
} from "../detail/catalog-detail-presentation";
import type { BrowseOnlyPolicy } from "../shell/browse-only";
import type {
  CatalogDetailWithdrawalNotice,
  WithdrawCatalogDetail,
} from "../detail/catalog-detail-withdrawal";

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

// A loaded Detail syncs its scroll offset into history through a 500 ms shell
// timer that the shell does not clear on unmount. Clear what a test leaves
// behind, so no callback runs after the jsdom window is gone.
const pendingTimers = new Set<number>();
const nativeSetTimeout = window.setTimeout.bind(window);

afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  for (const id of pendingTimers) window.clearTimeout(id);
  pendingTimers.clear();
  document.body.replaceChildren();
  window.history.replaceState(null, "", "/dev/t02p");
  vi.restoreAllMocks();
});

beforeEach(() => {
  vi.spyOn(window, "setTimeout").mockImplementation(((
    handler: TimerHandler,
    timeout?: number,
    ...args: unknown[]
  ) => {
    const id = nativeSetTimeout(handler, timeout, ...args);
    pendingTimers.add(id);
    return id;
  }) as typeof window.setTimeout);
  returnState = null;
  shellState = null;
  authorFixture.current = null;
  observed.track.mockClear();
  observed.states.length = 0;
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
    seeded = false,
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
    // The work its first read returned, held for the return (seeded only).
    let held: CatalogDetailPresentation | null = null;
    const peek = seeded
      ? vi.fn<CatalogDetailPresentationPeek>((id) =>
          id === content.id ? held : null,
        )
      : undefined;
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
                    peek={peek}
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
    if (
      seeded &&
      loaded.state === "loaded" &&
      loaded.detail.contentType === "work"
    )
      held = { ...loaded.detail, provisional: true };
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
    return { container, back, push, render, peek };
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

  it.each([false, true])(
    "uses the actual Work identity when an authentication source becomes inaccessible, seeded=%s",
    async (seeded) => {
      if (seeded)
        authorFixture.current = {
          checking: false,
          sessionError: false,
          viewer: { id: "synthetic-reader" },
        };
      const { container, back, push, peek } = await mountAuthJourney(
        "not-found",
        true,
        "work",
        false,
        seeded,
      );
      if (seeded) {
        // The known work showed on return, before its read answered 404.
        expect(peek).toHaveBeenCalledWith(`work-${"a".repeat(32)}`);
        expect(
          observed.states.some(
            (state) =>
              state.state === "loaded" &&
              state.detail.contentType === "work" &&
              state.detail.provisional === true,
          ),
        ).toBe(true);
      }
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
    },
  );

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

describe("PreviewCatalogDetailOverlay from a known work (detail-entry-speed-v1)", () => {
  const WORK = `work-${"e".repeat(32)}`;
  const OTHER_WORK = `work-${"f".repeat(32)}`;
  const READER = {
    checking: false,
    sessionError: false,
    viewer: { id: "synthetic-reader" },
  };
  type WorkDetail = Extract<CatalogDetailPresentation, { contentType: "work" }>;
  const media = (id: string) => ({
    id,
    src: `/${id}.jpg`,
    alt: "Synthetic sample",
    width: 100,
    height: 100,
  });
  const work = (id: string, title: string): WorkDetail => ({
    contentType: "work",
    id,
    authorId: `user-${"b".repeat(32)}`,
    authorName: "Synthetic author",
    available: true,
    canEdit: false,
    aliases: [],
    facts: [],
    media: [media("synthetic-media")],
    sections: [{ key: "description", title: "正文", text: `${title} body` }],
    source: "runtime",
    sourceCitations: [],
    title,
  });
  /** What peekWorkDetail gives for a work this account already received. */
  const known = (id: string, title: string): WorkDetail => ({
    ...work(id, title),
    provisional: true,
  });
  const loaded = (
    detail: CatalogDetailPresentation,
  ): CatalogDetailPresentationState => ({ state: "loaded", detail });
  interface HeldRead {
    readonly resolve: (state: CatalogDetailPresentationState) => void;
    readonly reject: (reason: unknown) => void;
  }
  /** Each read waits until the test answers it. */
  const heldReads = () => {
    const reads: HeldRead[] = [];
    const loader = vi.fn<CatalogDetailPresentationLoader>(
      () =>
        new Promise((resolve, reject) => {
          reads.push({ resolve, reject });
        }),
    );
    return { loader, reads };
  };
  const phase = (state: CatalogDetailPresentationState) =>
    state.state !== "loaded"
      ? state.state
      : `${
          state.detail.contentType === "work" &&
          state.detail.provisional === true
            ? "seed"
            : "loaded"
        }:${state.detail.title}`;
  /** The states the Detail was given, repeated renders folded. */
  const phases = () =>
    observed.states
      .map(phase)
      .filter((value, index, all) => index === 0 || value !== all[index - 1]);
  const opens = () =>
    observed.track.mock.calls.filter(
      ([event]) => (event as { name?: string }).name === "content_open",
    );
  const ContentOpener = ({ target }: { readonly target: ContentIdentity }) => {
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

  beforeEach(() => {
    class InertObserver {
      disconnect() {}
      observe() {}
      unobserve() {}
    }
    vi.stubGlobal("IntersectionObserver", InertObserver);
    vi.stubGlobal("ResizeObserver", InertObserver);
    authorFixture.current = READER;
  });
  afterEach(() => vi.unstubAllGlobals());

  const mount = async ({
    loader,
    peek,
    target = { type: "work", id: WORK },
    strict = false,
  }: {
    readonly loader: CatalogDetailPresentationLoader;
    readonly peek?: CatalogDetailPresentationPeek;
    readonly target?: ContentIdentity;
    readonly strict?: boolean;
  }) => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    roots.push(root);
    let refresh = () => {};
    // What the actions use to remove the work from the open Detail (a delete).
    let withdraw: WithdrawCatalogDetail | null = null;
    const Withdrawal = () => {
      withdraw = useCatalogDetailWithdrawal();
      return null;
    };
    // The identity the open Detail reads; switching it keeps the same overlay.
    let shown = target;
    const tree = () => (
      <ProductShell
        user={<p>user</p>}
        home={<ContentOpener target={target} />}
        discussion={<p>discussion</p>}
        initialPlatform="phone"
        renderProfileOverlay={() => <p>Synthetic profile</p>}
        renderDetailOverlay={({
          backButtonRef,
          initialScrollTop,
          onClose,
          onScrollTopChange,
        }) => {
          const overlay = (
            <PreviewCatalogDetailOverlay
              backButtonRef={backButtonRef}
              catalogId={shown.id}
              target={shown}
              renderActions={(_detail, next) => {
                refresh = next;
                return (
                  <div data-synthetic-actions="">
                    <Withdrawal />
                  </div>
                );
              }}
              initialScrollTop={initialScrollTop}
              loader={loader}
              peek={peek}
              onClose={onClose}
              onScrollTopChange={onScrollTopChange}
            />
          );
          return strict ? <StrictMode>{overlay}</StrictMode> : overlay;
        }}
      />
    );
    await act(async () => root.render(tree()));
    const detail = () => container.querySelector("[data-detail-state]");
    return {
      container,
      detail,
      provisional: () => detail()?.hasAttribute("data-detail-provisional"),
      skeleton: () => container.querySelector('[aria-label="正在加载资料"]'),
      title: () => container.querySelector("[data-detail-title]"),
      shell: (name: string) =>
        container.querySelector("[data-product-shell]")?.getAttribute(name),
      open: () =>
        act(async () =>
          container
            .querySelector<HTMLButtonElement>("[data-open-detail]")
            ?.click(),
        ),
      show: (next: ContentIdentity) => {
        shown = next;
        return act(async () => root.render(tree()));
      },
      refresh: () => act(async () => refresh()),
      withdraw: (notice: CatalogDetailWithdrawalNotice) =>
        act(async () => withdraw?.(shown.id, notice)),
    };
  };

  it("opens a known work at once and confirms it in place, counting the open only then", async () => {
    const { loader, reads } = heldReads();
    const peek = vi.fn<CatalogDetailPresentationPeek>((id) =>
      id === WORK ? known(WORK, "Known title") : null,
    );
    const view = await mount({ loader, peek });
    await view.open();
    // The first state is the known work: no skeleton, marked provisional.
    expect(phases()).toEqual(["seed:Known title"]);
    expect(view.skeleton()).toBeNull();
    expect(view.detail()?.getAttribute("data-detail-state")).toBe("loaded");
    expect(view.provisional()).toBe(true);
    expect(view.title()?.textContent).toContain("Known title");
    expect(view.container.querySelector("[data-synthetic-actions]")).not.toBe(
      null,
    );
    // Every open still reads.
    expect(loader).toHaveBeenCalledExactlyOnceWith(
      WORK,
      expect.any(AbortSignal),
    );
    expect(opens()).toHaveLength(0);
    const section = view.detail();
    const title = view.title();

    await act(async () =>
      reads[0]!.resolve(loaded(work(WORK, "Confirmed title"))),
    );
    expect(phases()).toEqual(["seed:Known title", "loaded:Confirmed title"]);
    expect(view.provisional()).toBe(false);
    // Replaced in place: the same nodes, now with the confirmed content.
    expect(view.detail()).toBe(section);
    expect(view.title()).toBe(title);
    expect(title?.textContent).toContain("Confirmed title");
    expect(opens()).toHaveLength(1);
    expect(opens()[0]![0]).toMatchObject({
      targetType: "work",
      targetId: WORK,
      surface: "detail",
    });

    // A refresh revalidates what is shown: no skeleton, no second open.
    await view.refresh();
    expect(loader).toHaveBeenCalledTimes(2);
    expect(view.skeleton()).toBeNull();
    await act(async () =>
      reads[1]!.resolve(loaded(work(WORK, "Refreshed title"))),
    );
    expect(phases()).toEqual([
      "seed:Known title",
      "loaded:Confirmed title",
      "loaded:Refreshed title",
    ]);
    expect(opens()).toHaveLength(1);
  });

  it.each([
    [
      "an unavailable answer",
      (read: HeldRead) => read.resolve({ state: "unavailable" }),
    ],
    [
      "an unexpected-error answer",
      (read: HeldRead) => read.resolve({ state: "unexpected-error" }),
    ],
    [
      "a failed read",
      (read: HeldRead) => read.reject(new TypeError("Failed to fetch")),
    ],
  ])(
    "keeps the known work, still provisional, after %s while it is still held",
    async (_case, fail) => {
      const { loader, reads } = heldReads();
      const view = await mount({
        loader,
        peek: () => known(WORK, "Known title"),
      });
      await view.open();
      await act(async () => fail(reads[0]!));
      expect(phases()).toEqual(["seed:Known title"]);
      expect(view.detail()?.getAttribute("data-detail-state")).toBe("loaded");
      expect(view.provisional()).toBe(true);
      expect(view.container.textContent).not.toMatch(/暂时无法/u);
      expect(opens()).toHaveLength(0);
    },
  );

  it("shows the read's unavailable answer once that read forgot the work (401, 403)", async () => {
    const { loader, reads } = heldReads();
    let held: CatalogDetailPresentation | null = known(WORK, "Known title");
    const view = await mount({ loader, peek: () => held });
    await view.open();
    await act(async () => {
      held = null;
      reads[0]!.resolve({ state: "unavailable" });
    });
    expect(phases()).toEqual(["seed:Known title", "unavailable"]);
    expect(view.detail()?.getAttribute("data-detail-state")).toBe(
      "unavailable",
    );
    expect(view.provisional()).toBe(false);
    expect(view.container.textContent).toContain("暂时无法加载资料");
    expect(opens()).toHaveLength(0);
  });

  it.each([
    [
      "a transport failure (unavailable)",
      (read: HeldRead) => read.resolve({ state: "unavailable" }),
      "unavailable",
      "暂时无法加载资料",
    ],
    [
      "an unexpected-error answer",
      (read: HeldRead) => read.resolve({ state: "unexpected-error" }),
      "unexpected-error",
      "暂时无法显示此页面",
    ],
    [
      "a failed read",
      (read: HeldRead) => read.reject(new TypeError("Failed to fetch")),
      "unexpected-error",
      "暂时无法显示此页面",
    ],
  ] as const)(
    "shows the answer of a Detail opened unseeded after %s, although a list read recorded the work meanwhile",
    async (_case, fail, answer, message) => {
      const { loader, reads } = heldReads();
      let held: CatalogDetailPresentation | null = null;
      const view = await mount({ loader, peek: () => held });
      await view.open();
      expect(view.skeleton()).not.toBeNull();
      // A Works tab list read records the work while this read is held.
      held = known(WORK, "Known title");
      await act(async () => fail(reads[0]!));
      expect(phases()).toEqual(["loading", answer]);
      expect(view.detail()?.getAttribute("data-detail-state")).toBe(answer);
      expect(view.provisional()).toBe(false);
      expect(view.container.textContent).toContain(message);
      expect(view.container.textContent).not.toContain("Known title");
      expect(opens()).toHaveLength(0);
    },
  );

  it("shows not-found when the read answers 404 after the known work", async () => {
    const { loader, reads } = heldReads();
    const view = await mount({
      loader,
      peek: () => known(WORK, "Known title"),
    });
    await view.open();
    await act(async () => reads[0]!.resolve({ state: "not-found" }));
    expect(phases()).toEqual(["seed:Known title", "not-found"]);
    expect(view.detail()?.getAttribute("data-detail-state")).toBe("not-found");
    expect(view.provisional()).toBe(false);
    expect(view.container.textContent).toContain("未找到这项资料");
    expect(opens()).toHaveLength(0);
  });

  it("keeps the deletion notice when the known work's read then answers 404, without a recovery", async () => {
    const { loader, reads } = heldReads();
    let held: CatalogDetailPresentation | null = known(WORK, "Known title");
    const view = await mount({ loader, peek: () => held });
    await view.open();
    expect(view.provisional()).toBe(true);
    const back = vi.spyOn(window.history, "back");
    const push = vi.spyOn(window.history, "pushState");

    // The owner deletes the work before its read answers; the delete forgets
    // the record.
    held = null;
    await view.withdraw({
      title: "作品已永久删除",
      description: "此作品已无法恢复。",
    });
    const notice = view.container.querySelector("[data-detail-withdrawn]");
    expect(notice?.textContent).toContain("作品已永久删除");
    expect(view.provisional()).toBe(false);

    // The read then answers 404 for the work just deleted.
    await act(async () => reads[0]!.resolve({ state: "not-found" }));
    expect(phases()).toEqual(["seed:Known title", "not-found"]);
    expect(view.container.querySelector("[data-detail-withdrawn]")).toBe(
      notice,
    );
    expect(view.container.textContent).not.toContain("未找到这项资料");
    expect(view.detail()?.getAttribute("data-detail-state")).toBe("not-found");
    // No recovery: the Detail stays open on its own entry.
    expect(view.shell("data-detail-open")).toBe("true");
    expect(parseProductHistoryState(window.history.state)?.kind).toBe("detail");
    expect(
      view.container.querySelector("[data-auth-content-recovery]"),
    ).toBeNull();
    expect(back).not.toHaveBeenCalled();
    expect(push).not.toHaveBeenCalled();
    expect(opens()).toHaveLength(0);
  });

  it.each([
    [
      "a session error",
      false,
      {
        checking: false,
        sessionError: true,
        viewer: { id: "synthetic-reader" },
      },
    ],
    [
      "a first check without a viewer",
      false,
      { checking: true, sessionError: false, viewer: null },
    ],
    ["no author context", false, null],
    [
      "a confirmed viewer's re-check",
      true,
      {
        checking: true,
        sessionError: false,
        viewer: { id: "synthetic-reader" },
      },
    ],
  ])(
    "with %s, shows the known work at once: %s",
    async (_case, seeded, author) => {
      authorFixture.current = author;
      const { loader, reads } = heldReads();
      const peek = vi.fn<CatalogDetailPresentationPeek>(() =>
        known(WORK, "Known title"),
      );
      const view = await mount({ loader, peek });
      await view.open();
      expect(view.skeleton() === null).toBe(seeded);
      expect(view.provisional()).toBe(seeded);
      // Nothing held is even read without a known account.
      if (!seeded) expect(peek).not.toHaveBeenCalled();
      await act(async () =>
        reads[0]!.resolve(loaded(work(WORK, "Confirmed title"))),
      );
      expect(phases()).toEqual([
        seeded ? "seed:Known title" : "loading",
        "loaded:Confirmed title",
      ]);
    },
  );

  it.each([
    ["holds", "synthetic-media", true],
    ["lacks", "other-media", false],
  ] as const)(
    "seeds a Viewer entry only when the known work %s its media",
    async (_case, mediaId, seeded) => {
      const { loader, reads } = heldReads();
      const view = await mount({
        loader,
        peek: () => known(WORK, "Known title"),
      });
      const target = { type: "work", id: WORK } as const;
      const entry = viewerHistoryState(target, mediaId, "home", 0);
      window.history.replaceState(
        entry,
        "",
        viewerLocation(window.location, target, mediaId),
      );
      await act(async () =>
        window.dispatchEvent(new PopStateEvent("popstate", { state: entry })),
      );
      expect(view.shell("data-detail-open")).toBe("true");
      expect(view.skeleton() === null).toBe(seeded);
      expect(view.provisional()).toBe(seeded);
      // The read confirms a work holding that media: the Viewer shows it.
      await act(async () =>
        reads[0]!.resolve(
          loaded({
            ...work(WORK, "Confirmed title"),
            media: [media("synthetic-media"), media("other-media")],
          }),
        ),
      );
      expect(phases()).toEqual([
        seeded ? "seed:Known title" : "loading",
        "loaded:Confirmed title",
      ]);
      expect(view.shell("data-viewer-open")).toBe("true");
    },
  );

  it("never lets an earlier work's read replace the current one", async () => {
    const { loader, reads } = heldReads();
    const view = await mount({
      loader,
      peek: (id) => known(id, id === WORK ? "First known" : "Second known"),
    });
    await view.open();
    await view.show({ type: "work", id: OTHER_WORK });
    expect(view.title()?.textContent).toContain("Second known");
    expect(loader.mock.calls.map(([id]) => id)).toEqual([WORK, OTHER_WORK]);

    await act(async () => reads[0]!.resolve(loaded(work(WORK, "Stale first"))));
    expect(view.container.textContent).not.toContain("Stale first");
    expect(view.provisional()).toBe(true);
    await act(async () =>
      reads[1]!.resolve(loaded(work(OTHER_WORK, "Second confirmed"))),
    );
    expect(phases()).toEqual([
      "seed:First known",
      "seed:Second known",
      "loaded:Second confirmed",
    ]);
    expect(opens()).toHaveLength(1);
  });

  it("keeps the current read's answer under StrictMode, whatever the discarded read answers", async () => {
    const { loader, reads } = heldReads();
    const view = await mount({
      loader,
      peek: () => known(WORK, "Known title"),
      strict: true,
    });
    await view.open();
    // StrictMode runs the read effect twice; the first read is aborted.
    expect(loader).toHaveBeenCalledTimes(2);
    expect(loader.mock.calls[0]![1]?.aborted).toBe(true);
    expect(view.skeleton()).toBeNull();
    expect(view.provisional()).toBe(true);

    await act(async () =>
      reads[1]!.resolve(loaded(work(WORK, "Current title"))),
    );
    await act(async () => reads[0]!.resolve(loaded(work(WORK, "Stale title"))));
    expect(view.title()?.textContent).toContain("Current title");
    expect(view.container.textContent).not.toContain("Stale title");
    expect(phases()).toEqual(["seed:Known title", "loaded:Current title"]);
    expect(opens()).toHaveLength(1);
  });

  it("keeps the Catalog without a peek: loading first, and a refresh passes through loading", async () => {
    const { loader, reads } = heldReads();
    const catalog = (title: string): CatalogDetailPresentation => ({
      id: "catalog-a",
      kind: "inscription",
      aliases: [],
      facts: [],
      media: [],
      source: "runtime",
      sourceCitations: [],
      title,
    });
    const view = await mount({
      loader,
      target: { type: "catalog", id: "catalog-a" },
    });
    await view.open();
    expect(view.skeleton()).not.toBeNull();
    await act(async () => reads[0]!.resolve(loaded(catalog("Catalog title"))));
    expect(view.skeleton()).toBeNull();
    await view.refresh();
    expect(view.skeleton()).not.toBeNull();
    await act(async () =>
      reads[1]!.resolve(loaded(catalog("Catalog refreshed"))),
    );
    expect(phases()).toEqual([
      "loading",
      "loaded:Catalog title",
      "loading",
      "loaded:Catalog refreshed",
    ]);
    expect(view.container.querySelector("[data-detail-provisional]")).toBe(
      null,
    );
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
    // These compatibility cases exercise the explicitly selected book reader;
    // an unconfigured desktop now starts in the ordinary layout.
    localStorage.setItem(DESKTOP_FEED_LAYOUT_PREFERENCE_STORAGE_KEY, "single");
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
    localStorage.removeItem(DESKTOP_FEED_LAYOUT_PREFERENCE_STORAGE_KEY);
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
          "[data-desktop-detail-colophon] [data-synthetic-comments]",
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
    expect(
      container.querySelector("[data-detail-calligraphy-layout]"),
    ).not.toBe(null);
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
    expect(
      container.querySelector("[data-detail-calligraphy-layout]"),
    ).not.toBe(null);
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

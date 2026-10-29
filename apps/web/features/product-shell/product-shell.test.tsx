// @vitest-environment jsdom

import { act, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  usePathname: () => window.location.pathname,
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn() }),
}));

import { ProductShell, useProductShell } from "./product-shell";
import { PRODUCT_BOOT_SCRIPT } from "./product-boot";
import {
  FEED_LAYOUT_PREFERENCE_STORAGE_KEY,
  DESKTOP_FEED_LAYOUT_PREFERENCE_STORAGE_KEY,
  THEME_PREFERENCE_STORAGE_KEY,
} from "./preferences";
import { AuthReturnProvider, useAuthReturn } from "../auth/auth-return";
import { AuthorDialog } from "../authors/author-dialog";
import { usePreviewNavigationHistory } from "../shell/use-preview-navigation-history";
import {
  editorHistoryState,
  feedViewerHistoryState,
  profileHistoryState,
  detailHistoryState,
  parseProductHistoryState,
  primaryHistoryState,
  settingsHistoryState,
  topicHistoryState,
  viewerHistoryState,
} from "./product-history";

import type { ReactNode } from "react";
import type { BrowseOnlyPolicy } from "../shell/browse-only";
import type { PresentationPlatform } from "../shell/device-platform";
import type { ProductEditorTarget } from "./product-history";
import type {
  ProductShellDetailOverlayRenderProps,
  ProductShellEditorOverlayControls,
  ProductShellProfileOverlayRenderProps,
  ProductShellContextValue,
} from "./product-shell";

const createMediaQueryList = (matches = false): MediaQueryList =>
  ({
    addEventListener: vi.fn(),
    addListener: vi.fn(),
    dispatchEvent: vi.fn(),
    matches,
    media: "(prefers-color-scheme: dark)",
    onchange: null,
    removeEventListener: vi.fn(),
    removeListener: vi.fn(),
  }) as unknown as MediaQueryList;

const mountedRoots: ReturnType<typeof createRoot>[] = [];
let observedProductShell: ProductShellContextValue | null = null;
let observedAuthReturn: ReturnType<typeof useAuthReturn> = null;
const nativeReplace = window.history.replaceState;
const AuthReturnObserver = () => {
  observedAuthReturn = useAuthReturn();
  return null;
};
const authReturn = () => {
  if (observedAuthReturn === null)
    throw new Error("Missing authentication return context");
  return observedAuthReturn;
};

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const ProductShellObserver = () => {
  observedProductShell = useProductShell();
  return null;
};

const SettingsRequester = () => {
  const { requestSettings } = useProductShell();
  return (
    <button
      aria-label="从用户页打开设置"
      data-settings-request-test=""
      onClick={(event) => requestSettings(event.currentTarget)}
      type="button"
    >
      Settings
    </button>
  );
};

const renderProductShell = (
  home: ReactNode = <p>home content</p>,
  options: {
    readonly primaryUtility?: ReactNode;
  } = {},
) => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  mountedRoots.push(root);
  act(() =>
    root.render(
      <ProductShell
        user={<p>user content</p>}
        home={home}
        initialPlatform="phone"
        discussion={<p>discussion content</p>}
        primaryUtility={<SettingsRequester />}
        {...options}
      />,
    ),
  );
  return { container };
};

const TopicOpener = () => {
  const { activeTopicId, openTopic, registerTopicOpener } = useProductShell();
  const openerRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (activeTopicId !== null && openerRef.current !== null) {
      registerTopicOpener(activeTopicId, openerRef.current);
    }
  }, [activeTopicId, registerTopicOpener]);
  return (
    <button
      ref={openerRef}
      type="button"
      data-topic-test-opener=""
      onClick={(event) => openTopic("topic-one", event.currentTarget, 164)}
    >
      Open topic
    </button>
  );
};

const renderTopicShell = () => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  mountedRoots.push(root);
  act(() =>
    root.render(
      <ProductShell
        user={<p>user content</p>}
        home={<p>home content</p>}
        primaryUtility={<SettingsRequester />}
        initialPlatform="phone"
        discussion={<TopicOpener />}
        renderTopicOverlay={({ backButtonRef, onClose, topicId }) => (
          <section aria-label={`Topic ${topicId}`} role="dialog">
            <button
              ref={backButtonRef}
              type="button"
              aria-label="返回专题"
              onClick={onClose}
            >
              Back
            </button>
          </section>
        )}
      />,
    ),
  );
  return { container };
};

const CatalogOpener = () => {
  const { openCatalog } = useProductShell();
  return (
    <article data-catalog-id="catalog-one">
      <button
        type="button"
        data-open-catalog=""
        onClick={(event) => openCatalog("catalog-one", event.currentTarget)}
      >
        Open catalog
      </button>
    </article>
  );
};

const ViewerControls = () => {
  const { activeViewerMediaId, changeViewerMedia, closeViewer, openViewer } =
    useProductShell();
  return (
    <>
      <button
        data-open-viewer-test=""
        onClick={() => openViewer("media-one")}
        type="button"
      >
        Open viewer
      </button>
      <button
        data-change-viewer-test=""
        onClick={() => changeViewerMedia("media-two")}
        type="button"
      >
        Change viewer media
      </button>
      <button data-close-viewer-test="" onClick={closeViewer} type="button">
        Close viewer
      </button>
      <span data-viewer-media-test="">{activeViewerMediaId ?? "closed"}</span>
    </>
  );
};

const renderDetailShell = () => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  mountedRoots.push(root);
  act(() =>
    root.render(
      <ProductShell
        user={<p>user content</p>}
        home={<CatalogOpener />}
        primaryUtility={<SettingsRequester />}
        initialPlatform="phone"
        discussion={<p>discussion content</p>}
        renderDetailOverlay={({
          backButtonRef,
          target,
          initialScrollTop,
          onClose,
          onScrollTopChange,
        }) => (
          <section aria-label={`Detail ${target.id}`} role="dialog">
            <button
              ref={backButtonRef}
              aria-label="返回资料"
              onClick={onClose}
              type="button"
            >
              Back
            </button>
            <button
              data-detail-scroll-test=""
              onClick={() => onScrollTopChange(73)}
              type="button"
            >
              Scroll detail
            </button>
            <span data-detail-initial-scroll="">{initialScrollTop}</span>
            <ViewerControls />
          </section>
        )}
      />,
    ),
  );
  return { container };
};

const feedMedia = ["media-one", "media-two"].map((id, index) => ({
  alt: `动态图像 ${index + 1}`,
  height: 600,
  id,
  src: `https://example.test/${id}.jpg`,
  width: 400,
}));
const feedTarget = { type: "catalog", id: "catalog-one" } as const;
let feedViewerOpened: boolean | undefined;
const FeedViewerOpener = () => {
  const { openFeedViewer } = useProductShell();
  return (
    <button
      data-open-feed-viewer-test=""
      onClick={(event) => {
        feedViewerOpened = openFeedViewer({
          target: feedTarget,
          media: feedMedia,
          index: 1,
          opener: event.currentTarget,
          direction: "rtl",
        });
      }}
      type="button"
    >
      Open feed image
    </button>
  );
};
const renderFeedViewerShell = () => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  mountedRoots.push(root);
  act(() =>
    root.render(
      <ProductShell
        user={<p>user content</p>}
        home={
          <>
            <FeedViewerOpener />
            <CatalogOpener />
          </>
        }
        primaryUtility={<ProductShellObserver />}
        initialPlatform="phone"
        discussion={<p>discussion content</p>}
        renderDetailOverlay={({ target }) => (
          <section aria-label={`Detail ${target.id}`} role="dialog" />
        )}
      />,
    ),
  );
  return { container };
};

const authorId = "user-" + "a".repeat(32),
  workId = "work-" + "b".repeat(32);
const renderAuthorShell = (enabled = true) => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  mountedRoots.push(root);
  let profile: ProductShellProfileOverlayRenderProps | undefined,
    detail: ProductShellDetailOverlayRenderProps | undefined;
  act(() =>
    root.render(
      <ProductShell
        initialPlatform="phone"
        home={
          <>
            <ProductShellObserver />
            <button
              aria-label="个人主页"
              onClick={(e) =>
                observedProductShell?.openProfile(authorId, e.currentTarget)
              }
            >
              Profile
            </button>
          </>
        }
        discussion={<p>discussion</p>}
        user={<p>user</p>}
        {...(enabled
          ? {
              renderProfileOverlay: (
                props: ProductShellProfileOverlayRenderProps,
              ) => {
                profile = props;
                return (
                  <section role="dialog" aria-label="Profile">
                    <button
                      ref={props.backButtonRef}
                      aria-label="返回主页"
                      onClick={props.onClose}
                    >
                      Back
                    </button>
                    <article data-content-id={workId}>
                      <button
                        aria-label="打开作品"
                        onClick={(e) =>
                          observedProductShell?.openContent(
                            { type: "work", id: workId },
                            e.currentTarget,
                          )
                        }
                      >
                        Work
                      </button>
                    </article>
                  </section>
                );
              },
            }
          : {})}
        renderDetailOverlay={(props) => {
          detail = props;
          return (
            <section role="dialog" aria-label="Work">
              <button
                ref={props.backButtonRef}
                aria-label="返回作者"
                onClick={props.onClose}
              >
                Back
              </button>
              <button
                aria-label="打开作品图像"
                onClick={() => observedProductShell?.openViewer("image-one")}
              >
                View
              </button>
            </section>
          );
        }}
      />,
    ),
  );
  return { container, profile: () => profile!, detail: () => detail! };
};
const draftId = "work-draft-" + "c".repeat(32);
const workTarget = { type: "work", id: workId } as const;
let editorMounts = 0;
const EditorMountProbe = () => {
  useEffect(() => {
    editorMounts += 1;
  }, []);
  return null;
};
const renderEditorShell = (
  enabled = true,
  withOverlays = false,
  articleEnabled = false,
) => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  mountedRoots.push(root);
  let editor:
    | {
        readonly target: ProductEditorTarget;
        readonly controls: ProductShellEditorOverlayControls;
      }
    | undefined;
  let profile: ProductShellProfileOverlayRenderProps | undefined,
    detail: ProductShellDetailOverlayRenderProps | undefined;
  const editWork = (
    <button
      aria-label="编辑作品"
      onClick={(e) =>
        observedProductShell?.openEditor(workTarget, e.currentTarget)
      }
    >
      Edit
    </button>
  );
  act(() =>
    root.render(
      <ProductShell
        initialPlatform="phone"
        articleEditorEnabled={articleEnabled}
        home={
          <>
            <ProductShellObserver />
            <button
              aria-label="发布作品"
              onClick={(e) =>
                observedProductShell?.openEditor(
                  { type: "new" },
                  e.currentTarget,
                )
              }
            >
              Create
            </button>
          </>
        }
        discussion={<p>discussion</p>}
        user={
          <button
            aria-label="继续草稿"
            onClick={(e) =>
              observedProductShell?.openEditor(
                { type: "draft", id: draftId },
                e.currentTarget,
              )
            }
          >
            Draft
          </button>
        }
        navigationAction={<button aria-label="停靠操作">Action</button>}
        primaryUtility={<SettingsRequester />}
        {...(withOverlays
          ? {
              renderProfileOverlay: (
                props: ProductShellProfileOverlayRenderProps,
              ) => {
                profile = props;
                return (
                  <section role="dialog" aria-label="Profile">
                    <button
                      ref={props.backButtonRef}
                      aria-label="返回主页"
                      onClick={props.onClose}
                    >
                      Back
                    </button>
                    {editWork}
                  </section>
                );
              },
              renderDetailOverlay: (
                props: ProductShellDetailOverlayRenderProps,
              ) => {
                detail = props;
                return (
                  <section role="dialog" aria-label="Work">
                    <button
                      ref={props.backButtonRef}
                      aria-label="返回作品"
                      onClick={props.onClose}
                    >
                      Back
                    </button>
                    {editWork}
                  </section>
                );
              },
            }
          : {})}
        {...(enabled
          ? {
              renderEditorOverlay: (
                target: ProductEditorTarget,
                controls: ProductShellEditorOverlayControls,
              ) => {
                editor = { target, controls };
                return (
                  <section role="dialog" aria-label="Editor">
                    <EditorMountProbe />
                    <button
                      ref={controls.backButtonRef}
                      aria-label="返回编辑"
                      onClick={controls.close}
                    >
                      Back
                    </button>
                  </section>
                );
              },
            }
          : {})}
      />,
    ),
  );
  return {
    container,
    editor: () => editor!,
    profile: () => profile!,
    detail: () => detail!,
  };
};
const editorDialog = (container: ParentNode) =>
  container.querySelector('[role="dialog"][aria-label="Editor"]');
const scrollable = (element: HTMLElement) => {
  Object.defineProperty(element, "scrollHeight", {
    configurable: true,
    value: 1_000,
  });
  Object.defineProperty(element, "clientHeight", {
    configurable: true,
    value: 400,
  });
  return element;
};
const sameDocument = (state: unknown) => ({
  ...(state as Record<string, unknown>),
  __artvennDocument: window.history.state.__artvennDocument,
});
const beforeUnloadPrevented = () => {
  const event = new Event("beforeunload", { cancelable: true });
  act(() => window.dispatchEvent(event));
  return event.defaultPrevented;
};

const traverse = (state: unknown) =>
  act(() => {
    window.history.replaceState(state, "");
    window.dispatchEvent(new PopStateEvent("popstate", { state }));
  });

const buttonByLabel = (
  container: ParentNode,
  label: string | RegExp,
): HTMLButtonElement => {
  const button = Array.from(container.querySelectorAll("button")).find(
    (candidate) => {
      const accessibleLabel = candidate.getAttribute("aria-label") ?? "";
      return typeof label === "string"
        ? accessibleLabel === label
        : label.test(accessibleLabel);
    },
  );
  if (!(button instanceof HTMLButtonElement)) {
    throw new Error(`Missing button ${String(label)}`);
  }
  return button;
};

const dialog = (container: ParentNode) =>
  container.querySelector<HTMLElement>('[role="dialog"][aria-label="设置"]');

const click = (button: HTMLButtonElement) => {
  act(() => button.click());
};

const withHistoryMarkers = (state: unknown) => ({
  ...(state as Record<string, unknown>),
  __artvennDocument: expect.any(String),
  __artvennEntry: expect.any(String),
});

describe("ProductShell", () => {
  it("checkpoints the primary scroll entry before settings so Back restores the saved position", async () => {
    const { container } = renderProductShell(<ProductShellObserver />);
    await act(async () => vi.runAllTimers());
    const scroller = scrollable(
      container.querySelector<HTMLElement>(
        '[data-primary-destination="home"]',
      )!,
    );
    scroller.scrollTop = 213;
    const replace = vi.spyOn(window.history, "replaceState");
    const opener = container.querySelector<HTMLButtonElement>(
      "[data-settings-request-test]",
    )!;
    act(() => observedProductShell!.requestSettings(opener));
    const saved = replace.mock.calls.find(
      ([state]) => parseProductHistoryState(state)?.kind === "primary",
    )![0];
    expect(parseProductHistoryState(saved)).toEqual(
      primaryHistoryState("home", 213),
    );
    await act(async () => {
      scroller.scrollTop = 0;
      window.history.replaceState(saved, "", "/dev/t02p");
      window.dispatchEvent(new PopStateEvent("popstate", { state: saved }));
    });
    await act(async () => vi.runAllTimers());
    expect(scroller.scrollTop).toBe(213);
    expect(document.activeElement).toBe(opener);
  });
  beforeEach(() => {
    observedAuthReturn = null;
    vi.useFakeTimers();
    window.localStorage.clear();
    window.history.replaceState(null, "", "/dev/t02p");
    document.documentElement.dataset.yoyiBoot = "pending";
    document.documentElement.dataset.yoyiBootStarted = String(
      performance.now() - 720,
    );
    Object.defineProperty(window, "innerWidth", {
      configurable: true,
      value: 390,
    });
    Object.defineProperty(window, "innerHeight", {
      configurable: true,
      value: 844,
    });
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: vi.fn(() => createMediaQueryList()),
    });
    Object.defineProperty(window, "visualViewport", {
      configurable: true,
      value: null,
    });
    Object.defineProperty(window, "scrollTo", {
      configurable: true,
      value: vi.fn(),
    });
    Object.defineProperty(window, "requestAnimationFrame", {
      configurable: true,
      value: (callback: FrameRequestCallback) =>
        window.setTimeout(() => callback(performance.now()), 0),
    });
    Object.defineProperty(window, "cancelAnimationFrame", {
      configurable: true,
      value: (id: number) => window.clearTimeout(id),
    });
  });

  afterEach(() => {
    for (const root of mountedRoots.splice(0)) {
      act(() => root.unmount());
    }
    document.body.replaceChildren();
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
    document.body.style.overflow = "";
    document.documentElement.removeAttribute("data-effective-theme");
    vi.restoreAllMocks();
    observedProductShell = null;
  });

  const renderAuthRecovery = async (kind: "detail" | "viewer" | "topic") => {
    const destination: "discussion" | "user" | "home" =
      kind === "topic" ? "discussion" : kind === "detail" ? "user" : "home";
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    mountedRoots.push(root);
    window.history.replaceState(
      primaryHistoryState(destination),
      "",
      "/dev/t02p?feed=favorites",
    );
    const render = async (auth: boolean) =>
      act(async () =>
        root.render(
          <AuthReturnProvider>
            <AuthReturnObserver />
            {auth ? (
              <p>Authentication route</p>
            ) : (
              <ProductShell
                user={<p>user source</p>}
                home={<p>home source</p>}
                discussion={<p>discussion source</p>}
                initialPlatform="phone"
                primaryUtility={
                  <>
                    <ProductShellObserver />
                    <button data-recovery-opener="" type="button">
                      Source opener
                    </button>
                  </>
                }
                renderDetailOverlay={({ target }) => (
                  <section data-recovery-detail="">{target.id}</section>
                )}
                renderTopicOverlay={({ topicId }) => (
                  <section data-recovery-topic="">{topicId}</section>
                )}
              />
            )}
          </AuthReturnProvider>,
        ),
      );
    await render(false);
    const opener = container.querySelector<HTMLButtonElement>(
      "[data-recovery-opener]",
    )!;
    act(() => {
      if (kind === "topic")
        observedProductShell?.openTopic("synthetic-topic", opener, 173);
      else observedProductShell?.openCatalog("synthetic-unavailable", opener);
    });
    if (kind === "viewer")
      act(() => observedProductShell?.openViewer("synthetic-media"));
    window.history.replaceState(
      { ...window.history.state, sourceScrollTop: 173 },
      "",
    );
    const sourcePath = `${window.location.pathname}${window.location.search}${window.location.hash}`;
    authReturn().capture(sourcePath, null);
    const sourceEntry = window.history.state;
    window.history.pushState(
      { __NA: true },
      "",
      `/login?return=${encodeURIComponent(sourcePath)}`,
    );
    expect(authReturn().hasSource()).toBe(true);
    await render(true);
    nativeReplace.call(window.history, sourceEntry, "", sourcePath);
    await act(async () =>
      window.dispatchEvent(
        new PopStateEvent("popstate", { state: sourceEntry }),
      ),
    );
    await render(false);
    expect(authReturn().isRestoring()).toBe(true);
    const sourcePanel = scrollable(
      container.querySelector<HTMLElement>(
        `[data-primary-destination="${destination}"]`,
      )!,
    );
    return { container, destination, sourcePanel };
  };

  it.each(["detail", "viewer", "topic"] as const)(
    "recovers only the unavailable %s authentication source with the original list scroll",
    async (kind) => {
      const { container, destination, sourcePanel } =
        await renderAuthRecovery(kind);
      const back = vi.spyOn(window.history, "back");
      const push = vi.spyOn(window.history, "pushState");
      let recovered: boolean | undefined;
      act(() => {
        recovered = observedProductShell?.recoverUnavailableAuthContent();
      });
      await act(async () => vi.runAllTimers());
      expect(recovered).toBe(true);
      expect(observedProductShell?.activeContent).toBeNull();
      expect(observedProductShell?.activeViewerMediaId).toBeNull();
      expect(observedProductShell?.activeTopicId).toBeNull();
      expect(observedProductShell?.activeDestination).toBe(destination);
      expect(parseProductHistoryState(window.history.state)).toEqual(
        primaryHistoryState(destination, 173),
      );
      expect(sourcePanel.scrollTop).toBe(173);
      expect(
        `${window.location.pathname}${window.location.search}${window.location.hash}`,
      ).toBe("/dev/t02p?feed=favorites");
      expect(
        container.querySelector('[data-auth-content-recovery][role="status"]')
          ?.textContent,
      ).toContain("已返回原列表");
      expect(authReturn().isRestoring()).toBe(false);
      expect(back).not.toHaveBeenCalled();
      expect(push).not.toHaveBeenCalled();
      back.mockRestore();
      push.mockRestore();
    },
  );

  it("ignores an unavailable result for a different content identity during restoration", async () => {
    const { container } = await renderAuthRecovery("detail");
    const replace = vi.spyOn(window.history, "replaceState");
    let recovered: boolean | undefined;
    act(() => {
      recovered = observedProductShell?.recoverUnavailableAuthContent({
        type: "catalog",
        id: "synthetic-other",
      });
    });
    expect(recovered).toBe(false);
    expect(observedProductShell?.activeCatalogId).toBe("synthetic-unavailable");
    expect(parseProductHistoryState(window.history.state)?.kind).toBe("detail");
    expect(container.querySelector("[data-auth-content-recovery]")).toBeNull();
    expect(authReturn().isRestoring()).toBe(true);
    expect(replace).not.toHaveBeenCalled();
    replace.mockRestore();
  });

  it("keeps an ordinary content entry unchanged without an authentication journey", () => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    mountedRoots.push(root);
    act(() =>
      root.render(
        <ProductShell
          user={<p>user</p>}
          home={<CatalogOpener />}
          discussion={<p>discussion</p>}
          initialPlatform="phone"
          primaryUtility={<ProductShellObserver />}
          renderDetailOverlay={() => <p>Ordinary missing content</p>}
        />,
      ),
    );
    act(() =>
      container
        .querySelector<HTMLButtonElement>("[data-open-catalog]")
        ?.click(),
    );
    const entry = window.history.state;
    const path = window.location.href;
    let recovered: boolean | undefined;
    act(() => {
      recovered = observedProductShell?.recoverUnavailableAuthContent();
    });
    expect(recovered).toBe(false);
    expect(window.history.state).toEqual(entry);
    expect(window.location.href).toBe(path);
    expect(observedProductShell?.activeCatalogId).toBe("catalog-one");
    expect(container.querySelector("[data-auth-content-recovery]")).toBeNull();
  });

  it("keeps all destinations mounted and commits a tap through one history replacement", async () => {
    const replaceState = vi.spyOn(window.history, "replaceState");
    const { container } = renderProductShell();
    await act(async () => vi.runAllTimers());
    replaceState.mockClear();

    click(buttonByLabel(container, "讨论"));
    await act(async () => vi.runAllTimers());

    expect(replaceState).toHaveBeenCalledOnce();
    expect(replaceState).toHaveBeenCalledWith(
      withHistoryMarkers(primaryHistoryState("discussion")),
      "",
      "/dev/t02p",
    );
    expect(
      container.querySelectorAll("[data-primary-destination]"),
    ).toHaveLength(3);
    expect(
      container
        .querySelector('[data-primary-destination="home"]')
        ?.hasAttribute("hidden"),
    ).toBe(true);
    expect(
      container
        .querySelector('[data-primary-destination="discussion"]')
        ?.hasAttribute("hidden"),
    ).toBe(false);
  });

  it("preserves navigation, icon, and label node identity across destination, Settings, and orientation updates", async () => {
    const { container } = renderProductShell();
    await act(async () => vi.runAllTimers());
    const navigation = container.querySelector<HTMLElement>(
      "[data-primary-navigation]",
    )!;
    const icons = Array.from(
      navigation.querySelectorAll("[data-primary-navigation-inline-icon]"),
    );
    const labels = Array.from(
      navigation.querySelectorAll("[data-primary-navigation-text-label]"),
    );
    expect(labels).toHaveLength(3);

    click(buttonByLabel(container, "讨论"));
    await act(async () => vi.runAllTimers());
    expect(container.querySelector("[data-primary-navigation]")).toBe(
      navigation,
    );
    expect(
      Array.from(
        navigation.querySelectorAll("[data-primary-navigation-inline-icon]"),
      ),
    ).toEqual(icons);
    expect(
      Array.from(
        navigation.querySelectorAll("[data-primary-navigation-text-label]"),
      ),
    ).toEqual(labels);

    click(buttonByLabel(container, "从用户页打开设置"));
    await act(async () => vi.runAllTimers());
    expect(container.querySelector("[data-primary-navigation]")).toBe(
      navigation,
    );

    act(() => window.dispatchEvent(new Event("orientationchange")));
    expect(container.querySelector("[data-primary-navigation]")).toBe(
      navigation,
    );
  });

  it("minimizes only after downward intent and expands after the canonical idle period", async () => {
    const { container } = renderProductShell();
    await act(async () => vi.runAllTimers());
    const shell = container.querySelector<HTMLElement>("[data-product-shell]")!;
    const home = container.querySelector<HTMLElement>(
      '[data-primary-destination="home"]',
    )!;

    act(() => {
      home.scrollTop = 6;
      home.dispatchEvent(new Event("scroll"));
    });
    expect(shell.dataset.primaryNavigationMinimized).toBe("false");

    act(() => {
      home.scrollTop = 18;
      home.dispatchEvent(new Event("scroll"));
    });
    expect(shell.dataset.primaryNavigationMinimized).toBe("true");
    expect(
      container
        .querySelector("[data-primary-navigation]")
        ?.getAttribute("data-minimized"),
    ).toBe("true");

    act(() => vi.advanceTimersByTime(399));
    expect(shell.dataset.primaryNavigationMinimized).toBe("true");
    act(() => vi.advanceTimersByTime(1));
    expect(shell.dataset.primaryNavigationMinimized).toBe("false");
  });

  it("keeps keyboard focus on a visible current item when navigation minimizes", async () => {
    const { container } = renderProductShell();
    await act(async () => vi.runAllTimers());
    const home = container.querySelector<HTMLElement>(
      '[data-primary-destination="home"]',
    )!;
    buttonByLabel(container, "讨论").focus();

    act(() => {
      home.scrollTop = 12;
      home.dispatchEvent(new Event("scroll"));
    });

    expect(document.activeElement).toBe(buttonByLabel(container, "首页"));
    expect(
      container
        .querySelector("[data-product-shell]")
        ?.getAttribute("data-primary-navigation-minimized"),
    ).toBe("true");
  });

  it("registers the active Home panel without copying scrollTop and ignores stale cleanup", async () => {
    const { container } = renderProductShell(<ProductShellObserver />);
    await act(async () => vi.runAllTimers());
    const shell = container.querySelector<HTMLElement>("[data-product-shell]")!;
    const discover = document.createElement("section");
    const nearby = document.createElement("section");
    for (const element of [discover, nearby]) {
      Object.defineProperty(element, "scrollHeight", {
        configurable: true,
        value: 1_000,
      });
      Object.defineProperty(element, "clientHeight", {
        configurable: true,
        value: 400,
      });
    }
    discover.scrollTop = 240;
    nearby.scrollTop = 130;

    let unregisterDiscover: () => void = () => undefined;
    let unregisterNearby: () => void = () => undefined;
    act(() => {
      unregisterDiscover =
        observedProductShell!.registerActiveHomeScrollElement(discover);
    });
    expect(observedProductShell!.readActiveScrollTop()).toBe(240);
    act(() => {
      unregisterNearby =
        observedProductShell!.registerActiveHomeScrollElement(nearby);
    });

    expect(nearby.scrollTop).toBe(130);
    act(() => unregisterDiscover());
    expect(observedProductShell!.readActiveScrollTop()).toBe(130);

    act(() => {
      discover.scrollTop = 300;
      discover.dispatchEvent(new Event("scroll"));
    });
    expect(shell.dataset.primaryNavigationMinimized).toBe("false");
    act(() => {
      nearby.scrollTop = 136;
      nearby.dispatchEvent(new Event("scroll"));
    });
    expect(shell.dataset.primaryNavigationMinimized).toBe("false");
    act(() => {
      observedProductShell!.restoreActiveScrollTop(175);
      vi.runAllTimers();
    });
    expect(nearby.scrollTop).toBe(175);
    expect(discover.scrollTop).toBe(300);

    act(() => unregisterNearby());
  });

  it("retries scroll restoration while a hidden view rebuilds its scroll range", async () => {
    renderProductShell(<ProductShellObserver />);
    await act(async () => vi.runAllTimers());
    const scroller = document.createElement("section");
    let rangeAvailable = false;
    Object.defineProperties(scroller, {
      clientHeight: {
        configurable: true,
        value: 400,
      },
      scrollHeight: {
        configurable: true,
        get: () => (rangeAvailable ? 1_000 : 400),
      },
    });
    let unregister: () => void = () => undefined;
    act(() => {
      unregister =
        observedProductShell!.registerActiveHomeScrollElement(scroller);
    });

    act(() => {
      observedProductShell!.restoreActiveScrollTop(175);
      vi.advanceTimersToNextTimer();
      vi.advanceTimersToNextTimer();
    });
    expect(scroller.scrollTop).toBe(0);

    rangeAvailable = true;
    act(() => vi.runAllTimers());
    expect(scroller.scrollTop).toBe(175);

    act(() => unregister());
  });

  it.each(["before first write", "during retry"])(
    "does not transfer a pending restore to a different Home panel: %s",
    async (timing) => {
      renderProductShell(<ProductShellObserver />);
      await act(async () => vi.runAllTimers());
      const discover = document.createElement("section");
      const nearby = document.createElement("section");
      Object.defineProperties(discover, {
        clientHeight: { value: 400 },
        scrollHeight: { value: 400 },
      });
      Object.defineProperties(nearby, {
        clientHeight: { value: 400 },
        scrollHeight: { value: 1_000 },
      });
      nearby.scrollTop = 300;
      act(() => {
        observedProductShell!.registerActiveHomeScrollElement(discover);
        observedProductShell!.restoreActiveScrollTop(175);
        if (timing === "during retry") {
          vi.advanceTimersToNextTimer();
          vi.advanceTimersToNextTimer();
        }
      });
      act(() => {
        observedProductShell!.registerActiveHomeScrollElement(nearby);
        vi.runAllTimers();
      });
      expect(nearby.scrollTop).toBe(300);
      expect(discover.scrollTop).toBe(0);
    },
  );

  it("restores Home into the panel registered by a document-to-panel resize", async () => {
    Object.defineProperty(window, "innerWidth", {
      configurable: true,
      value: 1280,
    });
    const panel = document.createElement("section");
    Object.defineProperties(panel, {
      clientHeight: { value: 400 },
      scrollHeight: { value: 1_000 },
    });
    const ResponsiveHomeOwner = () => {
      const state = useProductShell();
      useLayoutEffect(() => {
        if (state.platform === "pc") return undefined;
        return state.registerActiveHomeScrollElement(panel);
      }, [state.platform, state.registerActiveHomeScrollElement]);
      return <ProductShellObserver />;
    };
    renderProductShell(<ResponsiveHomeOwner />);
    await act(async () => vi.runAllTimers());
    expect(observedProductShell!.platform).toBe("pc");
    document.documentElement.scrollTop = 175;
    act(() => {
      Object.defineProperty(window, "innerWidth", {
        configurable: true,
        value: 390,
      });
      window.dispatchEvent(new Event("resize"));
    });
    expect(observedProductShell!.platform).toBe("phone");
    act(() => vi.runAllTimers());
    expect(panel.scrollTop).toBe(175);
    document.documentElement.scrollTop = 0;
  });

  it.each(["exhausted", "replaced", "unmounted"])(
    "finishes pending restoration without stale writes when %s",
    async (ending) => {
      renderProductShell(<ProductShellObserver />);
      await act(async () => vi.runAllTimers());
      const scroller = document.createElement("section");
      let range = 0;
      let top = 0;
      const writeTop = vi.fn((value: number) => {
        top = value;
      });
      Object.defineProperties(scroller, {
        clientHeight: { value: 400 },
        scrollHeight: { get: () => 400 + range },
        scrollTop: { get: () => top, set: writeTop },
      });
      act(() => {
        observedProductShell!.registerActiveHomeScrollElement(scroller);
        observedProductShell!.restoreActiveScrollTop(175);
        vi.advanceTimersToNextTimer();
        vi.advanceTimersToNextTimer();
      });
      expect(writeTop).toHaveBeenCalledTimes(1);
      act(() => {
        if (ending === "replaced") {
          range = 600;
          observedProductShell!.restoreActiveScrollTop(40);
        } else if (ending === "unmounted") {
          mountedRoots.pop()!.unmount();
          range = 600;
        }
        vi.runAllTimers();
      });
      expect(top).toBe(ending === "replaced" ? 40 : 0);
      expect(writeTop).toHaveBeenCalledTimes(
        ending === "exhausted" ? 13 : ending === "replaced" ? 2 : 1,
      );
      const writes = writeTop.mock.calls.length;
      act(() => vi.runAllTimers());
      expect(writeTop).toHaveBeenCalledTimes(writes);
    },
  );

  it("corrects a post-restore scroll drift before releasing the scroll owner", async () => {
    renderProductShell(<ProductShellObserver />);
    await act(async () => vi.runAllTimers());
    const scroller = document.createElement("section");
    let top = 0;
    const writeTop = vi.fn((value: number) => {
      top = value;
    });
    Object.defineProperties(scroller, {
      clientHeight: { value: 400 },
      scrollHeight: { value: 1_000 },
      scrollTop: { get: () => top, set: writeTop },
    });

    act(() => {
      observedProductShell!.registerActiveHomeScrollElement(scroller);
      observedProductShell!.restoreActiveScrollTop(175);
      vi.advanceTimersToNextTimer();
      vi.advanceTimersToNextTimer();
    });
    expect(top).toBe(175);
    expect(writeTop).toHaveBeenCalledTimes(1);

    top = 182;
    act(() => vi.advanceTimersToNextTimer());
    expect(top).toBe(175);
    expect(writeTop).toHaveBeenCalledTimes(2);

    act(() => vi.runAllTimers());
    expect(writeTop).toHaveBeenCalledTimes(2);
  });

  it.each(
    ["before first write", "after first write", "during retry"].flatMap(
      (timing) =>
        [
          "wheel",
          "touchstart",
          "pointerdown",
          "PageDown",
          "Meta+ArrowUp",
          "Meta+ArrowDown",
          "Control+End",
        ].map((input) => ({ timing, input })),
    ),
  )("yields a pending restore to $input $timing", async ({ timing, input }) => {
    const { container } = renderProductShell(<ProductShellObserver />);
    await act(async () => vi.runAllTimers());
    const scroller = document.createElement("section");
    container.append(scroller);
    let top = 0;
    let range = timing === "during retry" ? 0 : 600;
    const writeTop = vi.fn((value: number) => {
      top = value;
    });
    Object.defineProperties(scroller, {
      clientHeight: { value: 400 },
      scrollHeight: { get: () => 400 + range },
      scrollTop: { get: () => top, set: writeTop },
    });
    act(() => {
      observedProductShell!.registerActiveHomeScrollElement(scroller);
      observedProductShell!.restoreActiveScrollTop(175);
      if (timing !== "before first write") {
        vi.advanceTimersToNextTimer();
        vi.advanceTimersToNextTimer();
      }
    });
    const writes = writeTop.mock.calls.length;
    const event =
      input === "PageDown" || input.includes("+")
        ? new KeyboardEvent("keydown", {
            key: input.split("+").at(-1) ?? input,
            metaKey: input.startsWith("Meta+"),
            ctrlKey: input.startsWith("Control+"),
            bubbles: true,
            cancelable: true,
          })
        : new Event(input, { bubbles: true, cancelable: true });
    act(() => {
      scroller.dispatchEvent(event);
      range = 600;
      top = 182;
      vi.runAllTimers();
    });
    expect(event.defaultPrevented).toBe(false);
    expect(top).toBe(182);
    expect(writeTop).toHaveBeenCalledTimes(writes);
    act(() => vi.runAllTimers());
    expect(writeTop).toHaveBeenCalledTimes(writes);
  });

  it.each([
    "completed",
    "replaced",
    "unmounted",
    "detail",
    "settings",
    "topic",
  ])(
    "removes scroll-input listeners when restoration is %s",
    async (ending) => {
      const { container } = renderProductShell(<ProductShellObserver />);
      await act(async () => vi.runAllTimers());
      if (ending === "topic") {
        act(() => observedProductShell!.navigatePrimary("discussion"));
        await act(async () => vi.runAllTimers());
      }
      const scroller = document.createElement("section");
      container.append(scroller);
      Object.defineProperties(scroller, {
        clientHeight: { value: 400 },
        scrollHeight: { value: 1_000 },
      });
      const addListener = vi.spyOn(window, "addEventListener");
      const removeListener = vi.spyOn(window, "removeEventListener");
      addListener.mockClear();
      removeListener.mockClear();
      act(() => {
        if (ending === "topic")
          observedProductShell!.registerActiveDiscussionScrollElement(scroller);
        else observedProductShell!.registerActiveHomeScrollElement(scroller);
        observedProductShell!.restoreActiveScrollTop(175);
        vi.advanceTimersToNextTimer();
        vi.advanceTimersToNextTimer();
      });
      const inputTypes = ["wheel", "touchstart", "pointerdown", "keydown"];
      const registrations = addListener.mock.calls.filter(([type]) =>
        inputTypes.includes(type),
      );
      expect(registrations).toHaveLength(4);
      act(() => {
        if (ending === "replaced") {
          observedProductShell!.restoreActiveScrollTop(40);
        } else if (ending === "unmounted") {
          mountedRoots.pop()!.unmount();
        } else if (ending === "detail") {
          observedProductShell!.openCatalog("catalog-one", scroller);
        } else if (ending === "settings") {
          observedProductShell!.requestSettings(scroller);
        } else if (ending === "topic") {
          observedProductShell!.openTopic("topic-one", scroller, 175);
        }
      });
      // A now-hidden primary surface must not be corrected under an overlay.
      if (["detail", "settings", "topic", "unmounted"].includes(ending)) {
        scroller.scrollTop = 182;
      }
      act(() => vi.runAllTimers());
      for (const [type, listener] of registrations) {
        expect(removeListener).toHaveBeenCalledWith(type, listener, true);
      }
      expect(scroller.scrollTop).toBe(
        ending === "completed" ? 175 : ending === "replaced" ? 40 : 182,
      );
      addListener.mockRestore();
      removeListener.mockRestore();
    },
  );

  it("ignores unrelated input without dropping the pending restore", async () => {
    const { container } = renderProductShell(<ProductShellObserver />);
    await act(async () => vi.runAllTimers());
    const scroller = document.createElement("section");
    const editor = document.createElement("input");
    scroller.append(editor);
    container.append(scroller);
    Object.defineProperties(scroller, {
      clientHeight: { value: 400 },
      scrollHeight: { value: 1_000 },
    });
    act(() => {
      observedProductShell!.registerActiveHomeScrollElement(scroller);
      observedProductShell!.restoreActiveScrollTop(175);
      container.dispatchEvent(new Event("wheel", { bubbles: true }));
      scroller.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Tab", bubbles: true }),
      );
      editor.dispatchEvent(
        new KeyboardEvent("keydown", { key: " ", bubbles: true }),
      );
      vi.runAllTimers();
    });
    expect(scroller.scrollTop).toBe(175);
  });

  it("keeps drift correction bounded when the scroll position never settles", async () => {
    renderProductShell(<ProductShellObserver />);
    await act(async () => vi.runAllTimers());
    const scroller = document.createElement("section");
    let top = 0;
    const writeTop = vi.fn((value: number) => {
      top = value + 7;
    });
    Object.defineProperties(scroller, {
      clientHeight: { value: 400 },
      scrollHeight: { value: 1_000 },
      scrollTop: { get: () => top, set: writeTop },
    });
    act(() => {
      observedProductShell!.registerActiveHomeScrollElement(scroller);
      observedProductShell!.restoreActiveScrollTop(175);
      vi.runAllTimers();
    });
    expect(writeTop).toHaveBeenCalledTimes(13);
    act(() => vi.runAllTimers());
    expect(writeTop).toHaveBeenCalledTimes(13);
  });

  it("expands the minimized current control without changing destination or history", async () => {
    const replaceState = vi.spyOn(window.history, "replaceState");
    const { container } = renderProductShell();
    await act(async () => vi.runAllTimers());
    replaceState.mockClear();
    const home = container.querySelector<HTMLElement>(
      '[data-primary-destination="home"]',
    )!;

    act(() => {
      home.scrollTop = 12;
      home.dispatchEvent(new Event("scroll"));
    });
    expect(
      container
        .querySelector("[data-product-shell]")
        ?.getAttribute("data-primary-navigation-minimized"),
    ).toBe("true");

    click(buttonByLabel(container, "首页"));
    expect(
      container
        .querySelector("[data-product-shell]")
        ?.getAttribute("data-primary-navigation-minimized"),
    ).toBe("false");
    expect(replaceState).not.toHaveBeenCalled();
    expect(document.activeElement === document.body).toBe(true);
  });

  it("owns Settings history, inertness, Back restoration, and opener focus", async () => {
    const pushState = vi.spyOn(window.history, "pushState");
    const { container } = renderProductShell();
    await act(async () => vi.runAllTimers());
    const opener = buttonByLabel(container, "从用户页打开设置");

    click(opener);
    await act(async () => vi.runAllTimers());

    expect(pushState).toHaveBeenCalledWith(
      withHistoryMarkers(settingsHistoryState("home")),
      "",
      "/dev/t02p#settings",
    );
    expect(dialog(container)).not.toBeNull();
    expect(
      container
        .querySelector("[data-product-primary-layer]")
        ?.hasAttribute("inert"),
    ).toBe(true);
    expect(document.activeElement).toBe(buttonByLabel(container, "返回"));

    act(() =>
      window.dispatchEvent(
        new PopStateEvent("popstate", { state: primaryHistoryState("home") }),
      ),
    );
    await act(async () => vi.runAllTimers());

    expect(dialog(container)).toBeNull();
    expect(document.activeElement).toBe(opener);

    act(() =>
      window.dispatchEvent(
        new PopStateEvent("popstate", {
          state: settingsHistoryState("home"),
        }),
      ),
    );
    await act(async () => vi.runAllTimers());
    expect(dialog(container)).not.toBeNull();
  });

  it.each(["before first frame", "between frames"])(
    "does not reclaim focus after Settings return %s",
    async (timing) => {
      const { container } = renderProductShell(
        <button aria-label="Continue reading">Continue reading</button>,
      );
      await act(async () => vi.runAllTimers());
      const opener = buttonByLabel(container, "从用户页打开设置");
      const next = buttonByLabel(container, "Continue reading");
      click(opener);
      await act(async () => vi.runAllTimers());
      act(() =>
        window.dispatchEvent(
          new PopStateEvent("popstate", { state: primaryHistoryState("home") }),
        ),
      );
      act(() => {
        if (timing === "between frames") vi.advanceTimersToNextTimer();
        // QA can already return the opener on its own first resume frame.
        opener.focus();
        next.focus();
        vi.runAllTimers();
      });
      expect(document.activeElement).toBe(next);
    },
  );

  it("restores the exact Settings opener when QA resumes another old control", async () => {
    const { container } = renderProductShell(
      <button aria-label="Continue reading">Continue reading</button>,
    );
    await act(async () => vi.runAllTimers());
    const opener = buttonByLabel(container, "从用户页打开设置");
    const previous = buttonByLabel(container, "Continue reading");
    click(opener);
    await act(async () => vi.runAllTimers());
    act(() =>
      window.dispatchEvent(
        new PopStateEvent("popstate", { state: primaryHistoryState("home") }),
      ),
    );
    act(() => {
      vi.advanceTimersToNextTimer();
      // WebKit clicks need not focus the Settings entry; QA may remember a tab.
      previous.focus();
      vi.runAllTimers();
    });
    expect(document.activeElement).toBe(opener);
  });

  it.each([
    ["keydown", "before first frame"],
    ["keydown", "between frames"],
    ["pointerdown", "before first frame"],
    ["pointerdown", "between frames"],
  ])("yields Settings focus to %s %s", async (type, timing) => {
    const { container } = renderProductShell(
      <button aria-label="Continue reading">Continue reading</button>,
    );
    await act(async () => vi.runAllTimers());
    const opener = buttonByLabel(container, "从用户页打开设置");
    const next = buttonByLabel(container, "Continue reading");
    click(opener);
    await act(async () => vi.runAllTimers());
    act(() =>
      window.dispatchEvent(
        new PopStateEvent("popstate", { state: primaryHistoryState("home") }),
      ),
    );
    const input =
      type === "keydown"
        ? new KeyboardEvent(type, {
            bubbles: true,
            cancelable: true,
            key: "Tab",
          })
        : new Event(type!, { bubbles: true, cancelable: true });
    act(() => {
      if (timing === "between frames") vi.advanceTimersToNextTimer();
      next.dispatchEvent(input);
      next.focus();
      vi.runAllTimers();
    });
    expect(document.activeElement).toBe(next);
    expect(input.defaultPrevented).toBe(false);
  });

  it.each(["unmounted", "settings", "detail", "destination"])(
    "cancels stale Settings focus when %s takes over",
    async (ending) => {
      const { container } = renderProductShell(<ProductShellObserver />);
      await act(async () => vi.runAllTimers());
      const opener = buttonByLabel(container, "从用户页打开设置");
      click(opener);
      await act(async () => vi.runAllTimers());
      act(() =>
        window.dispatchEvent(
          new PopStateEvent("popstate", { state: primaryHistoryState("home") }),
        ),
      );
      act(() => vi.advanceTimersToNextTimer());
      const focus = vi.spyOn(opener, "focus");
      act(() => {
        if (ending === "unmounted") mountedRoots.pop()!.unmount();
        else if (ending === "settings") {
          observedProductShell!.requestSettings(opener);
        } else if (ending === "detail") {
          observedProductShell!.openCatalog("catalog-one", opener);
        } else click(buttonByLabel(container, "讨论"));
      });
      act(() => vi.runAllTimers());
      expect(focus).not.toHaveBeenCalled();
      focus.mockRestore();
    },
  );

  it("has no external Settings entry while preserving the owned Settings seam", async () => {
    const { container } = renderProductShell(<p>home content</p>, {
      primaryUtility: <SettingsRequester />,
    });
    await act(async () => vi.runAllTimers());

    expect(container.querySelector("[data-open-settings]")).toBeNull();
    const opener = buttonByLabel(container, "从用户页打开设置");
    opener.focus();
    click(opener);
    await act(async () => vi.runAllTimers());

    expect(dialog(container)).not.toBeNull();
    expect(
      container
        .querySelector("[data-product-primary-layer]")
        ?.hasAttribute("inert"),
    ).toBe(true);

    act(() =>
      window.dispatchEvent(
        new PopStateEvent("popstate", { state: primaryHistoryState("home") }),
      ),
    );
    await act(async () => vi.runAllTimers());
    expect(dialog(container)).toBeNull();
    expect(document.activeElement).toBe(opener);
  });

  it("closes owned Settings with Escape and restores its exact opener", async () => {
    const back = vi
      .spyOn(window.history, "back")
      .mockImplementation(() => undefined);
    // An earlier test's spy may still wrap Back.
    back.mockClear();
    const { container } = renderProductShell(<p>home content</p>, {
      primaryUtility: <SettingsRequester />,
    });
    await act(async () => vi.runAllTimers());
    const opener = buttonByLabel(container, "从用户页打开设置");
    opener.focus();
    click(opener);
    await act(async () => vi.runAllTimers());

    const escape = new KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      key: "Escape",
    });
    act(() => document.dispatchEvent(escape));
    expect(escape.defaultPrevented).toBe(true);
    expect(back).toHaveBeenCalledOnce();

    act(() =>
      window.dispatchEvent(
        new PopStateEvent("popstate", { state: primaryHistoryState("home") }),
      ),
    );
    await act(async () => vi.runAllTimers());
    expect(dialog(container)).toBeNull();
    expect(document.activeElement).toBe(opener);
  });

  it("owns Topic history, inertness, navigation identity, Back/Forward, scroll, and focus", async () => {
    const pushState = vi.spyOn(window.history, "pushState");
    const replaceState = vi.spyOn(window.history, "replaceState");
    const { container } = renderTopicShell();
    await act(async () => vi.runAllTimers());
    click(buttonByLabel(container, "讨论"));
    await act(async () => vi.runAllTimers());
    replaceState.mockClear();
    const discussion = container.querySelector<HTMLElement>(
      '[data-primary-destination="discussion"]',
    )!;
    Object.defineProperty(discussion, "scrollHeight", {
      configurable: true,
      value: 1_000,
    });
    Object.defineProperty(discussion, "clientHeight", {
      configurable: true,
      value: 400,
    });
    discussion.scrollTop = 164;
    const opener = container.querySelector<HTMLButtonElement>(
      "[data-topic-test-opener]",
    )!;
    const navigation = container.querySelector<HTMLElement>(
      "[data-primary-navigation]",
    )!;

    click(opener);
    await act(async () => vi.runAllTimers());

    expect(pushState).toHaveBeenCalledWith(
      withHistoryMarkers(topicHistoryState("topic-one", 164)),
      "",
      "/dev/t02p#topic-topic-one",
    );
    expect(replaceState).toHaveBeenCalledWith(
      withHistoryMarkers(primaryHistoryState("discussion", 164, "topic-one")),
      "",
      "/dev/t02p",
    );
    expect(container.querySelector('[role="dialog"]')).not.toBeNull();
    expect(
      container
        .querySelector("[data-product-primary-layer]")
        ?.hasAttribute("inert"),
    ).toBe(true);
    expect(container.querySelector("[data-primary-navigation]")).toBe(
      navigation,
    );
    expect(
      navigation
        .closest("[data-primary-navigation-layer]")
        ?.hasAttribute("hidden"),
    ).toBe(true);
    expect(document.activeElement).toBe(buttonByLabel(container, "返回专题"));

    act(() =>
      window.dispatchEvent(
        new PopStateEvent("popstate", {
          state: {
            ...primaryHistoryState("discussion", 164, "topic-one"),
            __artvennDocument: window.history.state.__artvennDocument,
          },
        }),
      ),
    );
    await act(async () => vi.runAllTimers());

    expect(container.querySelector('[role="dialog"]')).toBeNull();
    expect(discussion.scrollTop).toBe(164);
    expect(document.activeElement).toBe(opener);
    expect(container.querySelector("[data-primary-navigation]")).toBe(
      navigation,
    );

    act(() =>
      window.dispatchEvent(
        new PopStateEvent("popstate", {
          state: topicHistoryState("topic-one", 164),
        }),
      ),
    );
    await act(async () => vi.runAllTimers());
    expect(container.querySelector('[role="dialog"]')).not.toBeNull();
    expect(
      container
        .querySelector("[data-product-shell]")
        ?.getAttribute("data-active-destination"),
    ).toBe("discussion");
  });

  it("resets Topic source scroll after a full reload and Back", async () => {
    window.history.replaceState(
      topicHistoryState("topic-one", 164),
      "",
      "/dev/t02p#topic-topic-one",
    );
    const { container } = renderTopicShell();
    await act(async () => vi.runAllTimers());

    const discussion = container.querySelector<HTMLElement>(
      '[data-primary-destination="discussion"]',
    )!;
    Object.defineProperty(discussion, "scrollHeight", {
      configurable: true,
      value: 1_000,
    });
    Object.defineProperty(discussion, "clientHeight", {
      configurable: true,
      value: 400,
    });
    discussion.scrollTop = 0;

    expect(container.querySelector('[role="dialog"]')).not.toBeNull();
    act(() =>
      window.dispatchEvent(
        new PopStateEvent("popstate", {
          state: primaryHistoryState("discussion", 164, "topic-one"),
        }),
      ),
    );
    await act(async () => vi.runAllTimers());

    expect(container.querySelector('[role="dialog"]')).toBeNull();
    expect(discussion.scrollTop).toBe(0);
    expect(document.activeElement).toBe(
      container.querySelector("[data-topic-test-opener]"),
    );
  });

  it("owns Detail history, source/detail scroll, opener focus, and overlay exclusion", async () => {
    const pushState = vi.spyOn(window.history, "pushState");
    const replaceState = vi.spyOn(window.history, "replaceState");
    const { container } = renderDetailShell();
    await act(async () => vi.runAllTimers());
    replaceState.mockClear();
    const home = container.querySelector<HTMLElement>(
      '[data-primary-destination="home"]',
    )!;
    Object.defineProperty(home, "scrollHeight", {
      configurable: true,
      value: 1_000,
    });
    Object.defineProperty(home, "clientHeight", {
      configurable: true,
      value: 400,
    });
    home.scrollTop = 146;
    const opener = container.querySelector<HTMLButtonElement>(
      "[data-open-catalog]",
    )!;

    click(opener);
    await act(async () => vi.runAllTimers());

    expect(replaceState).toHaveBeenCalledWith(
      withHistoryMarkers(
        primaryHistoryState("home", 146, undefined, "catalog-one"),
      ),
      "",
      "/dev/t02p",
    );
    expect(pushState).toHaveBeenCalledWith(
      withHistoryMarkers(detailHistoryState("catalog-one", "home", 146)),
      "",
      "/dev/t02p?catalogId=catalog-one#detail",
    );
    expect(
      container.querySelector('[aria-label="Detail catalog-one"]'),
    ).not.toBeNull();
    expect(
      container
        .querySelector("[data-product-primary-layer]")
        ?.hasAttribute("inert"),
    ).toBe(true);
    expect(document.activeElement).toBe(buttonByLabel(container, "返回资料"));

    click(
      container.querySelector<HTMLButtonElement>("[data-detail-scroll-test]")!,
    );
    await act(async () => vi.runAllTimers());
    expect(parseProductHistoryState(window.history.state)).toEqual(
      detailHistoryState("catalog-one", "home", 146, 73),
    );

    click(buttonByLabel(container, "从用户页打开设置"));
    expect(dialog(container)).toBeNull();

    act(() =>
      window.dispatchEvent(
        new PopStateEvent("popstate", {
          state: {
            ...primaryHistoryState("home", 146, undefined, "catalog-one"),
            __artvennDocument: window.history.state.__artvennDocument,
          },
        }),
      ),
    );
    await act(async () => vi.runAllTimers());
    expect(
      container.querySelector('[aria-label="Detail catalog-one"]'),
    ).toBeNull();
    expect(home.scrollTop).toBe(146);
    expect(document.activeElement).toBe(opener);

    act(() =>
      window.dispatchEvent(
        new PopStateEvent("popstate", {
          state: {
            ...detailHistoryState("catalog-one", "home", 146, 73),
            __artvennDocument: window.history.state.__artvennDocument,
          },
        }),
      ),
    );
    await act(async () => vi.runAllTimers());
    expect(
      container.querySelector("[data-detail-initial-scroll]")?.textContent,
    ).toBe("73");
  });

  it("debounces rapid Detail scroll history updates below browser quotas", async () => {
    const replaceState = vi.spyOn(window.history, "replaceState");
    const { container } = renderDetailShell();
    await act(async () => vi.runAllTimers());
    click(container.querySelector<HTMLButtonElement>("[data-open-catalog]")!);
    await act(async () => vi.runAllTimers());
    replaceState.mockClear();
    const scrollDetail = container.querySelector<HTMLButtonElement>(
      "[data-detail-scroll-test]",
    )!;

    for (let index = 0; index < 120; index += 1) {
      click(scrollDetail);
      await act(async () => vi.advanceTimersByTime(16));
    }

    expect(replaceState).not.toHaveBeenCalled();
    await act(async () => vi.advanceTimersByTime(500));
    expect(replaceState).toHaveBeenCalledOnce();
    expect(parseProductHistoryState(window.history.state)).toEqual(
      detailHistoryState("catalog-one", "home", 0, 73),
    );
  });

  it("owns one Viewer history layer and replaces media navigation in place", async () => {
    const pushState = vi.spyOn(window.history, "pushState");
    const replaceState = vi.spyOn(window.history, "replaceState");
    const { container } = renderDetailShell();
    await act(async () => vi.runAllTimers());
    const home = container.querySelector<HTMLElement>(
      '[data-primary-destination="home"]',
    )!;
    Object.defineProperties(home, {
      clientHeight: { configurable: true, value: 400 },
      scrollHeight: { configurable: true, value: 1_000 },
    });
    home.scrollTop = 146;
    click(container.querySelector<HTMLButtonElement>("[data-open-catalog]")!);
    await act(async () => vi.runAllTimers());
    click(
      container.querySelector<HTMLButtonElement>("[data-detail-scroll-test]")!,
    );
    await act(async () => vi.runAllTimers());
    pushState.mockClear();
    replaceState.mockClear();

    click(
      container.querySelector<HTMLButtonElement>("[data-open-viewer-test]")!,
    );

    expect(replaceState).toHaveBeenCalledWith(
      withHistoryMarkers(detailHistoryState("catalog-one", "home", 146, 73)),
      "",
      "/dev/t02p?catalogId=catalog-one#detail",
    );
    expect(pushState).toHaveBeenCalledWith(
      withHistoryMarkers(
        viewerHistoryState("catalog-one", "media-one", "home", 146, 73),
      ),
      "",
      "/dev/t02p?catalogId=catalog-one&image=media-one#viewer",
    );
    expect(
      container.querySelector("[data-viewer-media-test]")?.textContent,
    ).toBe("media-one");
    expect(
      container
        .querySelector("[data-product-shell]")
        ?.getAttribute("data-viewer-open"),
    ).toBe("true");

    replaceState.mockClear();
    click(
      container.querySelector<HTMLButtonElement>("[data-change-viewer-test]")!,
    );
    expect(replaceState).toHaveBeenCalledWith(
      withHistoryMarkers(
        viewerHistoryState("catalog-one", "media-two", "home", 146, 73),
      ),
      "",
      "/dev/t02p?catalogId=catalog-one&image=media-two#viewer",
    );
    expect(pushState).toHaveBeenCalledOnce();

    act(() =>
      window.dispatchEvent(
        new PopStateEvent("popstate", {
          state: detailHistoryState("catalog-one", "home", 146, 73),
        }),
      ),
    );
    await act(async () => vi.runAllTimers());
    expect(
      container.querySelector("[data-viewer-media-test]")?.textContent,
    ).toBe("closed");
    expect(
      container.querySelector('[aria-label="Detail catalog-one"]'),
    ).not.toBeNull();

    act(() =>
      window.dispatchEvent(
        new PopStateEvent("popstate", {
          state: viewerHistoryState(
            "catalog-one",
            "media-two",
            "home",
            146,
            73,
          ),
        }),
      ),
    );
    await act(async () => vi.runAllTimers());
    expect(
      container.querySelector("[data-viewer-media-test]")?.textContent,
    ).toBe("media-two");
  });

  it("opens a feed viewer without Detail and closes it through history Back", async () => {
    feedViewerOpened = undefined;
    const pushState = vi.spyOn(window.history, "pushState");
    const replaceState = vi.spyOn(window.history, "replaceState");
    const { container } = renderFeedViewerShell();
    await act(async () => vi.runAllTimers());
    const root = container.querySelector<HTMLElement>("[data-product-shell]")!;
    scrollable(
      container.querySelector<HTMLElement>(
        '[data-primary-destination="home"]',
      )!,
    ).scrollTop = 146;
    const opener = container.querySelector<HTMLButtonElement>(
      "[data-open-feed-viewer-test]",
    )!;
    pushState.mockClear();

    click(opener);

    expect(feedViewerOpened).toBe(true);
    expect(pushState).toHaveBeenCalledOnce();
    expect(pushState).toHaveBeenCalledWith(
      withHistoryMarkers(
        feedViewerHistoryState(feedTarget, "media-two", "home", 146),
      ),
      "",
      "/dev/t02p?catalogId=catalog-one&image=media-two#viewer",
    );
    expect(root.getAttribute("data-viewer-open")).toBe("true");
    expect(root.getAttribute("data-detail-open")).toBe("false");
    expect(observedProductShell?.activeFeedViewer).toEqual({
      target: feedTarget,
      mediaId: "media-two",
    });
    const viewer = container.querySelector<HTMLElement>("[data-detail-viewer]");
    expect(viewer?.getAttribute("data-viewer-direction")).toBe("rtl");
    expect(
      viewer?.querySelector<HTMLImageElement>("[data-detail-viewer-image]")
        ?.alt,
    ).toBe("动态图像 2");

    // Every other layer and a second viewer refuse while it is open.
    click(container.querySelector<HTMLButtonElement>("[data-open-catalog]")!);
    click(opener);
    act(() => {
      observedProductShell?.openProfile(null, opener);
      observedProductShell?.requestSettings(opener);
    });
    expect(feedViewerOpened).toBe(false);
    expect(pushState).toHaveBeenCalledOnce();
    expect(observedProductShell?.activeContent).toBeNull();
    expect(observedProductShell?.settingsOpen).toBe(false);

    replaceState.mockClear();
    act(() => observedProductShell?.changeFeedViewerMedia(0));
    expect(replaceState).toHaveBeenCalledWith(
      withHistoryMarkers(
        feedViewerHistoryState(feedTarget, "media-one", "home", 146),
      ),
      "",
      "/dev/t02p?catalogId=catalog-one&image=media-one#viewer",
    );
    expect(observedProductShell?.activeFeedViewer?.mediaId).toBe("media-one");

    const back = vi
      .spyOn(window.history, "back")
      .mockImplementation(() => undefined);
    // An earlier test's spy may still wrap Back.
    back.mockClear();
    act(() => observedProductShell?.closeFeedViewer());
    // A second close before Back lands must not leave the feed as well.
    act(() => observedProductShell?.closeFeedViewer());
    expect(back).toHaveBeenCalledOnce();
    expect(root.getAttribute("data-viewer-open")).toBe("true");
    back.mockRestore();

    traverse(sameDocument(primaryHistoryState("home", 146)));
    await act(async () => vi.runAllTimers());
    expect(container.querySelector("[data-detail-viewer]")).toBeNull();
    expect(root.getAttribute("data-viewer-open")).toBe("false");
    expect(observedProductShell?.activeFeedViewer).toBeNull();
    expect(document.activeElement).toBe(opener);
    expect(observedProductShell?.activeDestination).toBe("home");

    // Forward onto the old entry cannot rebuild it: the feed stays.
    replaceState.mockClear();
    traverse(
      sameDocument(
        feedViewerHistoryState(feedTarget, "media-one", "home", 146),
      ),
    );
    await act(async () => vi.runAllTimers());
    expect(container.querySelector("[data-detail-viewer]")).toBeNull();
    expect(observedProductShell?.activeContent).toBeNull();
    expect(parseProductHistoryState(window.history.state)).toEqual(
      primaryHistoryState("home", 146),
    );
    expect(window.location.search).toBe("");
    expect(window.location.hash).toBe("");

    // Closed, the shell accepts other layers again.
    click(container.querySelector<HTMLButtonElement>("[data-open-catalog]")!);
    expect(observedProductShell?.activeContent).toEqual(feedTarget);
  });

  it("refuses a feed viewer over Detail or for missing media", async () => {
    const { container } = renderFeedViewerShell();
    await act(async () => vi.runAllTimers());
    const opener = container.querySelector<HTMLButtonElement>(
      "[data-open-feed-viewer-test]",
    )!;
    let opened: boolean | undefined;
    act(() => {
      opened = observedProductShell?.openFeedViewer({
        target: feedTarget,
        media: feedMedia,
        index: 2,
        opener,
      });
    });
    expect(opened).toBe(false);
    act(() => {
      opened = observedProductShell?.openFeedViewer({
        target: feedTarget,
        media: [{ ...feedMedia[0]!, id: "media one" }],
        index: 0,
        opener,
      });
    });
    expect(opened).toBe(false);
    click(container.querySelector<HTMLButtonElement>("[data-open-catalog]")!);
    act(() => {
      opened = observedProductShell?.openFeedViewer({
        target: feedTarget,
        media: feedMedia,
        index: 0,
        opener,
      });
    });
    expect(opened).toBe(false);
    expect(observedProductShell?.activeFeedViewer).toBeNull();
    expect(
      container
        .querySelector("[data-product-shell]")
        ?.getAttribute("data-viewer-open"),
    ).toBe("false");
  });

  it.each(["home", "discussion", "user"] as const)(
    "opens Settings from the committed %s destination",
    async (destination) => {
      const pushState = vi.spyOn(window.history, "pushState");
      const { container } = renderProductShell();
      await act(async () => vi.runAllTimers());

      if (destination !== "home") {
        click(
          buttonByLabel(
            container,
            destination === "discussion" ? "讨论" : "用户",
          ),
        );
        await act(async () => vi.runAllTimers());
      }
      pushState.mockClear();

      click(buttonByLabel(container, "从用户页打开设置"));
      await act(async () => vi.runAllTimers());

      expect(pushState).toHaveBeenCalledOnce();
      expect(pushState).toHaveBeenCalledWith(
        withHistoryMarkers(settingsHistoryState(destination)),
        "",
        "/dev/t02p#settings",
      );
      expect(dialog(container)).not.toBeNull();
      expect(
        container.querySelectorAll("[data-primary-destination]"),
      ).toHaveLength(3);
    },
  );

  it("defaults to light even when the system prefers dark", async () => {
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: vi.fn(() => createMediaQueryList(true)),
    });

    renderProductShell(<ProductShellObserver />);
    await act(async () => vi.runAllTimers());

    expect(observedProductShell?.theme).toBe("light");
    expect(document.documentElement.dataset.theme).toBe("light");
    expect(document.documentElement.dataset.effectiveTheme).toBe("light");
  });

  it("uses light when access to localStorage itself is blocked", async () => {
    const storage = vi.spyOn(window, "localStorage", "get");
    storage.mockImplementation(() => {
      throw new DOMException("blocked", "SecurityError");
    });
    try {
      renderProductShell(<ProductShellObserver />);
      await act(async () => vi.runAllTimers());
      expect(observedProductShell?.theme).toBe("light");
      expect(document.documentElement.dataset.theme).toBe("light");
    } finally {
      storage.mockRestore();
    }
  });

  it.each([
    ["dark", 390],
    ["system", 834],
  ] as const)(
    "hydrates legacy %s preferences to defaults at width %s and retains subsequent choices",
    async (legacyTheme, width) => {
      Object.defineProperty(window, "innerWidth", {
        configurable: true,
        value: width,
      });
      window.localStorage.setItem("yoyi.theme-preference", legacyTheme);
      window.localStorage.setItem("yoyi.home-feed-layout", "double");
      window.localStorage.setItem("yoyi.publishing.original-quality", "true");
      window.eval(PRODUCT_BOOT_SCRIPT);
      expect(document.documentElement.dataset.theme).toBe("light");
      expect(document.documentElement.dataset.homeLayout).toBe("single");
      renderProductShell(<ProductShellObserver />);
      await act(async () => vi.runAllTimers());
      expect(observedProductShell?.theme).toBe("light");
      expect(observedProductShell?.feedLayout).toBe("single");
      expect(document.documentElement.dataset.theme).toBe("light");
      expect(document.documentElement.dataset.homeLayout).toBe("single");
      await act(async () => {
        observedProductShell!.setThemePreference(legacyTheme);
        observedProductShell!.setFeedLayoutPreference("double");
      });
      for (const root of mountedRoots.splice(0)) act(() => root.unmount());
      document.body.replaceChildren();
      // A legacy tab cannot change the versioned choices made after the reset.
      window.localStorage.setItem("yoyi.theme-preference", "light");
      window.localStorage.setItem("yoyi.home-feed-layout", "single");
      renderProductShell(<ProductShellObserver />);
      await act(async () => vi.runAllTimers());
      expect(observedProductShell?.theme).toBe(legacyTheme);
      expect(observedProductShell?.feedLayout).toBe("double");
      expect(
        window.localStorage.getItem("yoyi.publishing.original-quality"),
      ).toBe("true");
    },
  );

  it("updates the effective theme when the saved system preference changes", async () => {
    window.localStorage.setItem(THEME_PREFERENCE_STORAGE_KEY, "system");
    let systemIsDark = false;
    let notifySystemThemeChange = () => {};
    const media = {
      addEventListener: (_type: string, listener: () => void) => {
        notifySystemThemeChange = listener;
      },
      get matches() {
        return systemIsDark;
      },
      removeEventListener: vi.fn(),
    } as unknown as MediaQueryList;
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: vi.fn(() => media),
    });

    renderProductShell();
    await act(async () => vi.runAllTimers());
    expect(document.documentElement.dataset.effectiveTheme).toBe("light");

    systemIsDark = true;
    act(() => notifySystemThemeChange());
    expect(document.documentElement.dataset.effectiveTheme).toBe("dark");
  });

  it("loads, applies, cycles, and persists canonical preferences", async () => {
    vi.spyOn(navigator, "userAgent", "get").mockReturnValue("iPhone Mobile");
    window.localStorage.setItem(THEME_PREFERENCE_STORAGE_KEY, "dark");
    window.localStorage.setItem(FEED_LAYOUT_PREFERENCE_STORAGE_KEY, "single");
    const { container } = renderProductShell();
    await act(async () => vi.runAllTimers());

    expect(
      container
        .querySelector("[data-product-shell]")
        ?.getAttribute("data-theme-preference"),
    ).toBe("dark");
    expect(
      container
        .querySelector("[data-product-shell]")
        ?.getAttribute("data-feed-layout"),
    ).toBe("single");
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(document.documentElement.dataset.homeLayout).toBe("single");

    click(buttonByLabel(container, "从用户页打开设置"));
    click(buttonByLabel(container, /切换主题/));
    click(buttonByLabel(container, /切换布局/));

    expect(window.localStorage.getItem(THEME_PREFERENCE_STORAGE_KEY)).toBe(
      "system",
    );
    expect(
      window.localStorage.getItem(FEED_LAYOUT_PREFERENCE_STORAGE_KEY),
    ).toBe("double");
    expect(document.documentElement.hasAttribute("data-theme")).toBe(false);
    expect(document.documentElement.dataset.homeLayout).toBe("double");
  });

  it("restores independent phone scroll positions without unmounting content", async () => {
    const { container } = renderProductShell();
    await act(async () => vi.runAllTimers());
    const home = container.querySelector<HTMLElement>(
      '[data-primary-destination="home"]',
    )!;
    const discussion = container.querySelector<HTMLElement>(
      '[data-primary-destination="discussion"]',
    )!;
    for (const element of [home, discussion]) {
      Object.defineProperty(element, "scrollHeight", {
        configurable: true,
        value: 1_000,
      });
      Object.defineProperty(element, "clientHeight", {
        configurable: true,
        value: 400,
      });
    }

    home.scrollTop = 240;
    click(buttonByLabel(container, "讨论"));
    await act(async () => vi.runAllTimers());
    discussion.scrollTop = 130;
    click(buttonByLabel(container, "首页"));
    await act(async () => vi.runAllTimers());

    expect(home.scrollTop).toBe(240);
    expect(discussion.scrollTop).toBe(130);
  });
  it("restores Profile tab and scroll through Work and Viewer history", async () => {
    const app = renderAuthorShell();
    await act(async () => vi.runAllTimers());
    const primary = window.history.state;
    click(buttonByLabel(app.container, "个人主页"));
    act(() => app.profile().onViewChange("favorites", 188));
    await act(async () => vi.runAllTimers());
    const profile = window.history.state;
    click(buttonByLabel(app.container, "打开作品"));
    expect(app.detail().target).toEqual({ type: "work", id: workId });
    act(() => app.detail().onScrollTopChange(73));
    await act(async () => vi.runAllTimers());
    const detail = window.history.state;
    click(buttonByLabel(app.container, "打开作品图像"));
    expect(observedProductShell?.activeViewerMediaId).toBe("image-one");
    traverse(detail);
    await act(async () => vi.runAllTimers());
    expect(app.detail().initialScrollTop).toBe(73);
    expect(observedProductShell?.activeViewerMediaId).toBeNull();
    traverse(profile);
    await act(async () => vi.runAllTimers());
    expect(app.profile().state.tab).toBe("favorites");
    expect(app.profile().state.profileScrollTop).toBe(188);
    expect(document.activeElement).toBe(
      buttonByLabel(app.container, "打开作品"),
    );
    traverse(primary);
    await act(async () => vi.runAllTimers());
    expect(observedProductShell?.activeProfile).toBeNull();
    expect(document.activeElement).toBe(
      buttonByLabel(app.container, "个人主页"),
    );
  });
  it("restores explicit same-document links with null native state and reloads a repeated Detail", async () => {
    const app = renderAuthorShell();
    await act(async () => vi.runAllTimers());
    click(buttonByLabel(app.container, "个人主页"));
    click(buttonByLabel(app.container, "打开作品"));
    const previous = app.detail().navigationRevision;
    act(() => {
      window.history.replaceState(
        null,
        "",
        `/dev/t02p?workId=${workId}#detail`,
      );
      window.dispatchEvent(new PopStateEvent("popstate", { state: null }));
    });
    await act(async () => vi.runAllTimers());
    expect(app.detail().target).toEqual({ type: "work", id: workId });
    expect(app.detail().navigationRevision).toBe(previous + 1);
    expect(parseProductHistoryState(window.history.state)?.kind).toBe("detail");
    act(() => {
      window.history.replaceState(
        null,
        "",
        `/dev/t02p?authorId=${authorId}#profile`,
      );
      window.dispatchEvent(new PopStateEvent("popstate", { state: null }));
    });
    await act(async () => vi.runAllTimers());
    expect(app.profile().state.authorId).toBe(authorId);
    expect(observedProductShell?.activeContent).toBeNull();
  });
  it("remembers Detail scroll immediately when native Back precedes the checkpoint timer", async () => {
    const app = renderAuthorShell();
    await act(async () => vi.runAllTimers());
    click(buttonByLabel(app.container, "个人主页"));
    const profile = window.history.state;
    click(buttonByLabel(app.container, "打开作品"));
    const detail = window.history.state;
    act(() => app.detail().onScrollTopChange(217));
    traverse(profile);
    traverse(detail);
    await act(async () => vi.runAllTimers());
    expect(app.detail().initialScrollTop).toBe(217);
  });
  it("resets all old-document offsets when returning from a refreshed Viewer", async () => {
    const old = (value: unknown) => ({
      ...(value as Record<string, unknown>),
      __artvennDocument: "old-document",
      __artvennEntry: "old-entry",
    });
    window.history.replaceState(
      old(
        viewerHistoryState(
          { type: "work", id: workId },
          "image-one",
          "home",
          146,
          73,
        ),
      ),
      "",
      `/dev/t02p?workId=${workId}&image=image-one#viewer`,
    );
    const app = renderAuthorShell();
    await act(async () => vi.runAllTimers());
    expect(app.detail().initialScrollTop).toBe(0);
    traverse(
      old(detailHistoryState({ type: "work", id: workId }, "home", 146, 73)),
    );
    await act(async () => vi.runAllTimers());
    expect(app.detail().initialScrollTop).toBe(0);
    traverse(
      old(
        profileHistoryState(
          authorId,
          "profile-entry",
          "favorites",
          188,
          "home",
          146,
        ),
      ),
    );
    await act(async () => vi.runAllTimers());
    expect(app.profile().state.profileScrollTop).toBe(0);
    expect(app.profile().state.sourceScrollTop).toBe(0);
  });
  it("bounds Profile scroll history writes and keeps disabled work/profile routes closed", async () => {
    const app = renderAuthorShell();
    await act(async () => vi.runAllTimers());
    click(buttonByLabel(app.container, "个人主页"));
    const replace = vi.spyOn(window.history, "replaceState");
    replace.mockClear();
    act(() => {
      for (let top = 1; top <= 100; top++)
        app.profile().onViewChange("works", top);
    });
    expect(replace).not.toHaveBeenCalled();
    await act(async () => vi.advanceTimersByTimeAsync(500));
    expect(replace).toHaveBeenCalledOnce();
    for (const root of mountedRoots.splice(0)) act(() => root.unmount());
    document.body.replaceChildren();
    window.history.replaceState(null, "", `/dev/t02p?workId=${workId}#detail`);
    const disabled = renderAuthorShell(false);
    await act(async () => vi.runAllTimers());
    expect(observedProductShell?.activeContent).toBeNull();
    const button = buttonByLabel(disabled.container, "个人主页");
    click(button);
    act(() =>
      observedProductShell?.openContent({ type: "work", id: workId }, button),
    );
    expect(observedProductShell?.activeProfile).toBeNull();
    expect(observedProductShell?.activeContent).toBeNull();
  });
  it.each([false, true])(
    "only composes a direct Article editor when its Development seam is enabled: %s",
    async (articleEnabled) => {
      window.history.replaceState(null, "", "/dev/t02p#article-editor");
      const app = renderEditorShell(true, false, articleEnabled);
      await act(async () => vi.runAllTimers());
      if (articleEnabled)
        expect(app.editor().target).toEqual({ type: "article-list" });
      else expect(editorDialog(app.container)).toBeNull();
    },
  );
  it("synchronizes Article URLs through the Next-style native history wrapper while retaining router state", async () => {
    const nativePush = History.prototype.pushState.bind(window.history);
    const nativeReplace = History.prototype.replaceState.bind(window.history);
    const routerState = {
      __NA: true,
      __PRIVATE_NEXTJS_INTERNALS_TREE: ["synthetic-router"],
    };
    nativeReplace({ ...window.history.state, ...routerState }, "");
    let canonical = `${window.location.pathname}${window.location.hash}`;
    const wrap =
      (native: typeof window.history.pushState) =>
      (
        data: Record<string, unknown>,
        title: string,
        url?: string | URL | null,
      ) => {
        if (!data?.__NA && !data?._N) {
          if (url) canonical = String(url);
          data = {
            ...data,
            __NA: window.history.state?.__NA,
            __PRIVATE_NEXTJS_INTERNALS_TREE:
              window.history.state?.__PRIVATE_NEXTJS_INTERNALS_TREE,
          };
        }
        native(data, title, url);
      };
    const pushMock = vi
      .spyOn(window.history, "pushState")
      .mockImplementation(wrap(nativePush));
    const replaceMock = vi
      .spyOn(window.history, "replaceState")
      .mockImplementation(wrap(nativeReplace));
    const app = renderEditorShell(true, false, true);
    await act(async () => vi.runAllTimers());
    act(() =>
      observedProductShell!.openEditor(
        { type: "article-list" },
        buttonByLabel(app.container, "发布作品"),
      ),
    );
    expect(canonical).toContain("#article-editor");
    expect(window.history.state.__PRIVATE_NEXTJS_INTERNALS_TREE).toEqual(
      routerState.__PRIVATE_NEXTJS_INTERNALS_TREE,
    );
    const target = {
      type: "article-draft",
      id: "article-" + "d".repeat(32),
    } as const;
    act(() => app.editor().controls.replaceTarget(target));
    expect(app.editor().target).toEqual(target);
    nativeReplace(window.history.state, "", canonical);
    expect(window.location.hash).toBe("#article-editor");
    pushMock.mockRestore();
    replaceMock.mockRestore();
  });
  it("keeps a private Article draft mounted when its registered guard rejects history Back", async () => {
    const app = renderEditorShell(true, false, true);
    await act(async () => vi.runAllTimers());
    const opener = buttonByLabel(app.container, "发布作品");
    const target = {
      type: "article-draft",
      id: "article-" + "d".repeat(32),
    } as const;
    act(() =>
      expect(observedProductShell!.openEditor(target, opener)).toBe(true),
    );
    await act(async () => vi.runAllTimers());
    const guard = vi.fn(() => "blocked" as const);
    act(() => app.editor().controls.registerLeaveGuard(guard));
    traverse(sameDocument(primaryHistoryState("home", 0)));
    await act(async () => vi.runAllTimers());
    expect(guard).toHaveBeenCalledWith("history");
    expect(app.editor().target).toEqual(target);
    expect(window.location.hash).toBe("#article-editor");
    expect(editorDialog(app.container)).not.toBeNull();
  });
  it("owns Editor history, inertness, dock hiding, Back scroll, and opener focus", async () => {
    const pushState = vi.spyOn(window.history, "pushState");
    const replaceState = vi.spyOn(window.history, "replaceState");
    const app = renderEditorShell();
    await act(async () => vi.runAllTimers());
    const home = scrollable(
      app.container.querySelector<HTMLElement>(
        '[data-primary-destination="home"]',
      )!,
    );
    home.scrollTop = 146;
    const opener = buttonByLabel(app.container, "发布作品");

    click(opener);
    await act(async () => vi.runAllTimers());

    expect(replaceState).toHaveBeenCalledWith(
      withHistoryMarkers(primaryHistoryState("home", 146)),
      "",
      "/dev/t02p",
    );
    expect(pushState).toHaveBeenCalledWith(
      withHistoryMarkers(editorHistoryState({ type: "new" }, "home", 146)),
      "",
      "/dev/t02p#editor",
    );
    expect(app.editor().target).toEqual({ type: "new" });
    expect(observedProductShell?.activeEditor).toEqual({ type: "new" });
    const layer = app.container.querySelector("[data-product-primary-layer]")!;
    expect(layer.hasAttribute("inert")).toBe(true);
    expect(layer.getAttribute("aria-hidden")).toBe("true");
    expect(
      app.container
        .querySelector("[data-primary-navigation-layer]")
        ?.hasAttribute("hidden"),
    ).toBe(true);
    expect(
      app.container
        .querySelector("[data-product-shell]")
        ?.getAttribute("data-editor-open"),
    ).toBe("true");
    expect(document.body.style.overflow).toBe("hidden");
    expect(document.activeElement).toBe(
      buttonByLabel(app.container, "返回编辑"),
    );

    home.scrollTop = 0;
    traverse(sameDocument(primaryHistoryState("home", 146)));
    await act(async () => vi.runAllTimers());

    expect(editorDialog(app.container)).toBeNull();
    expect(observedProductShell?.activeEditor).toBeNull();
    expect(layer.hasAttribute("inert")).toBe(false);
    expect(home.scrollTop).toBe(146);
    expect(document.activeElement).toBe(opener);
  });

  it("opens the Editor from another primary destination and returns to its position", async () => {
    const pushState = vi.spyOn(window.history, "pushState");
    const app = renderEditorShell();
    await act(async () => vi.runAllTimers());
    click(buttonByLabel(app.container, "用户"));
    await act(async () => vi.runAllTimers());
    const user = scrollable(
      app.container.querySelector<HTMLElement>(
        '[data-primary-destination="user"]',
      )!,
    );
    user.scrollTop = 212;

    click(buttonByLabel(app.container, "继续草稿"));
    await act(async () => vi.runAllTimers());
    // The private draft ID lives in history state, never in the address.
    expect(pushState).toHaveBeenLastCalledWith(
      withHistoryMarkers(
        editorHistoryState({ type: "draft", id: draftId }, "user", 212),
      ),
      "",
      "/dev/t02p#editor",
    );
    expect(window.location.search).toBe("");

    user.scrollTop = 0;
    traverse(sameDocument(primaryHistoryState("user", 212)));
    await act(async () => vi.runAllTimers());
    expect(observedProductShell?.activeDestination).toBe("user");
    expect(user.scrollTop).toBe(212);
    expect(editorDialog(app.container)).toBeNull();
  });

  it("closes through its return bar by history Back without asking an allowing guard twice", async () => {
    const back = vi
      .spyOn(window.history, "back")
      .mockImplementation(() => undefined);
    back.mockClear();
    const app = renderEditorShell();
    await act(async () => vi.runAllTimers());
    click(buttonByLabel(app.container, "发布作品"));
    await act(async () => vi.runAllTimers());
    const guard = vi.fn(() => "allow" as const);
    act(() => {
      app.editor().controls.registerLeaveGuard(guard);
    });

    click(buttonByLabel(app.container, "返回编辑"));
    expect(guard).toHaveBeenCalledExactlyOnceWith("close");
    expect(back).toHaveBeenCalledOnce();
    traverse(sameDocument(primaryHistoryState("home", 0)));
    await act(async () => vi.runAllTimers());
    expect(guard).toHaveBeenCalledOnce();
    expect(editorDialog(app.container)).toBeNull();
    expect(beforeUnloadPrevented()).toBe(false);
  });

  it("expires an approval whose Back never arrived and never lets it cover a new guard", async () => {
    const back = vi
      .spyOn(window.history, "back")
      .mockImplementation(() => undefined);
    back.mockClear();
    const app = renderEditorShell();
    await act(async () => vi.runAllTimers());
    click(buttonByLabel(app.container, "发布作品"));
    await act(async () => vi.runAllTimers());
    const guard = vi.fn<(reason: string) => "allow" | "blocked">(() => "allow");
    act(() => {
      app.editor().controls.registerLeaveGuard(guard);
    });

    click(buttonByLabel(app.container, "返回编辑"));
    expect(back).toHaveBeenCalledOnce();
    // No popstate followed; the author keeps editing and later presses Back.
    await act(async () => vi.advanceTimersByTimeAsync(1_000));
    guard.mockReturnValue("blocked");
    traverse(sameDocument(primaryHistoryState("home", 0)));
    await act(async () => vi.runAllTimers());
    expect(guard).toHaveBeenLastCalledWith("history");
    expect(editorDialog(app.container)).not.toBeNull();
    expect(parseProductHistoryState(window.history.state)?.kind).toBe("editor");

    guard.mockReturnValue("allow");
    click(buttonByLabel(app.container, "返回编辑"));
    expect(back).toHaveBeenCalledTimes(2);
    const blocking = vi.fn(() => "blocked" as const);
    act(() => {
      app.editor().controls.registerLeaveGuard(blocking);
    });
    traverse(sameDocument(primaryHistoryState("home", 0)));
    await act(async () => vi.runAllTimers());
    expect(blocking).toHaveBeenCalledExactlyOnceWith("history");
    expect(editorDialog(app.container)).not.toBeNull();
  });

  it("lets a blocking guard keep the Editor through close, popstate, and unload", async () => {
    const back = vi
      .spyOn(window.history, "back")
      .mockImplementation(() => undefined);
    back.mockClear();
    const app = renderEditorShell();
    await act(async () => vi.runAllTimers());
    click(buttonByLabel(app.container, "发布作品"));
    await act(async () => vi.runAllTimers());
    expect(beforeUnloadPrevented()).toBe(false);
    const guard = vi.fn<(reason: string) => "allow" | "blocked">(
      () => "blocked",
    );
    let unregister = () => undefined as void;
    act(() => {
      unregister = app.editor().controls.registerLeaveGuard(guard);
    });

    click(buttonByLabel(app.container, "返回编辑"));
    expect(guard).toHaveBeenLastCalledWith("close");
    expect(back).not.toHaveBeenCalled();
    expect(editorDialog(app.container)).not.toBeNull();

    const pushState = vi.spyOn(window.history, "pushState");
    traverse(sameDocument(primaryHistoryState("home", 0)));
    await act(async () => vi.runAllTimers());
    expect(guard).toHaveBeenLastCalledWith("history");
    expect(pushState).toHaveBeenCalledWith(
      withHistoryMarkers(editorHistoryState({ type: "new" }, "home", 0)),
      "",
      "/dev/t02p#editor",
    );
    expect(parseProductHistoryState(window.history.state)?.kind).toBe("editor");
    expect(editorDialog(app.container)).not.toBeNull();
    expect(
      app.container
        .querySelector("[data-product-primary-layer]")
        ?.hasAttribute("inert"),
    ).toBe(true);

    expect(beforeUnloadPrevented()).toBe(true);
    expect(guard).toHaveBeenLastCalledWith("unload");
    act(() => unregister());
    guard.mockClear();
    expect(beforeUnloadPrevented()).toBe(false);
    expect(guard).not.toHaveBeenCalled();

    act(() => {
      app.editor().controls.registerLeaveGuard(guard);
    });
    guard.mockReturnValue("allow");
    traverse(sameDocument(primaryHistoryState("home", 0)));
    await act(async () => vi.runAllTimers());
    expect(editorDialog(app.container)).toBeNull();
    guard.mockClear();
    expect(beforeUnloadPrevented()).toBe(false);
    expect(guard).not.toHaveBeenCalled();
  });

  it("asks a blocking guard before writing anything for a native link's entry", async () => {
    const app = renderEditorShell(true, true);
    await act(async () => vi.runAllTimers());
    click(buttonByLabel(app.container, "发布作品"));
    await act(async () => vi.runAllTimers());
    const guard = vi.fn<(reason: string) => "allow" | "blocked">(
      () => "blocked",
    );
    act(() => {
      app.editor().controls.registerLeaveGuard(guard);
    });
    const replaceState = vi.spyOn(window.history, "replaceState");
    const pushState = vi.spyOn(window.history, "pushState");
    const followLink = (url: string) =>
      act(() => {
        window.history.replaceState(null, "", url);
        window.dispatchEvent(new PopStateEvent("popstate", { state: null }));
      });
    replaceState.mockClear();
    pushState.mockClear();

    followLink(`/dev/t02p?workId=${workId}#detail`);
    await act(async () => vi.runAllTimers());
    expect(guard).toHaveBeenCalledExactlyOnceWith("history");
    expect(pushState).not.toHaveBeenCalled();
    // The link's own write, then the Editor overwriting that same entry.
    expect(replaceState).toHaveBeenCalledTimes(2);
    expect(replaceState).toHaveBeenLastCalledWith(
      withHistoryMarkers(editorHistoryState({ type: "new" }, "home", 0)),
      "",
      "/dev/t02p#editor",
    );
    expect(`${window.location.search}${window.location.hash}`).toBe("#editor");
    expect(observedProductShell?.activeContent).toBeNull();
    expect(editorDialog(app.container)).not.toBeNull();

    guard.mockReturnValue("allow");
    followLink(`/dev/t02p?workId=${workId}#detail`);
    await act(async () => vi.runAllTimers());
    expect(editorDialog(app.container)).toBeNull();
    expect(app.detail().target).toEqual(workTarget);
    // Only the allowed navigation reloaded Detail.
    expect(app.detail().navigationRevision).toBe(1);
    expect(parseProductHistoryState(window.history.state)?.kind).toBe("detail");
  });

  it("replaces its target in place and keeps other overlays and destinations closed", async () => {
    const replaceState = vi.spyOn(window.history, "replaceState");
    const pushState = vi.spyOn(window.history, "pushState");
    const app = renderEditorShell();
    await act(async () => vi.runAllTimers());
    const opener = buttonByLabel(app.container, "发布作品");
    let opened: boolean | undefined;
    act(() => {
      opened = observedProductShell?.openEditor({ type: "new" }, opener);
    });
    expect(opened).toBe(true);
    await act(async () => vi.runAllTimers());
    replaceState.mockClear();
    pushState.mockClear();
    const controls = app.editor().controls;
    const backButton = buttonByLabel(app.container, "返回编辑");
    const mounts = editorMounts;

    act(() =>
      app.editor().controls.replaceTarget({ type: "draft", id: draftId }),
    );
    expect(replaceState).toHaveBeenCalledOnce();
    expect(replaceState).toHaveBeenCalledWith(
      withHistoryMarkers(
        editorHistoryState({ type: "draft", id: draftId }, "home", 0),
      ),
      "",
      "/dev/t02p#editor",
    );
    expect(app.editor().target).toEqual({ type: "draft", id: draftId });
    // The same session: stable controls, the same host, no remount.
    expect(app.editor().controls).toBe(controls);
    expect(buttonByLabel(app.container, "返回编辑")).toBe(backButton);
    expect(editorMounts).toBe(mounts);
    act(() =>
      app.editor().controls.replaceTarget({ type: "draft", id: "invalid" }),
    );
    expect(replaceState).toHaveBeenCalledOnce();

    act(() => {
      opened = observedProductShell?.openEditor({ type: "new" }, opener);
      observedProductShell?.openCatalog("catalog-one", opener);
      observedProductShell?.requestSettings(opener);
    });
    expect(opened).toBe(false);
    click(buttonByLabel(app.container, "讨论"));
    await act(async () => vi.runAllTimers());
    expect(pushState).not.toHaveBeenCalled();
    expect(observedProductShell?.activeContent).toBeNull();
    expect(observedProductShell?.settingsOpen).toBe(false);
    expect(observedProductShell?.activeDestination).toBe("home");
    expect(app.editor().target).toEqual({ type: "draft", id: draftId });
  });

  it("keeps one session for its own link and starts a guard-free one when history switches editors", async () => {
    const app = renderEditorShell();
    await act(async () => vi.runAllTimers());
    click(buttonByLabel(app.container, "发布作品"));
    await act(async () => vi.runAllTimers());
    act(() =>
      app.editor().controls.replaceTarget({ type: "draft", id: draftId }),
    );
    const guard = vi.fn<(reason: string) => "allow" | "blocked">(
      () => "blocked",
    );
    act(() => {
      app.editor().controls.registerLeaveGuard(guard);
    });
    const backButton = buttonByLabel(app.container, "返回编辑");
    const mounts = editorMounts;
    const followLink = (url: string) =>
      act(() => {
        window.history.replaceState(null, "", url);
        window.dispatchEvent(new PopStateEvent("popstate", { state: null }));
      });

    // The draft's own plain link is the same Editor, not a new work.
    followLink("/dev/t02p#editor");
    await act(async () => vi.runAllTimers());
    expect(guard).not.toHaveBeenCalled();
    expect(app.editor().target).toEqual({ type: "draft", id: draftId });
    expect(parseProductHistoryState(window.history.state)).toEqual(
      editorHistoryState({ type: "draft", id: draftId }, "home", 0),
    );
    expect(editorMounts).toBe(mounts);

    followLink(`/dev/t02p?workId=${workId}#editor`);
    await act(async () => vi.runAllTimers());
    expect(guard).toHaveBeenCalledExactlyOnceWith("history");
    expect(app.editor().target).toEqual({ type: "draft", id: draftId });
    expect(`${window.location.search}${window.location.hash}`).toBe("#editor");

    guard.mockReturnValue("allow");
    followLink(`/dev/t02p?workId=${workId}#editor`);
    await act(async () => vi.runAllTimers());
    expect(app.editor().target).toEqual(workTarget);
    expect(editorMounts).toBe(mounts + 1);
    const nextBackButton = buttonByLabel(app.container, "返回编辑");
    expect(nextBackButton).not.toBe(backButton);
    expect(document.activeElement).toBe(nextBackButton);
    guard.mockClear();
    expect(beforeUnloadPrevented()).toBe(false);
    expect(guard).not.toHaveBeenCalled();
  });

  it("opens over Detail and Back returns to that Detail, its scroll and its back button", async () => {
    const replaceState = vi.spyOn(window.history, "replaceState");
    const pushState = vi.spyOn(window.history, "pushState");
    const app = renderEditorShell(true, true);
    await act(async () => vi.runAllTimers());
    const home = scrollable(
      app.container.querySelector<HTMLElement>(
        '[data-primary-destination="home"]',
      )!,
    );
    home.scrollTop = 146;
    act(() =>
      observedProductShell?.openContent(
        workTarget,
        buttonByLabel(app.container, "发布作品"),
      ),
    );
    act(() => app.detail().onScrollTopChange(73));
    replaceState.mockClear();

    click(buttonByLabel(app.container, "编辑作品"));
    const detailEntry = [...replaceState.mock.calls]
      .reverse()
      .find(([state]) => parseProductHistoryState(state)?.kind === "detail")
      ?.at(0);
    expect(parseProductHistoryState(detailEntry)).toEqual(
      detailHistoryState(workTarget, "home", 146, 73),
    );
    expect(pushState).toHaveBeenLastCalledWith(
      withHistoryMarkers(editorHistoryState(workTarget, "home", 146)),
      "",
      `/dev/t02p?workId=${workId}#editor`,
    );
    expect(observedProductShell?.activeContent).toBeNull();
    expect(
      app.container.querySelector('[role="dialog"][aria-label="Work"]'),
    ).toBeNull();
    await act(async () => vi.runAllTimers());
    expect(document.activeElement).toBe(
      buttonByLabel(app.container, "返回编辑"),
    );

    home.scrollTop = 20;
    traverse(detailEntry);
    await act(async () => vi.runAllTimers());
    expect(editorDialog(app.container)).toBeNull();
    expect(app.detail().target).toEqual(workTarget);
    expect(app.detail().initialScrollTop).toBe(73);
    expect(document.activeElement).toBe(
      buttonByLabel(app.container, "返回作品"),
    );
    // Still under Detail: no primary scroll restore, no opener focus.
    expect(home.scrollTop).toBe(20);
    expect(
      app.container
        .querySelector("[data-product-primary-layer]")
        ?.hasAttribute("inert"),
    ).toBe(true);
  });

  it("opens over Profile and Back returns to its tab, scroll and back button", async () => {
    const replaceState = vi.spyOn(window.history, "replaceState");
    const app = renderEditorShell(true, true);
    await act(async () => vi.runAllTimers());
    act(() =>
      observedProductShell?.openProfile(
        authorId,
        buttonByLabel(app.container, "发布作品"),
      ),
    );
    act(() => app.profile().onViewChange("favorites", 188));
    replaceState.mockClear();

    click(buttonByLabel(app.container, "编辑作品"));
    const profileEntry = [...replaceState.mock.calls]
      .reverse()
      .find(([state]) => parseProductHistoryState(state)?.kind === "profile")
      ?.at(0);
    expect(parseProductHistoryState(profileEntry)).toMatchObject({
      authorId,
      profileScrollTop: 188,
      tab: "favorites",
    });
    expect(parseProductHistoryState(window.history.state)).toEqual(
      editorHistoryState(workTarget, "home", 0),
    );
    expect(observedProductShell?.activeProfile).toBeNull();
    await act(async () => vi.runAllTimers());

    traverse(profileEntry);
    await act(async () => vi.runAllTimers());
    expect(editorDialog(app.container)).toBeNull();
    expect(app.profile().state.tab).toBe("favorites");
    expect(app.profile().state.profileScrollTop).toBe(188);
    expect(document.activeElement).toBe(
      buttonByLabel(app.container, "返回主页"),
    );
  });

  it("completes into the submitted work's Detail, whose Back returns to the browse origin", async () => {
    const replaceState = vi.spyOn(window.history, "replaceState");
    const pushState = vi.spyOn(window.history, "pushState");
    const app = renderEditorShell(true, true);
    await act(async () => vi.runAllTimers());
    const home = scrollable(
      app.container.querySelector<HTMLElement>(
        '[data-primary-destination="home"]',
      )!,
    );
    home.scrollTop = 146;
    click(buttonByLabel(app.container, "发布作品"));
    await act(async () => vi.runAllTimers());
    const guard = vi.fn(() => "blocked" as const);
    act(() => {
      app.editor().controls.registerLeaveGuard(guard);
    });
    replaceState.mockClear();
    pushState.mockClear();

    act(() =>
      app.editor().controls.completeWith({ type: "catalog", id: "has space" }),
    );
    expect(replaceState).not.toHaveBeenCalled();
    expect(editorDialog(app.container)).not.toBeNull();

    act(() => app.editor().controls.completeWith(workTarget));
    expect(pushState).not.toHaveBeenCalled();
    expect(replaceState).toHaveBeenCalledExactlyOnceWith(
      withHistoryMarkers(detailHistoryState(workTarget, "home", 146)),
      "",
      `/dev/t02p?workId=${workId}#detail`,
    );
    await act(async () => vi.runAllTimers());
    expect(editorDialog(app.container)).toBeNull();
    expect(observedProductShell?.activeEditor).toBeNull();
    expect(app.detail().target).toEqual(workTarget);
    expect(app.detail().initialScrollTop).toBe(0);
    expect(document.activeElement).toBe(
      buttonByLabel(app.container, "返回作品"),
    );
    expect(beforeUnloadPrevented()).toBe(false);
    expect(guard).not.toHaveBeenCalled();

    home.scrollTop = 0;
    traverse(sameDocument(primaryHistoryState("home", 146)));
    await act(async () => vi.runAllTimers());
    expect(observedProductShell?.activeContent).toBeNull();
    expect(home.scrollTop).toBe(146);
  });

  it("completes back to, and reloads, the same work's Detail it was opened over", async () => {
    const back = vi
      .spyOn(window.history, "back")
      .mockImplementation(() => undefined);
    back.mockClear();
    const replaceState = vi.spyOn(window.history, "replaceState");
    const pushState = vi.spyOn(window.history, "pushState");
    const app = renderEditorShell(true, true);
    await act(async () => vi.runAllTimers());
    act(() =>
      observedProductShell?.openContent(
        workTarget,
        buttonByLabel(app.container, "发布作品"),
      ),
    );
    const revision = app.detail().navigationRevision;
    click(buttonByLabel(app.container, "编辑作品"));
    await act(async () => vi.runAllTimers());
    const guard = vi.fn(() => "blocked" as const);
    act(() => {
      app.editor().controls.registerLeaveGuard(guard);
    });
    replaceState.mockClear();
    pushState.mockClear();

    act(() => app.editor().controls.completeWith(workTarget));
    expect(back).toHaveBeenCalledOnce();
    expect(replaceState).not.toHaveBeenCalled();
    expect(pushState).not.toHaveBeenCalled();
    expect(beforeUnloadPrevented()).toBe(false);

    traverse(sameDocument(detailHistoryState(workTarget, "home", 0)));
    await act(async () => vi.runAllTimers());
    expect(guard).not.toHaveBeenCalled();
    expect(editorDialog(app.container)).toBeNull();
    expect(app.detail().target).toEqual(workTarget);
    expect(app.detail().navigationRevision).toBe(revision + 1);
    expect(document.activeElement).toBe(
      buttonByLabel(app.container, "返回作品"),
    );
  });

  it("rebuilds exact Editor links above their source and keeps private, disabled or malformed links closed", async () => {
    window.history.replaceState(
      null,
      "",
      `/dev/t02p?feed=nearby&workId=${workId}#editor`,
    );
    const replaceState = vi.spyOn(window.history, "replaceState");
    const pushState = vi.spyOn(window.history, "pushState");
    const app = renderEditorShell(true, true);
    await act(async () => vi.runAllTimers());
    // On load, #editor beats the work Detail the same link also names.
    expect(app.editor().target).toEqual(workTarget);
    expect(observedProductShell?.activeContent).toBeNull();
    expect(replaceState).toHaveBeenCalledWith(
      withHistoryMarkers(primaryHistoryState("home", 0)),
      "",
      "/dev/t02p?feed=nearby",
    );
    expect(pushState).toHaveBeenCalledWith(
      withHistoryMarkers(editorHistoryState(workTarget, "home", 0)),
      "",
      `/dev/t02p?feed=nearby&workId=${workId}#editor`,
    );
    expect(document.activeElement).toBe(
      buttonByLabel(app.container, "返回编辑"),
    );

    // A same-document plain #editor link switches to a new work.
    act(() => {
      window.history.replaceState(null, "", "/dev/t02p#editor");
      window.dispatchEvent(new PopStateEvent("popstate", { state: null }));
    });
    await act(async () => vi.runAllTimers());
    expect(app.editor().target).toEqual({ type: "new" });
    expect(observedProductShell?.activeContent).toBeNull();

    // A reload restores a draft from history state alone.
    for (const root of mountedRoots.splice(0)) act(() => root.unmount());
    document.body.replaceChildren();
    window.history.replaceState(
      {
        ...editorHistoryState({ type: "draft", id: draftId }, "user", 212),
        __artvennDocument: "old-document",
      },
      "",
      "/dev/t02p#editor",
    );
    const restored = renderEditorShell();
    await act(async () => vi.runAllTimers());
    expect(restored.editor().target).toEqual({ type: "draft", id: draftId });
    expect(observedProductShell?.activeDestination).toBe("user");
    expect(window.location.search).toBe("");

    for (const [enabled, url] of [
      [true, `/dev/t02p?draftId=${draftId}#editor`],
      [true, "/dev/t02p?workId=work-invalid#editor"],
      [false, "/dev/t02p#editor"],
    ] as const) {
      for (const root of mountedRoots.splice(0)) act(() => root.unmount());
      document.body.replaceChildren();
      window.history.replaceState(null, "", url);
      const closed = renderEditorShell(enabled);
      await act(async () => vi.runAllTimers());
      expect(editorDialog(closed.container)).toBeNull();
      expect(observedProductShell?.activeEditor).toBeNull();
      expect(parseProductHistoryState(window.history.state)?.kind).toBe(
        "primary",
      );
      expect(`${window.location.search}${window.location.hash}`).toBe("");
      let opened: boolean | undefined;
      act(() => {
        opened = observedProductShell?.openEditor(
          { type: "new" },
          buttonByLabel(closed.container, "发布作品"),
        );
      });
      expect(opened).toBe(enabled);
      expect(observedProductShell?.activeEditor).toEqual(
        enabled ? { type: "new" } : null,
      );
    }
  });
  it("persists explicit choices through the same root and preserves cycle APIs", async () => {
    vi.spyOn(navigator, "userAgent", "get").mockReturnValue("iPhone Mobile");
    renderProductShell(<ProductShellObserver />);
    await act(async () => {
      observedProductShell!.setThemePreference("dark");
      observedProductShell!.setFeedLayoutPreference("single");
    });
    expect(window.localStorage.getItem(THEME_PREFERENCE_STORAGE_KEY)).toBe(
      "dark",
    );
    expect(
      window.localStorage.getItem(FEED_LAYOUT_PREFERENCE_STORAGE_KEY),
    ).toBe("single");
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(document.documentElement.dataset.homeLayout).toBe("single");
    await act(async () => {
      observedProductShell!.cycleTheme();
      observedProductShell!.cycleFeedLayout();
    });
    expect(window.localStorage.getItem(THEME_PREFERENCE_STORAGE_KEY)).toBe(
      "system",
    );
    expect(
      window.localStorage.getItem(FEED_LAYOUT_PREFERENCE_STORAGE_KEY),
    ).toBe("double");
  });

  describe("desktop preference scope", () => {
    it.each([390, 800, 895, 896, 2560])(
      "hydrates and writes the desktop key at width %s without changing mobile preferences",
      async (width) => {
        vi.spyOn(navigator, "userAgent", "get").mockReturnValue(
          "Desktop Browser",
        );
        Object.defineProperty(window, "innerWidth", {
          configurable: true,
          value: width,
        });
        window.localStorage.setItem(
          FEED_LAYOUT_PREFERENCE_STORAGE_KEY,
          "single",
        );
        window.localStorage.setItem(
          DESKTOP_FEED_LAYOUT_PREFERENCE_STORAGE_KEY,
          "double",
        );
        window.eval(PRODUCT_BOOT_SCRIPT);
        expect(document.documentElement.dataset.homeLayout).toBe("double");
        renderProductShell(<ProductShellObserver />);
        await act(async () => vi.runAllTimers());
        expect(observedProductShell?.feedLayout).toBe("double");
        expect(observedProductShell?.desktop).toBe(width >= 896);
        act(() => observedProductShell!.setFeedLayoutPreference("single"));
        expect(
          window.localStorage.getItem(
            DESKTOP_FEED_LAYOUT_PREFERENCE_STORAGE_KEY,
          ),
        ).toBe("single");
        expect(
          window.localStorage.getItem(FEED_LAYOUT_PREFERENCE_STORAGE_KEY),
        ).toBe("single");
        for (const nextWidth of [800, 1280, 390]) {
          act(() => {
            Object.defineProperty(window, "innerWidth", {
              configurable: true,
              value: nextWidth,
            });
            window.dispatchEvent(new Event("resize"));
          });
          expect(observedProductShell?.feedLayout).toBe("single");
          expect(observedProductShell?.desktop).toBe(nextWidth >= 896);
        }
      },
    );

    it("defaults a desktop to calligraphy independently of a saved phone normal mode", async () => {
      window.localStorage.setItem(FEED_LAYOUT_PREFERENCE_STORAGE_KEY, "double");
      renderProductShell(<ProductShellObserver />);
      await act(async () => vi.runAllTimers());
      expect(observedProductShell?.feedLayout).toBe("single");
      expect(
        window.localStorage.getItem(FEED_LAYOUT_PREFERENCE_STORAGE_KEY),
      ).toBe("double");
      expect(
        window.localStorage.getItem(DESKTOP_FEED_LAYOUT_PREFERENCE_STORAGE_KEY),
      ).toBeNull();
    });

    it("keeps a wide iPad on the existing phone/tablet key", async () => {
      vi.spyOn(navigator, "userAgent", "get").mockReturnValue("iPad");
      Object.defineProperty(window, "innerWidth", {
        configurable: true,
        value: 1280,
      });
      window.localStorage.setItem(FEED_LAYOUT_PREFERENCE_STORAGE_KEY, "single");
      window.localStorage.setItem(
        DESKTOP_FEED_LAYOUT_PREFERENCE_STORAGE_KEY,
        "double",
      );
      renderProductShell(<ProductShellObserver />);
      await act(async () => vi.runAllTimers());
      expect(observedProductShell?.desktop).toBe(false);
      expect(observedProductShell?.platform).toBe("tablet");
      expect(observedProductShell?.feedLayout).toBe("single");
      act(() => observedProductShell!.setFeedLayoutPreference("double"));
      expect(
        window.localStorage.getItem(FEED_LAYOUT_PREFERENCE_STORAGE_KEY),
      ).toBe("double");
      expect(
        window.localStorage.getItem(DESKTOP_FEED_LAYOUT_PREFERENCE_STORAGE_KEY),
      ).toBe("double");
    });

    it("keeps session choices usable when access to browser storage is blocked", async () => {
      vi.spyOn(window, "localStorage", "get").mockImplementation(() => {
        throw new DOMException("blocked", "SecurityError");
      });
      renderProductShell(<ProductShellObserver />);
      await act(async () => vi.runAllTimers());
      expect(observedProductShell?.feedLayout).toBe("single");
      act(() => {
        observedProductShell!.setFeedLayoutPreference("double");
        observedProductShell!.setThemePreference("dark");
      });
      expect(observedProductShell?.feedLayout).toBe("double");
      expect(observedProductShell?.theme).toBe("dark");
    });
  });

  it("delegates settings to the current page and ignores disposal of an older intent", async () => {
    const { container } = renderProductShell(<ProductShellObserver />);
    await act(async () => vi.runAllTimers());
    const first = vi.fn(),
      current = vi.fn();
    const removeFirst = observedProductShell!.registerSettingsIntent(first);
    const removeCurrent = observedProductShell!.registerSettingsIntent(current);
    removeFirst();
    const opener = buttonByLabel(container, "从用户页打开设置");
    click(opener);
    expect(first).not.toHaveBeenCalled();
    expect(current).toHaveBeenCalledExactlyOnceWith(opener);
    expect(observedProductShell?.settingsOpen).toBe(false);
    removeCurrent();
    click(opener);
    expect(observedProductShell?.settingsOpen).toBe(true);
    expect(dialog(container)).not.toBeNull();
  });

  describe("browse-only (pc-browse-only-v1)", () => {
    const anonymous: BrowseOnlyPolicy = { session: false };
    const iPadAgent =
      "Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";
    // iPadOS can identify itself as a Mac while keeping multi-touch.
    const iPadOsAgent =
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15";
    const restores: (() => void)[] = [];

    afterEach(() => {
      for (const root of mountedRoots.splice(0)) act(() => root.unmount());
      for (const restore of restores.splice(0)) restore();
    });

    const setWidth = (width: number) =>
      Object.defineProperty(window, "innerWidth", {
        configurable: true,
        value: width,
      });
    const resizeTo = (width: number) =>
      act(() => {
        setWidth(width);
        window.dispatchEvent(new Event("resize"));
      });
    const emulateDevice = (userAgent: string, maxTouchPoints: number) => {
      const agent = vi
        .spyOn(navigator, "userAgent", "get")
        .mockReturnValue(userAgent);
      Object.defineProperty(navigator, "maxTouchPoints", {
        configurable: true,
        value: maxTouchPoints,
      });
      restores.push(() => {
        agent.mockRestore();
        delete (navigator as { maxTouchPoints?: number }).maxTouchPoints;
      });
    };
    // Back and Go stay inert here, so any walk the shell starts is recorded.
    const watchHistory = () => {
      const spies = {
        back: vi
          .spyOn(window.history, "back")
          .mockImplementation(() => undefined),
        go: vi.spyOn(window.history, "go").mockImplementation(() => undefined),
        pushState: vi.spyOn(window.history, "pushState"),
      };
      for (const spy of Object.values(spies)) spy.mockClear();
      restores.push(() => {
        for (const spy of Object.values(spies)) spy.mockRestore();
      });
      return spies;
    };
    const expectNoHistoryWalk = (spies: ReturnType<typeof watchHistory>) => {
      expect(spies.back).not.toHaveBeenCalled();
      expect(spies.go).not.toHaveBeenCalled();
      expect(spies.pushState).not.toHaveBeenCalled();
    };
    const address = () =>
      `${window.location.pathname}${window.location.search}${window.location.hash}`;
    const traverseTo = (state: unknown, url: string) =>
      act(() => {
        window.history.replaceState(state, "", url);
        window.dispatchEvent(new PopStateEvent("popstate", { state }));
      });
    const dialogMarkers = () =>
      Object.keys(window.history.state ?? {}).filter((key) =>
        ["phase4Dialog", "phase4DialogDepth", "yoyiPreviewNavigation"].includes(
          key,
        ),
      );

    // A Thread post opened inside a topic marks history as the preview does.
    const ThreadPostPreview = () => {
      usePreviewNavigationHistory({ depth: 1, onBack: () => undefined });
      return null;
    };
    // A 用户 page that owns a modal, as its settings and editors do.
    const UserPageWithDialog = () => (
      <div data-user-probe="">
        <dialog data-user-dialog="" open>
          设置
        </dialog>
      </div>
    );
    // Like a ?topic= link: Discussion asks for itself before the shell syncs.
    const DiscussionRequest = () => {
      const { navigatePrimary } = useProductShell();
      useEffect(() => {
        navigatePrimary("discussion");
      }, [navigatePrimary]);
      return null;
    };

    const browseOnlyShell = ({
      policy = anonymous,
      initialPlatform = "pc",
      home = null,
      user = <p>user</p>,
      topicContent = null,
    }: {
      readonly policy?: BrowseOnlyPolicy | null;
      readonly initialPlatform?: PresentationPlatform;
      readonly home?: ReactNode;
      readonly user?: ReactNode;
      readonly topicContent?: ReactNode;
    } = {}) => (
      <ProductShell
        initialPlatform={initialPlatform}
        {...(policy === null ? {} : { browseOnlyPolicy: policy })}
        articleEditorEnabled
        home={home}
        discussion={<p>discussion</p>}
        user={user}
        navigationAction={
          <button aria-label="停靠操作" type="button">
            Action
          </button>
        }
        primaryUtility={
          <>
            <ProductShellObserver />
            <button aria-label="打开入口" type="button">
              Opener
            </button>
          </>
        }
        renderDetailOverlay={({ backButtonRef, onClose, target }) => (
          <section aria-label={`Detail ${target.id}`} role="dialog">
            <button
              ref={backButtonRef}
              aria-label="返回资料"
              onClick={onClose}
              type="button"
            >
              Back
            </button>
          </section>
        )}
        renderEditorOverlay={(target, controls) => (
          <section
            aria-label="Editor"
            data-editor-target={target.type}
            role="dialog"
          >
            <button
              ref={controls.backButtonRef}
              aria-label="返回编辑"
              onClick={controls.close}
              type="button"
            >
              Back
            </button>
          </section>
        )}
        renderProfileOverlay={({ backButtonRef, onClose }) => (
          <section aria-label="Profile" role="dialog">
            <button
              ref={backButtonRef}
              aria-label="返回主页"
              onClick={onClose}
              type="button"
            >
              Back
            </button>
          </section>
        )}
        renderTopicOverlay={({ backButtonRef, onClose, topicId }) => (
          <section aria-label={`Topic ${topicId}`} role="dialog">
            <button
              ref={backButtonRef}
              aria-label="返回专题"
              onClick={onClose}
              type="button"
            >
              Back
            </button>
            {topicContent}
          </section>
        )}
      />
    );
    const mountShell = (
      options: Parameters<typeof browseOnlyShell>[0] = {},
    ) => {
      const container = document.createElement("div");
      document.body.append(container);
      const root = createRoot(container);
      mountedRoots.push(root);
      const render = (policy: BrowseOnlyPolicy | null) =>
        act(() => root.render(browseOnlyShell({ ...options, policy })));
      render(options.policy === undefined ? anonymous : options.policy);
      return {
        container,
        render,
        opener: () => buttonByLabel(container, "打开入口"),
      };
    };

    const expectBrowseOnly = (container: ParentNode, active: boolean) => {
      expect(observedProductShell?.browseOnly).toBe(active);
      expect(
        container.querySelector<HTMLElement>("[data-product-shell]")?.dataset
          .browseOnly,
      ).toBe(String(active));
      expect(
        container
          .querySelector("[data-primary-navigation-layer]")
          ?.hasAttribute("hidden"),
      ).toBe(active);
      expect(container.querySelector('[aria-label="停靠操作"]') === null).toBe(
        active,
      );
    };
    const expectHomeOnly = (container: ParentNode) => {
      expect(container.querySelector('[role="dialog"]')).toBeNull();
      expect(observedProductShell?.activeProfile).toBeNull();
      expect(observedProductShell?.activeEditor).toBeNull();
      expect(observedProductShell?.activeTopicId).toBeNull();
      expect(observedProductShell?.activeContent).toBeNull();
      expect(observedProductShell?.activeDestination).toBe("home");
      expect(parseProductHistoryState(window.history.state)).toEqual(
        primaryHistoryState("home"),
      );
      expect(dialogMarkers()).toEqual([]);
    };

    it("hides the dock and refuses all but Home and its content at 1280px", async () => {
      setWidth(1280);
      window.history.replaceState(null, "", "/");
      const { container, opener } = mountShell();
      await act(async () => vi.runAllTimers());
      expectBrowseOnly(container, true);
      const history = watchHistory();
      const replaceState = vi.spyOn(window.history, "replaceState");
      replaceState.mockClear();

      for (const destination of ["discussion", "user"] as const) {
        act(() => observedProductShell!.navigatePrimary(destination));
        expect(observedProductShell?.activeDestination).toBe("home");
      }
      act(() => observedProductShell!.openProfile(authorId, opener()));
      act(() => observedProductShell!.openProfile(null, opener()));
      expect(observedProductShell?.activeProfile).toBeNull();
      const targets: ProductEditorTarget[] = [
        { type: "new" },
        workTarget,
        { type: "article-list" },
      ];
      for (const target of targets) {
        let opened: boolean | undefined;
        act(() => {
          opened = observedProductShell!.openEditor(target, opener());
        });
        expect(opened).toBe(false);
      }
      expect(observedProductShell?.activeEditor).toBeNull();
      expectNoHistoryWalk(history);
      expect(replaceState).not.toHaveBeenCalled();
      expect(address()).toBe("/");

      // Profiles are refused, not disabled: a work's Detail still opens.
      act(() => observedProductShell!.openContent(workTarget, opener()));
      await act(async () => vi.runAllTimers());
      expect(observedProductShell?.activeContent).toEqual(workTarget);
      expect(
        container.querySelector(`[aria-label="Detail ${workId}"]`),
      ).not.toBeNull();
      expect(history.pushState).toHaveBeenCalledExactlyOnceWith(
        withHistoryMarkers(detailHistoryState(workTarget, "home", 0)),
        "",
        `/?workId=${workId}#detail`,
      );
    });

    it("keeps the dock, every destination and every overlay at 390px", async () => {
      window.history.replaceState(null, "", "/");
      const { container, opener } = mountShell({ initialPlatform: "phone" });
      await act(async () => vi.runAllTimers());
      expectBrowseOnly(container, false);

      for (const destination of ["discussion", "user", "home"] as const) {
        act(() => observedProductShell!.navigatePrimary(destination));
        expect(observedProductShell?.activeDestination).toBe(destination);
      }
      let opened: boolean | undefined;
      act(() => {
        opened = observedProductShell!.openEditor({ type: "new" }, opener());
      });
      expect(opened).toBe(true);
      expect(observedProductShell?.activeEditor).toEqual({ type: "new" });
      traverse(sameDocument(primaryHistoryState("home")));
      await act(async () => vi.runAllTimers());
      expect(observedProductShell?.activeEditor).toBeNull();

      act(() => observedProductShell!.openProfile(authorId, opener()));
      expect(observedProductShell?.activeProfile?.authorId).toBe(authorId);
      expect(address()).toBe(`/?authorId=${authorId}#profile`);
    });

    it.each([
      { url: "/#profile", expected: "/" },
      { url: `/?authorId=${authorId}`, expected: "/" },
      {
        url: `/?feed=nearby&authorId=${authorId}#profile`,
        expected: "/?feed=nearby",
      },
      { url: "/#editor", expected: "/" },
      { url: "/#article-editor", expected: "/" },
      { url: "/?topic=topic-one", expected: "/" },
      { url: "/?feed=nearby&notifications=1", expected: "/?feed=nearby" },
    ])(
      "ignores $url on load and settles on $expected",
      async ({ url, expected }) => {
        setWidth(1280);
        window.history.replaceState(null, "", url);
        const history = watchHistory();
        const { container } = mountShell();
        await act(async () => vi.runAllTimers());

        expectBrowseOnly(container, true);
        expectHomeOnly(container);
        expect(address()).toBe(expected);
        expectNoHistoryWalk(history);
      },
    );

    it("opens a work's Detail, not its editor, from a work editor link on load", async () => {
      setWidth(1280);
      window.history.replaceState(null, "", `/?workId=${workId}#editor`);
      mountShell();
      await act(async () => vi.runAllTimers());

      expect(observedProductShell?.activeEditor).toBeNull();
      expect(observedProductShell?.activeContent).toEqual(workTarget);
      expect(parseProductHistoryState(window.history.state)).toEqual(
        detailHistoryState(workTarget, "home", 0),
      );
      expect(address()).toBe(`/?workId=${workId}#detail`);
    });

    it.each([
      {
        entry: "discussion",
        state: primaryHistoryState("discussion", 120, "topic-one"),
        url: "/?topic=topic-one",
      },
      { entry: "user", state: primaryHistoryState("user", 120), url: "/" },
      {
        entry: "profile",
        state: profileHistoryState(
          authorId,
          "profile-entry",
          "works",
          80,
          "user",
          120,
        ),
        url: `/?authorId=${authorId}#profile`,
      },
      {
        entry: "topic",
        state: topicHistoryState("topic-one", 120),
        url: "/#topic-topic-one",
      },
      {
        entry: "editor",
        state: editorHistoryState({ type: "new" }, "user", 120),
        url: "/#editor",
      },
    ])("restores Home for a reloaded $entry entry", async ({ state, url }) => {
      setWidth(1280);
      window.history.replaceState(
        {
          ...state,
          __artvennDocument: "old-document",
          phase4Dialog: "old-dialog",
          phase4DialogDepth: 0,
        },
        "",
        url,
      );
      const history = watchHistory();
      const { container } = mountShell();
      await act(async () => vi.runAllTimers());

      expectBrowseOnly(container, true);
      expectHomeOnly(container);
      expect(address()).toBe("/");
      expectNoHistoryWalk(history);
    });

    it.each([
      {
        entry: "profile",
        state: profileHistoryState(
          authorId,
          "profile-entry",
          "works",
          0,
          "home",
          0,
        ),
        url: `/?feed=nearby&authorId=${authorId}#profile`,
      },
      {
        entry: "native profile link",
        state: null,
        url: `/?feed=nearby&authorId=${authorId}#profile`,
      },
      {
        entry: "topic",
        state: topicHistoryState("topic-one", 40),
        url: "/?feed=nearby#topic-topic-one",
      },
      {
        entry: "discussion",
        state: primaryHistoryState("discussion", 40),
        url: "/?feed=nearby&topic=topic-one",
      },
      {
        entry: "editor",
        state: editorHistoryState({ type: "new" }, "home", 0),
        url: "/?feed=nearby#editor",
      },
    ])(
      "rewrites a $entry entry reached by Back or Forward to Home",
      async ({ state, url }) => {
        setWidth(1280);
        window.history.replaceState(null, "", "/?feed=nearby");
        const { container } = mountShell();
        await act(async () => vi.runAllTimers());
        const history = watchHistory();

        traverseTo(state === null ? null : sameDocument(state), url);
        await act(async () => vi.runAllTimers());

        expectBrowseOnly(container, true);
        expectHomeOnly(container);
        expect(address()).toBe("/?feed=nearby");
        expectNoHistoryWalk(history);
      },
    );

    it.each(["profile", "topic", "editor"] as const)(
      "closes an open %s and returns to Home when the window widens",
      async (overlay) => {
        window.history.replaceState(null, "", "/?feed=nearby");
        const { container, opener } = mountShell({ initialPlatform: "phone" });
        await act(async () => vi.runAllTimers());
        act(() =>
          observedProductShell!.navigatePrimary(
            overlay === "topic" ? "discussion" : "user",
          ),
        );
        act(() => {
          if (overlay === "profile")
            observedProductShell!.openProfile(authorId, opener());
          else if (overlay === "topic")
            observedProductShell!.openTopic("topic-one", opener(), 0);
          else observedProductShell!.openEditor({ type: "new" }, opener());
        });
        await act(async () => vi.runAllTimers());
        expect(container.querySelector('[role="dialog"]')).not.toBeNull();
        expect(address()).not.toBe("/?feed=nearby");
        const history = watchHistory();

        resizeTo(1280);
        await act(async () => vi.runAllTimers());

        expectBrowseOnly(container, true);
        expectHomeOnly(container);
        expect(address()).toBe("/?feed=nearby");
        expectNoHistoryWalk(history);
      },
    );

    it("keeps a Detail opened from 讨论 when the window widens, and Back lands on Home", async () => {
      window.history.replaceState(null, "", "/");
      const { container, opener } = mountShell({ initialPlatform: "phone" });
      await act(async () => vi.runAllTimers());
      act(() => observedProductShell!.navigatePrimary("discussion"));
      const discussionEntry = window.history.state;
      act(() =>
        observedProductShell!.openContent(
          { type: "catalog", id: "catalog-one" },
          opener(),
        ),
      );
      await act(async () => vi.runAllTimers());
      const history = watchHistory();

      resizeTo(1280);
      await act(async () => vi.runAllTimers());

      expect(observedProductShell?.browseOnly).toBe(true);
      expect(observedProductShell?.activeContent).toEqual({
        type: "catalog",
        id: "catalog-one",
      });
      expect(
        container.querySelector('[aria-label="Detail catalog-one"]'),
      ).not.toBeNull();
      expect(observedProductShell?.activeDestination).toBe("home");
      expect(parseProductHistoryState(window.history.state)).toEqual(
        detailHistoryState("catalog-one", "home", 0),
      );
      expect(address()).toBe("/?catalogId=catalog-one#detail");
      expectNoHistoryWalk(history);

      click(buttonByLabel(container, "返回资料"));
      expect(history.back).toHaveBeenCalledOnce();
      // The browser then lands on the 讨论 entry beneath the Detail.
      traverseTo(discussionEntry, "/");
      await act(async () => vi.runAllTimers());

      expectBrowseOnly(container, true);
      expectHomeOnly(container);
      expect(address()).toBe("/");
    });

    it("keeps Settings opened from 用户 when the window widens, above Home", async () => {
      window.history.replaceState(null, "", "/");
      const { container, opener } = mountShell({ initialPlatform: "phone" });
      await act(async () => vi.runAllTimers());
      act(() => observedProductShell!.navigatePrimary("user"));
      act(() => observedProductShell!.requestSettings(opener()));
      await act(async () => vi.runAllTimers());
      const history = watchHistory();

      resizeTo(1280);
      await act(async () => vi.runAllTimers());

      expect(observedProductShell?.browseOnly).toBe(true);
      expect(observedProductShell?.settingsOpen).toBe(true);
      expect(dialog(container)).not.toBeNull();
      expect(observedProductShell?.activeDestination).toBe("home");
      expect(parseProductHistoryState(window.history.state)).toEqual(
        settingsHistoryState("home"),
      );
      expect(address()).toBe("/#settings");
      expectNoHistoryWalk(history);
    });

    it("enters browse-only when a wide session signs out", async () => {
      setWidth(1280);
      window.history.replaceState(null, "", "/");
      const { container, opener, render } = mountShell({
        policy: { session: true },
      });
      await act(async () => vi.runAllTimers());
      act(() => observedProductShell!.navigatePrimary("user"));
      act(() => observedProductShell!.openProfile(null, opener()));
      expect(observedProductShell?.activeProfile).not.toBeNull();
      const history = watchHistory();

      render(anonymous);
      await act(async () => vi.runAllTimers());

      expectBrowseOnly(container, true);
      expectHomeOnly(container);
      expect(address()).toBe("/");
      expectNoHistoryWalk(history);
    });

    it("drops Thread and dialog markers from the entry it rewrites without walking history", async () => {
      window.history.replaceState(null, "", "/");
      const { container, opener } = mountShell({
        initialPlatform: "phone",
        topicContent: <ThreadPostPreview />,
      });
      await act(async () => vi.runAllTimers());
      act(() => observedProductShell!.navigatePrimary("discussion"));
      act(() => observedProductShell!.openTopic("topic-one", opener(), 0));
      await act(async () => vi.runAllTimers());
      // The opened post pushed its own entry above the topic's.
      expect(window.history.state.yoyiPreviewNavigation).toEqual({
        id: expect.any(String),
        depth: 1,
      });
      window.history.replaceState(
        {
          ...window.history.state,
          phase4Dialog: "dialog-one",
          phase4DialogDepth: 0,
        },
        "",
      );
      const history = watchHistory();

      resizeTo(1280);
      await act(async () => vi.runAllTimers());

      expectHomeOnly(container);
      expect(address()).toBe("/");
      expectNoHistoryWalk(history);
    });

    it.each([
      { device: "A desktop", agent: null, seed: "pc", width: 895 },
      { device: "A desktop", agent: null, seed: "pc", width: 896 },
      { device: "An iPad", agent: iPadAgent, seed: "tablet", width: 834 },
      { device: "An iPad", agent: iPadAgent, seed: "tablet", width: 1024 },
      { device: "An iPad", agent: iPadAgent, seed: "tablet", width: 1194 },
      { device: "iPadOS", agent: iPadOsAgent, seed: "pc", width: 820 },
      { device: "iPadOS", agent: iPadOsAgent, seed: "pc", width: 1024 },
    ] as const)(
      "$device at $width px follows the wide layout",
      async ({ agent, seed, width }) => {
        if (agent !== null) emulateDevice(agent, 5);
        setWidth(width);
        window.history.replaceState(null, "", "/");
        const { container } = mountShell({ initialPlatform: seed });
        await act(async () => vi.runAllTimers());

        const wide = width >= 896;
        // A tablet crossing the wide width keeps its platform.
        expect(observedProductShell?.platform).toBe(
          agent === null && wide ? "pc" : "tablet",
        );
        expectBrowseOnly(container, wide);
        act(() => observedProductShell!.navigatePrimary("discussion"));
        expect(observedProductShell?.activeDestination).toBe(
          wide ? "home" : "discussion",
        );
      },
    );

    it("returns the dock and every destination when the window narrows again", async () => {
      setWidth(1280);
      window.history.replaceState(null, "", "/");
      const { container } = mountShell();
      await act(async () => vi.runAllTimers());
      expectBrowseOnly(container, true);

      resizeTo(800);
      await act(async () => vi.runAllTimers());
      expectBrowseOnly(container, false);
      act(() => observedProductShell!.navigatePrimary("discussion"));
      expect(observedProductShell?.activeDestination).toBe("discussion");

      resizeTo(1280);
      await act(async () => vi.runAllTimers());
      expectBrowseOnly(container, true);
      expectHomeOnly(container);
    });

    it.each([
      { width: 800, destination: "discussion" },
      { width: 1280, destination: "home" },
    ] as const)(
      "judges a child's mount-time request at $width px by the live width",
      async ({ width, destination }) => {
        setWidth(width);
        window.history.replaceState(null, "", "/");
        // The server guessed a wide screen; the shell has not synced yet.
        mountShell({ initialPlatform: "pc", home: <DiscussionRequest /> });
        await act(async () => vi.runAllTimers());

        expect(observedProductShell?.browseOnly).toBe(width >= 896);
        expect(observedProductShell?.activeDestination).toBe(destination);
      },
    );

    it("hides the dock while a session is pending but closes nothing until it proves anonymous", async () => {
      setWidth(1280);
      window.history.replaceState(null, "", "/#profile");
      const { container, render } = mountShell({ policy: { session: null } });
      await act(async () => vi.runAllTimers());

      expect(observedProductShell?.browseOnly).toBe(true);
      expect(
        container.querySelector<HTMLElement>("[data-product-shell]")?.dataset
          .browseOnly,
      ).toBe("true");
      expect(container.querySelector('[aria-label="停靠操作"]')).toBeNull();
      expect(observedProductShell?.activeProfile?.authorId).toBeNull();
      expect(container.querySelector('[aria-label="Profile"]')).not.toBeNull();
      expect(address()).toBe("/#profile");
      const history = watchHistory();

      render(anonymous);
      await act(async () => vi.runAllTimers());

      expectBrowseOnly(container, true);
      expectHomeOnly(container);
      expect(address()).toBe("/");
      expectNoHistoryWalk(history);
    });

    it.each([
      { name: "a signed-in session", policy: { session: true } },
      { name: "no policy", policy: null },
    ] as const)("changes nothing at 1280px for $name", async ({ policy }) => {
      setWidth(1280);
      window.history.replaceState(null, "", `/?authorId=${authorId}`);
      const { container, opener } = mountShell({ policy });
      await act(async () => vi.runAllTimers());
      expect(observedProductShell?.activeProfile?.authorId).toBe(authorId);
      traverse(sameDocument(primaryHistoryState("home")));
      await act(async () => vi.runAllTimers());

      expectBrowseOnly(container, false);
      act(() => observedProductShell!.navigatePrimary("user"));
      expect(observedProductShell?.activeDestination).toBe("user");
      let opened: boolean | undefined;
      act(() => {
        opened = observedProductShell!.openEditor({ type: "new" }, opener());
      });
      expect(opened).toBe(true);
    });

    it.each([
      { seed: "pc", policy: anonymous, hidden: true },
      { seed: "tablet", policy: anonymous, hidden: true },
      { seed: "phone", policy: anonymous, hidden: false },
      { seed: "pc", policy: { session: null }, hidden: true },
      { seed: "pc", policy: { session: true }, hidden: false },
      { seed: "pc", policy: null, hidden: false },
    ] as const)(
      "server-renders a $seed seed with policy $policy and the dock hidden: $hidden",
      ({ seed, policy, hidden }) => {
        const host = document.createElement("div");
        host.innerHTML = renderToStaticMarkup(
          browseOnlyShell({ initialPlatform: seed, policy }),
        );
        expect(
          host.querySelector<HTMLElement>("[data-product-shell]")?.dataset
            .browseOnly,
        ).toBe(String(hidden));
        expect(
          host
            .querySelector("[data-primary-navigation-layer]")
            ?.hasAttribute("hidden"),
        ).toBe(hidden);
        expect(host.querySelector('[aria-label="停靠操作"]') === null).toBe(
          hidden,
        );
      },
    );

    it("unmounts 用户 and the dialog it owns when the window widens, and mounts it again when it narrows", async () => {
      window.history.replaceState(null, "", "/");
      const { container } = mountShell({
        initialPlatform: "phone",
        user: <UserPageWithDialog />,
      });
      await act(async () => vi.runAllTimers());
      act(() => observedProductShell!.navigatePrimary("user"));
      await act(async () => vi.runAllTimers());
      expect(observedProductShell?.activeDestination).toBe("user");
      expect(container.querySelector("[data-user-probe]")).not.toBeNull();
      expect(
        container.querySelector("dialog[data-user-dialog][open]"),
      ).not.toBeNull();
      const history = watchHistory();

      resizeTo(1280);
      await act(async () => vi.runAllTimers());

      expect(observedProductShell?.activeDestination).toBe("home");
      expect(container.querySelector("[data-user-probe]")).toBeNull();
      // Nothing it owned stays modal over Home.
      expect(document.querySelector("dialog[open]")).toBeNull();
      expect(history.back).not.toHaveBeenCalled();
      expect(history.go).not.toHaveBeenCalled();

      resizeTo(390);
      await act(async () => vi.runAllTimers());
      expectBrowseOnly(container, false);
      act(() => observedProductShell!.navigatePrimary("user"));
      await act(async () => vi.runAllTimers());

      expect(observedProductShell?.activeDestination).toBe("user");
      expect(container.querySelector("[data-user-probe]")).not.toBeNull();
      expect(
        container.querySelector("dialog[data-user-dialog][open]"),
      ).not.toBeNull();
    });

    it("unmounts a real AuthorDialog with 用户 on widening without walking history or leaving a modal", async () => {
      // jsdom has no modal dialogs; stub them as the authors tests do.
      const showModal = vi.fn(function (this: HTMLDialogElement) {
        this.open = true;
      });
      const close = vi.fn(function (this: HTMLDialogElement) {
        this.open = false;
      });
      for (const [name, value] of [
        ["showModal", showModal],
        ["close", close],
      ] as const) {
        const original = Object.getOwnPropertyDescriptor(
          HTMLDialogElement.prototype,
          name,
        );
        Object.defineProperty(HTMLDialogElement.prototype, name, {
          configurable: true,
          value,
        });
        restores.push(() => {
          if (original !== undefined)
            Object.defineProperty(HTMLDialogElement.prototype, name, original);
          else
            delete (HTMLDialogElement.prototype as Partial<HTMLDialogElement>)[
              name
            ];
        });
      }
      const onClose = vi.fn();
      // A 用户 page whose 设置 opens the real modal, as its settings do.
      const UserPageWithAuthorDialog = () => {
        const [open, setOpen] = useState(false);
        return (
          <div data-user-probe="">
            <button
              aria-label="打开设置"
              onClick={() => setOpen(true)}
              type="button"
            >
              设置
            </button>
            {open ? (
              <AuthorDialog
                title="设置"
                onClose={() => {
                  onClose();
                  setOpen(false);
                }}
              >
                <p data-author-dialog-content="">设置内容</p>
              </AuthorDialog>
            ) : null}
          </div>
        );
      };
      window.history.replaceState(null, "", "/");
      const { container } = mountShell({
        initialPlatform: "phone",
        user: <UserPageWithAuthorDialog />,
      });
      await act(async () => vi.runAllTimers());
      act(() => observedProductShell!.navigatePrimary("user"));
      await act(async () => vi.runAllTimers());
      expect(observedProductShell?.activeDestination).toBe("user");
      act(() => buttonByLabel(container, "打开设置").click());
      await act(async () => vi.runAllTimers());

      expect(showModal).toHaveBeenCalledTimes(1);
      expect(
        container.querySelector('dialog[aria-label="设置"][open]'),
      ).not.toBeNull();
      expect(window.history.state).toMatchObject({
        phase4Dialog: expect.any(String),
        phase4DialogDepth: 0,
      });
      const history = watchHistory();

      resizeTo(1280);
      await act(async () => vi.runAllTimers());
      // The unmount queued a microtask that walks Back if its marker remains.
      await act(async () => {
        await Promise.resolve();
      });
      await act(async () => vi.runAllTimers());

      expect(observedProductShell?.activeDestination).toBe("home");
      expect(container.querySelector("[data-user-probe]")).toBeNull();
      expect(document.querySelector("[data-author-dialog-content]")).toBeNull();
      expect(document.querySelector('dialog[aria-label="设置"]')).toBeNull();
      expect(document.querySelector("dialog[open]")).toBeNull();
      expect(close).toHaveBeenCalledTimes(1);
      expect(onClose).not.toHaveBeenCalled();
      expectNoHistoryWalk(history);
      expect(window.history.state).not.toHaveProperty("phase4Dialog");
      expectBrowseOnly(container, true);
      expectHomeOnly(container);
    });

    it("drops a 消息 link kept while the session was pending once it proves anonymous", async () => {
      setWidth(1280);
      window.history.replaceState(null, "", "/?notifications=comments");
      const { container, render } = mountShell({ policy: { session: null } });
      await act(async () => vi.runAllTimers());
      // Pending is not enforced: the link waits for the session.
      expect(address()).toBe("/?notifications=comments");
      const history = watchHistory();

      render(anonymous);
      await act(async () => vi.runAllTimers());

      expect(window.location.search).not.toContain("notifications");
      expect(address()).toBe("/");
      expectBrowseOnly(container, true);
      expectHomeOnly(container);
      expectNoHistoryWalk(history);
    });

    it("drops a 消息 link from a Home entry that Back returns to once browse-only applies", async () => {
      setWidth(1280);
      window.history.replaceState(
        null,
        "",
        "/?notifications=comments&catalogId=catalog-one",
      );
      const { render } = mountShell({ policy: { session: null } });
      await act(async () => vi.runAllTimers());
      // Pending keeps the link on both the Home entry and the Detail above it.
      expect(address()).toContain("notifications=comments");

      render(anonymous);
      await act(async () => vi.runAllTimers());
      expect(window.location.search).not.toContain("notifications");

      // Back to the Home entry beneath the Detail, which still has the link.
      const home = sameDocument(primaryHistoryState("home"));
      act(() => {
        window.history.replaceState(home, "", "/?notifications=comments");
        window.dispatchEvent(new PopStateEvent("popstate", { state: home }));
      });
      await act(async () => vi.runAllTimers());

      expect(address()).toBe("/");
      expect(window.history.state).toMatchObject({
        kind: "primary",
        destination: "home",
      });
    });

    it("opens a catalog's Detail from a link that also names a 讨论 topic, with topic= in neither entry", async () => {
      setWidth(1280);
      const topicId = `thread-${"d".repeat(32)}`;
      window.history.replaceState(
        null,
        "",
        `/?topic=${topicId}&catalogId=catalog-one`,
      );
      // The entries this document writes, bottom to top, as the browser keeps them.
      const nativePush = History.prototype.pushState.bind(window.history);
      const nativeReplace = History.prototype.replaceState.bind(window.history);
      const entries = [{ state: window.history.state, url: address() }];
      const history = watchHistory();
      history.pushState.mockImplementation((state, unused, url) => {
        nativePush(state, unused, url);
        entries.push({ state: window.history.state, url: address() });
      });
      const replaceState = vi
        .spyOn(window.history, "replaceState")
        .mockImplementation((state, unused, url) => {
          nativeReplace(state, unused, url);
          entries[entries.length - 1] = {
            state: window.history.state,
            url: address(),
          };
        });
      replaceState.mockClear();
      restores.push(() => replaceState.mockRestore());

      const { container } = mountShell();
      await act(async () => vi.runAllTimers());

      expect(
        container.querySelector<HTMLElement>("[data-product-shell]")?.dataset
          .detailOpen,
      ).toBe("true");
      expect(observedProductShell?.activeContent).toEqual({
        type: "catalog",
        id: "catalog-one",
      });
      expect(observedProductShell?.activeTopicId).toBeNull();
      expect(observedProductShell?.activeDestination).toBe("home");
      expect(entries.map(({ url }) => url)).toEqual([
        "/",
        "/?catalogId=catalog-one#detail",
      ]);
      expect(parseProductHistoryState(entries[0]!.state)).toEqual(
        primaryHistoryState("home", 0, undefined, "catalog-one"),
      );
      expect(parseProductHistoryState(entries[1]!.state)).toEqual(
        detailHistoryState({ type: "catalog", id: "catalog-one" }, "home", 0),
      );
      for (const [, , url] of [
        ...replaceState.mock.calls,
        ...history.pushState.mock.calls,
      ])
        expect(String(url ?? "")).not.toContain("topic=");
      expect(address()).toBe("/?catalogId=catalog-one#detail");
      expect(history.back).not.toHaveBeenCalled();
      expect(history.go).not.toHaveBeenCalled();
    });

    it.each([
      {
        name: "1280px without an account",
        width: 1280,
        seed: "pc",
        policy: anonymous,
        expected: true,
      },
      {
        name: "390px without an account",
        width: 390,
        seed: "phone",
        policy: anonymous,
        expected: false,
      },
      {
        name: "1280px with a pending session",
        width: 1280,
        seed: "pc",
        policy: { session: null },
        expected: false,
      },
      {
        name: "1280px with a signed-in session",
        width: 1280,
        seed: "pc",
        policy: { session: true },
        expected: false,
      },
      {
        name: "1280px without a policy",
        width: 1280,
        seed: "pc",
        policy: null,
        expected: false,
      },
    ] as const)(
      "isBrowseOnlyEnforced() is $expected at $name",
      async ({ width, seed, policy, expected }) => {
        setWidth(width);
        window.history.replaceState(null, "", "/");
        mountShell({ initialPlatform: seed, policy });
        await act(async () => vi.runAllTimers());

        expect(observedProductShell?.isBrowseOnlyEnforced()).toBe(expected);
      },
    );

    it("reads isBrowseOnlyEnforced() live, before the shell has seen a resize", async () => {
      setWidth(1280);
      window.history.replaceState(null, "", "/");
      mountShell();
      await act(async () => vi.runAllTimers());
      const enforced = observedProductShell!.isBrowseOnlyEnforced;
      expect(enforced()).toBe(true);

      setWidth(390);
      expect(enforced()).toBe(false);
      setWidth(1280);
      expect(enforced()).toBe(true);
    });
  });
});

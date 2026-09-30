// @vitest-environment jsdom

import { act, useEffect, useLayoutEffect, useRef } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  usePathname: () => window.location.pathname,
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn() }),
}));

import { ProductShell, useProductShell } from "./product-shell";
import { AuthReturnProvider, useAuthReturn } from "../auth/auth-return";
import {
  editorHistoryState,
  profileHistoryState,
  detailHistoryState,
  parseProductHistoryState,
  primaryHistoryState,
  settingsHistoryState,
  topicHistoryState,
  viewerHistoryState,
} from "./product-history";

import type { ReactNode } from "react";
import type { EditorTarget } from "./product-history";
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
const renderEditorShell = (enabled = true, withOverlays = false) => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  mountedRoots.push(root);
  let editor:
    | {
        readonly target: EditorTarget;
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
                target: EditorTarget,
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

  it("updates the effective theme when the system preference changes", async () => {
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
    window.localStorage.setItem("yoyi.theme-preference", "dark");
    window.localStorage.setItem("yoyi.home-feed-layout", "single");
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

    expect(window.localStorage.getItem("yoyi.theme-preference")).toBe("system");
    expect(window.localStorage.getItem("yoyi.home-feed-layout")).toBe("double");
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
    renderProductShell(<ProductShellObserver />);
    await act(async () => {
      observedProductShell!.setThemePreference("dark");
      observedProductShell!.setFeedLayoutPreference("single");
    });
    expect(window.localStorage.getItem("yoyi.theme-preference")).toBe("dark");
    expect(window.localStorage.getItem("yoyi.home-feed-layout")).toBe("single");
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(document.documentElement.dataset.homeLayout).toBe("single");
    await act(async () => {
      observedProductShell!.cycleTheme();
      observedProductShell!.cycleFeedLayout();
    });
    expect(window.localStorage.getItem("yoyi.theme-preference")).toBe("system");
    expect(window.localStorage.getItem("yoyi.home-feed-layout")).toBe("double");
  });
});

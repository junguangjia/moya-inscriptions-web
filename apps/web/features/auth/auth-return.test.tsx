// @vitest-environment jsdom
import { act, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { router } = vi.hoisted(() => ({
  router: { push: vi.fn(), replace: vi.fn(), back: vi.fn() },
}));
vi.mock("next/navigation", () => ({
  useRouter: () => router,
  usePathname: () => window.location.pathname,
}));

import {
  AuthReturnProvider,
  createAuthReturnState,
  useAuthEntry,
  useAuthReturn,
  useAuthReturnView,
  useBeforeAuth,
} from "./auth-return";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const sourcePath = "/source?feed=favorites#detail";
const authPath = `/login?return=${encodeURIComponent(sourcePath)}`;
const registerPath = `/register?return=${encodeURIComponent(sourcePath)}`;
const historyKey = "__artvennAuthReturn";
type State = ReturnType<typeof createAuthReturnState>;
const baseHistory = () => ({
  __NA: true,
  __PRIVATE_NEXTJS_INTERNALS_TREE: { synthetic: "next-tree" },
  __artvennEntry: "synthetic-source-entry",
  product: { synthetic: "existing-product-state" },
});
const deferredGuard = () => {
  let resolve!: (value: boolean) => void;
  const promise = new Promise<boolean>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

describe("single-journey authentication return state", () => {
  beforeEach(() => window.history.replaceState(baseHistory(), "", sourcePath));

  const mutate = (
    state: State,
    kind: "push" | "replace",
    path: string,
    data: unknown = { __NA: true },
  ) => {
    const next = state.historyMutation(kind, path, data);
    window.history[kind === "push" ? "pushState" : "replaceState"](
      next,
      "",
      path,
    );
    state.observe();
  };
  const capture = () => {
    const state = createAuthReturnState();
    state.register("shell", () => ({ feed: "favorites", top: 240 }));
    state.register("late-reader", () => ({ page: "comments", top: 420 }));
    state.remember("synthetic-owner-a", "synthetic-content", {
      draft: "unsent text",
    });
    state.capture(sourcePath, "#synthetic-opener");
    return { state, entry: window.history.state };
  };
  const nativeReturn = (state: State, entry: unknown) => {
    window.history.replaceState(entry, "", sourcePath);
    state.observe();
  };

  it("does not restore during capture or authentication, and permits only the source ticket on native Back", () => {
    const { state, entry } = capture();
    expect(state.hasSource()).toBe(false);
    expect(state.read("shell")).toBeUndefined();
    expect(
      state.take("synthetic-owner-a", "synthetic-content"),
    ).toBeUndefined();
    mutate(state, "push", authPath);
    expect(state.hasSource()).toBe(true);
    expect(state.returnPath("/fallback")).toBe(sourcePath);
    expect(state.read("shell")).toBeUndefined();
    nativeReturn(state, entry);
    expect(state.hasSource()).toBe(false);
    expect(state.isRestoring()).toBe(true);
    expect(state.read("shell")).toEqual({ feed: "favorites", top: 240 });
    expect(state.focus()).toBe("#synthetic-opener");
    expect(state.take("synthetic-owner-a", "synthetic-content")).toEqual({
      draft: "unsent text",
    });
    expect(
      state.take("synthetic-owner-a", "synthetic-content"),
    ).toBeUndefined();
  });

  it("keeps the same journey through mode replacement and preserves Next/ProductShell data", () => {
    const { state, entry } = capture();
    const sourceTicket = entry[historyKey];
    mutate(state, "push", authPath, baseHistory());
    expect(window.history.state.__PRIVATE_NEXTJS_INTERNALS_TREE).toEqual(
      baseHistory().__PRIVATE_NEXTJS_INTERNALS_TREE,
    );
    expect(window.history.state.product).toEqual(baseHistory().product);
    expect(window.history.state[historyKey]).toEqual({
      id: sourceTicket.id,
      role: "auth",
    });
    mutate(state, "replace", registerPath, { __NA: true });
    expect(state.hasSource()).toBe(true);
    expect(window.history.state[historyKey]).toEqual({
      id: sourceTicket.id,
      role: "auth",
    });
    nativeReturn(state, entry);
    expect(state.read("late-reader")).toEqual({ page: "comments", top: 420 });
  });

  it("allows late source adapters while committed slots are consumed once", () => {
    const { state, entry } = capture();
    mutate(state, "push", authPath);
    nativeReturn(state, entry);
    const shell = state.read("shell");
    state.consumeView("shell", shell);
    expect(state.read("shell")).toBeUndefined();
    expect(state.read("late-reader")).toEqual({ page: "comments", top: 420 });
    expect(state.focus()).toBe("#synthetic-opener");
    const reader = state.read("late-reader");
    state.consumeView("late-reader", {});
    expect(state.read("late-reader")).toBe(reader);
    state.consumeView("late-reader", reader);
    expect(state.read("late-reader")).toBeUndefined();
  });

  it.each([
    "/other",
    "/source?feed=recent#detail",
    "/source?feed=favorites#another-detail",
  ])(
    "retires views and drafts on a route change to %s, including the same pathname",
    (path) => {
      const { state, entry } = capture();
      mutate(state, "push", authPath);
      nativeReturn(state, entry);
      mutate(state, "replace", path, { ...entry });
      expect(state.isRestoring()).toBe(false);
      expect(state.focus()).toBeNull();
      // A later ordinary browser visit cannot revive an old history ticket.
      window.history.replaceState(entry, "", sourcePath);
      state.observe();
      expect(state.read("late-reader")).toBeUndefined();
      expect(
        state.take("synthetic-owner-a", "synthetic-content"),
      ).toBeUndefined();
    },
  );

  it("treats a fresh entry at the same URL as an ordinary visit", () => {
    const { state, entry } = capture();
    mutate(state, "push", authPath);
    nativeReturn(state, entry);
    mutate(state, "push", sourcePath, baseHistory());
    expect(state.read("shell")).toBeUndefined();
    expect(window.history.state[historyKey]).toBeUndefined();
    mutate(state, "push", authPath);
    expect(state.hasSource()).toBe(false);
    expect(state.returnPath("/fallback")).toBe("/fallback");
  });

  it("retains source-local modal history and retires a different ProductShell entry at the same URL", () => {
    const { state, entry } = capture();
    mutate(state, "push", authPath);
    nativeReturn(state, entry);
    mutate(state, "push", sourcePath, {
      ...entry,
      yoyiPreviewNavigation: { id: "synthetic-local-modal", depth: 1 },
    });
    expect(state.isRestoring()).toBe(true);
    expect(state.read("late-reader")).toEqual({ page: "comments", top: 420 });
    mutate(state, "replace", sourcePath, {
      ...window.history.state,
      __artvennEntry: "synthetic-different-entry",
    });
    expect(state.isRestoring()).toBe(false);
    expect(state.read("late-reader")).toBeUndefined();
  });

  it("does not turn a direct auth visit or an unrelated auth push into a controlled return", () => {
    const empty = createAuthReturnState();
    window.history.replaceState({}, "", authPath);
    expect(empty.hasSource()).toBe(false);
    expect(empty.returnPath("//outside.invalid")).toBe("/");
    window.history.replaceState(baseHistory(), "", sourcePath);
    const { state } = capture();
    mutate(state, "push", authPath);
    mutate(state, "push", registerPath);
    expect(state.hasSource()).toBe(false);
    expect(state.returnPath("/fallback")).toBe("/fallback");
  });

  it("requires the matching source history ticket even if the URL matches", () => {
    const { state, entry } = capture();
    mutate(state, "push", authPath);
    window.history.replaceState(
      {
        ...entry,
        [historyKey]: { id: "synthetic-other-journey", role: "source" },
      },
      "",
      sourcePath,
    );
    state.observe();
    expect(state.read("shell")).toBeUndefined();
    expect(
      state.take("synthetic-owner-a", "synthetic-content"),
    ).toBeUndefined();
  });

  it("keeps captured drafts only for the source route and confirmed owner", () => {
    const state = createAuthReturnState();
    window.history.replaceState({}, "", "/other");
    state.remember("synthetic-owner-a", "other-content", {
      draft: "unrelated",
    });
    window.history.replaceState(baseHistory(), "", sourcePath);
    state.remember("synthetic-owner-a", "source-content", {
      draft: "owned draft",
    });
    state.capture(sourcePath, null);
    const entry = window.history.state;
    mutate(state, "push", authPath);
    nativeReturn(state, entry);
    expect(state.take("synthetic-owner-a", "other-content")).toBeUndefined();
    expect(state.take("synthetic-owner-b", "source-content")).toBeUndefined();
    state.identify("synthetic-owner-b");
    expect(state.take("synthetic-owner-a", "source-content")).toBeUndefined();
  });

  it("does not retain source-owned drafts for the next authentication journey", () => {
    const { state, entry } = capture();
    mutate(state, "push", authPath);
    nativeReturn(state, entry);
    mutate(state, "push", "/other");
    mutate(state, "push", sourcePath);
    state.capture(sourcePath, null);
    const second = window.history.state;
    mutate(state, "push", authPath);
    nativeReturn(state, second);
    expect(
      state.take("synthetic-owner-a", "synthetic-content"),
    ).toBeUndefined();
  });
});

describe("authentication entry and provider integration", () => {
  let container: HTMLDivElement;
  let root: Root;
  let context: State | null = null;
  let checkpoint: () => Promise<boolean>;
  let sourceRendered: unknown;
  let lateRendered: unknown;
  let pushedSource: unknown;
  const nativePush = window.history.pushState;
  const nativeReplace = window.history.replaceState;

  beforeEach(() => {
    router.push.mockReset();
    router.replace.mockReset();
    router.back.mockReset();
    router.push.mockImplementation((href: string) => {
      pushedSource = window.history.state;
      window.history.pushState({ __NA: true }, "", href);
    });
    router.replace.mockImplementation((href: string) =>
      window.history.replaceState({ __NA: true }, "", href),
    );
    window.history.replaceState(baseHistory(), "", sourcePath);
    checkpoint = async () => true;
    sourceRendered = undefined;
    lateRendered = undefined;
    pushedSource = undefined;
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    context = null;
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.restoreAllMocks();
  });

  const Late = () => {
    lateRendered = useAuthReturnView("late", () => ({
      page: "comments",
      top: 333,
    }));
    return <div data-late="" />;
  };
  const Source = ({
    late = true,
    actor = "checking-guest",
  }: {
    readonly late?: boolean;
    readonly actor?: string;
  }) => {
    context = useAuthReturn();
    const enter = useAuthEntry();
    sourceRendered = useAuthReturnView("shell", () => ({
      feed: "favorites",
      top: 123,
    }));
    useBeforeAuth(() => checkpoint());
    return (
      <main>
        <a href="/login">登录入口</a>
        <button onClick={(event) => enter("/login", event.currentTarget)}>
          按钮登录
        </button>
        <a href="/dev/community" onClick={(event) => event.preventDefault()}>
          其他入口
        </a>
        {late && <Late key={actor} />}
      </main>
    );
  };
  const Auth = () => {
    context = useAuthReturn();
    const enter = useAuthEntry();
    return <button onClick={() => enter("/register")}>切换注册</button>;
  };
  const render = async (
    page: "source" | "auth",
    late = true,
    strict = false,
    actor = "checking-guest",
  ) => {
    const content = (
      <AuthReturnProvider>
        {page === "source" ? <Source late={late} actor={actor} /> : <Auth />}
      </AuthReturnProvider>
    );
    await act(async () =>
      root.render(strict ? <StrictMode>{content}</StrictMode> : content),
    );
  };
  const click = async (text: string) => {
    const target = [
      ...container.querySelectorAll<HTMLElement>("a,button"),
    ].find((node) => node.textContent === text);
    expect(target).toBeDefined();
    await act(async () => target?.click());
  };
  const popTo = async (entry: unknown, path = sourcePath) => {
    // Simulate a browser history traversal, which never invokes push/replace.
    nativeReplace.call(window.history, entry, "", path);
    await act(async () =>
      window.dispatchEvent(new PopStateEvent("popstate", { state: entry })),
    );
  };

  it.each(["登录入口", "按钮登录"])(
    "uses the same prepared, captured route entry for %s",
    async (label) => {
      const guard = vi.fn(async () => true);
      checkpoint = guard;
      window.history.replaceState(
        {
          ...baseHistory(),
          phase4Dialog: "synthetic-dialog",
          phase4DialogDepth: 2,
        },
        "",
        sourcePath,
      );
      await render("source");
      await click(label);
      expect(guard).toHaveBeenCalledTimes(1);
      expect(router.push).toHaveBeenCalledWith(authPath, { scroll: true });
      expect(context?.hasSource()).toBe(true);
      expect(window.history.state[historyKey].role).toBe("auth");
      await render("auth");
      // The previous source entry keeps all existing router/shell fields and
      // sheds only the obsolete modal marker before leaving.
      expect(pushedSource).toEqual(
        expect.objectContaining({
          __NA: true,
          __PRIVATE_NEXTJS_INTERNALS_TREE:
            baseHistory().__PRIVATE_NEXTJS_INTERNALS_TREE,
          product: baseHistory().product,
          [historyKey]: expect.objectContaining({ role: "source" }),
        }),
      );
      expect(pushedSource).not.toHaveProperty("phase4Dialog");
      expect(pushedSource).not.toHaveProperty("phase4DialogDepth");
      await popTo(pushedSource);
      await render("source");
      expect(sourceRendered).toEqual({ feed: "favorites", top: 123 });
      expect(lateRendered).toEqual({ page: "comments", top: 333 });
      expect(context?.hasSource()).toBe(false);
    },
  );

  it("leaves checkpoint rejection on the source and suppresses duplicate pending navigation", async () => {
    const pending = deferredGuard();
    const guard = vi.fn(() => pending.promise);
    checkpoint = guard;
    await render("source");
    await click("按钮登录");
    await click("登录入口");
    expect(guard).toHaveBeenCalledTimes(1);
    expect(router.push).not.toHaveBeenCalled();
    await act(async () => pending.resolve(false));
    expect(router.push).not.toHaveBeenCalled();
    expect(window.location.pathname).toBe("/source");
    expect(window.history.state[historyKey]).toBeUndefined();
  });

  it.each(["url", "entry", "opener"])(
    "does not navigate after a guarded checkpoint when the %s changed",
    async (change) => {
      const pending = deferredGuard();
      checkpoint = () => pending.promise;
      await render("source");
      await click("按钮登录");
      if (change === "url")
        window.history.replaceState(baseHistory(), "", "/source?feed=other");
      if (change === "entry")
        window.history.replaceState(
          { ...baseHistory(), __artvennEntry: "synthetic-other-entry" },
          "",
          sourcePath,
        );
      if (change === "opener") container.querySelector("button")?.remove();
      await act(async () => pending.resolve(true));
      expect(router.push).not.toHaveBeenCalled();
    },
  );

  it("keeps public snapshots for late and account-keyed adapters under StrictMode until the returned entry ends", async () => {
    await render("source", true, true);
    await click("按钮登录");
    const id = window.history.state[historyKey].id;
    await render("auth", true, true);
    await click("切换注册");
    expect(router.replace).toHaveBeenCalledWith(registerPath, { scroll: true });
    expect(context?.hasSource()).toBe(true);
    const entry = { ...baseHistory(), [historyKey]: { id, role: "source" } };
    await popTo(entry);
    await render("source", false, true);
    expect(sourceRendered).toEqual({ feed: "favorites", top: 123 });
    expect(context?.read("shell")).toEqual({ feed: "favorites", top: 123 });
    await render("source", true, true);
    expect(lateRendered).toEqual({ page: "comments", top: 333 });
    await render("source", false, true);
    await render("source", true, true);
    expect(lateRendered).toEqual({ page: "comments", top: 333 });
    await render("source", true, true, "synthetic-signed-in-owner");
    expect(lateRendered).toEqual({ page: "comments", top: 333 });
    window.history.pushState({}, "", "/other");
    await popTo(entry);
    await render("auth", true, true);
    await render("source", true, true, "synthetic-signed-in-owner");
    expect(sourceRendered).toBeUndefined();
    expect(lateRendered).toBeUndefined();
  });

  it("restores the confirmed-account rekey after a checking guest committed first, without requiring an AuthorProvider", async () => {
    await render("source");
    await click("按钮登录");
    const entry = pushedSource;
    await render("auth");
    await popTo(entry);
    await render("source", true, false, "checking-guest");
    expect(lateRendered).toEqual({ page: "comments", top: 333 });
    // Mirrors /me confirmation changing the detail/discovery/profile actor key.
    await render("source", true, false, "synthetic-confirmed-account");
    expect(lateRendered).toEqual({ page: "comments", top: 333 });
    expect(context?.read("late")).toEqual({ page: "comments", top: 333 });
    // Ending that route retires the journey; a later normal visit stays clean.
    window.history.replaceState({}, "", "/source?feed=other");
    await popTo(entry);
    await render("auth");
    await render("source", true, false, "synthetic-confirmed-account");
    expect(lateRendered).toBeUndefined();
  });

  it("observes query-only history changes before a later direct auth visit", async () => {
    await render("source");
    await click("按钮登录");
    const id = window.history.state[historyKey].id;
    await render("auth");
    const entry = { ...baseHistory(), [historyKey]: { id, role: "source" } };
    await popTo(entry);
    await render("source", false);
    window.history.pushState({}, "", "/source?feed=other");
    window.history.pushState({}, "", authPath);
    await render("auth");
    expect(context?.hasSource()).toBe(false);
    expect(context?.returnPath("/fallback")).toBe("/fallback");
    expect(context?.read("late")).toBeUndefined();
  });

  it("preserves existing history methods and does not intercept other anchors", async () => {
    const pushSpy = vi
      .spyOn(window.history, "pushState")
      .mockImplementation((data, unused, url) =>
        nativePush.call(window.history, data, unused, url),
      );
    await render("source");
    await click("其他入口");
    expect(router.push).not.toHaveBeenCalled();
    await click("按钮登录");
    expect(pushSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        __NA: true,
        [historyKey]: expect.objectContaining({ role: "auth" }),
      }),
      "",
      authPath,
    );
  });
});

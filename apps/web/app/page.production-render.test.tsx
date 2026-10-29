// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/*
 * The Formal root is rendered for real here: only the Catalog HTTP boundary
 * and request/HTTP boundaries are replaced. Production mounts the existing
 * author, publishing and notification providers, with no QA fixture source.
 */
const {
  loadHomeCatalogStateMock,
  readFormalRequestContextMock,
  readVisitorAccessMock,
} = vi.hoisted(() => ({
  loadHomeCatalogStateMock: vi.fn(),
  readFormalRequestContextMock: vi.fn(),
  readVisitorAccessMock: vi.fn(),
}));

vi.mock("../features/home/load-home-catalog", () => ({
  loadHomeCatalogState: loadHomeCatalogStateMock,
  // The mocked loader ignores the visitor's source.
  visitorCatalogSource: () => async () => {
    throw new Error("Unexpected Catalog source call");
  },
}));
vi.mock("./formal-request-context", () => ({
  readFormalRequestContext: readFormalRequestContextMock,
}));
vi.mock("./product-access", () => ({
  readVisitorAccess: readVisitorAccessMock,
}));

import FormalPage from "./page";

import type { CatalogId, CatalogKind } from "@moya/contracts";

const threadId = `thread-${"a".repeat(32)}`;

const populated = (kind: CatalogKind) => ({
  page: {
    items: [
      {
        aliases: [],
        id: `runtime-${kind}` as CatalogId,
        kind,
        title: `真实${kind === "inscription" ? "刻石" : "书法"}样例`,
      },
    ],
    page: 1,
    pageSize: 24,
    total: 1,
    totalPages: 1,
  },
  state: "populated",
});

const mountedRoots: ReturnType<typeof createRoot>[] = [];

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

beforeEach(() => {
  vi.stubEnv("NODE_ENV", "production");
  vi.stubEnv("MOYA_WIDE_SCREEN_BROWSE_ONLY", undefined);
  readFormalRequestContextMock.mockReset();
  readFormalRequestContextMock.mockResolvedValue({ initialPlatform: "phone" });
  readVisitorAccessMock.mockReset();
  readVisitorAccessMock.mockResolvedValue({
    state: "granted",
    closedBeta: false,
    token: undefined,
  });
  loadHomeCatalogStateMock.mockReset();
  loadHomeCatalogStateMock.mockImplementation(
    async (query?: { readonly kind?: CatalogKind }) =>
      populated(query?.kind ?? "inscription"),
  );
});

afterEach(() => {
  for (const root of mountedRoots.splice(0)) act(() => root.unmount());
  document.body.replaceChildren();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("Formal root in a Production build", () => {
  it("renders the Catalog and live business providers without QA fixtures", async () => {
    const container = document.createElement("div");
    container.innerHTML = renderToStaticMarkup(await FormalPage({}));

    expect(container.textContent).toContain("真实书法样例");
    expect(
      container.querySelector('[data-threads-state="loading"]'),
    ).not.toBeNull();
    expect(container.querySelector("[data-create-work-action]")).not.toBeNull();
    expect(
      container.querySelector("[data-phase4-inscriptions]"),
    ).not.toBeNull();
    expect(container.querySelector("[data-t02p-qa-harness]")).toBeNull();
    expect(
      container.querySelector("[data-development-primary-pager]"),
    ).toBeNull();
  });

  it("opens the real Thread page and reads its existing API in Production", async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      "IntersectionObserver",
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    );
    const thread = {
      id: threadId,
      title: "Runtime thread",
      description: "Published thread from the HTTP boundary",
      tags: [],
      status: "open",
      heat: 0,
      postCount: 0,
      latestActivityAt: null,
      createdAt: "2026-10-02T00:00:00.000Z",
      unread: null,
    };
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const path = String(input).split("?")[0];
      if (path === `/api/community/threads/${threadId}`)
        return Response.json(thread);
      if (path === `/api/community/threads/${threadId}/posts`)
        return Response.json({
          items: [],
          total: 0,
          page: 1,
          pageSize: 20,
          totalPages: 0,
        });
      if (path === "/api/community/threads")
        return Response.json({
          items: [thread],
          total: 1,
          page: 1,
          pageSize: 22,
          totalPages: 1,
          anchor: "2026-10-02T00:00:00.000Z",
        });
      return new Response(null, { status: 401 });
    });
    vi.stubGlobal("fetch", fetchMock);
    window.history.replaceState(null, "", "/");
    for (const [name, value] of Object.entries({
      innerWidth: 390,
      innerHeight: 844,
      visualViewport: null,
      matchMedia: () =>
        ({
          addEventListener: () => undefined,
          matches: false,
          removeEventListener: () => undefined,
        }) as unknown as MediaQueryList,
      scrollTo: () => undefined,
      requestAnimationFrame: (callback: FrameRequestCallback) =>
        window.setTimeout(() => callback(performance.now()), 0),
      cancelAnimationFrame: (id: number) => window.clearTimeout(id),
    }))
      Object.defineProperty(window, name, { configurable: true, value });

    const page = await FormalPage({
      searchParams: Promise.resolve({ topic: threadId }),
    });
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    mountedRoots.push(root);
    act(() => root.render(page));
    // The link switches to Discussion, then opens the topic a frame later.
    for (let frame = 0; frame < 4; frame += 1)
      await act(() => vi.advanceTimersByTimeAsync(20));

    const opened = container.querySelector("[data-thread-detail]");
    expect(opened?.getAttribute("data-thread-detail")).toBe(threadId);
    expect(opened?.textContent).toContain("Runtime thread");
    expect(
      fetchMock.mock.calls.some(
        ([url]) => String(url) === `/api/community/threads/${threadId}`,
      ),
    ).toBe(true);
  });
});

describe("Formal root on a wide screen (pc-browse-only-v1)", () => {
  // A synthetic stand-in with the opaque session shape; not a credential.
  const visitorSession = "s".repeat(43);
  const viewer = {
    id: `user-${"0".repeat(31)}1`,
    handle: "synthetic-browse-only",
    displayName: "甲",
  };

  const renderStatic = async () => {
    const container = document.createElement("div");
    container.innerHTML = renderToStaticMarkup(await FormalPage({}));
    return container;
  };
  const browseOnly = (container: ParentNode) =>
    container
      .querySelector("[data-product-shell]")
      ?.getAttribute("data-browse-only");
  const navigationHidden = (container: ParentNode) => {
    const layer = container.querySelector("[data-primary-navigation-layer]");
    expect(layer).not.toBeNull();
    return layer?.hasAttribute("hidden");
  };
  const shown = (container: ParentNode, selector: string) =>
    [...container.querySelectorAll(selector)].filter(
      (element) => element.closest("[hidden]") === null,
    );

  it("renders the complete pc product for a visitor without an account", async () => {
    readFormalRequestContextMock.mockResolvedValue({ initialPlatform: "pc" });
    const container = await renderStatic();

    expect(browseOnly(container)).toBe("false");
    expect(navigationHidden(container)).toBe(false);
    expect(shown(container, "[data-create-work-action]")).not.toEqual([]);
    expect(shown(container, "[data-search-trigger]")).not.toEqual([]);
    expect(container.textContent).toContain("真实书法样例");
    expect(container.textContent).toContain("豫ICP备");
  });

  it("keeps the phone Formal root unchanged", async () => {
    const container = await renderStatic();

    expect(browseOnly(container)).toBe("false");
    expect(navigationHidden(container)).toBe(false);
    expect(shown(container, "[data-create-work-action]")).not.toEqual([]);
  });

  it("keeps a closed beta's pc Formal root complete", async () => {
    readFormalRequestContextMock.mockResolvedValue({ initialPlatform: "pc" });
    for (const token of [undefined, visitorSession]) {
      readVisitorAccessMock.mockResolvedValue({
        state: "granted",
        closedBeta: true,
        token,
      });
      const container = await renderStatic();

      expect(browseOnly(container)).toBe("false");
      expect(navigationHidden(container)).toBe(false);
      expect(shown(container, "[data-create-work-action]")).not.toEqual([]);
    }
  });

  it.each(["off", "false", "0"])(
    "keeps the pc Formal root complete when switched %s",
    async (value) => {
      vi.stubEnv("MOYA_WIDE_SCREEN_BROWSE_ONLY", value);
      readFormalRequestContextMock.mockResolvedValue({ initialPlatform: "pc" });
      const container = await renderStatic();

      expect(browseOnly(container)).toBe("false");
      expect(navigationHidden(container)).toBe(false);
      expect(shown(container, "[data-create-work-action]")).not.toEqual([]);
    },
  );

  it.each([
    // A signed-in session keeps everything once /me confirms it.
    {
      cookie: "a session",
      token: visitorSession,
      status: 200,
      expected: "false",
    },
    // A session /me could not check is trusted.
    {
      cookie: "a session",
      token: visitorSession,
      status: 503,
      expected: "false",
    },
    // An expired session is no account.
    {
      cookie: "a session",
      token: visitorSession,
      status: 401,
      expected: "false",
    },
    { cookie: "no session", token: undefined, status: 401, expected: "false" },
  ] as const)(
    "settles pc with $cookie on /me $status as browse-only $expected",
    async ({ token, status, expected }) => {
      readFormalRequestContextMock.mockResolvedValue({ initialPlatform: "pc" });
      readVisitorAccessMock.mockResolvedValue({
        state: "granted",
        closedBeta: false,
        token,
      });
      // The server render cannot know the session yet: browse-only first.
      expect(browseOnly(await renderStatic())).toBe("false");

      vi.useFakeTimers();
      vi.stubGlobal(
        "IntersectionObserver",
        class {
          observe() {}
          unobserve() {}
          disconnect() {}
        },
      );
      // A signed-in viewer opens the live notification stream.
      vi.stubGlobal(
        "EventSource",
        class {
          onerror = null;
          addEventListener() {}
          close() {}
        },
      );
      const fetchMock = vi.fn<typeof fetch>(async (input) =>
        String(input).split("?")[0] === "/api/community/me"
          ? status === 200
            ? Response.json(viewer)
            : new Response(null, { status })
          : new Response(null, { status: 401 }),
      );
      vi.stubGlobal("fetch", fetchMock);
      window.history.replaceState(null, "", "/");
      for (const [name, value] of Object.entries({
        innerWidth: 1_280,
        innerHeight: 800,
        visualViewport: null,
        matchMedia: () =>
          ({
            addEventListener: () => undefined,
            matches: false,
            removeEventListener: () => undefined,
          }) as unknown as MediaQueryList,
        scrollTo: () => undefined,
        requestAnimationFrame: (callback: FrameRequestCallback) =>
          window.setTimeout(() => callback(performance.now()), 0),
        cancelAnimationFrame: (id: number) => window.clearTimeout(id),
      }))
        Object.defineProperty(window, name, { configurable: true, value });

      const page = await FormalPage({});
      const container = document.createElement("div");
      document.body.append(container);
      const root = createRoot(container);
      mountedRoots.push(root);
      act(() => root.render(page));
      for (let frame = 0; frame < 4; frame += 1)
        await act(() => vi.advanceTimersByTimeAsync(20));

      expect(
        fetchMock.mock.calls.some(
          ([url]) => String(url) === "/api/community/me",
        ),
      ).toBe(true);
      expect(browseOnly(container)).toBe(expected);
      expect(navigationHidden(container)).toBe(false);
      expect(shown(container, "[data-search-trigger]")).not.toEqual([]);
    },
  );

  it("keeps a real topic link available across desktop and compact reflow", async () => {
    readFormalRequestContextMock.mockResolvedValue({ initialPlatform: "pc" });
    vi.useFakeTimers();
    vi.stubGlobal(
      "IntersectionObserver",
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    );
    const thread = {
      id: threadId,
      title: "Runtime thread",
      description: "Published thread from the HTTP boundary",
      tags: [],
      status: "open",
      heat: 0,
      postCount: 0,
      latestActivityAt: null,
      createdAt: "2026-10-02T00:00:00.000Z",
      unread: null,
    };
    // The Thread is readable, so only the spent link keeps it closed.
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const path = String(input).split("?")[0];
      if (path === `/api/community/threads/${threadId}`)
        return Response.json(thread);
      if (path === `/api/community/threads/${threadId}/posts`)
        return Response.json({
          items: [],
          total: 0,
          page: 1,
          pageSize: 20,
          totalPages: 0,
        });
      if (path === "/api/community/threads")
        return Response.json({
          items: [thread],
          total: 1,
          page: 1,
          pageSize: 22,
          totalPages: 1,
          anchor: "2026-10-02T00:00:00.000Z",
        });
      return new Response(null, { status: 401 });
    });
    vi.stubGlobal("fetch", fetchMock);
    window.history.replaceState(null, "", `/?topic=${threadId}`);
    for (const [name, value] of Object.entries({
      innerWidth: 1_280,
      innerHeight: 800,
      visualViewport: null,
      matchMedia: () =>
        ({
          addEventListener: () => undefined,
          matches: false,
          removeEventListener: () => undefined,
        }) as unknown as MediaQueryList,
      scrollTo: () => undefined,
      requestAnimationFrame: (callback: FrameRequestCallback) =>
        window.setTimeout(() => callback(performance.now()), 0),
      cancelAnimationFrame: (id: number) => window.clearTimeout(id),
    }))
      Object.defineProperty(window, name, { configurable: true, value });
    const frames = async () => {
      for (let frame = 0; frame < 4; frame += 1)
        await act(() => vi.advanceTimersByTimeAsync(20));
    };

    const page = await FormalPage({
      searchParams: Promise.resolve({ topic: threadId }),
    });
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    mountedRoots.push(root);
    act(() => root.render(page));
    await frames();

    const shell = container.querySelector<HTMLElement>("[data-product-shell]");
    expect(browseOnly(container)).toBe("false");
    expect(shell?.dataset.topicOpen).toBe("true");
    expect(container.querySelector("[data-thread-detail]")).not.toBeNull();
    expect(window.location.search).toContain("topic=");
    act(() => {
      Object.defineProperty(window, "innerWidth", {
        configurable: true,
        value: 800,
      });
      window.dispatchEvent(new Event("resize"));
    });
    await frames();
    expect(browseOnly(container)).toBe("false");
    expect(navigationHidden(container)).toBe(true); // The open topic owns the modal navigation layer.
    expect(shell?.dataset.topicOpen).toBe("true");
    expect(window.location.search).toContain("topic=");
  });
});

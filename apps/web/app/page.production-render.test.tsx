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
const { loadHomeCatalogStateMock } = vi.hoisted(() => ({
  loadHomeCatalogStateMock: vi.fn(),
}));

vi.mock("../features/home/load-home-catalog", () => ({
  loadHomeCatalogState: loadHomeCatalogStateMock,
}));
vi.mock("./formal-request-context", () => ({
  readFormalRequestContext: async () => ({ initialPlatform: "phone" }),
}));
vi.mock("./product-access", () => ({
  readVisitorAccess: async () => ({
    state: "granted",
    closedBeta: false,
    token: undefined,
  }),
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

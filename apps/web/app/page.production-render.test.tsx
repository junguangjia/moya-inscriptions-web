// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/*
 * The Formal root is rendered for real here: only the Catalog HTTP boundary
 * and the request headers are replaced. A Production build composes no author
 * community (amendment 2026-09-11, section 7), so every surface of the root
 * must render without the author, publishing and publishing-entry providers.
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
  it("renders the Catalog and an unavailable 话题 without the author community", async () => {
    const container = document.createElement("div");
    container.innerHTML = renderToStaticMarkup(await FormalPage({}));

    expect(
      container.querySelector('[data-product-panel="home"]')?.textContent,
    ).toContain("真实刻石样例");
    const threads = container.querySelector("#discussion-panel-threads");
    expect(
      threads?.querySelector('[data-threads-state="unavailable"]')?.textContent,
    ).toBe("话题暂时不可用");
    expect(threads?.querySelector('[role="status"]')).not.toBeNull();
    expect(threads?.querySelector("button")).toBeNull();
    expect(container.querySelector("[data-threads-feed]")).toBeNull();
  });

  it("opens no Thread page for a Thread link after the root mounts", async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      "IntersectionObserver",
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    );
    const fetchMock = vi.fn<typeof fetch>(
      async () => new Response(null, { status: 404 }),
    );
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

    const opened = container.querySelector("[data-topic-detail]");
    expect(opened?.getAttribute("data-topic-detail-state")).toBe("not-found");
    expect(container.querySelector("[data-thread-detail]")).toBeNull();
    // Nothing reads Threads for the link.
    expect(
      fetchMock.mock.calls.filter(([url]) => String(url).includes("threads")),
    ).toEqual([]);
  });
});

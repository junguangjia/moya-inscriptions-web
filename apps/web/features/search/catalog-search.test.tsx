// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
const { openCatalog, analytics } = vi.hoisted(() => ({
  openCatalog: vi.fn(),
  analytics: vi.fn(),
}));
vi.mock("../analytics/client", () => ({ trackAnalytics: analytics }));
vi.mock("../product-shell/product-shell", () => ({
  useProductShell: () => ({ platform: "phone", openCatalog }),
}));
import {
  CatalogSearch,
  CatalogSearchHeaderAction,
  CatalogSearchNavigationAction,
  CatalogSearchProvider,
} from "./catalog-search";
import type { CatalogSearchLoader } from "./catalog-search";
import type { CatalogSearchTransportResult } from "../../lib/public-api/catalog-search";
import type { CatalogId, CatalogSearchItem } from "@moya/contracts";
import type { Root } from "react-dom/client";
(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
const roots: Root[] = [];
const item = (id: string, title = "合成搜索资料"): CatalogSearchItem => ({
  id: id as CatalogId,
  title,
  aliases: [],
  kind: "inscription",
  matchKind: "body",
});
const success = (
  items = [item("synthetic-search-1")],
  page = 1,
  total = items.length,
): CatalogSearchTransportResult => ({
  state: "success",
  page: {
    items,
    page,
    pageSize: 20,
    total,
    totalPages: Math.ceil(total / 20),
  },
});
const deferred = () => {
  let resolve!: (value: CatalogSearchTransportResult) => void;
  const promise = new Promise<CatalogSearchTransportResult>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
const element = <T extends HTMLElement>(
  container: ParentNode,
  selector: string,
) => {
  const match = container.querySelector<T>(selector);
  if (match === null) throw new Error("Missing synthetic test element");
  return match;
};
const renderSearch = (loadPage: CatalogSearchLoader) => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  act(() =>
    root.render(
      <CatalogSearchProvider>
        <div data-product-shell="" data-detail-open="false">
          <div data-primary-navigation-pager="">
            <button>背景</button>
          </div>
          <nav data-primary-navigation-dock="">
            <CatalogSearchNavigationAction />
          </nav>
          <CatalogSearch loadPage={loadPage} />
        </div>
      </CatalogSearchProvider>,
    ),
  );
  act(() =>
    element<HTMLButtonElement>(container, "[data-search-trigger]").click(),
  );
  return container;
};
const type = (container: ParentNode, text: string) => {
  const input = element<HTMLInputElement>(container, 'input[type="search"]');
  act(() => {
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )?.set?.call(input, text);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
};
const submit = async (container: ParentNode) => {
  await act(async () =>
    element<HTMLFormElement>(container, "form").dispatchEvent(
      new Event("submit", { bubbles: true, cancelable: true }),
    ),
  );
};
afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  document.body.replaceChildren();
  vi.clearAllMocks();
});
describe("real Catalog Search utility", () => {
  it("dismisses keyboard focus on a valid search and keeps only the outer close control", async () => {
    const container = renderSearch(vi.fn().mockResolvedValue(success()));
    const input = element<HTMLInputElement>(container, 'input[type="search"]');
    type(container, "测试");
    input.focus();
    await submit(container);
    expect(analytics).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "search",
        surface: "search",
        searchQuery: "测试",
        requestId: expect.any(String),
      }),
    );
    expect(document.activeElement).not.toBe(input);
    expect(container.querySelector("[data-search-clear]")).toBeNull();
    expect(container.querySelectorAll("[data-search-close]")).toHaveLength(1);
  });
  it("opens with accepted focus/isolation and no QA, suggestions or fictional history", () => {
    const loader = vi.fn();
    const container = renderSearch(loader);
    expect(document.activeElement).toBe(element(container, "input"));
    expect(
      element(container, "[data-primary-navigation-pager]").hasAttribute(
        "inert",
      ),
    ).toBe(true);
    expect(container.textContent).toContain("搜索馆藏资料");
    expect(container.textContent).not.toMatch(/QA|最近搜索|搜索建议|龙门/);
    expect(loader).not.toHaveBeenCalled();
  });
  it("opens the same panel from a header trigger and returns focus to the one used", () => {
    const frames: FrameRequestCallback[] = [];
    const frameSpy = vi.spyOn(window, "requestAnimationFrame");
    frameSpy.mockImplementation((callback) => {
      frames.push(callback);
      return frames.length;
    });
    const flushFrames = () =>
      act(() => {
        for (const frame of frames.splice(0)) frame(0);
      });
    const loader = vi.fn();
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    roots.push(root);
    act(() =>
      root.render(
        <CatalogSearchProvider>
          <div data-product-shell="" data-detail-open="false">
            <div data-primary-navigation-pager="">
              {(["home", "inscriptions", "calligraphy"] as const).map(
                (destination) => (
                  <section
                    data-primary-destination={destination}
                    hidden={destination !== "inscriptions"}
                    key={destination}
                  >
                    <header data-author-bar="">
                      <CatalogSearchHeaderAction />
                    </header>
                  </section>
                ),
              )}
            </div>
            <CatalogSearch loadPage={loader} />
          </div>
        </CatalogSearchProvider>,
      ),
    );
    const triggers = Array.from(
      container.querySelectorAll<HTMLButtonElement>(
        '[data-search-trigger-placement="header"]',
      ),
    );
    expect(triggers).toHaveLength(3);
    expect(
      triggers.every((t) => t.getAttribute("aria-label") === "打开搜索"),
    ).toBe(true);
    const visible = triggers[1]!;

    act(() => visible.click());
    expect(container.querySelector("[data-search-panel]")).not.toBeNull();
    expect(document.activeElement).toBe(element(container, "input"));
    expect(visible.getAttribute("aria-expanded")).toBe("true");
    expect(
      element(container, "[data-primary-navigation-pager]").hasAttribute(
        "inert",
      ),
    ).toBe(true);

    act(() =>
      element<HTMLButtonElement>(container, "[data-search-close]").click(),
    );
    flushFrames();
    expect(container.querySelector("[data-search-panel]")).toBeNull();
    expect(document.activeElement).toBe(visible);
    expect(loader).not.toHaveBeenCalled();
    frameSpy.mockRestore();
  });
  it("submits backend requests and opens the existing Detail with the real identity", async () => {
    const loader = vi.fn().mockResolvedValue(success());
    const container = renderSearch(loader);
    type(container, "正文");
    await submit(container);
    expect(loader).toHaveBeenCalledWith(
      { q: "正文", page: "1", pageSize: "20" },
      expect.any(AbortSignal),
    );
    expect(container.textContent).toContain("正文匹配");
    const opener = element<HTMLButtonElement>(
      container,
      "[data-search-result] [data-open-catalog]",
    );
    act(() => opener.click());
    expect(openCatalog).toHaveBeenCalledWith("synthetic-search-1", opener);
  });
  it("suppresses composition submission and does not submit blank text", async () => {
    const loader = vi.fn().mockResolvedValue(success());
    const container = renderSearch(loader);
    await submit(container);
    expect(loader).not.toHaveBeenCalled();
    type(container, "合成");
    const input = element(container, "input");
    act(() =>
      input.dispatchEvent(
        new CompositionEvent("compositionstart", { bubbles: true }),
      ),
    );
    await submit(container);
    expect(loader).not.toHaveBeenCalled();
    act(() =>
      input.dispatchEvent(
        new CompositionEvent("compositionend", { bubbles: true }),
      ),
    );
    await submit(container);
    expect(loader).toHaveBeenCalledOnce();
  });
  it("uses loading then truthful empty state", async () => {
    const pending = deferred();
    const container = renderSearch(vi.fn().mockReturnValue(pending.promise));
    type(container, "缺少");
    await submit(container);
    expect(container.textContent).toContain("正在搜索");
    await act(async () => pending.resolve(success([])));
    expect(container.textContent).toContain("没有找到相关内容");
  });
  it("shows service failure separately and retries the submitted query", async () => {
    const loader = vi
      .fn()
      .mockResolvedValueOnce({ state: "unavailable" })
      .mockResolvedValueOnce(success());
    const container = renderSearch(loader);
    type(container, "正文");
    await submit(container);
    expect(container.textContent).toContain("搜索暂时不可用");
    expect(container.textContent).not.toContain("没有找到相关内容");
    await act(async () =>
      element<HTMLButtonElement>(
        container,
        '[data-search-state="error"] button',
      ).click(),
    );
    expect(loader).toHaveBeenCalledTimes(2);
    expect(container.textContent).toContain("合成搜索资料");
  });
  it("prevents superseded requests and clear from restoring stale results", async () => {
    const first = deferred();
    const second = deferred();
    const loader = vi
      .fn()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    const container = renderSearch(loader);
    type(container, "旧文");
    await submit(container);
    type(container, "新文");
    await submit(container);
    expect(loader.mock.calls[0]?.[1].aborted).toBe(true);
    await act(async () =>
      second.resolve(success([item("synthetic-new", "新文结果")])),
    );
    await act(async () =>
      first.resolve(success([item("synthetic-old", "旧文结果")])),
    );
    expect(container.textContent).toContain("新文结果");
    expect(container.textContent).not.toContain("旧文结果");
    // Owner r3 removes the duplicate clear icon; deleting input still fences stale reads.
    type(container, "");
    expect(element<HTMLInputElement>(container, "input").value).toBe("");
    expect(container.querySelector("[data-search-result]")).toBeNull();
    expect(loader).toHaveBeenCalledTimes(2);
  });
  it("clear cancels a pending request without treating its late response as results", async () => {
    const pending = deferred();
    const loader = vi.fn().mockReturnValue(pending.promise);
    const container = renderSearch(loader);
    type(container, "待返回");
    await submit(container);
    // Owner r3 removes the duplicate clear icon; deleting input still fences stale reads.
    type(container, "");
    expect(loader.mock.calls[0]?.[1].aborted).toBe(true);
    await act(async () => pending.resolve(success()));
    expect(container.querySelector("[data-search-result]")).toBeNull();
    expect(element<HTMLInputElement>(container, "input").value).toBe("");
    expect(container.textContent).toContain("搜索馆藏资料");
  });

  it("preserves prior results on paging failure and appends only the successful next page", async () => {
    const loader = vi
      .fn()
      .mockResolvedValueOnce(success([item("synthetic-a", "第一页")], 1, 21))
      .mockResolvedValueOnce({ state: "unavailable" })
      .mockResolvedValueOnce(success([item("synthetic-b", "第二页")], 2, 21));
    const container = renderSearch(loader);
    type(container, "页面");
    await submit(container);
    await act(async () =>
      element<HTMLButtonElement>(
        container,
        "[data-catalog-paging-control]",
      ).click(),
    );
    expect(container.textContent).toContain("第一页");
    expect(container.textContent).toContain("加载失败，重新加载");
    await act(async () =>
      element<HTMLButtonElement>(
        container,
        "[data-catalog-paging-control]",
      ).click(),
    );
    expect(loader.mock.calls[2]?.[0]).toEqual({
      q: "页面",
      page: "2",
      pageSize: "20",
    });
    expect(
      Array.from(container.querySelectorAll("[data-catalog-id]")).map((node) =>
        node.getAttribute("data-catalog-id"),
      ),
    ).toEqual(["synthetic-a", "synthetic-b"]);
    expect(container.querySelector("[data-catalog-paging-control]")).toBeNull();
  });
  it("keeps the results node and scroll position while Shell owns Detail/Viewer", async () => {
    const loader = vi.fn().mockResolvedValue(success());
    const container = renderSearch(loader);
    type(container, "正文");
    await submit(container);
    const content = element(container, "[data-search-content]");
    content.scrollTop = 260;
    const result = element(container, "[data-search-result]");
    const shell = element(container, "[data-product-shell]");
    act(() => {
      shell.setAttribute("data-detail-open", "true");
      shell.setAttribute("data-viewer-open", "true");
    });
    act(() => {
      shell.setAttribute("data-viewer-open", "false");
      shell.setAttribute("data-detail-open", "false");
    });
    expect(element(container, "[data-search-result]")).toBe(result);
    expect(content.scrollTop).toBe(260);
    expect(element<HTMLInputElement>(container, "input").value).toBe("正文");
    expect(loader).toHaveBeenCalledOnce();
  });
});

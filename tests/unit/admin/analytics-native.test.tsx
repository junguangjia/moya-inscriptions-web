// @vitest-environment jsdom
import { createElement } from "react";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ADMIN_ANALYTICS_CHINA_MAP_SHA256,
  ADMIN_ANALYTICS_PROVINCE_CODES,
  type AdminAnalyticsTimePoint,
} from "@moya/contracts/admin-analytics";
import { NativeAnalytics } from "admin/analytics-native";

const navigationModule = await vi.hoisted(async () => {
  const { createRequire } = await import("node:module");
  const { realpathSync } = await import("node:fs");
  const { join } = await import("node:path");
  const require = createRequire(
    join(import.meta.dirname, "../../../apps/admin/"),
  );
  return realpathSync(require.resolve("next/navigation"));
});
vi.mock(navigationModule, () => ({
  useSearchParams: () => new URLSearchParams(window.location.search),
}));

let queries: URLSearchParams[];
let rejectCities = false;
let trendRows: AdminAnalyticsTimePoint[] = [];
const summary = {
  pageviews: 323,
  visitors: 323,
  visits: 323,
  bounces: 323,
  totaltime: 0,
};
const city = (index: number) => ({
  name: `City${index}`,
  country: "CN",
  region: null,
  visitors: 1,
  visits: 1,
  pageviews: 1,
  bounces: 1,
  totaltime: 0,
});
beforeEach(() => {
  queries = [];
  rejectCities = false;
  trendRows = [];
  window.history.replaceState({}, "", "/admin/analytics");
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const query = new URL(String(input), "http://localhost").searchParams;
      queries.push(new URLSearchParams(query));
      const resource = query.get("resource");
      if (resource === "summary")
        return Response.json({
          resource,
          data: {
            ...summary,
            comparison: {
              ...summary,
              visitors: 0,
              pageviews: 0,
              visits: 0,
              bounces: 0,
            },
          },
        });
      if (resource === "trend")
        return Response.json({
          resource,
          data: { pageviews: trendRows, sessions: trendRows },
        });
      if (resource === "map")
        return Response.json({
          resource,
          data: {
            width: 800,
            height: 640,
            viewBox: "0 0 800 640",
            sha256: ADMIN_ANALYTICS_CHINA_MAP_SHA256,
            attribution: "Synthetic boundary fixture; not a geography claim",
            referenceUrl: "https://example.invalid/standard-map",
            shapes: [
              ...ADMIN_ANALYTICS_PROVINCE_CODES.map((code, index) => ({
                id: code,
                code,
                name:
                  code === "CN-BJ"
                    ? "北京市"
                    : code === "CN-TW"
                      ? "台湾省"
                      : `合成省份${index}`,
                path: `M${index * 10},10L${index * 10 + 8},10L${index * 10},18Z`,
                decorative: false,
              })),
              {
                id: "decoration",
                code: null,
                name: "",
                path: "M1,1L2,2",
                decorative: true,
              },
            ],
          },
        });
      if (resource === "metrics") {
        const type = query.get("type");
        const data =
          type === "region"
            ? [{ x: "CN-BJ", y: 2, displayName: "北京市", country: "CN" }]
            : type === "country"
              ? [
                  { x: "CN", y: 319, displayName: "中国" },
                  { x: "US", y: 4, displayName: "美国" },
                ]
              : [];
        return Response.json({
          resource,
          data,
          limit: Number(query.get("limit")),
          offset: 0,
        });
      }
      if (resource === "expanded") {
        if (rejectCities)
          return Response.json(
            { error: "ANALYTICS_UNAVAILABLE" },
            { status: 503 },
          );
        const limit = Number(query.get("limit"));
        const offset = Number(query.get("offset") || 0);
        const data =
          query.get("region") === "CN-BJ" || query.get("q") === "北京"
            ? [
                {
                  ...city(0),
                  name: "Beijing",
                  region: "CN-BJ",
                  displayName: "北京市",
                  visitors: 2,
                },
              ]
            : Array.from({ length: 23 }, (_, index) => city(index)).slice(
                offset,
                offset + limit,
              );
        return Response.json({ resource, data, limit, offset });
      }
      throw new Error("Unexpected native analytics request");
    }),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("native Admin analytics", () => {
  it("synchronizes same-path framework navigation without resetting an unsubmitted date draft on its own URL update", async () => {
    const view = render(createElement(NativeAnalytics));
    await screen.findByText("City0");
    fireEvent.change(screen.getByLabelText("开始日期"), {
      target: { value: "2026-10-01" },
    });
    fireEvent.change(screen.getByRole("searchbox", { name: "搜索城市" }), {
      target: { value: "北京" },
    });
    fireEvent.click(screen.getByRole("button", { name: "搜索城市" }));
    await screen.findByText("北京市", { selector: "td" });
    view.rerender(createElement(NativeAnalytics));
    expect((screen.getByLabelText("开始日期") as HTMLInputElement).value).toBe(
      "2026-10-01",
    );
    window.history.replaceState({}, "", "/admin/analytics");
    view.rerender(createElement(NativeAnalytics));
    await screen.findByText("City0");
    expect(
      (screen.getByRole("searchbox", { name: "搜索城市" }) as HTMLInputElement)
        .value,
    ).toBe("");
    expect(queries.at(-1)?.has("q")).toBe(false);
    expect(queries.at(-1)?.get("offset")).toBe("0");
  });
  it("keeps empty days on the selected date axis rather than spacing sparse observations equally", async () => {
    window.history.replaceState(
      {},
      "",
      "/admin/analytics?from=2026-10-20&to=2026-10-26",
    );
    trendRows = [
      { x: "2026-10-20", y: 2 },
      { x: "2026-10-21", y: 3 },
      { x: "2026-10-26", y: 4 },
    ];
    render(createElement(NativeAnalytics));
    const graph = await screen.findByRole("img", {
      name: "所选日期内的访客与浏览量趋势",
    });
    const points = graph
      .querySelectorAll("polyline")[1]!
      .getAttribute("points")!
      .split(" ")
      .map((point) => point.split(",").map(Number));
    expect(points).toHaveLength(7);
    expect(
      (points[1]![0]! - points[0]![0]!) / (points[6]![0]! - points[0]![0]!),
    ).toBeCloseTo(1 / 6);
    expect(points[2]![1]).toBeGreaterThan(points[1]![1]!);
    fireEvent.click(screen.getByText("查看趋势数据"));
    expect(screen.getByText("2026-10-22")).toBeTruthy();
  });

  it("keeps geography local to cities and exposes a native 34-province map without an embedded application", async () => {
    const { container } = render(createElement(NativeAnalytics));
    const overview = screen.getByRole("region", { name: "访问概览" });
    await within(overview).findAllByText("323");
    const map = await screen.findByRole("group", { name: /中国省级访问地图/u });
    expect(within(map).getAllByRole("button")).toHaveLength(34);
    expect(within(map).getByRole("button", { name: /^台湾省/u })).toBeTruthy();
    fireEvent.click(within(map).getByRole("button", { name: /^北京市/u }));
    await waitFor(() =>
      expect(
        queries.some(
          (query) =>
            query.get("resource") === "expanded" &&
            query.get("country") === "CN" &&
            query.get("region") === "CN-BJ",
        ),
      ).toBe(true),
    );
    expect(
      queries.filter((query) => query.get("resource") === "summary"),
    ).toHaveLength(1);
    expect(within(overview).getAllByText("323")).toHaveLength(3);
    expect(container.querySelector("iframe")).toBeNull();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(
      queries.every(
        (query) =>
          !query.has("websiteId") &&
          !query.has("boardId") &&
          !query.has("username"),
      ),
    ).toBe(true);
  });

  it("expands and paginates in place, then resets pagination when searching or choosing a province", async () => {
    render(createElement(NativeAnalytics));
    await screen.findByText("City0");
    fireEvent.click(screen.getByRole("button", { name: "查看全部城市" }));
    await waitFor(() =>
      expect(
        queries.some(
          (query) =>
            query.get("resource") === "expanded" && query.get("limit") === "20",
        ),
      ).toBe(true),
    );
    await screen.findByText("City19");
    fireEvent.click(screen.getByRole("button", { name: "下一页城市" }));
    await screen.findByText("City20");
    expect(screen.queryByText("City0")).toBeNull();
    fireEvent.change(screen.getByRole("searchbox", { name: "搜索城市" }), {
      target: { value: "北京" },
    });
    fireEvent.click(screen.getByRole("button", { name: "搜索城市" }));
    await screen.findByText("北京市", { selector: "td" });
    expect(queries.at(-1)?.get("offset")).toBe("0");
    expect(queries.at(-1)?.get("q")).toBe("北京");
    fireEvent.change(screen.getByLabelText("选择省份"), {
      target: { value: "CN-BJ" },
    });
    await waitFor(() => expect(queries.at(-1)?.get("region")).toBe("CN-BJ"));
    expect(
      (screen.getByRole("searchbox", { name: "搜索城市" }) as HTMLInputElement)
        .value,
    ).toBe("");
    expect(queries.at(-1)?.has("q")).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "清除地域筛选" }));
    await screen.findByText("City0");
    expect(queries.at(-1)?.has("region")).toBe(false);
    expect(queries.at(-1)?.has("country")).toBe(false);
  });

  it("retains the search on a read failure and retries without presenting invented zero counts", async () => {
    render(createElement(NativeAnalytics));
    await screen.findByText("City0");
    rejectCities = true;
    fireEvent.change(screen.getByRole("searchbox", { name: "搜索城市" }), {
      target: { value: "北京" },
    });
    fireEvent.click(screen.getByRole("button", { name: "搜索城市" }));
    const failure = await screen.findByRole("alert");
    expect(failure.textContent).toContain("暂时无法读取");
    expect(screen.queryByText("City0")).toBeNull();
    expect(screen.queryByText(/当前范围没有符合条件/u)).toBeNull();
    expect(
      (screen.getByRole("searchbox", { name: "搜索城市" }) as HTMLInputElement)
        .value,
    ).toBe("北京");
    rejectCities = false;
    fireEvent.click(within(failure).getByRole("button", { name: "重试" }));
    await screen.findByText("北京市", { selector: "td" });
    expect(
      (screen.getByRole("searchbox", { name: "搜索城市" }) as HTMLInputElement)
        .value,
    ).toBe("北京");
  });
});

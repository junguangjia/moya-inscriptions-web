import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

// Explicit synthetic HTTP responses validate the Formal browser journey.
// Actual PostgreSQL/normalization/HTTP quality is tested by the isolated backend suite.
const summary = (id: string, title: string) => ({
  id,
  title,
  kind: "inscription",
  aliases: [],
  matchKind: "title-alias-partial",
});
const firstItems = Array.from({ length: 20 }, (_, index) =>
  summary(`search-synthetic-${index}`, `合成搜索资料 ${index + 1}`),
);
const target = summary("runtime-inscription-multi-media", "运行时多图碑刻");
const responsePage = (
  items: readonly unknown[],
  page = 1,
  total = items.length,
) => ({ items, page, pageSize: 20, total, totalPages: Math.ceil(total / 20) });
const openSearch = async (page: Page) => {
  await page.goto("/");
  await expect(page.locator("[data-product-boot]")).toHaveCount(0);
  await page.getByRole("button", { name: "打开搜索", exact: true }).click();
  const search = page.getByRole("dialog", { name: "搜索", exact: true });
  await expect(search).toBeVisible();
  await expect(search.getByRole("searchbox")).toBeFocused();
  return search;
};

test("Formal Search preserves server paging order and Detail/Viewer return state", async ({
  page,
}) => {
  let requests = 0;
  await page.route("**/api/catalog-search?*", async (route) => {
    requests += 1;
    const url = new URL(route.request().url());
    expect(url.searchParams.get("q")).toBe("合成文字");
    expect(url.searchParams.get("pageSize")).toBe("20");
    const pageNumber = Number(url.searchParams.get("page"));
    await route.fulfill({
      json: responsePage(
        pageNumber === 1 ? firstItems : [target],
        pageNumber,
        21,
      ),
    });
  });
  const search = await openSearch(page);
  await expect(search).not.toContainText(/QA|最近搜索|搜索建议/u);
  await search.getByRole("searchbox").fill("合成文字");
  await search.getByRole("button", { name: "提交搜索", exact: true }).click();
  await expect(search.locator("[data-search-result]")).toHaveCount(20);
  await search.getByRole("button", { name: "继续加载", exact: true }).click();
  await expect(search.locator("[data-search-result]")).toHaveCount(21);
  const opener = search.locator(
    '[data-catalog-id="runtime-inscription-multi-media"] [data-open-catalog]',
  );
  await opener.scrollIntoViewIfNeeded();
  const content = search.locator("[data-search-content]");
  const scrollTop = await content.evaluate((node) => node.scrollTop);
  expect(scrollTop).toBeGreaterThan(0);
  await opener.click();
  const detail = page.getByRole("dialog", { name: "资料详情", exact: true });
  await expect(detail).toBeVisible();
  await expect(detail.locator("[data-detail-title]")).toHaveText(
    "运行时多图碑刻",
  );
  await detail.locator("[data-detail-main-image]").click();
  const viewer = page.getByRole("dialog", { name: "图像查看", exact: true });
  await expect(viewer).toBeVisible();
  await page.goBack();
  await expect(viewer).toBeHidden();
  await expect(detail).toBeVisible();
  await detail.getByRole("button", { name: "返回", exact: true }).click();
  await expect(detail).toHaveCount(0);
  await expect(search).toBeVisible();
  await expect(opener).toBeFocused();
  await expect(search.getByRole("searchbox")).toHaveValue("合成文字");
  await expect(search.locator("[data-search-result]")).toHaveCount(21);
  await expect
    .poll(() => content.evaluate((node) => node.scrollTop))
    .toBeCloseTo(scrollTop, 0);
  expect(requests).toBe(2);
  // The current Search composer clears through its native search input.
  await search.getByRole("searchbox").fill("");
  await expect(search.getByRole("searchbox")).toHaveValue("");
  await expect(search.locator("[data-search-result]")).toHaveCount(0);
  expect(requests).toBe(2);
});

test("Formal Search distinguishes error/retry/empty and suppresses composition Enter", async ({
  page,
}) => {
  let requests = 0;
  await page.route("**/api/catalog-search?*", async (route) => {
    requests += 1;
    await route.fulfill(
      requests === 1 ? { status: 503, body: "" } : { json: responsePage([]) },
    );
  });
  const search = await openSearch(page);
  const input = search.getByRole("searchbox");
  await input.fill("合成无结果");
  await input.dispatchEvent("compositionstart");
  await input.press("Enter");
  expect(requests).toBe(0);
  await input.dispatchEvent("compositionend");
  await search.getByRole("button", { name: "提交搜索", exact: true }).click();
  await expect(search.getByRole("alert")).toContainText("搜索暂时不可用");
  await expect(search).not.toContainText("没有找到相关内容");
  await search.getByRole("button", { name: "重试", exact: true }).click();
  await expect(search).toContainText("没有找到相关内容");
  expect(requests).toBe(2);
  await search.getByRole("button", { name: "关闭搜索", exact: true }).click();
  await expect(search).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "打开搜索", exact: true }),
  ).toBeFocused();
});

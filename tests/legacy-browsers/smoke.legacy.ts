import { mkdirSync, writeFileSync } from "node:fs";

import { expect, test } from "@playwright/test";

import type { Locator, Page } from "@playwright/test";

// Core anonymous flows of the production build against the e2e Public API
// fixture. Selectors follow tests/e2e/formal-web.spec.ts and search-v1.spec.ts,
// limited to APIs that @playwright/test 1.31 already has.
const catalogId = "runtime-inscription-multi-media";
const title = "运行时多图碑刻";

const surface = (page: Page) => page.locator("[data-clean-product-preview]");
const shell = (page: Page) => surface(page).locator("[data-product-shell]");
const detail = (page: Page) =>
  shell(page).getByRole("dialog", { name: "资料详情" });
const viewer = (page: Page) =>
  shell(page).getByRole("dialog", { name: "图像查看" });

const click = async (locator: Locator) => {
  await expect(locator).toBeVisible();
  await locator.click();
};

// From 896px the public product is browse-only for visitors without an
// account (pc-browse-only-v1): no dock, no 讨论/用户, and /login and /register
// go to Home. Steps that need them run in a desktop window below that width.
const narrow = (page: Page) =>
  page.setViewportSize({ width: 800, height: 900 });

const enter = async (page: Page, path = "/") => {
  const response = await page.goto(path);
  expect(response?.status()).toBe(200);
  await expect(shell(page)).toBeVisible();
  await expect(surface(page).locator("[data-product-boot]")).toHaveCount(0);
};

let pageErrors: string[] = [];

test.beforeEach(async ({ page }) => {
  pageErrors = [];
  page.on("pageerror", (error) =>
    pageErrors.push(`${error.name}: ${error.message}`),
  );
});

test.afterEach(async () => {
  expect(pageErrors, "uncaught page errors").toEqual([]);
});

test("enters the site and the home feed reads /api/community/discover", async ({
  page,
  browser,
  browserName,
}) => {
  const discover: number[] = [];
  page.on("response", (response) => {
    if (new URL(response.url()).pathname === "/api/community/discover")
      discover.push(response.status());
  });
  const response = await page.goto("/");
  expect(response?.status()).toBe(200);
  const engine = {
    project: test.info().project.name,
    browserName,
    version: browser.version(),
    userAgent: await page.evaluate(() => navigator.userAgent),
  };
  console.log(`ENGINE ${JSON.stringify(engine)}`);
  const output = process.env.LEGACY_OUTPUT_DIR;
  if (output) {
    mkdirSync(output, { recursive: true });
    writeFileSync(
      `${output}/engine-${engine.project}.json`,
      `${JSON.stringify(engine, null, 2)}\n`,
    );
  }
  await expect(shell(page)).toBeVisible();
  await expect(surface(page).locator("[data-product-boot]")).toHaveCount(0);
  // Bounded like every other step: no request at all must fail, not wait.
  await expect.poll(() => discover).toContain(200);
  await expect(
    shell(page).locator(
      `[data-home-feed-panel="discover"] [data-catalog-id="${catalogId}"]`,
    ),
  ).toBeVisible();
});

test("switches the four home tabs", async ({ page }) => {
  await enter(page);
  const home = shell(page).locator("[data-home-surface]");
  for (const [name, feed] of [
    ["附近", "nearby"],
    ["碑刻", "inscriptions"],
    ["书帖", "calligraphy"],
    ["发现", "discover"],
  ] as const) {
    await click(home.getByRole("tab", { exact: true, name }));
    await expect(home).toHaveAttribute("data-active-home-feed", feed);
  }
});

test("opens 讨论 and 用户", async ({ page }) => {
  await narrow(page);
  await enter(page);
  const navigation = surface(page).getByRole("navigation", {
    name: "主要内容",
  });
  for (const [name, destination] of [
    ["讨论", "discussion"],
    ["用户", "user"],
    ["首页", "home"],
  ] as const) {
    await click(navigation.getByRole("button", { exact: true, name }));
    await expect(shell(page)).toHaveAttribute(
      "data-active-destination",
      destination,
    );
  }
});

test("opens a detail and the viewer, then goes back twice", async ({
  page,
}) => {
  await enter(page);
  await click(
    shell(page)
      .locator(
        '[data-primary-destination="home"] [data-home-feed-panel][aria-hidden="false"]',
      )
      .locator(`[data-catalog-id="${catalogId}"] [data-open-catalog]`),
  );
  await expect(detail(page)).toBeVisible();
  await expect(detail(page).locator("[data-detail-title]")).toHaveText(title);
  await click(detail(page).locator("[data-detail-main-image]"));
  await expect(viewer(page)).toBeVisible();
  await expect(page).toHaveURL(/[?&]image=/u);
  await page.goBack();
  await expect(viewer(page)).toBeHidden();
  await expect(detail(page)).toBeVisible();
  await page.goBack();
  await expect(detail(page)).toHaveCount(0);
  await expect(page).not.toHaveURL(/[?&]catalogId=/u);
  await expect(shell(page)).toBeVisible();
});

test("opens and closes search at 1280 without the dock", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await enter(page);
  await expect(shell(page)).toHaveAttribute("data-browse-only", "true");
  await expect(
    surface(page).getByRole("navigation", { name: "主要内容" }),
  ).toBeHidden();
  await click(page.getByRole("button", { name: "打开搜索", exact: true }));
  const search = page.getByRole("dialog", { name: "搜索", exact: true });
  await expect(search).toBeVisible();
  await expect(search.getByRole("searchbox")).toBeVisible();
  await click(search.getByRole("button", { name: "关闭搜索", exact: true }));
  await expect(search).toBeHidden();
});

test("follows a detail deep link", async ({ page }) => {
  await enter(page, `/?catalogId=${catalogId}#detail`);
  await expect(detail(page)).toBeVisible();
  await expect(page.locator("[data-detail-state=loaded]")).toBeVisible();
  await expect(detail(page).locator("[data-detail-title]")).toHaveText(title);
});

for (const path of ["/login", "/register"])
  test(`renders the ${path} form`, async ({ page }) => {
    await narrow(page);
    const response = await page.goto(path);
    expect(response?.status()).toBe(200);
    const main = page.locator("main[data-auth-mode]");
    await expect(main).toBeVisible();
    await expect(main.locator("form")).toBeVisible();
    await expect(main.locator("form input").first()).toBeVisible();
    await expect(page.getByText("暂时无法连接登录服务")).toHaveCount(0);
  });

import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { prepareFormalRoutes } from "./support/prepare-formal-routes";

// These cases intentionally do not seed a desktop preference before entry.
test.beforeAll(async ({ request }) => prepareFormalRoutes(request));
test.beforeEach(async ({ page }, info) => {
  test.skip(!info.project.name.startsWith("desktop"), "Desktop default only");
  test.setTimeout(45_000);
  await page.setViewportSize({ width: 1440, height: 900 });
});

const storedChoices = (page: Page) =>
  page.evaluate(() => [
    localStorage.getItem("yoyi.desktop-feed-layout.v1"),
    localStorage.getItem("yoyi.home-feed-layout.v2"),
  ]);
const ready = async (page: Page) => {
  await expect(page.locator("html")).toHaveAttribute("data-yoyi-boot", "ready");
};

test("an unseeded desktop defaults to normal without writing either preference", async ({
  page,
}) => {
  for (const width of [1024, 1440, 800]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/");
    await ready(page);
    const shell = page.locator("[data-product-shell]");
    await expect(shell).toHaveAttribute("data-feed-layout", "double");
    await expect(shell).toHaveAttribute(
      "data-desktop",
      width >= 896 ? "true" : "false",
    );
    await expect(shell).toHaveAttribute("data-browse-only", "false");
    await expect(page.locator("html")).toHaveAttribute(
      "data-home-layout",
      "double",
    );
    await expect(page.locator("[data-desktop-feed]")).toHaveCount(0);
    expect(await storedChoices(page)).toEqual([null, null]);
  }
});

test("an unseeded desktop retains real navigation, publishing and auth entries", async ({
  page,
}) => {
  await page.goto("/");
  await ready(page);
  const shell = page.locator("[data-product-shell]");
  await expect(shell).toHaveAttribute("data-feed-layout", "double");
  await expect(shell).toHaveAttribute("data-browse-only", "false");
  const navigation = page.getByRole("navigation", {
    name: "主要内容",
    exact: true,
  });
  await expect(navigation).toBeVisible();
  await expect(page.locator("[data-create-work-action]")).toBeVisible();
  await expect(
    page.getByRole("button", { name: "打开消息", exact: true }),
  ).toBeVisible();
  await navigation.getByRole("button", { name: "用户", exact: true }).click();
  const login = page
    .locator('[data-author-profile="guest"]')
    .getByRole("link", { name: "登录", exact: true });
  await expect(login).toBeVisible();
  await login.click();
  await expect(page).toHaveURL((url) => url.pathname === "/login");
  await expect(page.locator('[data-auth-mode="sign-in"]')).toBeVisible();
  for (const [path, mode] of [
    ["/login", "sign-in"],
    ["/register", "register"],
  ] as const) {
    await page.goto(path);
    await expect(page).toHaveURL((url) => url.pathname === path);
    await expect(page.locator('[data-auth-mode="' + mode + '"]')).toBeVisible();
    await expect(page.locator("body")).toHaveCSS("visibility", "visible");
    await expect(page.locator("#yoyi-auth-redirect")).toHaveCount(0);
    expect(await storedChoices(page)).toEqual([null, null]);
  }
});

test("an explicit book choice survives sign-in cancellation and reload", async ({
  page,
}) => {
  await page.goto("/");
  await ready(page);
  const shell = page.locator("[data-product-shell]");
  await expect(shell).toHaveAttribute("data-feed-layout", "double");
  // One-time legacy setup must not reseed choices during auth navigation or reload.
  await page.evaluate(() =>
    localStorage.setItem("yoyi.home-feed-layout.v2", "double"),
  );
  await page.locator("[data-desktop-settings]").click();
  await page.locator("[data-feed-layout-toggle]").click();
  await expect(page.locator("[data-feed-layout-toggle]")).toHaveAttribute(
    "data-feed-layout-mode",
    "single",
  );
  await page.keyboard.press("Escape");
  await expect(shell).toHaveAttribute("data-feed-layout", "single");
  expect(await storedChoices(page)).toEqual(["single", "double"]);
  await page.reload();
  await ready(page);
  await expect(shell).toHaveAttribute("data-feed-layout", "single");
  const navigation = page.getByRole("navigation", {
    name: "主要内容",
    exact: true,
  });
  await navigation.getByRole("button", { name: "用户", exact: true }).click();
  const sourceUrl = page.url();
  await page
    .locator('[data-author-profile="guest"]')
    .getByRole("link", { name: "登录", exact: true })
    .click();
  await expect(page.locator('[data-auth-mode="sign-in"]')).toBeVisible();
  expect(await storedChoices(page)).toEqual(["single", "double"]);
  await page.goBack();
  await expect(page).toHaveURL(sourceUrl);
  await ready(page);
  await expect(shell).toHaveAttribute("data-active-destination", "user");
  await expect(shell).toHaveAttribute("data-feed-layout", "single");
  await page.reload();
  await ready(page);
  await expect(shell).toHaveAttribute("data-feed-layout", "single");
  expect(await storedChoices(page)).toEqual(["single", "double"]);
});

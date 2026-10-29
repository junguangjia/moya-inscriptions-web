import { expect, test } from "@playwright/test";
import { prepareFormalRoutes } from "./support/prepare-formal-routes";
import { addSessionCookie } from "./support/session-cookie";

test.beforeAll(async ({ request }) => {
  await prepareFormalRoutes(request);
  for (const path of ["/login", "/register"])
    expect((await request.get(path)).status()).toBe(200);
});
test.beforeEach(async ({ page }) => {
  test.setTimeout(45000);
  await page.addInitScript(() => {
    localStorage.setItem("yoyi.home-feed-layout.v2", "double");
    localStorage.setItem("yoyi.desktop-feed-layout.v1", "double");
  });
});

// #260 retires the device-only restriction; auth/session permissions remain.
test("authentication pages remain visible at every width, reload and history return", async ({
  page,
}, info) => {
  for (const width of [800, 896, 1440, 2560]) {
    await page.setViewportSize({ width, height: 900 });
    for (const [path, mode] of [
      ["/login", "sign-in"],
      ["/register", "register"],
    ] as const) {
      await page.goto(`${path}?return=%2F%3Ffeed%3Dinscriptions`);
      const form = page.locator(`[data-auth-mode="${mode}"]`);
      await expect(form).toBeVisible();
      await expect(page.locator("body")).toHaveCSS("visibility", "visible");
      await expect(page.locator("#yoyi-auth-redirect")).toHaveCount(0);
      await expect(page).toHaveURL((url) => url.pathname === path);
      await page.reload();
      await expect(form).toBeVisible();
      await expect(page).toHaveURL((url) => url.pathname === path);
    }
  }
  await page.goto("/login");
  await page.goto("/");
  await page.goBack();
  await expect(page.locator('[data-auth-mode="sign-in"]')).toBeVisible();
  await page.screenshot({
    path: info.outputPath("desktop-login.png"),
    animations: "disabled",
  });
});

test("anonymous product exposes navigation and its sign-in entry without anonymous write access", async ({
  page,
}, info) => {
  await page.goto("/");
  const shell = page.locator("[data-product-shell]");
  await expect(shell).toHaveAttribute("data-browse-only", "false");
  const nav = page.getByRole("navigation", { name: "主要内容" });
  await expect(nav).toBeVisible();
  await expect(page.locator("[data-create-work-action]")).toBeVisible();
  await nav.getByRole("button", { name: "讨论", exact: true }).click();
  await expect(shell).toHaveAttribute("data-active-destination", "discussion");
  await nav.getByRole("button", { name: "用户", exact: true }).click();
  await expect(shell).toHaveAttribute("data-active-destination", "user");
  const guest = page.locator('[data-author-profile="guest"]');
  await expect(guest).toBeVisible();
  const login = guest.getByRole("link", { name: "登录", exact: true });
  await expect(login).toBeVisible();
  await page.screenshot({
    path: info.outputPath("desktop-guest-features.png"),
    animations: "disabled",
  });
  await login.click();
  await expect(page).toHaveURL((url) => url.pathname === "/login");
  await expect(page.locator('[data-auth-mode="sign-in"]')).toBeVisible();
});

test("anonymous detail keeps real discussion and actions across compact reflow", async ({
  page,
}) => {
  await page.goto("/?catalogId=runtime-inscription-no-media#detail");
  const shell = page.locator("[data-product-shell]"),
    detail = page.getByRole("dialog", { name: "资料详情" });
  await expect(detail).toHaveAttribute("data-detail-state", "loaded");
  await expect(detail.locator("[data-detail-content-actions]")).toBeVisible();
  await expect(detail.locator("[data-comment-section]")).toHaveCount(1);
  await expect(detail.locator("[data-comment-composer]")).toHaveCount(0);
  const original = page.viewportSize()!;
  for (const width of [800, 896, 1440, original.width]) {
    await page.setViewportSize({ width, height: original.height });
    await expect(shell).toHaveAttribute("data-browse-only", "false");
    await expect(detail).toBeVisible();
    await expect(detail.locator("[data-detail-content-actions]")).toBeVisible();
  }
});

test("notification deep links remain reachable for visitors and show a login state", async ({
  page,
}) => {
  await page.goto("/?notifications=comments");
  await expect(page.locator("[data-product-shell]")).toHaveAttribute(
    "data-browse-only",
    "false",
  );
  const messages = page.getByRole("dialog", { name: /^(消息|评论)$/ });
  await expect(messages).toBeVisible();
  await expect(
    messages.getByRole("link", { name: /登录/ }).first(),
  ).toBeVisible();
  // The existing message host consumes this one-shot link after opening it.
  await messages.getByRole("button", { name: "返回", exact: true }).click();
  await expect(
    page.getByRole("dialog", { name: "消息", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("dialog", { name: "消息", exact: true })
    .getByRole("button", { name: "返回", exact: true })
    .click();
  await expect(messages).not.toBeVisible();
  await expect(
    page.getByRole("navigation", { name: "主要内容" }),
  ).toBeVisible();
});

test("confirmed sessions retain existing features and lose no UI merely on expiry", async ({
  baseURL,
  context,
  page,
}) => {
  if (!baseURL) throw Error("missingbaseURL");
  await addSessionCookie(context, baseURL);
  let signedIn = true;
  await page.route("**/api/community/me", (route) =>
    signedIn
      ? route.fulfill({
          json: {
            id: `user-${"8".repeat(32)}`,
            handle: "synthetic-desktop-viewer",
            displayName: "桌面测试",
          },
        })
      : route.fulfill({ status: 401 }),
  );
  await page.goto("/");
  const shell = page.locator("[data-product-shell]");
  await expect(shell).toHaveAttribute("data-browse-only", "false");
  const nav = page.getByRole("navigation", { name: "主要内容" });
  await expect(nav).toBeVisible();
  await nav.getByRole("button", { name: "讨论", exact: true }).click();
  await expect(shell).toHaveAttribute("data-active-destination", "discussion");
  signedIn = false;
  await context.clearCookies();
  const expired = page.waitForResponse(
    (response) =>
      response.url().endsWith("/api/community/me") && response.status() === 401,
  );
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expired;
  await expect(shell).toHaveAttribute("data-browse-only", "false");
  await expect(nav).toBeVisible();
  await expect(shell).toHaveAttribute("data-active-destination", "discussion");
});

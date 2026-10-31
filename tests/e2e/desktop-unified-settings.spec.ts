import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { readPagingWebPort } from "./support/e2e-ports";

// Browser-only synthetic identities; no real Session, mail or account writes.
const actor = {
  id: `user-${"f".repeat(32)}`,
  handle: "synthetic-unified-settings",
  displayName: "统一设置合成用户",
};
const ownProfile = {
  ...actor,
  bio: "合成资料",
  avatar: null,
  isOwner: true,
  following: false,
  privacy: {
    following: "private",
    followers: "private",
    favorites: "private",
    likes: "private",
  },
  totals: { works: 0, following: 0, followers: 0, favorites: 0, likes: 0 },
  nextAvatarChangeAt: null,
};
const installIdentity = async (page: Page, initiallySignedIn = false) => {
  let signedIn = initiallySignedIn;
  const writes: string[] = [];
  await page.route("**/api/community/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname.replace("/api/community/", "");
    if (path === "me")
      return route.fulfill(
        signedIn
          ? { status: 200, json: actor }
          : {
              status: 401,
              json: {
                error: { code: "UNAUTHENTICATED", message: "Synthetic guest" },
              },
            },
      );
    if (path === `authors/${actor.id}`)
      return route.fulfill({ status: 200, json: ownProfile });
    if (path.startsWith(`authors/${actor.id}/`))
      return route.fulfill({
        status: 200,
        json: { items: [], page: 1, pageSize: 12, total: 0 },
      });
    if (path === "auth/capabilities")
      return route.fulfill({
        status: 200,
        json: {
          profile: "full-local",
          email: { available: true, reason: null },
          phone: { available: false, reason: "not_configured" },
          developmentOnly: true,
        },
      });
    if (path === "auth/passwords/login") {
      writes.push(path);
      signedIn = true;
      return route.fulfill({
        status: 200,
        json: {
          outcome: "signed_in",
          session: {
            expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
            profile: actor,
          },
        },
      });
    }
    if (request.method() !== "GET") writes.push(path);
    return route.fallback();
  });
  return writes;
};

test.beforeEach(async ({ page }, info) => {
  test.skip(
    !info.project.name.startsWith("desktop"),
    "Desktop complete-settings integration",
  );
  test.setTimeout(45_000);
  await page.setViewportSize({ width: 1440, height: 900 });
});
const ready = async (page: Page) =>
  expect(page.locator("html")).toHaveAttribute("data-yoyi-boot", "ready");
const settings = (page: Page) =>
  page.getByRole("dialog", { name: "设置", exact: true });
const assertOutsideInert = async (page: Page) => {
  await expect(page.locator("dialog[open]")).toHaveCount(1);
  expect(
    await page
      .locator("dialog[open]")
      .evaluate(
        (node) =>
          node.closest('[hidden], [inert], [aria-hidden="true"]') === null,
      ),
  ).toBe(true);
  await expect(page.locator("[data-product-settings]")).toHaveCount(0);
};

test("every primary gear opens the same complete guest settings with protected entries", async ({
  page,
}) => {
  const writes = await installIdentity(page);
  await page.goto("/");
  await ready(page);
  for (const destination of ["首页", "讨论", "用户"]) {
    await page
      .getByRole("navigation", { name: "主要内容", exact: true })
      .getByRole("button", { name: destination, exact: true })
      .click();
    const gear = page.locator("[data-desktop-settings]");
    await gear.click();
    await expect(settings(page)).toBeVisible();
    await assertOutsideInert(page);
    for (const label of [
      "外观",
      "列表隐私",
      "已屏蔽账户",
      "账号与安全",
      "切换账号",
      "我的举报与申诉",
      "编辑信息",
      "反馈与建议",
    ])
      await expect(
        settings(page).getByRole("button", { name: new RegExp(`^${label}`) }),
      ).toBeVisible();
    await settings(page)
      .getByRole("button", { name: "列表隐私", exact: true })
      .click();
    const privacy = page.getByRole("dialog", { name: "列表隐私", exact: true });
    await expect(
      privacy.getByRole("link", { name: "登录后管理账户设置", exact: true }),
    ).toBeVisible();
    await expect(privacy.locator("select")).toHaveCount(0);
    await privacy.getByRole("button", { name: "返回", exact: true }).click();
    await expect(settings(page)).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(settings(page)).toHaveCount(0);
    await expect(gear).toBeFocused();
  }
  expect(writes).toEqual([]);
});

test("direct settings consumes the old root entry before the native dialog closes", async ({
  page,
}) => {
  await installIdentity(page);
  await page.goto("/policies");
  const before = page.url();
  await page.goto("/#settings");
  await ready(page);
  await expect(settings(page)).toBeVisible();
  await assertOutsideInert(page);
  await page.keyboard.press("Escape");
  await expect(settings(page)).toHaveCount(0);
  await page.goBack();
  await expect(page).toHaveURL(before);
});

test("the own-profile overlay uses the complete host outside its inert parent", async ({
  page,
}) => {
  const writes = await installIdentity(page, true);
  await page.goto(`/?authorId=${actor.id}#profile`);
  await ready(page);
  const profile = page.getByRole("dialog", { name: "作者主页", exact: true });
  await expect(profile).toBeVisible();
  await profile.getByRole("button", { name: "设置", exact: true }).click();
  await expect(settings(page)).toBeVisible();
  await assertOutsideInert(page);
  await settings(page)
    .getByRole("button", { name: "编辑信息", exact: true })
    .click();
  const editor = page.getByRole("dialog", { name: "编辑资料", exact: true });
  await expect(editor.getByLabel("昵称", { exact: true })).toHaveValue(
    actor.displayName,
  );
  await editor.getByRole("button", { name: "返回", exact: true }).click();
  await expect(settings(page)).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(settings(page)).toHaveCount(0);
  await expect(profile).toBeVisible();
  expect(writes).toEqual([]);
});

test("guest edit intent survives login and offers the real editor with fresh owned data", async ({
  page,
}) => {
  const writes = await installIdentity(page);
  await page.goto("/");
  await ready(page);
  await page.locator("[data-desktop-settings]").click();
  await settings(page)
    .getByRole("button", { name: "编辑信息", exact: true })
    .click();
  await page
    .getByRole("dialog", { name: "编辑信息", exact: true })
    .getByRole("link", { name: "登录后管理账户设置", exact: true })
    .click();
  await expect(page.locator('[data-auth-mode="sign-in"]')).toBeVisible();
  await page
    .getByLabel("邮箱地址", { exact: true })
    .fill("synthetic-settings-owner@example.invalid");
  await page
    .getByLabel("密码", { exact: true })
    .fill("synthetic-settings-only-password-42");
  await page.getByRole("button", { name: "登录", exact: true }).click();
  const continued = page.getByRole("dialog", { name: "编辑信息", exact: true });
  await continued
    .getByRole("button", { name: "继续编辑资料", exact: true })
    .click();
  const editor = page.getByRole("dialog", { name: "编辑资料", exact: true });
  await expect(editor.getByLabel("昵称", { exact: true })).toHaveValue(
    actor.displayName,
  );
  await expect(
    editor.getByRole("textbox", { name: "简介", exact: true }),
  ).toHaveValue(ownProfile.bio);
  // The editor replaces Settings, so its native modal must retain the lock.
  await expect
    .poll(() => page.evaluate(() => document.documentElement.style.overflowY))
    .toBe("hidden");
  expect(writes).toEqual(["auth/passwords/login"]);
});

test("settings to editor retains the desktop viewport lock and returns its exact state", async ({
  page,
}) => {
  const writes = await installIdentity(page, true);
  await page.setViewportSize({ width: 1024, height: 720 });
  // Use the existing paged fixture so this journey has real scrollable content.
  await page.goto(`http://127.0.0.1:${readPagingWebPort()}/?feed=inscriptions`);
  await ready(page);
  await expect(
    page.locator('[data-home-feed-panel="inscriptions"] [data-desktop-feed]'),
  ).toHaveAttribute("data-layout-ready", "true");
  await expect(page.locator("[data-product-shell]")).not.toHaveAttribute(
    "data-scroll-restoring",
    "",
  );
  // Isolate viewport locking from the number/shape of records in this fixture.
  // Scroll with real input so any bounded initial restoration relinquishes.
  await page.addStyleTag({
    content: "[data-product-shell] { min-height: 200vh; }",
  });
  const initial = await page.evaluate(() => ({
    value: document.documentElement.style.getPropertyValue("overflow-y"),
    priority: document.documentElement.style.getPropertyPriority("overflow-y"),
  }));
  await page.mouse.move(5, 350);
  await page.mouse.wheel(0, 300);
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(300);
  const before = await page.evaluate(() => window.scrollY);
  const gear = page.locator("[data-desktop-settings]");
  await gear.click();
  await settings(page)
    .getByRole("button", { name: "编辑信息", exact: true })
    .click();
  const editor = page.getByRole("dialog", { name: "编辑资料", exact: true });
  await expect(editor).toBeVisible();
  await expect
    .poll(() => page.evaluate(() => document.documentElement.style.overflowY))
    .toBe("hidden");
  await editor.locator("header").hover();
  await page.mouse.wheel(0, 600);
  const positions = await page.evaluate(
    () =>
      new Promise<number[]>((resolve) => {
        const samples: number[] = [];
        const start = performance.now();
        const sample = () => {
          samples.push(window.scrollY);
          if (performance.now() - start >= 200) resolve(samples);
          else requestAnimationFrame(sample);
        };
        sample();
      }),
  );
  expect(positions.every((value) => Math.abs(value - before) < 1)).toBe(true);
  await editor.getByRole("button", { name: "返回", exact: true }).click();
  await expect(settings(page)).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(settings(page)).toHaveCount(0);
  await expect(gear).toBeFocused();
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(before);
  expect(
    await page.evaluate(() => ({
      value: document.documentElement.style.getPropertyValue("overflow-y"),
      priority:
        document.documentElement.style.getPropertyPriority("overflow-y"),
    })),
  ).toEqual(initial);
  expect(writes).toEqual([]);
});

import { expect, test } from "@playwright/test";
import { prepareFormalRoutes } from "./support/prepare-formal-routes";
const qa = "/dev/t02p/qa?qaChrome=hidden";
test.beforeAll(async ({ request }) => prepareFormalRoutes(request));
// Playwright requires a destructured fixture parameter even when only TestInfo is used.
// eslint-disable-next-line no-empty-pattern
test.beforeEach(async ({}, info) =>
  test.skip(
    !info.project.name.startsWith("desktop"),
    "Desktop-only rail; mobile motion is tested separately.",
  ),
);

test("secondary rail reveals one label with motion, including the current item", async ({
  page,
}, info) => {
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(qa);
  await expect(page.locator("html")).toHaveAttribute("data-yoyi-boot", "ready");
  const rail = page.locator(
    '[data-home-surface] [data-animated-top-tabs][data-orientation="vertical"]',
  );
  const buttons = rail.getByRole("tab");
  await expect(buttons).toHaveCount(4);
  for (const button of await buttons.all()) {
    await expect(button.locator("[data-tab-label-slot]")).toHaveCSS(
      "max-height",
      "0px",
    );
    expect(await button.locator("[data-icon]").count()).toBeGreaterThan(0);
  }
  const first = rail.getByRole("tab", { name: "发现", exact: true });
  await first.click();
  await expect(first).toHaveAttribute("data-label-expanded", "true");
  expect(
    await first
      .locator("[data-tab-label-slot]")
      .evaluate((node) =>
        node
          .getAnimations()
          .some((animation) => animation.playState === "running"),
      ),
  ).toBe(true);
  await expect(first.locator("[data-tab-label-slot]")).toHaveCSS(
    "opacity",
    "1",
  );
  const widthBefore = (await rail.boundingBox())!.width;
  const next = rail.getByRole("tab", { name: "书帖", exact: true });
  await next.click();
  await expect(next).toHaveAttribute("aria-selected", "true");
  await expect(next.locator("[data-tab-label-slot]")).toHaveCSS("opacity", "1");
  await expect(first.locator("[data-tab-label-slot]")).toHaveCSS(
    "max-height",
    "0px",
  );
  expect((await rail.boundingBox())!.width).toBe(widthBefore);
  await page.screenshot({
    path: info.outputPath("secondary-selected.png"),
    animations: "disabled",
  });
});

test("secondary rail respects reduced motion and vertical keyboard selection", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto(qa);
  const rail = page.locator(
    '[data-home-surface] [data-animated-top-tabs][data-orientation="vertical"]',
  );
  const first = rail.getByRole("tab", { name: "发现", exact: true });
  await first.focus();
  await first.press("ArrowDown");
  const next = rail.getByRole("tab", { name: "附近", exact: true });
  await expect(next).toBeFocused();
  await expect(next).toHaveAttribute("data-label-expanded", "true");
  await expect(next.locator("[data-tab-label-slot]")).toHaveCSS(
    "transition-duration",
    "0s",
  );
  await expect(next.locator("[data-tab-label-slot]")).toHaveCSS("opacity", "1");
});

test("detail isolates background utility triggers and restores them on return", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(
    `${qa}&feed=inscriptions&catalogId=qa-visual-inscription-01#detail`,
  );
  const detail = page.getByRole("dialog", { name: "资料详情", exact: true });
  await expect(detail).toBeVisible();
  const utilities = page.locator("[data-user-trigger], [data-filter-trigger]");
  await expect(utilities).toHaveCount(2);
  for (const trigger of await utilities.all()) {
    expect(
      await trigger.evaluate((node) => node.closest("[inert]") !== null),
    ).toBe(true);
    await trigger.focus();
    await expect(trigger).not.toBeFocused();
  }
  for (let index = 0; index < 8; index += 1) {
    await page.keyboard.press("Tab");
    expect(
      await utilities.evaluateAll((nodes) =>
        nodes.some((node) => node === document.activeElement),
      ),
    ).toBe(false);
  }
  await detail.getByRole("button", { name: "返回", exact: true }).click();
  await expect(detail).toHaveCount(0);
  const filter = page.locator("[data-filter-trigger]");
  await filter.focus();
  await expect(filter).toBeFocused();
});

test("long and short menu destinations keep one desktop frame and stable gallery geometry", async ({
  page,
}, info) => {
  await page.addInitScript(() =>
    localStorage.setItem("yoyi.desktop-feed-layout.v1", "single"),
  );
  for (const width of [1440, 3440]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(qa);
    await expect(page.locator("html")).toHaveAttribute(
      "data-yoyi-boot",
      "ready",
    );
    await page.addStyleTag({
      content:
        "html::-webkit-scrollbar { width:16px; } html::-webkit-scrollbar-thumb { background:#777; }",
    });
    await expect(
      page
        .locator('[data-home-feed-panel="discover"] [data-desktop-feed]')
        .first(),
    ).toHaveAttribute("data-layout-ready", "true");
    await page.evaluate(
      () =>
        new Promise<void>((resolve) => requestAnimationFrame(() => resolve())),
    );
    const read = () =>
      page.evaluate(() => {
        const active = document.querySelector<HTMLElement>(
          '[data-primary-destination][data-active="true"]',
        )!;
        const header = active.querySelector<HTMLElement>(
          '[data-desktop-presentation="true"] > header',
        );
        const shell = document.querySelector<HTMLElement>(
          "[data-primary-shell]",
        )!;
        return {
          client: document.documentElement.clientWidth,
          frame: shell.getBoundingClientRect().width,
          header: (header ?? active).getBoundingClientRect().width,
        };
      });
    const home = page.locator("[data-home-surface]");
    const tabs = home.getByRole("tab");
    const before = await read();
    expect(before.header).toBeCloseTo(before.frame, 1);
    await page.evaluate(() => {
      const target = window as typeof window & {
        menuWidths?: number[];
        menuMeasure?: number;
      };
      target.menuWidths = [];
      const measure = () => {
        target.menuWidths!.push(document.documentElement.clientWidth);
        target.menuMeasure = requestAnimationFrame(measure);
      };
      measure();
    });
    await tabs.filter({ hasText: "书帖" }).click();
    await expect(home).toHaveAttribute("data-active-home-feed", "calligraphy");
    const card = home
      .locator('[data-home-feed-panel="calligraphy"] [data-desktop-feed-item]')
      .first();
    const cardBefore = await card.boundingBox();
    await tabs.filter({ hasText: "附近" }).click();
    await expect(home).toHaveAttribute("data-active-home-feed", "nearby");
    expect(await read()).toEqual(before);
    await tabs.filter({ hasText: "书帖" }).click();
    await expect(home).toHaveAttribute("data-active-home-feed", "calligraphy");
    const cardAfter = await card.boundingBox();
    expect(cardAfter!.width).toBeCloseTo(cardBefore!.width, 1);
    expect(cardAfter!.height).toBeCloseTo(cardBefore!.height, 1);
    const navigation = page.getByRole("navigation", {
      name: "主要内容",
      exact: true,
    });
    await navigation.getByRole("button", { name: "讨论", exact: true }).click();
    expect(await read()).toEqual(before);
    await navigation.getByRole("button", { name: "用户", exact: true }).click();
    expect(await read()).toEqual(before);
    await navigation.getByRole("button", { name: "首页", exact: true }).click();
    expect(await read()).toEqual(before);
    const widths = await page.evaluate(() => {
      const target = window as typeof window & {
        menuWidths?: number[];
        menuMeasure?: number;
      };
      cancelAnimationFrame(target.menuMeasure!);
      return target.menuWidths!;
    });
    expect(Math.max(...widths) - Math.min(...widths)).toBeLessThan(1);
    await page.screenshot({
      path: info.outputPath(`stable-frame-${width}.png`),
      animations: "disabled",
    });
  }
});

test("desktop document gutter preserves settings and search background scroll locks", async ({
  page,
}) => {
  await page.addInitScript(() =>
    localStorage.setItem("yoyi.desktop-feed-layout.v1", "single"),
  );
  await page.setViewportSize({ width: 1440, height: 720 });
  await page.goto(qa);
  await expect(page.locator("html")).toHaveAttribute("data-yoyi-boot", "ready");
  await expect(
    page
      .locator('[data-home-feed-panel="discover"] [data-desktop-feed]')
      .first(),
  ).toHaveAttribute("data-layout-ready", "true");
  await page.evaluate(() => window.scrollTo(0, 150));
  await expect
    .poll(() => page.evaluate(() => window.scrollY))
    .toBeGreaterThan(0);
  const before = await page.evaluate(() => window.scrollY);
  const lockedWheel = async (selector: string) => {
    await expect
      .poll(() => page.evaluate(() => document.body.style.overflow))
      .toBe("hidden");
    expect(await page.evaluate(() => window.scrollY)).toBe(before);
    await page.locator(selector).hover();
    await page.mouse.wheel(0, 600);
    const samples = await page.evaluate(
      () =>
        new Promise<number[]>((resolve) => {
          const values: number[] = [];
          const start = performance.now();
          const sample = () => {
            values.push(window.scrollY);
            if (performance.now() - start >= 200) resolve(values);
            else requestAnimationFrame(sample);
          };
          sample();
        }),
    );
    expect(samples.every((value) => Math.abs(value - before) < 1)).toBe(true);
  };
  const settings = page.locator("[data-desktop-settings]");
  await settings.click();
  await expect(page.locator("[data-product-settings]")).toBeVisible();
  await lockedWheel("[data-product-settings] > header");
  await page.keyboard.press("Escape");
  await expect(settings).toBeFocused();
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(before);
  const search = page.locator("[data-search-trigger]:visible").first();
  await search.click();
  await expect(page.locator("[data-search-panel]")).toBeVisible();
  await lockedWheel("[data-search-composer]");
  await page.locator("[data-search-close]").click();
  await expect(search).toBeFocused();
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(before);
});
